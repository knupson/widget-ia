const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PRICES_AS_OF,
  MODEL_PRICES_USD_PER_M,
  resolveModelPricingKey,
  resolveModelFamily,
  estimateModelCostUsd,
  estimateByModelCostUsd,
  parseClaudeTranscriptContent,
  parseCodexTranscriptContent,
  aggregateUsageRecords,
  createIncrementalScanner,
  createProjectUsageAggregator
} = require('../src/services/projectUsage');

test('resolveModelPricingKey y estimateModelCostUsd resuelven tarifas por modelo/versión y devuelven null para desconocidos', () => {
  assert.ok(PRICES_AS_OF);
  assert.equal(resolveModelPricingKey('claude-opus-4-6-20260501'), 'claude-opus-4-6');
  assert.equal(resolveModelPricingKey('claude-opus-4-1-20250805'), 'claude-opus-4-1');
  assert.equal(resolveModelPricingKey('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');
  assert.equal(resolveModelPricingKey('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(resolveModelPricingKey('gpt-5-codex'), 'gpt-5-codex');
  assert.equal(resolveModelPricingKey('codex-mini-latest'), 'codex-mini-latest');
  assert.equal(resolveModelPricingKey('<synthetic>'), null);
  assert.equal(resolveModelPricingKey('codex'), null);
  assert.equal(resolveModelPricingKey('claude-opus-99-unknown'), null);
  assert.equal(resolveModelPricingKey('gpt-9-unknown'), null);

  assert.equal(resolveModelFamily('claude-opus-4-6'), 'opus');
  assert.equal(resolveModelFamily('gpt-5-codex', 'codex'), 'codex');

  // GPT-5-Codex: 1.25 input / 10 output / 0.125 cacheRead por millón
  const costGpt5Codex = estimateModelCostUsd(
    {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 0
    },
    'gpt-5-codex',
    'codex'
  );
  assert.equal(Math.round(costGpt5Codex * 1000) / 1000, 11.375);

  // Opus 4.1 (15 / 75) vs Opus 4.6 (5 / 25)
  const costOpus41 = estimateModelCostUsd(
    { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
    'claude-opus-4-1-20250805'
  );
  const costOpus46 = estimateModelCostUsd(
    { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
    'claude-opus-4-6'
  );
  assert.equal(costOpus41, 90);
  assert.equal(costOpus46, 30);

  // Modelo sin tarifa conocida devuelve null (incluso si el nombre incluye 'opus' o provider es 'codex')
  assert.equal(
    estimateModelCostUsd({ input: 500_000, output: 100_000, cacheWrite: 0, cacheRead: 0 }, 'unknown-1', 'codex'),
    null
  );
  assert.equal(
    estimateModelCostUsd({ input: 500_000, output: 100_000, cacheWrite: 0, cacheRead: 0 }, 'claude-opus-next'),
    null
  );
  assert.ok(MODEL_PRICES_USD_PER_M['claude-opus-4-1'].output > MODEL_PRICES_USD_PER_M['claude-opus-4-6'].output);
});

test('desglose de escritura de caché 5m (1.25x) vs 1h (2x) en parseClaudeTranscriptContent y estimateModelCostUsd', () => {
  const lines = [
    // Turno con desglose explícito de 5m (400k) y 1h (1M) en Sonnet 4.6 ($3 base -> $3.75 5m, $6.00 1h)
    JSON.stringify({
      type: 'assistant',
      cwd: 'E:\\Repositorios\\app',
      requestId: 'req-cache-1',
      timestamp: '2026-10-25T12:00:00.000Z',
      message: {
        id: 'msg-cache-1',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 1_400_000,
          cache_creation: {
            ephemeral_5m_input_tokens: 400_000,
            ephemeral_1h_input_tokens: 1_000_000
          },
          cache_read_input_tokens: 0
        }
      }
    }),
    // Turno sin objeto cache_creation -> cae por defecto como escritura de 5m (600k)
    JSON.stringify({
      type: 'assistant',
      cwd: 'E:\\Repositorios\\app',
      requestId: 'req-cache-2',
      timestamp: '2026-10-25T12:05:00.000Z',
      message: {
        id: 'msg-cache-2',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 600_000,
          cache_read_input_tokens: 0
        }
      }
    })
  ].join('\n');

  const parsed = parseClaudeTranscriptContent(lines);
  const day = Object.values(parsed.daily)[0];
  assert.equal(day.tokens.cacheWrite5m, 1_000_000); // 400k + 600k fallback
  assert.equal(day.tokens.cacheWrite1h, 1_000_000);
  assert.equal(day.tokens.cacheWrite, 2_000_000);

  // Costo en Sonnet 4.6: 1M * 3.75 (5m) + 1M * 6.00 (1h) = 9.75 USD
  const cost = estimateModelCostUsd(day.tokens, 'claude-sonnet-4-6');
  assert.equal(Math.round(cost * 100) / 100, 9.75);
});

test('estimateByModelCostUsd y aggregateUsageRecords marcan costo parcial o null cuando faltan tarifas', () => {
  // Todos desconocidos -> estimatedCostUsd: null, costPartial: false
  const allUnknown = estimateByModelCostUsd({
    'modelo-nuevo-2027': {
      provider: 'claude',
      tokens: { input: 100_000, output: 50_000, cacheRead: 0, cacheWrite: 0, total: 150_000 }
    }
  });
  assert.equal(allUnknown.estimatedCostUsd, null);
  assert.equal(allUnknown.costPartial, false);
  assert.equal(allUnknown.unpricedTokens, 150_000);
  assert.deepEqual(allUnknown.unpricedModels, ['modelo-nuevo-2027']);

  // Mezcla de modelo conocido y desconocido -> costPartial: true + subtotal conocido
  const mixed = estimateByModelCostUsd({
    'claude-sonnet-4-6': {
      provider: 'claude',
      tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 }
    },
    'gpt-futuro-x': {
      provider: 'codex',
      tokens: { input: 500_000, output: 100_000, cacheRead: 0, cacheWrite: 0, total: 600_000 }
    }
  });
  assert.equal(mixed.estimatedCostUsd, 3.0);
  assert.equal(mixed.knownCostUsd, 3.0);
  assert.equal(mixed.costPartial, true);
  assert.equal(mixed.unpricedTokens, 600_000);
  assert.deepEqual(mixed.unpricedModels, ['gpt-futuro-x']);

  const now = Date.parse('2026-10-30T18:00:00.000Z');
  const rec = parseClaudeTranscriptContent(
    [
      JSON.stringify({
        type: 'assistant',
        cwd: 'E:\\Repositorios\\mix-proj',
        requestId: 'r-known',
        timestamp: '2026-10-29T10:00:00.000Z',
        message: {
          id: 'm-known',
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 1_000_000, output_tokens: 0 }
        }
      }),
      JSON.stringify({
        type: 'assistant',
        cwd: 'E:\\Repositorios\\mix-proj',
        requestId: 'r-unknown',
        timestamp: '2026-10-29T10:05:00.000Z',
        message: {
          id: 'm-unknown',
          model: 'claude-experimental-x',
          usage: { input_tokens: 500_000, output_tokens: 200_000 }
        }
      })
    ].join('\n')
  );

  const report = aggregateUsageRecords([rec], { now });
  assert.equal(report.projects.length, 1);
  assert.equal(report.projects[0].costPartial, true);
  assert.equal(report.projects[0].estimatedCostUsd, 1.0);
  assert.deepEqual(report.projects[0].unpricedModels, ['claude-experimental-x']);
  assert.equal(report.totals.costPartial, true);
});

test('parseClaudeTranscriptContent deduplica por message.id + requestId (idénticos y progresivos en streaming)', () => {
  const lines = [
    JSON.stringify({
      type: 'user',
      cwd: 'E:\\Repositorios\\mi-app\\src\\components',
      timestamp: '2026-10-20T14:05:00.000Z'
    }),
    // Primer chunk de streaming con conteo parcial (output: 50)
    JSON.stringify({
      type: 'assistant',
      cwd: 'E:\\Repositorios\\mi-app',
      requestId: 'req-1',
      timestamp: '2026-10-20T14:10:00.000Z',
      message: {
        id: 'msg-1',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 1000,
          output_tokens: 50,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 300
        }
      }
    }),
    // Chunk final del mismo message.id + requestId con output actualizado (500) -> reemplaza al anterior sin duplicar
    JSON.stringify({
      type: 'assistant',
      requestId: 'req-1',
      timestamp: '2026-10-20T14:10:01.000Z',
      message: {
        id: 'msg-1',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 300
        }
      }
    }),
    // Repetición exacta del mismo message.id + requestId -> se ignora
    JSON.stringify({
      type: 'assistant',
      requestId: 'req-1',
      timestamp: '2026-10-20T14:10:02.000Z',
      message: {
        id: 'msg-1',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 300
        }
      }
    }),
    // Mensaje sintético -> se ignora
    JSON.stringify({
      type: 'assistant',
      requestId: 'req-synth',
      timestamp: '2026-10-20T14:12:00.000Z',
      message: {
        id: 'msg-synth',
        model: '<synthetic>',
        usage: { input_tokens: 9999, output_tokens: 9999 }
      }
    })
  ].join('\n');

  const parsed = parseClaudeTranscriptContent(lines);
  assert.equal(parsed.hasUsage, true);
  assert.equal(parsed.cwd, 'E:\\Repositorios\\mi-app');
  const days = Object.values(parsed.daily);
  assert.equal(days.length, 1);
  assert.equal(days[0].tokens.input, 1000);
  assert.equal(days[0].tokens.output, 500);
  assert.equal(days[0].tokens.cacheWrite, 200);
  assert.equal(days[0].tokens.cacheRead, 300);
  assert.equal(days[0].tokens.total, 2000);
});

