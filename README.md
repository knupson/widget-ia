# ⚡ AI Pulse Widget — Claude & Google Antigravity (AGY) HUD

![License: MIT](https://img.shields.io/badge/License-MIT-e09f3e.svg)
![Platform: Windows](https://img.shields.io/badge/Platform-Windows%2010%2F11-f59e0b.svg)
![Electron](https://img.shields.io/badge/Electron-35+-14100c.svg)
![Security: Local-First](https://img.shields.io/badge/Security-127.0.0.1%20Loopback-10b981.svg)

**AI Pulse Widget** es un HUD flotante *Always-on-Top* y centro de telemetría en tiempo real para Windows, diseñado con estética **Obsidian, Ochre & Amber** para desarrolladores que trabajan en simultáneo con **Claude (Code CLI & Desktop App)**, **Google Antigravity (`AGY` CLI & IDE)** y agentes en **servidores remotos (SSH / Webhooks / ntfy.sh)**.

---

## ✨ Características Principales

### 💊 1. Doble Modo con Ancho Unificado (`516px`) y Always-on-Top Real
- **Modo Píldora Compacta (`516 × 52 px`)**:
  - Se acopla discretamente en la esquina superior derecha de tu pantalla.
  - Muestra en vivo el estado de actividad global, alertas pendientes y dos bloques dedicados con separación visual clara:
    - **CLAUDE**: Porcentaje de cuota de sesión (`5h`) y semanal (`7d`), indicador de regalo/reseteo de cuota semanal vigente (`🎁`) y tokens efectivos del día.
    - **AGY**: Porcentaje de cuota de ventana de `5h` y semanal (`7d`) más tokens efectivos del día.
  - **Botón Diana (`🎯`)**: Enfoca con un clic la ventana exacta que requiere tu atención (diferenciando consolas de Windows Terminal / PowerShell mediante coincidencia del árbol de procesos padre-hijo y título de pestaña) **sin perder jamás el nivel `screen-saver` Always-on-Top** sobre Chrome u otras aplicaciones.
- **Modo Panel Expandido (`516 × 670 px`)**:
  - Se despliega conservando exactamente el mismo ancho (`516px`) que la píldora contraída.
  - **Sin icono en la barra de tareas** (`skipTaskbar: true`), operando limpiamente desde el área de notificaciones (System Tray) con menú contextual completo.

### 🧠 2. Detección en Tiempo Real (Claude CLI + Claude Desktop App + AGY)
- **Claude Desktop App (Windows)**:
  - Decodifica en tiempo real los bloques comprimidos con Snappy y los registros en vivo `antalytics_queue_v1` de LevelDB (`%APPDATA%\Claude\Local Storage\leveldb`) junto con `%APPDATA%\Claude\logs\main.log`.
  - Detecta al instante cuando Claude Desktop está **pensando / generando respuesta (`⚡ Activa`)** y cuando acaba de responder y queda **esperando tu respuesta (`💬 Lista`)**, evitando falsos positivos de conversaciones inactivas.
- **Claude Code CLI & Google Antigravity (`AGY`)**:
  - Monitoreo híbrido por inspección de transcripts JSONL, sesiones activas por PID y **Hooks instantáneos** (`Stop`, `Notification`, `PreToolUse`).

### 📊 3. Telemetría de Cuotas (`5h` / `7d`), Cuenta Regresiva de Resets y Detección de Bonus (`🎁`)
- Barras duales de consumo para la ventana rotativa de **5 horas** y el límite **semanal de 7 días**, tanto para **Claude** como para **AGY**.
- **Cuenta regresiva exacta de reseteo** (`⏱ 3h 42m` / `⏱ 4d 11h`) visible directamente en los encabezados de cuota.
- **Detector de Regalos / Resets Semanales de Claude (`🎁`)**:
  - Detecta caídas abruptas en el consumo semanal (`7d`) fuera de la fecha programada de renovación.
  - Muestra el badge `🎁` **únicamente mientras el beneficio corresponde al ciclo semanal vigente**, ocultando automáticamente reseteos históricos de semanas pasadas.

### 🌐 4. Monitoreo de CLIs Remotos (SSH con Llave Privada, `ntfy.sh` y Webhook)
- **Sondeo SSH con soporte de llave privada (`-i`)**: Configurá servidores remotos (`usuario@ip`, puerto y ruta a tu clave privada como `~/.ssh/id_ed25519` o `C:\Keys\server.pem`) para monitorear sesiones remotas sin instalar agentes adicionales.
- **Relay `ntfy.sh` sin abrir puertos**: Recibí notificaciones instantáneas cuando un agente remoto en un contenedor o VPS termina su tarea o solicita permisos.

---

## 🚀 Instalación y Uso Rápido

### Requisitos Previos
- **Windows 10 / 11** (64-bit)
- **Node.js 18+**

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

---

## 🗂️ Estructura del Proyecto

| Archivo / Directorio | Descripción |
| :--- | :--- |
| [`main.js`](main.js) | Proceso principal de Electron: gestión de ventana `516px`, `Always-on-Top` (`screen-saver`), bandeja del sistema (`Tray`) e IPC. |
| [`preload.js`](preload.js) | Puente seguro (`contextBridge`) entre el proceso principal y la interfaz. |
| [`src/server.js`](src/server.js) | Servidor local (`127.0.0.1:19876`), stream SSE (`/api/stream`), agregador de cuotas y protección de origen. |
| [`src/collectors/claudeCollector.js`](src/collectors/claudeCollector.js) | Recolector de Claude Code CLI y decodificador LevelDB/Snappy + `antalytics_queue_v1` de Claude Desktop App. |
| [`src/collectors/agyCollector.js`](src/collectors/agyCollector.js) | Recolector de sesiones, subagentes, modelos y cuotas de Google Antigravity (`AGY`). |
| [`src/collectors/remoteManager.js`](src/collectors/remoteManager.js) | Gestor de sesiones remotas por stream `ntfy.sh`, Webhook HTTP y sondeo SSH seguro con soporte `-i`. |
| [`src/services/windowFocuser.js`](src/services/windowFocuser.js) | Motor Win32 (`user32.dll` + árbol de procesos CIM) para enfocar la consola o ventana exacta de cada sesión. |
| [`src/services/hooksManager.js`](src/services/hooksManager.js) | Instalador en 1 clic de hooks locales para `~/.claude/settings.json` y `~/.gemini/antigravity-cli/hooks.json`. |
| [`src/public/`](src/public/) | Interfaz de usuario (HTML5, CSS3 con tema *Obsidian & Ochre*, gráficas SVG y audio WebAudio sintetizado). |
| [`scripts/build-launcher.js`](scripts/build-launcher.js) | Generador de iconos `.ico` multi-resolución y compilador C# para `AI Pulse Widget.exe`. |

---

## 🔒 Seguridad, Privacidad y Licencia

- **Seguridad ([`SECURITY.md`](SECURITY.md))**: Servidor restringido a `127.0.0.1`, validación de cabeceras `Host`/`Origin` contra DNS Rebinding y CSRF, sanitización de argumentos SSH y aislamiento de Electron (`contextIsolation: true`).
- **Privacidad ([`PRIVACY.md`](PRIVACY.md))**: Procesamiento 100% local y de solo lectura. Sin telemetría hacia terceros. Tu archivo `config.json` está excluido del control de versiones.
- **Licencia ([`LICENSE`](LICENSE))**: Distribuido bajo la licencia **MIT**.
