const fs = require('fs');
const { TOKEN_WEIGHTS } = require('./tokenWeights');
const path = require('path');
const os = require('os');
const { createAgyQuotaStatusReader } = require('./agyQuotaStatus');
const readAgyQuotaStatus = createAgyQuotaStatusReader();

// Cache incremental por conversación para no re-parsear archivos JSONL ni SQLite sin cambios
const transcriptCache = new Map();
let settingsCache = { key: '', data: null };
let dbSummariesCache = { key: '', rows: [] };
let historyMapCache = { key: '', map: new Map() };
let brainScanCache = { mtimeMs: 0, checkedAt: 0, recentIds: [] };
let agyResultCache = { key: '', data: null };
const DEFAULT_FIVE_HOUR_LIMIT_M = 25;
const DEFAULT_SEVEN_DAY_LIMIT_M = 100;
const lockedPresencePolls = new Map();
const quotaSamples = new Map();
let summariesSourceError = false;
let summariesWarnedAt = -Infinity;
const unlockedPresenceCache = new Map(); // file -> { mtimeMs, checkedAt }

function getAgyBaseDir() {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

/**
 * Lee settings.json de AGY para obtener modelo activo y proyecto GCP
 */
function readAgySettings(baseDir) {
  const settingsPath = path.join(baseDir, 'settings.json');
  const defaults = {
    model: 'Gemini 4 Argon (Low)',
    gcpProject: 'GCP Workspace',
    gcpLocation: 'global'
  };
  if (!fs.existsSync(settingsPath)) return defaults;
  try {
    const st = fs.statSync(settingsPath);
    const key = `${st.mtimeMs}:${st.size}`;
    if (settingsCache.data && settingsCache.key === key) {
      return settingsCache.data;
    }
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const data = {
      model: raw.model || defaults.model,
      gcpProject: (raw.gcp && raw.gcp.project) || defaults.gcpProject,
      gcpLocation: (raw.gcp && raw.gcp.location) || defaults.gcpLocation
    };
    settingsCache = { key, data };
    return data;
  } catch {
    return defaults;
  }
}

/**
 * Detecta qué conversaciones de AGY tienen un bloqueo activo a nivel de SO
 * en ~/.gemini/antigravity-cli/presence/<conversationId>.lock
 */
function getActiveLockedConversations(baseDir) {
  const presenceDir = path.join(baseDir, 'presence');
  const activeMap = new Map(); // conversationId -> { lockMtimeMs }

  if (!fs.existsSync(presenceDir)) { lockedPresencePolls.clear(); return activeMap; }

  let files = [];
  try {
    files = fs.readdirSync(presenceDir);
  } catch {
    return activeMap;
  }

  for (const file of lockedPresencePolls.keys()) if (!files.includes(file)) lockedPresencePolls.delete(file);
  const now = Date.now();
  const buf = Buffer.alloc(1);
  for (const file of files) {
    if (!file.endsWith('.lock')) continue;
    const convId = file.slice(0, -5);
    const fullPath = path.join(presenceDir, file);
    let fileMtimeMs = 0;
    try {
      fileMtimeMs = fs.statSync(fullPath).mtimeMs;
    } catch {
      continue;
    }

    // Nota: en Windows, LockFileEx sobre un archivo .lock existente NO modifica su mtimeMs.
    // Por lo tanto, no podemos asumir que si mtimeMs no cambió nunca volverá a bloquearse;
    // usamos un TTL corto (3s) para archivos antiguos desbloqueados.
    const prevUnlocked = unlockedPresenceCache.get(file);
    if (
      prevUnlocked &&
      prevUnlocked.mtimeMs === fileMtimeMs &&
      now - fileMtimeMs > 60000 &&
      now - prevUnlocked.checkedAt < 3000
    ) {
      lockedPresencePolls.delete(file);
      continue;
    }

    let fd = null;
    let isLocked = false;
    try {
      fd = fs.openSync(fullPath, 'r');
      fs.readSync(fd, buf, 0, 1, 0);
    } catch (err) {
      if (err && (err.code === 'EBUSY' || err.code === 'EACCES' || err.code === 'EPERM')) {
        isLocked = true;
      }
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }

    if (isLocked) {
      unlockedPresenceCache.delete(file);
      const prior = lockedPresencePolls.get(file);
      const polls = prior && prior.mtimeMs === fileMtimeMs ? prior.polls + 1 : 1;
      lockedPresencePolls.set(file, { mtimeMs: fileMtimeMs, polls });
      if (polls >= 2) activeMap.set(convId, { lockMtimeMs: fileMtimeMs || now });
    } else {
      lockedPresencePolls.delete(file);
      unlockedPresenceCache.set(file, { mtimeMs: fileMtimeMs, checkedAt: now });
    }
  }

  return activeMap;
}

/**
 * Lee conversation_summaries.db usando el módulo nativo node:sqlite
 */
function readConversationSummaries(baseDir) {
  const dbPath = path.join(baseDir, 'conversation_summaries.db');
  if (!fs.existsSync(dbPath)) { summariesSourceError = false; return []; }

  let cacheKey = '';
  try {
    const st = fs.statSync(dbPath);
    let walPart = '0:0';
    const walPath = `${dbPath}-wal`;
    if (fs.existsSync(walPath)) {
      const wst = fs.statSync(walPath);
      walPart = `${wst.mtimeMs}:${wst.size}`;
    }
    cacheKey = `${st.mtimeMs}:${st.size}:${walPart}`;
    if (dbSummariesCache.key === cacheKey) {
      return dbSummariesCache.rows;
    }
  } catch {}

  let db = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath, { open: true, readOnly: true });
    const stmt = db.prepare(`
      SELECT
        conversation_id,
        title,
        preview,
        step_count,
        last_modified_time,
        workspace_uris,
        status,
        source,
        agent_name,
        parent_conversation_id,
        nesting_depth,
        not_fully_idle,
        killed,
        last_user_input_time
      FROM conversation_summaries
      ORDER BY last_modified_time DESC
      LIMIT 80
    `);
    const rows = stmt.all();
    summariesSourceError = false;
    if (cacheKey) {
      dbSummariesCache = { key: cacheKey, rows };
    }
    return rows;
  } catch (err) {
    summariesSourceError = true;
    if (Date.now() - summariesWarnedAt >= 60000) {
      console.warn('[AGY] No se pudo leer el resumen de conversaciones:', err.code || err.message);
      summariesWarnedAt = Date.now();
    }
    return dbSummariesCache.rows || [];
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }
}

