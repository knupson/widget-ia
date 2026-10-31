const test = require('node:test');
const assert = require('node:assert/strict');

const { localDayKey, snappyUncompress } = require('../src/collectors/claudeCollector');
const { buildCodexQuota, parseRolloutLine } = require('../src/collectors/codexCollector');
const {
  parseOfficialQuotaPayload,
  parseQuotaErrors,
  parseLogModel,
  successMatches
} = require('../src/collectors/agyQuotaStatus');

test('localDayKey formatea fechas locales como YYYY-MM-DD con ceros a la izquierda', () => {
  const ts = new Date(2026, 0, 5, 14, 30, 0).getTime();
  assert.equal(localDayKey(ts), '2026-01-05');

  const tsOct = new Date(2026, 9, 30, 23, 59, 59).getTime();
  assert.equal(localDayKey(tsOct), '2026-10-30');
});

test('snappyUncompress descomprime bloques literales y con back-references', () => {
  // Literal simple: longitud descomprimida = 5, tag literal (len-1 = 4 -> 4 << 2 = 0x10), "hello"
  const raw = Buffer.from([0x05, 0x10, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  const out = snappyUncompress(raw);
  assert.ok(out);
  assert.equal(out.toString('utf8'), 'hello');
});

test('buildCodexQuota calcula porcentajes y timestamps de reseteo para ventanas 5h y 7d', () => {
  const now = 1759990000000;
  const limits = {
    primary: {
      used_percent: 42.5,
      resets_at: 1760000000
    },
    secondary: {
      usedPercent: 18.2,
      resetsAt: 1760500000
    }
  };
  const quota = buildCodexQuota(null, now, { limits, fetchedAt: now - 1000 });
  assert.equal(quota.available, true);
  assert.equal(quota.stale, false);
  assert.equal(quota.fiveHourPct, 42.5);
  assert.equal(quota.sevenDayPct, 18.2);
  assert.equal(quota.nextFiveHourResetAt, 1760000000 * 1000);
  assert.equal(quota.nextWeeklyResetAt, 1760500000 * 1000);
  assert.equal(quota.source, 'codex-app-server');
});

test('buildCodexQuota devuelve no disponible cuando no hay límites', () => {
  const quota = buildCodexQuota(null, 1759990000000);
  assert.equal(quota.available, false);
  assert.equal(quota.fiveHourPct, null);
  assert.equal(quota.sevenDayPct, null);
});

test('parseRolloutLine extrae metadatos, uso de tokens y rate_limits de sesiones Codex', () => {
  const data = {
    meta: {},
    model: null,
    quota: null,
    previous: {},
    daily: {},
    total: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, effective: 0, turns: 0 },
    state: 'waiting_input',
    lastMessage: '',
    updatedAt: 0
  };

  parseRolloutLine(
    data,
    JSON.stringify({
      timestamp: '2026-10-30T15:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'sess-123', cwd: 'E:\\Repositorios\\demo', git: { branch: 'main' } }
    })
  );
  assert.equal(data.meta.id, 'sess-123');
  assert.equal(data.meta.cwd, 'E:\\Repositorios\\demo');
  assert.equal(data.meta.git.branch, 'main');

  parseRolloutLine(
    data,
    JSON.stringify({
      timestamp: '2026-10-30T15:01:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1200,
            cached_input_tokens: 800,
            output_tokens: 300,
            total_tokens: 1500
          }
        },
        rate_limits: {
          primary: { used_percent: 25, resets_at: 1761840000 }
        }
      }
    })
  );
  assert.equal(data.total.input, 400);
  assert.equal(data.total.cacheRead, 800);
  assert.equal(data.total.output, 300);
  assert.equal(data.total.total, 1500);
  assert.equal(data.quota.limits.primary.used_percent, 25);
});

test('parseOfficialQuotaPayload interpreta fracciones restantes y tiempos de reset de AGY', () => {
  const payload = {
    groups: [
      {
        displayName: 'Standard',
        buckets: [
          {
            bucketId: 'weekly-limit',
            window: '7d',
            remainingFraction: 0.75,
            resetTime: '2026-11-02T00:00:00Z'
          },
          {
            bucketId: 'five-hour-limit',
            window: '5h',
            remainingFraction: 0.4,
            resetTime: '2026-10-30T22:00:00Z'
          }
        ]
      }
    ]
  };
  const parsed = parseOfficialQuotaPayload(payload, { project_id: 'proj-1' }, 1761850000000);
  assert.equal(parsed.available, true);
  assert.equal(parsed.weekly.usedPctRounded, 25);
  assert.equal(parsed.fiveHour.usedPctRounded, 60);
  assert.equal(parsed.weekly.resetAt, Date.parse('2026-11-02T00:00:00Z'));
});

test('parseQuotaErrors y successMatches detectan agotamiento de pool y recuperación posterior', () => {
  const refTime = new Date(2026, 9, 30, 18, 0, 0).getTime();
  const logText = [
    'E1030 17:00:00.000000 1234 client.go:99] Quota pool exhausted for model="gemini-4-argon". Resets in 1h 30m.',
    'I1030 17:05:00.000000 1234 input_loop.go:50] Quota pool exhausted ignored on user input'
  ].join('\n');

  const err = parseQuotaErrors(logText, refTime);
  assert.ok(err);
  assert.equal(err.window, '5h');
  assert.equal(err.model, 'gemini-4-argon');
  assert.equal(err.resetDelayMs, (90 * 60) * 1000);

  assert.equal(parseLogModel('calling /models/gemini-4-argon.'), 'gemini-4-argon');
  assert.equal(
    successMatches(err, { timestamp: err.observedAt + 5000, model: 'gemini-4-argon' }),
    true
  );
});
