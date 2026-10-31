const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData, threadId } = require('node:worker_threads');

const DAY_MS = 24 * 3600 * 1000;
const SIX_MONTHS_DAYS = 183; // ~6 meses (26 semanas + margen)
const STREAM_CHUNK_BYTES = 64 * 1024; // 64 KB por bloque de lectura incremental
const MAX_LINE_CARRY_BYTES = 4 * 1024 * 1024; // Límite defensivo ante líneas corruptas sin '\n'
const MAX_SEEN_IDS_PER_FILE = 2500; // Cota de memoria por archivo para deduplicación de streaming
const DEFAULT_MAX_CACHED_FILES = 2500; // Cota de archivos agregados en caché
const CACHE_SCHEMA_VERSION = 1; // Versión del esquema de caché en disco (ignorar si no coincide)
const DEFAULT_CACHE_PATH = path.join(os.homedir(), '.claude', 'ai-pulse', 'project-usage-cache.json');
const DEFAULT_CACHE_SAVE_THROTTLE_MS = 30 * 1000; // Máximo una escritura a disco cada ~30 s
const MAX_PERSISTED_SEEN_GROUPS_PER_FILE = 250; // Cota de entradas de deduplicación persistidas por archivo
const FILE_HEAD_HASH_BYTES = 128; // Bytes iniciales para huella rápida de identidad de archivo

// Tarifas oficiales verificadas por modelo y versión en USD por millón de tokens (USD / 1M tokens).
// Fuentes y fecha de verificación (2026-10-30):
// 1. Anthropic API Pricing (https://platform.claude.com/docs/en/about-claude/pricing, verificado 2026-10-30):
//    - Escritura de caché efímera 5m = 1.25x input base; escritura de caché 1h = 2.0x input base; lectura de caché = 0.1x input base.
//    - Claude Opus 4.5 / 4.6: $5 / $25 (5m: $6.25, 1h: $10.00, read: $0.50).
//    - Claude Opus 4 / 4.1 y Claude 3 Opus: $15 / $75 (5m: $18.75, 1h: $30.00, read: $1.50).
//    - Claude Sonnet 3.5 / 3.7 / 4 / 4.5 / 4.6: $3 / $15 (5m: $3.75, 1h: $6.00, read: $0.30).
//    - Claude Haiku 4.5: $1 / $5 (5m: $1.25, 1h: $2.00, read: $0.10).
//    - Claude Haiku 3.5: $0.80 / $4.00 (5m: $1.00, 1h: $1.60, read: $0.08).
//    - Claude Haiku 3: $0.25 / $1.25 (5m: $0.30, 1h: $0.50, read: $0.03).
// 2. OpenAI API Pricing (https://developers.openai.com/api/docs/models/gpt-5-codex y https://openai.com/api/pricing, verificado 2026-10-30):
//    - GPT-5-Codex / GPT-5.1-Codex / GPT-5.1-Codex-Max / GPT-5 / GPT-5.1: $1.25 input / $10.00 output / $0.125 cached input.
//    - GPT-5.2-Codex / GPT-5.3-Codex / GPT-5.2: $1.75 input / $14.00 output / $0.175 cached input.
//    - GPT-5-Mini / GPT-5.1-Codex-Mini: $0.25 input / $2.00 output / $0.025 cached input.
//    - codex-mini-latest: $1.50 input / $6.00 output / $0.375 cached input.
//    - o3: $2.00 input / $8.00 output / $0.50 cached input.
//    - o4-mini: $1.10 input / $4.40 output / $0.275 cached input.
// Cualquier modelo sin tarifa verificada en esta tabla devuelve costo `null` (nunca se inventa ni se agrupa por familia).
const PRICES_AS_OF = '2026-10-30';

const MODEL_PRICES_USD_PER_M = Object.freeze({
  // Anthropic, generación actual (skill claude-api, tabla cacheada 2026-10-06). Escrituras de caché
  // a 1.25x/2x del input; las lecturas de Opus 5.5, Sonnet 5.5 y Fable 5.1 son tarifas publicadas
  // propias (no 0.1x). Haiku 5.5: tarifa hasta 100K tokens de prompt.
  'claude-fable-5-1': Object.freeze({ input: 10.0, output: 50.0, cacheWrite5m: 12.5, cacheWrite1h: 20.0, cacheRead: 0.25 }),
  'claude-opus-5-5': Object.freeze({ input: 4.0, output: 20.0, cacheWrite5m: 5.0, cacheWrite1h: 8.0, cacheRead: 0.20 }),
  'claude-sonnet-5-5': Object.freeze({ input: 2.0, output: 10.0, cacheWrite5m: 2.5, cacheWrite1h: 4.0, cacheRead: 0.20 }),
  'claude-haiku-5-5': Object.freeze({ input: 0.10, output: 0.50, cacheWrite5m: 0.125, cacheWrite1h: 0.20, cacheRead: 0.01 }),
  'claude-opus-4-8': Object.freeze({ input: 5.0, output: 25.0, cacheWrite5m: 6.25, cacheWrite1h: 10.0, cacheRead: 0.50 }),
  'claude-opus-4-7': Object.freeze({ input: 5.0, output: 25.0, cacheWrite5m: 6.25, cacheWrite1h: 10.0, cacheRead: 0.50 }),
  // Anthropic Opus 4.5 / 4.6 (https://platform.claude.com/docs/en/about-claude/pricing, 2026-10-30)
  'claude-opus-4-6': Object.freeze({ input: 5.0, output: 25.0, cacheWrite5m: 6.25, cacheWrite1h: 10.0, cacheRead: 0.50 }),
  'claude-opus-4-5': Object.freeze({ input: 5.0, output: 25.0, cacheWrite5m: 6.25, cacheWrite1h: 10.0, cacheRead: 0.50 }),
  // Anthropic Opus 4 / 4.1 y Claude 3 Opus (https://platform.claude.com/docs/en/about-claude/pricing, 2026-10-30)
  'claude-opus-4-1': Object.freeze({ input: 15.0, output: 75.0, cacheWrite5m: 18.75, cacheWrite1h: 30.0, cacheRead: 1.50 }),
  'claude-opus-4-0': Object.freeze({ input: 15.0, output: 75.0, cacheWrite5m: 18.75, cacheWrite1h: 30.0, cacheRead: 1.50 }),
  'claude-3-opus': Object.freeze({ input: 15.0, output: 75.0, cacheWrite5m: 18.75, cacheWrite1h: 30.0, cacheRead: 1.50 }),
  // Anthropic Sonnet 3.5 / 3.7 / 4 / 4.5 / 4.6 (https://platform.claude.com/docs/en/about-claude/pricing, 2026-10-30)
  'claude-sonnet-4-6': Object.freeze({ input: 3.0, output: 15.0, cacheWrite5m: 3.75, cacheWrite1h: 6.0, cacheRead: 0.30 }),
  'claude-sonnet-4-5': Object.freeze({ input: 3.0, output: 15.0, cacheWrite5m: 3.75, cacheWrite1h: 6.0, cacheRead: 0.30 }),
  'claude-sonnet-4-0': Object.freeze({ input: 3.0, output: 15.0, cacheWrite5m: 3.75, cacheWrite1h: 6.0, cacheRead: 0.30 }),
  'claude-3-7-sonnet': Object.freeze({ input: 3.0, output: 15.0, cacheWrite5m: 3.75, cacheWrite1h: 6.0, cacheRead: 0.30 }),
  'claude-3-5-sonnet': Object.freeze({ input: 3.0, output: 15.0, cacheWrite5m: 3.75, cacheWrite1h: 6.0, cacheRead: 0.30 }),
  // Anthropic Haiku 4.5 / 3.5 / 3 (https://platform.claude.com/docs/en/about-claude/pricing, 2026-10-30)
  'claude-haiku-4-5': Object.freeze({ input: 1.0, output: 5.0, cacheWrite5m: 1.25, cacheWrite1h: 2.0, cacheRead: 0.10 }),
  'claude-3-5-haiku': Object.freeze({ input: 0.80, output: 4.0, cacheWrite5m: 1.0, cacheWrite1h: 1.60, cacheRead: 0.08 }),
  'claude-3-haiku': Object.freeze({ input: 0.25, output: 1.25, cacheWrite5m: 0.30, cacheWrite1h: 0.50, cacheRead: 0.03 }),
  // OpenAI GPT-5 / Codex (https://developers.openai.com/api/docs/models/gpt-5-codex, 2026-10-30)
  'gpt-5-codex': Object.freeze({ input: 1.25, output: 10.0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.125 }),
  'gpt-5.1-codex': Object.freeze({ input: 1.25, output: 10.0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.125 }),
  'gpt-5.1-codex-max': Object.freeze({ input: 1.25, output: 10.0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.125 }),
  'gpt-5': Object.freeze({ input: 1.25, output: 10.0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.125 }),
  'gpt-5.1': Object.freeze({ input: 1.25, output: 10.0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.125 }),
  'gpt-5-mini': Object.freeze({ input: 0.25, output: 2.0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.025 }),
  'gpt-5.1-codex-mini': Object.freeze({ input: 0.25, output: 2.0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.025 }),
  'gpt-5.2-codex': Object.freeze({ input: 1.75, output: 14.0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.175 }),
  'gpt-5.3-codex': Object.freeze({ input: 1.75, output: 14.0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.175 }),
  'gpt-5.2': Object.freeze({ input: 1.75, output: 14.0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.175 }),
  'codex-mini-latest': Object.freeze({ input: 1.50, output: 6.0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.375 }),
  'o3': Object.freeze({ input: 2.0, output: 8.0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.50 }),
  'o4-mini': Object.freeze({ input: 1.10, output: 4.40, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.275 })
});

