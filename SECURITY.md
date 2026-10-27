# Política de Seguridad (`SECURITY.md`)

**AI Pulse Widget** está diseñado bajo una arquitectura **Local-First & Zero-Cloud Telemetry**: toda la lectura de sesiones, tokens y cuotas ocurre estrictamente en tu máquina local sin depender de servidores intermediarios ni almacenar credenciales en el repositorio.

---

## 🛡️ Arquitectura de Seguridad

### 1. Servidor Local Aislado (`127.0.0.1` Loopback)
- El motor interno de telemetría (`src/server.js`) escucha **exclusivamente en `127.0.0.1`** (loopback local) por defecto (`127.0.0.1:19876`). No expone puertos a la red local (LAN) ni a Internet.
- **Protección contra DNS Rebinding y Cross-Origin CSRF**:
  - Todas las peticiones HTTP entrantes validan estrictamente las cabeceras `Host` y `Origin`.
  - Cualquier petición originada desde un sitio web externo en el navegador (cross-origin) o con un `Host` distinto de `127.0.0.1` / `localhost` es rechazada inmediatamente con `HTTP 403 Forbidden`.
  - No se utiliza `Access-Control-Allow-Origin: *`.

### 2. Lectura Local de Solo Lectura (Read-Only Collectors)
- Los recolectores de **Claude** (`src/collectors/claudeCollector.js`) y **Google Antigravity / AGY** (`src/collectors/agyCollector.js`) abren los archivos locales de telemetría (`~/.claude`, `%APPDATA%/Claude`, `~/.gemini/antigravity-cli`) **únicamente en modo lectura**.
- **Nunca se leen ni transmiten tokens OAuth, API keys ni cookies de sesión**.

### 3. Endurecimiento de Sondeo SSH (`src/collectors/remoteManager.js`)
- El sondeo opcional por SSH utiliza `child_process.execFile('ssh', ...)` sin pasar por un shell local (evitando inyección de comandos en la máquina anfitriona).
- Los parámetros `target` (`usuario@host`), `port` (`1..65535`) y `keyPath` (`-i`) son validados contra expresiones regulares estrictas y precedidos por el separador `--` para impedir inyección de opciones de OpenSSH (`ProxyCommand`, `LocalCommand`, etc.).
- El cliente SSH se ejecuta siempre con `BatchMode=yes` y `ConnectTimeout=5`.

### 4. Aislamiento del Proceso Renderer en Electron (`main.js` & `preload.js`)
- La ventana de Electron corre con `contextIsolation: true` y `nodeIntegration: false`.
- El puente IPC (`preload.js`) expone únicamente primitivas seguras y valida que cualquier apertura de enlaces externos (`shell.openExternal`) utilice exclusivamente los protocolos `http://` o `https://`.

### 5. Protección de Configuración y Secretos Locales (`.gitignore`)
- El archivo `config.json` (que almacena tu tópico aleatorio de `ntfy.sh` y la lista de servidores SSH configurados) se genera dinámicamente en el primer arranque y está **excluido mediante `.gitignore`**.
- Los binarios locales y logs temporales nunca se versionan en Git.

---

## 🚨 Reporte de Vulnerabilidades

Si descubrís una vulnerabilidad de seguridad en este repositorio:

1. **No abras un Issue público** si el reporte incluye un exploit funcional.
2. Envía el reporte a través de [GitHub Security Advisories](https://github.com/knupson/widget-ia/security/advisories/new) en el repositorio `knupson/widget-ia`.
3. Incluí los pasos para reproducir el problema y el impacto potencial. Recibirás respuesta y parche a la brevedad.
