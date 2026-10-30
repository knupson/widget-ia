const fs = require('fs');
const { TOKEN_WEIGHTS } = require('./tokenWeights');
const os = require('os');
const path = require('path');
const { getRateLimitsSnapshot } = require('./codexRateLimits');

const WEEK = 7 * 24 * 3600 * 1000;
const emptyBucket = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, effective: 0, turns: 0 });
const number = (v) => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0;

function localDayKey(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function add(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key] || 0;
}

function normalizeWindow(window, now) {
  if (!window) return null;
  const usedPct = window.usedPercent ?? window.used_percent;
  if (!Number.isFinite(usedPct)) return null;
  const resetSeconds = window.resetsAt ?? window.resets_at;
  const resetsAt = Number.isFinite(resetSeconds) ? resetSeconds * 1000 : null;
  return {
    usedPct: Math.max(0, Math.min(100, usedPct)),
    windowMinutes: number(window.windowDurationMins ?? window.window_minutes),
    resetsAt,
    expired: resetsAt !== null && resetsAt <= now
  };
}

function buildCodexQuota(snapshot, now, liveSnapshot = null) {
  const live = liveSnapshot && now - liveSnapshot.fetchedAt < 3 * 60 * 1000;
  const selected = live ? liveSnapshot : snapshot;
  const limits = selected?.limits || {};
  const timestamp = live ? selected.fetchedAt : selected?.timestamp ?? null;
  const slots = [limits.primary, limits.secondary].map((w) => normalizeWindow(w, now));
  const windows = slots.filter(Boolean);
  const fiveHour = windows.find((w) => w.windowMinutes > 0 && w.windowMinutes <= 1440)
    || (slots[0]?.windowMinutes === 0 ? slots[0] : null);
  const sevenDay = windows.find((w) => w.windowMinutes >= 6 * 24 * 60)
    || (slots[1]?.windowMinutes === 0 ? slots[1] : null);
  return {
    available: Boolean(selected),
    source: live ? 'codex-app-server' : 'local-session',
    limitId: limits.limitId || limits.limit_id || 'codex',
    planType: limits.planType || limits.plan_type || null,
    updatedAt: timestamp,
    stale: live ? false : timestamp === null || now - timestamp > 15 * 60 * 1000,
    fiveHourPct: fiveHour && !fiveHour.expired ? fiveHour.usedPct : null,
    sevenDayPct: sevenDay && !sevenDay.expired ? sevenDay.usedPct : null,
    nextFiveHourResetAt: fiveHour && !fiveHour.expired ? fiveHour.resetsAt : null,
    nextWeeklyResetAt: sevenDay && !sevenDay.expired ? sevenDay.resetsAt : null,
    windows
  };
}

// Procesa una línea de rollout y actualiza `data` en sitio. Exportada para tests.
function parseRolloutLine(data, line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  const payload = event.payload || {};
  const timestamp = Date.parse(event.timestamp);
  if (!Number.isFinite(timestamp)) return;
  if (event.type === 'session_meta') data.meta = payload;
  if (event.type === 'turn_context') data.model = payload.model || data.model;
  if (event.type !== 'event_msg') return;
  if (payload.type === 'token_count') {
    // Otros pools/modelos no deben reemplazar la cuota general de Codex.
    if (payload.rate_limits && (!payload.rate_limits.limit_id || payload.rate_limits.limit_id === 'codex')) {
      data.quota = { limits: payload.rate_limits, timestamp };
    }
    const usage = payload.info && payload.info.total_token_usage;
    if (!usage) return;
    const current = {
      input: number(usage.input_tokens), cache: number(usage.cached_input_tokens),
      output: number(usage.output_tokens), total: number(usage.total_tokens)
    };
    const delta = {};
    for (const key of Object.keys(current)) delta[key] = Math.max(0, current[key] - (data.previous[key] || 0));
    data.previous = current;
    if (delta.total === 0) return; // Eventos repetidos de cuota no agregan tokens ni turnos.
    const bucket = {
      input: Math.max(0, delta.input - delta.cache), cacheRead: delta.cache, cacheWrite: 0,
      output: delta.output, total: delta.total,
      // Índice comparativo del widget; no representa cuota ni precio del proveedor.
      effective: Math.round(Math.max(0, delta.input - delta.cache) + delta.cache * TOKEN_WEIGHTS.cacheRead + delta.output * TOKEN_WEIGHTS.output),
      turns: 1
    };
    const day = localDayKey(timestamp);
    data.daily[day] ||= emptyBucket();
    add(data.daily[day], bucket);
    add(data.total, bucket);
  } else if (payload.type === 'task_started' || payload.type === 'user_message') {
    data.state = 'running';
  } else if (['task_complete', 'turn_complete'].includes(payload.type)) {
    data.state = 'waiting_input';
    data.lastMessage = String(payload.last_agent_message || '').slice(0, 260);
  } else if (['turn_aborted', 'shutdown_complete'].includes(payload.type)) {
    data.state = 'closed';
  } else if (payload.type === 'agent_message') {
    data.lastMessage = String(payload.message || '').slice(0, 260);
  }
  data.updatedAt = Math.max(data.updatedAt, timestamp);
}

