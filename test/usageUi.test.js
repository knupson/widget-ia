const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fmtCompactTokens,
  fmtEstimatedUsd,
  fmtLocalDayKey,
  fmtSpanishDate,
  fmtHourEs,
  computeActivityLevel,
  buildCalendarGrid,
  computeTimeTicks,
  emptyHistoryMessage
} = require('../src/public/usage');

test('fmtCompactTokens y fmtEstimatedUsd formatean tokens y dólares estimados', () => {
  assert.equal(fmtCompactTokens(null), '--');
  assert.equal(fmtCompactTokens(840), '840');
  assert.equal(fmtCompactTokens(14500), '14.5k');
  assert.equal(fmtCompactTokens(2350000), '2.35M');
  assert.equal(fmtCompactTokens(1500000000), '1.50B');

  assert.equal(fmtEstimatedUsd(null), 'n/d');
  assert.equal(fmtEstimatedUsd(0), '~$0.00');
  assert.equal(fmtEstimatedUsd(0.004), '<~$0.01');
  assert.equal(fmtEstimatedUsd(4.256), '~$4.26');
  assert.equal(fmtEstimatedUsd(125.44), '~$125.4');
});

test('computeActivityLevel asigna niveles 0..4 proporcionales al máximo diario', () => {
  assert.equal(computeActivityLevel(0, 1000), 0);
  assert.equal(computeActivityLevel(100, 0), 0);
  assert.equal(computeActivityLevel(100, 1000), 1);
  assert.equal(computeActivityLevel(250, 1000), 2);
  assert.equal(computeActivityLevel(500, 1000), 3);
  assert.equal(computeActivityLevel(850, 1000), 4);
});

test('buildCalendarGrid arma 26 semanas hasta hoy sin inventar días futuros', () => {
  const now = new Date(2026, 9, 30, 15, 0, 0).getTime(); // Viernes 30 Oct 2026
  const todayKey = fmtLocalDayKey(new Date(now));
  const grid = buildCalendarGrid(
    [
      {
        date: todayKey,
        input: 1000,
        output: 500,
        cacheRead: 2000,
        cacheWrite: 500,
        total: 4000,
        peakHour: 14
      }
    ],
    now,
    26
  );

  assert.equal(grid.weeksCount, 26);
  assert.equal(grid.maxTokens, 4000);
  assert.ok(grid.cells.length >= 25 * 7 + 1 && grid.cells.length <= 26 * 7);

  const lastCell = grid.cells[grid.cells.length - 1];
  assert.equal(lastCell.date, todayKey);
  assert.equal(lastCell.isToday, true);
  assert.equal(lastCell.level, 4);
  assert.equal(lastCell.peakHour, 14);
});

test('computeTimeTicks y emptyHistoryMessage cubren rangos 1h/24h/7d/30d y estados vacíos', () => {
  const toMs = new Date(2026, 9, 30, 16, 0, 0).getTime();
  assert.ok(computeTimeTicks('1h', toMs - 3600_000, toMs).length >= 3);
  assert.ok(computeTimeTicks('24h', toMs - 86400_000, toMs).length >= 5);
  assert.ok(computeTimeTicks('7d', toMs - 7 * 86400_000, toMs).length >= 6);
  assert.ok(computeTimeTicks('30d', toMs - 30 * 86400_000, toMs).length >= 3);

  assert.match(emptyHistoryMessage(0, 5), /Todavía no hay muestras oficiales/);
  assert.match(emptyHistoryMessage(1, 5), /1 sola muestra oficial/);
  assert.match(fmtSpanishDate('2026-10-30'), /30 oct 2026/);
  assert.equal(fmtHourEs(14), '14:00 hs');
});
