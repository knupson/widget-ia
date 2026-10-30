const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY_MS = 24 * 3600 * 1000;
const SIX_MONTHS_DAYS = 183; // ~6 meses (26 semanas + margen)

// Precios estimados de referencia por millón de tokens (USD / 1M tokens) por familia de modelo.
// Fuente: tarifas públicas de API de Anthropic y OpenAI vigentes al 2026-10-06.
// Se utilizan exclusivamente como estimación orientativa (costo equivalente de API).
const PRICES_AS_OF = '2026-10-06';
const MODEL_FAMILY_PRICES_USD_PER_M = Object.freeze({
  opus: Object.freeze({ input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.50 }),
  sonnet: Object.freeze({ input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 }),
  haiku: Object.freeze({ input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.10 }),
  codex: Object.freeze({ input: 1.5, output: 6.0, cacheWrite: 1.5, cacheRead: 0.375 })
});

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function addTokens(target, src) {
  if (!src) return target;
  const input = Number(src.input) || 0;
  const output = Number(src.output) || 0;
  const cacheRead = Number(src.cacheRead) || 0;
  const cacheWrite = Number(src.cacheWrite) || 0;
  target.input += input;
  target.output += output;
  target.cacheRead += cacheRead;
  target.cacheWrite += cacheWrite;
  target.total += input + output + cacheRead + cacheWrite;
  return target;
}

function localDayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfLocalDayMs(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Determina la familia de precios ('opus' | 'sonnet' | 'haiku' | 'codex' | null)
 * a partir del identificador de modelo o proveedor.
 */
function resolveModelFamily(modelName, provider = '') {
  const raw = String(modelName || '').trim().toLowerCase();
  if (!raw || raw === '<synthetic>') return null;
  if (raw.includes('opus')) return 'opus';
  if (raw.includes('sonnet')) return 'sonnet';
  if (raw.includes('haiku')) return 'haiku';
  if (
    raw.includes('codex') ||
    raw.includes('gpt-') ||
    raw.startsWith('o1') ||
    raw.startsWith('o3') ||
    raw.startsWith('o4') ||
    provider === 'codex'
  ) {
    return 'codex';
  }
  return null;
}

/**
 * Calcula el costo estimado en USD para un bloque de tokens y una familia de modelo.
 * Devuelve null si la familia no tiene precio definido (nunca inventa 0 para modelos desconocidos).
 */
function estimateModelCostUsd(tokens, modelName, provider = '', priceTable = MODEL_FAMILY_PRICES_USD_PER_M) {
  if (!tokens) return null;
  const family = resolveModelFamily(modelName, provider);
  if (!family || !priceTable[family]) return null;
  const rates = priceTable[family];
  const input = Number(tokens.input) || 0;
  const output = Number(tokens.output) || 0;
  const cacheWrite = Number(tokens.cacheWrite) || 0;
  const cacheRead = Number(tokens.cacheRead) || 0;
  const cost =
    (input * rates.input +
      output * rates.output +
      cacheWrite * rates.cacheWrite +
      cacheRead * rates.cacheRead) /
    1_000_000;
  return cost;
}

/**
 * Calcula el costo estimado total de un mapa `byModel` ({ [modelName]: { tokens, provider } }).
 */
function estimateByModelCostUsd(byModel, priceTable = MODEL_FAMILY_PRICES_USD_PER_M) {
  if (!byModel || typeof byModel !== 'object') {
    return { estimatedCostUsd: 0, unpricedModels: [] };
  }
  let totalCost = 0;
  let pricedCount = 0;
  const unpricedModels = [];

  for (const [modelName, info] of Object.entries(byModel)) {
    const tokens = info && info.tokens ? info.tokens : info;
    const provider = (info && info.provider) || '';
    if (!tokens || (tokens.total || 0) <= 0) continue;
    const cost = estimateModelCostUsd(tokens, modelName, provider, priceTable);
    if (cost === null) {
      unpricedModels.push(modelName);
    } else {
      totalCost += cost;
      pricedCount++;
    }
  }

  return {
    estimatedCostUsd: pricedCount > 0 ? Math.round(totalCost * 10000) / 10000 : unpricedModels.length > 0 ? null : 0,
    unpricedModels
  };
}

function projectNameFromPath(cwdOrSlug) {
  if (!cwdOrSlug) return 'sin-proyecto';
  const cleaned = String(cwdOrSlug).replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cleaned || 'sin-proyecto';
}

function normalizePathKey(p) {
  if (!p) return '';
  const cleaned = String(p).trim().replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return process.platform === 'win32' ? cleaned.toLowerCase() : cleaned;
}

/**
 * Parsea el contenido de un archivo JSONL de Claude Code y devuelve su resumen por día y por modelo.
 * Deduplica respuestas en streaming por `requestId` o `message.id`.
 */
function parseClaudeTranscriptContent(content, { isSubagent = false } = {}) {
  const seenIds = new Set();
  const daily = {}; // dayKey -> { tokens, byHour: number[24], byModel: { [model]: tokens } }
  let shortestCwd = null;
  let lastSeenMs = 0;
  let hasUsage = false;

  const lines = String(content || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line[0] !== '{') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;

    if (typeof entry.cwd === 'string' && entry.cwd.trim()) {
      const c = entry.cwd.trim();
      if (shortestCwd === null || c.length < shortestCwd.length) {
        shortestCwd = c;
      }
    }

    if (entry.type !== 'assistant') continue;
    const msg = entry.message;
    if (!msg || typeof msg !== 'object' || !msg.usage) continue;
    const model = typeof msg.model === 'string' && msg.model.trim() ? msg.model.trim() : '';
    if (!model || model === '<synthetic>') continue;

    const uid = entry.requestId || msg.id;
    if (uid) {
      if (seenIds.has(uid)) continue;
      seenIds.add(uid);
    }

    const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(ts) || ts <= 0) continue;

    const u = msg.usage;
    const tok = {
      input: Math.max(0, Number(u.input_tokens) || 0),
      output: Math.max(0, Number(u.output_tokens) || 0),
      cacheWrite: Math.max(0, Number(u.cache_creation_input_tokens) || 0),
      cacheRead: Math.max(0, Number(u.cache_read_input_tokens) || 0)
    };
    tok.total = tok.input + tok.output + tok.cacheWrite + tok.cacheRead;
    if (tok.total <= 0) continue;

    hasUsage = true;
    if (ts > lastSeenMs) lastSeenMs = ts;

    const dayKey = localDayKey(ts);
    const hour = new Date(ts).getHours();
    if (!daily[dayKey]) {
      daily[dayKey] = {
        tokens: emptyTokens(),
        byHour: new Array(24).fill(0),
        byModel: {}
      };
    }
    addTokens(daily[dayKey].tokens, tok);
    daily[dayKey].byHour[hour] += tok.total;
    if (!daily[dayKey].byModel[model]) {
      daily[dayKey].byModel[model] = emptyTokens();
    }
    addTokens(daily[dayKey].byModel[model], tok);
  }

  return {
    provider: 'claude',
    isSubagent: Boolean(isSubagent),
    cwd: shortestCwd,
    lastSeenMs,
    hasUsage,
    daily
  };
}

