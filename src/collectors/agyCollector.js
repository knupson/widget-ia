const fs = require('fs');
const path = require('path');
const os = require('os');

// Cache incremental por conversación para no re-parsear archivos JSONL ni SQLite sin cambios
const transcriptCache = new Map();
let settingsCache = { key: '', data: null };
let dbSummariesCache = { key: '', rows: [] };
let historyMapCache = { key: '', map: new Map() };
let brainScanCache = { mtimeMs: 0, checkedAt: 0, recentIds: [] };
let agyResultCache = { key: '', data: null };
const unlockedPresenceCache = new Map(); // file -> mtimeMs

function getAgyBaseDir() {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

/**
 * Lee settings.json de AGY para obtener modelo activo y proyecto GCP
 */
function readAgySettings(baseDir) {
  const settingsPath = path.join(baseDir, 'settings.json');
  const defaults = {
    model: 'Gemini 4 Argon (High)',
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

  if (!fs.existsSync(presenceDir)) return activeMap;

  let files = [];
  try {
    files = fs.readdirSync(presenceDir);
  } catch {
    return activeMap;
  }

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

    // Si en el ciclo anterior no estaba bloqueado y su mtime tiene más de 60s sin cambios, no abrir descriptor
    const prevUnlockedMtime = unlockedPresenceCache.get(file);
    if (prevUnlockedMtime === fileMtimeMs && now - fileMtimeMs > 60000) {
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
      activeMap.set(convId, { lockMtimeMs: fileMtimeMs || now });
    } else {
      unlockedPresenceCache.set(file, fileMtimeMs);
    }
  }

  return activeMap;
}

/**
 * Lee conversation_summaries.db usando el módulo nativo node:sqlite
 */
function readConversationSummaries(baseDir) {
  const dbPath = path.join(baseDir, 'conversation_summaries.db');
  if (!fs.existsSync(dbPath)) return [];

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
    if (cacheKey) {
      dbSummariesCache = { key: cacheKey, rows };
    }
    return rows;
  } catch (err) {
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

/**
 * Parsea transcript.jsonl de una conversación de AGY (con caché por mtime/size)
 */
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
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.data;
  }

  let raw = '';
  try {
    raw = fs.readFileSync(trPath, 'utf8');
  } catch {
    return cached ? cached.data : null;
  }

  const lines = raw.split(/\r?\n/);
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let turns = 0;
  const dailyTokens = {}; // YYYY-MM-DD -> { input, cacheRead, output, effective, total, turns }
  const slotTokens = {}; // slotIndex (15min) -> { input, cacheRead, output, effective, total, turns }

  let lastStep = null;
  let lastUserPrompt = '';
  let lastAssistantText = '';
  let currentToolCall = null;
  let pendingQuestion = null;
  let lastActivityAt = stat.mtimeMs;
  let lastPlannedCommandDaemon = false;
  const activeBgTasks = new Map(); // taskId -> { taskId, detail, isDaemon, startedAt }
  const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;

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
      const eff = Math.round(inTok + cacheTok * 0.1 + outTok * 5);

      const dayKey = step.created_at ? step.created_at.slice(0, 10) : new Date(stat.mtimeMs).toISOString().slice(0, 10);
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

  const runningBgTasks = [...activeBgTasks.values()].filter((t) => !t.isDaemon);
  const activeBgTask = runningBgTasks.length > 0 ? runningBgTasks[runningBgTasks.length - 1] : null;

  // Determinar estado detallado según los últimos pasos del transcript
  let transcriptState = 'idle'; // 'running' | 'waiting_approval' | 'waiting_input' | 'idle'
  if (lastStep) {
    if (pendingQuestion && lastStep.type === 'PLANNER_RESPONSE') {
      transcriptState = 'waiting_approval';
    } else if (lastStep.status === 'RUNNING' || lastStep.status === 'PENDING') {
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
    }
  }

  const totalTokens = inputTokens + cacheReadTokens + outputTokens;
  const effectiveTokens = Math.round(inputTokens + cacheReadTokens * 0.1 + outputTokens * 5);

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
    lastUserPrompt,
    lastAssistantText,
    currentToolCall,
    activeBgTasks: runningBgTasks,
    activeBgTask,
    pendingQuestion,
    lastActivityAt,
    stepCount: lines.filter(Boolean).length
  };

  transcriptCache.set(convId, { mtimeMs: stat.mtimeMs, size: stat.size, data });
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
 * Construye el objeto de cuota y telemetría de AGY (ventanas móviles de 5h y 7d + historial + burn rate)
 */
