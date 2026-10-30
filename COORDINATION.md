# Coordinación de trabajo

## Codex — integrado, 2026-10-29

Estado: implementación terminada; `node --check` y `git diff --check` sin errores. Se comprobaron identificadores HTML únicos.

### Cambios

- `src/collectors/codexCollector.js`: lee los rollouts JSONL locales de Codex de forma incremental; agrega tokens por sesión y día; extrae uso de 5h y 7d de `rate_limits`. No lee `auth.json` ni llama a modelos. Marca porcentajes ausentes, caducados o antiguos como desconocidos/obsoletos.
- `src/server.js`: añade sesiones, tokens diarios y semanales y cuota de Codex al estado y análisis del widget.
- `main.js`, `src/public/index.html`, `src/public/app.js`, `src/public/styles.css`: añaden el indicador de Codex en la píldora, vista móvil, KPI, filtro, panel y gráfico; ancho de escritorio 736 px.
- `src/collectors/agyQuotaStatus.js` y `src/collectors/agyCollector.js`: leen de logs locales el error 429 y el plazo de reset informado por AGY. No deducen cuál ventana se agotó. El porcentaje actual de AGY sigue siendo una estimación configurable, ahora rotulada con `~`.
- `src/services/conversationReader.js`: filtra respuestas de AGY que contienen `RESOURCE_EXHAUSTED` o errores de cuota agotada para evitar repetirlos en el historial conversacional. El estado y el reset quedan en el aviso del widget.
- Confirmación del usuario: AGY se restableció al cumplirse el plazo anunciado.

### Límites de validación

- Pasaron las comprobaciones de sintaxis JavaScript y de HTML indicadas arriba.
- No se ejecutó Electron con una ventana real ni se recompiló el APK Android.
- La integración es de lectura local: Codex requiere que sus rollouts contengan un evento `token_count` con `rate_limits`; si falta o está vencido, la interfaz muestra `--`/aviso de antigüedad.
- Para liberar los archivos a Claude y AGY, la reserva de este trabajo queda cerrada. Coordinar ediciones futuras por archivo antes de hacerlas; este documento no confirma que otras sesiones ya hayan visto la nota.

## AGY — corrección de detección 429, calibración de ventana 5h y estado post-reset, 2026-10-29

### Diagnóstico y correcciones aplicadas
- `src/collectors/agyQuotaStatus.js`:
  - **Filtro de falsos positivos en prompts de usuario**: se ignoran líneas de nivel `I` y registros de `input_loop.go` / `HandleUserInput` para que si el usuario cita el texto `"Quota pool exhausted"` en un prompt no se interprete como un nuevo error 429.
  - **Soporte para `Resets in 0s.`**: cuando el log informa `Resets in 0s.`, `delay === 0` ahora fija `resetAt = timestamp` en lugar de `null` (antes `delay > 0 ? ... : null` lo dejaba en `null` y forzaba 15 minutos extra de estado `exhausted` falso tras el reset).
  - **Detección de recuperación verificada (`state: 'recovered'`)**: se rastrean respuestas exitosas de `http_helpers.go` (`:streamGenerateContent?alt=sse ResponseID:`) posteriores a `observedAt` y el vencimiento de `resetAt`, pasando automáticamente de `exhausted` a `recovered` con `verifiedAfterReset: true` y `lastResetAt`.
  - **Inferencia de ventana (`window: '5h'`)**: plazos de reset `<= 5h` se asocian a la ventana rotativa de 5 horas.
- `src/collectors/agyCollector.js`:
  - Cuando `providerStatus.exhausted` es `true`, `fiveHourPct` pasa a `100%` y `nextFiveHourResetAt` adopta el timestamp oficial `providerStatus.resetAt`.
  - Tras cumplirse `lastResetAt` en las últimas 5h, contabiliza el nuevo ciclo desde el slot del reset manteniendo el techo configurado (`limit5hM = 25M`, acorde al pico histórico local de `25.17M` sin 429).
  - Se incluyó `providerStatus` en `topCacheKey` para invalidar la caché de inmediato al cambiar el estado de cuota.
- `src/public/app.js`:
  - Se agregaron `providerStatus` y `codexQuota` a `pillSig` y `summarySig`.
  - Las barras de 5h de AGY (`#pill-agy-fh`, `#kpi-agy-fh-bar`, `#agy-fh-bar`, `#aw-agy-fh`) muestran `100%` y `.fill-danger` cuando la cuota está agotada, y muestran `✅ Reseteada HH:MM` con el consumo del nuevo ciclo tras recuperarse.

## Auditoría completa y correcciones — 2026-10-30

Estado: aplicado por 8 agentes con archivos disjuntos; sólo `node --check` y pruebas aisladas. No se probó Electron, Android ni el túnel reales. Sin commits.

- **Seguridad servidor** (`server.js`, `remoteManager.js`, `tunnelManager.js`): bind 127.0.0.1 por defecto, token sólo por header/cookie HttpOnly, rate limit, ntfy con comandos firmados (formato `v1|…` documentado al inicio de `remoteManager.js`), APK fuera de estáticos (`/api/apk` con auth), snapshot sin token ni keyPath.
- **Seguridad local** (`remoteResponder.js`, `windowFocuser.js`, `hooksManager.js`, `fullscreenWatcher.js`, `main.js`): sin `shell:true`, allow-list de `quickAction`, sin autoelevación UAC, sandbox Electron.
- **Android** (`android/**`, `build-android-apk.js`): `null` → `--`, receptor no exportado, Bearer, firma v1 de ntfy, build sin rutas ni claves fijas, v1.3.1.
- **Collectors**: día local, recuperación AGY por modelo, TTL de datos oficiales, lectura incremental, cache de chat acotado, helpers `tokenWeights.js` y `leveldbWal.js`.
- **Frontend/docs**: marca "ant." para Claude vencido, carrera del chat, dedupe, accesibilidad, README/package.json/.gitattributes.

Pendiente: rotar token/topic y reconstruir APK (invalida el pairing del celular), Electron 35 → vigente, quitar `.exe` trackeados, tests de los parsers exportados, y `MainActivity.java:279` ("Actualizar APK") apunta a una ruta pública que ya no existe.

## Codex — contador de instancias, 2026-10-30

Responsable: sesión del contador. Alcance: src/services/processCounter.js, src/server.js, src/public/app.js (sólo contador y firmas), src/public/index.html, src/public/styles.css. Se conservan cambios previos; codexCollector.js y codexRateLimits.js quedan fuera del alcance. Estado: terminado, reserva cerrada. Validación: check 21/21 OK, diff sin errores y pruebas simuladas de filtros/caché/ciclo de vida OK. Ejecución real de 3 s: {"claude":0,"codex":0,"agy":0,"updatedAt":null}; Get-CimInstance devolvió acceso denegado en el entorno restringido. No se probó Electron visualmente.
