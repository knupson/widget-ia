const fs = require('fs');
const path = require('path');
const os = require('os');

// Cache incremental por archivo JSONL
const jsonlCache = new Map();
let planUsageCache = { mtimeMs: 0, data: null };

function getClaudeDir() {
  return path.join(os.homedir(), '.claude');
}

function getClaudeAppDataDir() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude');
}

/**
 * Verifica si un PID de sistema operativo sigue vivo sin afectarlo
 */
function isPidAlive(pid) {
  const num = Number(pid);
  if (!num || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * Lee ~/.claude.json (cachedUsageUtilization) para obtener fechas exactas de próximo reseteo y promos
 */
function readClaudeUtilizationMeta() {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  const meta = {
    nextWeeklyResetAt: null,
    nextFiveHourResetAt: null,
    activePromo: null
  };
  if (!fs.existsSync(claudeJsonPath)) return meta;
  try {
    const raw = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    const util = raw?.cachedUsageUtilization?.utilization;
    if (!util) return meta;

    if (util.seven_day?.resets_at) {
      const ts = Date.parse(util.seven_day.resets_at);
      if (!Number.isNaN(ts)) meta.nextWeeklyResetAt = ts;
    }
    if (util.five_hour?.resets_at) {
      const ts = Date.parse(util.five_hour.resets_at);
      if (!Number.isNaN(ts)) meta.nextFiveHourResetAt = ts;
    }

    const promoKeys = [
      'omelette_promotional',
      'amber_cistern_offer',
      'amber_cistern',
      'wattle_ember',
      'cedar_ember'
    ];
    for (const k of promoKeys) {
      if (util[k]) {
        meta.activePromo = k;
        break;
      }
    }
  } catch {}
  return meta;
}

/**
 * Lee %APPDATA%\Claude\plan-usage-history.json para obtener el % oficial de cuota
 * y detectar reseteos semanales (programados y bonus gratis de Anthropic)
 * fh = Five-Hour window %, sd = Seven-Day (Weekly) window %
 */
function readPlanQuotaUsage() {
  const appData = getClaudeAppDataDir();
  const planPath = path.join(appData, 'plan-usage-history.json');
  const utilMeta = readClaudeUtilizationMeta();

  if (!fs.existsSync(planPath)) {
    return {
      available: false,
      fiveHourPct: null,
      sevenDayPct: null,
      updatedAt: null,
      nextWeeklyResetAt: utilMeta.nextWeeklyResetAt,
      lastReset: null,
      lastBonusReset: null,
      resets: [],
      history: []
    };
  }

  try {
    const stat = fs.statSync(planPath);
    if (planUsageCache.data && planUsageCache.mtimeMs === stat.mtimeMs) {
      return planUsageCache.data;
    }

    const raw = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    let entries = [];
    if (Array.isArray(raw)) {
      entries = raw;
    } else if (raw && typeof raw === 'object') {
      for (const val of Object.values(raw)) {
        if (Array.isArray(val) && val.length > 0 && val[val.length - 1].u) {
          entries = val;
          break;
        }
      }
    }

    if (entries.length === 0) {
      return {
        available: false,
        fiveHourPct: null,
        sevenDayPct: null,
        updatedAt: null,
        nextWeeklyResetAt: utilMeta.nextWeeklyResetAt,
        lastReset: null,
        lastBonusReset: null,
        resets: [],
        history: []
      };
    }

    // Detectar caídas de cuota semanal (sd) que indican un reseteo de cuota
    const resets = [];
    let prevResetTs = 0;
    for (let i = 1; i < entries.length; i++) {
      const prevSd = entries[i - 1]?.u?.sd;
      const currSd = entries[i]?.u?.sd;
      const currTs = entries[i]?.t || 0;
      if (typeof prevSd === 'number' && typeof currSd === 'number' && currSd < prevSd) {
        const drop = prevSd - currSd;
        if (drop >= 6 || (prevSd >= 10 && currSd <= 5)) {
          const daysSincePrevReset =
            prevResetTs > 0 ? (currTs - prevResetTs) / (1000 * 3600 * 24) : 7;
          const dayOfWeek = new Date(currTs).getDay(); // 5 = Viernes (día habitual de corte)
          // Es un Reseteo Gratis / Bonus si ocurre fuera del viernes (ej. martes) con uso alto
          // o si pasaron menos de 5.8 días desde el reseteo anterior
          const isBonus =
            (dayOfWeek !== 5 && prevSd >= 40) ||
            (prevResetTs > 0 && daysSincePrevReset < 5.8 && prevSd >= 40);

          resets.push({
            id: `reset:${currTs}`,
            timestamp: currTs,
            fromPct: prevSd,
            toPct: currSd,
            savedPct: drop,
            isBonus,
            label: isBonus ? '🎁 Reseteo Gratis (Bonus)' : '🔄 Reseteo Semanal'
          });
          prevResetTs = currTs;
        }
      }
    }

    resets.reverse(); // Más recientes primero
    const lastReset = resets[0] || null;
    const lastBonusReset = resets.find((r) => r.isBonus) || null;

    // Si nextWeeklyResetAt ya pasó o no está disponible, estimar 7 días desde el último reset de viernes
    let nextWeeklyResetAt = utilMeta.nextWeeklyResetAt;
    if ((!nextWeeklyResetAt || nextWeeklyResetAt < Date.now()) && lastReset) {
      nextWeeklyResetAt = lastReset.timestamp + 7 * 24 * 3600 * 1000;
    }

    const latest = entries[entries.length - 1];
    const recentHistory = entries.slice(-48).map((item) => ({
      t: item.t,
      fh: item.u && typeof item.u.fh === 'number' ? item.u.fh : 0,
      sd: item.u && typeof item.u.sd === 'number' ? item.u.sd : 0
    }));

    const result = {
      available: true,
      fiveHourPct: latest.u && typeof latest.u.fh === 'number' ? latest.u.fh : 0,
      sevenDayPct: latest.u && typeof latest.u.sd === 'number' ? latest.u.sd : 0,
      updatedAt: latest.t || stat.mtimeMs,
      nextWeeklyResetAt,
      nextFiveHourResetAt: utilMeta.nextFiveHourResetAt,
      activePromo: utilMeta.activePromo,
      lastReset,
      lastBonusReset,
      resets: resets.slice(0, 6),
      history: recentHistory
    };

    planUsageCache = { mtimeMs: stat.mtimeMs, data: result };
    return result;
  } catch {
    return {
      available: false,
      fiveHourPct: null,
      sevenDayPct: null,
      updatedAt: null,
      nextWeeklyResetAt: utilMeta.nextWeeklyResetAt,
      lastReset: null,
      lastBonusReset: null,
      resets: [],
      history: []
    };
  }
}

/**
 * Lee todas las sesiones registradas en ~/.claude/sessions/*.json
 */
function readActiveSessionFiles(claudeDir) {
  const sessDir = path.join(claudeDir, 'sessions');
  const map = new Map(); // sessionId -> sessionMeta
  if (!fs.existsSync(sessDir)) return map;

  let files = [];
  try {
    files = fs.readdirSync(sessDir);
  } catch {
    return map;
  }

  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(sessDir, f);
    try {
      const obj = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!obj || !obj.sessionId) continue;
      const alive = isPidAlive(obj.pid);
      const existing = map.get(obj.sessionId);
      if (!existing || alive || (obj.updatedAt || 0) > (existing.updatedAt || 0)) {
        map.set(obj.sessionId, {
          ...obj,
          isAlive: alive,
          fileMtimeMs: fs.statSync(full).mtimeMs
        });
      }
    } catch {}
  }

  return map;
}