// Cuota oficial por app-server; sesiones y tokens por lectura incremental de rollouts.
function createCodexCollector({ home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), clock = Date.now } = {}) {
  const cache = new Map();
  let files = [];
  let scannedAt = -Infinity;

  // El stat se toma sólo acá (cada 15 s), no en cada collect.
  function discover(dir) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) discover(file);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push({ file, stat: fs.statSync(file) });
      }
    } catch { /* Codex todavía puede no estar instalado. */ }
  }

  function read(file, stat) {
    let data = cache.get(file);
    if (data && data.size === stat.size && data.mtime === stat.mtimeMs && data.identity === `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`) return data;
    if (!data || data.identity !== `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` || stat.size < data.size || (stat.size === data.size && stat.mtimeMs !== data.mtime)) {
      data = { size: 0, mtime: 0, rest: '', meta: {}, daily: {}, total: emptyBucket(), previous: {}, updatedAt: 0, state: 'closed', lastMessage: '', model: '', quota: null };
    }
    const length = stat.size - data.size;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    let bytes;
    try { bytes = fs.readSync(fd, buffer, 0, length, data.size); } finally { fs.closeSync(fd); }
    // Retener bytes, no texto, para soportar caracteres UTF-8 partidos entre escrituras.
    const content = Buffer.concat([Buffer.from(data.rest, 'base64'), buffer.subarray(0, bytes)]);
    const end = content.lastIndexOf(10);
    data.rest = content.subarray(end + 1).toString('base64');
    const lines = end >= 0 ? content.subarray(0, end).toString('utf8').split('\n') : [];
    for (const line of lines) parseRolloutLine(data, line);
    data.size += bytes;
    data.mtime = stat.mtimeMs;
    data.identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    cache.set(file, data);
    return data;
  }

  return function collectCodexData() {
    const now = clock();
    const liveQuota = getRateLimitsSnapshot();
    if (now - scannedAt >= 15000) {
      files = [];
      discover(path.join(home, 'sessions'));
      scannedAt = now;
      const liveFiles = new Set(files.map((entry) => entry.file));
      for (const file of cache.keys()) if (!liveFiles.has(file)) cache.delete(file);
    }
    const records = new Map();
    const dailyTokens = {};
    let quota = null;
    for (const { file, stat } of files) {
      try {
        if (stat.mtimeMs < now - WEEK) continue;
        const data = read(file, stat);
        // Tokens se suman por archivo: un resume puede abrir un rollout nuevo con el mismo session id.
        for (const [day, bucket] of Object.entries(data.daily)) {
          dailyTokens[day] ||= emptyBucket();
          add(dailyTokens[day], bucket);
        }
        if (data.quota && (!quota || data.quota.timestamp > quota.timestamp)) quota = data.quota;
        // Dedupe sólo para la lista de sesiones: se queda el archivo más nuevo.
        const id = data.meta.id || file;
        if (!records.has(id) || records.get(id).updatedAt < data.updatedAt) records.set(id, data);
      } catch { /* Archivo rotado o todavía incompleto. */ }
    }
    const sessions = [];
    for (const [id, data] of records) {
      const age = now - data.updatedAt;
      // Sin PID/lock fiable, no afirmar que una sesión histórica sigue abierta.
      const isOpen = data.state === 'running' && age < 120000;
      const state = isOpen ? 'running' : 'closed';
      if (age > 24 * 3600 * 1000) continue;
      const workspace = data.meta.cwd || '';
      sessions.push({
        id: `codex:${id}`, sessionId: id, provider: 'codex', providerLabel: 'Codex',
        surface: data.meta.source === 'cli' ? 'cli' : 'app', workspace,
        projectName: workspace ? path.win32.basename(workspace.replace(/\//g, '\\')) : 'Codex',
        title: data.model ? `Codex · ${data.model}` : 'Sesión Codex', model: data.model,
        isOpen, state, stateLabel: isOpen ? 'Activa' : 'Reciente',
        updatedAt: data.updatedAt, turns: data.total.turns, tokens: { ...data.total },
        lastMessage: data.lastMessage, currentAction: isOpen ? 'Trabajando (actividad reciente)' : ''
      });
    }
    return { sessions, dailyTokens, codexQuota: buildCodexQuota(quota, now, liveQuota) };
  };
}

const collectCodexData = createCodexCollector();
module.exports = { collectCodexData, createCodexCollector, buildCodexQuota, parseRolloutLine };
