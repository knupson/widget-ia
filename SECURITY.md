# Política de Seguridad (`SECURITY.md`)

**AI Pulse Widget** lee la telemetría de tus herramientas en tu máquina. Este documento describe **sólo lo que el código hace hoy**. Si algo acá no coincide con el código, el código manda y conviene reportarlo.

---

## 🛡️ Arquitectura de seguridad

### 1. Servidor local y `bindHost`
- El servidor (`src/server.js`) escucha en `bindHost`. Si el `config.json` no tiene `bindHost`, el valor es **`127.0.0.1`** (sólo loopback). El código **nunca** reescribe `bindHost` a `0.0.0.0` por su cuenta.
- Escuchar en la LAN requiere que **vos** escribas `"bindHost": "0.0.0.0"` (o una IP) en `config.json`. Al arrancar con una IP no loopback, el servidor deja un aviso en consola. En ese modo, cualquier cliente de la LAN necesita token (ver punto 2).
- El túnel Cloudflare (si lo activás) siempre apunta a `http://127.0.0.1:<port>`, sin importar `bindHost`.

### 2. Autenticación
- Un cliente **no loopback** (LAN, túnel) necesita `remoteAuthToken`. Se acepta en cabecera `Authorization: Bearer`, en `X-Auth-Token`, en la cookie `ai_pulse_token` o en `?token=` (la UI lo usa para SSE y para los enlaces/QR; ese formato queda en el historial del navegador).
- Las peticiones **loopback sin cabecera `Origin`** (CLI, hooks, scripts locales) no piden token.
- Las peticiones loopback **con `Origin`** (la UI del navegador o la ventana de Electron) **sí piden token**. La ventana local lo recibe como cookie al cargar `/`: la cookie es `HttpOnly; SameSite=Strict; Path=/`, así que el JavaScript de la página no la puede leer.
- La comparación del token usa `crypto.timingSafeEqual`.
- **Rate limit**: 10 intentos fallidos por IP en 10 minutos bloquean esa IP (HTTP 429) por el resto de la ventana. Por el túnel la IP se toma de `cf-connecting-ip`.
- Los tokens generados en instalaciones nuevas tienen 128 bits. Las instalaciones existentes conservan su token anterior (64 bits); si querés regenerarlo, borrá `remoteAuthToken` de `config.json` y volvé a emparejar el celular.

### 2b. Lectura de credenciales de Antigravity (AGY)
- `src/collectors/agyQuotaStatus.js` lee el access token OAuth de tu sesión local de Antigravity y lo envía **sólo** a `businessaicode.googleapis.com` (cabecera `Authorization`) para leer tu cuota oficial. Es el único caso en que el widget usa un token ajeno a `remoteAuthToken`.
### 3. Validación de Host y Origin (anti DNS-rebinding y CSRF)
- `Host` debe ser exactamente `127.0.0.1:<port>` o `localhost:<port>` para considerarse loopback. Otros valores se tratan como remotos (exigen token).
- `Origin` debe ser exactamente `http://127.0.0.1:<port>` o `http://localhost:<port>` (mismo puerto). Cualquier otro origen recibe **HTTP 403** desde loopback.
- No se usa `Access-Control-Allow-Origin: *`.

### 4. Token: dónde viaja y dónde NO
- **Nunca se envía a ntfy.sh.** El aviso de túnel activo y las alertas push llevan sólo la URL pública, sin token. El celular ya tiene su clave guardada.
- El watchdog del túnel consulta `/api/widget/compact` con `Authorization: Bearer` (no en la URL).
- `/api/state` y el stream SSE **no incluyen `remoteAuthToken`**. Las URLs de acceso móvil (`mobileAccess`) incluyen el token **sólo** para clientes loopback (la ventana local muestra el QR); para LAN y túnel se entregan sin `token=`.
- `config.json` guarda el token en texto plano en tu disco. Está en `.gitignore`.

### 5. Comandos de respuesta por ntfy: firmados
- Un `remote_reply` recibido por ntfy se ejecuta **sólo si**: trae `sig` (HMAC-SHA256 con `remoteAuthToken`), `ts` está a ±2 minutos del reloj local y la firma no fue usada antes (cache en memoria).
- El formato exacto está en el comentario al inicio de `src/collectors/remoteManager.js`.
- Un comando que no cumple cualquiera de esas reglas se descarta sin responder.
- Si el `sessionId` no coincide con una sesión abierta, no se hace ningún fallback a "la primera sesión en espera".
- **Limitación conocida**: los mensajes de *estado* (no comandos) que llegan por ntfy (`ntfy` relay de CLIs remotos) **no van firmados**. Quien conozca el tópico puede inyectar sesiones falsas en el panel. Por eso el tópico debe ser largo y aleatorio (8 a 64 caracteres `[A-Za-z0-9_-]`).
- Los textos de los comandos viajan por ntfy codificados en Base64 (no cifrados). Ver `PRIVACY.md`.

