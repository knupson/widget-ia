const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PRICES_AS_OF,
  MODEL_FAMILY_PRICES_USD_PER_M,
  resolveModelFamily,
  estimateModelCostUsd,
  parseClaudeTranscriptContent,
  parseCodexTranscriptContent,
  aggregateUsageRecords,
  createProjectUsageAggregator
} = require('../src/services/projectUsage');

test('resolveModelFamily y estimateModelCostUsd clasifican familias y calculan costo estimado en USD', () => {
  assert.ok(PRICES_AS_OF);
  assert.equal(resolveModelFamily('claude-opus-4-6-20260501'), 'opus');
  assert.equal(resolveModelFamily('claude-sonnet-4-5-20250929'), 'sonnet');
  assert.equal(resolveModelFamily('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(resolveModelFamily('gpt-5-codex', 'codex'), 'codex');
  assert.equal(resolveModelFamily('<synthetic>'), null);
  assert.equal(resolveModelFamily('modelo-desconocido-xyz'), null);

  // 1M de cada tipo en sonnet: 3 + 15 + 3.75 + 0.30 = 22.05 USD
  const costSonnet = estimateModelCostUsd(
    {
      input: 1_000_000,
      output: 1_000_000,
      cacheWrite: 1_000_000,
      cacheRead: 1_000_000
    },
    'claude-sonnet-4-6'
  );
  assert.equal(Math.round(costSonnet * 100) / 100, 22.05);

  // Modelo desconocido devuelve null (nunca 0 inventado)
  assert.equal(
    estimateModelCostUsd({ input: 500_000, output: 100_000, cacheWrite: 0, cacheRead: 0 }, 'unknown-1'),
    null
  );
  assert.ok(MODEL_FAMILY_PRICES_USD_PER_M.opus.output > MODEL_FAMILY_PRICES_USD_PER_M.haiku.output);
});

test('parseClaudeTranscriptContent deduplica por requestId, ignora <synthetic> y conserva el cwd más corto', () => {
  const lines = [
    JSON.stringify({
      type: 'user',
      cwd: 'E:\\Repositorios\\mi-app\\src\\components',
      timestamp: '2026-10-20T14:05:00.000Z'
    }),
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
          output_tokens: 500,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 300
        }
      }
    }),
    // Duplicado del mismo requestId en streaming -> se ignora
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
  // input neto = (1000-400) + (500-200) = 900; cacheRead = 600; output = 350; total = 1850
  assert.equal(days[0].tokens.input, 900);
  assert.equal(days[0].tokens.cacheRead, 600);
  assert.equal(days[0].tokens.output, 350);
  assert.equal(days[0].tokens.total, 1850);
});

test('createProjectUsageAggregator escanea directorios, agrupa subdirectorios y reutiliza caché por mtime/size', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-pulse-proj-test-'));
  const claudeDir = path.join(tmpRoot, 'claude-projects');
  const codexDir = path.join(tmpRoot, 'codex-sessions');
  try {
    const slugDir = path.join(claudeDir, 'E--Repositorios-demo');
    const subagentsDir = path.join(slugDir, 'sess-1', 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });

    const now = Date.parse('2026-10-30T18:00:00.000Z');

    // Sesión principal en raíz del proyecto
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

    // Subagente que corrió dentro de un subdirectorio del mismo proyecto
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

    const agg = createProjectUsageAggregator({
      claudeProjectsDir: claudeDir,
      codexSessionsDir: codexDir,
      cacheTtlMs: 0
    });

    const report1 = agg.getUsageReport({ now });
    assert.equal(agg.getCacheSize(), 2);
    assert.equal(report1.projects.length, 1);
    assert.equal(report1.projects[0].name, 'demo');
    assert.equal(report1.projects[0].path, 'E:\\Repositorios\\demo');
    assert.equal(report1.projects[0].sessions, 1); // el subagente no infla el conteo de sesiones
    assert.equal(report1.projects[0].tokens.total, 4250);
    assert.ok(report1.projects[0].estimatedCostUsd > 0);
    assert.equal(report1.activity.days.length, 1);
    assert.equal(report1.activity.days[0].total, 4250);

    // Segunda llamada sin cambios en archivos reutiliza las entradas cacheadas
    const report2 = agg.getUsageReport({ now: now + 1000 });
    assert.equal(report2.totals.tokens.total, 4250);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