// Alias de referencia rápida por familia (conservado por compatibilidad de exportación; el cálculo usa MODEL_PRICES_USD_PER_M)
const MODEL_FAMILY_PRICES_USD_PER_M = Object.freeze({
  opus: MODEL_PRICES_USD_PER_M['claude-opus-4-6'],
  sonnet: MODEL_PRICES_USD_PER_M['claude-sonnet-4-6'],
  haiku: MODEL_PRICES_USD_PER_M['claude-haiku-4-5'],
  codex: MODEL_PRICES_USD_PER_M['gpt-5-codex']
});

function emptyTokens() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    total: 0
  };
}

function resolveCacheWriteBreakdown(src) {
  if (!src) return { write5m: 0, write1h: 0, cacheWrite: 0 };
  const rawWrite = Math.max(0, Number(src.cacheWrite) || 0);
  const write1h = Math.max(0, Number(src.cacheWrite1h) || 0);
  const explicit5m =
    src.cacheWrite5m !== undefined ? Math.max(0, Number(src.cacheWrite5m) || 0) : null;
  const write5m =
    explicit5m !== null
      ? explicit5m + Math.max(0, rawWrite - (explicit5m + write1h))
      : Math.max(0, rawWrite - write1h);
  const cacheWrite = Math.max(rawWrite, write5m + write1h);
  return { write5m, write1h, cacheWrite };
}

