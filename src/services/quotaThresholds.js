function createQuotaThresholdNotifier(notify) {
  const windows = new Map();
  return (provider, quota, now = Date.now()) => {
    if (!quota || quota.stale || quota.available === false) return;
    if (provider === 'codex' && !['codex-app-server', 'local-session'].includes(quota.source)) return;
    for (const [key, label, pct, resetAt] of [
      ['5h', 'de 5h', quota.fiveHourPct, quota.nextFiveHourResetAt],
      ['7d', 'semanal', quota.sevenDayPct, quota.nextWeeklyResetAt]
    ]) {
      const resetEstimated = key === '5h' ? quota.nextFiveHourResetEstimated : quota.nextWeeklyResetEstimated;
      if (resetEstimated || (quota.estimated && resetEstimated == null)) continue;
      if (!Number.isFinite(pct) || !Number.isFinite(resetAt) || resetAt <= now) continue;
      const id = `${provider}:${key}`;
      let window = windows.get(id);
      // resets_at puede variar unos segundos entre lecturas: sólo una diferencia
      // de más de 10 min es una ventana nueva.
      if (!window || Math.abs(window.resetAt - resetAt) > 10 * 60000) {
        window = { resetAt, fired: new Set() };
        windows.set(id, window);
      }
      const crossed = [80, 95].filter((threshold) => pct >= threshold && !window.fired.has(threshold));
      if (!crossed.length) continue;
      crossed.forEach((threshold) => window.fired.add(threshold));
      const threshold = crossed[crossed.length - 1];
      const minutes = Math.ceil((resetAt - now) / 60000);
      const days = Math.floor(minutes / 1440);
      const hours = Math.floor((minutes % 1440) / 60);
      const countdown = days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
      const name = provider === 'claude' ? 'Claude' : 'Codex';
      notify({
        alertType: 'quota_threshold', provider, providerLabel: name,
        title: `${name} ${label} al ${threshold}% · resetea en ${countdown}`,
        message: `Consumo actual: ${pct}%.`, timestamp: now
      });
    }
  };
}

module.exports = { createQuotaThresholdNotifier };
