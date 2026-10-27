#!/usr/bin/env node
/**
 * Hook ligero para Claude Code y Antigravity (AGY)
 * Lee el evento JSON desde stdin, lo envía al servidor local del Widget (:19876)
 * y devuelve {} por stdout inmediatamente para no bloquear el loop del agente.
 */
import http from 'node:http';

const provider = process.argv[2] || 'auto';
const eventHint = process.argv[3] || '';
const port = Number(process.env.AI_WIDGET_PORT) || 19876;

let rawStdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  rawStdin += chunk;
});

process.stdin.on('end', () => {
  let payload = {};
  try {
    payload = rawStdin.trim() ? JSON.parse(rawStdin) : {};
  } catch {
    payload = { raw: rawStdin.slice(0, 500) };
  }

  const body = JSON.stringify({
    provider,
    eventHint,
    receivedAt: Date.now(),
    payload
  });

  const req = http.request(
    {
      hostname: '127.0.0.1',
      port,
      path: '/api/hooks/event',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 600
    },
    (res) => {
      res.resume();
      finish();
    }
  );

  req.on('error', () => finish());
  req.on('timeout', () => {
    req.destroy();
    finish();
  });

  req.write(body);
  req.end();
});

let done = false;
function finish() {
  if (done) return;
  done = true;
  process.stdout.write('{}\n');
  process.exit(0);
}

// Salvaguarda por si stdin no cierra rápido
setTimeout(finish, 800);