function addTokens(target, src, sign = 1) {
  if (!src) return target;
  const input = (Number(src.input) || 0) * sign;
  const output = (Number(src.output) || 0) * sign;
  const cacheRead = (Number(src.cacheRead) || 0) * sign;
  const { write5m, write1h, cacheWrite } = resolveCacheWriteBreakdown(src);

  target.input = Math.max(0, target.input + input);
  target.output = Math.max(0, target.output + output);
  target.cacheRead = Math.max(0, target.cacheRead + cacheRead);
  target.cacheWrite = Math.max(0, target.cacheWrite + cacheWrite * sign);
  target.cacheWrite5m = Math.max(0, (target.cacheWrite5m || 0) + write5m * sign);
  target.cacheWrite1h = Math.max(0, (target.cacheWrite1h || 0) + write1h * sign);
  target.total = target.input + target.output + target.cacheRead + target.cacheWrite;
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
 * Resuelve la clave exacta de tarifa para un identificador de modelo y versión.
 * Quita únicamente prefijos de proveedor y sufijos de snapshot de fecha (`-YYYYMMDD`, `-YYYY-MM-DD`).
 * Devuelve `null` si el modelo/versión no tiene tarifa verificada (nunca agrupa por familia).
 */
function resolveModelPricingKey(modelName, priceTable = MODEL_PRICES_USD_PER_M) {
  const raw = String(modelName || '').trim().toLowerCase();
  if (!raw || raw === '<synthetic>' || raw === 'codex') return null;
  if (!priceTable || typeof priceTable !== 'object') return null;

  let s = raw
    .replace(/^(?:anthropic|openai|models)\//, '')
    .replace(/^(?:us\.|eu\.|apac\.)?anthropic\./, '')
    .replace(/(?:-v\d+:\d+|@\d{8})$/, '');

  if (Object.prototype.hasOwnProperty.call(priceTable, s)) return s;

  // Quitar sufijo de fecha de snapshot (-YYYYMMDD o -YYYY-MM-DD) o -latest
  s = s.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  if (Object.prototype.hasOwnProperty.call(priceTable, s)) return s;

  if (s === 'codex-mini') s = 'codex-mini-latest';
  if (s.endsWith('-latest') && !Object.prototype.hasOwnProperty.call(priceTable, s)) {
    s = s.replace(/-latest$/, '');
  }

  if (s.startsWith('claude-')) {
    s = s.replace(/(\d)\.(\d)/g, '$1-$2').replace(/-v\d+$/, '');
    if (s === 'claude-opus-4') s = 'claude-opus-4-0';
    if (s === 'claude-sonnet-4') s = 'claude-sonnet-4-0';
  }

  if (Object.prototype.hasOwnProperty.call(priceTable, s)) return s;
  return null;
}

/**
 * Clasificación visual de familia ('opus' | 'sonnet' | 'haiku' | 'codex' | null)
 * usada por la interfaz para etiquetas/colores. No se utiliza para asignar precios.
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
 * Calcula el costo estimado en USD para un bloque de tokens y un modelo específico.
 * Devuelve `null` si el modelo/versión no tiene tarifa verificada en `priceTable`.
 * Aplica tarifas separadas para escritura de caché de 5m (1.25x input) y de 1h (2x input).
 */
function estimateModelCostUsd(tokens, modelName, _provider = '', priceTable = MODEL_PRICES_USD_PER_M) {
  if (!tokens) return null;
  const pricingKey = resolveModelPricingKey(modelName, priceTable);
  const rates =
    pricingKey && priceTable[pricingKey]
      ? priceTable[pricingKey]
      : priceTable && Object.prototype.hasOwnProperty.call(priceTable, modelName)
        ? priceTable[modelName]
        : null;
  if (!rates) return null;

  const input = Math.max(0, Number(tokens.input) || 0);
  const output = Math.max(0, Number(tokens.output) || 0);
  const cacheRead = Math.max(0, Number(tokens.cacheRead) || 0);
  const { write5m, write1h } = resolveCacheWriteBreakdown(tokens);

  const rate5m =
    rates.cacheWrite5m !== undefined ? Number(rates.cacheWrite5m) || 0 : Number(rates.cacheWrite) || 0;
  const rate1h =
    rates.cacheWrite1h !== undefined
      ? Number(rates.cacheWrite1h) || 0
      : rates.cacheWrite !== undefined
        ? (Number(rates.cacheWrite) || 0) * 1.6
        : 0;

  const cost =
    (input * (Number(rates.input) || 0) +
      output * (Number(rates.output) || 0) +
      write5m * rate5m +
      write1h * rate1h +
      cacheRead * (Number(rates.cacheRead) || 0)) /
    1_000_000;
  return cost;
}

/**
 * Calcula el costo estimado total de un mapa `byModel` ({ [modelName]: { tokens, provider } }).
 * Si existen modelos con tokens sin tarifa conocida:
 * - Si ningún modelo tiene tarifa conocida, `estimatedCostUsd` es `null`.
 * - Si hay mezcla de modelos con tarifa conocida y desconocida, marca `costPartial: true`,
 *   informa `knownCostUsd`, `unpricedTokens` y `unpricedModels` para no tratarlos silenciosamente como 0.
 */
function estimateByModelCostUsd(byModel, priceTable = MODEL_PRICES_USD_PER_M) {
  if (!byModel || typeof byModel !== 'object') {
    return {
      estimatedCostUsd: 0,
      knownCostUsd: 0,
      costPartial: false,
      unpricedTokens: 0,
      unpricedModels: []
    };
  }
  let totalCost = 0;
  let pricedCount = 0;
  let unpricedTokens = 0;
  const unpricedModels = [];

  for (const [modelName, info] of Object.entries(byModel)) {
    const tokens = info && info.tokens ? info.tokens : info;
    const provider = (info && info.provider) || '';
    if (!tokens || (tokens.total || 0) <= 0) continue;
    const cost = estimateModelCostUsd(tokens, modelName, provider, priceTable);
    if (cost === null) {
      unpricedModels.push(modelName);
      unpricedTokens += Number(tokens.total) || 0;
    } else {
      totalCost += cost;
      pricedCount++;
    }
  }

  const roundedKnown = Math.round(totalCost * 10000) / 10000;
  const hasUnpriced = unpricedModels.length > 0;
  const costPartial = pricedCount > 0 && hasUnpriced;
  const estimatedCostUsd = pricedCount > 0 ? roundedKnown : hasUnpriced ? null : 0;

  return {
    estimatedCostUsd,
    knownCostUsd: pricedCount > 0 ? roundedKnown : 0,
    costPartial,
    unpricedTokens,
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

function createClaudeFileState({ isSubagent = false, projectSlug = null } = {}) {
  return {
    provider: 'claude',
    isSubagent: Boolean(isSubagent),
    projectSlug: projectSlug || null,
    cwd: null,
    lastSeenMs: 0,
    hasUsage: false,
    daily: {}, // dayKey -> { tokens, byHour: number[24], byModel: { [model]: tokens } }
    seenEntries: new Map() // dedupKey -> { dayKey, hour, model, tok }
  };
}

function rememberSeenClaudeEntry(seenMap, keys, value) {
  for (const k of keys) {
    if (!k) continue;
    if (!seenMap.has(k) && seenMap.size >= MAX_SEEN_IDS_PER_FILE) {
      const oldestKey = seenMap.keys().next().value;
      if (oldestKey !== undefined) seenMap.delete(oldestKey);
    }
    seenMap.set(k, value);
  }
}

/**
 * Procesa una línea JSONL de Claude Code sobre el estado acumulado del archivo.
 * Deduplica entradas repetidas de streaming por `message.id + requestId` (y por `requestId` o `message.id` individual).
 * Conserva por separado `ephemeral_5m_input_tokens` y `ephemeral_1h_input_tokens`.
 */
function processClaudeJsonlLine(state, line) {
  if (!line || line[0] !== '{') return false;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return false;
  }
  if (!entry || typeof entry !== 'object') return false;

  if (typeof entry.cwd === 'string' && entry.cwd.trim()) {
    const c = entry.cwd.trim();
    if (state.cwd === null || c.length < state.cwd.length) {
      state.cwd = c;
    }
  }

  if (entry.type !== 'assistant') return true;
  const msg = entry.message;
  if (!msg || typeof msg !== 'object' || !msg.usage) return true;
  const model = typeof msg.model === 'string' && msg.model.trim() ? msg.model.trim() : '';
  if (!model || model === '<synthetic>') return true;

  const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  if (!Number.isFinite(ts) || ts <= 0) return true;

  const u = msg.usage;
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const rawTotalWrite = Math.max(0, Number(u.cache_creation_input_tokens) || 0);
  const write1h = cc ? Math.max(0, Number(cc.ephemeral_1h_input_tokens) || 0) : 0;
  const explicit5m =
    cc && cc.ephemeral_5m_input_tokens !== undefined
      ? Math.max(0, Number(cc.ephemeral_5m_input_tokens) || 0)
      : null;
  // Si no hay desglose (o si cache_creation_input_tokens supera la suma del desglose), el remanente cae como 5m
  const write5m =
    explicit5m !== null
      ? explicit5m + Math.max(0, rawTotalWrite - (explicit5m + write1h))
      : Math.max(0, rawTotalWrite - write1h);
  const cacheWrite = Math.max(rawTotalWrite, write5m + write1h);

  const tok = {
    input: Math.max(0, Number(u.input_tokens) || 0),
    output: Math.max(0, Number(u.output_tokens) || 0),
    cacheWrite,
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
    cacheRead: Math.max(0, Number(u.cache_read_input_tokens) || 0)
  };
  tok.total = tok.input + tok.output + tok.cacheWrite + tok.cacheRead;
  if (tok.total <= 0) return true;

  const msgId = typeof msg.id === 'string' ? msg.id.trim() : '';
  const reqId = typeof entry.requestId === 'string' ? entry.requestId.trim() : '';
  const compositeKey = msgId && reqId ? `mr:${msgId}:${reqId}` : '';
  const msgKey = msgId ? `m:${msgId}` : '';
  const reqKey = reqId ? `r:${reqId}` : '';
  const lookupKeys = [compositeKey, msgKey, reqKey].filter(Boolean);

  if (lookupKeys.length > 0) {
    let prev = null;
    for (const k of lookupKeys) {
      if (state.seenEntries.has(k)) {
        prev = state.seenEntries.get(k);
        break;
      }
    }
    if (prev) {
      // Si el chunk repetido tiene igual o menor cantidad de tokens, se descarta para no duplicar
      if (tok.total <= prev.tok.total && tok.output <= prev.tok.output) {
        return true;
      }
      // Si es una actualización progresiva del mismo mensaje en streaming con mayor conteo final, reemplazar el anterior
      const prevDay = state.daily[prev.dayKey];
      if (prevDay) {
        addTokens(prevDay.tokens, prev.tok, -1);
        prevDay.byHour[prev.hour] = Math.max(0, (prevDay.byHour[prev.hour] || 0) - prev.tok.total);
        if (prevDay.byModel[prev.model]) {
          addTokens(prevDay.byModel[prev.model], prev.tok, -1);
        }
      }
    }
  }

  state.hasUsage = true;
  if (ts > state.lastSeenMs) state.lastSeenMs = ts;

  const dayKey = localDayKey(ts);
  const hour = new Date(ts).getHours();
  if (!state.daily[dayKey]) {
    state.daily[dayKey] = {
      tokens: emptyTokens(),
      byHour: new Array(24).fill(0),
      byModel: {}
    };
  }
  addTokens(state.daily[dayKey].tokens, tok, 1);
  state.daily[dayKey].byHour[hour] += tok.total;
  if (!state.daily[dayKey].byModel[model]) {
    state.daily[dayKey].byModel[model] = emptyTokens();
  }
  addTokens(state.daily[dayKey].byModel[model], tok, 1);

  if (lookupKeys.length > 0) {
    rememberSeenClaudeEntry(state.seenEntries, lookupKeys, { dayKey, hour, model, tok });
  }
  return true;
}

function toFileRecord(state) {
  return {
    provider: state.provider,
    isSubagent: Boolean(state.isSubagent),
    projectSlug: state.projectSlug || null,
    cwd: state.cwd,
    lastSeenMs: state.lastSeenMs,
    hasUsage: state.hasUsage,
    daily: state.daily
  };
}

/**
 * Parsea el contenido completo de un archivo JSONL de Claude Code y devuelve su resumen por día y modelo.
 */
function parseClaudeTranscriptContent(content, { isSubagent = false, projectSlug = null } = {}) {
  const state = createClaudeFileState({ isSubagent, projectSlug });
  const str = String(content || '');
  let start = 0;
  const len = str.length;
  while (start < len) {
    let end = str.indexOf('\n', start);
    if (end === -1) end = len;
    let lineEnd = end;
    if (lineEnd > start && str.charCodeAt(lineEnd - 1) === 13) lineEnd--;
    if (lineEnd > start && str.charCodeAt(start) === 123 /* '{' */) {
      processClaudeJsonlLine(state, str.slice(start, lineEnd));
    }
    start = end + 1;
  }
  return toFileRecord(state);
}

function createCodexFileState() {
  return {
    provider: 'codex',
    isSubagent: false,
    projectSlug: null,
    cwd: null,
    model: 'codex',
    lastSeenMs: 0,
    hasUsage: false,
    previous: { input: 0, cache: 0, output: 0, total: 0 },
    daily: {}
  };
}

function processCodexJsonlLine(state, line) {
  if (!line || line[0] !== '{') return false;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return false;
  }
  if (!ev || typeof ev !== 'object') return false;
  const payload = ev.payload || {};
  const ts = ev.timestamp ? Date.parse(ev.timestamp) : NaN;

  if (ev.type === 'session_meta' && typeof payload.cwd === 'string' && payload.cwd.trim()) {
    state.cwd = payload.cwd.trim();
  } else if (ev.type === 'turn_context' && typeof payload.model === 'string' && payload.model.trim()) {
    state.model = payload.model.trim();
  } else if (ev.type === 'event_msg' && payload.type === 'token_count') {
    const usage = payload.info && payload.info.total_token_usage;
    if (!usage || !Number.isFinite(ts) || ts <= 0) return true;
    const current = {
      input: Math.max(0, Number(usage.input_tokens) || 0),
      cache: Math.max(0, Number(usage.cached_input_tokens) || 0),
      output: Math.max(0, Number(usage.output_tokens) || 0),
      total: Math.max(0, Number(usage.total_tokens) || 0)
    };
    const delta = {
      input: Math.max(0, current.input - state.previous.input),
      cache: Math.max(0, current.cache - state.previous.cache),
      output: Math.max(0, current.output - state.previous.output),
      total: Math.max(0, current.total - state.previous.total)
    };
    state.previous = current;
    if (delta.total <= 0) return true;

    const tok = {
      input: Math.max(0, delta.input - delta.cache),
      output: delta.output,
      cacheRead: delta.cache,
      cacheWrite: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0
    };
    tok.total = tok.input + tok.output + tok.cacheRead;
    if (tok.total <= 0) return true;

    state.hasUsage = true;
    if (ts > state.lastSeenMs) state.lastSeenMs = ts;

    const dayKey = localDayKey(ts);
    const hour = new Date(ts).getHours();
    if (!state.daily[dayKey]) {
      state.daily[dayKey] = {
        tokens: emptyTokens(),
        byHour: new Array(24).fill(0),
        byModel: {}
      };
    }
    addTokens(state.daily[dayKey].tokens, tok, 1);
    state.daily[dayKey].byHour[hour] += tok.total;
    const modelKey = state.model || 'codex';
    if (!state.daily[dayKey].byModel[modelKey]) {
      state.daily[dayKey].byModel[modelKey] = emptyTokens();
    }
    addTokens(state.daily[dayKey].byModel[modelKey], tok, 1);
  }
  return true;
}

/**
 * Parsea el contenido de un archivo rollout JSONL de Codex y devuelve su resumen por día y modelo.
 */
function parseCodexTranscriptContent(content) {
  const state = createCodexFileState();
  const str = String(content || '');
  let start = 0;
  const len = str.length;
  while (start < len) {
    let end = str.indexOf('\n', start);
    if (end === -1) end = len;
    let lineEnd = end;
    if (lineEnd > start && str.charCodeAt(lineEnd - 1) === 13) lineEnd--;
    if (lineEnd > start && str.charCodeAt(start) === 123 /* '{' */) {
      processCodexJsonlLine(state, str.slice(start, lineEnd));
    }
    start = end + 1;
  }
  return toFileRecord(state);
}

const sharedReadBuffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
const headHashBuffer = Buffer.allocUnsafe(FILE_HEAD_HASH_BYTES);

function computeBufferHeadHash(buf, len = buf.length) {
  const n = Math.min(FILE_HEAD_HASH_BYTES, len, buf.length);
  if (n <= 0) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < n; i++) {
    hash ^= buf[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function readFileHeadHash(filePath, maxBytes = FILE_HEAD_HASH_BYTES) {
  const toRead = Math.min(FILE_HEAD_HASH_BYTES, Math.max(0, Number(maxBytes) || 0));
  if (toRead <= 0) return 0;
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, headHashBuffer, 0, toRead, 0);
    if (bytesRead <= 0) return 0;
    return computeBufferHeadHash(headHashBuffer, bytesRead);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Lee un archivo JSONL por bloques desde `startOffset` hasta `targetSize` sin cargar el archivo entero
 * ni hacer `.split()`. Devuelve el nuevo offset de byte confirmado, cualquier resto parcial de línea (`carry`)
 * y la huella de cabecera (`headHash`) si se leyó desde el byte 0.
 */
function streamJsonlFileIncremental(filePath, startOffset, targetSize, onLine, initialCarry = '') {
  if (targetSize <= startOffset) {
    return {
      nextOffset: startOffset,
      bytesRead: 0,
      linesProcessed: 0,
      carry: typeof initialCarry === 'string' ? initialCarry : '',
      headHash: null
    };
  }

  const fd = fs.openSync(filePath, 'r');
  let pos = startOffset;
  let lastCommittedOffset = startOffset;
  let carryBuf =
    typeof initialCarry === 'string' && initialCarry.length > 0
      ? Buffer.from(initialCarry, 'utf8')
      : null;
  let carryOut = '';
  let headHash = null;
  let linesProcessed = 0;

  try {
    while (pos < targetSize) {
      const toRead = Math.min(STREAM_CHUNK_BYTES, targetSize - pos);
      const bytesRead = fs.readSync(fd, sharedReadBuffer, 0, toRead, pos);
      if (bytesRead <= 0) break;

      if (pos === 0 && headHash === null) {
        headHash = computeBufferHeadHash(sharedReadBuffer, bytesRead);
      }

      const slice = sharedReadBuffer.subarray(0, bytesRead);
      const bufferStartFileOffset = pos - (carryBuf ? carryBuf.length : 0);
      const chunk = carryBuf ? Buffer.concat([carryBuf, slice]) : slice;
      carryBuf = null;

      let searchFrom = 0;
      while (searchFrom < chunk.length) {
        const nlIdx = chunk.indexOf(0x0a, searchFrom); // '\n'
        if (nlIdx === -1) break;
        let lineEnd = nlIdx;
        if (lineEnd > searchFrom && chunk[lineEnd - 1] === 0x0d) {
          lineEnd--; // '\r'
        }
        if (lineEnd > searchFrom && chunk[searchFrom] === 0x7b /* '{' */) {
          const lineStr = chunk.toString('utf8', searchFrom, lineEnd);
          onLine(lineStr);
          linesProcessed++;
        }
        searchFrom = nlIdx + 1;
        lastCommittedOffset = bufferStartFileOffset + searchFrom;
      }

      if (searchFrom < chunk.length) {
        const remaining = chunk.subarray(searchFrom);
        if (remaining.length <= MAX_LINE_CARRY_BYTES) {
          carryBuf = Buffer.from(remaining);
        } else {
          // Descartar línea anormalmente larga sin salto de línea para acotar memoria
          carryBuf = null;
          lastCommittedOffset = pos + bytesRead;
        }
      } else {
        lastCommittedOffset = pos + bytesRead;
      }

      pos += bytesRead;
    }

    // Si quedó una última línea sin '\n' al final del archivo, procesarla si es JSON válido completo;
    // de lo contrario conservarla en `carry` y avanzar el offset hasta `pos` para continuar en el próximo escaneo.
    if (carryBuf && carryBuf.length > 0) {
      let end = carryBuf.length;
      if (end > 0 && carryBuf[end - 1] === 0x0d) end--;
      if (end > 0 && carryBuf[0] === 0x7b /* '{' */ && carryBuf[end - 1] === 0x7d /* '}' */) {
        const lineStr = carryBuf.toString('utf8', 0, end);
        if (onLine(lineStr)) {
          linesProcessed++;
          lastCommittedOffset = pos;
          carryOut = '';
        } else {
          carryOut = carryBuf.toString('utf8');
          lastCommittedOffset = pos;
        }
      } else if (end === 0) {
        lastCommittedOffset = pos;
        carryOut = '';
      } else {
        carryOut = carryBuf.toString('utf8');
        lastCommittedOffset = pos;
      }
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }

  return {
    nextOffset: lastCommittedOffset,
    bytesRead: Math.max(0, lastCommittedOffset - startOffset),
    linesProcessed,
    carry: carryOut,
    headHash
  };
}

function pruneFileStateDays(state, cutoffDayKey) {
  if (!state || !state.daily) return false;
  let pruned = false;
  for (const dayKey of Object.keys(state.daily)) {
    if (dayKey < cutoffDayKey) {
      delete state.daily[dayKey];
      pruned = true;
    }
  }
  return pruned;
}

/**
 * Construye el reporte consolidado de actividad diaria (últimos 6 meses) y uso por proyecto
 * a partir de una lista de resúmenes de archivos ya parseados.
 */
function aggregateUsageRecords(records, { now = Date.now(), daysWindow = SIX_MONTHS_DAYS, coverage = null } = {}) {
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
      cacheWrite5m: item.tokens.cacheWrite5m || 0,
      cacheWrite1h: item.tokens.cacheWrite1h || 0,
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
        pricingKey: resolveModelPricingKey(model),
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
      estimatedCostUsd: costInfo.estimatedCostUsd,
      knownCostUsd: costInfo.knownCostUsd,
      costPartial: costInfo.costPartial,
      unpricedTokens: costInfo.unpricedTokens,
      unpricedModels: costInfo.unpricedModels
    });
  }

  projects.sort((a, b) => b.tokens.total - a.tokens.total || a.name.localeCompare(b.name));

  const totalCostInfo = estimateByModelCostUsd(totalByModel);

  const defaultCoverage = coverage || {
    sourcesConfigured: 2,
    sourcesAvailable: 2,
    claudeAvailable: true,
    codexAvailable: true,
    scannedFiles: records.length,
    cachedFiles: 0,
    incrementalFiles: 0,
    fullReadFiles: records.length,
    bytesRead: 0,
    unreadableFiles: 0,
    errorCount: 0,
    errors: [],
    status: 'ok'
  };

  return {
    generatedAt: now,
    updatedAt: now,
    computing: false,
    stale: false,
    lastError: null,
    windowDays: daysWindow,
    fromDate: cutoffDayKey,
    toDate: todayDayKey,
    coverage: defaultCoverage,
    pricing: {
      asOf: PRICES_AS_OF,
      isEstimate: true,
      models: MODEL_PRICES_USD_PER_M,
      families: MODEL_FAMILY_PRICES_USD_PER_M,
      costPartial: totalCostInfo.costPartial,
      unpricedTokens: totalCostInfo.unpricedTokens,
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
      estimatedCostUsd: totalCostInfo.estimatedCostUsd,
      knownCostUsd: totalCostInfo.knownCostUsd,
      costPartial: totalCostInfo.costPartial,
      unpricedTokens: totalCostInfo.unpricedTokens,
      unpricedModels: totalCostInfo.unpricedModels
    }
  };
}

/**
 * Recorre recursivamente los archivos .jsonl de una carpeta de proyecto de Claude,
 * registrando errores de lectura en `errorCollector` en lugar de silenciarlos.
 */
function listClaudeProjectJsonlFiles(projectDir, cutoffMs, depth = 0, out = [], errorCollector = null) {
  if (depth > 3) return out;
  let entries;
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch (err) {
    if (errorCollector) {
      errorCollector.push({
        source: 'claude',
        path: projectDir,
        code: err.code || 'READDIR_ERROR',
        message: err.message
      });
    }
    return out;
  }
  for (const entry of entries) {
    const full = path.join(projectDir, entry.name);
    if (entry.isDirectory()) {
      listClaudeProjectJsonlFiles(full, cutoffMs, depth + 1, out, errorCollector);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs >= cutoffMs && stat.size > 0) {
          out.push({
            filePath: full,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            ino: stat.ino || 0,
            dev: stat.dev || 0,
            birthtimeMs: stat.birthtimeMs || 0,
            isSubagent: depth > 0
          });
        }
      } catch (err) {
        if (errorCollector && err.code !== 'ENOENT') {
          errorCollector.push({
            source: 'claude',
            path: full,
            code: err.code || 'STAT_ERROR',
            message: err.message
          });
        }
      }
    }
  }
  return out;
}

