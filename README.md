# ⚡ AI Pulse Widget — Claude, Google Antigravity (AGY) & Codex HUD

![License: MIT](https://img.shields.io/badge/License-MIT-e09f3e.svg)
![Platform: Windows](https://img.shields.io/badge/Platform-Windows%2010%2F11-f59e0b.svg)
![Electron](https://img.shields.io/badge/Electron-35+-14100c.svg)
![Security: Local-First](https://img.shields.io/badge/Security-127.0.0.1%20Loopback-10b981.svg)

**AI Pulse Widget** es un HUD flotante *Always-on-Top* y centro de telemetría en tiempo real para Windows, diseñado con estética **Obsidian, Ochre & Amber** para desarrolladores que trabajan en simultáneo con **Claude (Code CLI & Desktop App)**, **Google Antigravity (`AGY` CLI & IDE)**, **OpenAI Codex (CLI)** y agentes en **servidores remotos (SSH / Webhooks / ntfy.sh)**.

---

## ✨ Características Principales

### 💊 1. Doble Modo con Ancho Unificado (`736px`) y Always-on-Top Real
- **Modo Píldora Compacta (`736 × 56 px`)**:
  - Se acopla discretamente en la esquina superior derecha de tu pantalla.
  - Muestra en vivo el estado de actividad global, alertas pendientes y bloques dedicados con separación visual clara:
    - **CLAUDE**: Porcentaje de cuota de sesión (`5h`) y semanal (`7d`), indicador de regalo/reseteo de cuota semanal vigente (`🎁`) y tokens efectivos del día.
    - **AGY**: Porcentaje de cuota de ventana de `5h` y semanal (`7d`) más tokens efectivos del día.
    - **CODEX**: Porcentaje de cuota de `5h` y `7d` informado por Codex, con tokens del día.
  - **Botón Diana (`🎯`)**: Enfoca con un clic la ventana exacta que requiere tu atención (diferenciando consolas de Windows Terminal / PowerShell mediante coincidencia del árbol de procesos padre-hijo y título de pestaña) **sin perder jamás el nivel `screen-saver` Always-on-Top** sobre Chrome u otras aplicaciones.
- **Modo Panel Expandido (`736 × 640 px`)**:
  - Se despliega conservando exactamente el mismo ancho (`736px`) que la píldora contraída.
  - **Sin icono en la barra de tareas** (`skipTaskbar: true`), operando limpiamente desde el área de notificaciones (System Tray) con menú contextual completo.

### 🧠 2. Detección en Tiempo Real (Claude, AGY y Codex)
- **Claude Desktop App (Windows)**:
  - Decodifica en tiempo real los bloques comprimidos con Snappy y los registros en vivo `antalytics_queue_v1` de LevelDB (`%APPDATA%\Claude\Local Storage\leveldb`) junto con `%APPDATA%\Claude\logs\main.log`.
  - Detecta al instante cuando Claude Desktop está **pensando / generando respuesta (`⚡ Activa`)** y cuando acaba de responder y queda **esperando tu respuesta (`💬 Lista`)**, evitando falsos positivos de conversaciones inactivas.
- **Claude Code CLI, Google Antigravity (`AGY`) y Codex**:
  - Monitoreo híbrido por inspección de transcripts JSONL (`~/.claude/projects`, `~/.gemini/antigravity-cli`, `~/.codex/sessions`), sesiones activas por PID y **Hooks instantáneos** (`Stop`, `Notification`, `PreToolUse`) para Claude y AGY.
  - **Codex**: lee de forma incremental los rollouts JSONL locales (respeta `CODEX_HOME`). Agrega tokens por sesión y por día y toma el uso de `5h`/`7d` de los eventos `rate_limits` de esos mismos archivos. No lee `auth.json` y no llama a modelos.
  - **AGY**: detecta en los logs locales los errores de cuota agotada (429) y el plazo de reset que informa el propio CLI. No deduce qué ventana se agotó.

### 📊 3. Telemetría de Cuotas (`5h` / `7d`), Cuenta Regresiva de Resets y Detección de Bonus (`🎁`)
- Barras duales de consumo para la ventana rotativa de **5 horas** y el límite **semanal de 7 días**, para **Claude**, **AGY** y **Codex**.
- **Cuenta regresiva exacta de reseteo** (`⏱ 3h 42m` / `⏱ 4d 11h`) visible directamente en los encabezados de cuota.
- **Detector de Regalos / Resets Semanales de Claude (`🎁`)**:
  - Detecta caídas abruptas en el consumo semanal (`7d`) fuera de la fecha programada de renovación.
  - Muestra el badge `🎁` **únicamente mientras el beneficio corresponde al ciclo semanal vigente**, ocultando automáticamente reseteos históricos de semanas pasadas.
- **Lectura vencida de Claude (`ant.`)**:
  - Claude Desktop escribe su historial de cuota cada ~15 minutos. Si deja de hacerlo, el último valor puede ser de una semana anterior, así que el widget **no lo presenta como actual**.
  - Con la lectura vencida, los porcentajes aparecen como `--%` con el marcador `ant.`, las barras se muestran como una pista punteada (nunca como un `0%` real) y el tooltip indica cuándo fue la última lectura y cuál era su valor. Abrí Claude Desktop para actualizarla.
  - Campos de la API: `planQuota.stale` (`true` cuando la lectura está vencida), `lastKnownFiveHourPct` / `lastKnownSevenDayPct` (último valor conocido) y `updatedAt`.
- **Pestañas actualizadas sólo cuando cambia algo**: tablas, gráficos y listas se reconstruyen únicamente si cambian los datos visibles, así no se pierden clics, selección ni scroll.

### 🌐 4. Monitoreo de CLIs Remotos (SSH con Llave Privada, `ntfy.sh` y Webhook)
- **Sondeo SSH con soporte de llave privada (`-i`)**: Configurá servidores remotos (`usuario@ip`, puerto y ruta a tu clave privada como `~/.ssh/id_ed25519` o `C:\Keys\server.pem`) para monitorear sesiones remotas sin instalar agentes adicionales.
- **Relay `ntfy.sh` opcional, sin abrir puertos**: Recibí notificaciones instantáneas cuando un agente remoto en un contenedor o VPS termina su tarea o solicita permisos. Es un canal opcional: si no lo activás, no se conecta.

### 📱 5. Acceso desde el Celular (PWA y Widget Android)
- La interfaz web se sirve desde el mismo servidor local y se puede instalar como PWA (`manifest.json` con iconos `any` y `maskable`).
- El Service Worker (`sw.js`) es **mínimo a propósito**: sólo habilita la instalación. No guarda caché, porque el servidor responde con `no-cache` (estado en vivo, SSE y API).
- Si el widget no puede mostrar una URL válida desde el cliente actual (por ejemplo, porque el servidor no entrega el token a clientes que no son loopback), indica *"no disponible desde este cliente"* en lugar de imprimir valores vacíos o `undefined`.

---

## 🚀 Instalación y Uso Rápido

### Requisitos Previos
- **Windows 10 / 11** (64-bit)
- **Node.js 18+** (`"engines": { "node": ">=18" }`)

### 1. Clonar e instalar dependencias
```powershell
git clone https://github.com/knupson/widget-ia.git
cd widget-ia
npm install
```

### 2. Iniciar el Widget
Podés ejecutar el lanzador nativo sin ventana de consola (`AI Pulse Widget.exe`) o mediante npm:
```powershell
# Iniciar mediante el ejecutable nativo Win32 (sin ventana CMD/BAT)
.\AI Pulse Widget.exe

# O desde terminal de desarrollo
npm start
```

### 3. Recompilar el ejecutable nativo y crear acceso directo (Opcional)
```powershell
npm run build:launcher
```
Esto compila `AI Pulse Widget.exe` (subsistema `winexe` con icono personalizado `assets/icon.ico`) y actualiza el acceso directo en tu Escritorio.

### 4. Verificar la sintaxis del proyecto
```powershell
npm run check
```
Corre `node --check` sobre `main.js`, `preload.js`, `start-electron.js` y todo `src/**/*.js`.

---

## 🗂️ Estructura del Proyecto

| Archivo / Directorio | Descripción |
| :--- | :--- |
| [`main.js`](main.js) | Proceso principal de Electron: ventana de `736px` (píldora `56px`, panel `640px`), `Always-on-Top` (`screen-saver`), bandeja del sistema (`Tray`) e IPC. |
| [`preload.js`](preload.js) | Puente seguro (`contextBridge`) entre el proceso principal y la interfaz. |
| [`start-electron.js`](start-electron.js) | Lanzador de desarrollo (`npm start`). |
| [`src/server.js`](src/server.js) | Servidor local (`127.0.0.1:19876`), stream SSE (`/api/stream`), agregador de cuotas y protección de origen. |
| [`src/collectors/claudeCollector.js`](src/collectors/claudeCollector.js) | Recolector de Claude Code CLI y decodificador LevelDB/Snappy + `antalytics_queue_v1` de Claude Desktop App. Marca como vencida la lectura de cuota antigua. |
| [`src/collectors/agyCollector.js`](src/collectors/agyCollector.js) | Recolector de sesiones, subagentes, modelos y cuotas de Google Antigravity (`AGY`). |
| [`src/collectors/agyQuotaStatus.js`](src/collectors/agyQuotaStatus.js) | Lectura de los logs locales de AGY: errores 429 de cuota agotada y plazo de reset informado. |
| [`src/collectors/codexCollector.js`](src/collectors/codexCollector.js) | Recolector de Codex: rollouts JSONL locales (`CODEX_HOME` o `~/.codex`), tokens por sesión y día, cuota `5h`/`7d` de `rate_limits`. |
| [`src/collectors/remoteManager.js`](src/collectors/remoteManager.js) | Gestor de sesiones remotas por stream `ntfy.sh`, Webhook HTTP y sondeo SSH seguro con soporte `-i`. |
| [`src/services/conversationReader.js`](src/services/conversationReader.js) | Lector del historial conversacional del chat en vivo. |
| [`src/services/windowFocuser.js`](src/services/windowFocuser.js) | Motor Win32 (`user32.dll` + árbol de procesos CIM) para enfocar la consola o ventana exacta de cada sesión. |
| [`src/services/hooksManager.js`](src/services/hooksManager.js) | Instalador en 1 clic de hooks locales para `~/.claude/settings.json` y `~/.gemini/antigravity-cli/hooks.json`. |
| [`src/public/`](src/public/) | Interfaz de usuario (HTML5, CSS3 con tema *Obsidian & Ochre*, gráficas SVG y audio WebAudio sintetizado). Incluye la PWA: `manifest.json`, `sw.js` e iconos. |
| [`scripts/build-launcher.js`](scripts/build-launcher.js) | Generador de iconos `.ico` multi-resolución y compilador C# para `AI Pulse Widget.exe`. |
| [`scripts/check.js`](scripts/check.js) | Chequeo de sintaxis de todos los JS del proyecto (`npm run check`). |

---

## 🔒 Seguridad, Privacidad y Licencia

- **Seguridad ([`SECURITY.md`](SECURITY.md))**: El servidor escucha en `127.0.0.1` (loopback) por defecto, valida las cabeceras `Host`/`Origin` contra DNS Rebinding y CSRF, sanitiza los argumentos SSH y Electron corre aislado (`contextIsolation: true`, `nodeIntegration: false`).
- **Privacidad ([`PRIVACY.md`](PRIVACY.md))**: Sin telemetría propia. El widget lee en modo de solo lectura los archivos locales de Claude, AGY y Codex. Los canales externos (ntfy, SSH, túnel) son opcionales. Si hay credenciales locales de Antigravity, el widget consulta la cuota oficial de AGY en Google con tu access token de sesión (ver el detalle en PRIVACY.md). Tu archivo `config.json` está excluido del control de versiones (`.gitignore`).
- **Licencia ([`LICENSE`](LICENSE))**: Distribuido bajo la licencia **MIT**.
