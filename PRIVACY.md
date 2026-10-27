# Política de Privacidad (`PRIVACY.md`)

**AI Pulse Widget** es una herramienta de código abierto que se ejecuta 100% de forma local en tu equipo.

---

## 🔒 Principios de Privacidad

1. **Cero Telemetría Externa Propia**:
   - La aplicación **no recolecta, no envía ni vende** estadísticas de uso, métricas de sesiones, prompts, nombres de proyectos ni identificadores personales a ningún servidor externo.
2. **Procesamiento Estricto en Memoria Local**:
   - Para calcular el estado de tus conversaciones y el uso de cuotas de 5 horas / 7 días, el proceso local inspecciona en modo de solo lectura:
     - `~/.claude/sessions/*.json` y `~/.claude/projects/**/*.jsonl` (metadatos de actividad y conteo de tokens de Claude Code CLI).
     - `%APPDATA%\Claude\Local Storage\leveldb` y `%APPDATA%\Claude\logs\main.log` (indicadores de cuota `5h`/`7d` y eventos `antalytics_queue_v1` de la aplicación de escritorio de Claude).
     - `~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl` (estados de pasos y conteo de tokens de Google Antigravity CLI/App).
   - Estos datos sólo se sirven a la interfaz local del widget a través de `http://127.0.0.1:19876`.
3. **Canales Remotos Opcionales**:
   - **Relay `ntfy.sh` (Opcional)**: Si mantenés activado el relay `ntfy.sh` para recibir alertas de CLIs remotos, el widget se suscribe a un tópico aleatorio (`ai-pulse-<hex>`) generado localmente en tu `config.json`. Podés desactivar `ntfy.sh` en cualquier momento desde la pestaña **Config** o cambiar el tópico por uno privado.
   - **Sondeo SSH (Opcional)**: Si configurás hosts SSH en la pestaña **Remoto**, las conexiones se realizan directamente desde el cliente OpenSSH nativo de tu sistema hacia los servidores que vos definas.
4. **Almacenamiento Local**:
   - Toda tu configuración personal se guarda únicamente en el archivo local `config.json` dentro de tu carpeta de instalación (ignorado por Git). Al eliminar la carpeta del proyecto, se elimina toda la configuración de forma permanente.
