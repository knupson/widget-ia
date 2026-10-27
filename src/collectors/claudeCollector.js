const fs = require('fs');
const path = require('path');
const os = require('os');
const v8 = require('v8');

// Cache incremental por archivo JSONL y bases de Claude Desktop App
const jsonlCache = new Map();
let planUsageCache = { mtimeMs: 0, data: null };
let desktopIdbCache = { key: '', data: null };

function getClaudeDir() {
  return path.join(os.homedir(), '.claude');
}

function getClaudeAppDataDir() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude');
}

/**
 * Verifica si la aplicación de escritorio de Claude está abierta comprobando el bloqueo SO sobre %APPDATA%\Claude\lockfile
 */
function isClaudeDesktopAppOpen(appDataDir) {
  const lockPath = path.join(appDataDir, 'lockfile');
  if (!fs.existsSync(lockPath)) return false;
  let fd = null;
  try {
    fd = fs.openSync(lockPath, 'r+');
    return false;
  } catch (err) {
    return Boolean(err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES'));
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Descompresor puro JS para flujos Snappy (usado por Chromium/Blink en IndexedDB blobs de Claude Desktop)
 */
function snappyUncompress(buf) {
  let pos = 0;
  let uncompressedLength = 0;
  let shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    uncompressedLength |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('Invalid Snappy header');
  }
  const out = Buffer.alloc(uncompressedLength);
  let outPos = 0;
  while (pos < buf.length && outPos < uncompressedLength) {
    const tag = buf[pos++];
    const type = tag & 0x03;
    if (type === 0) {
      let len = (tag >> 2) + 1;
      if (len > 60) {
        const extraBytes = len - 60;
        len = 0;
        for (let i = 0; i < extraBytes; i++) {
          len |= buf[pos++] << (8 * i);
        }
        len += 1;
      }
      buf.copy(out, outPos, pos, pos + len);
      pos += len;
      outPos += len;
    } else {
      let len = 0;
      let offset = 0;
      if (type === 1) {
        len = ((tag >> 2) & 0x07) + 4;
        offset = ((tag & 0xe0) << 3) | buf[pos++];
      } else if (type === 2) {
        len = (tag >> 2) + 1;
        offset = buf.readUInt16LE(pos);
        pos += 2;
      } else {
        len = (tag >> 2) + 1;
        offset = buf.readUInt32LE(pos);
        pos += 4;
      }
      if (offset <= 0 || outPos - offset < 0) throw new Error('Invalid Snappy offset');
      for (let i = 0; i < len; i++) {
        out[outPos] = out[outPos - offset];
        outPos++;
      }
    }
  }
  return out;
}

/**
 * Desempaqueta bloques físicos de 32KB del Write-Ahead Log (.log) de LevelDB
 */
function unpackLevelDbWal(buf) {
  const BLOCK_SIZE = 32768;
  const records = [];
  let current = [];
  let offset = 0;
  while (offset < buf.length) {
    const blockEnd = Math.min(offset + BLOCK_SIZE, buf.length);
    let pos = offset;
    while (pos + 7 <= blockEnd) {
      const len = buf.readUInt16LE(pos + 4);
      const type = buf[pos + 6];
      if (type === 0 || type > 4 || pos + 7 + len > blockEnd) break;
      const chunk = buf.subarray(pos + 7, pos + 7 + len);
      if (type === 1) {
        records.push(chunk);
        current = [];
      } else if (type === 2) {
        current = [chunk];
      } else if (type === 3 && current.length > 0) {
        current.push(chunk);
      } else if (type === 4 && current.length > 0) {
        current.push(chunk);
        records.push(Buffer.concat(current));
        current = [];
      }
      pos += 7 + len;
    }
    offset += BLOCK_SIZE;
  }
  return records;
}

/**
 * Extrae las conversaciones abiertas y recientes de la App de Escritorio de Claude (%APPDATA%\Claude)
 */
function collectClaudeDesktopSessions(appDataDir) {
  const isAppOpen = isClaudeDesktopAppOpen(appDataDir);
  const ssDir = path.join(appDataDir, 'Session Storage');
  const lsDir = path.join(appDataDir, 'Local Storage', 'leveldb');
  const idbDir = path.join(appDataDir, 'IndexedDB', 'https_claude.ai_0.indexeddb.leveldb');
  const blobRootDir = path.join(appDataDir, 'IndexedDB', 'https_claude.ai_0.indexeddb.blob');

  if (!fs.existsSync(idbDir) && !fs.existsSync(ssDir) && !fs.existsSync(lsDir)) {
    return [];
  }

  // Construir firma de mtimes para caché ultrarrápido
  let sigParts = [isAppOpen ? '1' : '0'];
  const ssFiles = [];
  for (const dir of [lsDir, ssDir]) {
    if (fs.existsSync(dir)) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.log') || f.endsWith('.ldb')) {
            const full = path.join(dir, f);
            const st = fs.statSync(full);
            ssFiles.push(full);
            sigParts.push(`ss:${f}:${st.mtimeMs}:${st.size}`);
          }
        }
      } catch {}
    }
  }

  const idbLogFiles = [];
  if (fs.existsSync(idbDir)) {
    try {
      for (const f of fs.readdirSync(idbDir)) {
        if (f.endsWith('.log')) {
          const full = path.join(idbDir, f);
          const st = fs.statSync(full);
          idbLogFiles.push(full);
          sigParts.push(`idb:${f}:${st.mtimeMs}:${st.size}`);
        }
      }
    } catch {}
  }

  const rqBlobFiles = [];
  if (fs.existsSync(blobRootDir)) {
    try {
      for (const storeFolder of fs.readdirSync(blobRootDir)) {
        const storePath = path.join(blobRootDir, storeFolder);
        if (!fs.statSync(storePath).isDirectory()) continue;
        for (const sub of fs.readdirSync(storePath)) {
          const subPath = path.join(storePath, sub);
          if (!fs.statSync(subPath).isDirectory()) continue;
          for (const bf of fs.readdirSync(subPath)) {
            const full = path.join(subPath, bf);
            const st = fs.statSync(full);
            if (st.size >= 400 && st.size <= 10 * 1024 * 1024) {
              rqBlobFiles.push({ full, mtimeMs: st.mtimeMs, size: st.size });
              sigParts.push(`blob:${storeFolder}/${sub}/${bf}:${st.mtimeMs}:${st.size}`);
            }
          }
        }
      }
    } catch {}
  }

  const cacheKey = sigParts.join('|');
  if (desktopIdbCache.data && desktopIdbCache.key === cacheKey) {
    return desktopIdbCache.data;
  }

  const nodeV8Ver = v8.serialize(0)[1];
  const convMap = new Map(); // uuid -> convMeta
  const projectsMap = new Map(); // projectUuid -> projectName
  const sessionActiveUuids = new Set(); // UUIDs activos en Session Storage actual

  // 1. Leer Local Storage y Session Storage (historial de navegación y snapshots del drawer)
  for (const full of ssFiles) {
    try {
      const buf = fs.readFileSync(full);
      for (const enc of ['utf8', 'utf16le']) {
        const patChat = Buffer.from('"key":"chat:', enc);
        let pos = 0;
        let rank = 0;
        while (pos < buf.length) {
          const idx = buf.indexOf(patChat, pos);
          if (idx === -1) break;
          pos = idx + patChat.length;
          const span = enc === 'utf16le' ? 700 : 350;
          const snippet = buf.subarray(idx, Math.min(buf.length, idx + span)).toString(enc);
          const m = snippet.match(
            /"key":"chat:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"[^}]*?"title":"([^"]+)"/i
          );
          if (m) {
            const uuid = m[1];
            const rawTitle = m[2];
            sessionActiveUuids.add(uuid);
            const prev = convMap.get(uuid) || { uuid };
            if (rawTitle) prev.title = rawTitle;
            prev.navRank = rank++;
            convMap.set(uuid, prev);
          }
        }

        const patSnap = Buffer.from('"snapshots":{', enc);
        let sPos = 0;
        while (sPos < buf.length) {
          const idx = buf.indexOf(patSnap, sPos);
          if (idx === -1) break;
          sPos = idx + patSnap.length;
          const span = enc === 'utf16le' ? 3000 : 1500;
          const snippet = buf.subarray(idx, Math.min(buf.length, idx + span)).toString(enc);
          const snapRegex =
            /"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})":\{"selectedItem":[^}]*,"at":(\d+)\}/gi;
          let sm;
          while ((sm = snapRegex.exec(snippet)) !== null) {
            const uuid = sm[1];
            const atTs = Number(sm[2]) || 0;
            sessionActiveUuids.add(uuid);
            const prev = convMap.get(uuid) || { uuid };
            prev.lastOpenedAt = Math.max(prev.lastOpenedAt || 0, atTs);
            convMap.set(uuid, prev);
          }
        }
      }
    } catch {}
  }

  // 2. Leer Blobs de React Query (chat_conversation_list y project_list)
  const patObjStart = Buffer.from('o"');
  rqBlobFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const bInfo of rqBlobFiles) {
    try {
      const raw = fs.readFileSync(bInfo.full);
      if (raw.length < 10) continue;
      const decomp = snappyUncompress(raw.subarray(3));
      const idxO = decomp.indexOf(patObjStart);
      if (idxO === -1) continue;
      const v8Buf = Buffer.concat([Buffer.from([0xff, nodeV8Ver]), decomp.subarray(idxO)]);
      const obj = v8.deserialize(v8Buf);
      const queries = obj?.clientState?.queries;
      if (!Array.isArray(queries)) continue;

      for (const q of queries) {
        const qKey0 = Array.isArray(q.queryKey) ? q.queryKey[0] : '';
        if (qKey0 === 'project_list') {
          const pList = Array.isArray(q.state?.data)
            ? q.state.data
            : q.state?.data?.pages?.flatMap((p) => p.data || []) || [];
          for (const p of pList) {
            if (p && p.uuid && p.name) {
              projectsMap.set(p.uuid, p.name);
            }
          }
        }
      }

      for (const q of queries) {
        const qKey0 = Array.isArray(q.queryKey) ? q.queryKey[0] : '';
        if (qKey0 === 'chat_conversation_list') {
          const cList = Array.isArray(q.state?.data)
            ? q.state.data
            : q.state?.data?.pages?.flatMap((p) => p.data || []) || [];
          for (const c of cList) {
            if (!c || !c.uuid) continue;
            const prev = convMap.get(c.uuid) || { uuid: c.uuid };
            const updMs = c.updated_at ? Date.parse(c.updated_at) || 0 : 0;
            const creMs = c.created_at ? Date.parse(c.created_at) || 0 : 0;
            prev.title = c.name || prev.title || `Chat ${c.uuid.slice(0, 8)}`;
            prev.model = c.model || prev.model || 'claude';
            prev.updatedAt = Math.max(prev.updatedAt || 0, updMs, creMs);
            prev.projectUuid = c.project_uuid || prev.projectUuid || null;
            prev.projectName =
              (c.project && c.project.name) ||
              (c.project_uuid && projectsMap.get(c.project_uuid)) ||
              prev.projectName ||
              '';
            convMap.set(c.uuid, prev);
          }
        }
      }
    } catch {}
  }

  // 3. Leer el Write-Ahead Log (.log) de IndexedDB (message-cache con mensajes en vivo)
  const pat = Buffer.from('o"\x10conversationUuid');
  for (const logPath of idbLogFiles) {
    try {
      const buf = fs.readFileSync(logPath);
      const records = unpackLevelDbWal(buf);
      for (const rec of records) {
        let searchFrom = 0;
        while (searchFrom < rec.length) {
          const idx = rec.indexOf(pat, searchFrom);
          if (idx === -1) break;
          searchFrom = idx + pat.length;
          try {
            const payload = Buffer.concat([Buffer.from([0xff, nodeV8Ver]), rec.subarray(idx)]);
            const val = v8.deserialize(payload);
            if (val && val.conversationUuid) {
              const uuid = val.conversationUuid;
              const tree = val.tree && typeof val.tree === 'object' ? val.tree : val;
              const prev = convMap.get(uuid) || { uuid };
              prev.inMemoryCache = true;
              if (tree.name || val.conversationTitle) {
                prev.title = tree.name || val.conversationTitle;
              }
              if (tree.model || val.model) {
                prev.model = tree.model || val.model;
              }
              if (tree.project && tree.project.name) {
                prev.projectName = tree.project.name;
              } else if (tree.project_uuid && projectsMap.get(tree.project_uuid)) {
                prev.projectName = projectsMap.get(tree.project_uuid);
              }
              const treeUpdMs = tree.updated_at ? Date.parse(tree.updated_at) || 0 : 0;
              prev.updatedAt = Math.max(
                prev.updatedAt || 0,
                treeUpdMs,
                Number(val.conversationUpdatedAt) || 0,
                Number(val.lastOpenedAt) || 0,
                Number(val.writtenAt) || 0,
                Number(val.fetchedAt) || 0
              );
              prev.lastOpenedAt = Math.max(
                prev.lastOpenedAt || 0,
                Number(val.lastOpenedAt) || 0,
                Number(val.writtenAt) || 0
              );
              prev.messageCount = Math.max(prev.messageCount || 0, Number(val.messageCount) || 0);
              prev.approxBytes = Math.max(prev.approxBytes || 0, Number(val.approxBytes) || 0);

              const msgs = Array.isArray(tree.chat_messages)
                ? tree.chat_messages
                : Array.isArray(val.messages)
                  ? val.messages
                  : [];
              if (msgs.length > 0) {
                let inChars = 0;
                let outChars = 0;
                let lastUserText = '';
                let lastAssistantText = '';
                for (const m of msgs) {
                  const txt =
                    typeof m.text === 'string' && m.text.trim()
                      ? m.text.trim()
                      : extractMessageText(m.content);
                  if (m.sender === 'human') {
                    inChars += txt.length;
                    if (txt) lastUserText = txt.slice(0, 220);
                  } else {
                    outChars += txt.length;
                    if (txt) lastAssistantText = txt.slice(0, 260);
                  }
                }
                const lastMsg = msgs[msgs.length - 1];
                prev.lastSender = lastMsg.sender || 'assistant';
                prev.lastStopReason = lastMsg.stop_reason || 'end_turn';
                prev.lastMsgUpdatedAt = lastMsg.updated_at ? Date.parse(lastMsg.updated_at) || 0 : 0;
                prev.lastUserText = lastUserText || prev.lastUserText || '';
                prev.lastAssistantText = lastAssistantText || prev.lastAssistantText || '';
                prev.inChars = inChars;
                prev.outChars = outChars;
                prev.messageCount = Math.max(prev.messageCount || 0, msgs.length);
              }
              convMap.set(uuid, prev);
            }
          } catch {}
        }
      }
    } catch {}
  }

  // Determinar cuáles conversaciones están "abiertas/activas" en la App de Escritorio
  const allConvs = [...convMap.values()].sort((a, b) => {
    const scoreA = Math.max(a.lastOpenedAt || 0, a.updatedAt || 0);
    const scoreB = Math.max(b.lastOpenedAt || 0, b.updatedAt || 0);
    return scoreB - scoreA;
  });

  const now = Date.now();
  const desktopSessions = [];
  let openAssignedCount = 0;

  for (const c of allConvs) {
    const projLabel =
      c.projectName || (c.projectUuid && projectsMap.get(c.projectUuid)) || 'Claude Desktop';
    const lastActiveMs = Math.max(c.updatedAt || 0, c.lastOpenedAt || 0, c.lastMsgUpdatedAt || 0);

    // Una conversación de la App de Escritorio se considera abierta si la App está ejecutándose y:
    // - Está en el cache en memoria de IndexedDB (.log) o en Session Storage actual, o
    // - Es una de las conversaciones tocadas en las últimas 24h mientras la app está abierta
    const isRecent = now - lastActiveMs < 36 * 60 * 60 * 1000;
    let isOpen = false;
    if (isAppOpen) {
      if ((c.inMemoryCache || sessionActiveUuids.has(c.uuid)) && openAssignedCount < 5) {
        isOpen = true;
        openAssignedCount++;
      } else if (openAssignedCount === 0 && desktopSessions.length === 0) {
        isOpen = true;
        openAssignedCount++;
      }
    }

    if (!isOpen && !isRecent) continue;

    // Determinar estado ('running' | 'waiting_input' | 'closed')
    let state = 'closed';
    if (isOpen) {
      const msgAgeMs = now - (c.lastMsgUpdatedAt || c.updatedAt || 0);
      if (
        (c.lastSender === 'human' && msgAgeMs < 180000) ||
        (c.lastSender === 'assistant' && !c.lastStopReason && msgAgeMs < 120000)
      ) {
        state = 'running';
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

    const turns = Math.max(1, Math.ceil((c.messageCount || 2) / 2));
    let inTok = 0;
    let outTok = 0;
    let crTok = 0;
    if ((c.inChars || 0) + (c.outChars || 0) > 0) {
      inTok = Math.round((c.inChars || 0) / 4);
      outTok = Math.round((c.outChars || 0) / 4);
      crTok = turns > 1 ? Math.round((inTok + outTok) * Math.min(3.5, (turns - 1) * 0.45)) : 0;
    } else if ((c.approxBytes || 0) > 0) {
      const baseTok = Math.round(c.approxBytes / 14);
      inTok = Math.round(baseTok * 0.25);
      outTok = Math.round(baseTok * 0.25);
      crTok = Math.round(baseTok * 0.5);
    }
    const totTok = inTok + outTok + crTok;
    const effTok = Math.round(inTok + crTok * 0.1 + outTok * 5);

    desktopSessions.push({
      id: `claude-app:${c.uuid}`,
      sessionId: c.uuid,
      pid: null,
      provider: 'claude',
      providerLabel: 'Claude App',
      surface: 'app',
      model: c.model || 'claude',
      gitBranch: '',
      isOpen,
      isSubagent: false,
      state,
      stateLabel: stateLabelMap[state] || state,
      title:
        c.title ||
        (c.lastUserText ? c.lastUserText.slice(0, 60) : '') ||
        `Chat ${c.uuid.slice(0, 8)}`,
      projectName: projLabel,
      workspace: `https://claude.ai/chat/${c.uuid}`,
      updatedAt: lastActiveMs || now,
      turns,
      lastMessage: c.lastAssistantText || c.lastUserText || '',
      currentAction: state === 'running' ? 'Generando respuesta en Claude App...' : '',
      tokens: {
        input: inTok,
        cacheRead: crTok,
        cacheWrite: 0,
        output: outTok,
        total: totTok,
        effective: effTok,
        turns
      }
    });
  }

  desktopIdbCache = { key: cacheKey, data: desktopSessions };
  return desktopSessions;
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

    const now = Date.now();
    // Si nextWeeklyResetAt ya pasó o no está disponible, proyectar en bloques de 7 días desde la referencia o último reset
    let nextWeeklyResetAt = utilMeta.nextWeeklyResetAt;
    if (nextWeeklyResetAt && nextWeeklyResetAt <= now) {
      while (nextWeeklyResetAt <= now) {
        nextWeeklyResetAt += 7 * 24 * 3600 * 1000;
      }
    } else if (!nextWeeklyResetAt && lastReset) {
      const schedReset = resets.find((r) => !r.isBonus) || lastReset;
      nextWeeklyResetAt = schedReset.timestamp + 7 * 24 * 3600 * 1000;
      while (nextWeeklyResetAt <= now) {
        nextWeeklyResetAt += 7 * 24 * 3600 * 1000;
      }
    }

    const latest = entries[entries.length - 1];
    const fiveHourPct = latest.u && typeof latest.u.fh === 'number' ? latest.u.fh : 0;
    const sevenDayPct = latest.u && typeof latest.u.sd === 'number' ? latest.u.sd : 0;

    // Calcular cuándo resetea la cuota de 5 horas si está activa (fh > 0)
    let nextFiveHourResetAt = utilMeta.nextFiveHourResetAt;
    if (!nextFiveHourResetAt || nextFiveHourResetAt <= now) {
      if (fiveHourPct > 0) {
        const fiveHoursAgo = now - 5 * 3600 * 1000;
        let windowStartTs = latest.t || now;
        for (let i = entries.length - 1; i >= 0; i--) {
          const item = entries[i];
          const ts = item.t || 0;
          const fhVal = item.u && typeof item.u.fh === 'number' ? item.u.fh : 0;
          if (ts < fiveHoursAgo) break;
          if (fhVal === 0) break;
          windowStartTs = ts;
          // Si houve caída de fh respecto a la muestra previa, ahí comenzó el ciclo actual de 5h
          if (i > 0) {
            const prevFh = entries[i - 1]?.u?.fh ?? 0;
            if (prevFh === 0 || fhVal < prevFh) break;
          }
        }
        nextFiveHourResetAt = windowStartTs + 5 * 3600 * 1000;
        if (nextFiveHourResetAt <= now) {
          nextFiveHourResetAt = (latest.t || now) + 5 * 3600 * 1000;
        }
      } else {
        nextFiveHourResetAt = null;
      }
    }

    const recentHistory = entries.slice(-48).map((item) => ({
      t: item.t,
      fh: item.u && typeof item.u.fh === 'number' ? item.u.fh : 0,
      sd: item.u && typeof item.u.sd === 'number' ? item.u.sd : 0
    }));

    const result = {
      available: true,
      fiveHourPct,
      sevenDayPct,
      updatedAt: latest.t || stat.mtimeMs,
      nextWeeklyResetAt,
      nextFiveHourResetAt,
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

  // Incorporar las conversaciones activas y recientes de la App de Escritorio de Claude (%APPDATA%\Claude)
  const desktopSessions = collectClaudeDesktopSessions(getClaudeAppDataDir());
  for (const ds of desktopSessions) {
    sessions.push(ds);
    if (ds.updatedAt >= sevenDaysAgo && ds.tokens && ds.tokens.total > 0) {
      const dayKey = new Date(ds.updatedAt).toISOString().slice(0, 10);
      if (!dailyAgg[dayKey]) {
        dailyAgg[dayKey] = {
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          total: 0,
          effective: 0,
          turns: 0
        };
      }
      dailyAgg[dayKey].input += ds.tokens.input || 0;
      dailyAgg[dayKey].cacheRead += ds.tokens.cacheRead || 0;
      dailyAgg[dayKey].output += ds.tokens.output || 0;
      dailyAgg[dayKey].total += ds.tokens.total || 0;
      dailyAgg[dayKey].effective += ds.tokens.effective || 0;
      dailyAgg[dayKey].turns += ds.tokens.turns || 0;
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
