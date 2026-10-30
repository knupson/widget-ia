const fs = require('fs');
const { TOKEN_WEIGHTS } = require('./tokenWeights');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

// Caché en memoria de la cuota oficial obtenida desde businessaicode.googleapis.com:fetchQuotaStatus
let apiQuotaCache = {
  checkedAt: 0,
  failures: 0,
  nextAttemptAt: 0,
  inFlight: false,
  cred: null,
  credLoadedAt: 0,
  data: null
};

const OFFICIAL_QUOTA_TTL_MS = 10 * 60000;

const CRED_PS_SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class AgyCredReader {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }
    [DllImport("Advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredRead(string target, uint type, int reservedFlag, out IntPtr credentialPtr);
    [DllImport("Advapi32.dll", SetLastError = true)]
    public static extern void CredFree(IntPtr cred);
    public static string Read(string target) {
        IntPtr ptr;
        if (!CredRead(target, 1, 0, out ptr)) return null;
        try {
            CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            if (c.CredentialBlob == IntPtr.Zero || c.CredentialBlobSize == 0) return null;
            byte[] b = new byte[c.CredentialBlobSize];
            Marshal.Copy(c.CredentialBlob, b, 0, (int)c.CredentialBlobSize);
            return System.Text.Encoding.UTF8.GetString(b);
        } finally {
            CredFree(ptr);
        }
    }
}
'@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$raw = [AgyCredReader]::Read('gemini:antigravity')
if ($raw) { Write-Output $raw }
`.trim();

function loadAgyCredentialFromKeyring() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(null);
      return;
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', CRED_PS_SCRIPT],
      { timeout: 6000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout).trim());
          resolve(parsed);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

function fetchBusinessAiCodeQuota(cred) {
  return new Promise((resolve) => {
    const tokenObj = (cred && cred.token) || {};
    const accessToken = tokenObj.access_token;
    const projectId = cred && cred.project_id;
    const region = (cred && cred.region) || 'global';
    const userTier = (cred && cred.user_tier) || 'gcp-ge-standard-tier';

    if (!accessToken || !projectId) {
      resolve(null);
      return;
    }

    const url = `https://businessaicode.googleapis.com/v1beta/projects/${encodeURIComponent(
      projectId
    )}/locations/${encodeURIComponent(region)}:fetchQuotaStatus?entitlement.userTier=${encodeURIComponent(
      userTier
    )}`;

    const req = https.get(
      url,
      {
        timeout: 8000,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Goog-User-Project': projectId,
          Accept: 'application/json'
        }
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk.toString('utf8');
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve({ httpStatus: res.statusCode, error: body.slice(0, 200) });
            return;
          }
          try {
            const json = JSON.parse(body);
            resolve({ httpStatus: 200, payload: json, cred });
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on('timeout', () => {
      try {
        req.destroy();
      } catch {}
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

function parseOfficialQuotaPayload(payload, cred, fetchedAt = Date.now()) {
  if (!payload || !Array.isArray(payload.groups)) return null;
  let weeklyBucket = null;
  let fiveHourBucket = null;

  for (const group of payload.groups) {
    const buckets = Array.isArray(group && group.buckets) ? group.buckets : [];
    for (const b of buckets) {
      if (!b || typeof b.remainingFraction !== 'number') continue;
      const win = String(b.window || b.bucketId || '').toLowerCase();
      const rem = Math.max(0, Math.min(1, Number(b.remainingFraction)));
      const usedFrac = Math.max(0, Math.min(1, 1 - rem));
      const usedPctExact = Number((usedFrac * 100).toFixed(4));
      const usedPctRounded = Math.round(usedFrac * 100);
      const resetAt = b.resetTime ? Date.parse(b.resetTime) || null : null;

      const parsedBucket = {
        bucketId: b.bucketId || '',
        displayName: b.displayName || group.displayName || '',
        description: b.description || group.description || '',
        window: b.window || '',
        remainingFraction: rem,
        remainingPctExact: Number((rem * 100).toFixed(4)),
        usedFraction: usedFrac,
        usedPctExact,
        usedPctRounded,
        resetTime: b.resetTime || null,
        resetAt
      };

      if (win.includes('week') || win === '7d') {
        weeklyBucket = parsedBucket;
      } else if (win.includes('5h') || win.includes('five') || win.includes('hour') || win.includes('day') || win.includes('daily')) {
        fiveHourBucket = parsedBucket;
      }
    }
  }

  return {
    available: Boolean(weeklyBucket || fiveHourBucket),
    fetchedAt,
    email: (cred && cred.id_token_email) || '',
    projectId: (cred && cred.project_id) || '',
    region: (cred && cred.region) || 'global',
    userTier: (cred && cred.user_tier) || '',
    weekly: weeklyBucket,
    fiveHour: fiveHourBucket
  };
}

function triggerBackgroundOfficialQuotaRefresh(now = Date.now()) {
  if (apiQuotaCache.inFlight || now < apiQuotaCache.nextAttemptAt) return;
  if (apiQuotaCache.data && now - apiQuotaCache.checkedAt < 60000) return;
  if (!apiQuotaCache.data && now - apiQuotaCache.checkedAt < 15000) return;

  apiQuotaCache.inFlight = true;
  apiQuotaCache.checkedAt = now;

  (async () => {
    let succeeded = false;
    try {
      const tokenExpiry =
        apiQuotaCache.cred &&
        apiQuotaCache.cred.token &&
        apiQuotaCache.cred.token.expiry
          ? Date.parse(apiQuotaCache.cred.token.expiry) || 0
          : 0;
      const needReloadCred =
        !apiQuotaCache.cred ||
        now - apiQuotaCache.credLoadedAt > 5 * 60000 ||
        (tokenExpiry > 0 && tokenExpiry - now < 2 * 60000);

      if (needReloadCred) {
        const freshCred = await loadAgyCredentialFromKeyring();
        apiQuotaCache.cred = freshCred;
        if (freshCred) {
          apiQuotaCache.cred = freshCred;
          apiQuotaCache.credLoadedAt = Date.now();
        }
      }

      if (!apiQuotaCache.cred) return;

      let res = await fetchBusinessAiCodeQuota(apiQuotaCache.cred);
      if (res && res.httpStatus === 401) {
        const freshCred = await loadAgyCredentialFromKeyring();
        apiQuotaCache.cred = freshCred;
        if (freshCred) {
          apiQuotaCache.cred = freshCred;
          apiQuotaCache.credLoadedAt = Date.now();
          res = await fetchBusinessAiCodeQuota(freshCred);
        }
      }

      if (res && res.httpStatus === 200 && res.payload) {
        const parsed = parseOfficialQuotaPayload(res.payload, apiQuotaCache.cred, Date.now());
        if (parsed) {
          apiQuotaCache.data = parsed;
          succeeded = parsed.available;
        }
      }
    } catch {} finally {
      apiQuotaCache.inFlight = false;
      apiQuotaCache.failures = succeeded ? 0 : Math.min(6, apiQuotaCache.failures + 1);
      apiQuotaCache.nextAttemptAt = Date.now() + (succeeded ? 60000 : Math.min(10 * 60000, 15000 * 2 ** apiQuotaCache.failures));
    }
  })();
}

function getOfficialAgyQuotaSnapshot(now = Date.now()) {
  triggerBackgroundOfficialQuotaRefresh(now);
  const data = apiQuotaCache.data;
  if (!data) return null;
  if (now - data.fetchedAt <= OFFICIAL_QUOTA_TTL_MS) return { ...data, stale: false };
  return { ...data, available: false, stale: true, weekly: null, fiveHour: null,
    lastKnownWeekly: data.weekly, lastKnownFiveHour: data.fiveHour };
}

// Detecta errores 429 (RESOURCE_EXHAUSTED) de cuota AGY y respuestas exitosas posteriores en los logs del CLI.
function parseLogTimestamp(line, fileTime = Date.now()) {
  const stamp = line.match(/^([IWEF])(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!stamp) return null;
  const reference = new Date(fileTime);
  const date = new Date(
    reference.getFullYear(),
    Number(stamp[2]) - 1,
    Number(stamp[3]),
    Number(stamp[4]),
    Number(stamp[5]),
    Number(stamp[6]),
    Number((stamp[7] || '').padEnd(3, '0').slice(0, 3))
  );
  if (date.getTime() > fileTime + 24 * 3600 * 1000) {
    date.setFullYear(date.getFullYear() - 1);
  }
  return { level: stamp[1], timestamp: date.getTime() };
}

function parseLogModel(line) {
  const match = line.match(/\/models\/([a-z0-9_.-]+)/i) ||
    line.match(/["']?model(?:_id|Id|_name|Name)?["']?\s*[:=]\s*["']?([a-z0-9_.-]+)/i);
  // El punto final de la oración también cae en la clase de caracteres: se recorta
  return match ? match[1].replace(/\.+$/, '').toLowerCase() : null;
}

function successMatches(error, success) {
  return success.timestamp > error.observedAt + 2000 &&
    ((error.model && success.model === error.model) ||
      (error.resetAt != null && success.timestamp >= error.resetAt));
}

function parseQuotaLogActivity(text, fileTime = Date.now()) {
  let latest = null;
  const successes = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (/http_helpers\.go:\d+\]\s+URL:\s+\S+:streamGenerateContent\?alt=sse\s+ResponseID:\s+\S+/i.test(line)) {
      const parsed = parseLogTimestamp(line, fileTime);
      if (parsed) successes.push({ timestamp: parsed.timestamp, model: parseLogModel(line) });
      continue;
    }
    if (!/Quota pool exhausted/i.test(line)) continue;
    // Ignorar logs de entrada del usuario (input_loop.go / HandleUserInput) o líneas meramente informativas (I)
    if (/input_loop\.go|HandleUserInput/i.test(line)) continue;

    const parsed = parseLogTimestamp(line, fileTime);
    if (!parsed || parsed.level === 'I') continue;

    const { timestamp } = parsed;
    const duration = line.match(/Resets in\s+((?:\d+(?:\.\d+)?\s*(?:ms|[dhms])\s*)+)/i);
    let delay = 0;
    const hasDuration = Boolean(duration);
    if (duration) {
      for (const match of duration[1].matchAll(/(\d+(?:\.\d+)?)\s*(ms|[dhms])/gi)) {
        delay += Number(match[1]) * ({ d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1 }[match[2].toLowerCase()]);
      }
    }

    // Si el error informa "Resets in 0s.", delay es 0 pero el timestamp de reset es conocido (timestamp + 0)
    const computedResetAt = hasDuration ? timestamp + delay : null;

    // Inferir ventana: en AGY la sesión rotativa es de 5h (<= 5h de espera al reset)
    const windowType = hasDuration
      ? delay <= 5 * 3600 * 1000 + 60000
        ? '5h'
        : '7d'
      : null;

    if (!latest || timestamp >= latest.observedAt) {
      latest = {
        source: 'provider-error',
        model: parseLogModel(line),
        observedAt: timestamp,
        resetAt: computedResetAt,
        resetDelayMs: hasDuration ? delay : null,
        message: 'AGY informó que el pool de cuota está agotado.',
        window: windowType,
        lastSuccessAt: 0
      };
    }
  }

  const lastSuccessAt = successes.reduce((value, success) => Math.max(value, success.timestamp), 0);
  if (latest) latest.lastSuccessAt = successes.filter((success) => successMatches(latest, success))
    .reduce((value, success) => Math.max(value, success.timestamp), 0);
  return { latestError: latest, lastSuccessAt, successes };
}

function parseQuotaErrors(text, fileTime = Date.now()) {
  return parseQuotaLogActivity(text, fileTime).latestError;
}

function createAgyQuotaStatusReader() {
  const cache = new Map();
  return function readAgyQuotaStatus(baseDir, now = Date.now(), extraSuccessAt = 0) {
    const files = [path.join(baseDir, 'cli.log')];
    try {
      files.push(
        ...fs
          .readdirSync(path.join(baseDir, 'log'))
          .filter((f) => /^cli-.*\.log$/.test(f))
          .sort()
          .slice(-12)
          .map((f) => path.join(baseDir, 'log', f))
      );
    } catch {}

    let latest = null;
    let lastSuccessAt = Number(extraSuccessAt) || 0;
    const successes = extraSuccessAt ? [{ timestamp: Number(extraSuccessAt), model: null }] : [];

    for (const file of files) {
      try {
        const stat = fs.statSync(file);
        if (now - stat.mtimeMs > 7 * 86400000) continue;
        const key = `${stat.size}:${stat.mtimeMs}`;
        let entry = cache.get(file);
        if (!entry || entry.key !== key) {
          const length = Math.min(stat.size, 256 * 1024);
          const buffer = Buffer.alloc(length);
          const fd = fs.openSync(file, 'r');
          try {
            fs.readSync(fd, buffer, 0, length, stat.size - length);
          } finally {
            fs.closeSync(fd);
          }
          entry = { key, ...parseQuotaLogActivity(buffer.toString('utf8'), stat.mtimeMs) };
          cache.set(file, entry);
        }
        successes.push(...entry.successes);
        if (entry.lastSuccessAt && entry.lastSuccessAt > lastSuccessAt) {
          lastSuccessAt = entry.lastSuccessAt;
        }
        if (entry.latestError && (!latest || entry.latestError.observedAt >= latest.observedAt)) {
          latest = { ...entry.latestError };
        }
      } catch {}
    }

    const officialApi = getOfficialAgyQuotaSnapshot(now);

    if (!latest) {
      return {
        state: officialApi && officialApi.available ? 'active' : 'unknown',
        source: officialApi && officialApi.available ? 'google-api' : 'no-provider-data',
        exhausted: false,
        lastSuccessAt: lastSuccessAt || null,
        officialApi: officialApi || null
      };
    }

    const matchedSuccessAt = successes.filter((success) => successMatches(latest, success))
      .reduce((value, success) => Math.max(value, success.timestamp), 0);
    const verifiedAfterReset = matchedSuccessAt > 0;
    const resetTimePassed = latest.resetAt != null && now >= latest.resetAt;
    const exhausted =
      !verifiedAfterReset &&
      !resetTimePassed;

    let state = 'unverified';
    if (exhausted) {
      state = 'exhausted';
    } else if (verifiedAfterReset || resetTimePassed) {
      state = 'recovered';
    }

    const lastResetAt =
      !exhausted && (latest.resetAt != null || verifiedAfterReset)
        ? latest.resetAt != null
          ? latest.resetAt
          : lastSuccessAt
        : null;

    return {
      ...latest,
      state,
      exhausted,
      verifiedAfterReset,
      lastSuccessAt: lastSuccessAt || null,
      lastResetAt,
      officialApi: officialApi || null
    };
  };
}

module.exports = { parseQuotaLogActivity, parseOfficialQuotaPayload, parseLogModel, successMatches, parseQuotaErrors, createAgyQuotaStatusReader, getOfficialAgyQuotaSnapshot };