/**
 * Parsea el contenido de un archivo rollout JSONL de Codex y devuelve su resumen por día y modelo.
 */
function parseCodexTranscriptContent(content) {
  const daily = {};
  let cwd = null;
  let model = 'codex';
  let lastSeenMs = 0;
  let hasUsage = false;
  let previous = { input: 0, cache: 0, output: 0, total: 0 };

  const lines = String(content || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line[0] !== '{') continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== 'object') continue;
    const payload = ev.payload || {};
    const ts = ev.timestamp ? Date.parse(ev.timestamp) : NaN;

    if (ev.type === 'session_meta' && typeof payload.cwd === 'string' && payload.cwd.trim()) {
      cwd = payload.cwd.trim();
    } else if (ev.type === 'turn_context' && typeof payload.model === 'string' && payload.model.trim()) {
      model = payload.model.trim();
    } else if (ev.type === 'event_msg' && payload.type === 'token_count') {
      const usage = payload.info && payload.info.total_token_usage;
      if (!usage || !Number.isFinite(ts) || ts <= 0) continue;
      const current = {
        input: Math.max(0, Number(usage.input_tokens) || 0),
        cache: Math.max(0, Number(usage.cached_input_tokens) || 0),
        output: Math.max(0, Number(usage.output_tokens) || 0),
        total: Math.max(0, Number(usage.total_tokens) || 0)
      };
      const delta = {
        input: Math.max(0, current.input - previous.input),
        cache: Math.max(0, current.cache - previous.cache),
        output: Math.max(0, current.output - previous.output),
        total: Math.max(0, current.total - previous.total)
      };
      previous = current;
      if (delta.total <= 0) continue;

      const tok = {
        input: Math.max(0, delta.input - delta.cache),
        output: delta.output,
        cacheRead: delta.cache,
        cacheWrite: 0
      };
      tok.total = tok.input + tok.output + tok.cacheRead;
      if (tok.total <= 0) continue;

      hasUsage = true;
      if (ts > lastSeenMs) lastSeenMs = ts;

      const dayKey = localDayKey(ts);
      const hour = new Date(ts).getHours();
      if (!daily[dayKey]) {
        daily[dayKey] = {
          tokens: emptyTokens(),
          byHour: new Array(24).fill(0),
          byModel: {}
        };
      }
      addTokens(daily[dayKey].tokens, tok);
      daily[dayKey].byHour[hour] += tok.total;
      const modelKey = model || 'codex';
      if (!daily[dayKey].byModel[modelKey]) {
        daily[dayKey].byModel[modelKey] = emptyTokens();
      }
      addTokens(daily[dayKey].byModel[modelKey], tok);
    }
  }

  return {
    provider: 'codex',
    isSubagent: false,
    cwd,
    lastSeenMs,
    hasUsage,
    daily
  };
}