/**
 * Recorre recursivamente los archivos .jsonl de sesiones de Codex,
 * registrando errores de lectura en `errorCollector`.
 */
function listCodexJsonlFiles(sessionsDir, cutoffMs, depth = 0, out = [], errorCollector = null) {
  if (depth > 4) return out;
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch (err) {
    if (errorCollector) {
      errorCollector.push({
        source: 'codex',
        path: sessionsDir,
        code: err.code || 'READDIR_ERROR',
        message: err.message
      });
    }
    return out;
  }
  for (const entry of entries) {
    const full = path.join(sessionsDir, entry.name);
    if (entry.isDirectory()) {
      listCodexJsonlFiles(full, cutoffMs, depth + 1, out, errorCollector);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs >= cutoffMs && stat.size > 0) {
          out.push({
            filePath: full,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            ino: stat.ino || 0,
            dev: stat.dev || 0,
            birthtimeMs: stat.birthtimeMs || 0
          });
        }
      } catch (err) {
        if (errorCollector && err.code !== 'ENOENT') {
          errorCollector.push({
            source: 'codex',
            path: full,
            code: err.code || 'STAT_ERROR',
            message: err.message
          });
        }
      }
    }
  }
  return out;
}

function canReadIncrementally(cached, fileMeta) {
  if (!cached || !cached.state) return false;
  if (fileMeta.size < cached.offset || fileMeta.size < cached.size) return false;
  if (cached.ino && fileMeta.ino && cached.ino !== fileMeta.ino) return false;
  if (cached.dev && fileMeta.dev && cached.dev !== fileMeta.dev) return false;
  if (
    cached.birthtimeMs &&
    fileMeta.birthtimeMs &&
    Math.abs(cached.birthtimeMs - fileMeta.birthtimeMs) > 1
  ) {
    return false;
  }
  if (fileMeta.mtimeMs < cached.mtimeMs) return false;
  if (fileMeta.size === cached.size && fileMeta.mtimeMs !== cached.mtimeMs) return false;
  return true;
}

function isUnchangedCacheEntry(cached, fileMeta) {
  if (!canReadIncrementally(cached, fileMeta)) return false;
  return cached.size === fileMeta.size && cached.mtimeMs === fileMeta.mtimeMs && cached.offset === fileMeta.size;
}

function sanitizeTokens(src) {
  const t = emptyTokens();
  if (src && typeof src === 'object') {
    addTokens(t, src, 1);
  }
  return t;
}

/**
 * Recalcula todos los costos en USD de un resumen de uso a partir únicamente de sus conteos
 * de tokens y de la tabla de precios vigente (`MODEL_PRICES_USD_PER_M` / `PRICES_AS_OF`).
 */
