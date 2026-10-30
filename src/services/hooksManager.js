const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK_MARKER = 'local-hook.mjs';

function getHookScriptPath() {
  return path.resolve(__dirname, '..', 'scripts', 'local-hook.mjs');
}

function getClaudeSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function getAgyHooksPath() {
  return path.join(os.homedir(), '.gemini', 'config', 'hooks.json');
}

// Extrae la ruta del script de un comando `node "<ruta>" ...`
function scriptPathFromCommand(cmd) {
  const m = typeof cmd === 'string' ? cmd.match(/"([^"]*local-hook\.mjs)"/) : null;
  return m ? m[1] : null;
}

/**
 * Estado de los hooks de Claude: 'installed' | 'outdated' (formato viejo o script inexistente) | 'missing'
 */
function claudeHookStatus(settings) {
  const hooks = settings && settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  let status = 'missing';
  for (const arr of Object.values(hooks)) {
    if (!Array.isArray(arr)) continue;
    for (const group of arr) {
      const entries = Array.isArray(group && group.hooks) ? group.hooks : [];
      for (const h of entries) {
        const cmd = typeof h.command === 'string' ? h.command : '';
        const legacy = Array.isArray(h.args) && JSON.stringify(h.args).includes(HOOK_MARKER);
        if (!legacy && !cmd.includes(HOOK_MARKER)) continue;
        const script = scriptPathFromCommand(cmd);
        if (legacy || !script || !fs.existsSync(script)) return 'outdated';
        status = 'installed';
      }
    }
  }
  return status;
}

/**
 * Estado del hook de AGY: 'installed' | 'outdated' | 'missing'
 */
function agyHookStatus(hooksObj) {
  const entry = hooksObj && hooksObj['ai-pulse-widget'];
  if (!entry) return 'missing';
  const cmd = entry.Stop && entry.Stop[0] ? entry.Stop[0].command : '';
  const script = scriptPathFromCommand(cmd);
  return script && fs.existsSync(script) ? 'installed' : 'outdated';
}

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Verifica si los hooks del Widget están instalados en Claude y AGY.
 * Si el script al que apunta el hook ya no existe, o el hook usa el formato viejo, el estado es 'outdated'.
 */
function getHooksStatus() {
  const claudeStatus = claudeHookStatus(readJsonSafe(getClaudeSettingsPath()));
  const agyStatus = agyHookStatus(readJsonSafe(getAgyHooksPath()));

  return {
    claudeInstalled: claudeStatus === 'installed',
    agyInstalled: agyStatus === 'installed',
    claudeStatus,
    agyStatus,
    hookScriptPath: getHookScriptPath()
  };
}

/**
 * Instala o desinstala de forma segura el hook en ~/.claude/settings.json
 * preservando intactos otros hooks del usuario (ej. write-guard.mjs)
 */
function setClaudeHookEnabled(enabled) {
  const settingsPath = getClaudeSettingsPath();
  const scriptPath = getHookScriptPath();

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      throw new Error('No se pudo parsear ~/.claude/settings.json');
    }
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }

  const events = ['Notification', 'Stop', 'SubagentStop'];
  for (const evt of events) {
    const arr = Array.isArray(settings.hooks[evt]) ? settings.hooks[evt] : [];
    // Filtrar entradas previas de nuestro widget
    const filtered = arr.filter((group) => {
      const str = JSON.stringify(group);
      return !str.includes(HOOK_MARKER);
    });

    if (enabled) {
      // Claude Code espera un único string `command`; el formato con args se migra quitándolo arriba
      filtered.push({
        hooks: [
          {
            type: 'command',
            command: `node "${scriptPath.replace(/\\/g, '/')}" claude ${evt}`,
            timeout: 5
          }
        ]
      });
    }

    if (filtered.length > 0) {
      settings.hooks[evt] = filtered;
    } else {
      delete settings.hooks[evt];
    }
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return getHooksStatus();
}

/**
 * Instala o desinstala de forma segura el hook en ~/.gemini/config/hooks.json
 */
function setAgyHookEnabled(enabled) {
  const hooksPath = getAgyHooksPath();
  const scriptPath = getHookScriptPath().replace(/\\/g, '/');

  let hooksObj = {};
  if (fs.existsSync(hooksPath)) {
    try {
      hooksObj = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    } catch {
      hooksObj = {};
    }
  }

  if (enabled) {
    hooksObj['ai-pulse-widget'] = {
      enabled: true,
      Stop: [
        {
          type: 'command',
          command: `node "${scriptPath}" agy Stop`,
          timeout: 5
        }
      ]
    };
  } else {
    delete hooksObj['ai-pulse-widget'];
  }

  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(hooksPath, JSON.stringify(hooksObj, null, 2), 'utf8');
  return getHooksStatus();
}

module.exports = {
  getHooksStatus,
  setClaudeHookEnabled,
  setAgyHookEnabled
};