/**
 * Construye el reporte consolidado de actividad diaria (últimos 6 meses) y uso por proyecto
 * a partir de una lista de resúmenes de archivos ya parseados.
 */
function aggregateUsageRecords(records, { now = Date.now(), daysWindow = SIX_MONTHS_DAYS } = {}) {
  const cutoffMs = startOfLocalDayMs(now - daysWindow * DAY_MS);
  const cutoffDayKey = localDayKey(cutoffMs);
  const todayDayKey = localDayKey(now);

  // 1. Determinar el cwd raíz más corto por cada carpeta de proyecto de Claude (projectSlug)
  const slugShortestCwd = new Map();
  for (const rec of records) {
    if (!rec || !rec.projectSlug || !rec.cwd) continue;
    const prev = slugShortestCwd.get(rec.projectSlug);
    if (!prev || rec.cwd.length < prev.length) {
      slugShortestCwd.set(rec.projectSlug, rec.cwd);
    }
  }

  // 2. Acumuladores por día y por proyecto
  const dailyMap = new Map(); // dayKey -> { tokens, byHour: number[24] }
  const projectsMap = new Map(); // projectKey -> { name, path, providers: Set, tokens, byModel, sessions, lastSeenMs }
  const totals = emptyTokens();
  const totalByModel = {};

  for (const rec of records) {
    if (!rec || !rec.hasUsage || !rec.daily) continue;

    const canonicalPath =
      (rec.projectSlug && slugShortestCwd.get(rec.projectSlug)) ||
      rec.cwd ||
      rec.projectSlug ||
      'sin-proyecto';
    const projKey = normalizePathKey(canonicalPath) || rec.projectSlug || 'sin-proyecto';

    let proj = null;
    let fileContributedInWindow = false;

    for (const [dayKey, dayData] of Object.entries(rec.daily)) {
      if (dayKey < cutoffDayKey || dayKey > todayDayKey) continue;
      if (!dayData || !dayData.tokens || dayData.tokens.total <= 0) continue;

      fileContributedInWindow = true;

      // Acumular en calendario de actividad diaria
      let dayAgg = dailyMap.get(dayKey);
      if (!dayAgg) {
        dayAgg = { tokens: emptyTokens(), byHour: new Array(24).fill(0) };
        dailyMap.set(dayKey, dayAgg);
      }
      addTokens(dayAgg.tokens, dayData.tokens);
      if (Array.isArray(dayData.byHour)) {
        for (let h = 0; h < 24; h++) {
          dayAgg.byHour[h] += dayData.byHour[h] || 0;
        }
      }

      // Acumular en el proyecto correspondiente
      if (!proj) {
        proj = projectsMap.get(projKey);
        if (!proj) {
          proj = {
            name: projectNameFromPath(canonicalPath),
            path: canonicalPath,
            providers: new Set(),
            tokens: emptyTokens(),
            byModel: {},
            sessions: 0,
            lastSeenMs: 0
          };
          projectsMap.set(projKey, proj);
        }
      }

      proj.providers.add(rec.provider || 'claude');
      addTokens(proj.tokens, dayData.tokens);
      addTokens(totals, dayData.tokens);

      if (dayData.byModel) {
        for (const [modelName, mTok] of Object.entries(dayData.byModel)) {
          if (!proj.byModel[modelName]) {
            proj.byModel[modelName] = { provider: rec.provider || 'claude', tokens: emptyTokens() };
          }
          addTokens(proj.byModel[modelName].tokens, mTok);

          if (!totalByModel[modelName]) {
            totalByModel[modelName] = { provider: rec.provider || 'claude', tokens: emptyTokens() };
          }
          addTokens(totalByModel[modelName].tokens, mTok);
        }
      }
    }

    if (fileContributedInWindow && proj) {
      if (!rec.isSubagent) {
        proj.sessions += 1;
      }
      if ((rec.lastSeenMs || 0) > proj.lastSeenMs) {
        proj.lastSeenMs = rec.lastSeenMs;
      }
    }
  }

  // Formatear lista de días de actividad ordenada cronológicamente
  const activityDays = [];
  let maxDailyTokens = 0;
  let activeDaysCount = 0;

  const sortedDayKeys = Array.from(dailyMap.keys()).sort();
  for (const dayKey of sortedDayKeys) {
    const item = dailyMap.get(dayKey);
    const t = item.tokens.total;
    if (t <= 0) continue;
    activeDaysCount++;
    if (t > maxDailyTokens) maxDailyTokens = t;
    let peakHour = 0;
    let peakVal = -1;
    for (let h = 0; h < 24; h++) {
      if (item.byHour[h] > peakVal) {
        peakVal = item.byHour[h];
        peakHour = h;
      }
    }
    activityDays.push({
      date: dayKey,
      total: t,
      input: item.tokens.input,
      output: item.tokens.output,
      cacheRead: item.tokens.cacheRead,
      cacheWrite: item.tokens.cacheWrite,
      peakHour
    });
  }

  // Formatear lista de proyectos ordenada de mayor a menor consumo de tokens
  const projects = [];
  const allUnpriced = new Set();

  for (const proj of projectsMap.values()) {
    if (proj.tokens.total <= 0) continue;
    const costInfo = estimateByModelCostUsd(proj.byModel);
    for (const m of costInfo.unpricedModels) allUnpriced.add(m);

    const modelsSummary = Object.entries(proj.byModel)
      .map(([model, info]) => ({
        model,
        family: resolveModelFamily(model, info.provider),
        provider: info.provider,
        tokens: info.tokens,
        estimatedCostUsd: estimateModelCostUsd(info.tokens, model, info.provider)
      }))
      .sort((a, b) => b.tokens.total - a.tokens.total);

    projects.push({
      name: proj.name,
      path: proj.path,
      providers: Array.from(proj.providers),
      sessions: Math.max(1, proj.sessions),
      lastSeen: proj.lastSeenMs || null,
      tokens: proj.tokens,
      models: modelsSummary,
      estimatedCostUsd: costInfo.estimatedCostUsd
    });
  }

  projects.sort((a, b) => b.tokens.total - a.tokens.total || a.name.localeCompare(b.name));

  const totalCostInfo = estimateByModelCostUsd(totalByModel);

  return {
    generatedAt: now,
    windowDays: daysWindow,
    fromDate: cutoffDayKey,
    toDate: todayDayKey,
    pricing: {
      asOf: PRICES_AS_OF,
      isEstimate: true,
      families: MODEL_FAMILY_PRICES_USD_PER_M,
      unpricedModels: Array.from(allUnpriced).sort()
    },
    activity: {
      days: activityDays,
      maxDailyTokens,
      activeDaysCount
    },
    projects,
    totals: {
      tokens: totals,
      projectsCount: projects.length,
      estimatedCostUsd: totalCostInfo.estimatedCostUsd
    }
  };
}