function repriceUsageReport(rawReport, priceTable = MODEL_PRICES_USD_PER_M) {
  if (!rawReport || typeof rawReport !== 'object') return null;
  const totalByModel = {};
  const allUnpriced = new Set();
  const totalsTokens = sanitizeTokens(rawReport.totals && rawReport.totals.tokens);

  const projects = Array.isArray(rawReport.projects)
    ? rawReport.projects.map((proj) => {
        const projTokens = sanitizeTokens(proj && proj.tokens);
        const byModel = {};
        const rawModels = Array.isArray(proj && proj.models) ? proj.models : [];
        for (const m of rawModels) {
          if (!m || !m.model) continue;
          const tok = sanitizeTokens(m.tokens);
          const provider = m.provider || 'claude';
          byModel[m.model] = { provider, tokens: tok };
          if (!totalByModel[m.model]) {
            totalByModel[m.model] = { provider, tokens: emptyTokens() };
          }
          addTokens(totalByModel[m.model].tokens, tok);
        }

        const costInfo = estimateByModelCostUsd(byModel, priceTable);
        for (const um of costInfo.unpricedModels) allUnpriced.add(um);

        const modelsSummary = Object.entries(byModel)
          .map(([model, info]) => ({
            model,
            pricingKey: resolveModelPricingKey(model, priceTable),
            family: resolveModelFamily(model, info.provider),
            provider: info.provider,
            tokens: info.tokens,
            estimatedCostUsd: estimateModelCostUsd(info.tokens, model, info.provider, priceTable)
          }))
          .sort((a, b) => b.tokens.total - a.tokens.total);

        return {
          name: (proj && proj.name) || 'sin-proyecto',
          path: (proj && proj.path) || 'sin-proyecto',
          providers: Array.isArray(proj && proj.providers) ? proj.providers : [],
          sessions: Math.max(1, Number(proj && proj.sessions) || 1),
          lastSeen: (proj && proj.lastSeen) || null,
          tokens: projTokens,
          models: modelsSummary,
          estimatedCostUsd: costInfo.estimatedCostUsd,
          knownCostUsd: costInfo.knownCostUsd,
          costPartial: costInfo.costPartial,
          unpricedTokens: costInfo.unpricedTokens,
          unpricedModels: costInfo.unpricedModels
        };
      })
    : [];

  projects.sort((a, b) => b.tokens.total - a.tokens.total || a.name.localeCompare(b.name));

  const totalCostInfo = estimateByModelCostUsd(totalByModel, priceTable);
  const now = Date.now();
  const windowDays = Number(rawReport.windowDays) || SIX_MONTHS_DAYS;
  const cutoffMs = startOfLocalDayMs(now - windowDays * DAY_MS);

  return {
    generatedAt: Number(rawReport.generatedAt) || now,
    updatedAt: Number(rawReport.updatedAt) || Number(rawReport.generatedAt) || now,
    computing: Boolean(rawReport.computing),
    stale: Boolean(rawReport.stale),
    lastError: rawReport.lastError || null,
    windowDays,
    fromDate: rawReport.fromDate || localDayKey(cutoffMs),
    toDate: rawReport.toDate || localDayKey(now),
    coverage: rawReport.coverage || {
      sourcesConfigured: 2,
      sourcesAvailable: 2,
      claudeAvailable: true,
      codexAvailable: true,
      scannedFiles: 0,
      cachedFiles: 0,
      incrementalFiles: 0,
      fullReadFiles: 0,
      bytesRead: 0,
      unreadableFiles: 0,
      errorCount: 0,
      errors: [],
      status: 'ok'
    },
    pricing: {
      asOf: PRICES_AS_OF,
      isEstimate: true,
      models: priceTable,
      families: MODEL_FAMILY_PRICES_USD_PER_M,
      costPartial: totalCostInfo.costPartial,
      unpricedTokens: totalCostInfo.unpricedTokens,
      unpricedModels: Array.from(allUnpriced).sort()
    },
    activity: rawReport.activity
      ? {
          days: Array.isArray(rawReport.activity.days) ? rawReport.activity.days : [],
          maxDailyTokens: Number(rawReport.activity.maxDailyTokens) || 0,
          activeDaysCount: Number(rawReport.activity.activeDaysCount) || 0
        }
      : { days: [], maxDailyTokens: 0, activeDaysCount: 0 },
    projects,
    totals: {
      tokens: totalsTokens,
      projectsCount: projects.length,
      estimatedCostUsd: totalCostInfo.estimatedCostUsd,
      knownCostUsd: totalCostInfo.knownCostUsd,
      costPartial: totalCostInfo.costPartial,
      unpricedTokens: totalCostInfo.unpricedTokens,
      unpricedModels: totalCostInfo.unpricedModels
    }
  };
}

function serializeReportForCache(report) {
  if (!report || typeof report !== 'object') return null;
  const projects = Array.isArray(report.projects)
    ? report.projects.map((proj) => ({
        name: proj.name || 'sin-proyecto',
        path: proj.path || 'sin-proyecto',
        providers: Array.isArray(proj.providers) ? proj.providers : [],
        sessions: Math.max(1, Number(proj.sessions) || 1),
        lastSeen: proj.lastSeen || null,
        tokens: sanitizeTokens(proj.tokens),
        models: Array.isArray(proj.models)
          ? proj.models.map((m) => ({
              model: m.model,
              provider: m.provider || 'claude',
              tokens: sanitizeTokens(m.tokens)
            }))
          : []
      }))
    : [];

  return {
    generatedAt: Number(report.generatedAt) || Date.now(),
    updatedAt: Number(report.updatedAt) || Number(report.generatedAt) || Date.now(),
    lastError: report.lastError || null,
    windowDays: Number(report.windowDays) || SIX_MONTHS_DAYS,
    fromDate: report.fromDate || null,
    toDate: report.toDate || null,
    coverage: report.coverage || null,
    activity: report.activity
      ? {
          days: Array.isArray(report.activity.days) ? report.activity.days : [],
          maxDailyTokens: Number(report.activity.maxDailyTokens) || 0,
          activeDaysCount: Number(report.activity.activeDaysCount) || 0
        }
      : { days: [], maxDailyTokens: 0, activeDaysCount: 0 },
    projects,
    totals: {
      tokens: sanitizeTokens(report.totals && report.totals.tokens),
      projectsCount: projects.length
    }
  };
}

function serializeFileCacheEntry(item) {
  if (!item || !item.state) return null;
  const state = item.state;
  const dailyOut = {};
  if (state.daily && typeof state.daily === 'object') {
    for (const [dayKey, dayData] of Object.entries(state.daily)) {
      if (!dayData || !dayData.tokens || (Number(dayData.tokens.total) || 0) <= 0) continue;
      const byModelOut = {};
      if (dayData.byModel && typeof dayData.byModel === 'object') {
        for (const [modelName, tok] of Object.entries(dayData.byModel)) {
          if (!tok || (Number(tok.total) || 0) <= 0) continue;
          byModelOut[modelName] = sanitizeTokens(tok);
        }
      }
      const byHour = new Array(24).fill(0);
      if (Array.isArray(dayData.byHour)) {
        for (let h = 0; h < 24; h++) {
          byHour[h] = Math.max(0, Number(dayData.byHour[h]) || 0);
        }
      }
      dailyOut[dayKey] = {
        tokens: sanitizeTokens(dayData.tokens),
        byHour,
        byModel: byModelOut
      };
    }
  }

  let dedup = null;
  if (state.provider === 'codex') {
    dedup = {
      model: state.model || 'codex',
      previous: {
        input: Math.max(0, Number(state.previous && state.previous.input) || 0),
        cache: Math.max(0, Number(state.previous && state.previous.cache) || 0),
        output: Math.max(0, Number(state.previous && state.previous.output) || 0),
        total: Math.max(0, Number(state.previous && state.previous.total) || 0)
      }
    };
  } else {
    const groupsMap = new Map();
    if (state.seenEntries instanceof Map) {
      for (const [k, v] of state.seenEntries.entries()) {
        if (!k || !v || !v.tok) continue;
        let g = groupsMap.get(v);
        if (!g) {
          g = {
            keys: [],
            dayKey: v.dayKey,
            hour: Number(v.hour) || 0,
            model: v.model || '',
            tok: sanitizeTokens(v.tok)
          };
          groupsMap.set(v, g);
        }
        g.keys.push(k);
      }
    }
    const groups = Array.from(groupsMap.values());
    const recentGroups =
      groups.length > MAX_PERSISTED_SEEN_GROUPS_PER_FILE
        ? groups.slice(groups.length - MAX_PERSISTED_SEEN_GROUPS_PER_FILE)
        : groups;
    dedup = { seenEntries: recentGroups };
  }

  return {
    identity: {
      size: Math.max(0, Number(item.size) || 0),
      mtimeMs: Number(item.mtimeMs) || 0,
      ino: Number(item.ino) || 0,
      dev: Number(item.dev) || 0,
      birthtimeMs: Number(item.birthtimeMs) || 0,
      headHash: Number(item.headHash) || 0
    },
    offset: Math.max(0, Number(item.offset) || 0),
    carry: typeof item.carry === 'string' ? item.carry : '',
    provider: state.provider === 'codex' ? 'codex' : 'claude',
    isSubagent: Boolean(state.isSubagent),
    projectSlug: state.projectSlug || null,
    cwd: state.cwd || null,
    lastSeenMs: Number(state.lastSeenMs) || 0,
    hasUsage: Boolean(state.hasUsage),
    daily: dailyOut,
    dedup
  };
}