/**
 * Lee history.jsonl como respaldo de workspaces y prompts recientes
 */
function readHistoryMap(baseDir) {
  const histPath = path.join(baseDir, 'history.jsonl');
  if (!fs.existsSync(histPath)) return new Map();

  try {
    const st = fs.statSync(histPath);
    const key = `${st.mtimeMs}:${st.size}`;
    if (historyMapCache.key === key) {
      return historyMapCache.map;
    }

    const map = new Map();
    const content = fs.readFileSync(histPath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (let i = Math.max(0, lines.length - 250); i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.conversationId) {
          map.set(obj.conversationId, {
            workspace: obj.workspace || '',
            lastPrompt: obj.display || '',
            timestamp: obj.timestamp || 0
          });
        }
      } catch {}
    }
    historyMapCache = { key, map };
    return map;
  } catch {
    return historyMapCache.map;
  }
}

const SLOT_MS = 15 * 60 * 1000; // Buckets de 15 minutos para ventanas móviles exactas (5h y 7d)

// Clave de día en FECHA LOCAL (toISOString usa UTC y corre el día en Argentina)
function localDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Parsea transcript.jsonl de una conversación de AGY (con caché por mtime/size)
 */
function readJsonlAppend(file, stat, cached) {
  const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  const resume = Boolean(cached && cached.identity === identity && stat.size >= cached.size &&
    !(stat.size === cached.size && stat.mtimeMs !== cached.mtimeMs));
  const offset = resume ? cached.size : 0;
  const buffer = Buffer.alloc(stat.size - offset);
  const fd = fs.openSync(file, 'r');
  let bytes;
  try { bytes = fs.readSync(fd, buffer, 0, buffer.length, offset); } finally { fs.closeSync(fd); }
  const content = Buffer.concat([resume ? cached.rest : Buffer.alloc(0), buffer.subarray(0, bytes)]);
  const end = content.lastIndexOf(10);
  const lines = end < 0 ? [] : content.subarray(0, end).toString('utf8').split('\n');
  return { identity, resume, size: offset + bytes, rest: content.subarray(end + 1), lines };
}