/**
 * Recorre recursivamente los archivos .jsonl de una carpeta de proyecto de Claude.
 */
function listClaudeProjectJsonlFiles(projectDir, cutoffMs, depth = 0, out = []) {
  if (depth > 3) return out;
  let entries;
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(projectDir, entry.name);
    if (entry.isDirectory()) {
      listClaudeProjectJsonlFiles(full, cutoffMs, depth + 1, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs >= cutoffMs && stat.size > 0) {
          out.push({
            filePath: full,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            isSubagent: depth > 0
          });
        }
      } catch {}
    }
  }
  return out;
}

/**
 * Recorre recursivamente los archivos .jsonl de sesiones de Codex.
 */
function listCodexJsonlFiles(sessionsDir, cutoffMs, depth = 0, out = []) {
  if (depth > 4) return out;
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(sessionsDir, entry.name);
    if (entry.isDirectory()) {
      listCodexJsonlFiles(full, cutoffMs, depth + 1, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs >= cutoffMs && stat.size > 0) {
          out.push({
            filePath: full,
            mtimeMs: stat.mtimeMs,
            size: stat.size
          });
        }
      } catch {}
    }
  }
  return out;
}

/**
 * Crea un agregador incremental con caché en memoria por archivo (mtimeMs + size).
 */
