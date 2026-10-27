const https = require('https');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

class RemoteManager {
  constructor({ config, saveConfig, onRemoteEvent }) {
    this.config = config;
    this.saveConfig = saveConfig;
    this.onRemoteEvent = onRemoteEvent;

    // Mapa de sesiones remotas: id -> sessionObject
    this.remoteSessions = new Map();

    // Estado del stream ntfy.sh
    this.ntfyReq = null;
    this.ntfyConnected = false;
    this.ntfyReconnectTimer = null;
    this.sshPollTimer = null;
  }

  start() {
    if (this.config.ntfyEnabled !== false && this.config.ntfyTopic) {
      this.connectNtfyStream();
    }
    this.startSshPoller();
  }

  stop() {
    this.disconnectNtfyStream();
    if (this.sshPollTimer) {
      clearInterval(this.sshPollTimer);
      this.sshPollTimer = null;
    }
  }

  /**
   * Conecta al canal pub/sub gratuito ntfy.sh por HTTPS streaming (NDJSON)
   * Permite recibir eventos de CLIs remotos sin abrir puertos ni requerir SSH
   */
  connectNtfyStream() {
    this.disconnectNtfyStream();
    const topic = (this.config.ntfyTopic || '').trim();
    if (!topic || this.config.ntfyEnabled === false) return;

    const url = `https://ntfy.sh/${encodeURIComponent(topic)}/json`;
    try {
      const req = https.get(url, { headers: { Accept: 'application/x-ndjson' } }, (res) => {
        if (res.statusCode !== 200) {
          this.ntfyConnected = false;
          this.scheduleNtfyReconnect();
          return;
        }
        this.ntfyConnected = true;
        let buffer = '';

        res.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const evt = JSON.parse(line);
              if (evt.event === 'message' && evt.message) {
                let payload;
                try {
                  payload = JSON.parse(evt.message);
                } catch {
                  payload = {
                    host: evt.title || 'CLI Remoto',
                    state: 'waiting_input',
                    message: evt.message
                  };
                }
                this.ingestRemotePayload(payload, 'ntfy');
              }
            } catch {}
          }
        });

        res.on('end', () => {
          this.ntfyConnected = false;
          this.scheduleNtfyReconnect();
        });

