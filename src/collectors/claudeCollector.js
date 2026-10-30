const fs = require('fs');
const { TOKEN_WEIGHTS } = require('./tokenWeights');
const path = require('path');
const os = require('os');
const v8 = require('v8');
const { unpackLevelDbWal } = require('../services/leveldbWal');

// Cache incremental por archivo JSONL y bases de Claude Desktop App
const jsonlCache = new Map();
const desktopBlobCache = new Map();
const desktopWalCache = new Map();
const sessionFileCache = new Map();
const projectFolderCache = new Map();
let projectsRootCache = { mtimeMs: 0, folders: [] };
let claudeJsonMetaCache = { key: '', data: null };
let planUsageCache = { mtimeMs: '', data: null };
const PLAN_USAGE_STALE_MS = 45 * 60 * 1000;
let desktopScanCache = { checkedAt: 0, isAppOpen: false, ssFiles: [], idbLogFiles: [], rqBlobFiles: [], fileCacheKey: '' };
let desktopIdbCache = { fileKey: '', allConvs: [], projectsMap: new Map(), resultKey: '', data: null };
let sessionsDirCache = { mtimeMs: 0, files: [] };
let claudeResultCache = { key: '', data: null };

function localDayKey(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

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
  const requireBytes = (count) => {
    if (pos + count > buf.length) throw new Error('Snappy truncado');
  };
  let uncompressedLength = 0;
  let shift = 0;
  while (true) {
    requireBytes(1);
    const byte = buf[pos++];
    uncompressedLength += (byte & 0x7f) * 2 ** shift;
    if (uncompressedLength > 64 * 1024 * 1024) throw new Error('Snappy excede 64 MB');
    if (!(byte & 0x80)) break;
    shift += 7;
    if (shift > 28) throw new Error('Cabecera Snappy invalida');
  }
  const out = Buffer.alloc(uncompressedLength);
  let outPos = 0;
  while (outPos < uncompressedLength) {
    requireBytes(1);
    const tag = buf[pos++];
    const type = tag & 3;
    let len;
    let offset;
    if (type === 0) {
      len = (tag >> 2) + 1;
      if (len > 60) {
        const extra = len - 60;
        requireBytes(extra);
        len = 1;
        for (let i = 0; i < extra; i++) len += buf[pos++] * 2 ** (8 * i);
      }
      requireBytes(len);
      if (outPos + len > out.length) throw new Error('Literal Snappy invalido');
      buf.copy(out, outPos, pos, pos + len);
      pos += len;
      outPos += len;
      continue;
    }
    const extra = type === 1 ? 1 : type === 2 ? 2 : 4;
    requireBytes(extra);
    if (type === 1) {
      len = ((tag >> 2) & 7) + 4;
      offset = ((tag & 0xe0) << 3) | buf[pos];
    } else {
      len = (tag >> 2) + 1;
      offset = type === 2 ? buf.readUInt16LE(pos) : buf.readUInt32LE(pos);
    }
    pos += extra;
    if (offset <= 0 || offset > outPos || outPos + len > out.length) throw new Error('Copia Snappy invalida');
    for (let i = 0; i < len; i++, outPos++) out[outPos] = out[outPos - offset];
  }
  return out;
}



/**
 * Extrae las conversaciones abiertas y recientes de la App de Escritorio de Claude (%APPDATA%\Claude)
 */