/**
 * Extrae texto legible del campo content de un mensaje de Claude JSONL
 */
function extractMessageText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const texts = [];
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text.trim());
      }
    }
    return texts.join(' ').trim();
  }
  return '';
}

/**
 * Parsea un archivo .jsonl de proyecto de Claude Code con caché incremental
 */
function parseClaudeJsonl(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  const cached = jsonlCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.data;
  }

  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return cached ? cached.data : null;
  }

  const lines = raw.split(/\r?\n/);
  let inputTokens = 0;
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let turns = 0;
  let lastModel = '';
  let cwd = '';
  let gitBranch = '';
  let customTitle = '';
  let lastUserText = '';
  let lastAssistantText = '';
  let lastToolUse = null;
  let lastStopReason = '';
  let lastEventType = '';
  let lastTimestampMs = stat.mtimeMs;

  const dailyTokens = {}; // YYYY-MM-DD -> { input, cacheRead, cacheWrite, output, total, effective, turns }
  const modelTokens = {}; // model -> { input, cacheRead, cacheWrite, output, total, effective }
  const seenRequestIds = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.cwd && !cwd) cwd = entry.cwd;
    if (entry.gitBranch) gitBranch = entry.gitBranch;
    if (entry.customTitle) customTitle = entry.customTitle;

    if (entry.timestamp) {
      const ts = typeof entry.timestamp === 'number' ? entry.timestamp : Date.parse(entry.timestamp);
      if (!Number.isNaN(ts) && ts > 0) lastTimestampMs = ts;
    }

    lastEventType = entry.type || lastEventType;

    if (entry.type === 'user' && entry.message) {
      const txt = extractMessageText(entry.message.content);
      if (txt && !txt.startsWith('<command-name>') && !txt.startsWith('[Request interrupted')) {
        lastUserText = txt.replace(/\s+/g, ' ').slice(0, 220);
      }
      lastToolUse = null;
    }

    if (entry.type === 'assistant' && entry.message) {
      const msg = entry.message;
      if (msg.model) lastModel = msg.model;
      if (msg.stop_reason) lastStopReason = msg.stop_reason;

      const txt = extractMessageText(msg.content);
      if (txt) {
        lastAssistantText = txt.replace(/\s+/g, ' ').slice(0, 260);
      }

      if (Array.isArray(msg.content)) {
        const toolBlocks = msg.content.filter((b) => b && b.type === 'tool_use');
        if (toolBlocks.length > 0) {
          const lastTb = toolBlocks[toolBlocks.length - 1];
          let detail = '';
          if (lastTb.input) {
            detail =
              lastTb.input.description ||
              lastTb.input.command ||
              lastTb.input.file_path ||
              lastTb.input.pattern ||
              '';
          }
          lastToolUse = {
            name: lastTb.name || 'tool',
            detail: String(detail).slice(0, 120)
          };
        } else if (msg.stop_reason === 'end_turn') {
          lastToolUse = null;
        }
      }

      // Evitar duplicar conteo si Claude loguea múltiples fragmentos del mismo requestId/message.id
      const reqKey = entry.requestId || msg.id || `line-${i}`;
      if (msg.usage && !seenRequestIds.has(reqKey)) {
        seenRequestIds.add(reqKey);
        turns++;
        const u = msg.usage;
        const inTok = Number(u.input_tokens) || 0;
        const cwTok = Number(u.cache_creation_input_tokens) || 0;
        const crTok = Number(u.cache_read_input_tokens) || 0;
        const outTok = Number(u.output_tokens) || 0;

        inputTokens += inTok;
        cacheWriteTokens += cwTok;
        cacheReadTokens += crTok;
        outputTokens += outTok;

        const tot = inTok + cwTok + crTok + outTok;
        const eff = Math.round(inTok + crTok * 0.1 + cwTok * 2 + outTok * 5);

        const dayKey = new Date(lastTimestampMs).toISOString().slice(0, 10);
        if (!dailyTokens[dayKey]) {
          dailyTokens[dayKey] = {
            input: 0,
            cacheRead: 0,
            cacheWrite: 0,
            output: 0,
            total: 0,
            effective: 0,
            turns: 0
          };
        }
        dailyTokens[dayKey].input += inTok;
        dailyTokens[dayKey].cacheRead += crTok;
        dailyTokens[dayKey].cacheWrite += cwTok;
        dailyTokens[dayKey].output += outTok;
        dailyTokens[dayKey].total += tot;
        dailyTokens[dayKey].effective += eff;
        dailyTokens[dayKey].turns += 1;

        const mKey = msg.model || 'claude';
        if (!modelTokens[mKey]) {
          modelTokens[mKey] = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, effective: 0 };
        }
        modelTokens[mKey].input += inTok;
        modelTokens[mKey].cacheRead += crTok;
        modelTokens[mKey].cacheWrite += cwTok;
        modelTokens[mKey].output += outTok;
        modelTokens[mKey].total += tot;
        modelTokens[mKey].effective += eff;
      }
    }
  }

  const totalTokens = inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens;
  const effectiveTokens = Math.round(
    inputTokens + cacheReadTokens * 0.1 + cacheWriteTokens * 2 + outputTokens * 5
  );

  const data = {
    sessionId: path.basename(filePath, '.jsonl'),
    cwd,
    gitBranch,
    customTitle,
    lastModel,
    inputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens,
    effectiveTokens,
    turns,
    dailyTokens,
    modelTokens,
    lastUserText,
    lastAssistantText,
    lastToolUse,
    lastStopReason,
    lastEventType,
    lastTimestampMs
  };

  jsonlCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, data });
  return data;
}