function deserializeFileCacheEntry(rawEntry, cutoffDayKey) {
  if (!rawEntry || typeof rawEntry !== 'object') return null;
  const id = rawEntry.identity && typeof rawEntry.identity === 'object' ? rawEntry.identity : rawEntry;
  const offset = Number(rawEntry.offset);
  const size = Number(id.size);
  const mtimeMs = Number(id.mtimeMs);
  if (
    !Number.isFinite(offset) ||
    offset < 0 ||
    !Number.isFinite(size) ||
    size < 0 ||
    offset > size ||
    !Number.isFinite(mtimeMs) ||
    mtimeMs <= 0
  ) {
    return null;
  }

  const provider = rawEntry.provider === 'codex' ? 'codex' : 'claude';
  const state =
    provider === 'codex'
      ? createCodexFileState()
      : createClaudeFileState({
          isSubagent: Boolean(rawEntry.isSubagent),
          projectSlug: rawEntry.projectSlug || null
        });

  state.cwd = typeof rawEntry.cwd === 'string' && rawEntry.cwd.trim() ? rawEntry.cwd.trim() : null;
  state.lastSeenMs = Number(rawEntry.lastSeenMs) || 0;
  state.hasUsage = Boolean(rawEntry.hasUsage);

  if (rawEntry.daily && typeof rawEntry.daily === 'object') {
    for (const [dayKey, dayData] of Object.entries(rawEntry.daily)) {
      if (!dayKey || (cutoffDayKey && dayKey < cutoffDayKey)) continue;
      if (!dayData || typeof dayData !== 'object') continue;
      const tok = sanitizeTokens(dayData.tokens);
      if (tok.total <= 0) continue;
      const byHour = new Array(24).fill(0);
      if (Array.isArray(dayData.byHour)) {
        for (let h = 0; h < 24; h++) {
          byHour[h] = Math.max(0, Number(dayData.byHour[h]) || 0);
        }
      }
      const byModel = {};
      if (dayData.byModel && typeof dayData.byModel === 'object') {
        for (const [modelName, mTok] of Object.entries(dayData.byModel)) {
          const cleanModelTok = sanitizeTokens(mTok);
          if (cleanModelTok.total > 0) {
            byModel[modelName] = cleanModelTok;
          }
        }
      }
      state.daily[dayKey] = {
        tokens: tok,
        byHour,
        byModel
      };
      state.hasUsage = true;
    }
  }

  const rawDedup = rawEntry.dedup && typeof rawEntry.dedup === 'object' ? rawEntry.dedup : null;
  if (provider === 'codex') {
    if (rawDedup) {
      if (typeof rawDedup.model === 'string' && rawDedup.model.trim()) {
        state.model = rawDedup.model.trim();
      }
      if (rawDedup.previous && typeof rawDedup.previous === 'object') {
        state.previous = {
          input: Math.max(0, Number(rawDedup.previous.input) || 0),
          cache: Math.max(0, Number(rawDedup.previous.cache) || 0),
          output: Math.max(0, Number(rawDedup.previous.output) || 0),
          total: Math.max(0, Number(rawDedup.previous.total) || 0)
        };
      }
    }
  } else if (rawDedup && Array.isArray(rawDedup.seenEntries)) {
    for (const g of rawDedup.seenEntries) {
      if (!g || !Array.isArray(g.keys) || !g.dayKey || !g.model || !g.tok) continue;
      const val = {
        dayKey: String(g.dayKey),
        hour: Math.max(0, Math.min(23, Number(g.hour) || 0)),
        model: String(g.model),
        tok: sanitizeTokens(g.tok)
      };
      rememberSeenClaudeEntry(state.seenEntries, g.keys, val);
    }
  }

  const carryStr =
    typeof rawEntry.carry === 'string' && rawEntry.carry.length <= MAX_LINE_CARRY_BYTES
      ? rawEntry.carry
      : '';

  return {
    offset,
    size,
    mtimeMs,
    ino: Number(id.ino) || 0,
    dev: Number(id.dev) || 0,
    birthtimeMs: Number(id.birthtimeMs) || 0,
    headHash: Number(id.headHash) || 0,
    carry: carryStr,
    state,
    record: toFileRecord(state)
  };
}

let atomicTmpSeq = 0;

/**
 * Persiste en disco de forma atómica (archivo temporal + rename) la caché por archivo
 * y el último resumen de reporte (almacenando solo tokens y recalculando costos al leer).
 */
