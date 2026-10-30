const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const BIN_DIR = path.resolve(__dirname, '..', '..', 'bin');
const LOCAL_CLOUDFLARED = path.join(BIN_DIR, 'cloudflared.exe');
const CLOUDFLARED_ASSET = 'cloudflared-windows-amd64.exe';
const CLOUDFLARED_DOWNLOAD_URL = `https://github.com/cloudflare/cloudflared/releases/latest/download/${CLOUDFLARED_ASSET}`;
// Solo se siguen redirects a estos hosts por https (GitHub Releases y su CDN de assets)
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
]);
const USER_AGENT = 'AI-Pulse-Widget/1.0';
// Rutas absolutas conocidas antes que la búsqueda por PATH (evita binarios plantados en PATH)
const KNOWN_INSTALL_PATHS = [
  LOCAL_CLOUDFLARED,
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'cloudflared', 'cloudflared.exe')
];

class TunnelManager {
  constructor({ config, saveConfig, onStateChange }) {
    this.config = config;
    this.saveConfig = saveConfig;
    this.onStateChange = onStateChange;

    this.proc = null;
    this.status = 'stopped'; // 'stopped' | 'downloading' | 'starting' | 'connected' | 'error'
    this.publicUrl = '';
    this.error = '';
    this.lastNotifiedUrl = '';
    this.cachedBinPath = null;
    this.lastLookupAt = 0; // cache negativa: no re-buscar cada getStatus() si no hay binario
    this.reconnectTimer = null;
    this.healthTimer = null;
    this.healthFailures = 0;
    this.ntfyRetryTimer = null;
  }

  resolveBinaryPath() {
    if (this.cachedBinPath && fs.existsSync(this.cachedBinPath)) {
      return this.cachedBinPath;
    }
    for (const candidate of KNOWN_INSTALL_PATHS) {
      if (fs.existsSync(candidate)) {
        this.cachedBinPath = candidate;
        return candidate;
      }
    }
    if (Date.now() - this.lastLookupAt < 60000) return null;
    this.lastLookupAt = Date.now();
    try {
      const out = execFileSync('where.exe', ['cloudflared'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
      });
      const first = String(out || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean);
      // Solo rutas absolutas llamadas cloudflared.exe
      if (
        first &&
        path.isAbsolute(first) &&
        path.basename(first).toLowerCase() === 'cloudflared.exe' &&
        fs.existsSync(first)
      ) {
        this.cachedBinPath = first;
        return first;
      }
    } catch {}
    return null;
  }