/**
 * Recolecta sesiones activas, historial de tokens (7 días) y cuotas del plan de Claude
 */
function collectClaudeData(hookStateOverrides = new Map()) {
  const claudeDir = getClaudeDir();
  const activeSessionsMap = readActiveSessionFiles(claudeDir);
  const planQuota = readPlanQuotaUsage();

  const projectsDir = path.join(claudeDir, 'projects');
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const jsonlFilesBySessionId = new Map();

  if (fs.existsSync(projectsDir)) {
    let projFolders = [];
    try {
      projFolders = fs.readdirSync(projectsDir);
    } catch {}

    for (const folder of projFolders) {
      const folderPath = path.join(projectsDir, folder);
      let entries = [];
      try {
        entries = fs.readdirSync(folderPath);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;
        const fullJsonl = path.join(folderPath, entry);
        const sessId = entry.slice(0, -6);
        try {
          const st = fs.statSync(fullJsonl);
          if (st.mtimeMs >= sevenDaysAgo || activeSessionsMap.has(sessId)) {
            jsonlFilesBySessionId.set(sessId, fullJsonl);
          }
        } catch {}
      }
    }
  }

  const dailyAgg = {};
  const modelAgg = {};
  const sessions = [];

  const allSessionIds = new Set([...activeSessionsMap.keys(), ...jsonlFilesBySessionId.keys()]);

  for (const sessId of allSessionIds) {
    const activeMeta = activeSessionsMap.get(sessId);
    const jsonlPath = jsonlFilesBySessionId.get(sessId);
    const parsed = jsonlPath ? parseClaudeJsonl(jsonlPath) : null;

    if (parsed && parsed.dailyTokens) {
      for (const [day, d] of Object.entries(parsed.dailyTokens)) {
        if (!dailyAgg[day]) {
          dailyAgg[day] = {
            input: 0,
            cacheRead: 0,
            cacheWrite: 0,
            output: 0,
            total: 0,
            effective: 0,
            turns: 0
          };
        }
        dailyAgg[day].input += d.input;
        dailyAgg[day].cacheRead += d.cacheRead;
        dailyAgg[day].cacheWrite += d.cacheWrite;
        dailyAgg[day].output += d.output;
        dailyAgg[day].total += d.total;
        dailyAgg[day].effective += d.effective;
        dailyAgg[day].turns += d.turns;
      }
    }

    if (parsed && parsed.modelTokens) {
      for (const [m, mt] of Object.entries(parsed.modelTokens)) {
        if (!modelAgg[m]) {
          modelAgg[m] = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, effective: 0 };
        }
        modelAgg[m].input += mt.input;
        modelAgg[m].cacheRead += mt.cacheRead;
        modelAgg[m].cacheWrite += mt.cacheWrite;
        modelAgg[m].output += mt.output;
        modelAgg[m].total += mt.total;
        modelAgg[m].effective += mt.effective;
      }
    }

    const isOpen = Boolean(activeMeta && activeMeta.isAlive);
    const workspace = (activeMeta && activeMeta.cwd) || (parsed && parsed.cwd) || '';
    const projectName = workspace ? path.basename(workspace) : 'Proyecto Claude';
    const sessionName =
      (activeMeta && activeMeta.name) ||
      (parsed && parsed.customTitle) ||
      (parsed && parsed.lastUserText ? parsed.lastUserText.slice(0, 65) : '') ||
      `Claude ${sessId.slice(0, 8)}`;

    const updatedAt = Math.max(
      activeMeta ? activeMeta.updatedAt || activeMeta.fileMtimeMs || 0 : 0,
      parsed ? parsed.lastTimestampMs || 0 : 0
    );

    // Determinar el estado de la sesión ('running' | 'waiting_approval' | 'waiting_input' | 'closed')
    let state = 'closed';
    const hookOverride = hookStateOverrides.get(sessId);

    if (isOpen) {
      if (hookOverride && Date.now() - hookOverride.timestamp < 5 * 60 * 1000) {
        state = hookOverride.state;
      } else if (activeMeta.status && activeMeta.status !== 'idle') {
        state = 'running';
      } else if (
        parsed &&
        parsed.lastStopReason === 'tool_use' &&
        parsed.lastEventType === 'assistant' &&
        Date.now() - parsed.lastTimestampMs < 120000
      ) {
        // Si se detuvo en tool_use hace más de 4 segundos sin avanzar, puede estar esperando confirmación de permiso
        const elapsed = Date.now() - parsed.lastTimestampMs;
        state = elapsed > 4500 ? 'waiting_approval' : 'running';
      } else {
        state = 'waiting_input';
      }
    }

    const stateLabelMap = {
      waiting_approval: 'Permiso',
      waiting_input: 'Lista',
      running: 'Activa',
      closed: 'Cerrada'
    };

    if (isOpen || Date.now() - updatedAt < 24 * 60 * 60 * 1000) {
      sessions.push({
        id: `claude:${sessId}`,
        sessionId: sessId,
        pid: activeMeta ? activeMeta.pid : null,
        provider: 'claude',
        providerLabel:
          activeMeta && activeMeta.entrypoint === 'app' ? 'Claude App' : 'Claude',
        surface: (activeMeta && activeMeta.entrypoint) || 'cli',
        model: (parsed && parsed.lastModel) || 'claude',
        gitBranch: (parsed && parsed.gitBranch) || '',
        isOpen,
        isSubagent: false,
        state, // 'running' | 'waiting_approval' | 'waiting_input' | 'closed'
        stateLabel: stateLabelMap[state] || state,
        title: sessionName,
        projectName,
        workspace,
        updatedAt,
        turns: (parsed && parsed.turns) || 0,
        lastMessage:
          (hookOverride && hookOverride.message) ||
          (parsed && parsed.lastAssistantText) ||
          (parsed && parsed.lastUserText) ||
          '',
        currentAction:
          state === 'running' && parsed && parsed.lastToolUse
            ? `${parsed.lastToolUse.name}${parsed.lastToolUse.detail ? ': ' + parsed.lastToolUse.detail : ''}`
            : state === 'waiting_approval' && parsed && parsed.lastToolUse
              ? `Permiso requerido (${parsed.lastToolUse.name}): ${parsed.lastToolUse.detail}`
              : '',
        tokens: {
          input: (parsed && parsed.inputTokens) || 0,
          cacheRead: (parsed && parsed.cacheReadTokens) || 0,
          cacheWrite: (parsed && parsed.cacheWriteTokens) || 0,
          output: (parsed && parsed.outputTokens) || 0,
          total: (parsed && parsed.totalTokens) || 0,
          effective: (parsed && parsed.effectiveTokens) || 0,
          turns: (parsed && parsed.turns) || 0
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

  return {
    sessions,
    dailyTokens: dailyAgg,
    modelTokens: modelAgg,
    planQuota
  };
}

module.exports = {
  collectClaudeData
};
