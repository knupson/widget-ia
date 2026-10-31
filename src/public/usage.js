(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.AIPulseUsage = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MINUTE_MS = 60 * 1000;
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;
  const CALENDAR_WEEKS = 26;

  // Intervalos máximos de actualización mientras la pestaña Uso está visible
  const HISTORY_POLL_INTERVAL_MS = 60 * 1000; // máx. cada 60s para /api/usage/history
  const PROJECTS_POLL_INTERVAL_MS = 5 * 60 * 1000; // máx. cada 5 min para /api/usage/projects
  const COMPUTING_RETRY_MS = 600; // reintento breve cuando el worker aún está calculando

  const MONTHS_ES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const WEEKDAYS_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  const SERIES_COLORS = {
    claude_5h: '#ff6b1a',
    claude_7d: '#e09f3e',
    codex_5h: '#10a37f',
    codex_7d: '#38bdf8'
  };

  function fmtCompactTokens(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '--';
    const num = Number(n);
    if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(num >= 10_000_000 ? 1 : 2)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(num >= 100_000 ? 0 : 1)}k`;
    return String(Math.round(num));
  }

  /**
   * Formatea un costo estimado en USD.
   * - Devuelve `'n/d'` cuando `costUsd` es `null` o inválido (modelo sin tarifa conocida).
   * - Si `options.partial` es `true` (mezcla de modelos con tarifa conocida y desconocida),
   *   agrega explícitamente el marcador `' (parcial)'` para no mostrarlo como total cerrado.
   */
  function fmtEstimatedUsd(costUsd, options = {}) {
    const isPartial = Boolean(options && options.partial);
    if (costUsd === null || costUsd === undefined || !Number.isFinite(Number(costUsd))) {
      return 'n/d';
    }
    const val = Number(costUsd);
    let formatted;
    if (val === 0) formatted = '~$0.00';
    else if (val < 0.01) formatted = '<~$0.01';
    else if (val >= 100) formatted = `~$${val.toFixed(1)}`;
    else formatted = `~$${val.toFixed(2)}`;
    return isPartial ? `${formatted} (parcial)` : formatted;
  }

  function fmtLocalDayKey(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function fmtSpanishDate(dayKey) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
    if (!m) return String(dayKey || '');
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const wd = WEEKDAYS_ES[dt.getDay()];
    const mon = MONTHS_ES[dt.getMonth()].toLowerCase();
    return `${wd} ${dt.getDate()} ${mon} ${dt.getFullYear()}`;
  }

  function fmtHourEs(hour) {
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) return '-- hs';
    return `${String(Math.floor(hour)).padStart(2, '0')}:00 hs`;
  }

  /**
   * Nivel de intensidad 0..4 para una celda del calendario de actividad.
   */
  function computeActivityLevel(tokens, maxTokens) {
    const t = Number(tokens) || 0;
    const max = Number(maxTokens) || 0;
    if (t <= 0 || max <= 0) return 0;
    const ratio = t / max;
    if (ratio < 0.15) return 1;
    if (ratio < 0.4) return 2;
    if (ratio < 0.7) return 3;
    return 4;
  }

  /**
   * Determina si el reporte presenta errores de lectura o falta de acceso a las fuentes.
   */
  function hasUsageSourceError(reportData) {
    if (!reportData || typeof reportData !== 'object') return true;
    if (reportData.lastError) return true;
    const cov = reportData.coverage;
    if (!cov || typeof cov !== 'object') return false;
    if (cov.status === 'error' || cov.status === 'partial') return true;
    if ((Number(cov.errorCount) || 0) > 0 || (Number(cov.unreadableFiles) || 0) > 0) return true;
    if ((Number(cov.sourcesConfigured) || 0) > 0 && (Number(cov.sourcesAvailable) || 0) === 0) {
      return true;
    }
    return false;
  }

  /**
   * Construye el texto de resumen del calendario de actividad distinguiendo entre
   * «sin actividad» y «sin datos» cuando no se pudo leer la fuente.
   */
  function formatActivitySummaryText(reportData) {
    if (!reportData || typeof reportData !== 'object') {
      return 'Sin datos (no se pudo leer la fuente de sesiones locales)';
    }
    if (reportData.computing && !reportData.updatedAt) {
      return 'Calculando uso de sesiones locales…';
    }
    const act = reportData.activity || { days: [], maxDailyTokens: 0, activeDaysCount: 0 };
    const cov = reportData.coverage || {};
    const sourceErr = hasUsageSourceError(reportData);

    const suffixes = [];
    if (reportData.stale) {
      suffixes.push('⚠️ desactualizado (sin datos nuevos por error de lectura)');
    } else if (cov.status === 'partial' || (Number(cov.unreadableFiles) || 0) > 0) {
      const unread = Number(cov.unreadableFiles) || Number(cov.errorCount) || 1;
      suffixes.push(`⚠️ cobertura parcial (${unread} sin leer)`);
    }
    if (reportData.computing) {
      suffixes.push('actualizando…');
    }
    const suffixTxt = suffixes.length > 0 ? ` · ${suffixes.join(' · ')}` : '';

    if (act.activeDaysCount > 0) {
      return `${act.activeDaysCount} días activos · Pico diario: ${fmtCompactTokens(act.maxDailyTokens)} tok${suffixTxt}`;
    }

    if (sourceErr) {
      return 'Sin datos (no se pudo leer la fuente de sesiones locales)';
    }

    return 'Sin actividad registrada en los últimos 6 meses';
  }

  /**
   * Construye el texto de detalle al pasar el cursor sobre una celda del calendario.
   * Muestra «sin datos» (y no «Sin actividad») cuando la fuente tuvo errores de lectura.
   */
  function formatCalendarCellTooltip(cell, reportData) {
    if (!cell) return '';
    const dateStr = fmtSpanishDate(cell.date);
    if ((cell.total || 0) > 0) {
      const peak = cell.peakHour !== null ? ` · Hora pico: ${fmtHourEs(cell.peakHour)}` : '';
      return `${dateStr}: ${fmtCompactTokens(cell.total)} tok (E: ${fmtCompactTokens(cell.input)} · S: ${fmtCompactTokens(cell.output)} · Caché: ${fmtCompactTokens((cell.cacheRead || 0) + (cell.cacheWrite || 0))})${peak}`;
    }
    if (hasUsageSourceError(reportData)) {
      return `${dateStr}: Sin datos (no se pudo leer la fuente)`;
    }
    return `${dateStr}: Sin actividad de tokens`;
  }

  /**
   * Controlador de generaciones de pedidos asíncronos para descartar respuestas fuera de orden
   * y cancelar solicitudes previas en vuelo mediante `AbortController`.
   */
  function createRequestTracker() {
    let currentGen = 0;
    let currentKey = '';
    let activeController = null;

    function begin(key = '') {
      if (activeController && typeof activeController.abort === 'function') {
        try {
          activeController.abort();
        } catch {}
      }
      currentGen += 1;
      currentKey = String(key || '');
      activeController = typeof AbortController !== 'undefined' ? new AbortController() : null;
      return {
        gen: currentGen,
        key: currentKey,
        signal: activeController ? activeController.signal : undefined
      };
    }

    function isCurrent(token, expectedKey = currentKey) {
      if (!token || typeof token !== 'object') return false;
      return token.gen === currentGen && token.key === String(expectedKey || '');
    }

    function cancel() {
      if (activeController && typeof activeController.abort === 'function') {
        try {
          activeController.abort();
        } catch {}
      }
      activeController = null;
      currentGen += 1;
    }

    return {
      begin,
      isCurrent,
      cancel,
      getCurrentGen: () => currentGen,
      getCurrentKey: () => currentKey
    };
  }

  /**
   * Genera la grilla de 26 semanas (Lunes = fila 0 ... Domingo = fila 6) terminando en `now`.
   */
  function buildCalendarGrid(activityDays, now = Date.now(), weeksCount = CALENDAR_WEEKS) {
    const byDate = new Map();
    let maxTokens = 0;
    if (Array.isArray(activityDays)) {
      for (const d of activityDays) {
        if (d && d.date && Number(d.total) > 0) {
          byDate.set(d.date, d);
          if (d.total > maxTokens) maxTokens = d.total;
        }
      }
    }

    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const todayKey = fmtLocalDayKey(today);

    // Lunes de la semana actual (0 = Lunes .. 6 = Domingo)
    const dowMon0 = (today.getDay() + 6) % 7;
    const thisMonday = new Date(today);
    thisMonday.setDate(today.getDate() - dowMon0);

    const startMonday = new Date(thisMonday);
    startMonday.setDate(thisMonday.getDate() - (weeksCount - 1) * 7);

    const cells = [];
    const months = [];
    let lastMonth = -1;
    let lastMonthWeek = -10;

    for (let w = 0; w < weeksCount; w++) {
      for (let d = 0; d < 7; d++) {
        const cur = new Date(startMonday);
        cur.setDate(startMonday.getDate() + w * 7 + d);
        if (cur > today) continue;

        if (d === 0) {
          const m = cur.getMonth();
          if (m !== lastMonth) {
            if (w - lastMonthWeek >= 2) {
              months.push({ week: w, label: MONTHS_ES[m] });
              lastMonthWeek = w;
            }
            lastMonth = m;
          }
        }

        const key = fmtLocalDayKey(cur);
        const rec = byDate.get(key) || null;
        const total = rec ? rec.total : 0;
        cells.push({
          week: w,
          dow: d,
          date: key,
          isToday: key === todayKey,
          total,
          input: rec ? rec.input || 0 : 0,
          output: rec ? rec.output || 0 : 0,
          cacheRead: rec ? rec.cacheRead || 0 : 0,
          cacheWrite: rec ? rec.cacheWrite || 0 : 0,
          peakHour: rec && Number.isFinite(rec.peakHour) ? rec.peakHour : null,
          level: computeActivityLevel(total, maxTokens)
        });
      }
    }

    return { weeksCount, maxTokens, cells, months };
  }

  /**
   * Genera marcas de tiempo redondeadas para el eje X del gráfico histórico según el rango.
   */
  function computeTimeTicks(range, fromMs, toMs) {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
    const d = new Date(fromMs);
    d.setSeconds(0, 0);

    let stepFn;
    let labelFn;

    if (range === '1h') {
      const m = d.getMinutes();
      d.setMinutes(m + ((15 - (m % 15)) % 15));
      stepFn = () => d.setMinutes(d.getMinutes() + 15);
      labelFn = () =>
        `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } else if (range === '24h') {
      if (d.getMinutes() > 0) d.setHours(d.getHours() + 1, 0);
      const h = d.getHours();
      d.setHours(h + ((4 - (h % 4)) % 4));
      stepFn = () => d.setHours(d.getHours() + 4);
      labelFn = () =>
        d.getHours() === 0
          ? WEEKDAYS_ES[d.getDay()]
          : `${String(d.getHours()).padStart(2, '0')}:00`;
    } else if (range === '7d') {
      if (d.getHours() > 0 || d.getMinutes() > 0) d.setDate(d.getDate() + 1);
      d.setHours(0, 0);
      stepFn = () => d.setDate(d.getDate() + 1);
      labelFn = () => `${WEEKDAYS_ES[d.getDay()]} ${d.getDate()}`;
    } else {
      // 30d -> cada lunes a las 00:00
      if (d.getHours() > 0 || d.getMinutes() > 0) d.setDate(d.getDate() + 1);
      d.setHours(0, 0);
      while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
      stepFn = () => d.setDate(d.getDate() + 7);
      labelFn = () => `${d.getDate()} ${MONTHS_ES[d.getMonth()]}`;
    }

    const ticks = [];
    for (let guard = 0; guard < 32 && d.getTime() <= toMs; guard++, stepFn()) {
      const t = d.getTime();
      if (t >= fromMs) {
        ticks.push({ t, label: labelFn() });
      }
    }
    return ticks;
  }

  /**
   * Texto explicativo cuando no hay suficientes muestras en el rango seleccionado.
   */
  function emptyHistoryMessage(sampleCount, intervalMin = 5) {
    if (sampleCount === 1) {
      return 'Hay 1 sola muestra oficial en este rango. La curva se dibuja a partir de la segunda lectura.';
    }
    const every = Number.isFinite(intervalMin) && intervalMin > 0 ? ` (cada ~${intervalMin} min)` : '';
    return `Todavía no hay muestras oficiales en este rango. Se guarda una lectura por ciclo${every} cuando Claude o Codex informan su cuota vigente.`;
  }

  // =========================================================
  // LÓGICA DE INTERFAZ EN EL NAVEGADOR
  // =========================================================
  if (typeof document !== 'undefined') {
    let activeRange = '24h';
    let lastHistoryData = null;
    let lastProjectsData = null;
    let lastHistoryFetchedAt = 0;
    let lastProjectsFetchedAt = 0;
    let historyInFlight = false;
    let projectsInFlight = false;
    let wasUsageTabVisible = false;
    let computingRetryTimer = null;

    const historyTracker = createRequestTracker();
    const projectsTracker = createRequestTracker();

    function getAuthToken() {
      try {
        const params = new URLSearchParams(window.location.search);
        return params.get('token') || localStorage.getItem('aiPulseAuthToken') || '';
      } catch {
        return '';
      }
    }

    async function fetchUsageJson(urlPath, { signal } = {}) {
      const token = getAuthToken();
      const headers = token ? { 'X-Auth-Token': token } : {};
      const res = await fetch(urlPath, { headers, credentials: 'same-origin', signal });
      if (!res.ok) return null;
      return res.json();
    }

    function escapeHtml(str) {
      return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function isUsageTabVisible() {
      const pane = document.getElementById('tab-usage');
      // Sólo la pestaña activa: el widget se muestra con showInactive() y Electron
      // puede reportar visibilityState 'hidden' con la ventana a la vista.
      return Boolean(pane && pane.classList.contains('active'));
    }

    function renderHistoryChart(histData) {
      const wrap = document.getElementById('usage-history-chart-wrap');
      const legendEl = document.getElementById('usage-history-legend');
      if (!wrap) return;

      const samples = (histData && Array.isArray(histData.samples) && histData.samples) || [];
      const series = (histData && Array.isArray(histData.series) && histData.series) || [];
      const range = (histData && histData.range) || activeRange;
      const fromMs = (histData && histData.from) || Date.now() - DAY_MS;
      const toMs = (histData && histData.to) || Date.now();

      if (legendEl) {
        if (series.length === 0) {
          legendEl.innerHTML = `<span class="muted-xs">Sin series oficiales registradas en ${escapeHtml(range)}</span>`;
        } else {
          legendEl.innerHTML = series
            .map((s) => {
              const color = SERIES_COLORS[s.key] || '#ff6b1a';
              const lastPt = s.points[s.points.length - 1];
              const pctTxt = lastPt && Number.isFinite(lastPt.p) ? `${Math.round(lastPt.p)}%` : '--%';
              return `<span class="usage-legend-item">
                <span class="usage-legend-dot" style="background:${color}"></span>
                <span>${escapeHtml(s.label)}</span>
                <strong style="color:${color}">${pctTxt}</strong>
              </span>`;
            })
            .join('');
        }
      }

      if (samples.length < 2 || series.length === 0) {
        const msg = emptyHistoryMessage(samples.length, histData && histData.sampleIntervalMin);
        wrap.innerHTML = `<div class="usage-empty-box">${escapeHtml(msg)}</div>`;
        return;
      }

      const W = 640;
      const H = 164;
      const padL = 32;
      const padR = 36;
      const padT = 12;
      const padB = 24;
      const plotW = W - padL - padR;
      const plotH = H - padT - padB;
      const span = Math.max(1, toMs - fromMs);

      const xOf = (t) => padL + Math.max(0, Math.min(1, (t - fromMs) / span)) * plotW;
      const yOf = (p) => padT + (1 - Math.max(0, Math.min(100, p)) / 100) * plotH;

      const yGrid = [0, 50, 100]
        .map((pct) => {
          const y = yOf(pct).toFixed(1);
          return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" class="usage-grid-line" />
                  <text x="${padL - 5}" y="${Number(y) + 3}" class="usage-axis-lbl" text-anchor="end">${pct}%</text>`;
        })
        .join('');

      const yWarn = yOf(80).toFixed(1);
      const warnLine = `<line x1="${padL}" y1="${yWarn}" x2="${W - padR}" y2="${yWarn}" class="usage-warn-line" />`;

      const ticks = computeTimeTicks(range, fromMs, toMs);
      const xGrid = ticks
        .map((tk) => {
          const x = xOf(tk.t).toFixed(1);
          return `<line x1="${x}" y1="${padT}" x2="${x}" y2="${H - padB}" class="usage-grid-vline" />
                  <text x="${x}" y="${H - 6}" class="usage-axis-lbl" text-anchor="middle">${escapeHtml(tk.label)}</text>`;
        })
        .join('');

      const pathsHtml = series
        .map((s) => {
          const color = SERIES_COLORS[s.key] || '#ff6b1a';
          const runs = Array.isArray(s.runs) && s.runs.length ? s.runs : [s.points];
          const segs = runs
            .map((run) => {
              if (!run || run.length === 0) return '';
              if (run.length === 1) {
                const cx = xOf(run[0].t).toFixed(1);
                const cy = yOf(run[0].p).toFixed(1);
                return `<circle cx="${cx}" cy="${cy}" r="2.6" fill="${color}" />`;
              }
              const d = run
                .map((pt, idx) => `${idx === 0 ? 'M' : 'L'}${xOf(pt.t).toFixed(1)},${yOf(pt.p).toFixed(1)}`)
                .join(' ');
              return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />`;
            })
            .join('');

          const lastPt = s.points[s.points.length - 1];
          const tip = lastPt
            ? `<circle cx="${xOf(lastPt.t).toFixed(1)}" cy="${yOf(lastPt.p).toFixed(1)}" r="3.2" fill="${color}" />
               <text x="${(xOf(lastPt.t) + 5).toFixed(1)}" y="${(yOf(lastPt.p) + 3).toFixed(1)}" class="usage-tip-lbl" fill="${color}">${escapeHtml(s.shortLabel || s.label)}</text>`
            : '';
          return `<g data-series="${escapeHtml(s.key)}">${segs}${tip}</g>`;
        })
        .join('');

      wrap.innerHTML = `
        <div class="usage-svg-container">
          <svg id="usage-history-svg" class="usage-history-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
            ${yGrid}
            ${warnLine}
            ${xGrid}
            ${pathsHtml}
            <line id="usage-hover-line" x1="0" y1="${padT}" x2="0" y2="${H - padB}" class="usage-hover-line hidden" />
          </svg>
          <div id="usage-history-tooltip" class="usage-floating-tip hidden"></div>
        </div>
      `;

      const svgEl = document.getElementById('usage-history-svg');
      const hoverLine = document.getElementById('usage-hover-line');
      const tipEl = document.getElementById('usage-history-tooltip');
      if (!svgEl || !hoverLine || !tipEl) return;

      svgEl.addEventListener('mousemove', (ev) => {
        const rect = svgEl.getBoundingClientRect();
        if (!rect.width) return;
        const relX = ((ev.clientX - rect.left) / rect.width) * W;
        const targetTs = fromMs + Math.max(0, Math.min(1, (relX - padL) / plotW)) * span;

        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < samples.length; i++) {
          const dist = Math.abs(samples[i].t - targetTs);
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
          }
        }
        const sample = samples[bestIdx];
        if (!sample) return;

        const sx = xOf(sample.t);
        hoverLine.setAttribute('x1', sx.toFixed(1));
        hoverLine.setAttribute('x2', sx.toFixed(1));
        hoverLine.classList.remove('hidden');

        const dt = new Date(sample.t);
        const dtStr = `${WEEKDAYS_ES[dt.getDay()]} ${dt.getDate()} ${MONTHS_ES[dt.getMonth()]} · ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
        const rows = series
          .map((s) => {
            const v = (sample.v || []).find((item) => item.k === s.key);
            if (!v || !Number.isFinite(v.p)) return '';
            const c = SERIES_COLORS[s.key] || '#ff6b1a';
            return `<div class="usage-tip-row"><span style="color:${c}">● ${escapeHtml(s.label)}</span><strong>${Math.round(v.p)}%</strong></div>`;
          })
          .filter(Boolean)
          .join('');

        tipEl.innerHTML = `<div class="usage-tip-head">${escapeHtml(dtStr)}</div>${rows}`;
        tipEl.classList.remove('hidden');
        const leftPct = Math.min(72, Math.max(4, ((sx - padL) / plotW) * 100));
        tipEl.style.left = `${leftPct}%`;
      });

      svgEl.addEventListener('mouseleave', () => {
        hoverLine.classList.add('hidden');
        tipEl.classList.add('hidden');
      });
    }

    function renderActivityHeatmap(reportData) {
      const wrap = document.getElementById('usage-activity-heatmap-wrap');
      const sumEl = document.getElementById('usage-activity-summary');
      if (!wrap) return;

      const act = (reportData && reportData.activity) || { days: [], maxDailyTokens: 0, activeDaysCount: 0 };
      const grid = buildCalendarGrid(act.days || [], Date.now(), CALENDAR_WEEKS);

      if (sumEl) {
        sumEl.textContent = formatActivitySummaryText(reportData);
      }

      const cell = 12;
      const step = 15;
      const padL = 28;
      const padT = 16;
      const W = padL + grid.weeksCount * step + 4;
      const H = padT + 7 * step + 4;

      const dayLabels = [
        { row: 0, text: 'Lun' },
        { row: 2, text: 'Mié' },
        { row: 4, text: 'Vie' }
      ]
        .map(
          (d) =>
            `<text x="0" y="${padT + d.row * step + 9}" class="usage-cal-lbl">${d.text}</text>`
        )
        .join('');

      const monthLabels = grid.months
        .map(
          (m) =>
            `<text x="${padL + m.week * step}" y="11" class="usage-cal-lbl">${escapeHtml(m.label)}</text>`
        )
        .join('');

      const rects = grid.cells
        .map((c, idx) => {
          const x = padL + c.week * step;
          const y = padT + c.dow * step;
          const cls = `usage-cal-cell level-${c.level}${c.isToday ? ' is-today' : ''}`;
          return `<rect class="${cls}" data-idx="${idx}" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2.5" />`;
        })
        .join('');

      const footerHint = hasUsageSourceError(reportData)
        ? '⚠️ Fuente con errores de lectura (los días vacíos se informan como sin datos)'
        : 'Pasá el cursor sobre un día para ver el detalle y hora pico';

      wrap.innerHTML = `
        <div class="usage-cal-container">
          <svg id="usage-cal-svg" class="usage-cal-svg" viewBox="0 0 ${W} ${H}">
            ${monthLabels}
            ${dayLabels}
            ${rects}
          </svg>
          <div class="usage-cal-footer">
            <span id="usage-cal-hover-info" class="muted-xs">${escapeHtml(footerHint)}</span>
            <div class="usage-cal-scale">
              <span class="muted-xs">Menos</span>
              <span class="usage-scale-box level-0"></span>
              <span class="usage-scale-box level-1"></span>
              <span class="usage-scale-box level-2"></span>
              <span class="usage-scale-box level-3"></span>
              <span class="usage-scale-box level-4"></span>
              <span class="muted-xs">Más</span>
            </div>
          </div>
        </div>
      `;

      const svgEl = document.getElementById('usage-cal-svg');
      const infoEl = document.getElementById('usage-cal-hover-info');
      if (!svgEl || !infoEl) return;

      svgEl.addEventListener('mouseover', (ev) => {
        const rectEl = ev.target.closest('rect[data-idx]');
        if (!rectEl) return;
        const c = grid.cells[Number(rectEl.dataset.idx)];
        if (!c) return;
        infoEl.textContent = formatCalendarCellTooltip(c, reportData);
      });
    }

    function renderProjectsTable(reportData) {
      const tbody = document.getElementById('usage-projects-tbody');
      const totalsBadge = document.getElementById('usage-projects-totals');
      const noteEl = document.getElementById('usage-pricing-note');
      if (!tbody) return;

      const projects = (reportData && Array.isArray(reportData.projects) && reportData.projects) || [];
      const totals = (reportData && reportData.totals) || {
        tokens: { total: 0 },
        estimatedCostUsd: 0,
        costPartial: false,
        unpricedModels: []
      };
      const pricing = (reportData && reportData.pricing) || { asOf: '2026-10-30', unpricedModels: [] };
      const sourceErr = hasUsageSourceError(reportData);

      if (totalsBadge) {
        const totalTok = totals.tokens ? totals.tokens.total : 0;
        const costTxt = fmtEstimatedUsd(totals.estimatedCostUsd, { partial: Boolean(totals.costPartial) });
        const statusFlag =
          reportData && reportData.stale
            ? ' · desactualizado'
            : reportData && reportData.computing
              ? ' · calculando…'
              : '';
        totalsBadge.textContent = `${projects.length} proy. · ${fmtCompactTokens(totalTok)} tok · ${costTxt} est.${statusFlag}`;
      }

      if (noteEl && pricing.asOf) {
        const unpriced = Array.isArray(pricing.unpricedModels) ? pricing.unpricedModels : [];
        const unpricedSuffix =
          unpriced.length > 0
            ? ` ⚠️ Sin tarifa verificada para: ${unpriced.join(', ')} (costo marcado como parcial o n/d).`
            : '';
        noteEl.textContent = `💡 Costo en USD estimado por modelo y versión (incluye caché 5m a 1.25x y 1h a 2x; fuente verificada ${pricing.asOf}). Los planes Pro/Max/Team no cobran por token.${unpricedSuffix}`;
      }

      if (projects.length === 0) {
        if (reportData && reportData.computing && !reportData.updatedAt) {
          tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Escaneando sesiones locales en segundo plano…</td></tr>`;
        } else if (sourceErr) {
          tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Sin datos: no se pudo leer la fuente de sesiones locales.</td></tr>`;
        } else {
          tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No se encontraron sesiones con consumo de tokens en los últimos 6 meses.</td></tr>`;
        }
        return;
      }

      const maxProjTokens = Math.max(1, projects[0].tokens.total || 1);

      tbody.innerHTML = projects
        .map((p) => {
          const t = p.tokens || {};
          const barPct = Math.max(2, Math.min(100, Math.round(((t.total || 0) / maxProjTokens) * 100)));
          const provPills = (p.providers || [])
            .map((prov) => {
              const cls = prov === 'codex' ? 'prov-codex' : 'prov-claude';
              return `<span class="provider-pill ${cls}" style="font-size:8.5px;padding:1px 4px">${escapeHtml(prov.toUpperCase())}</span>`;
            })
            .join(' ');
          const modelsList = (p.models || [])
            .slice(0, 3)
            .map((m) => `${m.model} (${fmtCompactTokens(m.tokens.total)})`)
            .join(' · ');
          const sessTxt = `${p.sessions || 1} ${(p.sessions || 1) === 1 ? 'sesión' : 'sesiones'}`;
          const write5m = t.cacheWrite5m !== undefined ? t.cacheWrite5m : t.cacheWrite || 0;
          const write1h = t.cacheWrite1h || 0;
          const cacheTip =
            write1h > 0
              ? `Lectura: ${fmtCompactTokens(t.cacheRead || 0)} · Escritura 5m: ${fmtCompactTokens(write5m)} · Escritura 1h: ${fmtCompactTokens(write1h)}`
              : `Lectura: ${fmtCompactTokens(t.cacheRead || 0)} · Escritura: ${fmtCompactTokens(t.cacheWrite || 0)}`;

          const costTxt = fmtEstimatedUsd(p.estimatedCostUsd, { partial: Boolean(p.costPartial) });
          const unpricedList = Array.isArray(p.unpricedModels) ? p.unpricedModels : [];
          const costTitle =
            unpricedList.length > 0
              ? `Sin tarifa verificada para: ${unpricedList.join(', ')}`
              : '';

          return `
            <tr title="${escapeHtml(p.path || p.name)}\nModelos: ${escapeHtml(modelsList)}">
              <td>
                <div class="usage-proj-cell">
                  <div class="usage-proj-top">
                    <strong class="usage-proj-name">${escapeHtml(p.name)}</strong>
                    ${provPills}
                  </div>
                  <div class="usage-proj-sub muted-xs">${escapeHtml(sessTxt)}${modelsList ? ` · ${escapeHtml(modelsList)}` : ''}</div>
                  <div class="usage-proj-bar"><div class="usage-proj-bar-fill" style="width:${barPct}%"></div></div>
                </div>
              </td>
              <td>${fmtCompactTokens(t.input || 0)}</td>
              <td>${fmtCompactTokens(t.output || 0)}</td>
              <td title="${escapeHtml(cacheTip)}">${fmtCompactTokens((t.cacheRead || 0) + (t.cacheWrite || 0))}</td>
              <td><strong>${fmtCompactTokens(t.total || 0)}</strong></td>
              <td class="usage-cost-cell"${costTitle ? ` title="${escapeHtml(costTitle)}"` : ''}>${escapeHtml(costTxt)}</td>
            </tr>
          `;
        })
        .join('');
    }

    async function refreshHistory({ force = false, range = activeRange } = {}) {
      const targetRange = range || activeRange;
      const now = Date.now();
      if (
        !force &&
        lastHistoryData &&
        lastHistoryData.range === targetRange &&
        now - lastHistoryFetchedAt < HISTORY_POLL_INTERVAL_MS
      ) {
        return;
      }
      if (!force && historyInFlight && historyTracker.getCurrentKey() === targetRange) {
        return;
      }

      const token = historyTracker.begin(targetRange);
      historyInFlight = true;
      try {
        const hist = await fetchUsageJson(
          `/api/usage/history?range=${encodeURIComponent(targetRange)}`,
          { signal: token.signal }
        );
        // Descartar respuesta si llegó fuera de orden o si el usuario ya cambió de rango
        if (!hist || !historyTracker.isCurrent(token, activeRange)) {
          return;
        }
        if (hist.range && hist.range !== activeRange) {
          return;
        }
        lastHistoryData = hist;
        lastHistoryFetchedAt = Date.now();
        renderHistoryChart(hist);
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        console.error('[AI Pulse Uso] Error cargando historial:', err);
      } finally {
        if (historyTracker.isCurrent(token, activeRange)) {
          historyInFlight = false;
        }
      }
    }

    function scheduleComputingFollowUp() {
      if (computingRetryTimer) return;
      computingRetryTimer = setTimeout(() => {
        computingRetryTimer = null;
        if (!isUsageTabVisible()) return;
        refreshProjects({ force: false, isFollowUp: true });
      }, COMPUTING_RETRY_MS);
    }

    async function refreshProjects({ force = false, onOpen = false, isFollowUp = false } = {}) {
      const now = Date.now();
      if (
        !force &&
        !onOpen &&
        !isFollowUp &&
        lastProjectsData &&
        now - lastProjectsFetchedAt < PROJECTS_POLL_INTERVAL_MS
      ) {
        return;
      }
      if (!force && projectsInFlight) {
        return;
      }

      const token = projectsTracker.begin('projects');
      projectsInFlight = true;
      try {
        const proj = await fetchUsageJson(`/api/usage/projects${force ? '?force=1' : ''}`, {
          signal: token.signal
        });
        if (!proj || !projectsTracker.isCurrent(token, 'projects')) {
          return;
        }
        lastProjectsData = proj;
        lastProjectsFetchedAt = Date.now();
        renderActivityHeatmap(proj);
        renderProjectsTable(proj);

        if (proj.computing && isUsageTabVisible()) {
          scheduleComputingFollowUp();
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        console.error('[AI Pulse Uso] Error cargando proyectos:', err);
      } finally {
        if (projectsTracker.isCurrent(token, 'projects')) {
          projectsInFlight = false;
        }
      }
    }

    async function refreshUsageView({ force = false, onOpen = false } = {}) {
      if (!force && !isUsageTabVisible()) return;
      await Promise.all([
        refreshHistory({ force, range: activeRange }),
        refreshProjects({ force, onOpen })
      ]);
    }

    function initUsageUi() {
      // Botones de rango (1h / 24h / 7d / 30d)
      document.querySelectorAll('[data-usage-range]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const r = btn.dataset.usageRange;
          if (!r) return;
          activeRange = r;
          document.querySelectorAll('[data-usage-range]').forEach((b) => {
            b.classList.toggle('active', b.dataset.usageRange === activeRange);
          });
          refreshHistory({ force: true, range: activeRange });
        });
      });

      document.getElementById('btn-usage-refresh')?.addEventListener('click', () => {
        refreshUsageView({ force: true });
      });

      // Al abrir la pestaña Uso, cargar inmediatamente (/api/usage/projects y /api/usage/history)
      document.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (btn.dataset.tab === 'usage') {
            wasUsageTabVisible = true;
            setTimeout(() => refreshUsageView({ force: false, onOpen: true }), 10);
          } else {
            wasUsageTabVisible = false;
            if (computingRetryTimer) {
              clearTimeout(computingRetryTimer);
              computingRetryTimer = null;
            }
          }
        });
      });
    }

    window.renderUsageTab = () => {
      const visible = isUsageTabVisible();
      if (!visible) {
        wasUsageTabVisible = false;
        return;
      }
      const justOpened = !wasUsageTabVisible;
      wasUsageTabVisible = true;
      refreshUsageView({ force: false, onOpen: justOpened });
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initUsageUi);
    } else {
      initUsageUi();
    }
  }

  return {
    CALENDAR_WEEKS,
    HISTORY_POLL_INTERVAL_MS,
    PROJECTS_POLL_INTERVAL_MS,
    SERIES_COLORS,
    fmtCompactTokens,
    fmtEstimatedUsd,
    fmtLocalDayKey,
    fmtSpanishDate,
    fmtHourEs,
    computeActivityLevel,
    hasUsageSourceError,
    formatActivitySummaryText,
    formatCalendarCellTooltip,
    createRequestTracker,
    buildCalendarGrid,
    computeTimeTicks,
    emptyHistoryMessage
  };
});