### 6. Endpoints y datos
- `POST /api/remote/report` exige token (ya no es público). Las sesiones remotas tienen tope de 200 y expiran a los 5 minutos sin recibir novedades.
- `POST /api/remote/test` está **desactivado** salvo que `config.devMode` sea `true` (devuelve 404).
- `POST /api/config` valida `ntfyTopic` con `^[A-Za-z0-9_-]{8,64}$`.
- Los cuerpos JSON están limitados a 256 KB (HTTP 413). Los errores internos devuelven 500 sin detalle.
- `POST /api/admin/handover` exige token.

### 7. Archivos estáticos y APK
- La raíz estática (`src/public`) **no sirve** `.apk`, archivos que empiecen con punto ni `config*.json`. Responden 404.
- El APK vive en `apk/ai-pulse.apk` (fuera de la raíz estática, ignorado por Git) y se sirve sólo por `GET /api/apk` con token. Si no existe ahí, se usa `src/public/ai-pulse.apk` como respaldo, también sólo por esa ruta.

### 8. Sondeo SSH (`src/collectors/remoteManager.js`)
- Se usa `child_process.execFile('ssh', ...)` sin shell local.
- `target` debe cumplir `^[a-zA-Z0-9._-]+(@[a-zA-Z0-9._-]+)?$`. `port` debe ser entero entre 1 y 65535. `keyPath` no puede empezar con `-`, no puede tener caracteres de control y debe existir como archivo. Si falla, el host queda en error y no se ejecuta `ssh`.
- Se pasa `--` antes del destino para evitar inyección de opciones.
- Opciones fijas: `BatchMode=yes`, `ConnectTimeout=5`, `StrictHostKeyChecking=accept-new`. **`accept-new`** significa que la primera conexión acepta la clave del host sin preguntar (TOFU); las siguientes sí se verifican.
- El script que corre en el host remoto (`sh`, codificado en Base64) sólo lee `~/.claude/sessions`, `~/.gemini/antigravity-cli/brain` y la lista de procesos del usuario.

### 9. cloudflared (túnel)
- El binario se descarga sólo por HTTPS desde `github.com`, `objects.githubusercontent.com` o `release-assets.githubusercontent.com`. Cualquier otro host en una redirección se rechaza.
- Si GitHub publica el SHA256 del asset de la última release (campo `digest` de la API), la descarga se verifica contra ese hash antes de usarla. **Si GitHub no lo publica, la descarga NO se verifica** y queda un aviso en consola (TODO en el código).
- Orden de búsqueda: `bin/cloudflared.exe` (descargado), luego `Program Files`, y sólo al final `where.exe` (PATH), aceptando únicamente una ruta absoluta llamada `cloudflared.exe`.

### 10. Aislamiento de Electron (`main.js`, `preload.js`)
- La ventana corre con `contextIsolation: true` y `nodeIntegration: false`.
- `widget:openExternal` sólo abre URLs que empiezan con `http://` o `https://`.

### 11. Binarios versionados
El repositorio **sí versiona dos ejecutables** (`git ls-files "*.exe"`):
- `AI Pulse Widget.exe` (raíz): launcher. Se regenera con `npm run build:launcher` (`scripts/build-launcher.js`, compila con `csc.exe` de .NET Framework).
- `src/services/fullscreenWatcher.exe`: no pude verificar acá cómo se compila.

Para verificarlos: calculá el hash (`Get-FileHash -Algorithm SHA256 <archivo>`) y comparalo con el de un build propio desde el código fuente, o con el que publique el autor. No confíes en un `.exe` de terceros sin comprobar su hash.

Los binarios que **no** se versionan: `bin/cloudflared.exe` (descargado, ver punto 9) y `apk/ai-pulse.apk` (build local, ignorado por Git).

---

## 🚨 Reporte de vulnerabilidades

Si descubrís una vulnerabilidad de seguridad en este repositorio:

1. **No abras un Issue público** si el reporte incluye un exploit funcional.
2. Enviá el reporte a través de [GitHub Security Advisories](https://github.com/knupson/widget-ia/security/advisories/new) en el repositorio `knupson/widget-ia`.
3. Incluí los pasos para reproducir el problema y el impacto potencial. Recibirás respuesta y parche a la brevedad.