function parseTranscript(baseDir, convId) {
  const trPath = path.join(baseDir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!fs.existsSync(trPath)) {
    return null;
  }

  let stat;
  try {
    stat = fs.statSync(trPath);
  } catch {
    return null;
  }

  const cached = transcriptCache.get(convId);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.identity === `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` &&
    cached.evaluatedMinute === Math.floor(Date.now() / 60000)) {
    return cached.data;
  }

  let append;
  try { append = readJsonlAppend(trPath, stat, cached); } catch { return cached ? cached.data : null; }
  const lines = append.lines;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let turns = 0;
  let dailyTokens = {}; // YYYY-MM-DD -> { input, cacheRead, output, effective, total, turns }
  let slotTokens = {}; // slotIndex (15min) -> { input, cacheRead, output, effective, total, turns }

  let lastStep = null;
  let lastUserPrompt = '';
  let lastAssistantText = '';
  let lastThinkingTitle = '';
  let currentToolCall = null;
  let pendingQuestion = null;
  let lastErrorText = '';
  let lastActivityAt = stat.mtimeMs;
  let lastPlannedCommandDaemon = false;
  let activeBgTasks = new Map(); // taskId -> { taskId, detail, isDaemon, startedAt }
  let eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;

  let lineCount = 0;
  if (append.resume) ({ inputTokens, cacheReadTokens, outputTokens, turns, dailyTokens, slotTokens, lastStep, lastUserPrompt, lastAssistantText, lastThinkingTitle, currentToolCall, pendingQuestion, lastErrorText, lastActivityAt, lastPlannedCommandDaemon, activeBgTasks, lineCount } = cached.state);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }

    lastStep = step;
    let stepTs = stat.mtimeMs;
    if (step.created_at) {
      const ts = Date.parse(step.created_at);
      if (!Number.isNaN(ts)) {
        stepTs = ts;
        lastActivityAt = ts;
      }
    }

    if (step.type === 'USER_INPUT' && typeof step.content === 'string') {
      const match = step.content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
      const cleanUser = (match ? match[1] : step.content).trim();
      if (cleanUser) lastUserPrompt = cleanUser.slice(0, 220);
      pendingQuestion = null;
      lastErrorText = '';
    }

    if (step.type === 'ERROR_MESSAGE') {
      const rawErr = (step.error || step.content || '').trim();
      lastErrorText = rawErr.replace(/^Error:\s*/i, '').slice(0, 140) || 'Stream o llamada interrumpida';
    }

    if (step.type === 'GENERIC' && typeof step.content === 'string') {
      const bgMatch = step.content.match(
        /(?:Tool|Daemon task) is running (?:as a|in the) background (?:task )?with task id:\s*([^\s\r\n]+)/i
      );
      if (bgMatch) {
        const taskId = bgMatch[1].trim();
        const descMatch = step.content.match(/Task Description:\s*([^\r\n]+)/i);
        const isDaemon =
          lastPlannedCommandDaemon || /^Daemon task is running/i.test(step.content.trim());
        activeBgTasks.set(taskId, {
          taskId,
          detail: descMatch ? descMatch[1].trim().slice(0, 110) : taskId,
          isDaemon,
          startedAt: stepTs
        });
      }

      const cancelMatch = step.content.match(
        /Task\s+"([^"]+)"\s+(?:cancelled|canceled|killed|completed|stopped)/i
      );
      if (cancelMatch) {
        activeBgTasks.delete(cancelMatch[1].trim());
      }

      const statusMatch = step.content.match(
        /Task:\s*([^\s\r\n]+)[\s\S]*?Status:\s*(RUNNING|COMPLETED|FAILED|CANCELLED|CANCELED|KILLED|DONE|EXITED)/i
      );
      if (statusMatch) {
        const tId = statusMatch[1].trim();
        const st = statusMatch[2].toUpperCase();
        if (st === 'RUNNING') {
          if (!activeBgTasks.has(tId)) {
            activeBgTasks.set(tId, {
              taskId: tId,
              detail: tId,
              isDaemon: false,
              startedAt: stepTs
            });
          }
        } else {
          activeBgTasks.delete(tId);
        }
      }

      if (/You have 0 background task\(s\) currently running/i.test(step.content)) {
        activeBgTasks.clear();
      }
    }

    if (step.type === 'SYSTEM_MESSAGE' && typeof step.content === 'string') {
      const senderMatch = step.content.match(/\bsender=([^\s)\]]+)/i);
      if (senderMatch) {
        activeBgTasks.delete(senderMatch[1].trim());
      }
      const taskDoneMatch = step.content.match(/Task id\s+"([^"]+)"/i);
      if (taskDoneMatch) {
        activeBgTasks.delete(taskDoneMatch[1].trim());
      }
    }

    if (step.type === 'PLANNER_RESPONSE') {
      turns++;
      const inTok = Number(step.input_tokens) || 0;
      const cacheTok = Number(step.cache_read_tokens) || 0;
      const outTok = Number(step.output_tokens) || 0;

      inputTokens += inTok;
      cacheReadTokens += cacheTok;
      outputTokens += outTok;

      const tot = inTok + cacheTok + outTok;
      const eff = Math.round(inTok + cacheTok * TOKEN_WEIGHTS.cacheRead + outTok * TOKEN_WEIGHTS.output);

      const dayKey = localDayKey(stepTs);
      if (!dailyTokens[dayKey]) {
        dailyTokens[dayKey] = { input: 0, cacheRead: 0, output: 0, total: 0, effective: 0, turns: 0 };
      }
      dailyTokens[dayKey].input += inTok;
      dailyTokens[dayKey].cacheRead += cacheTok;
      dailyTokens[dayKey].output += outTok;
      dailyTokens[dayKey].total += tot;
      dailyTokens[dayKey].effective += eff;
      dailyTokens[dayKey].turns += 1;

      if (stepTs >= eightDaysAgo) {
        const slotKey = Math.floor(stepTs / SLOT_MS);
        if (!slotTokens[slotKey]) {
          slotTokens[slotKey] = { input: 0, cacheRead: 0, output: 0, total: 0, effective: 0, turns: 0 };
        }
        slotTokens[slotKey].input += inTok;
        slotTokens[slotKey].cacheRead += cacheTok;
        slotTokens[slotKey].output += outTok;
        slotTokens[slotKey].total += tot;
        slotTokens[slotKey].effective += eff;
        slotTokens[slotKey].turns += 1;
      }

      if (typeof step.content === 'string' && step.content.trim()) {
        lastAssistantText = step.content.trim().replace(/\s+/g, ' ').slice(0, 260);
      }

      if (typeof step.thinking === 'string' && step.thinking.trim()) {
        const headingMatches = [...step.thinking.matchAll(/\*\*([^*]+)\*\*/g)];
        if (headingMatches.length > 0) {
          lastThinkingTitle = headingMatches[headingMatches.length - 1][1].trim().slice(0, 90);
        }
      }

      if (
        (typeof step.content === 'string' && step.content.trim()) ||
        (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) ||
        step.input_tokens != null ||
        step.output_tokens != null
      ) {
        lastErrorText = '';
      }

      if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
        lastPlannedCommandDaemon = step.tool_calls.some(
          (t) =>
            t &&
            t.args &&
            (t.args.IsDaemon === true ||
              t.args.IsDaemon === 'true' ||
              String(t.args.IsDaemon).toLowerCase() === 'true')
        );

        for (const tc of step.tool_calls) {
          if (
            tc &&
            tc.name === 'manage_task' &&
            tc.args &&
            String(tc.args.Action || '').replace(/^["']+|["']+$/g, '') === 'kill' &&
            tc.args.TaskId
          ) {
            const killedId = String(tc.args.TaskId).replace(/^["']+|["']+$/g, '').trim();
            activeBgTasks.delete(killedId);
          }
        }

        const lastTool = step.tool_calls[step.tool_calls.length - 1];
        const toolName = lastTool.name || 'tool';
        let detail = '';
        if (lastTool.args) {
          detail =
            lastTool.args.toolSummary ||
            lastTool.args.CommandLine ||
            lastTool.args.Path ||
            lastTool.args.query ||
            lastTool.args.Role ||
            '';
        }
        currentToolCall = {
          name: toolName,
          detail: String(detail).slice(0, 90)
        };

        const askTool = step.tool_calls.find((t) => t.name === 'ask_question');
        if (askTool && askTool.args && Array.isArray(askTool.args.questions) && askTool.args.questions[0]) {
          pendingQuestion = askTool.args.questions[0].question || 'Esperando confirmación en cuestionario';
        } else {
          pendingQuestion = null;
        }
      } else {
        lastPlannedCommandDaemon = false;
        currentToolCall = null;
        pendingQuestion = null;
      }
    }
  }

  lineCount += lines.length;
  const state = { inputTokens, cacheReadTokens, outputTokens, turns, dailyTokens, slotTokens, lastStep, lastUserPrompt, lastAssistantText, lastThinkingTitle, currentToolCall, pendingQuestion, lastErrorText, lastActivityAt, lastPlannedCommandDaemon, activeBgTasks, lineCount };

  const runningBgTasks = [...activeBgTasks.values()].filter((t) => !t.isDaemon);
  const activeBgTask = runningBgTasks.length > 0 ? runningBgTasks[runningBgTasks.length - 1] : null;

  // Determinar estado detallado según los últimos pasos del transcript
  let transcriptState = 'idle'; // 'running' | 'waiting_approval' | 'waiting_input' | 'idle'
  let isStreamingIncomplete = false;
  if (lastStep) {
    // En AGY, mientras el modelo está pensando/generando una llamada a herramienta en vivo,
    // escribe un PLANNER_RESPONSE parcial con status: "DONE", thinking != "", pero sin content,
    // sin tool_calls y sin input_tokens/output_tokens aún.
    const isThinkingOnlyStep =
      lastStep.type === 'PLANNER_RESPONSE' &&
      (!Array.isArray(lastStep.tool_calls) || lastStep.tool_calls.length === 0) &&
      (!lastStep.content || !lastStep.content.trim()) &&
      Boolean(lastStep.thinking && lastStep.thinking.trim()) &&
      lastStep.input_tokens == null &&
      lastStep.output_tokens == null;

    if (isThinkingOnlyStep && Date.now() - lastActivityAt < 10 * 60 * 1000) {
      isStreamingIncomplete = true;
    }

    if (pendingQuestion && lastStep.type === 'PLANNER_RESPONSE') {
      transcriptState = 'waiting_approval';
    } else if (lastStep.status === 'RUNNING' || lastStep.status === 'PENDING' || isStreamingIncomplete) {
      if (pendingQuestion) {
        transcriptState = 'waiting_approval';
      } else {
        transcriptState = 'running';
      }
    } else if (
      lastStep.type === 'PLANNER_RESPONSE' &&
      lastStep.status === 'DONE' &&
      (!Array.isArray(lastStep.tool_calls) || lastStep.tool_calls.length === 0)
    ) {
      transcriptState = activeBgTask ? 'running' : 'waiting_input';
    } else if (
      lastStep.type === 'PLANNER_RESPONSE' &&
      Array.isArray(lastStep.tool_calls) &&
      lastStep.tool_calls.length > 0
    ) {
      transcriptState = pendingQuestion ? 'waiting_approval' : 'running';
    } else if (lastStep.type === 'GENERIC' && lastStep.status === 'DONE') {
      const ageMs = Date.now() - lastActivityAt;
      transcriptState = ageMs < 60000 || activeBgTask ? 'running' : 'waiting_input';
    } else if (lastStep.type === 'USER_INPUT' || lastStep.type === 'SYSTEM_MESSAGE') {
      const ageMs = Date.now() - lastActivityAt;
      transcriptState = ageMs < 60000 || activeBgTask ? 'running' : 'waiting_input';
    } else if (lastStep.type === 'ERROR_MESSAGE') {
      transcriptState = activeBgTask ? 'running' : 'waiting_input';
    }
  }

  const totalTokens = inputTokens + cacheReadTokens + outputTokens;
  const effectiveTokens = Math.round(inputTokens + cacheReadTokens * TOKEN_WEIGHTS.cacheRead + outputTokens * TOKEN_WEIGHTS.output);

  const data = {
    inputTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens,
    effectiveTokens,
    turns,
    dailyTokens,
    slotTokens,
    transcriptState,
    isStreamingIncomplete,
    lastThinkingTitle,
    lastErrorText,
    lastUserPrompt,
    lastAssistantText,
    currentToolCall,
    activeBgTasks: runningBgTasks,
    activeBgTask,
    pendingQuestion,
    lastActivityAt,
    stepCount: lineCount
  };

  transcriptCache.set(convId, { mtimeMs: stat.mtimeMs, size: append.size, identity: append.identity, rest: append.rest, state, evaluatedMinute: Math.floor(Date.now() / 60000), data });
  return data;
}

/**
 * Extrae el path limpio del workspace desde workspace_uris JSON array
 */
function parseWorkspaceUri(workspaceUrisStr, fallbackWorkspace) {
  if (workspaceUrisStr) {
    try {
      const arr = JSON.parse(workspaceUrisStr);
      if (Array.isArray(arr) && arr.length > 0) {
        let uri = arr[0];
        uri = uri.replace(/^file:\/\/\//i, '');
        uri = decodeURIComponent(uri).replace(/\//g, '\\');
        return uri;
      }
    } catch {}
  }
  return fallbackWorkspace || '';
}

/**
 * Construye el objeto de cuota y telemetría de AGY (ventanas móviles de 5h y 7d + historial + burn rate + estado real 429)
 */
function buildAgyQuota(slotAgg, settings, config = {}, providerStatus = null) {
  const now = Date.now();
  const currentSlot = Math.floor(now / SLOT_MS);
  const slots5h = 20; // 5 horas = 20 bloques de 15m
  const slots1h = 4; // 1 hora = 4 bloques de 15m
  const slots7d = 7 * 24 * 4; // 7 días = 672 bloques de 15m

  // Límites de referencia configurables (en tokens efectivos ponderados)
  const configuredLimit5hEff = (Number(config.agyFiveHourLimitM ?? config.fiveHourLimitM) || DEFAULT_FIVE_HOUR_LIMIT_M) * 1_000_000;
  const limit7dEff = (Number(config.agySevenDayLimitM ?? config.sevenDayLimitM) || DEFAULT_SEVEN_DAY_LIMIT_M) * 1_000_000;

  // Si hubo un agotamiento real de 5h confirmado en logs y ya se reseteó en las últimas 5h,
  // contabilizamos el porcentaje del ciclo nuevo desde lastResetAt contra el techo configurado (25M).
  const confirmedResetAt =
    providerStatus &&
    (providerStatus.lastResetAt || providerStatus.resetAt) &&
    providerStatus.window === '5h'
      ? providerStatus.lastResetAt || providerStatus.resetAt
      : null;

  let resetSlot5h = null;
  if (confirmedResetAt) {
    const endSlot = Math.floor(confirmedResetAt / SLOT_MS);
    if (!providerStatus.exhausted && now >= confirmedResetAt && now - confirmedResetAt < 5 * 3600 * 1000) {
      resetSlot5h = endSlot;
    }
  }

  const limit5hEff = configuredLimit5hEff;

  const fiveHour = { input: 0, cacheRead: 0, output: 0, total: 0, effective: 0, turns: 0 };
  const sinceReset5h = { input: 0, cacheRead: 0, output: 0, total: 0, effective: 0, turns: 0 };
  const oneHour = { input: 0, cacheRead: 0, output: 0, total: 0, effective: 0, turns: 0 };
  const sevenDay = { input: 0, cacheRead: 0, output: 0, total: 0, effective: 0, turns: 0 };

  let oldestSlot5h = null;
  let oldestSlotSinceReset5h = null;
  let oldestSlot7d = null;

  for (const [slotStr, b] of Object.entries(slotAgg)) {
    const s = Number(slotStr);
    const diff = currentSlot - s;
    if (diff < 0) continue;
    if (diff <= slots7d) {
      sevenDay.input += b.input;
      sevenDay.cacheRead += b.cacheRead;
      sevenDay.output += b.output;
      sevenDay.total += b.total;
      sevenDay.effective += b.effective;
      sevenDay.turns += b.turns;
      if (b.total > 0 && (oldestSlot7d === null || s < oldestSlot7d)) {
        oldestSlot7d = s;
      }
    }
    if (diff <= slots5h) {
      fiveHour.input += b.input;
      fiveHour.cacheRead += b.cacheRead;
      fiveHour.output += b.output;
      fiveHour.total += b.total;
      fiveHour.effective += b.effective;
      fiveHour.turns += b.turns;
      if (b.total > 0 && (oldestSlot5h === null || s < oldestSlot5h)) {
        oldestSlot5h = s;
      }
      if (resetSlot5h !== null && s >= resetSlot5h) {
        sinceReset5h.input += b.input;
        sinceReset5h.cacheRead += b.cacheRead;
        sinceReset5h.output += b.output;
        sinceReset5h.total += b.total;
        sinceReset5h.effective += b.effective;
        sinceReset5h.turns += b.turns;
        if (b.total > 0 && (oldestSlotSinceReset5h === null || s < oldestSlotSinceReset5h)) {
          oldestSlotSinceReset5h = s;
        }
      }
    }
    if (diff <= slots1h) {
      oneHour.input += b.input;
      oneHour.cacheRead += b.cacheRead;
      oneHour.output += b.output;
      oneHour.total += b.total;
      oneHour.effective += b.effective;
      oneHour.turns += b.turns;
    }
  }

  const activeFiveHour = resetSlot5h !== null ? sinceReset5h : fiveHour;

  // Datos 100% reales del backend de Google (businessaicode.googleapis.com:fetchQuotaStatus)
  const officialApi = (providerStatus && providerStatus.officialApi) || null;
  const officialWeekly = (officialApi && officialApi.weekly) || null;
  const officialFiveHour = (officialApi && officialApi.fiveHour) || null;

  let fiveHourPct = null;
  let sevenDayPct = null;
  let sevenDayPctExact = null;
  let nextFiveHourResetAt = null;
  let nextWeeklyResetAt = null;

  if (officialWeekly) {
    sevenDayPct = officialWeekly.usedPctRounded;
    sevenDayPctExact = officialWeekly.usedPctExact;
    nextWeeklyResetAt = officialWeekly.resetAt || null;
  }

  if (officialFiveHour) {
    fiveHourPct = officialFiveHour.usedPctRounded;
    nextFiveHourResetAt = officialFiveHour.resetAt || null;
  }

  // Si AGY reporta agotamiento activo (HTTP 429 RESOURCE_EXHAUSTED en cli.log), reflejar 100% y el horario oficial de reset
  if (providerStatus && providerStatus.exhausted) {
    if (providerStatus.window === '7d') {
      sevenDayPct = 100;
      if (providerStatus.resetAt) nextWeeklyResetAt = providerStatus.resetAt;
    } else if (providerStatus.window === '5h') {
      fiveHourPct = 100;
      if (providerStatus.resetAt) nextFiveHourResetAt = providerStatus.resetAt;
    }
  }

  const estimatedFiveHourPct = Math.min(
    100,
    Math.round((activeFiveHour.effective / Math.max(1, limit5hEff)) * 100)
  );
  const estimatedSevenDayPct = Math.min(
    100,
    Math.round((sevenDay.effective / Math.max(1, limit7dEff)) * 100)
  );

  // Construir curva histórica de las últimas 24 horas (24 puntos, cada 1 hora = 4 slots)
  const sampleTime = officialApi && officialApi.available ? officialApi.fetchedAt : now;
  if (fiveHourPct != null || sevenDayPct != null) {
    quotaSamples.set(sampleTime, { t: sampleTime, fh: fiveHourPct, sd: sevenDayPct });
  }
  for (const t of quotaSamples.keys()) if (now - t > 24 * 3600 * 1000) quotaSamples.delete(t);
  const history = [];
  for (let h = 23; h >= 0; h--) {
    const refSlot = currentSlot - h * 4;
    const refTs = refSlot * SLOT_MS;
    const sample = [...quotaSamples.values()].filter((point) => point.t <= refTs && refTs - point.t < 3600000)
      .sort((a, b) => b.t - a.t)[0];
    history.push({
      t: refTs,
      fh: sample ? sample.fh : null,
      sd: sample ? sample.sd : null
    });
  }

  if (history.length > 0) {
    history[history.length - 1] = { t: now, fh: fiveHourPct, sd: sevenDayPct };
  }

  const cacheHitPct =
    sevenDay.total > 0 ? Math.round((sevenDay.cacheRead / sevenDay.total) * 100) : 0;

  // Burn rate por hora basado en la última hora (o promedio de las últimas 5h si la última hora estuvo quieta)
  const burnRatePerHour =
    oneHour.total > 0 ? oneHour.total : Math.round(fiveHour.total / 5);

  const hasOfficialWeekly = Boolean(officialWeekly);

  return {
    available: true,
    source:
      providerStatus && providerStatus.exhausted
        ? 'provider-error'
        : hasOfficialWeekly
        ? 'google-api'
        : 'provider-logs',
    estimated: false,
    model: settings.model,
    gcpProject: (officialApi && officialApi.projectId) || settings.gcpProject,
    gcpLocation: (officialApi && officialApi.region) || settings.gcpLocation,
    userTier: (officialApi && officialApi.userTier) || '',
    fiveHourPct,
    sevenDayPct,
    sevenDayPctExact,
    officialWeekly,
    officialFiveHour,
    estimatedFiveHourPct,
    estimatedSevenDayPct,
    fiveHour: activeFiveHour,
    rollingFiveHour: fiveHour,
    sevenDay,
    oneHour,
    burnRatePerHour,
    cacheHitPct,
    limit5hM: Number((limit5hEff / 1_000_000).toFixed(1)),
    configuredLimit5hM: Math.round(configuredLimit5hEff / 1_000_000),
    limit7dM: Math.round(limit7dEff / 1_000_000),
    nextFiveHourResetAt,
    nextWeeklyResetAt,
    providerStatus,
    updatedAt: (officialApi && officialApi.fetchedAt) || now,
    officialStale: Boolean(officialApi && officialApi.stale),
    history
  };
}

/**
 * Recolecta todas las sesiones activas y recientes + métricas de tokens y cuota de AGY
 */
function collectAgyData(config = {}) {
  const baseDir = getAgyBaseDir();
  const providerStatus = readAgyQuotaStatus(baseDir);
  const settings = readAgySettings(baseDir);
  const activeLocks = getActiveLockedConversations(baseDir);
  const dbRows = readConversationSummaries(baseDir);
  const historyMap = readHistoryMap(baseDir);

  const dbMap = new Map();
  for (const row of dbRows) {
    dbMap.set(row.conversation_id, row);
  }

  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const candidateIds = new Set([...activeLocks.keys()]);

  for (const row of dbRows) {
    const modMs = Date.parse(row.last_modified_time) || 0;
    if (modMs >= sevenDaysAgo) {
      candidateIds.add(row.conversation_id);
    }
  }

  const brainDir = path.join(baseDir, 'brain');
  if (fs.existsSync(brainDir)) {
    try {
      const brainStat = fs.statSync(brainDir);
      if (
        brainStat.mtimeMs !== brainScanCache.mtimeMs ||
        now - brainScanCache.checkedAt >= 30000 ||
        brainScanCache.recentIds.length === 0
      ) {
        const recentIds = [];
        for (const entry of fs.readdirSync(brainDir)) {
          const trFile = path.join(brainDir, entry, '.system_generated', 'logs', 'transcript.jsonl');
          if (fs.existsSync(trFile)) {
            const st = fs.statSync(trFile);
            if (st.mtimeMs >= sevenDaysAgo) {
              recentIds.push(entry);
            }
          }
        }
        brainScanCache = { mtimeMs: brainStat.mtimeMs, checkedAt: now, recentIds };
      }
      for (const id of brainScanCache.recentIds) {
        candidateIds.add(id);
      }
    } catch {}
  }

  // Verificar si los transcripts activos, locks, DB y configuración no cambiaron desde el último ciclo
  const lockSigParts = [];
  let hasRecentLiveActivity = false;
  for (const [cid, linfo] of activeLocks.entries()) {
    const trFile = path.join(baseDir, 'brain', cid, '.system_generated', 'logs', 'transcript.jsonl');
    let trSig = '0:0';
    try {
      const st = fs.statSync(trFile);
      trSig = `${st.mtimeMs}:${st.size}`;
      if (now - st.mtimeMs < 90000) {
        hasRecentLiveActivity = true;
      }
    } catch {}
    lockSigParts.push(`${cid}:${linfo.lockMtimeMs}:${trSig}`);
  }
  const officialApiSig =
    providerStatus && providerStatus.officialApi && providerStatus.officialApi.weekly
      ? `${providerStatus.officialApi.weekly.remainingFraction}:${providerStatus.officialApi.weekly.resetTime || ''}`
      : '';
  const topCacheKey = [
    settingsCache.key,
    dbSummariesCache.key,
    summariesSourceError,
    historyMapCache.key,
    brainScanCache.mtimeMs,
    lockSigParts.join(','),
    config.agyFiveHourLimitM || config.fiveHourLimitM || DEFAULT_FIVE_HOUR_LIMIT_M,
    config.agySevenDayLimitM || config.sevenDayLimitM || DEFAULT_SEVEN_DAY_LIMIT_M,
    providerStatus ? `${providerStatus.state}:${providerStatus.exhausted ? 1 : 0}:${providerStatus.resetAt || 0}:${providerStatus.lastResetAt || 0}` : '',
    officialApiSig,
    JSON.stringify(providerStatus && providerStatus.officialApi),
    hasRecentLiveActivity ? Math.floor(now / 5000) : Math.floor(now / SLOT_MS)
  ].join('|');

  if (agyResultCache.data && agyResultCache.key === topCacheKey) {
    return { ...agyResultCache.data, agyQuota: { ...agyResultCache.data.agyQuota, providerStatus } };
  }

  const sessions = [];
  const dailyAgg = {}; // YYYY-MM-DD -> { input, cacheRead, output, total, effective, turns }
  const slotAgg = {}; // slotKey -> { input, cacheRead, output, total, effective, turns }

  for (const convId of candidateIds) {
    const isLocked = activeLocks.has(convId);
    const lockInfo = activeLocks.get(convId);
    const row = dbMap.get(convId);
    const hist = historyMap.get(convId);
    const tr = parseTranscript(baseDir, convId);

    if (tr && tr.dailyTokens) {
      for (const [day, d] of Object.entries(tr.dailyTokens)) {
        if (!dailyAgg[day]) {
          dailyAgg[day] = { input: 0, cacheRead: 0, output: 0, total: 0, effective: 0, turns: 0 };
        }
        dailyAgg[day].input += d.input;
        dailyAgg[day].cacheRead += d.cacheRead;
        dailyAgg[day].output += d.output;
        dailyAgg[day].total += d.total;
        dailyAgg[day].effective += d.effective;
        dailyAgg[day].turns += d.turns;
      }
    }

    if (tr && tr.slotTokens) {
      for (const [slot, s] of Object.entries(tr.slotTokens)) {
        if (!slotAgg[slot]) {
          slotAgg[slot] = { input: 0, cacheRead: 0, output: 0, total: 0, effective: 0, turns: 0 };
        }
        slotAgg[slot].input += s.input;
        slotAgg[slot].cacheRead += s.cacheRead;
        slotAgg[slot].output += s.output;
        slotAgg[slot].total += s.total;
        slotAgg[slot].effective += s.effective;
        slotAgg[slot].turns += s.turns;
      }
    }

    const workspace = parseWorkspaceUri(row && row.workspace_uris, hist && hist.workspace);
    const projectName = workspace ? path.basename(workspace) : 'Workspace General';
    const title =
      (row && row.title && row.title.trim()) ||
      (tr && tr.lastUserPrompt ? tr.lastUserPrompt.slice(0, 65) : '') ||
      (hist && hist.lastPrompt ? hist.lastPrompt.slice(0, 65) : '') ||
      `Sesión AGY ${convId.slice(0, 8)}`;

    const dbStatus = (row && row.status) || '';
    const notFullyIdle = Boolean(row && Number(row.not_fully_idle) === 1);
    const isSubagent = Boolean(row && row.parent_conversation_id);
    const childSubagents = dbRows.filter((r) => r.parent_conversation_id === convId);
    const runningSubagents = childSubagents.filter(
      (r) =>
        Number(r.killed) !== 1 &&
        (r.status === 'CASCADE_RUN_STATUS_RUNNING' || Number(r.not_fully_idle) === 1)
    );
    const hasActiveBgTaskFromTr = Boolean(
      tr &&
        tr.activeBgTask &&
        (!row || notFullyIdle || Date.now() - (tr.activeBgTask.startedAt || tr.lastActivityAt || 0) < 15000)
    );
    const hasActiveBgWork =
      notFullyIdle || runningSubagents.length > 0 || hasActiveBgTaskFromTr;

    let state = 'closed';
    if (isLocked) {
      if (tr && tr.transcriptState === 'waiting_approval') {
        state = 'waiting_approval';
      } else if (
        dbStatus === 'CASCADE_RUN_STATUS_RUNNING' ||
        hasActiveBgWork ||
        (tr && tr.isStreamingIncomplete) ||
        (tr && tr.transcriptState === 'running' && (!row || notFullyIdle || Date.now() - tr.lastActivityAt < 15000))
      ) {
        state = 'running';
      } else if (dbStatus === 'CASCADE_RUN_STATUS_IDLE') {
        state = 'waiting_input';
      } else {
        state = 'waiting_input';
      }
    } else if (
      (dbStatus === 'CASCADE_RUN_STATUS_RUNNING' || hasActiveBgWork || (tr && tr.isStreamingIncomplete)) &&
      tr &&
      Date.now() - tr.lastActivityAt < 45000
    ) {
      state = 'running';
    }

    const hasInterruptedError = Boolean(tr && tr.lastErrorText && state === 'waiting_input');
    const stateLabelMap = {
      waiting_approval: 'Permiso',
      waiting_input: hasInterruptedError ? 'Error' : 'Lista',
      running: 'Activa',
      closed: 'Cerrada'
    };

    const updatedAt = Math.max(
      row && row.last_modified_time ? Date.parse(row.last_modified_time) || 0 : 0,
      tr ? tr.lastActivityAt : 0,
      lockInfo ? lockInfo.lockMtimeMs : 0
    );

    const subagentsCount = childSubagents.length;
    const backgroundTasksCount =
      (tr ? tr.activeBgTasksCount || 0 : 0) ||
      runningSubagents.length ||
      (notFullyIdle ? 1 : 0);

    let currentAction = '';
    if (state === 'running') {
      if (tr && tr.currentToolCall) {
        currentAction = `${tr.currentToolCall.name}${tr.currentToolCall.detail ? ': ' + tr.currentToolCall.detail : ''}`;
      } else if (tr && tr.isStreamingIncomplete) {
        currentAction = `🧠 Generando${tr.lastThinkingTitle ? ': ' + tr.lastThinkingTitle : ' respuesta / código...'}`;
      } else if (tr && tr.activeBgTask) {
        currentAction = `⏳ Background: ${tr.activeBgTask.detail || 'comando en segundo plano'}`;
      } else if (runningSubagents.length > 0) {
        const subTitle = (runningSubagents[0].title || '').trim() || 'activo';
        currentAction = `🤖 Subagente (${runningSubagents.length}): ${subTitle.slice(0, 60)}`;
      } else if (notFullyIdle) {
        currentAction = '⏳ Ejecutando tarea o comando en segundo plano...';
      }
    } else if (state === 'waiting_approval' && tr && tr.pendingQuestion) {
      currentAction = `Pregunta: ${tr.pendingQuestion}`;
    } else if (hasInterruptedError) {
      currentAction = `⚠️ ${tr.lastErrorText}`;
    }

    if (isLocked || state !== 'closed' || Date.now() - updatedAt < 24 * 60 * 60 * 1000) {
      sessions.push({
        id: `agy:${convId}`,
        sessionId: convId,
        provider: 'agy',
        providerLabel: isSubagent ? 'AGY Sub' : 'AGY',
        model: settings.model,
        surface: (row && row.source) || 'cli',
        isOpen: isLocked || state === 'running',
        isSubagent,
        parentConversationId: (row && row.parent_conversation_id) || null,
        state,
        stateLabel: stateLabelMap[state] || state,
        subagentsCount,
        backgroundTasksCount,
        title,
        projectName,
        workspace,
        updatedAt,
        stepCount: (tr && tr.stepCount) || (row && row.step_count) || 0,
        turns: (tr && tr.turns) || 0,
        lastMessage:
          (tr && tr.pendingQuestion) ||
          (tr && tr.lastAssistantText) ||
          (row && row.preview) ||
          (tr && tr.lastUserPrompt) ||
          '',
        currentAction,
        tokens: {
          input: (tr && tr.inputTokens) || 0,
          cacheRead: (tr && tr.cacheReadTokens) || 0,
          cacheWrite: 0,
          output: (tr && tr.outputTokens) || 0,
          total: (tr && tr.totalTokens) || 0,
          effective: (tr && tr.effectiveTokens) || 0,
          turns: (tr && tr.turns) || 0
        }
      });
    }
  }

  const statePriority = { waiting_approval: 0, waiting_input: 1, running: 2, closed: 3 };
  sessions.sort((a, b) => {
    if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
    if (statePriority[a.state] !== statePriority[b.state]) {
      return statePriority[a.state] - statePriority[b.state];
    }
    return b.updatedAt - a.updatedAt;
  });

  const agyQuota = buildAgyQuota(slotAgg, settings, config, providerStatus);

  const result = {
    sessions,
    dailyTokens: dailyAgg,
    sourceError: summariesSourceError,
    agyQuota
  };
  agyResultCache = { key: topCacheKey, data: result };
  return result;
}

module.exports = {
  collectAgyData, buildAgyQuota, parseTranscript, getActiveLockedConversations, localDayKey
};
