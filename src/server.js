const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { collectAgyData } = require('./collectors/agyCollector');
const { collectClaudeData } = require('./collectors/claudeCollector');
const { collectCodexData } = require('./collectors/codexCollector');
const { RemoteManager } = require('./collectors/remoteManager');
const { getHooksStatus, setClaudeHookEnabled, setAgyHookEnabled } = require('./services/hooksManager');
const { focusSessionWindow } = require('./services/windowFocuser');
const { getSessionMessages } = require('./services/conversationReader');
const { sendSessionReply } = require('./services/remoteResponder');
const { TunnelManager } = require('./services/tunnelManager');
const processCounter = require('./services/processCounter');

const CONFIG_PATH = path.resolve(__dirname, '..', 'config.json');
const PUBLIC_DIR = path.resolve(__dirname, 'public');
// APK fuera de la raíz estática: se sirve solo por /api/apk (autenticado)
const APK_DIR = path.resolve(__dirname, '..', 'apk');
const LEGACY_APK_PATH = path.join(PUBLIC_DIR, 'ai-pulse.apk');
const NTFY_TOPIC_RE = /^[A-Za-z0-9_-]{8,64}$/;
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_FAILS = 10;
const BODY_MAX_BYTES = 1024 * 256;

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.includes(String(host || ''));
}

function tokenCookie(token) {
  return `ai_pulse_token=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`;
}

function stripTokenFromUrl(url) {
  return String(url || '')
    .replace(/\?token=[^&]*&?/, '?')
    .replace(/&token=[^&]*/, '')
    .replace(/\?$/, '');
}

function resolveApkPath() {
  for (const candidate of [path.join(APK_DIR, 'ai-pulse.apk'), LEGACY_APK_PATH]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

function loadConfig() {
  const defaultTopic = `ai-pulse-${crypto.randomBytes(5).toString('hex')}`;
  const defaultAuthToken = crypto.randomBytes(16).toString('hex');
  const defaults = {
    port: 19876,
    // Loopback por defecto. LAN solo si el usuario escribe bindHost explícito (p. ej. 0.0.0.0)
    bindHost: '127.0.0.1',
    remoteAuthToken: defaultAuthToken,
    tunnelEnabled: false,
    ntfyPushLocalAlerts: true,
    ntfyIncludeText: false,
    soundEnabled: true,
    soundTone: 'chime',
    desktopNotifications: true,
    alwaysOnTop: true,
    autoHideFullscreen: true,
    launchAtStartup: true,
    opacity: 1.0,
    ntfyEnabled: true,
    ntfyTopic: defaultTopic,
    agyFiveHourLimitM: 25,
    agySevenDayLimitM: 100,
    sshHosts: []
  };

  if (!fs.existsSync(CONFIG_PATH)) {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2), 'utf8');
    } catch {}
    return defaults;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const merged = { ...defaults, ...parsed };
    let needsSave = false;
    if (!merged.ntfyTopic) {
      merged.ntfyTopic = defaultTopic;
      needsSave = true;
    }
    if (!merged.remoteAuthToken) {
      merged.remoteAuthToken = defaultAuthToken;
      needsSave = true;
    }
    if (!merged.bindHost) {
      merged.bindHost = '127.0.0.1';
    }
    if (!isLoopbackHost(merged.bindHost)) {
      console.warn(`[AI Pulse] bindHost=${merged.bindHost}: el servidor acepta conexiones de la LAN (requiere token)`);
    }
    if (needsSave) {
      try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
      } catch {}
    }
    return merged;
  } catch {
    return defaults;
  }
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch {}
}

// Clave de día en FECHA LOCAL (toISOString usa UTC y corre el día en Argentina)
function localDayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getLast7DaysKeys() {
  const days = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    days.push(localDayKey(d));
  }
  return days;
}

function createZeroTokenBucket() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, effective: 0, turns: 0 };
}

function addTokenBucket(target, src) {
  if (!src) return target;
  target.input += Number(src.input) || 0;
  target.cacheRead += Number(src.cacheRead) || 0;
  target.cacheWrite += Number(src.cacheWrite) || 0;
  target.output += Number(src.output) || 0;
  target.total += Number(src.total) || 0;
  target.effective += Number(src.effective) || 0;
  target.turns += Number(src.turns) || 0;
  return target;
}