function createProjectUsageAggregator({
  claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects'),
  codexSessionsDir = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'),
  cacheTtlMs = 15000
} = {}) {
  const fileCache = new Map(); // filePath -> { mtimeMs, size, record }
  let lastReport = null;
  let lastReportAt = 0;

  function getUsageReport({ now = Date.now(), force = false } = {}) {
    if (!force && lastReport && now - lastReportAt < cacheTtlMs) {
      return lastReport;
    }

    const cutoffMs = startOfLocalDayMs(now - SIX_MONTHS_DAYS * DAY_MS);
    const activeFiles = new Set();
    const records = [];

    // 1. Escanear proyectos de Claude Code (~/.claude/projects/<projectSlug>/**/*.jsonl)
    if (claudeProjectsDir && fs.existsSync(claudeProjectsDir)) {
      let projectDirs = [];
      try {
        projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });
      } catch {}

      for (const dirent of projectDirs) {
        if (!dirent.isDirectory()) continue;
        const projectSlug = dirent.name;
        const projectFullDir = path.join(claudeProjectsDir, projectSlug);
        const files = listClaudeProjectJsonlFiles(projectFullDir, cutoffMs);

        for (const f of files) {
          activeFiles.add(f.filePath);
          const cached = fileCache.get(f.filePath);
          if (cached && cached.mtimeMs === f.mtimeMs && cached.size === f.size) {
            records.push(cached.record);
            continue;
          }
          try {
            const raw = fs.readFileSync(f.filePath, 'utf8');
            const parsed = parseClaudeTranscriptContent(raw, { isSubagent: f.isSubagent });
            const record = { ...parsed, projectSlug };
            fileCache.set(f.filePath, { mtimeMs: f.mtimeMs, size: f.size, record });
            records.push(record);
          } catch {}
        }
      }
    }

    // 2. Escanear sesiones de Codex (~/.codex/sessions/**/*.jsonl)
    if (codexSessionsDir && fs.existsSync(codexSessionsDir)) {
      const codexFiles = listCodexJsonlFiles(codexSessionsDir, cutoffMs);
      for (const f of codexFiles) {
        activeFiles.add(f.filePath);
        const cached = fileCache.get(f.filePath);
        if (cached && cached.mtimeMs === f.mtimeMs && cached.size === f.size) {
          records.push(cached.record);
          continue;
        }
        try {
          const raw = fs.readFileSync(f.filePath, 'utf8');
          const parsed = parseCodexTranscriptContent(raw);
          const record = { ...parsed, projectSlug: null };
          fileCache.set(f.filePath, { mtimeMs: f.mtimeMs, size: f.size, record });
          records.push(record);
        } catch {}
      }
    }

    // Limpiar entradas de archivos borrados o fuera de ventana
    for (const cachedPath of fileCache.keys()) {
      if (!activeFiles.has(cachedPath)) {
        fileCache.delete(cachedPath);
      }
    }

    lastReport = aggregateUsageRecords(records, { now, daysWindow: SIX_MONTHS_DAYS });
    lastReportAt = now;
    return lastReport;
  }

  return {
    getUsageReport,
    getCacheSize: () => fileCache.size
  };
}

module.exports = {
  SIX_MONTHS_DAYS,
  PRICES_AS_OF,
  MODEL_FAMILY_PRICES_USD_PER_M,
  emptyTokens,
  addTokens,
  localDayKey,
  resolveModelFamily,
  estimateModelCostUsd,
  estimateByModelCostUsd,
  parseClaudeTranscriptContent,
  parseCodexTranscriptContent,
  aggregateUsageRecords,
  createProjectUsageAggregator
};
