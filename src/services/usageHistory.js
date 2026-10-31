const fs = require('fs');
const os = require('os');
const path = require('path');

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const MIN_SAMPLE_INTERVAL_MS = 5 * MINUTE_MS;
const RETENTION_MS = 30 * DAY_MS;

const RANGE_MS = Object.freeze({
  '1h': HOUR_MS,
  '24h': 24 * HOUR_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS
});

const SERIES_META = Object.freeze([
  { key: 'claude_5h', label: 'Claude · 5h', shortLabel: 'CL 5h', provider: 'claude', window: '5h' },
  { key: 'claude_7d', label: 'Claude · 7d', shortLabel: 'CL 7d', provider: 'claude', window: '7d' },
  { key: 'codex_5h', label: 'Codex · 5h', shortLabel: 'CX 5h', provider: 'codex', window: '5h' },
  { key: 'codex_7d', label: 'Codex · 7d', shortLabel: 'CX 7d', provider: 'codex', window: '7d' }
]);

const DEFAULT_HISTORY_PATH = path.join(os.homedir(), '.claude', 'ai-pulse', 'usage-history.json');

function clampPct(val) {
  return Math.round(Math.max(0, Math.min(100, Number(val))) * 10) / 10;
}

function validResetTs(val) {
  const num = Number(val);
  return Number.isFinite(num) && num > 0 ? Math.round(num) : undefined;
}

/**
 * Extrae únicamente valores oficiales y vigentes (no vencidos/stale) de Claude y Codex.
 * Nunca convierte valores desconocidos (null/undefined/NaN/stale) en 0.
 */
function extractOfficialQuotaValues({ claudeQuota, codexQuota } = {}) {
  const values = [];

  if (claudeQuota && claudeQuota.available && !claudeQuota.stale) {
    if (typeof claudeQuota.fiveHourPct === 'number' && Number.isFinite(claudeQuota.fiveHourPct)) {
      const entry = { k: 'claude_5h', p: clampPct(claudeQuota.fiveHourPct) };
      const r = validResetTs(claudeQuota.nextFiveHourResetAt);
      if (r) entry.r = r;
      values.push(entry);
    }
    if (typeof claudeQuota.sevenDayPct === 'number' && Number.isFinite(claudeQuota.sevenDayPct)) {
      const entry = { k: 'claude_7d', p: clampPct(claudeQuota.sevenDayPct) };
      const r = validResetTs(claudeQuota.nextWeeklyResetAt);
      if (r) entry.r = r;
      values.push(entry);
    }
  }

  if (codexQuota && codexQuota.available && !codexQuota.stale) {
    if (typeof codexQuota.fiveHourPct === 'number' && Number.isFinite(codexQuota.fiveHourPct)) {
      const entry = { k: 'codex_5h', p: clampPct(codexQuota.fiveHourPct) };
      const r = validResetTs(codexQuota.nextFiveHourResetAt);
      if (r) entry.r = r;
      values.push(entry);
    }
    if (typeof codexQuota.sevenDayPct === 'number' && Number.isFinite(codexQuota.sevenDayPct)) {
      const entry = { k: 'codex_7d', p: clampPct(codexQuota.sevenDayPct) };
      const r = validResetTs(codexQuota.nextWeeklyResetAt);
      if (r) entry.r = r;
      values.push(entry);
    }
  }

  return values;
}

/**
 * Detecta si una ventana de cuota se reseteó entre la muestra previa y la actual.
 */
function windowResetBetween(prevItem, nextItem, sampleTs) {
  if (!prevItem || !nextItem) return false;
  if (
    Number.isFinite(prevItem.r) &&
    Number.isFinite(nextItem.r) &&
    nextItem.r > prevItem.r + MINUTE_MS &&
    prevItem.r <= sampleTs
  ) {
    return true;
  }
  if (Number.isFinite(prevItem.p) && Number.isFinite(nextItem.p) && prevItem.p - nextItem.p >= 15) {
    return true;
  }
  return false;
}

function hasAnyWindowReset(lastSample, nextValues, sampleTs) {
  if (!lastSample || !Array.isArray(lastSample.v) || !Array.isArray(nextValues)) return false;
  for (const after of nextValues) {
    const before = lastSample.v.find((item) => item && item.k === after.k);
    if (windowResetBetween(before, after, sampleTs)) return true;
  }
  return false;
}

/**
 * Filtra y limpia muestras fuera de la ventana de retención (30 días por defecto).
 */
function pruneSamples(samples, now = Date.now(), retentionMs = RETENTION_MS) {
  if (!Array.isArray(samples)) return [];
  const cutoff = now - retentionMs;
  const valid = [];
  for (const s of samples) {
    if (!s || !Number.isFinite(s.t) || s.t < cutoff || !Array.isArray(s.v)) continue;
    const cleanV = [];
    for (const item of s.v) {
      if (
        item &&
        typeof item.k === 'string' &&
        typeof item.p === 'number' &&
        Number.isFinite(item.p)
      ) {
        const entry = { k: item.k, p: clampPct(item.p) };
        if (Number.isFinite(item.r) && item.r > 0) entry.r = Math.round(item.r);
        cleanV.push(entry);
      }
    }
    if (cleanV.length > 0) {
      valid.push({ t: Math.round(s.t), v: cleanV });
    }
  }
  valid.sort((a, b) => a.t - b.t);
  return valid;
}

/**
 * Agrega una muestra al arreglo existente respetando el intervalo mínimo (~5 min)
 * salvo que haya ocurrido un reseteo de ventana o aparezcan métricas nuevas en la muestra reciente.
 */
