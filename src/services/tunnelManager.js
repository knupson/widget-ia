const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, execFileSync } = require('child_process');

const BIN_DIR = path.resolve(__dirname, '..', '..', 'bin');
const LOCAL_CLOUDFLARED = path.join(BIN_DIR, 'cloudflared.exe');
const CLOUDFLARED_DOWNLOAD_URL =
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

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
    this.reconnectTimer = null;
  }

  resolveBinaryPath() {
    if (this.cachedBinPath && fs.existsSync(this.cachedBinPath)) {
      return this.cachedBinPath;
    }
    if (fs.existsSync(LOCAL_CLOUDFLARED)) {
      this.cachedBinPath = LOCAL_CLOUDFLARED;
      return LOCAL_CLOUDFLARED;
    }
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
      if (first && fs.existsSync(first)) {
        this.cachedBinPath = first;
        return first;
      }
    } catch {}
    return null;
  }

  downloadBinary(url = CLOUDFLARED_DOWNLOAD_URL, redirects = 0) {
    return new Promise((resolve, reject) => {
      if (redirects > 6) {
        reject(new Error('Demasiadas redirecciones descargando cloudflared'));
        return;
      }
      if (!fs.existsSync(BIN_DIR)) {
        fs.mkdirSync(BIN_DIR, { recursive: true });
      }
      const tmpPath = `${LOCAL_CLOUDFLARED}.tmp`;

      https
        .get(url, { headers: { 'User-Agent': 'AI-Pulse-Widget/1.0' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            this.downloadBinary(res.headers.location, redirects + 1)
              .then(resolve)
              .catch(reject);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode} al descargar cloudflared`));
            return;
          }

          const file = fs.createWriteStream(tmpPath);
          res.pipe(file);
          file.on('finish', () => {
            file.close(() => {
              try {
                if (fs.existsSync(LOCAL_CLOUDFLARED)) fs.unlinkSync(LOCAL_CLOUDFLARED);
                fs.renameSync(tmpPath, LOCAL_CLOUDFLARED);
                resolve(LOCAL_CLOUDFLARED);
              } catch (err) {
                reject(err);
              }
            });
          });
          file.on('error', (err) => {
            try {
              fs.unlinkSync(tmpPath);
            } catch {}
            reject(err);
          });
        })
        .on('error', (err) => {
          try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
          } catch {}
          reject(err);
        });
    });
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
          this.emitChange();
          this.notifyTunnelUrlViaNtfy(this.publicUrl);
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
            }, 8000);
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

  stop() {
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

  notifyTunnelUrlViaNtfy(publicUrl) {
    if (!publicUrl || this.lastNotifiedUrl === publicUrl) return;
    if (this.config.ntfyEnabled === false || !this.config.ntfyTopic) return;

    this.lastNotifiedUrl = publicUrl;
    const token = this.config.remoteAuthToken || '';
    const appLink = `${publicUrl}/?token=${encodeURIComponent(token)}`;
    const widgetLink = `${publicUrl}/?mode=widget&token=${encodeURIComponent(token)}`;

    const body = `Túnel 4G activo (sin VPN).\n📱 App / Responder: ${appLink}\n🧩 Widget Android: ${widgetLink}`;
    try {
      const req = https.request(
        `https://ntfy.sh/${encodeURIComponent(this.config.ntfyTopic)}`,
        {
          method: 'POST',
          headers: {
            Title: 'AI Pulse 4G Listo',
            Priority: 'default',
            Tags: 'iphone,satellite',
            Click: appLink
          }
        },
        (res) => res.resume()
      );
      req.on('error', () => {});
      req.write(body);
      req.end();
    } catch {}
  }
}

module.exports = {
  TunnelManager
};
