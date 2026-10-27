/* =========================================================
   AI Pulse Widget · Frontend Controller (Pill HUD + Dashboard)
   Diseño Naranja / Ocre / Negro + Telemetría Dual Claude & AGY
   ========================================================= */

(function () {
  const isElectron = Boolean(window.electronAPI);
  const urlParams = new URLSearchParams(window.location.search);
  const isWebMode = urlParams.get('mode') === 'web' || !isElectron;

  let currentState = null;
  let activeFilter = 'open';
  let searchQuery = '';
  let activeTab = 'sessions';
  let audioCtx = null;

  // Consolas fijadas (Pin) guardadas en localStorage
  let pinnedIds = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem('aiPulsePinned') || '[]');
    if (Array.isArray(saved)) pinnedIds = new Set(saved);
  } catch {}

  function togglePinSession(id) {
    if (pinnedIds.has(id)) {
      pinnedIds.delete(id);
    } else {
      pinnedIds.add(id);
    }
    try {
      localStorage.setItem('aiPulsePinned', JSON.stringify([...pinnedIds]));
    } catch {}
    if (currentState) renderSessionsList(currentState);
  }

  // Inicializar modo visual del body de forma 100% segura
  try {
    if (isWebMode) {
      document.body.classList.remove('mode-pill', 'mode-expanded');
      document.body.classList.add('mode-web');
      document.getElementById('btn-collapse-pill')?.classList.add('hidden');
      document.getElementById('btn-hide-tray')?.classList.add('hidden');
      document.getElementById('btn-open-web')?.classList.add('hidden');
    } else if (window.electronAPI) {
      const getModeFn = window.electronAPI.getMode || window.electronAPI.getWindowMode;
      if (typeof getModeFn === 'function') {
        Promise.resolve(getModeFn.call(window.electronAPI))
          .then((mode) => applyWindowModeClass(mode))
          .catch(() => {});
      }
      const onModeFn = window.electronAPI.onModeChanged || window.electronAPI.onWindowModeChanged;
      if (typeof onModeFn === 'function') {
        onModeFn.call(window.electronAPI, (mode) => applyWindowModeClass(mode));
      }
    }
  } catch (err) {
    console.warn('Error inicializando modo Electron:', err);
  }

  function applyWindowModeClass(mode) {
    if (isWebMode) return;
    document.body.classList.remove('mode-pill', 'mode-expanded');
    document.body.classList.add(mode === 'expanded' ? 'mode-expanded' : 'mode-pill');
  }

  async function requestWindowMode(mode) {
    applyWindowModeClass(mode);
    try {
      const setModeFn =
        window.electronAPI && (window.electronAPI.setMode || window.electronAPI.setWindowMode);
      if (typeof setModeFn === 'function') {
        await setModeFn.call(window.electronAPI, mode);
      }
    } catch {}
    await apiPost('/api/window/control', { mode });
  }

  // =========================================================
  // SINTETIZADOR DE SONIDO WEBAUDIO
  // =========================================================
  function getAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function playNote(ctx, freq, startTime, duration, type = 'sine', maxGain = 0.14) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, startTime);

    gain.gain.setValueAtTime(0.001, startTime);
    gain.gain.exponentialRampToValueAtTime(maxGain, startTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration);
  }

  function playAlertSound(toneName = 'chime', isUrgent = false) {
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;

      if (isUrgent) {
        playNote(ctx, 587.33, now, 0.16, 'triangle', 0.18);
        playNote(ctx, 880.0, now + 0.14, 0.28, 'triangle', 0.2);
        return;
      }

      switch (toneName) {
        case 'reset':
          playNote(ctx, 523.25, now, 0.16, 'triangle', 0.16);
          playNote(ctx, 659.25, now + 0.11, 0.18, 'triangle', 0.16);
          playNote(ctx, 783.99, now + 0.22, 0.22, 'triangle', 0.18);
          playNote(ctx, 1046.5, now + 0.34, 0.55, 'sine', 0.2);
          break;
        case 'bell':
          playNote(ctx, 783.99, now, 0.45, 'sine', 0.16);
          playNote(ctx, 1174.66, now + 0.08, 0.55, 'sine', 0.12);
          break;
        case 'radar':
          playNote(ctx, 523.25, now, 0.11, 'sine', 0.14);
          playNote(ctx, 659.25, now + 0.11, 0.11, 'sine', 0.14);
          playNote(ctx, 783.99, now + 0.22, 0.25, 'sine', 0.16);
          break;
        case 'double':
          playNote(ctx, 880, now, 0.1, 'sine', 0.14);
          playNote(ctx, 880, now + 0.15, 0.14, 'sine', 0.14);
          break;
        case 'chime':
        default:
          playNote(ctx, 523.25, now, 0.28, 'sine', 0.13);
          playNote(ctx, 659.25, now + 0.09, 0.32, 'sine', 0.13);
          playNote(ctx, 987.77, now + 0.18, 0.45, 'sine', 0.15);
          break;
      }
    } catch {}
  }

  // =========================================================
  // UTILIDADES DE FORMATO
  // =========================================================
  function fmtNumber(num) {
    const n = Number(num) || 0;
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return String(Math.round(n));
  }

  function fmtRelativeTime(ts) {
    if (!ts) return '';
    const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diffSec < 10) return 'ahora';
    if (diffSec < 60) return `${diffSec}s`;
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showToast(msg = 'Copiado al portapapeles') {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      t.classList.add('hidden');
    }, 2000);
  }

  async function copyText(text, label = 'Copiado al portapapeles') {
    try {
      const fn =
        window.electronAPI &&
        (window.electronAPI.copyText || window.electronAPI.copyToClipboard);
      if (typeof fn === 'function') {
        await fn.call(window.electronAPI, text);
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      }
      showToast(label);
    } catch {}
  }

  async function apiPost(endpoint, body = {}) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Salta directamente a la primera consola que esté esperando respuesta o permiso
  async function jumpToFirstReadySession() {
    if (!currentState || !Array.isArray(currentState.sessions)) return;
    const target = currentState.sessions.find(
      (s) => s.isOpen && !s.isRemote && (s.state === 'waiting_approval' || s.state === 'waiting_input')
    );
    if (!target) {
      showToast('No hay consolas locales esperando respuesta');
      return;
    }
    await apiPost('/api/sessions/focus', {
      id: target.id,
      sessionId: target.sessionId || target.id,
      pid: target.pid || null,
      provider: target.provider,
      surface: target.surface || 'cli',
      workspace: target.workspace || '',
      title: target.projectName || target.title || ''
    });
    showToast(`🎯 Enfocando ${target.projectName || target.title}`);
  }

  function fmtDateTimeShort(ts) {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
      const day = dayNames[d.getDay()];
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      return `${day} ${dd}/${mm} ${hh}:${mi}`;
    } catch {
      return '';
    }
  }

  function fmtTimeShort(ts) {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      return `${hh}:${mi}`;
    } catch {
      return '';
    }
  }

  function fmtCountdown(targetTs) {
    if (!targetTs) return '';
    const diffMs = targetTs - Date.now();
    if (diffMs <= 0) return 'inminente';
    const totalHours = Math.floor(diffMs / 3_600_000);
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    const mins = Math.floor((diffMs % 3_600_000) / 60_000);
    if (days > 0) return `en ${days}d ${hours}h`;
    if (hours > 0) return `en ${hours}h ${mins}m`;
    return `en ${mins}m`;
  }

  function fmtCountdownShort(targetTs) {
    if (!targetTs) return '--';
    const diffMs = targetTs - Date.now();
    if (diffMs <= 0) return 'ahora';
    const totalHours = Math.floor(diffMs / 3_600_000);
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    const mins = Math.floor((diffMs % 3_600_000) / 60_000);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  // Resuelve la cuota de Claude junto con el detector de Reseteo Semanal y Reseteo Gratis (Bonus)
  function resolveClaudeQuota(data) {
    const pq = (data && data.planQuota) || {};
    const now = Date.now();
    const currSd = typeof pq.sevenDayPct === 'number' ? pq.sevenDayPct : 0;

    // Filtrar únicamente reseteos recientes (últimas 24h y cuyo ahorro siga vigente)
    // para evitar mostrar regalos de semanas/días pasados ya consumidos
    const rawResets = Array.isArray(pq.resets) ? pq.resets : [];
    const recentResets = rawResets.filter(
      (r) => r && r.timestamp && now - r.timestamp < 24 * 3600 * 1000 && currSd < (r.fromPct || 100)
    );

    const lastReset = recentResets[0] || null;
    const lastBonusReset =
      recentResets.find(
        (r) => r.isBonus && now - r.timestamp < 12 * 3600 * 1000 && currSd < 50
      ) || null;

    return {
      ...pq,
      resets: recentResets,
      lastReset,
      lastBonusReset
    };
  }

  function drawSparklineSvg(svgEl, hist, color5h, color7d) {
    if (!svgEl) return;
    if (!Array.isArray(hist) || hist.length < 2) {
      svgEl.innerHTML = `<line x1="0" y1="23" x2="400" y2="23" stroke="rgba(224,159,62,0.12)" stroke-dasharray="3,3" />`;
      return;
    }
    const w = 400;
    const h = 46;
    const pad = 4;

    const ptsFh = hist
      .map((pt, idx) => {
        const x = (idx / (hist.length - 1)) * (w - pad * 2) + pad;
        const y = h - pad - (Math.min(100, pt.fh || 0) / 100) * (h - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

    const ptsSd = hist
      .map((pt, idx) => {
        const x = (idx / (hist.length - 1)) * (w - pad * 2) + pad;
        const y = h - pad - (Math.min(100, pt.sd || 0) / 100) * (h - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

    svgEl.innerHTML = `
      <line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" stroke="rgba(224,159,62,0.12)" stroke-dasharray="3,3" />
      <polyline fill="none" stroke="${color7d}" stroke-width="1.8" opacity="0.85" points="${ptsSd}" />
      <polyline fill="none" stroke="${color5h}" stroke-width="2.1" points="${ptsFh}" />
    `;
  }

  // Sintetiza o resuelve la telemetría de cuota AGY (compatible en caliente sin reiniciar proceso)
  function resolveAgyQuota(data) {
    if (data && data.agyQuota && data.agyQuota.available) {
      return data.agyQuota;
    }
    const cfg = (data && data.config) || {};
    const fiveHourLimit = (Number(cfg.agyFiveHourLimitM) || 25) * 1_000_000;
    const sevenDayLimit = (Number(cfg.agySevenDayLimitM) || 100) * 1_000_000;

    const todayAgy = data?.analytics?.today?.agy || { total: 0, effective: 0, turns: 0, cacheRead: 0 };
    const weeklyAgy = data?.analytics?.weekly?.agy || { total: 0, effective: 0, turns: 0, cacheRead: 0 };

    const now = Date.now();
    const fiveHoursAgo = now - 5 * 3600 * 1000;
    const agySessions5h = (data?.sessions || []).filter(
      (s) => s.provider === 'agy' && (s.updatedAt || 0) >= fiveHoursAgo
    );

    let fhTotal = 0;
    let fhEffective = 0;
    let fhTurns = 0;
    for (const s of agySessions5h) {
      fhTotal += s.tokens?.total || 0;
      fhEffective += s.tokens?.effective || 0;
      fhTurns += s.tokens?.turns || s.turns || 0;
    }
    if (fhTotal === 0 && todayAgy.total > 0) {
      fhTotal = Math.round(todayAgy.total * 0.45);
      fhEffective = Math.round(todayAgy.effective * 0.45);
      fhTurns = Math.round((todayAgy.turns || 0) * 0.45);
    }

    const fiveHourPct = Math.min(100, Math.round((fhEffective / Math.max(1, fiveHourLimit)) * 100));
    const sevenDayPct = Math.min(
      100,
      Math.round(((weeklyAgy.effective || 0) / Math.max(1, sevenDayLimit)) * 100)
    );

    const cacheRead7d =
      weeklyAgy.cacheRead || Math.max(0, (weeklyAgy.total || 0) - (weeklyAgy.effective || 0));
    const cacheHitPct =
      weeklyAgy.total > 0 ? Math.round((cacheRead7d / weeklyAgy.total) * 100) : 0;

    const tl = data?.analytics?.timeline || [];
    const history = tl.map((d) => {
      const dayEff = d.agy?.effective || 0;
      return {
        t: d.date,
        fh: Math.min(100, Math.round(((dayEff / 3) / Math.max(1, fiveHourLimit)) * 100)),
        sd: sevenDayPct
      };
    });

    return {
      available: true,
      fiveHourPct,
      sevenDayPct,
      fiveHour: { total: fhTotal, effective: fhEffective, turns: fhTurns },
      sevenDay: {
        total: weeklyAgy.total || 0,
        effective: weeklyAgy.effective || 0,
        turns: weeklyAgy.turns || 0
      },
      burnRatePerHour: Math.round(fhTotal / 5),
      cacheHitPct,
      model: 'Gemini 4 Argon (High)',
      gcpProject: 'GCP-Workspace',
      history
    };
  }

  function compactStateLabel(s) {
    const map = {
      waiting_approval: 'Permiso',
      waiting_input: 'Lista',
      running: 'Activa',
      closed: 'Cerrada'
    };
    return map[s.state] || s.stateLabel || s.state;
  }

  // =========================================================
  // RENDERIZADO: PÍLDORA COMPACTA (MODO 1)
  // =========================================================
  function renderPill(data) {
    const sum = data.summary || {};
    const clQuota = resolveClaudeQuota(data);
    const agyQuota = resolveAgyQuota(data);
    const pillView = document.getElementById('pill-view');
    const orb = document.getElementById('pill-orb');
    const headerOrb = document.getElementById('header-orb');

    const waitingTotal = (sum.waitingInput || 0) + (sum.waitingApproval || 0);
    document.getElementById('pill-waiting-count').textContent = sum.waitingInput || 0;
    document.getElementById('pill-approval-count').textContent = sum.waitingApproval || 0;
    document.getElementById('pill-running-count').textContent = sum.running || 0;

    const wrapWaiting = document.getElementById('pill-waiting-wrap');
    const wrapApproval = document.getElementById('pill-approval-wrap');
    const wrapRunning = document.getElementById('pill-running-wrap');

    wrapWaiting.classList.toggle('has-items', (sum.waitingInput || 0) > 0);
    wrapRunning.classList.toggle('has-items', (sum.running || 0) > 0);
    wrapApproval.classList.toggle('hidden', (sum.waitingApproval || 0) === 0);

    // Botón mágico de salto directo en píldora y header
    document.getElementById('pill-btn-jump')?.classList.toggle('hidden', waitingTotal === 0);
    document.getElementById('btn-jump-ready')?.classList.toggle('hidden', waitingTotal === 0);

    // Estado del orbe y resplandor
    pillView.classList.remove('glow-green', 'glow-amber');
    orb.className = 'pill-orb';
    headerOrb.className = 'header-orb';

    if ((sum.waitingApproval || 0) > 0) {
      pillView.classList.add('glow-amber');
      orb.classList.add('state-approval');
      headerOrb.classList.add('state-approval');
    } else if ((sum.unreadAlertsCount || 0) > 0 || (sum.waitingInput || 0) > 0) {
      if ((sum.unreadAlertsCount || 0) > 0) {
        pillView.classList.add('glow-green');
      }
      orb.classList.add('state-ready');
      headerOrb.classList.add('state-ready');
    } else if ((sum.running || 0) > 0) {
      orb.classList.add('state-running');
      headerOrb.classList.add('state-running');
    }

    // Cuota Claude en Píldora
    const clFh = clQuota.fiveHourPct != null ? clQuota.fiveHourPct : 0;
    const clSd = clQuota.sevenDayPct != null ? clQuota.sevenDayPct : 0;
    const clFhEl = document.getElementById('pill-cl-fh');
    const clSdEl = document.getElementById('pill-cl-sd');
    if (clFhEl) clFhEl.style.width = `${Math.min(100, clFh)}%`;
    if (clSdEl) {
      clSdEl.style.width = `${Math.min(100, clSd)}%`;
      clSdEl.classList.toggle('fill-danger', clSd >= 90);
    }
    document.getElementById('pill-cl-fh-txt').textContent = clQuota.fiveHourPct != null ? `${clFh}%` : '--%';
    document.getElementById('pill-cl-sd-txt').textContent = clQuota.sevenDayPct != null ? `${clSd}%` : '--%';

    const clResetBadge = document.getElementById('pill-cl-reset-badge');
    const clResetTimer = document.getElementById('pill-cl-reset-timer');
    const pillClBox = document.getElementById('pill-claude-box');
    const bonusR = clQuota.lastBonusReset;
    if (clResetTimer) {
      const primaryReset = clQuota.nextFiveHourResetAt || clQuota.nextWeeklyResetAt;
      clResetTimer.textContent = primaryReset ? `⏳${fmtCountdownShort(primaryReset)}` : '';
    }
    if (clResetBadge) {
      if (bonusR) {
        clResetBadge.classList.remove('hidden');
        clResetBadge.title = `🎁 Último Reseteo Gratis (Bonus): ${fmtDateTimeShort(bonusR.timestamp)} · Bajó de ${bonusR.fromPct}% → ${bonusR.toPct}% (-${bonusR.savedPct}%)`;
      } else {
        clResetBadge.classList.add('hidden');
      }
    }
    if (pillClBox) {
      const next5hStr = clQuota.nextFiveHourResetAt
        ? `\n⏳ Reset 5h: ${fmtTimeShort(clQuota.nextFiveHourResetAt)} (${fmtCountdown(clQuota.nextFiveHourResetAt)})`
        : '';
      const nextStr = clQuota.nextWeeklyResetAt
        ? `\n📅 Reset semanal (7d): ${fmtDateTimeShort(clQuota.nextWeeklyResetAt)} (${fmtCountdown(clQuota.nextWeeklyResetAt)})`
        : '';
      const bonusStr = bonusR
        ? `\n🎁 Último Bonus Gratis: ${fmtDateTimeShort(bonusR.timestamp)} (${bonusR.fromPct}% → ${bonusR.toPct}%)`
        : '';
      pillClBox.title = `🟠 CLAUDE (Plan Pro/Max)\n5h: ${clFh}% | Semanal (7d): ${clSd}%${next5hStr}${nextStr}${bonusStr}`;
    }

    // Cuota AGY en Píldora
    const agyFh = agyQuota.fiveHourPct != null ? agyQuota.fiveHourPct : 0;
    const agySd = agyQuota.sevenDayPct != null ? agyQuota.sevenDayPct : 0;
    const agyFhEl = document.getElementById('pill-agy-fh');
    const agySdEl = document.getElementById('pill-agy-sd');
    if (agyFhEl) agyFhEl.style.width = `${Math.min(100, agyFh)}%`;
    if (agySdEl) {
      agySdEl.style.width = `${Math.min(100, agySd)}%`;
      agySdEl.classList.toggle('fill-danger', agySd >= 90);
    }
    document.getElementById('pill-agy-fh-txt').textContent = agyQuota.available ? `${agyFh}%` : '--%';
    document.getElementById('pill-agy-sd-txt').textContent = agyQuota.available ? `${agySd}%` : '--%';

    const agyResetTimer = document.getElementById('pill-agy-reset-timer');
    if (agyResetTimer) {
      const agyReset = agyQuota.nextFiveHourResetAt || agyQuota.nextWeeklyResetAt;
      agyResetTimer.textContent = agyReset ? `⏳${fmtCountdownShort(agyReset)}` : '';
    }

    const pillAgyBox = document.getElementById('pill-agy-box');
    if (pillAgyBox && agyQuota.available) {
      const agy5hStr = agyQuota.nextFiveHourResetAt
        ? `\n⏳ Libera ventana 5h: ${fmtTimeShort(agyQuota.nextFiveHourResetAt)} (${fmtCountdown(agyQuota.nextFiveHourResetAt)})`
        : '';
      const agy7dStr = agyQuota.nextWeeklyResetAt
        ? `\n📅 Libera ventana 7d: ${fmtDateTimeShort(agyQuota.nextWeeklyResetAt)} (${fmtCountdown(agyQuota.nextWeeklyResetAt)})`
        : '';
      pillAgyBox.title = `🟡 AGY (${agyQuota.model})\n5h: ${agyFh}% (${fmtNumber(agyQuota.fiveHour?.total)} tok · ${agyQuota.fiveHour?.turns || 0} turnos)\n7d: ${agySd}% (${fmtNumber(agyQuota.sevenDay?.total)} tok · ${agyQuota.sevenDay?.turns || 0} turnos)${agy5hStr}${agy7dStr}`;
    }

    // Iconos de sonido
    const soundIcon = data.config && data.config.soundEnabled ? '🔊' : '🔇';
    document.getElementById('pill-btn-sound').textContent = soundIcon;
    document.getElementById('btn-toggle-sound').textContent = soundIcon;

    // Botón de marcar alertas como vistas
    const btnAckAll = document.getElementById('btn-ack-all');
    if ((sum.unreadAlertsCount || 0) > 0) {
      btnAckAll.classList.remove('hidden');
      btnAckAll.textContent = `✓ Visto (${sum.unreadAlertsCount})`;
    } else {
      btnAckAll.classList.add('hidden');
    }

    // Subtítulo y chip de velocidad en el header
    const liveStatus = document.getElementById('header-live-status');
    if (liveStatus) {
      liveStatus.textContent = `${sum.totalOpen || 0} abiertas · ${waitingTotal} listas · ${sum.running || 0} activas`;
    }

    const burnChip = document.getElementById('header-burn-chip');
    if (burnChip) {
      const rate = agyQuota.burnRatePerHour || 0;
      const cacheHit = agyQuota.cacheHitPct || 0;
      burnChip.textContent = `🔥 ${fmtNumber(rate)}/h · ⚡ ${cacheHit}% caché`;
    }
  }

  // =========================================================
  // RENDERIZADO: RESUMEN 4 KPIs (CONSOLAS | CLAUDE | AGY | 7D)
  // =========================================================
  function renderSummaryStrip(data) {
    const sum = data.summary || {};
    const clQuota = resolveClaudeQuota(data);
    const agyQuota = resolveAgyQuota(data);
    const analytics = data.analytics || {};

    // KPI 1: Consolas
    const waitingTotal = (sum.waitingInput || 0) + (sum.waitingApproval || 0);
    document.getElementById('kpi-waiting-val').textContent = waitingTotal;
    document.getElementById('kpi-running-val').textContent = sum.running || 0;

    const kpiWaitingCard = document.getElementById('kpi-waiting-card');
    kpiWaitingCard.classList.toggle('active-alert', waitingTotal > 0);

    const approvalSub = document.getElementById('kpi-approval-sub');
    if ((sum.waitingApproval || 0) > 0) {
      approvalSub.textContent = `⚠️ ${sum.waitingApproval} pidiendo permiso`;
      approvalSub.style.color = '#fde047';
    } else {
      approvalSub.textContent = `${sum.totalOpen || 0} consolas abiertas ahora`;
      approvalSub.style.color = '';
    }

    // KPI 2: Cuota Claude
    const clFh = clQuota.fiveHourPct != null ? clQuota.fiveHourPct : 0;
    const clSd = clQuota.sevenDayPct != null ? clQuota.sevenDayPct : 0;
    document.getElementById('kpi-fh-val').textContent = clQuota.fiveHourPct != null ? `${clFh}%` : '--%';
    document.getElementById('kpi-sd-val').textContent = clQuota.sevenDayPct != null ? `${clSd}%` : '--%';
    document.getElementById('kpi-fh-bar').style.width = `${Math.min(100, clFh)}%`;
    const clSdBar = document.getElementById('kpi-sd-bar');
    clSdBar.style.width = `${Math.min(100, clSd)}%`;
    clSdBar.classList.toggle('fill-danger', clSd >= 90);

    const todayClaudeTok = analytics.today?.claude?.total || 0;
    const kpiClaudeSub = document.getElementById('kpi-claude-sub');
    if (kpiClaudeSub) {
      if (clQuota.nextFiveHourResetAt || clQuota.nextWeeklyResetAt) {
        kpiClaudeSub.textContent = `⏳5h:${fmtCountdownShort(clQuota.nextFiveHourResetAt)} · 7d:${fmtCountdownShort(clQuota.nextWeeklyResetAt)}`;
      } else {
        kpiClaudeSub.textContent = `Hoy: ${fmtNumber(todayClaudeTok)} tok`;
      }
    }
    const kpiClaudeCard = document.getElementById('kpi-claude-card');
    if (kpiClaudeCard) {
      kpiClaudeCard.title = [
        `Cuota Plan Claude · Hoy: ${fmtNumber(todayClaudeTok)} tok`,
        clQuota.nextFiveHourResetAt ? `⏳ Reset 5h: ${fmtTimeShort(clQuota.nextFiveHourResetAt)} (${fmtCountdown(clQuota.nextFiveHourResetAt)})` : '',
        clQuota.nextWeeklyResetAt ? `📅 Reset 7d: ${fmtDateTimeShort(clQuota.nextWeeklyResetAt)} (${fmtCountdown(clQuota.nextWeeklyResetAt)})` : ''
      ].filter(Boolean).join('\n');
    }

    // KPI 3: Cuota AGY
    const agyFh = agyQuota.fiveHourPct != null ? agyQuota.fiveHourPct : 0;
    const agySd = agyQuota.sevenDayPct != null ? agyQuota.sevenDayPct : 0;
    document.getElementById('kpi-agy-fh-val').textContent = agyQuota.available ? `${agyFh}%` : '--%';
    document.getElementById('kpi-agy-sd-val').textContent = agyQuota.available ? `${agySd}%` : '--%';
    document.getElementById('kpi-agy-fh-bar').style.width = `${Math.min(100, agyFh)}%`;
    const agySdBar = document.getElementById('kpi-agy-sd-bar');
    agySdBar.style.width = `${Math.min(100, agySd)}%`;
    agySdBar.classList.toggle('fill-danger', agySd >= 90);

    const fhAgyTok = agyQuota.fiveHour?.total || 0;
    const sdAgyTok = agyQuota.sevenDay?.total || 0;
    const kpiAgySub = document.getElementById('kpi-agy-sub');
    if (kpiAgySub) {
      if (agyQuota.nextFiveHourResetAt || agyQuota.nextWeeklyResetAt) {
        kpiAgySub.textContent = `⏳5h:${fmtCountdownShort(agyQuota.nextFiveHourResetAt)} · 7d:${fmtCountdownShort(agyQuota.nextWeeklyResetAt)}`;
      } else {
        kpiAgySub.textContent = `5h:${fmtNumber(fhAgyTok)} · 7d:${fmtNumber(sdAgyTok)}`;
      }
    }
    const kpiAgyCard = document.getElementById('kpi-agy-card');
    if (kpiAgyCard) {
      kpiAgyCard.title = [
        `Cuota Antigravity (AGY) · 5h: ${fmtNumber(fhAgyTok)} tok | 7d: ${fmtNumber(sdAgyTok)} tok`,
        agyQuota.nextFiveHourResetAt ? `⏳ Libera 5h: ${fmtTimeShort(agyQuota.nextFiveHourResetAt)} (${fmtCountdown(agyQuota.nextFiveHourResetAt)})` : '',
        agyQuota.nextWeeklyResetAt ? `📅 Libera 7d: ${fmtDateTimeShort(agyQuota.nextWeeklyResetAt)} (${fmtCountdown(agyQuota.nextWeeklyResetAt)})` : ''
      ].filter(Boolean).join('\n');
    }

    const modelShort = (agyQuota.model || 'Argon').includes('Argon')
      ? 'ARGON'
      : (agyQuota.model || 'AGY').slice(0, 7).toUpperCase();
    document.getElementById('kpi-agy-model-tag').textContent = modelShort;

    // KPI 4: Tokens 7 Días & Caché
    const weekTotal = analytics.weekly?.combined?.total || 0;
    const weekCache = analytics.weekly?.combined?.cacheRead || 0;
    const todayTotal = analytics.today?.combined?.total || 0;
    const combinedCachePct = weekTotal > 0 ? Math.round((weekCache / weekTotal) * 100) : 0;

    document.getElementById('kpi-week-tokens').textContent = fmtNumber(weekTotal);
    document.getElementById('kpi-today-tokens').textContent = `Hoy: ${fmtNumber(todayTotal)} tok`;
    document.getElementById('kpi-cache-tag').textContent = `${combinedCachePct}% caché`;

    // Badges en pestañas
    document.getElementById('tab-badge-sessions').textContent = sum.totalOpen || 0;
    const remBadge = document.getElementById('tab-badge-remotes');
    if ((sum.remoteOpen || 0) > 0) {
      remBadge.textContent = sum.remoteOpen;
      remBadge.classList.remove('hidden');
    } else {
      remBadge.classList.add('hidden');
    }
  }

  // =========================================================
  // RENDERIZADO: PESTAÑA 1 (FILAS COMPACTAS DE SESIONES)
  // =========================================================
  function renderSessionsList(data) {
    const container = document.getElementById('sessions-list');
    if (!container) return;

    const all = data.sessions || [];
    const q = searchQuery.trim().toLowerCase();

    const filtered = all.filter((s) => {
      if (activeFilter === 'open' && !s.isOpen) return false;
      if (activeFilter === 'waiting') {
        if (!s.isOpen || (s.state !== 'waiting_input' && s.state !== 'waiting_approval')) return false;
      }
      if (activeFilter === 'claude' && s.provider !== 'claude') return false;
      if (activeFilter === 'agy' && s.provider !== 'agy') return false;
      if (activeFilter === 'remote' && !s.isRemote) return false;

      if (q) {
        const hay = `${s.projectName || ''} ${s.title || ''} ${s.currentAction || ''} ${s.providerLabel || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    // Ordenar poniendo primero las fijadas (Pin), luego abiertas y prioridad de estado
    const statePriority = { waiting_approval: 0, waiting_input: 1, running: 2, closed: 3 };
    filtered.sort((a, b) => {
      const pinA = pinnedIds.has(a.id);
      const pinB = pinnedIds.has(b.id);
      if (pinA !== pinB) return pinA ? -1 : 1;
      if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
      if (statePriority[a.state] !== statePriority[b.state]) {
        return statePriority[a.state] - statePriority[b.state];
      }
      return b.updatedAt - a.updatedAt;
    });

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="section-card" style="text-align:center; padding: 18px 10px;">
          <div style="font-size: 12px; font-weight: 700; color: #fed7aa; margin-bottom: 3px;">Sin consolas en esta vista</div>
          <div class="muted-xs">Cambiá el filtro a "24h" o limpiá el buscador para ver el historial reciente.</div>
        </div>
      `;
      return;
    }

    const maxTokens = Math.max(
      100_000,
      ...filtered.map((s) => (s.tokens && s.tokens.total) || 0)
    );

    container.innerHTML = filtered
      .map((s) => {
        const isPinned = pinnedIds.has(s.id);
        const provClass = s.isRemote
          ? 'prov-remote'
          : s.provider === 'claude'
          ? 'prov-claude'
          : 'prov-agy';

        const shortProv = s.isRemote
          ? 'REM'
          : s.provider === 'claude'
          ? s.surface === 'app'
            ? 'CL·APP'
            : 'CLAUDE'
          : s.isSubagent
          ? 'AGY·SUB'
          : 'AGY';

        const dotClass =
          s.state === 'waiting_approval'
            ? 'dot-amber'
            : s.state === 'waiting_input'
            ? 'dot-ready'
            : s.state === 'running'
            ? 'dot-orange'
            : '';

        const tok = s.tokens || {};
        const totTok = tok.total || 0;
        const cachePct = totTok > 0 ? Math.round(((tok.cacheRead || 0) / totTok) * 100) : 0;
        const energyPct = Math.max(6, Math.min(100, Math.round((totTok / maxTokens) * 100)));

        const tokTooltip = [
          `Proyecto: ${s.projectName || 'General'}`,
          `Sesión: ${s.title || s.sessionId}`,
          `Ruta: ${s.workspace || 'N/A'}`,
          `────────────────────────`,
          `Total Tokens: ${fmtNumber(totTok)} (Efectivos: ${fmtNumber(tok.effective || 0)})`,
          `Input: ${fmtNumber(tok.input || 0)} | Output: ${fmtNumber(tok.output || 0)}`,
          `Caché Leído: ${fmtNumber(tok.cacheRead || 0)} (${cachePct}% ahorro)`,
          `Turnos: ${tok.turns || s.turns || 0}${s.pid ? ' | PID: ' + s.pid : ''}`,
          `Doble clic en la fila para ir a la consola`
        ].join('\n');

        const hasSubRow =
          Boolean(s.currentAction) ||
          (s.subagentsCount || 0) > 0 ||
          (s.backgroundTasksCount || 0) > 0;

        return `
        <article class="session-row state-${escapeHtml(s.state)} ${isPinned ? 'is-pinned' : ''} ${s.hasUnreadAlert ? 'unread-highlight' : ''}"
                 data-session-id="${escapeHtml(s.id)}"
                 data-raw-session-id="${escapeHtml(s.sessionId || s.id)}"
                 data-pid="${s.pid || ''}"
                 data-provider="${escapeHtml(s.provider)}"
                 data-surface="${escapeHtml(s.surface || 'cli')}"
                 data-workspace="${escapeHtml(s.workspace || '')}"
                 data-title="${escapeHtml(s.projectName || s.title || '')}"
                 title="${escapeHtml(tokTooltip)}">
          <div class="sr-main">
            <div class="sr-left">
              ${dotClass ? `<span class="dot ${dotClass}"></span>` : `<span class="dot" style="background:#57493c"></span>`}
              <span class="provider-pill ${provClass}">${escapeHtml(shortProv)}</span>
              <span class="sr-project">${escapeHtml(s.projectName || 'Global')}</span>
              <span class="sr-sep">›</span>
              <span class="sr-title">${escapeHtml(s.title || s.sessionId)}</span>
            </div>

            <div class="sr-right">
              <span class="sr-state-tag st-${escapeHtml(s.state)}">${escapeHtml(compactStateLabel(s))}</span>
              <span class="sr-tok-pill">${fmtNumber(totTok)}</span>
              <span class="sr-time">${fmtRelativeTime(s.updatedAt)}</span>

              <div class="sr-actions">
                <button class="btn-row-icon ${isPinned ? 'pinned-active' : ''}" data-action="pin" data-id="${escapeHtml(s.id)}" title="${isPinned ? 'Desfijar consola' : 'Fijar consola arriba'}">📌</button>
                ${
                  s.hasUnreadAlert
                    ? `<button class="btn-row-icon" data-action="ack" data-id="${escapeHtml(s.id)}" title="Marcar alerta como vista">✓</button>`
                    : ''
                }
                ${
                  s.isRemote
                    ? `<button class="btn-row-icon" data-action="remove-remote" data-id="${escapeHtml(s.id)}" title="Quitar sesión remota">✕</button>`
                    : s.isOpen
                    ? `<button class="btn-row-icon btn-focus" data-action="focus" data-id="${escapeHtml(s.id)}" data-raw-session-id="${escapeHtml(s.sessionId || s.id)}" data-pid="${s.pid || ''}" data-provider="${escapeHtml(s.provider)}" data-surface="${escapeHtml(s.surface || 'cli')}" data-workspace="${escapeHtml(s.workspace || '')}" data-title="${escapeHtml(s.projectName || s.title || '')}" title="Ir a la pestaña exacta de esta consola (o doble clic en la fila)">🎯</button>`
                    : ''
                }
                <button class="btn-row-icon" data-action="copy" data-copy="${escapeHtml(s.workspace || s.sessionId)}" title="Copiar ruta del proyecto o ID">📋</button>
              </div>
            </div>
          </div>

          ${
            hasSubRow
              ? `<div class="sr-sub">
                  ${s.currentAction ? `<span class="sr-tool-chip">⚡ ${escapeHtml(s.currentAction)}</span>` : ''}
                  ${s.subagentsCount > 0 ? `<span class="sr-meta-tag">🤖 ${s.subagentsCount} sub</span>` : ''}
                  ${s.backgroundTasksCount > 0 ? `<span class="sr-meta-tag">⚙️ ${s.backgroundTasksCount} bg</span>` : ''}
                </div>`
              : ''
          }

          <div class="sr-energy-track">
            <div class="sr-energy-fill" style="width:${energyPct}%"></div>
          </div>
        </article>
      `;
      })
      .join('');
  }

  // =========================================================
  // RENDERIZADO: PESTAÑA 2 (CUOTAS Y TOKENS: CLAUDE + AGY)
  // =========================================================
  function renderTokensTab(data) {
    const clQuota = resolveClaudeQuota(data);
    const agyQuota = resolveAgyQuota(data);
    const analytics = data.analytics || {};

    // 1. Cuota Oficial Plan Claude
    const clFh = clQuota.fiveHourPct != null ? clQuota.fiveHourPct : 0;
    const clSd = clQuota.sevenDayPct != null ? clQuota.sevenDayPct : 0;

    document.getElementById('tokens-fh-pct').textContent = clQuota.fiveHourPct != null ? `${clFh}%` : '--%';
    document.getElementById('tokens-sd-pct').textContent = clQuota.sevenDayPct != null ? `${clSd}%` : '--%';
    document.getElementById('tokens-fh-bar').style.width = `${Math.min(100, clFh)}%`;

    const sdBar = document.getElementById('tokens-sd-bar');
    sdBar.style.width = `${Math.min(100, clSd)}%`;
    sdBar.classList.toggle('fill-danger', clSd >= 90);

    const sdWarn = document.getElementById('tokens-sd-warning');
    if (clSd >= 90) {
      sdWarn.textContent = `⚠️ Al ${clSd}% del límite semanal Claude (${fmtNumber(analytics.weekly?.claude?.total)} tok)`;
      sdWarn.style.color = '#fca5a5';
    } else {
      sdWarn.textContent = `7d: ${fmtNumber(analytics.weekly?.claude?.total)} tok · ${analytics.weekly?.claude?.turns || 0} turnos`;
      sdWarn.style.color = '';
    }

    const clFhFoot = document.getElementById('tokens-cl-fh-foot');
    if (clFhFoot) {
      clFhFoot.textContent = `Hoy: ${fmtNumber(analytics.today?.claude?.total)} tok (${analytics.today?.claude?.turns || 0} turnos)`;
    }

    const clFhResetEl = document.getElementById('tokens-cl-fh-reset');
    if (clFhResetEl) {
      clFhResetEl.textContent = clQuota.nextFiveHourResetAt
        ? `⏳ Resetea: ${fmtTimeShort(clQuota.nextFiveHourResetAt)} (${fmtCountdown(clQuota.nextFiveHourResetAt)})`
        : '⏳ Ventana móvil 5h activa';
    }

    const clSdResetEl = document.getElementById('tokens-cl-sd-reset');
    if (clSdResetEl) {
      clSdResetEl.textContent = clQuota.nextWeeklyResetAt
        ? `⏳ Resetea: ${fmtDateTimeShort(clQuota.nextWeeklyResetAt)} (${fmtCountdown(clQuota.nextWeeklyResetAt)})`
        : '⏳ Ventana semanal (7d)';
    }

    if (clQuota.updatedAt) {
      document.getElementById('quota-updated-at').textContent = `Sincronizado hace ${fmtRelativeTime(clQuota.updatedAt)}`;
    }

    drawSparklineSvg(
      document.getElementById('quota-sparkline'),
      clQuota.history || [],
      '#ff6b1a',
      '#e09f3e'
    );

    // 1.B Detector de Reseteo Semanal y Reseteo Gratis (Bonus) de Claude
    const next5hEl = document.getElementById('claude-next-5h-txt');
    if (next5hEl) {
      next5hEl.textContent = clQuota.nextFiveHourResetAt
        ? `${fmtTimeShort(clQuota.nextFiveHourResetAt)} (${fmtCountdownShort(clQuota.nextFiveHourResetAt)})`
        : 'En ventana';
    }

    const nextResetEl = document.getElementById('claude-next-reset-txt');
    if (nextResetEl) {
      if (clQuota.nextWeeklyResetAt) {
        nextResetEl.textContent = `${fmtDateTimeShort(clQuota.nextWeeklyResetAt)} (${fmtCountdownShort(clQuota.nextWeeklyResetAt)})`;
      } else {
        nextResetEl.textContent = 'Viernes 07:00 hs';
      }
    }

    const bonusBadgeEl = document.getElementById('claude-last-bonus-badge');
    if (bonusBadgeEl) {
      if (clQuota.lastBonusReset) {
        bonusBadgeEl.classList.remove('hidden');
        bonusBadgeEl.textContent = `🎁 Bonus -${clQuota.lastBonusReset.savedPct}%`;
        bonusBadgeEl.title = `Detectado el ${fmtDateTimeShort(clQuota.lastBonusReset.timestamp)}`;
      } else {
        bonusBadgeEl.classList.add('hidden');
      }
    }

    const resetsListEl = document.getElementById('claude-resets-list');
    if (resetsListEl) {
      const resets = Array.isArray(clQuota.resets) ? clQuota.resets : [];
      if (resets.length === 0) {
        resetsListEl.innerHTML = `<div class="muted-xs">Sin reseteos en las últimas 24h · Monitoreando si Claude otorga un bonus gratis</div>`;
      } else {
        resetsListEl.innerHTML = resets
          .slice(0, 4)
          .map((r) => {
            const badgeHtml = r.isBonus
              ? `<span class="crp-badge-bonus">🎁 Bonus Gratis</span>`
              : `<span class="crp-badge-sched">🔄 Semanal</span>`;
            return `
              <div class="crp-item ${r.isBonus ? 'is-bonus' : ''}">
                <div class="crp-item-left">
                  ${badgeHtml}
                  <span class="crp-date">${escapeHtml(fmtDateTimeShort(r.timestamp))}</span>
                </div>
                <div class="crp-drop">
                  ${r.fromPct}% → ${r.toPct}%
                  <span class="crp-saved">(-${r.savedPct}%)</span>
                </div>
              </div>
            `;
          })
          .join('');
      }
    }

    // 2. Cuota y Telemetría Antigravity (AGY)
    const agyFh = agyQuota.fiveHourPct != null ? agyQuota.fiveHourPct : 0;
    const agySd = agyQuota.sevenDayPct != null ? agyQuota.sevenDayPct : 0;

    document.getElementById('agy-fh-pct').textContent = agyQuota.available ? `${agyFh}%` : '--%';
    document.getElementById('agy-sd-pct').textContent = agyQuota.available ? `${agySd}%` : '--%';
    document.getElementById('agy-fh-bar').style.width = `${Math.min(100, agyFh)}%`;

    const agySdBar = document.getElementById('agy-sd-bar');
    if (agySdBar) {
      agySdBar.style.width = `${Math.min(100, agySd)}%`;
      agySdBar.classList.toggle('fill-danger', agySd >= 90);
    }

    const agyMetaBadge = document.getElementById('agy-meta-badge');
    if (agyMetaBadge) {
      agyMetaBadge.textContent = agyQuota.model || 'Gemini 4 Argon (High)';
    }

    const agyFhDetail = document.getElementById('agy-fh-detail');
    if (agyFhDetail && agyQuota.fiveHour) {
      agyFhDetail.textContent = `${fmtNumber(agyQuota.fiveHour.total)} tok (${fmtNumber(agyQuota.fiveHour.effective)} ef.) · ${agyQuota.fiveHour.turns} turnos`;
    }

    const agySdDetail = document.getElementById('agy-sd-detail');
    if (agySdDetail && agyQuota.sevenDay) {
      agySdDetail.textContent = `${fmtNumber(agyQuota.sevenDay.total)} tok (${fmtNumber(agyQuota.sevenDay.effective)} ef.) · ${agyQuota.sevenDay.turns} turnos`;
    }

    const agyFhResetEl = document.getElementById('tokens-agy-fh-reset');
    if (agyFhResetEl) {
      agyFhResetEl.textContent = agyQuota.nextFiveHourResetAt
        ? `⏳ Libera: ${fmtTimeShort(agyQuota.nextFiveHourResetAt)} (${fmtCountdown(agyQuota.nextFiveHourResetAt)})`
        : '⏳ Ventana móvil continua (5h)';
    }

    const agySdResetEl = document.getElementById('tokens-agy-sd-reset');
    if (agySdResetEl) {
      agySdResetEl.textContent = agyQuota.nextWeeklyResetAt
        ? `⏳ Libera: ${fmtDateTimeShort(agyQuota.nextWeeklyResetAt)} (${fmtCountdown(agyQuota.nextWeeklyResetAt)})`
        : '⏳ Ventana móvil continua (7d)';
    }

    const gcpEl = document.getElementById('agy-gcp-proj');
    const burnEl = document.getElementById('agy-burn-rate');
    const cacheEl = document.getElementById('agy-cache-hit');
    if (gcpEl) gcpEl.textContent = agyQuota.gcpProject || 'GCP';
    if (burnEl) burnEl.textContent = `${fmtNumber(agyQuota.burnRatePerHour || 0)} tok/h`;
    if (cacheEl) cacheEl.textContent = `${agyQuota.cacheHitPct || 0}%`;

    drawSparklineSvg(
      document.getElementById('agy-sparkline'),
      agyQuota.history || [],
      '#facc15',
      '#f59e0b'
    );

    // 3. Tabla comparativa Hoy vs 7 Días
    const today = analytics.today || { claude: {}, agy: {}, combined: {} };
    const weekly = analytics.weekly || { claude: {}, agy: {}, combined: {} };
    const tableWrap = document.getElementById('token-comparison-table');
    if (tableWrap) {
      tableWrap.innerHTML = `
        <table class="token-table">
          <thead>
            <tr>
              <th>Motor</th>
              <th>Hoy (Total)</th>
              <th>Hoy (Output)</th>
              <th>7 Días (Total)</th>
              <th>7 Días (Efectivos)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span class="leg-dot leg-claude"></span>Claude</td>
              <td>${fmtNumber(today.claude?.total)}</td>
              <td>${fmtNumber(today.claude?.output)}</td>
              <td><strong>${fmtNumber(weekly.claude?.total)}</strong></td>
              <td>${fmtNumber(weekly.claude?.effective)}</td>
            </tr>
            <tr>
              <td><span class="leg-dot leg-agy"></span>AGY</td>
              <td>${fmtNumber(today.agy?.total)}</td>
              <td>${fmtNumber(today.agy?.output)}</td>
              <td><strong>${fmtNumber(weekly.agy?.total)}</strong></td>
              <td>${fmtNumber(weekly.agy?.effective)}</td>
            </tr>
            <tr style="border-top: 1px solid rgba(224,159,62,0.28); color: #fff7ed;">
              <td>Combinado</td>
              <td><strong>${fmtNumber(today.combined?.total)}</strong></td>
              <td><strong>${fmtNumber(today.combined?.output)}</strong></td>
              <td><strong style="color:#ff8542">${fmtNumber(weekly.combined?.total)}</strong></td>
              <td><strong style="color:#fde047">${fmtNumber(weekly.combined?.effective)}</strong></td>
            </tr>
          </tbody>
        </table>
      `;
    }

    // 4. Gráfico de barras apiladas de los últimos 7 días
    const chartEl = document.getElementById('weekly-chart');
    const timeline = analytics.timeline || [];
    if (chartEl && timeline.length > 0) {
      const maxDay = Math.max(1, ...timeline.map((d) => d.totalTokens || 0));
      chartEl.innerHTML = timeline
        .map((d) => {
          const claudePct = ((d.claude?.total || 0) / maxDay) * 100;
          const agyPct = ((d.agy?.total || 0) / maxDay) * 100;
          return `
            <div class="day-col" title="${d.date}\nClaude: ${fmtNumber(d.claude?.total)} tok\nAGY: ${fmtNumber(d.agy?.total)} tok">
              <div class="day-val">${fmtNumber(d.totalTokens)}</div>
              <div class="day-bars-stack">
                <div class="bar-seg-claude" style="height:${claudePct.toFixed(1)}%"></div>
                <div class="bar-seg-agy" style="height:${agyPct.toFixed(1)}%"></div>
              </div>
              <div class="day-lbl">${escapeHtml(d.label)}</div>
            </div>
          `;
        })
        .join('');
    }

    // 5. Top Proyectos
    const topEl = document.getElementById('top-projects-list');
    const topProjects = analytics.topProjects || [];
    if (topEl) {
      if (topProjects.length === 0) {
        topEl.innerHTML = `<div class="muted-xs">Sin actividad registrada aún.</div>`;
      } else {
        const maxProj = Math.max(1, topProjects[0].totalTokens || 1);
        topEl.innerHTML = topProjects
          .map((p) => {
            const pct = Math.min(100, ((p.totalTokens || 0) / maxProj) * 100);
            const color = p.provider === 'claude' ? 'var(--claude-color)' : 'var(--agy-color)';
            return `
              <div class="proj-row">
                <div class="proj-row-head">
                  <span>
                    <strong style="color:#fff7ed">${escapeHtml(p.projectName)}</strong>
                    <span class="muted-xs">(${p.provider.toUpperCase()} · ${p.sessionsCount} ses.)</span>
                  </span>
                  <span><strong style="color:#fed7aa">${fmtNumber(p.totalTokens)}</strong> tok</span>
                </div>
                <div class="proj-bar-bg">
                  <div class="proj-bar-fill" style="width:${pct.toFixed(1)}%; background:${color}"></div>
                </div>
              </div>
            `;
          })
          .join('');
      }
    }
  }

  // =========================================================
  // RENDERIZADO: PESTAÑA 3 (REMOTOS Y HOOKS) Y PESTAÑA 4 (AJUSTES)
  // =========================================================
  function renderRemotesAndSettings(data) {
    const hooks = data.hooksStatus || {};
    const rem = data.remoteSetup || {};
    const cfg = data.config || {};

    const chkClaude = document.getElementById('chk-hook-claude');
    const chkAgy = document.getElementById('chk-hook-agy');
    if (chkClaude) chkClaude.checked = Boolean(hooks.claudeInstalled);
    if (chkAgy) chkAgy.checked = Boolean(hooks.agyInstalled);

    const ntfyBadge = document.getElementById('ntfy-status-badge');
    if (ntfyBadge) {
      if (rem.ntfyConnected) {
        ntfyBadge.textContent = '● Escuchando en vivo';
        ntfyBadge.className = 'badge-pill badge-ok';
      } else {
        ntfyBadge.textContent = '○ Reconectando...';
        ntfyBadge.className = 'badge-pill';
      }
    }

    const topicInput = document.getElementById('input-ntfy-topic');
    if (topicInput && document.activeElement !== topicInput) {
      topicInput.value = rem.topic || cfg.ntfyTopic || '';
    }

    const snipBash = document.getElementById('snippet-bash');
    const snipPs = document.getElementById('snippet-ps');
    const snipHook = document.getElementById('snippet-hook');
    if (snipBash) snipBash.textContent = rem.bashRelayDaemon || '';
    if (snipPs) snipPs.textContent = rem.psRelayOneLiner || '';
    if (snipHook) snipHook.textContent = rem.claudeRemoteHookJson || '';

    const sshList = document.getElementById('ssh-hosts-list');
    const hosts = cfg.sshHosts || [];
    if (sshList) {
      if (hosts.length === 0) {
        sshList.innerHTML = `<div class="muted-xs">No hay hosts SSH agregados. Usá el Modo 1 (arriba) si no tenés SSH.</div>`;
      } else {
        sshList.innerHTML = hosts
          .map((h, idx) => {
            const keyName = h.keyPath
              ? String(h.keyPath).split(/[\\/]/).filter(Boolean).pop() || h.keyPath
              : '';
            const keyBadge = keyName
              ? `<span class="ssh-key-badge" title="Llave privada: ${escapeHtml(h.keyPath)}">🔑 ${escapeHtml(keyName)}</span>`
              : '';
            return `
          <div class="ssh-item">
            <div style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
              <strong>${escapeHtml(h.label || h.target)}</strong>
              <span class="muted-xs"> (${escapeHtml(h.target)}:${h.port || 22})</span>
              ${keyBadge}
              <span class="badge-pill ${h.lastStatus === 'ok' ? 'badge-ok' : ''}">
                ${h.lastStatus === 'ok' ? 'Conectado' : h.lastStatus === 'error' ? 'Error SSH' : 'Pendiente'}
              </span>
            </div>
            <button class="btn-row-icon" data-action="remove-ssh" data-index="${idx}" title="Eliminar host">✕</button>
          </div>
        `;
          })
          .join('');
      }
    }

    // Controles de Ajustes
    const cfgSound = document.getElementById('cfg-sound-enabled');
    const cfgTone = document.getElementById('cfg-sound-tone');
    const cfgNotif = document.getElementById('cfg-desktop-notif');
    const cfgTop = document.getElementById('cfg-always-top');
    const cfgOp = document.getElementById('cfg-opacity');
    const lblOp = document.getElementById('lbl-opacity');
    const lblPort = document.getElementById('lbl-local-port');
    const cfgAgy5h = document.getElementById('cfg-agy-5h');
    const cfgAgy7d = document.getElementById('cfg-agy-7d');

    if (cfgSound) cfgSound.checked = Boolean(cfg.soundEnabled);
    if (cfgTone && document.activeElement !== cfgTone) cfgTone.value = cfg.soundTone || 'chime';
    if (cfgNotif) cfgNotif.checked = Boolean(cfg.desktopNotifications);
    if (cfgTop) cfgTop.checked = Boolean(cfg.alwaysOnTop);
    if (cfgOp && document.activeElement !== cfgOp) {
      cfgOp.value = cfg.opacity || 0.96;
      if (lblOp) lblOp.textContent = `${Math.round((cfg.opacity || 0.96) * 100)}%`;
    }
    if (cfgAgy5h && document.activeElement !== cfgAgy5h) {
      cfgAgy5h.value = cfg.agyFiveHourLimitM || 25;
    }
    if (cfgAgy7d && document.activeElement !== cfgAgy7d) {
      cfgAgy7d.value = cfg.agySevenDayLimitM || 100;
    }
    if (lblPort) lblPort.textContent = cfg.port || 19876;

    // Historial de alertas
    const alertsEl = document.getElementById('recent-alerts-list');
    const alerts = data.recentAlerts || [];
    if (alertsEl) {
      if (alerts.length === 0) {
        alertsEl.innerHTML = `<div class="muted-xs">Aún no se han disparado alertas en esta sesión.</div>`;
      } else {
        alertsEl.innerHTML = alerts
          .slice(0, 10)
          .map(
            (a) => `
          <div class="alert-item">
            <div>
              <strong style="color:#fed7aa">[${escapeHtml(a.providerLabel || a.provider)}] ${escapeHtml(a.projectName || a.title)}</strong>
              <div class="muted-xs">${escapeHtml(a.message)}</div>
            </div>
            <span class="sr-time">${fmtRelativeTime(a.timestamp)}</span>
          </div>
        `
          )
          .join('');
      }
    }
  }

  function renderAll(data) {
    if (!data) return;
    currentState = data;
    renderPill(data);
    renderSummaryStrip(data);
    renderSessionsList(data);
    renderTokensTab(data);
    renderRemotesAndSettings(data);
  }

  function switchTab(tabName) {
    activeTab = tabName;
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-pane').forEach((pane) => {
      pane.classList.toggle('active', pane.id === `tab-${tabName}`);
    });
  }

  // =========================================================
  // EVENTOS DE INTERFAZ Y ATAJOS
  // =========================================================
  function setupEventListeners() {
    document.getElementById('pill-btn-expand')?.addEventListener('click', () => {
      requestWindowMode('expanded');
    });

    document.getElementById('pill-click-area')?.addEventListener('dblclick', () => {
      requestWindowMode('expanded');
    });

    document.getElementById('btn-collapse-pill')?.addEventListener('click', () => {
      requestWindowMode('pill');
    });

    document.getElementById('pill-btn-jump')?.addEventListener('click', jumpToFirstReadySession);
    document.getElementById('btn-jump-ready')?.addEventListener('click', jumpToFirstReadySession);

    // Clic en los KPIs lleva a la pestaña/filtro correspondiente
    document.getElementById('kpi-waiting-card')?.addEventListener('click', () => {
      switchTab('sessions');
      activeFilter = 'waiting';
      document.querySelectorAll('.filter-chip').forEach((c) => {
        c.classList.toggle('active', c.dataset.filter === 'waiting');
      });
      if (currentState) renderSessionsList(currentState);
    });

    document.getElementById('kpi-claude-card')?.addEventListener('click', () => switchTab('tokens'));
    document.getElementById('kpi-agy-card')?.addEventListener('click', () => switchTab('tokens'));

    document.getElementById('btn-hide-tray')?.addEventListener('click', () => {
      if (window.electronAPI && window.electronAPI.hideToTray) {
        window.electronAPI.hideToTray();
      }
      apiPost('/api/window/control', { action: 'hide' });
    });

    document.getElementById('btn-open-web')?.addEventListener('click', () => {
      const port = (currentState && currentState.config && currentState.config.port) || 19876;
      const url = `http://localhost:${port}/?mode=web`;
      if (window.electronAPI) {
        window.electronAPI.openExternal(url);
      } else {
        window.open(url, '_blank');
      }
    });

    const toggleQuickSound = async () => {
      const next = !(currentState && currentState.config && currentState.config.soundEnabled);
      await apiPost('/api/config', { soundEnabled: next });
      if (next) playAlertSound(currentState?.config?.soundTone || 'chime');
    };
    document.getElementById('pill-btn-sound')?.addEventListener('click', toggleQuickSound);
    document.getElementById('btn-toggle-sound')?.addEventListener('click', toggleQuickSound);

    document.getElementById('btn-ack-all')?.addEventListener('click', () => {
      apiPost('/api/sessions/ack', { all: true });
    });

    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    document.querySelectorAll('.filter-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        activeFilter = chip.dataset.filter;
        document.querySelectorAll('.filter-chip').forEach((c) => c.classList.toggle('active', c === chip));
        if (currentState) renderSessionsList(currentState);
      });
    });

    // Buscador instantáneo de sesiones
    const searchInput = document.getElementById('session-search');
    searchInput?.addEventListener('input', (ev) => {
      searchQuery = ev.target.value || '';
      if (currentState) renderSessionsList(currentState);
    });

    // Acciones delegadas en filas de sesión (clic en botones)
    const sessionsListEl = document.getElementById('sessions-list');
    sessionsListEl?.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('button[data-action]');
      if (!btn) return;
      ev.stopPropagation();
      const action = btn.dataset.action;

      if (action === 'focus') {
        await apiPost('/api/sessions/focus', {
          id: btn.dataset.id,
          sessionId: btn.dataset.rawSessionId || btn.dataset.id,
          pid: Number(btn.dataset.pid) || null,
          provider: btn.dataset.provider,
          surface: btn.dataset.surface || 'cli',
          workspace: btn.dataset.workspace,
          title: btn.dataset.title
        });
        showToast(`🎯 Enfocando pestaña de ${btn.dataset.title || 'consola'}...`);
      } else if (action === 'pin') {
        togglePinSession(btn.dataset.id);
      } else if (action === 'ack') {
        await apiPost('/api/sessions/ack', { id: btn.dataset.id });
      } else if (action === 'remove-remote') {
        await apiPost('/api/remote/remove', { id: btn.dataset.id });
      } else if (action === 'copy') {
        await copyText(btn.dataset.copy, 'Ruta / ID copiada al portapapeles');
      }
    });

    // Magia: Doble clic en cualquier fila enfoca automáticamente esa pestaña exacta de consola
    sessionsListEl?.addEventListener('dblclick', async (ev) => {
      if (ev.target.closest('button')) return;
      const row = ev.target.closest('.session-row');
      if (!row) return;
      await apiPost('/api/sessions/focus', {
        id: row.dataset.sessionId,
        sessionId: row.dataset.rawSessionId || row.dataset.sessionId,
        pid: Number(row.dataset.pid) || null,
        provider: row.dataset.provider,
        surface: row.dataset.surface || 'cli',
        workspace: row.dataset.workspace,
        title: row.dataset.title
      });
      showToast(`🎯 Saltando a pestaña de ${row.dataset.title || 'consola'}...`);
    });

    // Probar aviso de Reseteo Gratis (Bonus) de Claude
    document.getElementById('btn-test-reset-alert')?.addEventListener('click', async () => {
      playAlertSound('reset', false);
      await apiPost('/api/quota/test-reset-alert', {});
      showToast('🎁 Alerta de Reseteo Gratis (Bonus) disparada');
    });

    // Hooks locales
    document.getElementById('chk-hook-claude')?.addEventListener('change', async (ev) => {
      await apiPost('/api/hooks/toggle', { target: 'claude', enabled: ev.target.checked });
      showToast(ev.target.checked ? 'Hook activado en Claude' : 'Hook desactivado en Claude');
    });

    document.getElementById('chk-hook-agy')?.addEventListener('change', async (ev) => {
      await apiPost('/api/hooks/toggle', { target: 'agy', enabled: ev.target.checked });
      showToast(ev.target.checked ? 'Hook activado en AGY' : 'Hook desactivado en AGY');
    });

    // Canal ntfy remoto y prueba
    document.getElementById('btn-save-topic')?.addEventListener('click', async () => {
      const val = document.getElementById('input-ntfy-topic')?.value.trim();
      if (!val) return;
      await apiPost('/api/config', { ntfyTopic: val });
      showToast('Canal remoto actualizado');
    });

    document.getElementById('btn-test-remote')?.addEventListener('click', async () => {
      await apiPost('/api/remote/test', {});
      showToast('Sesión remota de prueba simulada');
    });

    document.querySelectorAll('.btn-copy').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.copyTarget;
        const pre = document.getElementById(targetId);
        if (pre) copyText(pre.textContent, 'Comando copiado al portapapeles');
      });
    });

    // Agregar / quitar host SSH
    document.getElementById('btn-add-ssh')?.addEventListener('click', async () => {
      const label = document.getElementById('ssh-label')?.value.trim();
      const target = document.getElementById('ssh-target')?.value.trim();
      const port = Number(document.getElementById('ssh-port')?.value) || 22;
      const keyPath = document.getElementById('ssh-key')?.value.trim() || '';
      if (!target) return;

      const hosts = [...(currentState?.config?.sshHosts || [])];
      hosts.push({ label: label || target, target, port, keyPath, enabled: true });
      await apiPost('/api/config', { sshHosts: hosts });
      document.getElementById('ssh-label').value = '';
      document.getElementById('ssh-target').value = '';
      if (document.getElementById('ssh-key')) document.getElementById('ssh-key').value = '';
      showToast(keyPath ? 'Servidor SSH + Llave agregados' : 'Servidor SSH agregado');
    });

    document.getElementById('ssh-hosts-list')?.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('button[data-action="remove-ssh"]');
      if (!btn) return;
      const idx = Number(btn.dataset.index);
      const hosts = [...(currentState?.config?.sshHosts || [])];
      hosts.splice(idx, 1);
      await apiPost('/api/config', { sshHosts: hosts });
    });

    // Guardar límites de cuota AGY
    document.getElementById('btn-save-agy-limits')?.addEventListener('click', async () => {
      const l5 = Math.max(1, Number(document.getElementById('cfg-agy-5h')?.value) || 25);
      const l7 = Math.max(5, Number(document.getElementById('cfg-agy-7d')?.value) || 100);
      await apiPost('/api/config', { agyFiveHourLimitM: l5, agySevenDayLimitM: l7 });
      showToast('Presupuesto de referencia AGY actualizado');
    });

    // Ajustes de sonido y ventana
    document.getElementById('cfg-sound-enabled')?.addEventListener('change', (ev) => {
      apiPost('/api/config', { soundEnabled: ev.target.checked });
    });

    document.getElementById('cfg-sound-tone')?.addEventListener('change', (ev) => {
      apiPost('/api/config', { soundTone: ev.target.value });
      playAlertSound(ev.target.value);
    });

    document.getElementById('btn-test-sound')?.addEventListener('click', () => {
      const tone = document.getElementById('cfg-sound-tone')?.value || 'chime';
      playAlertSound(tone);
    });

    document.getElementById('cfg-desktop-notif')?.addEventListener('change', (ev) => {
      apiPost('/api/config', { desktopNotifications: ev.target.checked });
    });

    document.getElementById('cfg-always-top')?.addEventListener('change', (ev) => {
      const val = ev.target.checked;
      apiPost('/api/config', { alwaysOnTop: val });
      if (window.electronAPI) window.electronAPI.setAlwaysOnTop(val);
    });

    document.getElementById('cfg-opacity')?.addEventListener('input', (ev) => {
      const val = Number(ev.target.value);
      const lbl = document.getElementById('lbl-opacity');
      if (lbl) lbl.textContent = `${Math.round(val * 100)}%`;
      if (window.electronAPI) window.electronAPI.setOpacity(val);
    });

    document.getElementById('cfg-opacity')?.addEventListener('change', (ev) => {
      apiPost('/api/config', { opacity: Number(ev.target.value) });
    });

    document.getElementById('btn-quit-app')?.addEventListener('click', () => {
      if (window.electronAPI) window.electronAPI.quitApp();
      apiPost('/api/window/control', { action: 'quit' });
    });

    // Atajos de teclado rápidos
    window.addEventListener('keydown', (ev) => {
      const tag = (ev.target && ev.target.tagName) || '';
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if (ev.key === 'Escape') {
        if (isInput) {
          ev.target.blur();
          return;
        }
        if (!isWebMode && document.body.classList.contains('mode-expanded')) {
          requestWindowMode('pill');
        }
      } else if (!isInput && ev.key === '/') {
        ev.preventDefault();
        switchTab('sessions');
        document.getElementById('session-search')?.focus();
      } else if (!isInput && ['1', '2', '3', '4'].includes(ev.key)) {
        const tabs = ['sessions', 'tokens', 'remotes', 'settings'];
        switchTab(tabs[Number(ev.key) - 1]);
      }
    });
  }

  // =========================================================
  // CONEXIÓN SSE EN TIEMPO REAL (/api/stream)
  // =========================================================
  function connectRealtimeStream() {
    fetch('/api/state')
      .then((r) => r.json())
      .then((snap) => renderAll(snap))
      .catch(() => {});

    const es = new EventSource('/api/stream');

    es.addEventListener('state', (ev) => {
      try {
        const snap = JSON.parse(ev.data);
        renderAll(snap);
      } catch {}
    });

    es.addEventListener('alert', (ev) => {
      try {
        const alertObj = JSON.parse(ev.data);
        const cfg = (currentState && currentState.config) || { soundEnabled: true, soundTone: 'chime' };
        if (alertObj.alertType === 'quota_reset') {
          if (cfg.soundEnabled) playAlertSound('reset', false);
          showToast(alertObj.message || '🎁 ¡Claude reseteó tu cuota semanal!');
          return;
        }
        if (cfg.soundEnabled) {
          playAlertSound(cfg.soundTone || 'chime', alertObj.alertType === 'waiting_approval');
        }
      } catch {}
    });

    es.onerror = () => {
      es.close();
      setTimeout(connectRealtimeStream, 3000);
    };
  }

  document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    connectRealtimeStream();
  });
})();
