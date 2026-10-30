#!/usr/bin/env node
// statusLine de Claude Code: guarda la cuota real (rate_limits) para que AI Pulse la lea.
// Claude Code pasa un JSON por stdin; rate_limits sólo viene para Pro/Max y tras la primera
// respuesta de la API, y cada ventana puede faltar por separado.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT_DIR = path.join(os.homedir(), '.claude', 'ai-pulse');
const OUT_FILE = path.join(OUT_DIR, 'claude-rate-limits.json');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function windowOf(w) {
  if (!w || !Number.isFinite(Number(w.used_percentage))) return null;
  const resetsAt = Number(w.resets_at);
  return {
    pct: Math.max(0, Math.min(100, Number(w.used_percentage))),
    resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt * 1000 : null
  };
}

let input = {};
try {
  input = JSON.parse(readStdin() || '{}');
} catch {
  input = {};
}

const rl = input.rate_limits || {};
const fiveHour = windowOf(rl.five_hour);
const sevenDay = windowOf(rl.seven_day);

if (fiveHour || sevenDay) {
  const now = Date.now();
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
  } catch {}
  const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
  const unchanged = prev && same(prev.fiveHour, fiveHour) && same(prev.sevenDay, sevenDay);
  // updatedAt sólo avanza cuando cambian los datos; lastSeenAt dice que la sesión sigue reportando
  const snapshot = {
    fiveHour,
    sevenDay,
    updatedAt: unchanged && prev.updatedAt ? prev.updatedAt : now,
    lastSeenAt: now
  };
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const tmp = `${OUT_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot));
    fs.renameSync(tmp, OUT_FILE);
  } catch {}
}

const fmt = (w) => (w ? `${Math.round(w.pct)}%` : '--');
process.stdout.write(`⚡ 5h ${fmt(fiveHour)} · 7d ${fmt(sevenDay)}`);