function createWidgetServer({ onAlert, onConfigChange, onWindowControl, isRendererVisible } = {}) {
  const config = loadConfig();
  const sseClients = new Map(); // res -> { loopback }
  const hookOverrides = new Map(); // sessionId -> { state, message, timestamp }
  const prevStates = new Map(); // session.id -> state
  const unreadAlerts = new Set(); // session.id con alerta pendiente de leer
  const unreadSince = new Map(); // session.id -> ts de alta (para purgar alertas viejas)
  const recentAlerts = []; // últimas 25 alertas
  const authFailures = new Map(); // ip -> { count, since } (rate limit de token)
  const lanExposed = !isLoopbackHost(config.bindHost);

  function markUnread(id) {
    unreadAlerts.add(id);
    if (!unreadSince.has(id)) unreadSince.set(id, Date.now());
  }

  // Quita alertas de sesiones que ya no existen; los reset: duran 10 min
  function pruneUnreadAlerts(liveIds) {
    const nowMs = Date.now();
    for (const id of [...unreadAlerts]) {
      const isReset = /reset/i.test(String(id));
      const expired = nowMs - (unreadSince.get(id) || 0) > 10 * 60 * 1000;
      if ((!isReset && !liveIds.has(id)) || (isReset && expired)) {
        unreadAlerts.delete(id);
        unreadSince.delete(id);
      }
    }
    for (const id of [...unreadSince.keys()]) {
      if (!unreadAlerts.has(id)) unreadSince.delete(id);
    }
  }

  let latestSnapshot = null;
  let lastBroadcastSig = '';
  let lastBroadcastAt = 0;
  let lastPollAt = 0;
  let hooksStatusCache = { checkedAt: 0, data: null };

  function getCachedHooksStatus(force = false) {
    const now = Date.now();
    if (!force && hooksStatusCache.data && now - hooksStatusCache.checkedAt < 15000) {
      return hooksStatusCache.data;
    }
    const status = getHooksStatus();
    hooksStatusCache = { checkedAt: now, data: status };
    return status;
  }

  function buildSnapshotSignature(snap) {
    return JSON.stringify({
      summary: snap.summary,
      running: snap.running,
      sessions: snap.sessions.map((s) => ({
        id: s.id,
        state: s.state,
        isOpen: s.isOpen,
        hasUnreadAlert: s.hasUnreadAlert,
        updatedAt: s.updatedAt,
        turns: s.turns,
        lastMessage: s.lastMessage,
        currentAction: s.currentAction,
        totalTok: s.tokens && s.tokens.total
      })),
      planFh: snap.planQuota && snap.planQuota.fiveHourPct,
      planSd: snap.planQuota && snap.planQuota.sevenDayPct,
      planResetId: snap.planQuota && snap.planQuota.lastReset && snap.planQuota.lastReset.id,
      agyFh: snap.agyQuota && snap.agyQuota.fiveHourPct,
      agySd: snap.agyQuota && snap.agyQuota.sevenDayPct,
      agyBurn: snap.agyQuota && snap.agyQuota.burnRatePerHour,
      agyStatus: snap.agyQuota && snap.agyQuota.providerStatus,
      codexQuota: snap.codexQuota,
      hooksStatus: snap.hooksStatus,
      ntfyConnected: snap.remoteSetup && snap.remoteSetup.ntfyConnected,
      tunnelStatus: snap.mobileAccess && snap.mobileAccess.tunnel,
      config: snap.config,
      recentAlertsLen: snap.recentAlerts.length,
      lastAlertId: snap.recentAlerts[0] && snap.recentAlerts[0].id
    });
  }

  const tunnelManager = new TunnelManager({
    config,
    saveConfig: () => saveConfig(config),
    onStateChange: () => {
      refreshSnapshot(true);
    }
  });

  const remoteManager = new RemoteManager({
    config,
    saveConfig: () => saveConfig(config),
    onRemoteEvent: (sessionObj, prevObj) => {
      const prevState = prevObj ? prevObj.state : null;
      if (
        (sessionObj.state === 'waiting_input' || sessionObj.state === 'waiting_approval') &&
        prevState !== sessionObj.state
      ) {
        triggerAlert(sessionObj, sessionObj.state);
      }
      refreshSnapshot(true);
    },
    onRemoteReplyCommand: async (cmdPayload) => {
      // El comando ya llegó firmado y verificado (remoteManager.verifyRemoteCommand)
      if (!cmdPayload || (!cmdPayload.text && !cmdPayload.quickAction)) return;
      const targetId = String(cmdPayload.sessionId || '');
      const sessions = (latestSnapshot && latestSnapshot.sessions) || [];
      // Sin fallback: solo se responde a la sesión exacta y abierta
      const targetSession = sessions.find(
        (s) => (s.id === targetId || s.sessionId === targetId) && s.isOpen
      );
      if (!targetSession) return;
      await sendSessionReply({
        ...targetSession,
        text: cmdPayload.text,
        quickAction: cmdPayload.quickAction
      });
      unreadAlerts.delete(targetSession.id);
      unreadSince.delete(targetSession.id);
      setTimeout(() => refreshSnapshot(true), 500);
    }
  });

  function getMobileBaseUrl() {
    if (tunnelManager.publicUrl) return tunnelManager.publicUrl;
    if (!lanExposed) return '';
    const ips = remoteManager.getLocalNetworkAddresses();
    if (ips.length > 0) return `http://${ips[0].address}:${config.port}`;
    return '';
  }

  function triggerAlert(session, alertType, customMessage) {
    markUnread(session.id);
    const alertObj = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      sessionId: session.id,
      provider: session.provider,
      providerLabel: session.providerLabel,
      isRemote: Boolean(session.isRemote),
      title: session.title,
      projectName: session.projectName,
      workspace: session.workspace,
      alertType, // 'waiting_input' | 'waiting_approval'
      message:
        customMessage ||
        session.currentAction ||
        session.lastMessage ||
        (alertType === 'waiting_approval'
          ? 'Requiere tu permiso o confirmación para continuar'
          : 'Terminó su tarea y está esperando tu respuesta'),
      timestamp: Date.now()
    };

    recentAlerts.unshift(alertObj);
    if (recentAlerts.length > 25) recentAlerts.length = 25;

    broadcastSse('alert', alertObj);
    if (typeof onAlert === 'function') {
      onAlert(alertObj, config);
    }
    remoteManager.sendOutboundAlertPush(alertObj, getMobileBaseUrl());
  }

  function triggerQuotaResetAlert(resetObj) {
    if (!resetObj) return;
    const isBonus = Boolean(resetObj.isBonus);
    const alertObj = {
      id: `${Date.now()}-reset`,
      sessionId: resetObj.id || 'claude:quota-reset',
      provider: 'claude',
      providerLabel: isBonus ? '🎁 BONUS CLAUDE' : '🔄 CUOTA CLAUDE',
      isRemote: false,
      title: `Bajó de ${resetObj.fromPct}% a ${resetObj.toPct}% (-${resetObj.savedPct}%)`,
      projectName: isBonus ? '¡Reseteo Gratis de Cuota Semanal!' : 'Cuota Semanal Renovada',
      workspace: '',
      alertType: 'quota_reset',
      isBonus,
      message: isBonus
        ? `🎁 ¡Claude te dio un reseteo gratis! Tu cuota semanal bajó de ${resetObj.fromPct}% a ${resetObj.toPct}% (+${resetObj.savedPct}% libre).`
        : `🔄 Tu cuota semanal de Claude se reinició de ${resetObj.fromPct}% a ${resetObj.toPct}%.`,
      timestamp: Date.now()
    };

    markUnread(alertObj.sessionId);
    recentAlerts.unshift(alertObj);
    if (recentAlerts.length > 25) recentAlerts.length = 25;

    broadcastSse('alert', alertObj);
    if (typeof onAlert === 'function') {
      onAlert(alertObj, config);
    }
    remoteManager.sendOutboundAlertPush(alertObj, getMobileBaseUrl());
    return alertObj;
  }

  function buildAnalytics(agyData, claudeData, codexData, allSessions) {
    const dayKeys = getLast7DaysKeys();
    const todayKey = dayKeys[dayKeys.length - 1];

    const timeline = dayKeys.map((day) => {
      const agyDay = agyData.dailyTokens[day] || createZeroTokenBucket();
      const claudeDay = claudeData.dailyTokens[day] || createZeroTokenBucket();
      const codexDay = codexData.dailyTokens[day] || createZeroTokenBucket();
      return {
        date: day,
        label: day.slice(5), // MM-DD
        agy: agyDay,
        claude: claudeDay,
        codex: codexDay,
        totalTokens: (agyDay.total || 0) + (claudeDay.total || 0) + codexDay.total,
        effectiveTokens: (agyDay.effective || 0) + (claudeDay.effective || 0) + codexDay.effective
      };
    });

    const weekly = {
      codex: createZeroTokenBucket(),
      agy: createZeroTokenBucket(),
      claude: createZeroTokenBucket(),
      combined: createZeroTokenBucket()
    };

    for (const item of timeline) {
      addTokenBucket(weekly.codex, item.codex);
      addTokenBucket(weekly.combined, item.codex);
      addTokenBucket(weekly.agy, item.agy);
      addTokenBucket(weekly.claude, item.claude);
      addTokenBucket(weekly.combined, item.agy);
      addTokenBucket(weekly.combined, item.claude);
    }

    const todayEntry = timeline[timeline.length - 1] || {
      agy: createZeroTokenBucket(),
      claude: createZeroTokenBucket()
    };
    const today = {
      codex: todayEntry.codex || createZeroTokenBucket(),
      agy: todayEntry.agy,
      claude: todayEntry.claude,
      combined: addTokenBucket(addTokenBucket(addTokenBucket(createZeroTokenBucket(), todayEntry.agy), todayEntry.claude), todayEntry.codex)
    };

    // Ranking de proyectos por consumo en sesiones recientes/activas
    const projectMap = new Map();
    for (const s of allSessions) {
      const key = `${s.provider}:${s.projectName}`;
      if (!projectMap.has(key)) {
        projectMap.set(key, {
          projectName: s.projectName,
          provider: s.provider,
          totalTokens: 0,
          effectiveTokens: 0,
          sessionsCount: 0
        });
      }
      const p = projectMap.get(key);
      p.totalTokens += (s.tokens && s.tokens.total) || 0;
      p.effectiveTokens += (s.tokens && s.tokens.effective) || 0;
      p.sessionsCount += 1;
    }

    const topProjects = [...projectMap.values()]
      .filter((p) => p.totalTokens > 0)
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 8);

    return {
      todayKey,
      timeline,
      today,
      weekly,
      topProjects,
      claudeModels: claudeData.modelTokens || {}
    };
  }

  function refreshSnapshot(forceBroadcast = false) {
    const now = Date.now();
    lastPollAt = now;
    const agyData = collectAgyData(config);
    const claudeData = collectClaudeData(hookOverrides);
    const codexData = collectCodexData();
    const remoteSessions = remoteManager.getActiveRemoteSessions();

    // Detectar automáticamente nuevos reseteos de cuota semanal Claude (Gratis / Bonus o Programados)
    const latestReset = claudeData.planQuota && claudeData.planQuota.lastReset;
    if (latestReset && latestReset.id) {
      if (!config.lastNotifiedResetId) {
        config.lastNotifiedResetId = latestReset.id;
        saveConfig(config);
      } else if (config.lastNotifiedResetId !== latestReset.id) {
        config.lastNotifiedResetId = latestReset.id;
        saveConfig(config);
        triggerQuotaResetAlert(latestReset);
      }
    }

    const allSessions = [...claudeData.sessions, ...agyData.sessions, ...codexData.sessions, ...remoteSessions];

    // Evaluar transiciones de estado para disparar alertas automáticas
    for (const s of allSessions) {
      const prev = prevStates.get(s.id);
      if (s.state === 'running') {
        // Si volvió a trabajar, limpiar alerta pendiente
        unreadAlerts.delete(s.id);
      } else if (
        prev === 'running' &&
        (s.state === 'waiting_input' || s.state === 'waiting_approval') &&
        s.isOpen
      ) {
        triggerAlert(s, s.state);
      } else if (prev !== 'waiting_approval' && s.state === 'waiting_approval' && s.isOpen && prev !== undefined) {
        triggerAlert(s, 'waiting_approval');
      }
      prevStates.set(s.id, s.state);
      s.hasUnreadAlert = unreadAlerts.has(s.id);
    }
    pruneUnreadAlerts(new Set(allSessions.map((s) => s.id)));

    const statePriority = { waiting_approval: 0, waiting_input: 1, running: 2, closed: 3 };
    allSessions.sort((a, b) => {
      if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
      if (Boolean(a.hasUnreadAlert) !== Boolean(b.hasUnreadAlert)) {
        return a.hasUnreadAlert ? -1 : 1;
      }
      if (statePriority[a.state] !== statePriority[b.state]) {
        return statePriority[a.state] - statePriority[b.state];
      }
      return b.updatedAt - a.updatedAt;
    });

    const openSessions = allSessions.filter((s) => s.isOpen);
    const summary = {
      totalOpen: openSessions.length,
      waitingInput: openSessions.filter((s) => s.state === 'waiting_input').length,
      waitingApproval: openSessions.filter((s) => s.state === 'waiting_approval').length,
      running: openSessions.filter((s) => s.state === 'running').length,
      remoteOpen: openSessions.filter((s) => s.isRemote).length,
      unreadAlertsCount: unreadAlerts.size,
      activeSessionTokens: openSessions.reduce((acc, s) => acc + ((s.tokens && s.tokens.total) || 0), 0)
    };

    const analytics = buildAnalytics(agyData, claudeData, codexData, allSessions);
    const snippets = remoteManager.getRemoteSetupSnippets(config.port);
    // Sin LAN expuesta no se ofrecen URLs LAN (el puerto no escucha fuera del loopback)
    const primaryLanIp =
      lanExposed && snippets.localIps && snippets.localIps.length > 0 ? snippets.localIps[0].address : '';
    const token = config.remoteAuthToken || '';
    const tunnelStatus = tunnelManager.getStatus();
    const lanBase = primaryLanIp ? `http://${primaryLanIp}:${config.port}` : '';
    const tunnelBase = tunnelStatus.publicUrl || '';
    const lanAppUrl = lanBase ? `${lanBase}/?mode=web&token=${encodeURIComponent(token)}` : '';
    const lanWidgetUrl = lanBase ? `${lanBase}/?mode=widget&token=${encodeURIComponent(token)}` : '';
    const tunnelAppUrl = tunnelBase
      ? `${tunnelBase}/?mode=web&token=${encodeURIComponent(token)}`
      : '';
    const tunnelWidgetUrl = tunnelBase
      ? `${tunnelBase}/?mode=widget&token=${encodeURIComponent(token)}`
      : '';
    const activeAppUrl = tunnelAppUrl || lanAppUrl;
    const activeWidgetUrl = tunnelWidgetUrl || lanWidgetUrl;

    const mobileAccess = {
      lanIp: primaryLanIp,
      lanUrl: lanAppUrl,
      lanAppUrl,
      lanWidgetUrl,
      tunnel: tunnelStatus,
      tunnelUrl: tunnelAppUrl,
      tunnelAppUrl,
      tunnelWidgetUrl,
      activeUrl: activeAppUrl,
      activeAppUrl,
      activeWidgetUrl
    };

    latestSnapshot = {
      timestamp: now,
      summary,
      running: processCounter.getCounts(),
      sessions: allSessions,
      planQuota: claudeData.planQuota,
      agyQuota: agyData.agyQuota,
      codexQuota: codexData.codexQuota,
      analytics,
      hooksStatus: getCachedHooksStatus(),
      remoteSetup: {
        ...snippets,
        ntfyConnected: remoteManager.ntfyConnected
      },
      mobileAccess,
      config,
      recentAlerts
    };

    if (sseClients.size > 0) {
      const windowVisible = typeof isRendererVisible === 'function' ? isRendererVisible() : true;
      const hasExternalWebClients = sseClients.size > 1;
      if (windowVisible || hasExternalWebClients || forceBroadcast) {
        const sig = buildSnapshotSignature(latestSnapshot);
        if (forceBroadcast || sig !== lastBroadcastSig || now - lastBroadcastAt >= 30000) {
          lastBroadcastSig = sig;
          lastBroadcastAt = now;
          broadcastSse('state', latestSnapshot);
        }
      }
    }
    return latestSnapshot;
  }

  // Vista del snapshot para un cliente: sin remoteAuthToken ni keyPath de SSH.
  // Las URLs con token solo se entregan al loopback (la ventana local muestra el QR).
  function sanitizeSnapshot(snap, loopback) {
    if (!snap) return snap;
    const cfg = { ...(snap.config || {}) };
    delete cfg.remoteAuthToken;
    if (Array.isArray(cfg.sshHosts)) {
      cfg.sshHosts = cfg.sshHosts.map((h) => {
        if (!h || typeof h !== 'object') return h;
        const { keyPath, ...rest } = h;
        return {
          ...rest,
          hasKeyPath: Boolean(keyPath),
          keyName: keyPath ? path.basename(String(keyPath)) : ''
        };
      });
    }
    let mobileAccess = snap.mobileAccess || {};
    if (!loopback) {
      mobileAccess = { ...mobileAccess };
      for (const k of Object.keys(mobileAccess)) {
        if (typeof mobileAccess[k] === 'string') mobileAccess[k] = stripTokenFromUrl(mobileAccess[k]);
      }
    }
    return { ...snap, config: cfg, mobileAccess };
  }

  function broadcastSse(eventName, data) {
    const isState = eventName === 'state';
    const fullMsg = `event: ${eventName}\ndata: ${JSON.stringify(isState ? sanitizeSnapshot(data, true) : data)}\n\n`;
    let remoteMsg = fullMsg;
    if (isState) {
      remoteMsg = `event: ${eventName}\ndata: ${JSON.stringify(sanitizeSnapshot(data, false))}\n\n`;
    }
    for (const [res, client] of sseClients) {
      try {
        res.write(client.loopback ? fullMsg : remoteMsg);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  function handleHookEvent(body) {
    const provider = body.provider || 'claude';
    const eventHint = body.eventHint || (body.payload && body.payload.hook_event_name) || '';
    const p = body.payload || {};

    if (provider === 'claude' || p.session_id) {
      const sessId = p.session_id;
      let newState = 'waiting_input';
      let msg = p.last_assistant_message || p.message || '';
      if (eventHint === 'Notification' || p.hook_event_name === 'Notification') {
        newState = p.notification_type === 'permission_prompt' ? 'waiting_approval' : 'waiting_input';
      } else if (eventHint === 'Stop' || eventHint === 'SubagentStop') {
        newState = 'waiting_input';
      }
      if (sessId) {
        hookOverrides.set(sessId, {
          state: newState,
          message: String(msg).slice(0, 240),
          timestamp: Date.now()
        });
      }
      refreshSnapshot(true);
      const targetSession =
        latestSnapshot &&
        latestSnapshot.sessions.find((s) => s.sessionId === sessId || s.id === `claude:${sessId}`);
      if (targetSession) {
        triggerAlert(targetSession, newState, msg);
      }
    } else if (provider === 'agy' || p.conversationId) {
      refreshSnapshot(true);
      const convId = p.conversationId;
      const targetSession =
        latestSnapshot &&
        latestSnapshot.sessions.find((s) => s.sessionId === convId || s.id === `agy:${convId}`);
      if (targetSession) {
        triggerAlert(targetSession, 'waiting_input', p.lastUserInput ? `Finalizó: ${p.lastUserInput}` : '');
      }
    }
  }

  // Rechaza con statusCode 413 si el cuerpo supera BODY_MAX_BYTES (antes quedaba colgado)
  function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      req.on('data', (chunk) => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > BODY_MAX_BYTES) {
          tooLarge = true;
          const err = new Error('Cuerpo de la petición demasiado grande');
          err.statusCode = 413;
          reject(err);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooLarge) return;
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(body.trim() ? JSON.parse(body) : {});
        } catch {
          resolve({});
        }
      });
      req.on('error', () => {
        if (!tooLarge) resolve({});
      });
    });
  }

  function isLocalLoopbackSocket(req) {
    if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) {
      return false; // Tráfico entrante desde Cloudflare Tunnel 4G
    }
    if (!isAllowedHostHeader(req.headers.host)) {
      return false; // Acceso por IP LAN o dominio de túnel -> validar por token remoto
    }
    const addr = String((req.socket && req.socket.remoteAddress) || '');
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  }

  // Origen exacto del propio servidor (mismo puerto). Otro puerto o host se rechaza.
  function isAllowedLocalOrigin(originHeader) {
    if (!originHeader) return true; // Peticiones directas de proceso local / CLI sin header Origin
    const origin = String(originHeader).trim().toLowerCase();
    return origin === `http://127.0.0.1:${config.port}` || origin === `http://localhost:${config.port}`;
  }

  function isAllowedHostHeader(hostHeader) {
    if (!hostHeader) return true;
    const host = String(hostHeader).trim().toLowerCase();
    return host === `127.0.0.1:${config.port}` || host === `localhost:${config.port}`;
  }

  function extractRequestToken(req, urlObj) {
    const qToken = urlObj.searchParams.get('token');
    if (qToken) return qToken.trim();
    const hToken = req.headers['x-auth-token'];
    if (hToken) return String(hToken).trim();
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim();
    }
    const cookieHeader = String(req.headers.cookie || '');
    const match = cookieHeader.match(/(?:^|;\s*)ai_pulse_token=([^;]+)/);
    if (match && match[1]) {
      try {
        return decodeURIComponent(match[1].trim());
      } catch {
        return match[1].trim();
      }
    }
    return '';
  }

  function isValidRemoteToken(tokenCandidate) {
    const expected = String(config.remoteAuthToken || '').trim();
    if (!expected || !tokenCandidate) return false;
    const a = Buffer.from(String(tokenCandidate), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Rate limit de intentos fallidos por IP (por túnel la IP real viene en cf-connecting-ip)
  function clientIpOf(req) {
    return String(req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown');
  }

  function isAuthRateLimited(ip) {
    const entry = authFailures.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.since > AUTH_WINDOW_MS) {
      authFailures.delete(ip);
      return false;
    }
    return entry.count >= AUTH_MAX_FAILS;
  }

  function recordAuthFailure(ip) {
    const now = Date.now();
    const entry = authFailures.get(ip);
    if (!entry || now - entry.since > AUTH_WINDOW_MS) {
      if (authFailures.size > 500) authFailures.clear();
      authFailures.set(ip, { count: 1, since: now });
    } else {
      entry.count += 1;
    }
  }

  function getCorsHeaders(req) {
    const origin = req.headers.origin;
    const headers = {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token, Authorization'
    };
    if (origin && isAllowedLocalOrigin(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Vary'] = 'Origin';
    }
    return headers;
  }

  function sendJson(res, statusCode, obj, req = { headers: {} }, extraHeaders = {}) {
    const payload = JSON.stringify(obj);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      ...getCorsHeaders(req),
      ...extraHeaders
    });
    res.end(payload);
  }

  function failRequest(res, err) {
    if (res.headersSent) {
      try {
        res.end();
      } catch {}
      return;
    }
    if (err && err.statusCode === 413) {
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
      res.end(JSON.stringify({ ok: false, error: 'Cuerpo demasiado grande' }));
      return;
    }
    console.error('[AI Pulse Server] Error en petición:', err && err.message);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'Error interno del servidor' }));
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => failRequest(res, err));
  });

  async function handleRequest(req, res) {
    const urlObj = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = urlObj.pathname;
    const isLocalLoopback = isLocalLoopbackSocket(req);

    // Si es socket local directo en PC, proteger contra DNS Rebinding y Cross-Origin CSRF desde sitios externos
    if (isLocalLoopback) {
      if (!isAllowedHostHeader(req.headers.host) || !isAllowedLocalOrigin(req.headers.origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Forbidden origin or host' }));
        return;
      }
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, getCorsHeaders(req));
      res.end();
      return;
    }

    // Autenticación: loopback sin Origin (CLI, hooks) no requiere token.
    // Resto (LAN, túnel, y loopback con Origin = UI del navegador/Electron) requiere token.
    const isOriginRequest = Boolean(req.headers.origin);
    const requiresToken = !isLocalLoopback || isOriginRequest;
    const isPublicPath = !pathname.startsWith('/api/');
    const clientIp = clientIpOf(req);
    const rateLimited = isAuthRateLimited(clientIp);
    const reqToken = extractRequestToken(req, urlObj);
    const hasValidToken = !rateLimited && isValidRemoteToken(reqToken);
    const cookieHeaders = {};
    if (hasValidToken && urlObj.searchParams.get('token')) {
      cookieHeaders['Set-Cookie'] = tokenCookie(reqToken);
    } else if (isLocalLoopback && req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      // La ventana local recibe la cookie HttpOnly (JS no la puede leer; el fetch same-origin la envía)
      cookieHeaders['Set-Cookie'] = tokenCookie(config.remoteAuthToken || '');
    }

    if (requiresToken && !isPublicPath && !hasValidToken) {
      if (!rateLimited) recordAuthFailure(clientIp);
      sendJson(res, rateLimited ? 429 : 401, {
        ok: false,
        requiresAuth: true,
        error: rateLimited
          ? 'Demasiados intentos fallidos. Esperá unos minutos.'
          : 'Clave de acceso remoto requerida. Escanea el código QR desde la pestaña Remotos en tu PC.'
      }, req);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      if (!latestSnapshot) refreshSnapshot();
      sendJson(res, 200, sanitizeSnapshot(latestSnapshot, isLocalLoopback), req, cookieHeaders);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/apk') {
      const apkPath = hasValidToken ? resolveApkPath() : null;
      if (!hasValidToken) {
        sendJson(res, 401, { ok: false, requiresAuth: true, error: 'Clave de acceso remoto requerida' }, req);
        return;
      }
      if (!apkPath) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('APK no disponible');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': 'attachment; filename="AI-Pulse.apk"',
        'Cache-Control': 'no-cache'
      });
      fs.createReadStream(apkPath).pipe(res);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/widget/compact') {
      if (!latestSnapshot) refreshSnapshot();
      const snap = latestSnapshot || {};
      const sum = snap.summary || {};
      const pq = snap.planQuota || {};
      const aq = snap.agyQuota || {};
      const cq = snap.codexQuota || {};
      const ma = snap.mobileAccess || {};
      const openSessions = ((snap.sessions || []).filter((s) => s.isOpen) || []).slice(0, 5).map((s) => ({
        id: s.id,
        provider: s.provider,
        providerLabel: s.providerLabel || s.provider.toUpperCase(),
        projectName: s.projectName || s.title || 'Consola',
        title: s.title || s.projectName || '',
        state: s.state || 'idle',
        statusText:
          s.state === 'waiting_approval'
            ? '⚠️ Pide permiso'
            : s.state === 'waiting_input'
            ? '💬 Lista p/ responder'
            : s.state === 'running' || s.state === 'working'
            ? '⚡ Trabajando'
            : '● En espera',
        lastMessage: String(s.currentAction || s.lastMessage || '').slice(0, 90)
      }));
      sendJson(
        res,
        200,
        {
          ok: true,
          timestamp: snap.timestamp || Date.now(),
          running: processCounter.getCounts(),
          lanBase: ma.lanIp ? `http://${ma.lanIp}:${config.port}` : '',
          tunnelBase: (ma.tunnel && ma.tunnel.publicUrl) || '',
          summary: {
            openCount: sum.totalOpen || 0,
            workingCount: sum.running || 0,
            waitingCount: sum.waitingInput || 0,
            approvalCount: sum.waitingApproval || 0
          },
          quotas: {
            claude5hPct: pq.fiveHourPct != null ? Math.round(Number(pq.fiveHourPct)) : null,
            claude7dPct: pq.sevenDayPct != null ? Math.round(Number(pq.sevenDayPct)) : null,
            claudeStale: Boolean(pq.stale),
            agy5hPct: aq.fiveHourPct != null ? Math.round(Number(aq.fiveHourPct)) : null,
            agy7dPct: aq.sevenDayPct != null ? Math.round(Number(aq.sevenDayPct)) : null,
            agy7dPctExact: aq.sevenDayPctExact != null ? Number(aq.sevenDayPctExact) : null,
            agyEstimated: Boolean(aq.estimated),
            agyStatus: aq.providerStatus || null,
            codex5hPct: cq.fiveHourPct ?? null,
            codex7dPct: cq.sevenDayPct ?? null,
            codexUpdatedAt: cq.updatedAt || null,
            codexStale: cq.stale || false,
            claudeResetId: (pq.lastReset && pq.lastReset.id) || '',
            claudeResetMsg:
              pq.lastReset && pq.lastReset.isBonus
                ? `🎁 ¡Bonus Claude! Cuota semanal bajó de ${pq.lastReset.fromPct}% a ${pq.lastReset.toPct}% (-${pq.lastReset.savedPct}%)`
                : pq.lastReset
                  ? `🔄 Cuota semanal de Claude renovada (${pq.lastReset.fromPct}% → ${pq.lastReset.toPct}%)`
                  : ''
          },
          sessions: openSessions
        },
        req,
        cookieHeaders
      );
      return;
    }

    if (req.method === 'GET' && pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        ...getCorsHeaders(req),
        ...cookieHeaders
      });
      res.write(`event: state\ndata: ${JSON.stringify(sanitizeSnapshot(latestSnapshot || refreshSnapshot(), isLocalLoopback))}\n\n`);
      sseClients.set(res, { loopback: isLocalLoopback });
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/sessions/messages') {
      const targetId = urlObj.searchParams.get('id') || '';
      if (!latestSnapshot) refreshSnapshot();
      const result = getSessionMessages(targetId, latestSnapshot ? latestSnapshot.sessions : []);
      sendJson(res, 200, result, req, cookieHeaders);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/sessions/reply') {
      const body = await parseJsonBody(req);
      if (!latestSnapshot) refreshSnapshot();
      const rawLookupId = String(body.sessionId || body.id || '').replace(/^(claude|agy|claude-app):/i, '');
      const matchSession = (list) =>
        list.find(
          (s) =>
            s.id === body.id ||
            s.sessionId === body.sessionId ||
            s.id === body.sessionId ||
            (rawLookupId && s.sessionId === rawLookupId)
        );

      let sessions = (latestSnapshot && latestSnapshot.sessions) || [];
      let targetSession = matchSession(sessions);
      if (!targetSession || (!body.pid && !targetSession.pid && targetSession.isOpen !== false)) {
        refreshSnapshot(false);
        sessions = (latestSnapshot && latestSnapshot.sessions) || [];
        targetSession = matchSession(sessions) || {};
      }

      const resolvedProvider = body.provider || targetSession.provider || 'claude';
      const resolvedWorkspace = body.workspace || targetSession.workspace || '';
      let resolvedPid = body.pid || targetSession.pid || null;

      if (!resolvedPid) {
        const wsLower = String(resolvedWorkspace || '').toLowerCase();
        const openMatch =
          (wsLower &&
            sessions.find(
              (s) =>
                s.isOpen &&
                s.pid &&
                s.provider === resolvedProvider &&
                String(s.workspace || '').toLowerCase() === wsLower
            )) ||
          sessions.find(
            (s) =>
              s.isOpen &&
              s.pid &&
              s.provider === resolvedProvider &&
              (s.state === 'waiting_approval' || s.state === 'waiting_input')
          ) ||
          sessions.find((s) => s.isOpen && s.pid && s.provider === resolvedProvider);
        if (openMatch) {
          resolvedPid = openMatch.pid;
        }
      }

      const resolvedSessionId =
        targetSession.parentConversationId ||
        body.sessionId ||
        targetSession.sessionId ||
        body.id ||
        targetSession.id;

      const replyPayload = {
        id: body.id || targetSession.id,
        sessionId: resolvedSessionId,
        pid: resolvedPid,
        provider: resolvedProvider,
        surface: body.surface || targetSession.surface,
        workspace: resolvedWorkspace,
        isOpen: targetSession.isOpen !== false,
        text: body.text || '',
        quickAction: body.quickAction || ''
      };

      if (replyPayload.id) {
        unreadAlerts.delete(replyPayload.id);
      }

      const result = await sendSessionReply(replyPayload);
      setTimeout(() => refreshSnapshot(true), 450);
      sendJson(res, 200, result, req);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/tunnel/toggle') {
      const body = await parseJsonBody(req);
      const enable = Boolean(body.enabled);
      config.tunnelEnabled = enable;
      saveConfig(config);

      let status;
      if (enable) {
        status = await tunnelManager.start();
      } else {
        status = tunnelManager.stop();
      }
      refreshSnapshot(true);
      sendJson(res, 200, { ok: true, tunnel: status }, req);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/hooks/event') {
      const body = await parseJsonBody(req);
      handleHookEvent(body);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/remote/report') {
      const body = await parseJsonBody(req);
      const sess = remoteManager.ingestRemotePayload(body, 'http');
      refreshSnapshot(true);
      sendJson(res, 200, { ok: true, session: sess });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/remote/test') {
      // Solo para desarrollo: datos de demo hardcodeados, no existen en producción
      if (config.devMode !== true) {
        sendJson(res, 404, { ok: false, error: 'No disponible (devMode desactivado)' }, req);
        return;
      }
      const body = await parseJsonBody(req);
      const sess = remoteManager.ingestRemotePayload(
        {
          host: body.host || 'srv-produccion-01',
          provider: body.provider || 'claude',
          sessionId: body.sessionId || 'demo-remote-1',
          title: body.title || 'Deploy & Migración API',
          cwd: '/home/ubuntu/api-backend',
          state: body.state || 'waiting_input',
          message:
            body.message ||
            'Migración completada en el servidor remoto. ¿Deseas reiniciar el servicio PM2 ahora?',
          tokens: {
            input: 14200,
            cacheRead: 185000,
            cacheWrite: 6400,
            output: 3150
          }
        },
        'ntfy'
      );
      refreshSnapshot(true);
      sendJson(res, 200, { ok: true, session: sess });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/remote/remove') {
      const body = await parseJsonBody(req);
      if (body.id) {
        remoteManager.removeRemoteSession(body.id);
        unreadAlerts.delete(body.id);
        refreshSnapshot(true);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/sessions/ack') {
      const body = await parseJsonBody(req);
      if (body.all) {
        unreadAlerts.clear();
      } else if (body.id) {
        unreadAlerts.delete(body.id);
      }
      refreshSnapshot(true);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/sessions/focus') {
      const body = await parseJsonBody(req);
      if (body.id) unreadAlerts.delete(body.id);
      const result = await focusSessionWindow({
        id: body.id,
        sessionId: body.sessionId,
        pid: body.pid,
        provider: body.provider,
        surface: body.surface,
        workspace: body.workspace,
        title: body.title
      });
      if (typeof onWindowControl === 'function') {
        onWindowControl({ action: 'ensureTopmost' });
      }
      refreshSnapshot(true);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/quota/test-reset-alert') {
      const sampleReset = (latestSnapshot &&
        latestSnapshot.planQuota &&
        (latestSnapshot.planQuota.lastBonusReset || latestSnapshot.planQuota.lastReset)) || {
        id: `reset:${Date.now()}`,
        timestamp: Date.now(),
        fromPct: 97,
        toPct: 7,
        savedPct: 90,
        isBonus: true,
        label: '🎁 Reseteo Gratis (Bonus)'
      };
      const alertObj = triggerQuotaResetAlert(sampleReset);
      refreshSnapshot(true);
      sendJson(res, 200, { ok: true, alert: alertObj });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/hooks/toggle') {
      const body = await parseJsonBody(req);
      try {
        if (body.target === 'claude') {
          setClaudeHookEnabled(Boolean(body.enabled));
        } else if (body.target === 'agy') {
          setAgyHookEnabled(Boolean(body.enabled));
        }
        getCachedHooksStatus(true);
        refreshSnapshot(true);
        sendJson(res, 200, { ok: true, hooksStatus: getCachedHooksStatus() });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/config') {
      const body = await parseJsonBody(req);
      const prevTopic = config.ntfyTopic;
      const prevNtfyEnabled = config.ntfyEnabled;

      if (Object.prototype.hasOwnProperty.call(body, 'ntfyTopic')) {
        body.ntfyTopic = String(body.ntfyTopic || '').trim();
        if (!NTFY_TOPIC_RE.test(body.ntfyTopic)) {
          sendJson(res, 400, { ok: false, error: 'ntfyTopic inválido: 8-64 caracteres [A-Za-z0-9_-]' }, req);
          return;
        }
      }
      if (Array.isArray(body.sshHosts)) {
        // La UI no recibe keyPath (solo keyName): si no viene una ruta nueva, se conserva la anterior del mismo target
        const prevHosts = Array.isArray(config.sshHosts) ? config.sshHosts : [];
        body.sshHosts = body.sshHosts.map((h) => {
          if (!h || typeof h !== 'object') return h;
          const { hasKeyPath, keyName, ...rest } = h;
          if (typeof rest.keyPath === 'string' && rest.keyPath.trim()) return rest;
          const old = prevHosts.find((p) => p && p.target === rest.target);
          return old && old.keyPath ? { ...rest, keyPath: old.keyPath } : rest;
        });
      }

      const allowedKeys = [
        'soundEnabled',
        'soundTone',
        'desktopNotifications',
        'alwaysOnTop',
        'autoHideFullscreen',
        'launchAtStartup',
        'opacity',
        'ntfyEnabled',
        'ntfyTopic',
        'ntfyPushLocalAlerts',
        'tunnelEnabled',
        'agyFiveHourLimitM',
        'agySevenDayLimitM',
        'sshHosts',
        'windowPosition'
      ];
      for (const k of allowedKeys) {
        if (Object.prototype.hasOwnProperty.call(body, k)) {
          config[k] = body[k];
        }
      }
      saveConfig(config);

      if (config.ntfyTopic !== prevTopic || config.ntfyEnabled !== prevNtfyEnabled) {
        remoteManager.connectNtfyStream();
      }
      if (body.sshHosts) {
        remoteManager.resetSshBackoff();
        remoteManager.pollAllSshHosts(true);
      }
      if (typeof onConfigChange === 'function') {
        onConfigChange(config);
      }

      refreshSnapshot(true);
      sendJson(res, 200, { ok: true, config }, req);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/window/control') {
      const body = await parseJsonBody(req);
      let result = { ok: true };
      if (typeof onWindowControl === 'function') {
        result = (await onWindowControl(body)) || { ok: true };
      }
      sendJson(res, 200, result, req);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/admin/handover') {
      if (!hasValidToken) {
        sendJson(res, 401, { ok: false, requiresAuth: true, error: 'Token requerido para handover' }, req);
        return;
      }
      sendJson(res, 200, { ok: true, standalone: require.main === module }, req);
      if (require.main === module) {
        setTimeout(() => {
          stop();
          process.exit(0);
        }, 120);
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/manifest.json') {
      const startToken = hasValidToken
        ? reqToken
        : isLocalLoopback
          ? config.remoteAuthToken || ''
          : '';
      const startUrl = startToken
        ? `/?mode=web&token=${encodeURIComponent(startToken)}`
        : '/?mode=web';
      sendJson(
        res,
        200,
        {
          name: 'AI Pulse — Claude & Antigravity Remote',
          short_name: 'AI Pulse',
          description:
            'Monitor en vivo, widget compacto y respuesta remota para consolas Claude Code y Antigravity (AGY)',
          start_url: startUrl,
          display: 'standalone',
          background_color: '#070504',
          theme_color: '#ff6b1a',
          orientation: 'portrait-primary',
          icons: [
            {
              src: '/icon.svg',
              sizes: 'any',
              type: 'image/svg+xml',
              purpose: 'any maskable'
            }
          ]
        },
        req,
        cookieHeaders
      );
      return;
    }

    // Servir archivos estáticos del frontend con protección de Path Traversal
    const safeRelPath = pathname === '/' ? 'index.html' : pathname.replace(/^[/\\]+/, '');
    const filePath = path.resolve(PUBLIC_DIR, safeRelPath);
    const publicRootWithSep = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : PUBLIC_DIR + path.sep;
    if (filePath !== PUBLIC_DIR && !filePath.startsWith(publicRootWithSep)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // Nunca se sirven dotfiles, config*.json ni APK desde la raíz estática
    const baseName = path.basename(filePath);
    const hiddenSegment = safeRelPath.split(/[\\/]/).some((seg) => seg.startsWith('.'));
    if (hiddenSegment || /^config.*\.json$/i.test(baseName) || /\.apk$/i.test(baseName)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.apk': 'application/vnd.android.package-archive'
      };
      const extraStaticHeaders =
        ext === '.apk'
          ? { 'Content-Disposition': 'attachment; filename="AI-Pulse.apk"', 'Cache-Control': 'no-cache' }
          : ext === '.html' || ext === '.css' || ext === '.js'
            ? { 'Cache-Control': 'no-cache, must-revalidate' }
            : {};
      res.writeHead(200, {
        'Content-Type': mimeMap[ext] || 'application/octet-stream',
        ...extraStaticHeaders,
        ...cookieHeaders
      });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  }

  let pollTimer = null;
  const bindHost = config.bindHost || '127.0.0.1';

  function start() {
    processCounter.start();
    return new Promise((resolve, reject) => {
      refreshSnapshot();
      remoteManager.start();
      if (config.tunnelEnabled) {
        tunnelManager.start();
      }

      pollTimer = setInterval(() => {
        try {
          const windowVisible = typeof isRendererVisible === 'function' ? isRendererVisible() : true;
          const hasExternalClients = sseClients.size > 1;
          const hasActiveClients = sseClients.size > 0 && (windowVisible || hasExternalClients);
          const runningCount =
            (latestSnapshot && latestSnapshot.summary && latestSnapshot.summary.running) || 0;
          const intervalMs =
            !hasActiveClients && unreadAlerts.size === 0
              ? 10000
              : runningCount > 0 || hasExternalClients
                ? 2500
                : 4500;
          if (Date.now() - lastPollAt >= intervalMs - 100) {
            refreshSnapshot();
          }
        } catch {}
      }, 2500);

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          const reqHandover = http.request(
            {
              hostname: '127.0.0.1',
              port: config.port,
              path: '/api/admin/handover',
              method: 'POST',
              headers: { Authorization: `Bearer ${config.remoteAuthToken || ''}` },
              timeout: 1000
            },
            () => {
              setTimeout(() => {
                try {
                  server.listen(config.port, bindHost, () => {
                    resolve({ port: config.port, alreadyRunning: false, config });
                  });
                } catch {
                  resolve({ port: config.port, alreadyRunning: true, config });
                }
              }, 350);
            }
          );
          reqHandover.on('error', () => {
            resolve({ port: config.port, alreadyRunning: true, config });
          });
          reqHandover.end();
        } else {
          reject(err);
        }
      });

      server.listen(config.port, bindHost, () => {
        resolve({ port: config.port, alreadyRunning: false, config });
      });
    });
  }

  function stop() {
    processCounter.stop();
    if (pollTimer) clearInterval(pollTimer);
    remoteManager.stop();
    tunnelManager.stop();
    try {
      server.close();
    } catch {}
  }

  return {
    start,
    stop,
    getSnapshot: () => latestSnapshot || refreshSnapshot(),
    forceBroadcast: () => refreshSnapshot(true),
    getConfig: () => config,
    updateConfig: (partial) => {
      if (partial && typeof partial === 'object') {
        Object.assign(config, partial);
        saveConfig(config);
      }
      return config;
    }
  };
}

// Permite ejecutar node src/server.js directamente como modo servidor standalone
if (require.main === module) {
  const instance = createWidgetServer();
  instance.start().then(({ port }) => {
    console.log(`[AI Pulse Widget Server] Activo en http://localhost:${port}`);
  });
}

module.exports = {
  createWidgetServer
};
