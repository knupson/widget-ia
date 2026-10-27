const fs = require('fs');
const path = require('path');
const os = require('os');

// Cache incremental por conversación para no re-parsear archivos JSONL sin cambios
const transcriptCache = new Map();

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
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return {
      model: raw.model || defaults.model,
      gcpProject: (raw.gcp && raw.gcp.project) || defaults.gcpProject,
      gcpLocation: (raw.gcp && raw.gcp.location) || defaults.gcpLocation
    };
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

  const buf = Buffer.alloc(1);
  for (const file of files) {
    if (!file.endsWith('.lock')) continue;
    const convId = file.slice(0, -5);
    const fullPath = path.join(presenceDir, file);
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
      let lockMtimeMs = Date.now();
      try {
        lockMtimeMs = fs.statSync(fullPath).mtimeMs;
      } catch {}
      activeMap.set(convId, { lockMtimeMs });
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
    return stmt.all();
  } catch (err) {
    return [];
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
  const map = new Map();
  if (!fs.existsSync(histPath)) return map;

  try {
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
  } catch {}
  return map;
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
        currentToolCall = null;
        pendingQuestion = null;
      }
    }
  }

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
      transcriptState = 'waiting_input';
    } else if (
      lastStep.type === 'PLANNER_RESPONSE' &&
      Array.isArray(lastStep.tool_calls) &&
      lastStep.tool_calls.length > 0
    ) {
      transcriptState = pendingQuestion ? 'waiting_approval' : 'running';
    } else if (lastStep.type === 'GENERIC' && lastStep.status === 'DONE') {
      const ageMs = Date.now() - lastActivityAt;
      transcriptState = ageMs < 60000 ? 'running' : 'waiting_input';
    } else if (lastStep.type === 'USER_INPUT') {
      transcriptState = 'running';
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

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
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
      for (const entry of fs.readdirSync(brainDir)) {
        const trFile = path.join(brainDir, entry, '.system_generated', 'logs', 'transcript.jsonl');
        if (fs.existsSync(trFile)) {
          const st = fs.statSync(trFile);
          if (st.mtimeMs >= sevenDaysAgo) {
            candidateIds.add(entry);
          }
        }
      }
    } catch {}
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

    let state = 'closed';
    if (isLocked) {
      if (tr && tr.transcriptState === 'waiting_approval') {
        state = 'waiting_approval';
      } else if (dbStatus === 'CASCADE_RUN_STATUS_IDLE') {
        state = 'waiting_input';
      } else if (
        dbStatus === 'CASCADE_RUN_STATUS_RUNNING' ||
        (tr && tr.transcriptState === 'running')
      ) {
        state = 'running';
      } else {
        state = 'waiting_input';
      }
    } else if (dbStatus === 'CASCADE_RUN_STATUS_RUNNING' && tr && Date.now() - tr.lastActivityAt < 45000) {
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

    const subagentsCount = dbRows.filter((r) => r.parent_conversation_id === convId).length;
    const backgroundTasksCount = notFullyIdle && state === 'waiting_input' ? 1 : 0;

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
        currentAction:
          state === 'running' && tr && tr.currentToolCall
            ? `${tr.currentToolCall.name}${tr.currentToolCall.detail ? ': ' + tr.currentToolCall.detail : ''}`
            : state === 'waiting_approval' && tr && tr.pendingQuestion
              ? `Pregunta: ${tr.pendingQuestion}`
              : '',
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

  return {
    sessions,
    dailyTokens: dailyAgg,
    agyQuota
  };
}

module.exports = {
  collectAgyData
};
