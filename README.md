# ⚡ AI Pulse Widget · HUD & Monitor para Claude y Google Antigravity (AGY)

Widget de escritorio nativo para Windows (**Electron + Node.js + .NET Win32 Launcher**) con estética **Obsidian, Molten Orange & Ochre**, diseñado para monitorear en tiempo real todas tus sesiones locales y remotas de **Claude (CLI & Desktop App)** y **Google Antigravity (`AGY` CLI & IDE)**.

---

## 🚀 Cómo iniciarlo

1. **Ejecutable Nativo con Splash HUD (sin consola ni `.bat`)**:
   - Haz doble clic en **`AI Pulse Widget.exe`** (o desde el acceso directo creado en tu **Escritorio** y **Menú Inicio**).
   - Si deseas recompilar el ejecutable nativo `.exe`, su ícono `.ico` y actualizar los accesos directos:
     ```powershell
     npm run build:launcher
     ```
2. **Desde terminal (modo desarrollo)**:
   ```powershell
   npm start
   ```
3. **Solo servidor/dashboard web local**:
   ```powershell
   npm run web
   # Abre http://127.0.0.1:19876/?mode=web
   ```

---

## ✨ Funcionalidades Principales

### 1. Píldora HUD Always-on-Top + Panel Expandible + System Tray
- **Modo Píldora Compacta (`445×52`)**:
  - Contadores en vivo con micro-animaciones:
    - 🟢 **Listas (Esperando tu respuesta)**
    - 🟠 **Pidiendo Permiso / Confirmación de herramienta**
    - 🟡 **Trabajando activamente**
  - **Doble bloque de cuotas identificadas**:
    - **`🟠 CLAUDE`** (`5h` y `7d` oficiales de tu plan + insignia `🎁` cuando recibes un reseteo gratis).
    - **`🟡 AGY`** (`5h` y `7d` estimados sobre tus turnos y consumo local).
- **Modo Panel Expandido (`455×595`)**:
  - Filas ultra-compactas de una sola línea por sesión (`Proveedor` · `Proyecto` · `Estado` · `Modelo` · `Tokens` · `Tiempo` · `🎯 Ir a pestaña`).
- **System Tray Dinámico**:
  - Icono en la bandeja del sistema con menú rápido y cambio de estado.

### 2. 🎁 Detector de Reseteos Semanales y Bonus Gratis de Claude
- Analiza automáticamente el historial de telemetría de cuota en `%APPDATA%\Claude\plan-usage-history.json` y los metadatos de `~/.claude.json` (`cachedUsageUtilization.utilization.seven_day.resets_at`).
- Distingue entre:
  - **🔄 Reseteo Semanal Programado**: caída de cuota en el corte habitual de tu ciclo de 7 días.
  - **🎁 Reseteo Gratis / Bonus de Anthropic**: caída abrupta de consumo semanal (`sd`) fuera del horario de corte semanal (por ejemplo, de `97% → 7%` un martes).
- Dispara una **fanfarria sonora especial**, **notificación nativa de Windows** y muestra el historial detallado y cuenta regresiva en la pestaña **Cuotas & Tokens**.

### 3. 🎯 "Ir a Consola" con Cambio Exacto de Pestaña en Windows Terminal
- Cuando tienes múltiples sesiones de `claude.exe` y varias instancias de `agy.exe` corriendo dentro de distintas pestañas de una misma ventana de **Windows Terminal (`WindowsTerminal.exe`)**:
  - Identifica el PID exacto de cada sesión (incluyendo desambiguación de múltiples instancias de `agy.exe` mediante la API nativa Win32 **Restart Manager `rstrtmgr.dll`** sobre el archivo `.lock` de cada conversación).
  - Rastréa el shell padre (`pwsh.exe` / `powershell.exe` / `cmd.exe`) dentro del árbol de procesos de `WindowsTerminal.exe`, calcula el índice exacto de pestaña y cambia automáticamente a esa pestaña mediante `wt.exe -w 0 focus-tab -t <tabIndex>` + **UIAutomation (`SelectionItemPattern`)**.

### 4. Detección Local Zero-Config + Hooks Instantáneos (`<50ms`)
- **Antigravity (`AGY`)**:
  - Detecta consolas abiertas verificando bloqueos a nivel OS en `~/.gemini/antigravity-cli/presence/<conversationId>.lock`.
  - Lee resúmenes desde `~/.gemini/antigravity-cli/conversation_summaries.db` (`node:sqlite`) y estados en vivo desde `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`.
- **Claude (CLI y App)**:
  - Detecta procesos vivos desde `~/.claude/sessions/<pid>.json`.
  - Analiza el consumo de tokens de entrada, salida y caché por sesión, proyecto y modelo desde `~/.claude/projects/<project>/<sessionId>.jsonl`.
- **Hooks Instantáneos**:
  - Instalación con 1 clic en `~/.claude/settings.json` (preservando hooks previos del usuario) y `~/.gemini/config/hooks.json`.

### 5. Monitoreo de CLIs Remotos (Con y Sin SSH)
- **Cloud Relay vía `ntfy.sh` (Sin SSH entrante)**:
  - Recibe eventos en tiempo real desde servidores detrás de NAT, contenedores o VMs con un comando `curl` o `Invoke-RestMethod` de 1 línea.
- **Sondeo directo por SSH**:
  - Monitoreo automático sin agentes adicionales consultando `~/.claude/sessions` y `~/.gemini/antigravity-cli/presence` vía clave pública SSH.

---

## 🛠️ Estructura del Proyecto

- [`main.js`](./main.js) — Proceso principal de Electron, ventana transparente sin bordes, bandeja del sistema y notificaciones nativas.
- [`src/launcher/Launcher.cs`](./src/launcher/Launcher.cs) & [`scripts/build-launcher.js`](./scripts/build-launcher.js) — Generador de ícono `.ico` multi-resolución y compilador del ejecutable nativo `AI Pulse Widget.exe` con splash HUD.
- [`src/collectors/claudeCollector.js`](./src/collectors/claudeCollector.js) — Colector de sesiones, tokens, cuota oficial `5h`/`7d` y detector de reseteos semanales/bonus gratis de Claude.
- [`src/collectors/agyCollector.js`](./src/collectors/agyCollector.js) — Colector de sesiones activas, base SQLite y transcripciones de Google Antigravity (`AGY`).
- [`src/services/windowFocuser.js`](./src/services/windowFocuser.js) — Motor Win32 + Restart Manager (`rstrtmgr.dll`) + UIAutomation para enfocar ventanas y cambiar a la pestaña exacta de Windows Terminal.
- [`src/public/`](./src/public/) — Interfaz HUD con tema Obsidian + Molten Orange & Ochre (`index.html`, `styles.css`, `app.js`).
