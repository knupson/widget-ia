const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createInterface } = require('readline');

const REQUEST_TIMEOUT = 8000;
let snapshot = null;
let child = null;
let restartTimer = null;
let pollTimer = null;
let backoff = 1000;
let started = false;
let stopped = false;

function launchCommand() {
  if (process.platform !== 'win32') return ['codex', ['app-server']];
  // El shim npm .cmd no se puede ejecutar directamente con spawn en Windows.
  const directories = (process.env.PATH || '').split(path.delimiter).map((dir) => dir.replace(/^"|"$/g, ''));
  if (process.env.APPDATA) directories.push(path.join(process.env.APPDATA, 'npm'));
  if (process.env.LOCALAPPDATA) directories.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin'));
  for (const dir of directories.filter(Boolean)) {
    const executable = path.join(dir, 'codex.exe');
    if (fs.existsSync(executable)) return [executable, ['app-server']];
    const entry = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(entry)) return [process.execPath, [entry, 'app-server']];
  }
  return ['cmd.exe', ['/d', '/s', '/c', 'codex', 'app-server']];
}

function killChild(server) {
  if (!server || !server.pid) return;
  // Incluye al binario nativo si el proceso padre es el wrapper npm o cmd.exe.
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(server.pid), '/t', '/f'], {
      windowsHide: true, shell: false, stdio: 'ignore', timeout: 1500
    });
  }
  server.kill();
}

function connect() {
  if (stopped || child) return;
  let server;
  try {
    const [command, args] = launchCommand();
    server = spawn(command, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    scheduleRestart();
    return;
  }
  child = server;
  let failed = false;
  let ready = false;
  let reading = false;
  let nextId = 1;
  const pending = new Map();
  const lines = createInterface({ input: server.stdout });
  server.unref();
  for (const stream of [server.stdin, server.stdout]) stream.unref?.();

  function fail(terminate = true) {
    if (failed) return;
    failed = true;
    ready = false;
    clearInterval(pollTimer);
    pollTimer = null;
    lines.close();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Se desconectó Codex app-server'));
    }
    pending.clear();
    // No reiniciar hasta que el proceso anterior haya cerrado.
    if (terminate) killChild(server);
  }

  function send(message) {
    server.stdin.write(`${JSON.stringify(message)}\n`, (error) => { if (error) fail(); });
  }

  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(fail, REQUEST_TIMEOUT);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      try { send({ id, method, params }); } catch { fail(); }
    });
  }

  async function readLimits() {
    if (!ready || reading || failed) return;
    reading = true;
    try {
      const result = await request('account/rateLimits/read', { excludeResetCreditDetails: true });
      const limits = result?.rateLimitsByLimitId?.codex || result?.rateLimits;
      if (!limits || typeof limits !== 'object') throw new Error('Respuesta de cuota inválida');
      snapshot = { limits, fetchedAt: Date.now() };
      backoff = 1000;
    } catch { fail(); } finally { reading = false; }
  }

  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== 'object') return;
    const waiting = pending.get(message.id);
    if (waiting) {
      clearTimeout(waiting.timer);
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error('Codex rechazó la consulta'));
      else waiting.resolve(message.result);
    } else if (message.method === 'account/rateLimitsUpdated' || message.method === 'account/rateLimits/updated') {
      void readLimits();
    }
  });
  server.on('error', fail);
  server.stdin.on('error', fail);
  server.stdout.on('error', fail);
  server.on('close', () => {
    fail(false);
    if (child === server) child = null;
    scheduleRestart();
  });

  void (async () => {
    try {
      await request('initialize', { clientInfo: { name: 'ai-pulse-widget', title: 'AI Pulse', version: '0.0.1' } });
      if (failed) return;
      send({ method: 'initialized' });
      ready = true;
      pollTimer = setInterval(() => { void readLimits(); }, 60000);
      pollTimer.unref();
      await readLimits();
    } catch { fail(); }
  })();
}

function scheduleRestart() {
  if (stopped || restartTimer) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    connect();
  }, backoff);
  restartTimer.unref();
  backoff = Math.min(backoff * 2, 60000);
}

function stop() {
  stopped = true;
  clearTimeout(restartTimer);
  clearInterval(pollTimer);
  killChild(child);
}

function getRateLimitsSnapshot() {
  if (!started) {
    started = true;
    process.once('exit', stop);
    process.once('SIGINT', () => process.exit(130));
    process.once('SIGTERM', () => process.exit(143));
    connect();
  }
  return snapshot;
}

module.exports = { getRateLimitsSnapshot };
