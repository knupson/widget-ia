const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { collectAgyData } = require('./collectors/agyCollector');
const { collectClaudeData } = require('./collectors/claudeCollector');
const { RemoteManager } = require('./collectors/remoteManager');
const { getHooksStatus, setClaudeHookEnabled, setAgyHookEnabled } = require('./services/hooksManager');
const { focusSessionWindow } = require('./services/windowFocuser');

const CONFIG_PATH = path.resolve(__dirname, '..', 'config.json');
const PUBLIC_DIR = path.resolve(__dirname, 'public');

function loadConfig() {
  const defaultTopic = `ai-pulse-${crypto.randomBytes(5).toString('hex')}`;
  const defaults = {
    port: 19876,
    soundEnabled: true,
    soundTone: 'chime',
    desktopNotifications: true,
    alwaysOnTop: true,
    opacity: 0.96,
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
    if (!merged.ntfyTopic) merged.ntfyTopic = defaultTopic;
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

function getLast7DaysKeys() {
  const days = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    days.push(d.toISOString().slice(0, 10));
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

function createWidgetServer({ onAlert, onConfigChange, onWindowControl } = {}) {
  const config = loadConfig();
  const sseClients = new Set();
  const hookOverrides = new Map(); // sessionId -> { state, message, timestamp }
  const prevStates = new Map(); // session.id -> state
  const unreadAlerts = new Set(); // session.id con alerta pendiente de leer
  const recentAlerts = []; // últimas 25 alertas

  let latestSnapshot = null;

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
      refreshSnapshot();
    }
  });

  function triggerAlert(session, alertType, customMessage) {
    unreadAlerts.add(session.id);
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

    unreadAlerts.add(alertObj.sessionId);
    recentAlerts.unshift(alertObj);
    if (recentAlerts.length > 25) recentAlerts.length = 25;

    broadcastSse('alert', alertObj);
    if (typeof onAlert === 'function') {
      onAlert(alertObj, config);
    }
    return alertObj;
  }

  function buildAnalytics(agyData, claudeData, allSessions) {
    const dayKeys = getLast7DaysKeys();
    const todayKey = dayKeys[dayKeys.length - 1];

    const timeline = dayKeys.map((day) => {
      const agyDay = agyData.dailyTokens[day] || createZeroTokenBucket();
      const claudeDay = claudeData.dailyTokens[day] || createZeroTokenBucket();
      return {
        date: day,
        label: day.slice(5), // MM-DD
        agy: agyDay,
        claude: claudeDay,
        totalTokens: (agyDay.total || 0) + (claudeDay.total || 0),
        effectiveTokens: (agyDay.effective || 0) + (claudeDay.effective || 0)
      };
    });

    const weekly = {
      agy: createZeroTokenBucket(),
      claude: createZeroTokenBucket(),
      combined: createZeroTokenBucket()
    };

    for (const item of timeline) {
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
      agy: todayEntry.agy,
      claude: todayEntry.claude,
      combined: addTokenBucket(addTokenBucket(createZeroTokenBucket(), todayEntry.agy), todayEntry.claude)
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

  function refreshSnapshot() {
    const agyData = collectAgyData(config);
    const claudeData = collectClaudeData(hookOverrides);
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

    const allSessions = [...claudeData.sessions, ...agyData.sessions, ...remoteSessions];

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

    const analytics = buildAnalytics(agyData, claudeData, allSessions);

    latestSnapshot = {
      timestamp: Date.now(),
      summary,
      sessions: allSessions,
      planQuota: claudeData.planQuota,
      agyQuota: agyData.agyQuota,
      analytics,
      hooksStatus: getHooksStatus(),
      remoteSetup: {
        ...remoteManager.getRemoteSetupSnippets(config.port),
        ntfyConnected: remoteManager.ntfyConnected
      },
      config,
      recentAlerts
    };

    broadcastSse('state', latestSnapshot);
    return latestSnapshot;
  }

  function broadcastSse(eventName, data) {
    const msg = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(msg);
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
      refreshSnapshot();
      const targetSession =
        latestSnapshot &&
        latestSnapshot.sessions.find((s) => s.sessionId === sessId || s.id === `claude:${sessId}`);
      if (targetSession) {
        triggerAlert(targetSession, newState, msg);
      }
    } else if (provider === 'agy' || p.conversationId) {
      refreshSnapshot();
      const convId = p.conversationId;
      const targetSession =
        latestSnapshot &&
        latestSnapshot.sessions.find((s) => s.sessionId === convId || s.id === `agy:${convId}`);
      if (targetSession) {
        triggerAlert(targetSession, 'waiting_input', p.lastUserInput ? `Finalizó: ${p.lastUserInput}` : '');
      }
    }
  }

  function parseJsonBody(req) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString('utf8');
        if (body.length > 1024 * 256) req.destroy();
      });
      req.on('end', () => {
        try {
          resolve(body.trim() ? JSON.parse(body) : {});
        } catch {
          resolve({});
        }
      });
      req.on('error', () => resolve({}));
    });
  }

  function sendJson(res, statusCode, obj) {
    const payload = JSON.stringify(obj);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(payload);
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }

    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;

    if (req.method === 'GET' && pathname === '/api/state') {
      if (!latestSnapshot) refreshSnapshot();
      sendJson(res, 200, latestSnapshot);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write(`event: state\ndata: ${JSON.stringify(latestSnapshot || refreshSnapshot())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
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
      refreshSnapshot();
      sendJson(res, 200, { ok: true, session: sess });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/remote/test') {
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
      refreshSnapshot();
      sendJson(res, 200, { ok: true, session: sess });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/remote/remove') {
      const body = await parseJsonBody(req);
      if (body.id) {
        remoteManager.removeRemoteSession(body.id);
        unreadAlerts.delete(body.id);
        refreshSnapshot();
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
      refreshSnapshot();
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
      refreshSnapshot();
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
      refreshSnapshot();
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
        refreshSnapshot();
        sendJson(res, 200, { ok: true, hooksStatus: getHooksStatus() });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/config') {
      const body = await parseJsonBody(req);
      const prevTopic = config.ntfyTopic;
      const prevNtfyEnabled = config.ntfyEnabled;

      Object.assign(config, body);
      saveConfig(config);

      if (config.ntfyTopic !== prevTopic || config.ntfyEnabled !== prevNtfyEnabled) {
        remoteManager.connectNtfyStream();
      }
      if (body.sshHosts) {
        remoteManager.pollAllSshHosts();
      }
      if (typeof onConfigChange === 'function') {
        onConfigChange(config);
      }

      refreshSnapshot();
      sendJson(res, 200, { ok: true, config });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/window/control') {
      const body = await parseJsonBody(req);
      let result = { ok: true };
      if (typeof onWindowControl === 'function') {
        result = (await onWindowControl(body)) || { ok: true };
      }
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/admin/handover') {
      sendJson(res, 200, { ok: true, standalone: require.main === module });
      if (require.main === module) {
        setTimeout(() => {
          stop();
          process.exit(0);
        }, 120);
      }
      return;
    }

    // Servir archivos estáticos del frontend
    let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml'
      };
      res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  let pollTimer = null;

  function start() {
    return new Promise((resolve, reject) => {
      refreshSnapshot();
      remoteManager.start();

      pollTimer = setInterval(() => {
        try {
          refreshSnapshot();
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
              timeout: 1000
            },
            () => {
              setTimeout(() => {
                try {
                  server.listen(config.port, '0.0.0.0', () => {
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

      server.listen(config.port, '0.0.0.0', () => {
        resolve({ port: config.port, alreadyRunning: false, config });
      });
    });
  }

  function stop() {
    if (pollTimer) clearInterval(pollTimer);
    remoteManager.stop();
    try {
      server.close();
    } catch {}
  }

  return {
    start,
    stop,
    getSnapshot: () => latestSnapshot || refreshSnapshot(),
    getConfig: () => config
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