function saveProjectUsageCache(cacheFilePath, fileCacheMap, lastValidReport = null, now = Date.now()) {
  if (!cacheFilePath) return false;
  let tmpPath = null;
  try {
    const dir = path.dirname(cacheFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const filesObj = {};
    if (fileCacheMap instanceof Map) {
      for (const [filePath, item] of fileCacheMap.entries()) {
        if (!filePath || !item) continue;
        const serialized = serializeFileCacheEntry(item);
        if (serialized) {
          filesObj[filePath] = serialized;
        }
      }
    }
    const payload = {
      version: CACHE_SCHEMA_VERSION,
      pricesAsOf: PRICES_AS_OF,
      savedAt: now,
      files: filesObj,
      lastReport: serializeReportForCache(lastValidReport)
    };
    tmpPath = `${cacheFilePath}.${process.pid}.${threadId || 0}.${now}.${++atomicTmpSeq}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmpPath, cacheFilePath);
    return true;
  } catch {
    if (tmpPath) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {}
    }
    return false;
  }
}

/**
 * Carga y valida la caché en disco. Si el archivo no existe, está corrupto o su `version`
 * no coincide con `CACHE_SCHEMA_VERSION`, devuelve `null` sin lanzar excepciones.
 */
function loadProjectUsageCache(
  cacheFilePath,
  { now = Date.now(), maxCachedFiles = DEFAULT_MAX_CACHED_FILES, summaryOnly = false } = {}
) {
  if (!cacheFilePath) return null;
  try {
    if (!fs.existsSync(cacheFilePath)) return null;
    const raw = fs.readFileSync(cacheFilePath, 'utf8');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.version !== CACHE_SCHEMA_VERSION) return null;
    if (!parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) {
      return null;
    }

    const lastReport = parsed.lastReport ? repriceUsageReport(parsed.lastReport) : null;
    if (summaryOnly) {
      return {
        version: parsed.version,
        pricesAsOf: parsed.pricesAsOf || null,
        savedAt: Number(parsed.savedAt) || null,
        cacheSize: Object.keys(parsed.files).length,
        lastReport
      };
    }

    const cutoffMs = startOfLocalDayMs(now - SIX_MONTHS_DAYS * DAY_MS);
    const cutoffDayKey = localDayKey(cutoffMs);
    const entries = [];

    for (const [filePath, rawEntry] of Object.entries(parsed.files)) {
      if (!filePath) continue;
      const entry = deserializeFileCacheEntry(rawEntry, cutoffDayKey);
      if (entry) {
        entries.push([filePath, entry]);
      }
    }

    if (entries.length > maxCachedFiles) {
      entries.sort((a, b) => (b[1].mtimeMs || 0) - (a[1].mtimeMs || 0));
      entries.length = maxCachedFiles;
    }

    return {
      version: parsed.version,
      pricesAsOf: parsed.pricesAsOf || null,
      savedAt: Number(parsed.savedAt) || null,
      files: new Map(entries),
      lastReport
    };
  } catch {
    return null;
  }
}

function resolveCacheFilePath(options = {}, hasCustomDirs = false) {
  if (options.cacheFilePath !== undefined) return options.cacheFilePath || null;
  if (options.cachePath !== undefined) return options.cachePath || null;
  if (options.filePath !== undefined) return options.filePath || null;
  return hasCustomDirs ? null : DEFAULT_CACHE_PATH;
}

/**
 * Escáner incremental con seguimiento de byte offset por archivo, caché acotada en memoria
 * y persistencia atómica en disco con throttling.
 */
function createIncrementalScanner(options = {}) {
  const hasCustomDirs = Boolean(options.claudeProjectsDir || options.codexSessionsDir);
  const claudeProjectsDir =
    options.claudeProjectsDir !== undefined
      ? options.claudeProjectsDir
      : path.join(os.homedir(), '.claude', 'projects');
  const codexSessionsDir =
    options.codexSessionsDir !== undefined
      ? options.codexSessionsDir
      : path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const maxCachedFiles = options.maxCachedFiles || DEFAULT_MAX_CACHED_FILES;
  const cacheFilePath = resolveCacheFilePath(options, hasCustomDirs);
  const saveThrottleMs =
    options.saveThrottleMs !== undefined && options.saveThrottleMs !== null
      ? Math.max(0, Number(options.saveThrottleMs) || 0)
      : DEFAULT_CACHE_SAVE_THROTTLE_MS;

  const fileCache = new Map(); // filePath -> { offset, size, mtimeMs, ino, dev, birthtimeMs, headHash, carry, state, record }
  let lastValidReport = null;
  let cacheDirty = false;
  let lastSavedAt = 0;
  let saveTimer = null;

  if (cacheFilePath) {
    const cacheExistedOnDisk = fs.existsSync(cacheFilePath);
    const loaded = loadProjectUsageCache(cacheFilePath, { maxCachedFiles });
    if (loaded) {
      for (const [k, v] of loaded.files.entries()) {
        fileCache.set(k, v);
      }
      if (loaded.lastReport) {
        lastValidReport = loaded.lastReport;
      }
      if (loaded.pricesAsOf !== PRICES_AS_OF || !loaded.lastReport) {
        cacheDirty = true;
      }
    } else if (cacheExistedOnDisk) {
      // El archivo existía pero estaba corrupto o tenía versión incompatible: reescribir tras escanear
      cacheDirty = true;
    }
  }

  function persistCacheNow(now = Date.now()) {
    if (!cacheFilePath) return false;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const ok = saveProjectUsageCache(cacheFilePath, fileCache, lastValidReport, now);
    if (ok) {
      cacheDirty = false;
      lastSavedAt = now;
    }
    return ok;
  }

  function scheduleThrottledSave(now = Date.now()) {
    if (!cacheFilePath || !cacheDirty || saveTimer) return;
    const elapsed = lastSavedAt > 0 ? Math.max(0, now - lastSavedAt) : 0;
    const delayMs = Math.max(25, saveThrottleMs - elapsed);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (cacheDirty && cacheFilePath) {
        persistCacheNow(Date.now());
      }
    }, delayMs);
    if (typeof saveTimer.unref === 'function') {
      saveTimer.unref();
    }
  }

  function flushCache({ now = Date.now() } = {}) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!cacheFilePath || !cacheDirty) return false;
    return persistCacheNow(now);
  }

  function enforceCacheBound() {
    if (fileCache.size <= maxCachedFiles) return false;
    const entries = Array.from(fileCache.entries()).sort(
      (a, b) => (a[1].mtimeMs || 0) - (b[1].mtimeMs || 0)
    );
    const toRemove = fileCache.size - maxCachedFiles;
    for (let i = 0; i < toRemove; i++) {
      fileCache.delete(entries[i][0]);
    }
    return toRemove > 0;
  }

  function processFileMeta(f, provider, projectSlug, cutoffDayKey, stats, errors) {
    const cached = fileCache.get(f.filePath);
    if (isUnchangedCacheEntry(cached, f)) {
      if (pruneFileStateDays(cached.state, cutoffDayKey)) {
        cached.record = toFileRecord(cached.state);
        cacheDirty = true;
      }
      stats.cachedFiles++;
      return cached.record;
    }

    let incremental = canReadIncrementally(cached, f) && cached.offset > 0 && f.size > cached.offset;
    if (incremental && cached.headHash) {
      const currentHeadHash = readFileHeadHash(
        f.filePath,
        Math.min(FILE_HEAD_HASH_BYTES, cached.offset)
      );
      if (currentHeadHash !== null && currentHeadHash !== cached.headHash) {
        incremental = false;
      }
    }

    const state = incremental
      ? cached.state
      : provider === 'codex'
        ? createCodexFileState()
        : createClaudeFileState({ isSubagent: f.isSubagent, projectSlug });
    const startOffset = incremental ? cached.offset : 0;
    const initialCarry = incremental && cached.carry ? cached.carry : '';

    try {
      const lineHandler =
        provider === 'codex'
          ? (line) => processCodexJsonlLine(state, line)
          : (line) => processClaudeJsonlLine(state, line);

      const streamRes = streamJsonlFileIncremental(
        f.filePath,
        startOffset,
        f.size,
        lineHandler,
        initialCarry
      );
      pruneFileStateDays(state, cutoffDayKey);
      const record = toFileRecord(state);
      const headHash =
        incremental && cached.headHash
          ? cached.headHash
          : streamRes.headHash !== null
            ? streamRes.headHash
            : readFileHeadHash(f.filePath, Math.min(FILE_HEAD_HASH_BYTES, f.size)) || 0;

      fileCache.set(f.filePath, {
        offset: streamRes.nextOffset,
        size: f.size,
        mtimeMs: f.mtimeMs,
        ino: f.ino || 0,
        dev: f.dev || 0,
        birthtimeMs: f.birthtimeMs || 0,
        headHash,
        carry: streamRes.carry || '',
        state,
        record
      });

      stats.bytesRead += streamRes.bytesRead;
      if (incremental) {
        stats.incrementalFiles++;
      } else {
        stats.fullReadFiles++;
      }
      return record;
    } catch (err) {
      stats.unreadableFiles++;
      errors.push({
        source: provider,
        path: f.filePath,
        code: err.code || 'READ_ERROR',
        message: err.message
      });
      if (cached && cached.record) {
        return cached.record;
      }
      return null;
    }
  }

  function scan({ now = Date.now(), forceSave = false } = {}) {
    const cutoffMs = startOfLocalDayMs(now - SIX_MONTHS_DAYS * DAY_MS);
    const cutoffDayKey = localDayKey(cutoffMs);
    const activeFiles = new Set();
    const records = [];
    const errors = [];
    const stats = {
      scannedFiles: 0,
      cachedFiles: 0,
      incrementalFiles: 0,
      fullReadFiles: 0,
      bytesRead: 0,
      unreadableFiles: 0
    };

    let claudeConfigured = Boolean(claudeProjectsDir);
    let codexConfigured = Boolean(codexSessionsDir);
    let claudeAvailable = false;
    let codexAvailable = false;
    let scanChangedCache = false;

    // 1. Escanear proyectos de Claude Code (~/.claude/projects/<projectSlug>/**/*.jsonl)
    if (claudeConfigured) {
      let projectDirs = null;
      try {
        projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });
        claudeAvailable = true;
      } catch (err) {
        errors.push({
          source: 'claude',
          path: claudeProjectsDir,
          code: err.code || 'SOURCE_UNAVAILABLE',
          message: err.message
        });
      }

      if (projectDirs) {
        for (const dirent of projectDirs) {
          if (!dirent.isDirectory()) continue;
          const projectSlug = dirent.name;
          const projectFullDir = path.join(claudeProjectsDir, projectSlug);
          const files = listClaudeProjectJsonlFiles(projectFullDir, cutoffMs, 0, [], errors);

          for (const f of files) {
            stats.scannedFiles++;
            activeFiles.add(f.filePath);
            const rec = processFileMeta(f, 'claude', projectSlug, cutoffDayKey, stats, errors);
            if (rec) records.push(rec);
          }
        }
      }
    }

    // 2. Escanear sesiones de Codex (~/.codex/sessions/**/*.jsonl)
    if (codexConfigured) {
      let codexRootStat = null;
      try {
        codexRootStat = fs.statSync(codexSessionsDir);
        if (codexRootStat.isDirectory()) {
          codexAvailable = true;
        }
      } catch (err) {
        errors.push({
          source: 'codex',
          path: codexSessionsDir,
          code: err.code || 'SOURCE_UNAVAILABLE',
          message: err.message
        });
      }

      if (codexAvailable) {
        const codexFiles = listCodexJsonlFiles(codexSessionsDir, cutoffMs, 0, [], errors);
        for (const f of codexFiles) {
          stats.scannedFiles++;
          activeFiles.add(f.filePath);
          const rec = processFileMeta(f, 'codex', null, cutoffDayKey, stats, errors);
          if (rec) records.push(rec);
        }
      }
    }

    // Si las fuentes estuvieron disponibles, limpiar archivos eliminados o fuera de ventana
    if (claudeAvailable || codexAvailable) {
      for (const cachedPath of fileCache.keys()) {
        if (!activeFiles.has(cachedPath)) {
          fileCache.delete(cachedPath);
          scanChangedCache = true;
        }
      }
    }
    if (enforceCacheBound()) {
      scanChangedCache = true;
    }
    if (stats.fullReadFiles > 0 || stats.incrementalFiles > 0) {
      scanChangedCache = true;
    }

    const sourcesConfigured = (claudeConfigured ? 1 : 0) + (codexConfigured ? 1 : 0);
    const sourcesAvailable = (claudeAvailable ? 1 : 0) + (codexAvailable ? 1 : 0);
    const nonEnoentErrors = errors.filter((e) => e.code !== 'ENOENT');
    const allSourcesFailed = sourcesConfigured > 0 && sourcesAvailable === 0;
    const hasFileErrors = stats.unreadableFiles > 0 || nonEnoentErrors.length > 0;

    const status = allSourcesFailed
      ? 'error'
      : hasFileErrors
        ? stats.scannedFiles > 0 && records.length === 0
          ? 'error'
          : 'partial'
        : 'ok';

    const coverage = {
      sourcesConfigured,
      sourcesAvailable,
      claudeAvailable,
      codexAvailable,
      scannedFiles: stats.scannedFiles,
      cachedFiles: stats.cachedFiles,
      incrementalFiles: stats.incrementalFiles,
      fullReadFiles: stats.fullReadFiles,
      bytesRead: stats.bytesRead,
      unreadableFiles: stats.unreadableFiles,
      errorCount: errors.length,
      errors: errors.slice(0, 25),
      status
    };

    // Si falló la lectura de la fuente y teníamos un resumen válido previo, conservarlo marcado como stale
    if ((status === 'error' || (status === 'partial' && records.length === 0)) && lastValidReport) {
      const staleReport = {
        ...lastValidReport,
        stale: true,
        lastError: (errors[0] && errors[0].message) || 'No se pudo leer la fuente de uso',
        coverage
      };
      return {
        report: staleReport,
        stats: { ...stats, cacheSize: fileCache.size }
      };
    }

    const hadPreviousReport = Boolean(lastValidReport);
    const report = aggregateUsageRecords(records, {
      now,
      daysWindow: SIX_MONTHS_DAYS,
      coverage
    });

    if (status === 'error') {
      report.stale = Boolean(lastValidReport);
      report.lastError = (errors[0] && errors[0].message) || 'No se pudo leer la fuente de uso';
    } else if (status === 'partial') {
      report.lastError = (errors[0] && errors[0].message) || 'Lectura parcial de sesiones';
      lastValidReport = report;
      if (!hadPreviousReport) scanChangedCache = true;
    } else {
      lastValidReport = report;
      if (!hadPreviousReport) scanChangedCache = true;
    }

    if (status !== 'error') {
      if (scanChangedCache) {
        cacheDirty = true;
      }
      if (cacheDirty && cacheFilePath) {
        const canSaveNow =
          forceSave ||
          lastSavedAt === 0 ||
          saveThrottleMs <= 0 ||
          now - lastSavedAt >= saveThrottleMs;
        if (canSaveNow) {
          persistCacheNow(now);
        } else {
          scheduleThrottledSave(now);
        }
      }
    }

    return {
      report,
      stats: { ...stats, cacheSize: fileCache.size }
    };
  }

  function stop() {
    return flushCache({ now: Date.now() });
  }

  return {
    scan,
    flushCache,
    stop,
    getCacheSize: () => fileCache.size,
    getCacheFilePath: () => cacheFilePath,
    getLastSavedAt: () => lastSavedAt,
    isCacheDirty: () => cacheDirty,
    getFileCacheEntry: (filePath) => {
      const item = fileCache.get(filePath);
      if (!item) return null;
      return {
        offset: item.offset,
        size: item.size,
        mtimeMs: item.mtimeMs,
        ino: item.ino || 0,
        dev: item.dev || 0,
        birthtimeMs: item.birthtimeMs || 0,
        headHash: item.headHash || 0,
        carry: item.carry || ''
      };
    }
  };
}

function buildInitialEmptyReport(now = Date.now()) {
  const base = aggregateUsageRecords([], { now, daysWindow: SIX_MONTHS_DAYS });
  return {
    ...base,
    updatedAt: null,
    computing: true,
    coverage: {
      ...base.coverage,
      status: 'computing'
    }
  };
}

/**
 * Crea el agregador de uso por proyecto respaldado por un worker (`node:worker_threads`)
 * para no bloquear el hilo principal durante el escaneo y parseo incremental de JSONL.
 */
function createProjectUsageAggregator(options = {}) {
  const hasCustomDirs = Boolean(options.claudeProjectsDir || options.codexSessionsDir);
  const claudeProjectsDir =
    options.claudeProjectsDir !== undefined
      ? options.claudeProjectsDir
      : path.join(os.homedir(), '.claude', 'projects');
  const codexSessionsDir =
    options.codexSessionsDir !== undefined
      ? options.codexSessionsDir
      : path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const cacheTtlMs = options.cacheTtlMs !== undefined ? options.cacheTtlMs : 15000;
  const maxCachedFiles = options.maxCachedFiles || DEFAULT_MAX_CACHED_FILES;
  const cacheFilePath = resolveCacheFilePath(options, hasCustomDirs);
  const saveThrottleMs =
    options.saveThrottleMs !== undefined && options.saveThrottleMs !== null
      ? Math.max(0, Number(options.saveThrottleMs) || 0)
      : DEFAULT_CACHE_SAVE_THROTTLE_MS;

  let worker = null;
  let stopped = false;
  let lastReport = null;
  let lastUpdatedAt = null;
  let lastScanStartedAt = 0;
  let computing = false;
  let hasCompletedLiveScan = false;
  let reqSeq = 0;
  let activeScanReqId = 0;
  let queuedScanArgs = null;
  let lastStats = {
    cacheSize: 0,
    scannedFiles: 0,
    cachedFiles: 0,
    incrementalFiles: 0,
    fullReadFiles: 0,
    bytesRead: 0,
    unreadableFiles: 0
  };
  const pendingWaiters = new Set();

  if (cacheFilePath) {
    const persisted = loadProjectUsageCache(cacheFilePath, {
      maxCachedFiles,
      summaryOnly: true
    });
    if (persisted && persisted.lastReport) {
      lastReport = {
        ...persisted.lastReport,
        stale: true,
        computing: true
      };
      lastUpdatedAt =
        persisted.lastReport.updatedAt ||
        persisted.lastReport.generatedAt ||
        persisted.savedAt ||
        Date.now();
      lastStats.cacheSize = persisted.cacheSize || 0;
    }
  }

  function resolveAllWaiters(reportObj) {
    for (const resolve of pendingWaiters) {
      try {
        resolve(reportObj);
      } catch {}
    }
    pendingWaiters.clear();
  }

  function ensureWorker() {
    if (stopped) return null;
    if (worker) return worker;

    worker = new Worker(__filename, {
      workerData: {
        role: 'projectUsageWorker',
        claudeProjectsDir,
        codexSessionsDir,
        maxCachedFiles,
        cacheFilePath,
        saveThrottleMs
      }
    });
    if (typeof worker.unref === 'function') {
      worker.unref();
    }

    worker.on('message', (msg) => {
      if (!msg || msg.type !== 'scanResult') return;
      hasCompletedLiveScan = true;
      if (msg.stats) {
        lastStats = msg.stats;
      }
      if (msg.report) {
        if (msg.report.stale && lastReport && !lastReport.stale) {
          lastReport = {
            ...lastReport,
            stale: true,
            lastError: msg.report.lastError,
            coverage: msg.report.coverage
          };
        } else {
          lastReport = msg.report;
          lastUpdatedAt = msg.report.updatedAt || msg.report.generatedAt || Date.now();
        }
      }

      if (queuedScanArgs) {
        const nextArgs = queuedScanArgs;
        queuedScanArgs = null;
        postScanToWorker(nextArgs);
        return;
      }

      computing = false;
      resolveAllWaiters(buildResponseSnapshot());
    });

    worker.on('error', (err) => {
      computing = false;
      queuedScanArgs = null;
      if (lastReport) {
        lastReport = {
          ...lastReport,
          stale: true,
          lastError: err.message
        };
      }
      worker = null;
      resolveAllWaiters(buildResponseSnapshot());
    });

    worker.on('exit', () => {
      computing = false;
      worker = null;
      resolveAllWaiters(buildResponseSnapshot());
    });

    return worker;
  }

  function postScanToWorker({ now = Date.now(), force = false } = {}) {
    const w = ensureWorker();
    if (!w) return false;
    computing = true;
    lastScanStartedAt = now;
    activeScanReqId = ++reqSeq;
    w.postMessage({
      type: 'scan',
      reqId: activeScanReqId,
      now,
      force: Boolean(force)
    });
    return true;
  }

  function triggerScanIfNeeded({ now = Date.now(), force = false } = {}) {
    if (stopped) return;
    if (computing) {
      if (force) {
        queuedScanArgs = { now, force: true };
      }
      return;
    }
    const ttlExpired =
      !hasCompletedLiveScan ||
      lastUpdatedAt === null ||
      cacheTtlMs <= 0 ||
      now - lastUpdatedAt >= cacheTtlMs;
    if (force || !lastReport || ttlExpired) {
      postScanToWorker({ now, force });
    }
  }

  function buildResponseSnapshot(now = Date.now()) {
    if (!lastReport) {
      const empty = buildInitialEmptyReport(now);
      return {
        ...empty,
        computing: Boolean(computing),
        updatedAt: lastUpdatedAt
      };
    }
    const isStartupStale = !hasCompletedLiveScan;
    return {
      ...lastReport,
      stale: Boolean(lastReport.stale || isStartupStale),
      computing: Boolean(computing || isStartupStale),
      updatedAt: lastUpdatedAt
    };
  }

  /**
   * Devuelve de inmediato el último resumen calculado sin bloquear el proceso principal.
   * Si el caché venció, es el primer arranque con resumen persistido o `force` es true,
   * dispara el escaneo incremental en el worker y marca `computing: true`
   * (y `stale: true` hasta finalizar el primer escaneo tras iniciar).
   */
  function getUsageReport({ now = Date.now(), force = false } = {}) {
    triggerScanIfNeeded({ now, force });
    return buildResponseSnapshot(now);
  }

  /**
   * Dispara (si corresponde) y espera a que el worker termine el escaneo en curso,
   * resolviendo con el resumen actualizado (`computing: false`).
   */
  function refresh({ now = Date.now(), force = false } = {}) {
    triggerScanIfNeeded({ now, force });
    if (!computing && lastReport && hasCompletedLiveScan) {
      return Promise.resolve(buildResponseSnapshot(now));
    }
    return new Promise((resolve) => {
      pendingWaiters.add(resolve);
    });
  }

  async function stop() {
    stopped = true;
    queuedScanArgs = null;
    computing = false;
    if (worker) {
      const w = worker;
      worker = null;
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, 1500);
        if (typeof timer.unref === 'function') timer.unref();
        w.once('message', (msg) => {
          if (msg && msg.type === 'stopped') finish();
        });
        w.once('exit', finish);
        w.once('error', finish);
        try {
          w.postMessage({ type: 'stop', reqId: ++reqSeq });
        } catch {
          finish();
        }
      });
      try {
        await w.terminate();
      } catch {}
    }
    resolveAllWaiters(buildResponseSnapshot());
  }

  return {
    getUsageReport,
    refresh,
    stop,
    getCacheSize: () => lastStats.cacheSize || 0,
    getCacheFilePath: () => cacheFilePath,
    getStats: () => ({ ...lastStats, computing, updatedAt: lastUpdatedAt, lastScanStartedAt })
  };
}

// Punto de entrada cuando este archivo se ejecuta dentro del worker_thread
if (!isMainThread && parentPort && workerData && workerData.role === 'projectUsageWorker') {
  const scanner = createIncrementalScanner({
    claudeProjectsDir: workerData.claudeProjectsDir,
    codexSessionsDir: workerData.codexSessionsDir,
    maxCachedFiles: workerData.maxCachedFiles || DEFAULT_MAX_CACHED_FILES,
    cacheFilePath: workerData.cacheFilePath,
    saveThrottleMs: workerData.saveThrottleMs
  });

  parentPort.on('message', (msg) => {
    if (!msg) return;
    if (msg.type === 'stop') {
      try {
        scanner.stop();
      } catch {}
      parentPort.postMessage({
        type: 'stopped',
        reqId: msg.reqId || 0
      });
      return;
    }
    if (msg.type !== 'scan') return;
    try {
      const result = scanner.scan({ now: msg.now || Date.now() });
      parentPort.postMessage({
        type: 'scanResult',
        reqId: msg.reqId,
        report: result.report,
        stats: result.stats
      });
    } catch (err) {
      parentPort.postMessage({
        type: 'scanResult',
        reqId: msg.reqId,
        report: {
          ...buildInitialEmptyReport(msg.now || Date.now()),
          computing: false,
          stale: true,
          lastError: err.message,
          coverage: {
            sourcesConfigured: 2,
            sourcesAvailable: 0,
            claudeAvailable: false,
            codexAvailable: false,
            scannedFiles: 0,
            cachedFiles: 0,
            incrementalFiles: 0,
            fullReadFiles: 0,
            bytesRead: 0,
            unreadableFiles: 0,
            errorCount: 1,
            errors: [{ source: 'worker', path: '', code: 'WORKER_SCAN_ERROR', message: err.message }],
            status: 'error'
          }
        },
        stats: { cacheSize: scanner.getCacheSize() }
      });
    }
  });
}

module.exports = {
  SIX_MONTHS_DAYS,
  PRICES_AS_OF,
  CACHE_SCHEMA_VERSION,
  DEFAULT_CACHE_PATH,
  DEFAULT_CACHE_SAVE_THROTTLE_MS,
  MODEL_PRICES_USD_PER_M,
  MODEL_FAMILY_PRICES_USD_PER_M,
  emptyTokens,
  addTokens,
  localDayKey,
  resolveModelPricingKey,
  resolveModelFamily,
  estimateModelCostUsd,
  estimateByModelCostUsd,
  repriceUsageReport,
  loadProjectUsageCache,
  saveProjectUsageCache,
  parseClaudeTranscriptContent,
  parseCodexTranscriptContent,
  streamJsonlFileIncremental,
  aggregateUsageRecords,
  createIncrementalScanner,
  createProjectUsageAggregator
};
