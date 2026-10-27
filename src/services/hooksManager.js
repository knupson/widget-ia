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

/**
 * Verifica si los hooks del Widget están instalados en Claude y AGY
 */
function getHooksStatus() {
  const claudePath = getClaudeSettingsPath();
  const agyPath = getAgyHooksPath();

  let claudeInstalled = false;
  let agyInstalled = false;

  if (fs.existsSync(claudePath)) {
    try {
      const raw = fs.readFileSync(claudePath, 'utf8');
      claudeInstalled = raw.includes(HOOK_MARKER);
    } catch {}
  }

  if (fs.existsSync(agyPath)) {
    try {
      const raw = fs.readFileSync(agyPath, 'utf8');
      agyInstalled = raw.includes(HOOK_MARKER);
    } catch {}
  }

  return {
    claudeInstalled,
    agyInstalled,
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
      filtered.push({
        hooks: [
          {
            type: 'command',
            command: 'node',
            args: [scriptPath, 'claude', evt],
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
