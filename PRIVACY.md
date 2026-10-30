# Política de Privacidad (`PRIVACY.md`)

**AI Pulse Widget** es una herramienta de código abierto que se ejecuta en tu equipo. No tiene servidor propio ni telemetría del autor. Lo que sale de tu máquina depende de lo que vos actives, y se detalla abajo.

---

## 🔒 Principios

1. **Sin telemetría del autor**: el proyecto no recolecta ni envía estadísticas de uso, prompts, nombres de proyecto ni identificadores a ningún servidor del autor.
2. **Lectura local**: para calcular el estado de tus sesiones y las cuotas de 5 horas / 7 días, el proceso local lee en modo de solo lectura:
   - `~/.claude/sessions/*.json` y `~/.claude/projects/**/*.jsonl` (actividad y conteo de tokens de Claude Code).
   - `%APPDATA%\Claude\Local Storage\leveldb` y `%APPDATA%\Claude\logs\main.log` (indicadores de cuota de la app de escritorio de Claude).
   - `~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl` (estado de pasos y tokens de Antigravity).
   - Estos datos se sirven sólo a la interfaz local, en `http://127.0.0.1:19876` por defecto.
3. **Almacenamiento local**: la configuración vive en `config.json` dentro de la carpeta del proyecto (ignorado por Git). Incluye el token de acceso remoto y las rutas de tus claves SSH. Borrar la carpeta borra todo.

---

## 🌐 Qué sale de tu equipo (sólo si lo activás)

| Canal | Cuándo | Qué se envía |
|---|---|---|
| **ntfy.sh – alertas push** (`ntfyEnabled`, `ntfyPushLocalAlerts`) | Una consola local termina o pide permiso | Por defecto sólo el **estado** ("Lista", "Permiso", "Cuota") y la etiqueta del proveedor (ej. "Claude"). Con `ntfyIncludeText: true` también el **nombre del proyecto** y el **texto** de la alerta. |
| **ntfy.sh – aviso de túnel** | Al levantar el túnel 4G | La URL pública del túnel (subdominio aleatorio de `trycloudflare.com`). **No** incluye el token. |
| **ntfy.sh – relay de CLIs remotos** | Si tenés scripts en otras máquinas que publican a tu tópico | Lo que esos scripts publican: nombre de host, título de sesión, carpeta de trabajo, estado y, según el script, mensajes. Lo decide quien instala el script. |
| **ntfy.sh – respuestas desde el celular** | Cuando respondés desde la app | El texto de tu respuesta, codificado en **Base64 (no cifrado)** y firmado con HMAC. Cualquiera con acceso al tópico puede leerlo. |
| **Cloudflare (túnel)** | Sólo con `tunnelEnabled: true` | Tu tráfico de acceso remoto pasa por la red de Cloudflare, que termina TLS. |
| **GitHub** | Al descargar `cloudflared` por primera vez | Consulta la API de releases (`api.github.com`) para obtener el SHA256 y descarga el binario. |
| **Servidores SSH** (`sshHosts`) | Si configurás hosts | Conexión directa desde tu cliente OpenSSH al host que vos definiste. Se ejecuta un script de lectura en ese host (ver `SECURITY.md`). |
| **Cloudflare 1.1.1.1** | Sólo ante fallos del túnel | Una consulta `GET /cdn-cgi/trace` para comprobar conectividad. |
| **Google (`businessaicode.googleapis.com`) – cuota de Antigravity** | Si hay credenciales locales de Antigravity (AGY) | Una consulta de cuota oficial **con el access token OAuth** de tu sesión local de AGY, enviado en la cabecera `Authorization`. El token se lee de tus archivos locales de AGY y se usa sólo para esa consulta a Google. |

**Con todo desactivado** (`ntfyEnabled: false`, sin túnel, sin SSH) el widget no hace conexiones salientes, **salvo** la consulta de cuota de AGY a Google si tenés credenciales de Antigravity en el equipo.

---

## ⚙️ Controles que tenés

- `ntfyEnabled: false` apaga el canal ntfy por completo.
- `ntfyPushLocalAlerts: false` apaga sólo las alertas push salientes.
- `ntfyIncludeText` (por defecto `false`) decide si el proyecto y el texto de las alertas salen hacia ntfy.
- `ntfyTopic` debe ser largo y aleatorio. Cualquiera que lo conozca puede leer las alertas y publicar estados falsos (ver `SECURITY.md`). Podés cambiarlo desde la pestaña **Config**.
- `tunnelEnabled: false` apaga el túnel.
- `bindHost` por defecto es `127.0.0.1`: sin tu decisión explícita, nada de tu red local puede conectarse.
