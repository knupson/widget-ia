const https = require('https');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

class RemoteManager {
  constructor({ config, saveConfig, onRemoteEvent, onRemoteReplyCommand }) {
    this.config = config;
    this.saveConfig = saveConfig;
    this.onRemoteEvent = onRemoteEvent;
    this.onRemoteReplyCommand = onRemoteReplyCommand;

    // Mapa de sesiones remotas: id -> sessionObject
    this.remoteSessions = new Map();

    // Estado del stream ntfy.sh y backoff exponencial por host SSH
    this.ntfyReq = null;
    this.ntfyConnected = false;
    this.ntfyReconnectTimer = null;
    this.sshPollTimer = null;
    this.sshBackoff = new Map(); // target -> { failures, nextCheckAt, inFlight }
    this.networkAddrCache = { checkedAt: 0, list: [] };
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
                const tags = Array.isArray(evt.tags) ? evt.tags : [];
                if (tags.includes('ai_pulse_outbound') || evt.title === 'AI Pulse 4G Listo') {
                  continue;
                }
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
                if (payload && payload.__fromAiPulseServer) continue;
                if (payload && payload.type === 'remote_reply' && typeof this.onRemoteReplyCommand === 'function') {
                  this.onRemoteReplyCommand(payload);
                  continue;
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

    const updatedAt = Number(payload.updatedAt) || Date.now();
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
      updatedAt,
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
        effective: effTok,
        turns: Number(payload.turns || (existing ? existing.turns : 1))
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

  pollAllSshHosts(force = false) {
    const hosts = Array.isArray(this.config.sshHosts) ? this.config.sshHosts : [];
    for (const h of hosts) {
      if (!h || !h.enabled || !h.target) continue;
      this.pollSingleSshHost(h, force);
    }
  }

  resetSshBackoff(target = null) {
    if (target) {
      this.sshBackoff.delete(String(target).trim());
    } else {
      this.sshBackoff.clear();
    }
  }

  pollSingleSshHost(hostCfg, force = false) {
    const target = String(hostCfg.target || '').trim(); // ej. user@192.168.1.50
    // Prevenir inyección de opciones en OpenSSH (ej. targets que inicien con '-')
    if (!target || target.startsWith('-') || !/^[a-zA-Z0-9._-]+(@[a-zA-Z0-9._-]+)?$/.test(target)) {
      hostCfg.lastStatus = 'error';
      hostCfg.lastError = 'Formato de host/usuario SSH inválido';
      return;
    }

    const now = Date.now();
    const bState = this.sshBackoff.get(target) || { failures: 0, nextCheckAt: 0, inFlight: false };
    if (bState.inFlight) return;
    if (!force && bState.nextCheckAt > now) return;

    bState.inFlight = true;
    this.sshBackoff.set(target, bState);

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
    // Script POSIX codificado en Base64 para compatibilidad total con cualquier login shell remoto (fish, bash, zsh, sh)
    // Inspecciona tanto sesiones de Claude (~/.claude/sessions) como de Antigravity CLI (~/.gemini/antigravity-cli/brain)
    const posixProbeScript = `
if command -v python3 >/dev/null 2>&1; then
  python3 - << 'PYEOF'
import os, glob, json, time, socket, subprocess, re

host = socket.gethostname()
now = time.time()

running_procs = ""
try:
    running_procs = subprocess.check_output(["ps", "-u", str(os.getuid()), "-o", "pid=,comm=,args="], text=True, stderr=subprocess.DEVNULL)
except Exception:
    pass

has_agy_proc = bool(re.search(r"\\b(agy|antigravity|jetski)\\b", running_procs, re.I))

for f in glob.glob(os.path.expanduser("~/.claude/sessions/*.json")):
    try:
        mtime = os.path.getmtime(f)
        if now - mtime > 86400:
            continue
        with open(f, "r", encoding="utf-8", errors="ignore") as fp:
            data = json.load(fp)
        pid = int(data.get("pid") or 0)
        alive = False
        if pid > 0:
            try:
                os.kill(pid, 0)
                alive = True
            except Exception:
                alive = False
        st = "closed"
        if alive:
            st = "waiting_input" if data.get("status") == "idle" else "running"
        print(json.dumps({
            "__host": host,
            "provider": "claude",
            "sessionId": str(data.get("sessionId") or pid or os.path.basename(f)),
            "title": data.get("name") or "Sesión Claude SSH",
            "cwd": data.get("cwd") or "",
            "state": st,
            "updatedAt": int(mtime * 1000)
        }))
    except Exception:
        pass

brain_dirs = glob.glob(os.path.expanduser("~/.gemini/antigravity-cli/brain/*"))
brain_dirs.sort(key=lambda p: os.path.getmtime(p) if os.path.exists(p) else 0, reverse=True)
for idx, d in enumerate(brain_dirs[:10]):
    tf = os.path.join(d, ".system_generated", "logs", "transcript.jsonl")
    if not os.path.isfile(tf):
        continue
    try:
        mtime = os.path.getmtime(tf)
        if now - mtime > 86400:
            continue
        conv_id = os.path.basename(d)
        in_tok = cr_tok = cw_tok = out_tok = turns = 0
        title = ""
        last_msg = ""
        last_type = ""
        last_status = ""
        with open(tf, "r", encoding="utf-8", errors="ignore") as fp:
            for line in fp:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                t = obj.get("type") or ""
                last_type = t
                last_status = obj.get("status") or ""
                if t == "USER_INPUT":
                    turns += 1
                    if not title:
                        raw = str(obj.get("content") or "")
                        m = re.search(r"<USER_REQUEST>\\s*([\\s\\S]*?)\\s*</USER_REQUEST>", raw)
                        txt = (m.group(1) if m else raw).strip().splitlines()[0] if (m or raw.strip()) else ""
                        title = txt[:80]
                elif t == "PLANNER_RESPONSE":
                    in_tok += int(obj.get("input_tokens") or 0)
                    cr_tok += int(obj.get("cache_read_tokens") or 0)
                    cw_tok += int(obj.get("cache_creation_tokens") or 0)
                    out_tok += int(obj.get("output_tokens") or 0)
                    c = str(obj.get("content") or "").strip()
                    if c:
                        last_msg = c.splitlines()[0][:180]
        is_recent_active = (idx == 0 and has_agy_proc and (now - mtime < 1800)) or (now - mtime < 45)
        if is_recent_active:
            st = "waiting_input" if (last_type == "PLANNER_RESPONSE" and last_status == "DONE") else "running"
        else:
            st = "closed"
        print(json.dumps({
            "__host": host,
            "provider": "agy",
            "sessionId": conv_id,
            "title": title or f"AGY {conv_id[:8]}",
            "cwd": "",
            "state": st,
            "updatedAt": int(mtime * 1000),
            "turns": max(1, turns),
            "message": last_msg,
            "tokens": {
                "input": in_tok,
                "cacheRead": cr_tok,
                "cacheWrite": cw_tok,
                "output": out_tok
            }
        }))
    except Exception:
        pass
PYEOF
else
  if [ -d "$HOME/.claude/sessions" ]; then
    for f in "$HOME/.claude/sessions"/*.json; do
      [ -e "$f" ] || continue
      cat "$f" 2>/dev/null | tr -d '\\n\\r'
      echo ""
    done
  fi
fi
`.trim();
    const b64Script = Buffer.from(posixProbeScript, 'utf8').toString('base64');
    const remoteCmd = `echo ${b64Script} | base64 -d | /bin/sh`;

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

    execFile('ssh', args, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      bState.inFlight = false;
      const doneAt = Date.now();
      if (err) {
        bState.failures = (bState.failures || 0) + 1;
        // Backoff exponencial: <2 fallos -> 20s, 2 -> 60s, 3 -> 180s, >=4 -> 300s (5 min)
        let delayMs = 20000;
        if (bState.failures === 2) delayMs = 60000;
        else if (bState.failures === 3) delayMs = 180000;
        else if (bState.failures >= 4) delayMs = 300000;

        bState.nextCheckAt = doneAt + delayMs;
        this.sshBackoff.set(target, bState);

        const cleanStderr = String(stderr || '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .pop();
        hostCfg.lastStatus = 'error';
        hostCfg.lastError = (cleanStderr || err.message || 'Error de conexión SSH').slice(0, 160);
        hostCfg.nextRetryAt = bState.nextCheckAt;
        if (typeof this.saveConfig === 'function') this.saveConfig();
        return;
      }

      bState.failures = 0;
      bState.nextCheckAt = doneAt + 20000;
      this.sshBackoff.set(target, bState);

      hostCfg.lastStatus = 'ok';
      hostCfg.lastError = '';
      hostCfg.lastCheckedAt = doneAt;
      hostCfg.nextRetryAt = null;
      if (typeof this.saveConfig === 'function') this.saveConfig();

      const lines = String(stdout || '').split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const obj = JSON.parse(line.trim());
          const hostName = hostCfg.label || obj.__host || target;
          const isAgy = obj.provider === 'agy';
          this.ingestRemotePayload(
            {
              host: hostName,
              provider: isAgy ? 'agy' : 'claude',
              sessionId: obj.sessionId || String(obj.pid || 'ssh'),
              title: obj.title || obj.name || (isAgy ? 'Sesión AGY SSH' : 'Sesión Claude SSH'),
              projectName: hostName,
              cwd: obj.cwd || `ssh://${target}`,
              state: obj.state || (obj.status === 'idle' ? 'waiting_input' : 'running'),
              updatedAt: obj.updatedAt || doneAt,
              turns: obj.turns || 1,
              message: obj.message || `Monitoreado por SSH (${target})`,
              tokens: obj.tokens || undefined
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
    const now = Date.now();
    if (this.networkAddrCache.list.length > 0 && now - this.networkAddrCache.checkedAt < 60000) {
      return this.networkAddrCache.list;
    }
    const nets = os.networkInterfaces();
    const results = [];
    for (const [name, addrs] of Object.entries(nets)) {
      for (const addr of addrs || []) {
        if (addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.')) {
          const lowerName = name.toLowerCase();
          const isVirtual =
            lowerName.includes('vethernet') ||
            lowerName.includes('wsl') ||
            lowerName.includes('docker') ||
            lowerName.includes('hyper-v') ||
            lowerName.includes('virtual') ||
            lowerName.includes('vbox') ||
            lowerName.includes('vmware');
          const isLan192 = addr.address.startsWith('192.168.');
          const isLan10 = addr.address.startsWith('10.');
          const priority = isVirtual ? 3 : isLan192 ? 0 : isLan10 ? 1 : 2;
          results.push({ interface: name, address: addr.address, priority });
        }
      }
    }
    results.sort((a, b) => a.priority - b.priority);
    this.networkAddrCache = { checkedAt: now, list: results };
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

  /**
   * Envía notificación push saliente por ntfy.sh al celular cuando una consola local termina o pide permiso
   */
  sendOutboundAlertPush(alertObj, mobileBaseUrl, authToken) {
    if (!alertObj || alertObj.isRemote) return;
    if (this.config.ntfyEnabled === false || !this.config.ntfyTopic) return;
    if (this.config.ntfyPushLocalAlerts === false) return;

    const topic = (this.config.ntfyTopic || '').trim();
    if (!topic) return;

    const isApproval = alertObj.alertType === 'waiting_approval';
    const isBonus = alertObj.alertType === 'quota_reset';
    const titlePrefix = isBonus ? '🎁 Cuota' : isApproval ? '⚠️ Permiso' : '✅ Lista';
    const rawTitle = `${titlePrefix} [${alertObj.providerLabel || alertObj.provider}] ${alertObj.projectName || ''}`.trim();
    // Header HTTP debe ser ASCII seguro
    const safeAsciiTitle = rawTitle.replace(/[^\x20-\x7E]/g, '').trim() || 'AI Pulse Alert';

    const headers = {
      Title: safeAsciiTitle,
      Priority: isApproval ? 'high' : 'default',
      Tags: `${isApproval ? 'warning' : 'white_check_mark'},ai_pulse_outbound`
    };

    if (mobileBaseUrl) {
      const clickUrl = `${mobileBaseUrl}/?session=${encodeURIComponent(alertObj.sessionId || '')}${
        authToken ? `&token=${encodeURIComponent(authToken)}` : ''
      }`;
      headers.Click = clickUrl;
    }

    const bodyText = `${rawTitle}\n${alertObj.title || ''}\n${alertObj.message || ''}`.trim();

    try {
      const req = https.request(
        `https://ntfy.sh/${encodeURIComponent(topic)}`,
        {
          method: 'POST',
          headers
        },
        (res) => res.resume()
      );
      req.on('error', () => {});
      req.write(bodyText);
      req.end();
    } catch {}
  }
}

module.exports = {
  RemoteManager
};
