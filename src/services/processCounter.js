const { execFile } = require('child_process');

const QUERY = `Get-CimInstance Win32_Process -Filter "Name='claude.exe' OR Name='codex.exe' OR Name='agy.exe'" | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`;
let counts = { claude: 0, codex: 0, agy: 0, updatedAt: null };
let timer = null;
let pending = false;
let generation = 0;

function refresh() {
  if (pending) return;
  pending = true;
  const currentGeneration = generation;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', QUERY],
    { timeout: 8000, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      pending = false;
      if (error || currentGeneration !== generation) return;
      try {
        const output = stdout.trim();
        const parsed = output ? JSON.parse(output) : [];
        const processes = Array.isArray(parsed) ? parsed : [parsed];
        const named = (name) => processes.filter((p) => String(p.Name).toLowerCase() === name);
        const codex = named('codex.exe').filter((p) => !String(p.CommandLine || '').toLowerCase().includes(' app-server'));
        // `agy models` lo lanza el propio widget para renovar el token de cuota: no es una sesión
        const agy = named('agy.exe').filter((p) => !/\smodels\s*$/i.test(String(p.CommandLine || '')));
        const topLevelCount = (items) => {
          const ids = new Set(items.map((p) => Number(p.ProcessId)));
          return items.filter((p) => !ids.has(Number(p.ParentProcessId))).length;
        };
        counts = {
          claude: named('claude.exe').length,
          codex: topLevelCount(codex),
          agy: topLevelCount(agy),
          updatedAt: Date.now()
        };
      } catch {
        // Conservar la última lectura válida si PowerShell devuelve datos inválidos.
      }
    });
}

function start() {
  if (timer) return;
  refresh();
  timer = setInterval(refresh, 10000);
  timer.unref();
}

function stop() {
  clearInterval(timer);
  timer = null;
  generation++;
}

function getCounts() {
  return { ...counts };
}

module.exports = { start, stop, getCounts };