function buildAgyQuota(slotAgg, settings, config = {}) {
  const now = Date.now();
  const currentSlot = Math.floor(now / SLOT_MS);
  const slots5h = 20; // 5 horas = 20 bloques de 15m
  const slots1h = 4; // 1 hora = 4 bloques de 15m
  const slots7d = 7 * 24 * 4; // 7 días = 672 bloques de 15m

  // Límites de referencia configurables (en tokens efectivos ponderados)
  const limit5hEff = (Number(config.agyFiveHourLimitM) || 25) * 1_000_000;
  const limit7dEff = (Number(config.agySevenDayLimitM) || 100) * 1_000_000;

  const fiveHour = { input: 0, cacheRead: 0, output: 0, total: 0, effective: 0, turns: 0 };
  const oneHour = { input: 0, cacheRead: 0, output: 0, total: 0, effective: 0, turns: 0 };
  const sevenDay = { input: 0, cacheRead: 0, output: 0, total: 0, effective: 0, turns: 0 };

  let oldestSlot5h = null;
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

  const nextFiveHourResetAt =
    oldestSlot5h !== null ? (oldestSlot5h + slots5h + 1) * SLOT_MS : null;
  const nextWeeklyResetAt =
    oldestSlot7d !== null ? (oldestSlot7d + slots7d + 1) * SLOT_MS : null;

  const fiveHourPct = Math.min(100, Math.round((fiveHour.effective / Math.max(1, limit5hEff)) * 100));
  const sevenDayPct = Math.min(100, Math.round((sevenDay.effective / Math.max(1, limit7dEff)) * 100));

  // Construir curva histórica de las últimas 24 horas (24 puntos, cada 1 hora = 4 slots)
  const history = [];
  for (let h = 23; h >= 0; h--) {
    const refSlot = currentSlot - h * 4;
    let eff5 = 0;
    let eff7 = 0;
    for (const [slotStr, b] of Object.entries(slotAgg)) {
      const s = Number(slotStr);
      const d = refSlot - s;
      if (d >= 0 && d <= slots7d) {
        eff7 += b.effective;
        if (d <= slots5h) eff5 += b.effective;
      }
    }
    history.push({
      t: refSlot * SLOT_MS,
      fh: Math.min(100, Math.round((eff5 / Math.max(1, limit5hEff)) * 100)),
      sd: Math.min(100, Math.round((eff7 / Math.max(1, limit7dEff)) * 100))
    });
  }

  const cacheHitPct =
    sevenDay.total > 0 ? Math.round((sevenDay.cacheRead / sevenDay.total) * 100) : 0;

  // Burn rate por hora basado en la última hora (o promedio de las últimas 5h si la última hora estuvo quieta)
  const burnRatePerHour =
    oneHour.total > 0 ? oneHour.total : Math.round(fiveHour.total / 5);

  return {
    available: true,
    model: settings.model,
    gcpProject: settings.gcpProject,
    gcpLocation: settings.gcpLocation,
    fiveHourPct,
    sevenDayPct,
    fiveHour,
    sevenDay,
    oneHour,
    burnRatePerHour,
    cacheHitPct,
    limit5hM: Math.round(limit5hEff / 1_000_000),
    limit7dM: Math.round(limit7dEff / 1_000_000),
    nextFiveHourResetAt,
    nextWeeklyResetAt,
    updatedAt: now,
    history
  };
}

/**
 * Recolecta todas las sesiones activas y recientes + métricas de tokens y cuota de AGY
 */
function collectAgyData(config = {}) {
  const baseDir = getAgyBaseDir();
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
  const topCacheKey = [
    settingsCache.key,
    dbSummariesCache.key,
    historyMapCache.key,
    brainScanCache.mtimeMs,
    lockSigParts.join(','),
    config.agyFiveHourLimitM || 25,
    config.agySevenDayLimitM || 100,
    hasRecentLiveActivity ? Math.floor(now / 5000) : Math.floor(now / SLOT_MS)
  ].join('|');

  if (agyResultCache.data && agyResultCache.key === topCacheKey) {
    return agyResultCache.data;
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
        (tr && tr.transcriptState === 'running' && (!row || notFullyIdle || Date.now() - tr.lastActivityAt < 15000))
      ) {
        state = 'running';
      } else if (dbStatus === 'CASCADE_RUN_STATUS_IDLE') {
        state = 'waiting_input';
      } else {
        state = 'waiting_input';
      }
    } else if (
      (dbStatus === 'CASCADE_RUN_STATUS_RUNNING' || hasActiveBgWork) &&
      tr &&
      Date.now() - tr.lastActivityAt < 45000
    ) {
      state = 'running';
    }

    const stateLabelMap = {
      waiting_approval: 'Permiso',
      waiting_input: 'Lista',
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
    }

    if (isLocked || state !== 'closed' || Date.now() - updatedAt < 24 * 60 * 60 * 1000) {
      sessions.push({
        id: `agy:${convId}`,
        sessionId: convId,
        provider: 'agy',
        providerLabel: isSubagent ? 'AGY Sub' : 'AGY',
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

  const agyQuota = buildAgyQuota(slotAgg, settings, config);

  const result = {
    sessions,
    dailyTokens: dailyAgg,
    agyQuota
  };
  agyResultCache = { key: topCacheKey, data: result };
  return result;
}

module.exports = {
  collectAgyData
};