function appendSample(
  samples,
  { claudeQuota, codexQuota, now = Date.now(), minIntervalMs = MIN_SAMPLE_INTERVAL_MS, retentionMs = RETENTION_MS } = {}
) {
  const list = pruneSamples(samples, now, retentionMs);
  const values = extractOfficialQuotaValues({ claudeQuota, codexQuota });
  if (values.length === 0) {
    return { samples: list, changed: list.length !== (Array.isArray(samples) ? samples.length : 0) };
  }

  const last = list[list.length - 1];
  if (last) {
    const resetOccurred = hasAnyWindowReset(last, values, now);
    if (!resetOccurred && now - last.t < minIntervalMs) {
      // Si dentro del mismo intervalo aparece un proveedor que no estaba en la última muestra, completarla
      let mergedNewKey = false;
      for (const item of values) {
        if (!last.v.some((existing) => existing.k === item.k)) {
          last.v.push(item);
          mergedNewKey = true;
        }
      }
      return {
        samples: list,
        changed: mergedNewKey || list.length !== (Array.isArray(samples) ? samples.length : 0)
      };
    }
  }

  list.push({ t: Math.round(now), v: values });
  return { samples: list, changed: true };
}

/**
 * Calcula el límite de corte por hueco sin datos: 3 veces la mediana del paso, mínimo 20 minutos.
 */
function gapLimitMs(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return 20 * MINUTE_MS;
  const steps = [];
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].t - samples[i - 1].t;
    if (d > 0) steps.push(d);
  }
  if (steps.length === 0) return 20 * MINUTE_MS;
  steps.sort((a, b) => a - b);
  const median = steps[Math.floor(steps.length / 2)];
  return Math.max(20 * MINUTE_MS, median * 3);
}

/**
 * Corta una serie de puntos en tramos continuos (runs) cuando hay un hueco temporal o un reseteo de cuota.
 */
function splitIntoRuns(points, maxGapMs = 20 * MINUTE_MS) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const out = [[points[0]]];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const gap = curr.t - prev.t > maxGapMs;
    const reset = windowResetBetween(prev, curr, curr.t);
    if (gap || reset) {
      out.push([curr]);
    } else {
      out[out.length - 1].push(curr);
    }
  }
  return out;
}

/**
 * Construye las series listas para graficar a partir de las muestras en un rango.
 */
function buildChartSeries(samples) {
  const safeSamples = Array.isArray(samples) ? samples : [];
  const maxGap = gapLimitMs(safeSamples);
  const series = [];

  for (const meta of SERIES_META) {
    const points = [];
    for (let i = 0; i < safeSamples.length; i++) {
      const s = safeSamples[i];
      if (!s || !Array.isArray(s.v)) continue;
      const found = s.v.find((item) => item && item.k === meta.key);
      if (found && typeof found.p === 'number' && Number.isFinite(found.p)) {
        const pt = { i, t: s.t, p: found.p };
        if (Number.isFinite(found.r)) pt.r = found.r;
        points.push(pt);
      }
    }
    if (points.length > 0) {
      series.push({
        ...meta,
        points,
        runs: splitIntoRuns(points, maxGap)
      });
    }
  }

  return series;
}

/**
 * Filtra las muestras según el rango solicitado ('1h' | '24h' | '7d' | '30d').
 */
function queryRange(samples, range = '24h', now = Date.now()) {
  const validRange = Object.prototype.hasOwnProperty.call(RANGE_MS, range) ? range : '24h';
  const spanMs = RANGE_MS[validRange];
  const from = now - spanMs;
  const filtered = (Array.isArray(samples) ? samples : []).filter(
    (s) => s && Number.isFinite(s.t) && s.t >= from && s.t <= now + MINUTE_MS
  );
  return {
    range: validRange,
    from,
    to: now,
    sampleIntervalMin: Math.round(MIN_SAMPLE_INTERVAL_MS / MINUTE_MS),
    samples: filtered,
    series: buildChartSeries(filtered)
  };
}

/**
 * Crea el almacén persistente en disco para el historial de porcentaje de cuota.
 */
function createUsageHistoryStore({
  filePath = DEFAULT_HISTORY_PATH,
  minIntervalMs = MIN_SAMPLE_INTERVAL_MS,
  retentionMs = RETENTION_MS
} = {}) {
  let samples = null;

  function ensureLoaded(now = Date.now()) {
    if (samples !== null) return samples;
    try {
      if (fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.samples) ? raw.samples : [];
        samples = pruneSamples(list, now, retentionMs);
      } else {
        samples = [];
      }
    } catch {
      samples = [];
    }
    return samples;
  }

  function saveToDisk() {
    try {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, samples }, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch {}
  }

  function record({ claudeQuota, codexQuota, now = Date.now() } = {}) {
    const current = ensureLoaded(now);
    const res = appendSample(current, {
      claudeQuota,
      codexQuota,
      now,
      minIntervalMs,
      retentionMs
    });
    samples = res.samples;
    if (res.changed) {
      saveToDisk();
    }
    return samples;
  }

  function getHistory({ range = '24h', now = Date.now() } = {}) {
    const current = ensureLoaded(now);
    return queryRange(current, range, now);
  }

  return {
    filePath,
    record,
    getHistory,
    getSamples: (now = Date.now()) => ensureLoaded(now).slice()
  };
}

module.exports = {
  MINUTE_MS,
  HOUR_MS,
  DAY_MS,
  MIN_SAMPLE_INTERVAL_MS,
  RETENTION_MS,
  RANGE_MS,
  SERIES_META,
  DEFAULT_HISTORY_PATH,
  extractOfficialQuotaValues,
  windowResetBetween,
  pruneSamples,
  appendSample,
  gapLimitMs,
  splitIntoRuns,
  buildChartSeries,
  queryRange,
  createUsageHistoryStore
};