function collectClaudeDesktopSessions(appDataDir) {
  const now = Date.now();
  const scanTtlMs = desktopScanCache.isAppOpen ? 10000 : 30000;

  let isAppOpen = desktopScanCache.isAppOpen;
  let ssFiles = desktopScanCache.ssFiles;
  let idbLogFiles = desktopScanCache.idbLogFiles;
  let rqBlobFiles = desktopScanCache.rqBlobFiles;
  let fileCacheKey = desktopScanCache.fileCacheKey;

  if (!fileCacheKey || now - desktopScanCache.checkedAt >= scanTtlMs) {
    isAppOpen = isClaudeDesktopAppOpen(appDataDir);
    const ssDir = path.join(appDataDir, 'Session Storage');
    const lsDir = path.join(appDataDir, 'Local Storage', 'leveldb');
    const idbDir = path.join(appDataDir, 'IndexedDB', 'https_claude.ai_0.indexeddb.leveldb');
    const blobRootDir = path.join(appDataDir, 'IndexedDB', 'https_claude.ai_0.indexeddb.blob');

    if (!fs.existsSync(idbDir) && !fs.existsSync(ssDir) && !fs.existsSync(lsDir)) {
      desktopScanCache = { checkedAt: now, isAppOpen, ssFiles: [], idbLogFiles: [], rqBlobFiles: [], fileCacheKey: 'empty' };
      return [];
    }

    // Construir firma estrictamente por mtimeMs y size de archivos reales (sin invalidación por tiempo)
    const sigParts = [];
    ssFiles = [];
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

    idbLogFiles = [];
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

    rqBlobFiles = [];
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

    fileCacheKey = sigParts.join('|') || 'empty';
    desktopScanCache = {
      checkedAt: now,
      isAppOpen,
      ssFiles,
      idbLogFiles,
      rqBlobFiles,
      fileCacheKey
    };
  }

  if (fileCacheKey === 'empty') {
    return [];
  }

  // Si los archivos en disco no cambiaron, reusar estructuras descomprimidas sin tocar LevelDB ni Snappy
  let allConvs = desktopIdbCache.allConvs;
  let projectsMap = desktopIdbCache.projectsMap;

  if (desktopIdbCache.fileKey !== fileCacheKey) {
    const nodeV8Ver = v8.serialize(0)[1];
    const convMap = new Map(); // uuid -> convMeta
    projectsMap = new Map(); // projectUuid -> projectName
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

        // Detectar eventos en vivo de telemetría (antalytics_queue_v1) en Local Storage:
        // claudeai.message.(sent | perceived_ttft | first_text | perceived_ttlt)
        const patMsgEvt = Buffer.from('claudeai.message.', enc);
        let ePos = 0;
        while (ePos < buf.length) {
          const idx = buf.indexOf(patMsgEvt, ePos);
          if (idx === -1) break;
          ePos = idx + patMsgEvt.length;
          const start = Math.max(0, idx - (enc === 'utf16le' ? 800 : 400));
          const end = Math.min(buf.length, idx + (enc === 'utf16le' ? 1400 : 700));
          const win = buf.subarray(start, end).toString(enc);
          const mEvt = win.match(
            /claudeai\.message\.(sent|perceived_ttft|first_text|perceived_ttlt)/
          );
          const mUuid = win.match(
            /"conversation_uuid"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i
          );
          const mTs = win.match(/"eventTimestamp"\s*:\s*"([^"]+)"/);
          if (mEvt && mUuid) {
            const evtType = mEvt[1];
            const uuid = mUuid[1];
            const ts = mTs ? Date.parse(mTs[1]) || 0 : 0;
            if (ts > 0) {
              const prev = convMap.get(uuid) || { uuid };
              if (evtType === 'perceived_ttlt') {
                prev.lastEndTs = Math.max(prev.lastEndTs || 0, ts);
              } else {
                prev.lastStartTs = Math.max(prev.lastStartTs || 0, ts);
              }
              prev.updatedAt = Math.max(prev.updatedAt || 0, ts);
              convMap.set(uuid, prev);
            }
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
      const st = fs.statSync(bInfo.full);
      const key = `${st.mtimeMs}:${st.size}`;
      let decoded = desktopBlobCache.get(bInfo.full);
      if (!decoded || decoded.key !== key) {
        const raw = fs.readFileSync(bInfo.full);
        let obj = null;
        if (raw.length >= 10) {
          const decomp = snappyUncompress(raw.subarray(3));
          const idxO = decomp.indexOf(patObjStart);
          if (idxO !== -1) obj = v8.deserialize(Buffer.concat([Buffer.from([0xff, nodeV8Ver]), decomp.subarray(idxO)]));
        }
        decoded = { key, obj };
        desktopBlobCache.set(bInfo.full, decoded);
      }
      const obj = decoded.obj;
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
      const st = fs.statSync(logPath);
      const key = `${st.mtimeMs}:${st.size}`;
      let decoded = desktopWalCache.get(logPath);
      if (!decoded || decoded.key !== key) {
        const values = [];
        for (const rec of unpackLevelDbWal(fs.readFileSync(logPath))) {
          let searchFrom = 0;
          while (searchFrom < rec.length) {
            const idx = rec.indexOf(pat, searchFrom);
            if (idx === -1) break;
            searchFrom = idx + pat.length;
            try { values.push(v8.deserialize(Buffer.concat([Buffer.from([0xff, nodeV8Ver]), rec.subarray(idx)]))); } catch {}
          }
        }
        decoded = { key, values };
        desktopWalCache.set(logPath, decoded);
      }
      for (const val of decoded.values) {
        try {
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
                prev.lastStopReason = lastMsg.stop_reason || null;
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
    } catch {}
  }

    // Determinar cuáles conversaciones están "abiertas/activas" en la App de Escritorio
    allConvs = [...convMap.values()].sort((a, b) => {
      const scoreA = Math.max(a.lastOpenedAt || 0, a.updatedAt || 0);
      const scoreB = Math.max(b.lastOpenedAt || 0, b.updatedAt || 0);
      return scoreB - scoreA;
    });

    desktopIdbCache.fileKey = fileCacheKey;
    desktopIdbCache.allConvs = allConvs;
    desktopIdbCache.projectsMap = projectsMap;
  }

  // Verificar si alguna conversación tiene actividad en los últimos 6 minutos para evaluar expiración de estados en memoria
  const hasRecentLiveActivity = allConvs.some((c) => {
    const lastTs = Math.max(c.lastStartTs || 0, c.lastEndTs || 0, c.lastMsgUpdatedAt || 0);
    return lastTs > 0 && now - lastTs < 6 * 60 * 1000;
  });
  const resultKey = `${fileCacheKey}:${isAppOpen ? '1' : '0'}:${hasRecentLiveActivity ? Math.floor(now / 15000) : Math.floor(now / 60000)}`;
  if (desktopIdbCache.data && desktopIdbCache.resultKey === resultKey) {
    return desktopIdbCache.data;
  }

  const desktopSessions = [];

  for (const c of allConvs) {
    const projLabel =
      c.projectName || (c.projectUuid && projectsMap.get(c.projectUuid)) || 'Claude Desktop';
    const lastActiveMs = Math.max(
      c.updatedAt || 0,
      c.lastOpenedAt || 0,
      c.lastMsgUpdatedAt || 0,
      c.lastStartTs || 0,
      c.lastEndTs || 0
    );

    const isRecent = now - lastActiveMs < 36 * 60 * 60 * 1000;

    // Determinar si Claude está pensando/respondiendo en vivo AHORA MISMO en la App de Escritorio:
    // 1) Evento sent/perceived_ttft/first_text más reciente que perceived_ttlt y dentro de los últimos 3 min
    // 2) O último mensaje en cache de IndexedDB es del usuario (sin respuesta aún) o del asistente sin stop_reason
    const hasActiveStream =
      (c.lastStartTs || 0) > (c.lastEndTs || 0) && now - (c.lastStartTs || 0) < 180_000;
    const msgTs = c.lastMsgUpdatedAt || 0;
    const hasUnfinishedMsg =
      msgTs > (c.lastEndTs || 0) &&
      ((c.lastSender === 'human' && now - msgTs < 180_000) ||
        (c.lastSender === 'assistant' && !c.lastStopReason && now - msgTs < 120_000));

    const isThinking = isAppOpen && (hasActiveStream || hasUnfinishedMsg);

    // Si recién terminó de pensar (hace menos de 5 minutos), mantenerla visible como "Lista"
    // para que el widget avise y permita saltar con 🎯; pasado ese tiempo pasa a "Cerrada"
    // para no ensuciar la pestaña de Abiertas con chats viejos del historial web.
    const lastFinishMs = Math.max(c.lastEndTs || 0, c.lastMsgUpdatedAt || 0);
    const justFinished =
      !isThinking && isAppOpen && lastFinishMs > 0 && now - lastFinishMs < 5 * 60 * 1000;

    const isOpen = isThinking || justFinished;
    if (!isOpen && !isRecent) continue;

    const state = isThinking ? 'running' : isOpen ? 'waiting_input' : 'closed';

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
    const effTok = Math.round(inTok + crTok * TOKEN_WEIGHTS.cacheRead + outTok * TOKEN_WEIGHTS.output);

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
      estimated: true,
      lastMessage: c.lastAssistantText || c.lastUserText || '',
      currentAction: state === 'running' ? 'Generando respuesta en Claude App...' : '',
      tokens: {
        estimated: true,
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

  desktopIdbCache.resultKey = resultKey;
  desktopIdbCache.data = desktopSessions;
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
  const emptyMeta = {
    nextWeeklyResetAt: null,
    nextFiveHourResetAt: null,
    activePromo: null
  };
  if (!fs.existsSync(claudeJsonPath)) return emptyMeta;
  try {
    const st = fs.statSync(claudeJsonPath);
    const cacheKey = `${st.mtimeMs}:${st.size}`;
    if (claudeJsonMetaCache.data && claudeJsonMetaCache.key === cacheKey) {
      return claudeJsonMetaCache.data;
    }

    const meta = { ...emptyMeta };
    const raw = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    const util = raw?.cachedUsageUtilization?.utilization;
    if (!util) {
      claudeJsonMetaCache = { key: cacheKey, data: meta };
      return meta;
    }

    const parseResetAt = (value) => typeof value === 'number'
      ? (value < 1e12 ? value * 1000 : value)
      : Date.parse(value);
    if (util.seven_day?.resets_at) {
      const ts = parseResetAt(util.seven_day.resets_at);
      if (Number.isFinite(ts)) meta.nextWeeklyResetAt = ts;
    }
    if (util.five_hour?.resets_at) {
      const ts = parseResetAt(util.five_hour.resets_at);
      if (Number.isFinite(ts)) meta.nextFiveHourResetAt = ts;
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
    claudeJsonMetaCache = { key: cacheKey, data: meta };
    return meta;
  } catch {
    return emptyMeta;
  }
}

/**
 * Lee %APPDATA%\Claude\plan-usage-history.json para obtener el % oficial de cuota
 * y detectar reseteos semanales (programados y bonus gratis de Anthropic)
 * fh = Five-Hour window %, sd = Seven-Day (Weekly) window %
 */
function readDesktopPlanQuotaUsage() {
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
    const cacheBucket = `${stat.mtimeMs}:${stat.size}:${utilMeta.nextWeeklyResetAt || 0}:${utilMeta.nextFiveHourResetAt || 0}:${utilMeta.activePromo || ''}:${Math.floor(Date.now() / 60000)}`;
    if (planUsageCache.data && planUsageCache.mtimeMs === cacheBucket) {
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
    const allResets = [];
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

          allResets.push({
            id: `reset:${currTs}`,
            timestamp: currTs,
            fromPct: prevSd,
            toPct: currSd,
            savedPct: drop,
            estimated: true,
            isBonus,
            label: isBonus ? '🎁 Reseteo Gratis (Bonus)' : '🔄 Reseteo Semanal'
          });
          prevResetTs = currTs;
        }
      }
    }

    allResets.reverse(); // Más recientes primero
    const latestHistoricalReset = allResets[0] || null;

    const now = Date.now();
    // Si nextWeeklyResetAt ya pasó o no está disponible, proyectar en bloques de 7 días desde la referencia o último reset
    let nextWeeklyResetAt = utilMeta.nextWeeklyResetAt;
    let nextWeeklyResetEstimated = false;
    if (nextWeeklyResetAt && nextWeeklyResetAt <= now) {
      nextWeeklyResetEstimated = true;
      while (nextWeeklyResetAt <= now) {
        nextWeeklyResetAt += 7 * 24 * 3600 * 1000;
      }
    } else if (!nextWeeklyResetAt && latestHistoricalReset) {
      nextWeeklyResetEstimated = true;
      const schedReset = allResets.find((r) => !r.isBonus) || latestHistoricalReset;
      nextWeeklyResetAt = schedReset.timestamp + 7 * 24 * 3600 * 1000;
      while (nextWeeklyResetAt <= now) {
        nextWeeklyResetAt += 7 * 24 * 3600 * 1000;
      }
    }

    const latest = entries[entries.length - 1];
    const fiveHourPct = latest.u && typeof latest.u.fh === 'number' ? latest.u.fh : null;
    const sevenDayPct = latest.u && typeof latest.u.sd === 'number' ? latest.u.sd : null;

    // Filtrar solo reseteos recientes (últimas 24h y cuyo ahorro no haya sido ya superado)
    // para no mostrar regalos ni cortes semanales del pasado como actuales
    const recentResets = allResets.filter(
      (r) => now - r.timestamp < 24 * 3600 * 1000 && sevenDayPct != null && sevenDayPct < r.fromPct
    );
    const lastReset = recentResets[0] || null;
    const lastBonusReset =
      recentResets.find(
        (r) => r.isBonus && now - r.timestamp < 12 * 3600 * 1000 && sevenDayPct != null && sevenDayPct < 50
      ) || null;

    // Calcular cuándo resetea la cuota de 5 horas si está activa (fh > 0)
    let nextFiveHourResetAt = utilMeta.nextFiveHourResetAt;
    let nextFiveHourResetEstimated = false;
    if (!nextFiveHourResetAt || nextFiveHourResetAt <= now) {
      if (fiveHourPct > 0) {
        nextFiveHourResetEstimated = true;
        const fiveHoursAgo = now - 5 * 3600 * 1000;
        let windowStartTs = latest.t || now;
        for (let i = entries.length - 1; i >= 0; i--) {
          const item = entries[i];
          const ts = item.t || 0;
          const fhVal = item.u && typeof item.u.fh === 'number' ? item.u.fh : null;
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
      fh: item.u && typeof item.u.fh === 'number' ? item.u.fh : null,
      sd: item.u && typeof item.u.sd === 'number' ? item.u.sd : null
    }));

    // Claude Desktop escribe una muestra cada ~15 min. Si dejó de hacerlo, el último valor
    // puede ser de una semana anterior (ej. 100% ya reseteado): se informa como desconocido.
    const updatedAt = latest.t || stat.mtimeMs;
    const stale = now - updatedAt > PLAN_USAGE_STALE_MS;

    const result = {
      available: true,
      stale,
      fiveHourPct: stale ? null : fiveHourPct,
      sevenDayPct: stale ? null : sevenDayPct,
      lastKnownFiveHourPct: fiveHourPct,
      lastKnownSevenDayPct: sevenDayPct,
      updatedAt,
      nextWeeklyResetAt,
      nextFiveHourResetAt: stale ? null : nextFiveHourResetAt,
      estimated: nextWeeklyResetEstimated || (!stale && nextFiveHourResetEstimated),
      nextWeeklyResetEstimated,
      nextFiveHourResetEstimated: !stale && nextFiveHourResetEstimated,
      activePromo: utilMeta.activePromo,
      lastReset: stale ? null : lastReset,
      lastBonusReset: stale ? null : lastBonusReset,
      resets: stale ? [] : recentResets.slice(0, 6),
      history: recentHistory
    };

    planUsageCache = { mtimeMs: cacheBucket, data: result };
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
 * Lee ~/.claude/ai-pulse/claude-rate-limits.json, que escribe src/scripts/claude-statusline.mjs
 * con el rate_limits real que Claude Code pasa a su statusLine (cuota del CLI, sin tocar OAuth).
 */
let statuslineQuotaCache = { key: '', data: null };
function readStatuslineQuota(now = Date.now()) {
  const file = path.join(os.homedir(), '.claude', 'ai-pulse', 'claude-rate-limits.json');
  try {
    const st = fs.statSync(file);
    const key = `${st.mtimeMs}:${st.size}`;
    let raw;
    if (statuslineQuotaCache.key === key) {
      raw = statuslineQuotaCache.data;
    } else {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      statuslineQuotaCache = { key, data: raw };
    }
    const lastSeenAt = Number(raw.lastSeenAt) || st.mtimeMs;
    // Una ventana ya vencida (resetsAt pasó) significa uso reiniciado: 0%, no el valor viejo
    const pctOf = (w) => {
      if (!w || !Number.isFinite(w.pct)) return null;
      return w.resetsAt && w.resetsAt <= now ? 0 : w.pct;
    };
    return {
      fiveHourPct: pctOf(raw.fiveHour),
      sevenDayPct: pctOf(raw.sevenDay),
      nextFiveHourResetAt: raw.fiveHour && raw.fiveHour.resetsAt > now ? raw.fiveHour.resetsAt : null,
      nextWeeklyResetAt: raw.sevenDay && raw.sevenDay.resetsAt > now ? raw.sevenDay.resetsAt : null,
      updatedAt: Number(raw.updatedAt) || lastSeenAt,
      lastSeenAt,
      stale: now - lastSeenAt > PLAN_USAGE_STALE_MS
    };
  } catch {
    return null;
  }
}

/**
 * Cuota del plan de Claude: combina Claude Desktop (plan-usage-history.json) y el statusline de
 * Claude Code. Gana la fuente con lectura vigente más reciente; si ambas están vencidas, queda stale.
 */
function readPlanQuotaUsage() {
  const desktop = readDesktopPlanQuotaUsage();
  const cli = readStatuslineQuota();
  if (!cli || cli.stale) return desktop;
  const desktopFresh = desktop && desktop.available && !desktop.stale;
  if (desktopFresh && (desktop.updatedAt || 0) >= cli.lastSeenAt) return desktop;
  return {
    ...(desktop || {}),
    available: true,
    source: 'claude-code-statusline',
    estimated: false,
    nextFiveHourResetEstimated: false,
    nextWeeklyResetEstimated: false,
    stale: false,
    fiveHourPct: cli.fiveHourPct,
    sevenDayPct: cli.sevenDayPct,
    lastKnownFiveHourPct: cli.fiveHourPct,
    lastKnownSevenDayPct: cli.sevenDayPct,
    updatedAt: cli.lastSeenAt,
    nextFiveHourResetAt: cli.nextFiveHourResetAt,
    nextWeeklyResetAt: cli.nextWeeklyResetAt
  };
}

/**
 * Lee todas las sesiones registradas en ~/.claude/sessions/*.json
 */
function readActiveSessionFiles(claudeDir) {
  const sessDir = path.join(claudeDir, 'sessions');
  const map = new Map(); // sessionId -> sessionMeta
  if (!fs.existsSync(sessDir)) return map;

  let files = sessionsDirCache.files;
  let dirMtimeMs = 0;
  try {
    const dirStat = fs.statSync(sessDir);
    dirMtimeMs = dirStat.mtimeMs;
    if (dirMtimeMs !== sessionsDirCache.mtimeMs || files.length === 0) {
      files = fs.readdirSync(sessDir).filter((f) => f.endsWith('.json'));
      sessionsDirCache = { mtimeMs: dirMtimeMs, files };
    }
  } catch {
    return map;
  }

  const now = Date.now();
  for (const f of files) {
    const full = path.join(sessDir, f);
    try {
      let cached = sessionFileCache.get(full);
      const st = fs.statSync(full);
      let obj = null;
      let alive = false;
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        obj = cached.obj;
        // Un PID muerto en un archivo sin cambios nunca revive; solo re-verificar PIDs que seguían vivos
        alive = cached.isAlive ? isPidAlive(obj && obj.pid) : false;
        cached.isAlive = alive;
        cached.dirMtimeMs = dirMtimeMs;
      } else {
        obj = JSON.parse(fs.readFileSync(full, 'utf8'));
        alive = isPidAlive(obj && obj.pid);
        sessionFileCache.set(full, {
          mtimeMs: st.mtimeMs,
          size: st.size,
          dirMtimeMs,
          isAlive: alive,
          obj
        });
      }
      if (!obj || !obj.sessionId) continue;
      const existing = map.get(obj.sessionId);
      if (!existing || alive || (obj.updatedAt || 0) > (existing.updatedAt || 0)) {
        map.set(obj.sessionId, {
          ...obj,
          isAlive: alive,
          fileMtimeMs: st.mtimeMs
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
const JSONL_PROBE_BYTES = 64;

function readJsonlAppend(file, stat, cached) {
  const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  let resume = Boolean(cached && cached.identity === identity && stat.size >= cached.size &&
    !(stat.size === cached.size && stat.mtimeMs !== cached.mtimeMs));
  let offset = 0;
  let buffer;
  let bytes;
  const fd = fs.openSync(file, 'r');
  try {
    // Truncado y vuelto a crecer: los últimos bytes ya no coinciden con el probe guardado
    if (resume && cached.probe && cached.probe.length > 0) {
      const probe = Buffer.alloc(cached.probe.length);
      const got = fs.readSync(fd, probe, 0, probe.length, cached.size - probe.length);
      if (got !== probe.length || !probe.equals(cached.probe)) resume = false;
    }
    offset = resume ? cached.size : 0;
    buffer = Buffer.alloc(stat.size - offset);
    bytes = fs.readSync(fd, buffer, 0, buffer.length, offset);
  } finally { fs.closeSync(fd); }
  const content = Buffer.concat([resume ? cached.rest : Buffer.alloc(0), buffer.subarray(0, bytes)]);
  const end = content.lastIndexOf(10);
  const lines = end < 0 ? [] : content.subarray(0, end).toString('utf8').split('\n');
  // Copias propias: sin esto la caché retiene el buffer completo de la última lectura
  const rest = Buffer.from(content.subarray(end + 1));
  const probe = Buffer.from(content.subarray(Math.max(0, content.length - JSONL_PROBE_BYTES)));
  return { identity, resume, size: offset + bytes, rest, probe, lines };
}

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

  let append;
  try { append = readJsonlAppend(filePath, stat, cached); } catch { return cached ? cached.data : null; }
  const lines = append.lines;
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
  let lastStopReason = null;
  let lastEventType = '';
  let lastUserIsToolResult = false;
  let activeBgCommand = null;
  let lastTimestampMs = stat.mtimeMs;

  let dailyTokens = {}; // YYYY-MM-DD -> { input, cacheRead, cacheWrite, output, total, effective, turns }
  let modelTokens = {}; // model -> { input, cacheRead, cacheWrite, output, total, effective }
  let seenRequestIds = new Set();

  let lineCount = 0;
  if (append.resume) ({ inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens, turns, lastModel, cwd, gitBranch, customTitle, lastUserText, lastAssistantText, lastToolUse, lastStopReason, lastEventType, lastUserIsToolResult, activeBgCommand, lastTimestampMs, dailyTokens, modelTokens, seenRequestIds, lineCount } = cached.state);

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
      const contentArr = Array.isArray(entry.message.content) ? entry.message.content : [];
      const hasToolResult = contentArr.some((b) => b && b.type === 'tool_result');
      lastUserIsToolResult = hasToolResult;

      if (hasToolResult) {
        const result = entry.toolUseResult || {};
        const backgroundResult = result.backgroundTaskId || result.background_task_id ||
          result.isAsync === true || result.isBackground === true ||
          contentArr.some((b) => b && b.type === 'tool_result' &&
            (b.backgroundTaskId || b.background_task_id || b.isBackground === true));
        if (backgroundResult) {
          activeBgCommand =
            (lastToolUse && lastToolUse.detail) || 'Comando o subagente en segundo plano';
        }
      } else {
        const txt = extractMessageText(entry.message.content);
        if (txt && !txt.startsWith('<command-name>') && !txt.startsWith('[Request interrupted')) {
          lastUserText = txt.replace(/\s+/g, ' ').slice(0, 220);
        }
        activeBgCommand = null;
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
          let isBackground = false;
          if (lastTb.input) {
            detail =
              lastTb.input.description ||
              lastTb.input.command ||
              lastTb.input.file_path ||
              lastTb.input.pattern ||
              lastTb.input.prompt ||
              '';
            isBackground = Boolean(
              lastTb.input.run_in_background ||
                /^(Task|Agent|dispatch_agent|subagent)$/i.test(lastTb.name || '')
            );
          }
          if (lastTb.name === 'KillShell' || lastTb.name === 'TaskStop') {
            activeBgCommand = null;
          } else if (lastTb.input && lastTb.input.run_in_background) {
            activeBgCommand = String(detail || lastTb.name || 'Background').slice(0, 120);
          }
          lastToolUse = {
            name: lastTb.name || 'tool',
            detail: String(detail).slice(0, 120),
            isBackground
          };
        } else if (msg.stop_reason === 'end_turn') {
          lastToolUse = null;
        }
      }

      // Evitar duplicar conteo si Claude loguea múltiples fragmentos del mismo requestId/message.id
      const reqKey = entry.requestId || msg.id || `line-${lineCount + i}`;
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
        const eff = Math.round(inTok + crTok * TOKEN_WEIGHTS.cacheRead + cwTok * TOKEN_WEIGHTS.cacheWrite + outTok * TOKEN_WEIGHTS.output);

        const dayKey = localDayKey(lastTimestampMs);
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

  lineCount += lines.length;
  const state = { inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens, turns, lastModel, cwd, gitBranch, customTitle, lastUserText, lastAssistantText, lastToolUse, lastStopReason, lastEventType, lastUserIsToolResult, activeBgCommand, lastTimestampMs, dailyTokens, modelTokens, seenRequestIds, lineCount };

  const totalTokens = inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens;
  const effectiveTokens = Math.round(
    inputTokens + cacheReadTokens * TOKEN_WEIGHTS.cacheRead + cacheWriteTokens * TOKEN_WEIGHTS.cacheWrite + outputTokens * TOKEN_WEIGHTS.output
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
    lastUserIsToolResult,
    activeBgCommand,
    lastTimestampMs
  };

  jsonlCache.set(filePath, { mtimeMs: stat.mtimeMs, size: append.size, identity: append.identity, rest: append.rest, probe: append.probe, state, data });
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
    let projFolders = projectsRootCache.folders;
    try {
      const rootStat = fs.statSync(projectsDir);
      if (rootStat.mtimeMs !== projectsRootCache.mtimeMs || projFolders.length === 0) {
        projFolders = fs.readdirSync(projectsDir);
        projectsRootCache = { mtimeMs: rootStat.mtimeMs, folders: projFolders };
      }
    } catch {}

    for (const folder of projFolders) {
      const folderPath = path.join(projectsDir, folder);
      let folderRecord = projectFolderCache.get(folderPath);
      let folderMtimeMs = 0;
      try {
        folderMtimeMs = fs.statSync(folderPath).mtimeMs;
      } catch {
        continue;
      }

      if (!folderRecord || folderRecord.mtimeMs !== folderMtimeMs) {
        const filesMap = new Map(); // sessId -> { fullJsonl, mtimeMs }
        try {
          const entries = fs.readdirSync(folderPath);
          for (const entry of entries) {
            if (!entry.endsWith('.jsonl')) continue;
            const fullJsonl = path.join(folderPath, entry);
            const sessId = entry.slice(0, -6);
            try {
              const st = fs.statSync(fullJsonl);
              filesMap.set(sessId, { fullJsonl, mtimeMs: st.mtimeMs });
            } catch {}
          }
          folderRecord = { mtimeMs: folderMtimeMs, filesMap };
          projectFolderCache.set(folderPath, folderRecord);
        } catch {
          continue;
        }
      }

      for (const [sessId, info] of folderRecord.filesMap.entries()) {
        try {
          const st = fs.statSync(info.fullJsonl);
          info.mtimeMs = st.mtimeMs;
          info.size = st.size;
        } catch { continue; }
        if (info.mtimeMs >= sevenDaysAgo || activeSessionsMap.has(sessId)) {
          jsonlFilesBySessionId.set(sessId, info.fullJsonl);
        }
      }
    }
  }

  const desktopSessions = collectClaudeDesktopSessions(getClaudeAppDataDir());
  const now = Date.now();
  const aliveSigParts = [];
  let hasRecentAliveActivity = false;

  for (const [sessId, meta] of activeSessionsMap.entries()) {
    if (!meta.isAlive) continue;
    let jSig = '0:0';
    let jMtime = 0;
    const jPath = jsonlFilesBySessionId.get(sessId);
    if (jPath) {
      try {
        const jSt = fs.statSync(jPath);
        jSig = `${jSt.mtimeMs}:${jSt.size}`;
        jMtime = jSt.mtimeMs;
      } catch {}
    }
    const lastAct = Math.max(meta.updatedAt || 0, meta.fileMtimeMs || 0, jMtime);
    if (now - lastAct < 10 * 60 * 1000) {
      hasRecentAliveActivity = true;
    }
    aliveSigParts.push(`${sessId}:${meta.status || ''}:${meta.fileMtimeMs || 0}:${jSig}`);
  }

  const hookSigParts = [];
  for (const [k, v] of hookStateOverrides.entries()) {
    hookSigParts.push(`${k}:${v.state}:${v.timestamp}`);
  }

  const topCacheKey = [
    sessionsDirCache.mtimeMs,
    projectsRootCache.mtimeMs,
    planUsageCache.mtimeMs,
    desktopIdbCache.resultKey,
    aliveSigParts.join(','),
    [...projectFolderCache.values()].flatMap((r) => [...r.filesMap.values()].map((f) => `${f.mtimeMs}:${f.size}`)).join(','),
    hookSigParts.join(','),
    hasRecentAliveActivity ? Math.floor(now / 3000) : Math.floor(now / 60000)
  ].join('|');

  if (claudeResultCache.data && claudeResultCache.key === topCacheKey) {
    return claudeResultCache.data;
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
      if (hookOverride && Date.now() - hookOverride.timestamp < 5 * 60 * 1000 &&
        (!parsed || parsed.lastTimestampMs <= hookOverride.timestamp)) {
        state = hookOverride.state;
      } else if (activeMeta.status && activeMeta.status !== 'idle') {
        state = activeMeta.status === 'waiting_approval' ? 'waiting_approval' : 'running';
      } else if (
        parsed &&
        parsed.lastStopReason === 'tool_use' &&
        parsed.lastEventType === 'assistant' &&
        Date.now() - parsed.lastTimestampMs < 180000
      ) {
        state = 'running';
      } else if (
        parsed &&
        parsed.lastEventType === 'user' &&
        parsed.lastUserIsToolResult &&
        Date.now() - parsed.lastTimestampMs < 90000
      ) {
        state = 'running';
      } else if (
        parsed &&
        parsed.lastEventType === 'user' &&
        !parsed.lastUserIsToolResult &&
        Date.now() - parsed.lastTimestampMs < 30000
      ) {
        state = 'running';
      } else if (
        parsed &&
        parsed.activeBgCommand &&
        Date.now() - parsed.lastTimestampMs < 10 * 60 * 1000
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
        backgroundTasksCount: parsed && parsed.activeBgCommand ? 1 : 0,
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
            : state === 'running' && parsed && parsed.activeBgCommand
              ? `⏳ Background: ${parsed.activeBgCommand}`
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
  for (const ds of desktopSessions) {
    sessions.push(ds);
    if (!ds.estimated && ds.updatedAt >= sevenDaysAgo && ds.tokens && ds.tokens.total > 0) {
      const dayKey = localDayKey(ds.updatedAt);
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

  const result = {
    sessions,
    dailyTokens: dailyAgg,
    modelTokens: modelAgg,
    planQuota
  };
  claudeResultCache = { key: topCacheKey, data: result };
  return result;
}

module.exports = {
  collectClaudeData, readPlanQuotaUsage, parseClaudeJsonl, snappyUncompress, localDayKey
};
