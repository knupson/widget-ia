const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MINUTE_MS,
  HOUR_MS,
  DAY_MS,
  extractOfficialQuotaValues,
  appendSample,
  pruneSamples,
  gapLimitMs,
  splitIntoRuns,
  buildChartSeries,
  queryRange,
  createUsageHistoryStore
} = require('../src/services/usageHistory');

test('extractOfficialQuotaValues solo toma valores oficiales vigentes y nunca convierte desconocidos en 0', () => {
  // Sin datos o vencidos (stale) -> arreglo vacío
  assert.deepEqual(extractOfficialQuotaValues({}), []);
  assert.deepEqual(
    extractOfficialQuotaValues({
      claudeQuota: { available: true, stale: true, fiveHourPct: 45, sevenDayPct: 80 },
      codexQuota: { available: false, fiveHourPct: 10, sevenDayPct: 20 }
    }),
    []
  );

  // Con valores parcialmente desconocidos (null / undefined) -> solo guarda las ventanas conocidas
  const vals = extractOfficialQuotaValues({
    claudeQuota: {
      available: true,
      stale: false,
      fiveHourPct: 34.56,
      sevenDayPct: null,
      nextFiveHourResetAt: 1760000000000
    },
    codexQuota: {
      available: true,
      stale: false,
      fiveHourPct: null,
      sevenDayPct: 12.3,
      nextWeeklyResetAt: 1760500000000
    }
  });

  assert.deepEqual(vals, [
    { k: 'claude_5h', p: 34.6, r: 1760000000000 },
    { k: 'codex_7d', p: 12.3, r: 1760500000000 }
  ]);
});

test('appendSample respeta el intervalo mínimo de 5 min salvo reseteo o clave nueva', () => {
  const t0 = 1_760_000_000_000;
  const claudeQuota = {
    available: true,
    stale: false,
    fiveHourPct: 20,
    sevenDayPct: 40,
    nextFiveHourResetAt: t0 + 2 * HOUR_MS
  };

  let state = appendSample([], { claudeQuota, now: t0 });
  assert.equal(state.samples.length, 1);
  assert.equal(state.changed, true);

  // 2 minutos después sin reseteo ni claves nuevas -> no agrega muestra
  state = appendSample(state.samples, {
    claudeQuota: { ...claudeQuota, fiveHourPct: 22 },
    now: t0 + 2 * MINUTE_MS
  });
  assert.equal(state.samples.length, 1);
  assert.equal(state.changed, false);

  // 3 minutos después aparece Codex por primera vez -> fusiona la clave en la muestra vigente
  state = appendSample(state.samples, {
    claudeQuota,
    codexQuota: { available: true, stale: false, fiveHourPct: 15, sevenDayPct: 5 },
    now: t0 + 3 * MINUTE_MS
  });
  assert.equal(state.samples.length, 1);
  assert.equal(state.changed, true);
  assert.equal(state.samples[0].v.length, 4);

  // 5 minutos después -> agrega segunda muestra
  state = appendSample(state.samples, {
    claudeQuota: { ...claudeQuota, fiveHourPct: 28 },
    now: t0 + 5 * MINUTE_MS
  });
  assert.equal(state.samples.length, 2);

  // 1 minuto después ocurre un reseteo de ventana (baja fuerte de % o nuevo nextFiveHourResetAt tras vencer)
  const resetTime = t0 + 2 * HOUR_MS + MINUTE_MS;
  state = appendSample(state.samples, {
    claudeQuota: {
      available: true,
      stale: false,
      fiveHourPct: 2,
      sevenDayPct: 42,
      nextFiveHourResetAt: resetTime + 5 * HOUR_MS
    },
    now: t0 + 5 * MINUTE_MS + 60 * 1000
  });
  assert.equal(state.samples.length, 3);
});

test('pruneSamples descarta muestras de más de 30 días', () => {
  const now = 1_760_000_000_000;
  const oldSample = { t: now - 31 * DAY_MS, v: [{ k: 'claude_5h', p: 50 }] };
  const recentSample = { t: now - 5 * DAY_MS, v: [{ k: 'claude_5h', p: 65 }] };

  const pruned = pruneSamples([oldSample, recentSample], now);
  assert.equal(pruned.length, 1);
  assert.equal(pruned[0].t, recentSample.t);
});

test('gapLimitMs y splitIntoRuns cortan las líneas en huecos sin datos o reseteos de ventana', () => {
  const step = 5 * MINUTE_MS;
  const samples = Array.from({ length: 6 }, (_, i) => ({ t: i * step }));
  assert.equal(gapLimitMs(samples), 20 * MINUTE_MS);

  const pts = [
    { t: 0, p: 10 },
    { t: 5 * MINUTE_MS, p: 20 },
    { t: 60 * MINUTE_MS, p: 30 },
    { t: 65 * MINUTE_MS, p: 5 } // caída de 25 pts -> reseteo
  ];
  const runs = splitIntoRuns(pts, 20 * MINUTE_MS);
  assert.deepEqual(
    runs.map((r) => r.map((x) => x.p)),
    [[10, 20], [30], [5]]
  );
});

test('createUsageHistoryStore persiste en disco y filtra por rango', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-pulse-hist-test-'));
  const filePath = path.join(tmpDir, 'usage-history.json');
  try {
    const store = createUsageHistoryStore({ filePath });
    const now = 1_760_000_000_000;

    store.record({
      claudeQuota: { available: true, stale: false, fiveHourPct: 12, sevenDayPct: 34 },
      now: now - 2 * HOUR_MS
    });
    store.record({
      claudeQuota: { available: true, stale: false, fiveHourPct: 25, sevenDayPct: 36 },
      now: now - 30 * MINUTE_MS
    });

    assert.equal(fs.existsSync(filePath), true);

    // Recargar desde otra instancia para verificar persistencia
    const store2 = createUsageHistoryStore({ filePath });
    const hist1h = store2.getHistory({ range: '1h', now });
    assert.equal(hist1h.samples.length, 1);
    assert.equal(hist1h.series[0].points[0].p, 25);

    const hist24h = store2.getHistory({ range: '24h', now });
    assert.equal(hist24h.samples.length, 2);
    assert.equal(hist24h.series.length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