  /**
   * Obtiene el SHA256 publicado por GitHub para el asset de la última release (campo `digest` de la API).
   * Devuelve null si no está disponible: en ese caso la descarga NO se verifica (ver TODO en downloadBinary).
   */
  fetchPublishedSha256() {
    return new Promise((resolve) => {
      const req = https.get(
        'https://api.github.com/repos/cloudflare/cloudflared/releases/latest',
        {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
          timeout: 8000
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            resolve(null);
            return;
          }
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            raw += c;
            if (raw.length > 1024 * 1024) req.destroy();
          });
          res.on('end', () => {
            try {
              const json = JSON.parse(raw);
              const asset = (Array.isArray(json.assets) ? json.assets : []).find((a) => a && a.name === CLOUDFLARED_ASSET);
              const m = asset && typeof asset.digest === 'string' && asset.digest.match(/^sha256:([a-f0-9]{64})$/i);
              resolve(m ? m[1].toLowerCase() : null);
            } catch {
              resolve(null);
            }
          });
        }
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
    });
  }

  sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
  }

  /** Descarga a `dest` siguiendo redirects solo hacia hosts permitidos por https. */
  downloadTo(url, dest, redirects = 0) {
    return new Promise((resolve, reject) => {
      if (redirects > 6) {
        reject(new Error('Demasiadas redirecciones descargando cloudflared'));
        return;
      }
      let target;
      try {
        target = new URL(url);
      } catch {
        reject(new Error('URL de descarga inválida'));
        return;
      }
      if (target.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(target.hostname)) {
        reject(new Error(`Host de descarga no permitido: ${target.hostname}`));
        return;
      }

      const req = https.get(target, { headers: { 'User-Agent': USER_AGENT }, timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, target).toString();
          this.downloadTo(next, dest, redirects + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} al descargar cloudflared`));
          return;
        }

        const file = fs.createWriteStream(dest);
        res.pipe(file);
        res.on('error', (err) => {
          file.destroy();
          reject(err);
        });
        file.on('finish', () => file.close(() => resolve(dest)));
        file.on('error', (err) => {
          try {
            fs.unlinkSync(dest);
          } catch {}
          reject(err);
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout descargando cloudflared')));
      req.on('error', (err) => {
        try {
          if (fs.existsSync(dest)) fs.unlinkSync(dest);
        } catch {}
        reject(err);
      });
    });
  }

  async downloadBinary() {
    if (!fs.existsSync(BIN_DIR)) {
      fs.mkdirSync(BIN_DIR, { recursive: true });
    }
    const tmpPath = `${LOCAL_CLOUDFLARED}.tmp`;
    const expected = await this.fetchPublishedSha256();
    if (!expected) {
      // TODO: sin digest publicado no hay verificación; revisar si la API de GitHub deja de exponerlo
      console.warn('[tunnel] No se obtuvo SHA256 publicado para cloudflared: descarga SIN verificar');
    }
    await this.downloadTo(CLOUDFLARED_DOWNLOAD_URL, tmpPath);
    if (expected) {
      const actual = this.sha256File(tmpPath);
      if (actual !== expected) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {}
        throw new Error('El SHA256 de cloudflared descargado no coincide con el publicado por GitHub');
      }
    }
    if (fs.existsSync(LOCAL_CLOUDFLARED)) fs.unlinkSync(LOCAL_CLOUDFLARED);
    fs.renameSync(tmpPath, LOCAL_CLOUDFLARED);
    this.cachedBinPath = LOCAL_CLOUDFLARED;
    return LOCAL_CLOUDFLARED;
  }

  emitChange() {
    if (typeof this.onStateChange === 'function') {
      this.onStateChange(this.getStatus());
    }
  }

  getStatus() {
    return {
      enabled: Boolean(this.config.tunnelEnabled),
      status: this.status,
      publicUrl: this.publicUrl,
      error: this.error,
      binaryInstalled: Boolean(this.resolveBinaryPath())
    };
  }

  async start() {
    if (this.proc) return this.getStatus();

    this.error = '';
    let binPath = this.resolveBinaryPath();

    if (!binPath) {
      this.status = 'downloading';
      this.emitChange();
      try {
        binPath = await this.downloadBinary();
      } catch (err) {
        this.status = 'error';
        this.error = `No se pudo descargar cloudflared: ${err.message}`;
        this.emitChange();
        return this.getStatus();
      }
    }

    this.status = 'starting';
    this.publicUrl = '';
    this.emitChange();

    const port = this.config.port || 19876;
    // El túnel apunta siempre a loopback: no depende de bindHost
    const args = ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'];

    try {
      const child = spawn(binPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.proc = child;

      const handleOutput = (chunk) => {
        const text = chunk.toString('utf8');
        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match && match[0] && this.publicUrl !== match[0]) {
          this.publicUrl = match[0];
          this.status = 'connected';
          this.error = '';
          this.healthFailures = 0;
          this.emitChange();
          this.notifyTunnelUrlViaNtfy(this.publicUrl);
          this.startHealthCheck();
        }
        // Si cloudflared pierde todas las conexiones al edge tras un corte de internet y no logra re-registrar
        if (
          this.status === 'connected' &&
          /Unregistered tunnel connection|Serve tunnel error|failed to serve tunnel/i.test(text)
        ) {
          this.scheduleImmediateHealthProbe();
        }
      };

      child.stdout.on('data', handleOutput);
      child.stderr.on('data', handleOutput);

      child.on('error', (err) => {
        this.proc = null;
        this.status = 'error';
        this.error = err.message;
        this.emitChange();
      });

      child.on('exit', (code) => {
        this.proc = null;
        this.stopHealthCheck();
        if (this.status !== 'stopped') {
          this.status = 'stopped';
          this.publicUrl = '';
          if (code && code !== 0) {
            this.error = `cloudflared finalizó (código ${code})`;
          }
          this.emitChange();
          if (this.config.tunnelEnabled) {
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = null;
              if (this.config.tunnelEnabled && !this.proc) {
                this.start();
              }
            }, 6000);
          }
        }
      });
    } catch (err) {
      this.proc = null;
      this.status = 'error';
      this.error = err.message;
      this.emitChange();
    }

    return this.getStatus();
  }

  startHealthCheck() {
    this.stopHealthCheck();
    this.healthFailures = 0;
    this.healthTimer = setInterval(() => {
      this.probePublicTunnel();
    }, 30000);
  }

  stopHealthCheck() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this._probeDelayTimer) {
      clearTimeout(this._probeDelayTimer);
      this._probeDelayTimer = null;
    }
    this.healthFailures = 0;
  }

  scheduleImmediateHealthProbe() {
    if (this._probeDelayTimer) return;
    this._probeDelayTimer = setTimeout(() => {
      this._probeDelayTimer = null;
      this.probePublicTunnel();
    }, 8000);
  }

  probePublicTunnel() {
    if (!this.proc || this.status !== 'connected' || !this.publicUrl) return;
    const token = this.config.remoteAuthToken || '';
    // Token por cabecera Authorization (nunca en query: queda en logs de acceso)
    const checkUrl = `${this.publicUrl}/api/widget/compact`;
    try {
      const req = https.get(
        checkUrl,
        {
          headers: { 'User-Agent': 'AI-Pulse-Tunnel-Watchdog/1.0', Authorization: `Bearer ${token}` },
          timeout: 10000
        },
        (res) => {
          res.resume();
          if (res.statusCode === 200 || res.statusCode === 401) {
            this.healthFailures = 0;
            if (this.lastNotifiedUrl !== this.publicUrl) {
              this.notifyTunnelUrlViaNtfy(this.publicUrl);
            }
          } else if (res.statusCode === 530 || res.statusCode === 502 || res.statusCode === 404) {
            // 530 / 502 en Cloudflare Quick Tunnel indica que el hostname perdió su origen tras corte de red
            this.handleHealthFailure(`HTTP ${res.statusCode} en túnel público`, res.statusCode === 530);
          } else {
            this.handleHealthFailure(`HTTP ${res.statusCode}`, false);
          }
        }
      );
      req.on('timeout', () => {
        try {
          req.destroy(new Error('timeout'));
        } catch {}
      });
      req.on('error', (err) => {
        const code = String((err && err.code) || '');
        // ENOTFOUND significa que Cloudflare dio de baja el subdominio trycloudflare.com tras el corte
        const isDeadDns = code === 'ENOTFOUND' || code === 'EAI_AGAIN';
        this.handleHealthFailure(code || err.message || 'error de red', isDeadDns);
      });
    } catch {}
  }

  handleHealthFailure(reason, immediateIfInternetUp = false) {
    this.healthFailures = (this.healthFailures || 0) + 1;
    // Si el DNS del túnel murió (ENOTFOUND / HTTP 530) o acumuló 2 fallos seguidos (60s),
    // verificamos que haya internet hacia Cloudflare antes de reciclar el proceso para obtener una URL nueva.
    const threshold = immediateIfInternetUp ? 1 : 2;
    if (this.healthFailures < threshold) return;

    const probeReq = https.get(
      'https://1.1.1.1/cdn-cgi/trace',
      { timeout: 5000 },
      (res) => {
        res.resume();
        // Hay internet real pero el túnel trycloudflare quedó zombie tras el corte -> reiniciar túnel
        this.restartZombieTunnel(reason);
      }
    );
    probeReq.on('timeout', () => {
      try {
        probeReq.destroy();
      } catch {}
    });
    probeReq.on('error', () => {
      // Sigue sin internet general; esperar a que vuelva la conexión para recrear el túnel
    });
  }

  restartZombieTunnel(reason) {
    if (!this.config.tunnelEnabled) return;
    this.stopHealthCheck();
    this.error = `Reconectando túnel tras corte de red (${reason})...`;
    this.publicUrl = '';
    this.status = 'starting';
    if (this.proc) {
      const oldProc = this.proc;
      this.proc = null;
      try {
        oldProc.kill();
      } catch {}
    }
    this.emitChange();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.config.tunnelEnabled && !this.proc) {
        this.start();
      }
    }, 2500);
  }

  stop() {
    this.stopHealthCheck();
    if (this.ntfyRetryTimer) {
      clearTimeout(this.ntfyRetryTimer);
      this.ntfyRetryTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.status = 'stopped';
    this.publicUrl = '';
    this.error = '';
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {}
      this.proc = null;
    }
    this.emitChange();
    return this.getStatus();
  }

  /**
   * Avisa por ntfy que el túnel está activo. NO incluye el token: solo la URL pública,
   * la app del celular ya tiene su clave guardada (o la pide en el modal de acceso).
   */
  notifyTunnelUrlViaNtfy(publicUrl, attempt = 0) {
    if (!publicUrl || this.lastNotifiedUrl === publicUrl) return;
    if (this.config.ntfyEnabled === false || !this.config.ntfyTopic) return;

    if (this.ntfyRetryTimer) {
      clearTimeout(this.ntfyRetryTimer);
      this.ntfyRetryTimer = null;
    }

    const body = `Túnel 4G activo (sin VPN).\n📱 Abrí la app desde: ${publicUrl}/\n(Necesitás tu clave de acceso remoto en la app)`;
    const scheduleRetry = () => {
      if (attempt >= 8 || this.publicUrl !== publicUrl) return;
      this.ntfyRetryTimer = setTimeout(() => {
        this.ntfyRetryTimer = null;
        if (this.publicUrl === publicUrl && this.lastNotifiedUrl !== publicUrl) {
          this.notifyTunnelUrlViaNtfy(publicUrl, attempt + 1);
        }
      }, Math.min(30000, 5000 * (attempt + 1)));
    };

    try {
      const req = https.request(
        `https://ntfy.sh/${encodeURIComponent(this.config.ntfyTopic)}`,
        {
          method: 'POST',
          timeout: 8000,
          headers: {
            Title: 'AI Pulse 4G Listo',
            Priority: 'default',
            Tags: 'iphone,satellite',
            Click: `${publicUrl}/`
          }
        },
        (res) => {
          res.resume();
          if (res.statusCode >= 200 && res.statusCode < 300) {
            this.lastNotifiedUrl = publicUrl;
          } else {
            scheduleRetry();
          }
        }
      );
      req.on('timeout', () => {
        try {
          req.destroy();
        } catch {}
      });
      req.on('error', () => {
        scheduleRetry();
      });
      req.write(body);
      req.end();
    } catch {
      scheduleRetry();
    }
  }
}

module.exports = {
  TunnelManager
};