        res.on('error', () => {
          this.ntfyConnected = false;
          this.scheduleNtfyReconnect();
        });
      });

      req.on('error', () => {
        this.ntfyConnected = false;
        this.scheduleNtfyReconnect();
      });

      this.ntfyReq = req;
    } catch {
      this.ntfyConnected = false;
      this.scheduleNtfyReconnect();
    }
  }

  disconnectNtfyStream() {
    if (this.ntfyReconnectTimer) {
      clearTimeout(this.ntfyReconnectTimer);
      this.ntfyReconnectTimer = null;
    }
    if (this.ntfyReq) {
      try {
        this.ntfyReq.destroy();
      } catch {}
      this.ntfyReq = null;
    }
    this.ntfyConnected = false;
  }

  scheduleNtfyReconnect() {
    if (this.ntfyReconnectTimer) return;
    if (this.config.ntfyEnabled === false) return;
    this.ntfyReconnectTimer = setTimeout(() => {
      this.ntfyReconnectTimer = null;
      this.connectNtfyStream();
    }, 8000);
  }

  /**
   * Procesa un reporte remoto entrante (por Webhook HTTP directo, Relay ntfy.sh o Sondeo SSH)
   */
  ingestRemotePayload(payload, transport = 'http') {
    if (!payload || typeof payload !== 'object') return null;

    const host = String(payload.host || payload.hostname || 'remoto').trim();
    const provider = String(payload.provider || 'claude').toLowerCase();
    const rawSessionId = String(payload.sessionId || payload.id || payload.project || 'default').trim();
    const fullId = `remote:${host}:${provider}:${rawSessionId}`;

    // Mapear evento o estado
    let state = payload.state || 'waiting_input';
    if (payload.event === 'Stop' || payload.event === 'SubagentStop' || state === 'idle') {
      state = 'waiting_input';
    } else if (
      payload.event === 'Notification' ||
      payload.notificationType === 'permission_prompt' ||
      state === 'permission'
    ) {
      state = 'waiting_approval';
    } else if (
      payload.event === 'PreToolUse' ||
      payload.event === 'PostToolUse' ||
      payload.event === 'PreInvocation' ||
      state === 'running' ||
      state === 'working'
    ) {
      state = 'running';
    }

    const existing = this.remoteSessions.get(fullId);
    const workspace = String(payload.cwd || payload.workspace || (existing && existing.workspace) || '');
    const projectName =
      payload.projectName ||
      (workspace ? workspace.split(/[\\/]/).filter(Boolean).pop() : '') ||
      (existing && existing.projectName) ||
      host;

    const title =
      payload.title ||
      payload.name ||
      (existing && existing.title) ||
      `${provider.toUpperCase()} @ ${host}`;

    const inTok = Number((payload.tokens && payload.tokens.input) || payload.inputTokens || (existing && existing.tokens.input) || 0);
    const crTok = Number((payload.tokens && payload.tokens.cacheRead) || payload.cacheReadTokens || (existing && existing.tokens.cacheRead) || 0);
    const cwTok = Number((payload.tokens && payload.tokens.cacheWrite) || payload.cacheWriteTokens || (existing && existing.tokens.cacheWrite) || 0);
    const outTok = Number((payload.tokens && payload.tokens.output) || payload.outputTokens || (existing && existing.tokens.output) || 0);
    const totalTok = Number(
      (payload.tokens && payload.tokens.total) ||
      payload.totalTokens ||
      inTok + crTok + cwTok + outTok
    );
    const effTok = Math.round(inTok + crTok * 0.1 + cwTok * 2 + outTok * 5);

    const sessionObj = {
      id: fullId,
      sessionId: rawSessionId,
      provider: provider === 'agy' ? 'agy' : 'claude',
      providerLabel: `${provider === 'agy' ? 'AGY' : 'Claude'} Remoto (${host})`,
      surface: 'remote',
      transport, // 'ntfy' | 'http' | 'ssh'
      remoteHost: host,
      isOpen: state !== 'closed',
      isRemote: true,
      isSubagent: false,
      state, // 'running' | 'waiting_approval' | 'waiting_input' | 'closed'
      title,
      projectName,
      workspace,
      updatedAt: Date.now(),
      turns: Number(payload.turns || (existing ? existing.turns + 1 : 1)),
      lastMessage: String(
        payload.message ||
        payload.lastMessage ||
        payload.last_assistant_message ||
        (existing && existing.lastMessage) ||
        ''
      ).slice(0, 260),
      currentAction: String(payload.currentAction || '').slice(0, 120),
      tokens: {
        input: inTok,
        cacheRead: crTok,
        cacheWrite: cwTok,
        output: outTok,
        total: totalTok,
        effective: effTok
      }
    };

    this.remoteSessions.set(fullId, sessionObj);
    if (typeof this.onRemoteEvent === 'function') {
      this.onRemoteEvent(sessionObj, existing);
    }
    return sessionObj;
  }

  /**
   * Sondeo periódico opcional por SSH para servidores donde el usuario sí tiene acceso SSH
   */
  startSshPoller() {
    if (this.sshPollTimer) clearInterval(this.sshPollTimer);
    this.sshPollTimer = setInterval(() => {
      this.pollAllSshHosts();
    }, 20000);
    // Primer sondeo a los 3 segundos
    setTimeout(() => this.pollAllSshHosts(), 3000);
  }

  pollAllSshHosts() {
    const hosts = Array.isArray(this.config.sshHosts) ? this.config.sshHosts : [];
    for (const h of hosts) {
      if (!h || !h.enabled || !h.target) continue;
      this.pollSingleSshHost(h);
    }
  }

  pollSingleSshHost(hostCfg) {
    const target = String(hostCfg.target || '').trim(); // ej. user@192.168.1.50
    // Prevenir inyección de opciones en OpenSSH (ej. targets que inicien con '-')
    if (!target || target.startsWith('-') || !/^[a-zA-Z0-9._-]+(@[a-zA-Z0-9._-]+)?$/.test(target)) {
      hostCfg.lastStatus = 'error';
      hostCfg.lastError = 'Formato de host/usuario SSH inválido';
      return;
    }

    const portNum = Number(hostCfg.port);
    const portArg = Number.isInteger(portNum) && portNum > 0 && portNum <= 65535 ? ['-p', String(portNum)] : [];
    const keyArg = [];
    if (hostCfg.keyPath && String(hostCfg.keyPath).trim()) {
      let kp = String(hostCfg.keyPath).trim().replace(/^["']|["']$/g, '');
      if (kp.startsWith('~/') || kp.startsWith('~\\')) {
        kp = path.join(os.homedir(), kp.slice(2));
      }
      if (!kp.startsWith('-')) {
        keyArg.push('-i', kp);
      }
    }
    // Script bash compacto de solo lectura que inspecciona ~/.claude/sessions/*.json en el host remoto
    const remoteCmd = `
      HOST=$(hostname);
      if [ -d "$HOME/.claude/sessions" ]; then
        for f in "$HOME/.claude/sessions"/*.json; do
          [ -e "$f" ] || continue;
          cat "$f" 2>/dev/null | tr -d '\\n' | sed "s/}$/,\\"__host\\":\\"$HOST\\"}/";
          echo "";
        done
      fi
    `.trim();

    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      '-o', 'StrictHostKeyChecking=accept-new',
      ...portArg,
      ...keyArg,
      '--',
      target,
      remoteCmd
    ];

    execFile('ssh', args, { timeout: 8000 }, (err, stdout) => {
      if (err) {
        hostCfg.lastStatus = 'error';
        hostCfg.lastError = err.message.slice(0, 120);
        return;
      }
      hostCfg.lastStatus = 'ok';
      hostCfg.lastError = '';
      hostCfg.lastCheckedAt = Date.now();

      const lines = String(stdout || '').split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const obj = JSON.parse(line.trim());
          this.ingestRemotePayload(
            {
              host: hostCfg.label || obj.__host || target,
              provider: 'claude',
              sessionId: obj.sessionId || String(obj.pid),
              title: obj.name || 'Sesión SSH',
              cwd: obj.cwd || '',
              state: obj.status === 'idle' ? 'waiting_input' : 'running',
              message: `Monitoreado por SSH (${target})`
            },
            'ssh'
          );
        } catch {}
      }
    });
  }

  getActiveRemoteSessions() {
    const now = Date.now();
    const list = [];
    for (const [id, sess] of this.remoteSessions.entries()) {
      // Expirar sesiones remotas sin actividad en más de 12 horas
      if (now - sess.updatedAt > 12 * 60 * 60 * 1000) {
        this.remoteSessions.delete(id);
        continue;
      }
      list.push(sess);
    }
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  removeRemoteSession(id) {
    return this.remoteSessions.delete(id);
  }

  /**
   * Obtiene las IPs locales (LAN / Tailscale / VPN) para mostrar en el asistente de conexión remota
   */
  getLocalNetworkAddresses() {
    const nets = os.networkInterfaces();
    const results = [];
    for (const [name, addrs] of Object.entries(nets)) {
      for (const addr of addrs || []) {
        if (addr.family === 'IPv4' && !addr.internal) {
          results.push({ interface: name, address: addr.address });
        }
      }
    }
    return results;
  }

  /**
   * Genera los comandos listos para copiar y pegar en servidores remotos (Linux/macOS/Windows)
   * tanto para modo sin SSH (Relay ntfy.sh) como modo directo HTTP
   */
  getRemoteSetupSnippets(port) {
    const topic = this.config.ntfyTopic || 'ai-pulse-default';
    const ips = this.getLocalNetworkAddresses();
    const primaryIp = ips.length > 0 ? ips[0].address : 'TU_IP_LOCAL';
    const relayUrl = `https://ntfy.sh/${topic}`;
    const directUrl = `http://${primaryIp}:${port}/api/remote/report`;

    // 1. Comando Bash de 1 línea para Linux/macOS/WSL/Docker (vía Relay ntfy.sh - NO requiere SSH ni puertos)
    const bashRelayDaemon = `nohup bash -c 'while true; do H=$(hostname); for f in ~/.claude/sessions/*.json; do [ -f "$f" ] || continue; P=$(grep -o "\\"pid\\":[0-9]*" "$f" | cut -d: -f2); kill -0 "$P" 2>/dev/null || continue; S=$(grep -o "\\"status\\":\\"[^\\"]*\\"" "$f" | cut -d\\" -f4); N=$(grep -o "\\"name\\":\\"[^\\"]*\\"" "$f" | cut -d\\" -f4); C=$(grep -o "\\"cwd\\":\\"[^\\"]*\\"" "$f" | cut -d\\" -f4); ID=$(grep -o "\\"sessionId\\":\\"[^\\"]*\\"" "$f" | cut -d\\" -f4); ST="running"; [ "$S" = "idle" ] && ST="waiting_input"; curl -s -X POST "${relayUrl}" -d "{\\"host\\":\\"$H\\",\\"provider\\":\\"claude\\",\\"sessionId\\":\\"$ID\\",\\"title\\":\\"$N\\",\\"cwd\\":\\"$C\\",\\"state\\":\\"$ST\\"}" >/dev/null; done; sleep 5; done' >/dev/null 2>&1 &`;

    // 2. Comando PowerShell de 1 línea para Windows Remoto (RDP / VM sin SSH) vía Relay ntfy.sh
    const psRelayOneLiner = `Start-Job -ScriptBlock { while($true) { $h=$env:COMPUTERNAME; Get-ChildItem "$HOME\\.claude\\sessions\\*.json" -ErrorAction SilentlyContinue | ForEach-Object { $c=Get-Content $_.FullName -Raw | ConvertFrom-Json; if(Get-Process -Id $c.pid -ErrorAction SilentlyContinue){ $st=if($c.status -eq 'idle'){'waiting_input'}else{'running'}; $body=@{host=$h;provider='claude';sessionId=$c.sessionId;title=$c.name;cwd=$c.cwd;state=$st}|ConvertTo-Json -Compress; Invoke-RestMethod -Method Post -Uri '${relayUrl}' -Body $body | Out-Null } }; Start-Sleep 5 } }`;

    // 3. Hook para ~/.claude/settings.json en máquina remota (disparo instantáneo al terminar o pedir permiso)
    const claudeRemoteHookJson = JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `curl -s -X POST "${relayUrl}" -d "{\\"host\\":\\"$(hostname)\\",\\"provider\\":\\"claude\\",\\"event\\":\\"Stop\\",\\"state\\":\\"waiting_input\\",\\"cwd\\":\\"$PWD\\",\\"message\\":\\"Turno finalizado, esperando tu respuesta\\"}" >/dev/null 2>&1 || true`
                }
              ]
            }
          ],
          Notification: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `curl -s -X POST "${relayUrl}" -d "{\\"host\\":\\"$(hostname)\\",\\"provider\\":\\"claude\\",\\"event\\":\\"Notification\\",\\"state\\":\\"waiting_approval\\",\\"cwd\\":\\"$PWD\\",\\"message\\":\\"Claude remoto solicita permiso o atención\\"}" >/dev/null 2>&1 || true`
                }
              ]
            }
          ]
        }
      },
      null,
      2
    );

    return {
      topic,
      relayUrl,
      directUrl,
      localIps: ips,
      bashRelayDaemon,
      psRelayOneLiner,
      claudeRemoteHookJson
    };
  }
}

module.exports = {
  RemoteManager
};