test('parseCodexTranscriptContent calcula deltas acumulados de sesiones de Codex', () => {
  const lines = [
    JSON.stringify({
      timestamp: '2026-10-21T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'cx-1', cwd: 'E:\\Repositorios\\mi-app' }
    }),
    JSON.stringify({
      timestamp: '2026-10-21T10:00:05.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-5-codex' }
    }),
    JSON.stringify({
      timestamp: '2026-10-21T10:01:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 400,
            output_tokens: 200,
            total_tokens: 1200
          }
        }
      }
    }),
    JSON.stringify({
      timestamp: '2026-10-21T10:02:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1500,
            cached_input_tokens: 600,
            output_tokens: 350,
            total_tokens: 1850
          }
        }
      }
    })
  ].join('\n');

  const parsed = parseCodexTranscriptContent(lines);
  assert.equal(parsed.hasUsage, true);
  assert.equal(parsed.cwd, 'E:\\Repositorios\\mi-app');
  const days = Object.values(parsed.daily);
  assert.equal(days.length, 1);
  assert.equal(days[0].tokens.input, 900);
  assert.equal(days[0].tokens.cacheRead, 600);
  assert.equal(days[0].tokens.output, 350);
  assert.equal(days[0].tokens.total, 1850);
});

test('createIncrementalScanner lee por byte offset al agregar líneas y relee desde 0 si el archivo se achica', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-pulse-inc-test-'));
  const claudeDir = path.join(tmpRoot, 'claude-projects');
  const codexDir = path.join(tmpRoot, 'codex-sessions');
  try {
    const slugDir = path.join(claudeDir, 'E--Repositorios-inc');
    fs.mkdirSync(slugDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });

    const now = Date.parse('2026-10-30T18:00:00.000Z');
    const sessFile = path.join(slugDir, 'sess-1.jsonl');

    const line1 =
      JSON.stringify({
        type: 'assistant',
        cwd: 'E:\\Repositorios\\inc',
        requestId: 'r1',
        timestamp: '2026-10-29T15:00:00.000Z',
        message: {
          id: 'm1',
          model: 'claude-opus-4-6',
          usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }
      }) + '\n';

    fs.writeFileSync(sessFile, line1);
    const size1 = Buffer.byteLength(line1, 'utf8');

    const scanner = createIncrementalScanner({
      claudeProjectsDir: claudeDir,
      codexSessionsDir: codexDir
    });

    // 1. Primera lectura completa
    const res1 = scanner.scan({ now });
    assert.equal(res1.stats.fullReadFiles, 1);
    assert.equal(res1.stats.incrementalFiles, 0);
    assert.equal(res1.stats.bytesRead, size1);
    assert.equal(res1.report.totals.tokens.total, 1500);
    assert.equal(scanner.getFileCacheEntry(sessFile).offset, size1);

    // 2. Sin cambios -> hit de caché (0 bytes leídos)
    const res2 = scanner.scan({ now: now + 1000 });
    assert.equal(res2.stats.cachedFiles, 1);
    assert.equal(res2.stats.bytesRead, 0);
    assert.equal(res2.report.totals.tokens.total, 1500);

    // 3. Append al archivo -> lectura incremental solo de los nuevos bytes
    const line2 =
      JSON.stringify({
        type: 'assistant',
        cwd: 'E:\\Repositorios\\inc',
        requestId: 'r2',
        timestamp: '2026-10-29T15:10:00.000Z',
        message: {
          id: 'm2',
          model: 'claude-opus-4-6',
          usage: { input_tokens: 400, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }
      }) + '\n';
    fs.appendFileSync(sessFile, line2);
    const size2 = Buffer.byteLength(line2, 'utf8');

    const res3 = scanner.scan({ now: now + 2000 });
    assert.equal(res3.stats.incrementalFiles, 1);
    assert.equal(res3.stats.fullReadFiles, 0);
    assert.equal(res3.stats.bytesRead, size2);
    assert.equal(res3.report.totals.tokens.total, 2000);
    assert.equal(scanner.getFileCacheEntry(sessFile).offset, size1 + size2);

    // 4. Si el archivo se trunca / achica, se relee completo desde offset 0
    const shorterLine =
      JSON.stringify({
        type: 'assistant',
        cwd: 'E:\\Repositorios\\inc',
        requestId: 'r3',
        timestamp: '2026-10-29T16:00:00.000Z',
        message: {
          id: 'm3',
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 200, output_tokens: 100 }
        }
      }) + '\n';
    fs.writeFileSync(sessFile, shorterLine);
    const res4 = scanner.scan({ now: now + 3000 });
    assert.equal(res4.stats.fullReadFiles, 1);
    assert.equal(res4.report.totals.tokens.total, 300);

    // 5. Si las fuentes dejan de poder leerse, conserva el último resumen válido marcado como stale
    fs.rmSync(claudeDir, { recursive: true, force: true });
    fs.rmSync(codexDir, { recursive: true, force: true });
    const res5 = scanner.scan({ now: now + 4000 });
    assert.equal(res5.report.stale, true);
    assert.equal(res5.report.totals.tokens.total, 300);
    assert.equal(res5.report.coverage.status, 'error');
    assert.ok(res5.report.coverage.errorCount > 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('createProjectUsageAggregator ejecuta en worker_threads, devuelve computing: true y actualiza al terminar', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-pulse-proj-worker-test-'));
  const claudeDir = path.join(tmpRoot, 'claude-projects');
  const codexDir = path.join(tmpRoot, 'codex-sessions');
  const agg = createProjectUsageAggregator({
    claudeProjectsDir: claudeDir,
    codexSessionsDir: codexDir,
    cacheTtlMs: 0
  });

  try {
    const slugDir = path.join(claudeDir, 'E--Repositorios-demo');
    const subagentsDir = path.join(slugDir, 'sess-1', 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });

    const now = Date.parse('2026-10-30T18:00:00.000Z');

    fs.writeFileSync(
      path.join(slugDir, 'sess-1.jsonl'),
      JSON.stringify({
        type: 'assistant',
        cwd: 'E:\\Repositorios\\demo',
        requestId: 'r1',
        timestamp: '2026-10-29T15:00:00.000Z',
        message: {
          id: 'm1',
          model: 'claude-opus-4-6',
          usage: { input_tokens: 2000, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 }
        }
      }) + '\n'
    );

    fs.writeFileSync(
      path.join(subagentsDir, 'agent-a.jsonl'),
      JSON.stringify({
        type: 'assistant',
        cwd: 'E:\\Repositorios\\demo\\packages\\core',
        requestId: 'r2',
        timestamp: '2026-10-29T15:05:00.000Z',
        message: {
          id: 'm2',
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 500, output_tokens: 250, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }
      }) + '\n'
    );

    // El primer llamado sincrónico no bloquea y devuelve computing: true mientras corre el worker
    const immediate = agg.getUsageReport({ now });
    assert.equal(immediate.computing, true);

    // Esperar a que el worker complete el escaneo
    const report1 = await agg.refresh({ now });
    assert.equal(report1.computing, false);
    assert.ok(report1.updatedAt);
    assert.equal(agg.getCacheSize(), 2);
    assert.equal(report1.projects.length, 1);
    assert.equal(report1.projects[0].name, 'demo');
    assert.equal(report1.projects[0].path, 'E:\\Repositorios\\demo');
    assert.equal(report1.projects[0].sessions, 1);
    assert.equal(report1.projects[0].tokens.total, 4250);
    assert.ok(report1.projects[0].estimatedCostUsd > 0);
    assert.equal(report1.activity.days.length, 1);
    assert.equal(report1.activity.days[0].total, 4250);
  } finally {
    await agg.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
