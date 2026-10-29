const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  screen,
  nativeImage,
  Notification,
  shell,
  clipboard
} = require('electron');
const fs = require('fs');
const path = require('path');
const { createWidgetServer } = require('./src/server');
const { focusSessionWindow } = require('./src/services/windowFocuser');
const { startFullscreenWatcher } = require('./src/services/fullscreenWatcher');

let mainWindow = null;
let tray = null;
let widgetServer = null;
let fullscreenWatcher = null;
let currentMode = 'pill'; // Arranca como píldora compacta flotante
let pillPosition = null; // { x, y }
let isProgrammaticMove = false;
let savePosTimer = null;
let hiddenByFullscreen = false;
let manualGamingHide = false;
let lastAppliedOpacity = 1;
let lastForegroundHwnd = null;
let updateTrayMenuFn = null;

const WIDGET_WIDTH = 586;
const PILL_WIDTH = WIDGET_WIDTH;
const PILL_HEIGHT = 56;
const EXPANDED_WIDTH = WIDGET_WIDTH;
const EXPANDED_HEIGHT = 640;

function persistWindowPosition(immediate = false) {
  if (!widgetServer || !pillPosition) return;
  if (savePosTimer) {
    clearTimeout(savePosTimer);
    savePosTimer = null;
  }
  const writeNow = () => {
    if (widgetServer && pillPosition) {
      widgetServer.updateConfig({
        windowPosition: { x: Math.round(pillPosition.x), y: Math.round(pillPosition.y) }
      });
    }
  };
  if (immediate) {
    writeNow();
  } else {
    savePosTimer = setTimeout(writeNow, 250);
  }
}

function applyLoginItemSetting(enabled) {
  try {
    const openAtLogin = enabled !== false;
    const packedExe = path.join(__dirname, 'dist', 'win-unpacked', 'AI Pulse Widget.exe');
    if (fs.existsSync(packedExe)) {
      app.setLoginItemSettings({
        openAtLogin,
        path: packedExe,
        args: []
      });
    } else {
      app.setLoginItemSettings({
        openAtLogin,
        path: process.execPath,
        args: [path.resolve(__dirname)]
      });
    }
  } catch {}
}

function applyWindowOpacity(val) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const clamped = Math.max(0.4, Math.min(1, typeof val === 'number' && !Number.isNaN(val) ? val : 1));
  // Cuando opacity == 1, evitamos forzar LWA_ALPHA (WS_EX_LAYERED) innecesario en DWM
  if (clamped >= 0.999) {
    if (lastAppliedOpacity < 0.999) {
      mainWindow.setOpacity(1);
    }
    lastAppliedOpacity = 1;
  } else if (Math.abs(clamped - lastAppliedOpacity) > 0.005) {
    mainWindow.setOpacity(clamped);
    lastAppliedOpacity = clamped;
  }
}

function enforceAlwaysOnTop() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (hiddenByFullscreen || manualGamingHide) return;
  const cfg = widgetServer ? widgetServer.getConfig() : { alwaysOnTop: true };
  if (cfg.alwaysOnTop !== false) {
    // En Windows, setSkipTaskbar, setResizable, SwitchToThisWindow o cambios de foco pueden
    // quitar WS_EX_TOPMOST en Win32 aunque Electron siga reportando isAlwaysOnTop() === true.
    // Alternar false -> true con nivel 'screen-saver' fuerza a Win32 a reaplicar HWND_TOPMOST sin robar foco.
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    if (mainWindow.isVisible()) {
      mainWindow.moveTop();
    }
  } else {
    mainWindow.setAlwaysOnTop(false);
  }
}

function evaluateFullscreenState(fgInfo) {
  if (!mainWindow || mainWindow.isDestroyed() || !widgetServer) return;
  const cfg = widgetServer.getConfig();
  const fgHwnd = fgInfo ? fgInfo.hwnd : null;
  const fgChanged = Boolean(fgHwnd && fgHwnd !== lastForegroundHwnd);
  lastForegroundHwnd = fgHwnd;

  if (cfg.autoHideFullscreen === false) {
    if (hiddenByFullscreen) {
      hiddenByFullscreen = false;
      if (!manualGamingHide) {
        mainWindow.showInactive();
        enforceAlwaysOnTop();
        widgetServer.forceBroadcast();
      }
      if (updateTrayMenuFn) updateTrayMenuFn();
    } else if (fgChanged && !manualGamingHide && (!fgInfo || fgInfo.pid !== process.pid)) {
      enforceAlwaysOnTop();
    }
    return;
  }

  let shouldHide = false;
  if (fgInfo && fgInfo.isFullscreen && fgInfo.pid !== process.pid) {
    const refBounds = pillPosition
      ? { x: pillPosition.x, y: pillPosition.y, width: PILL_WIDTH, height: PILL_HEIGHT }
      : mainWindow.getBounds();
    const widgetDisplay = screen.getDisplayMatching(refBounds);
    const monBounds = widgetDisplay ? widgetDisplay.bounds : null;
    if (monBounds) {
      const fgCenterX = fgInfo.monX + fgInfo.monWidth / 2;
      const fgCenterY = fgInfo.monY + fgInfo.monHeight / 2;
      const sameMonitor =
        fgCenterX >= monBounds.x &&
        fgCenterX <= monBounds.x + monBounds.width &&
        fgCenterY >= monBounds.y &&
        fgCenterY <= monBounds.y + monBounds.height;
      if (sameMonitor) {
        shouldHide = true;
      }
    }
  }

  if (shouldHide && !hiddenByFullscreen) {
    hiddenByFullscreen = true;
    mainWindow.setAlwaysOnTop(false);
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    }
    if (updateTrayMenuFn) updateTrayMenuFn();
  } else if (!shouldHide && hiddenByFullscreen) {
    hiddenByFullscreen = false;
    if (!manualGamingHide) {
      mainWindow.showInactive();
      enforceAlwaysOnTop();
      widgetServer.forceBroadcast();
    }
    if (updateTrayMenuFn) updateTrayMenuFn();
  } else if (!shouldHide && !hiddenByFullscreen && !manualGamingHide && fgChanged && (!fgInfo || fgInfo.pid !== process.pid)) {
    enforceAlwaysOnTop();
  }
}

/**
 * Genera un ícono circular 16x16 en memoria para el System Tray según el color de estado
 */
function createStatusTrayIcon(hexColor = '#10b981') {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const r = parseInt(hexColor.slice(1, 3), 16) || 16;
  const g = parseInt(hexColor.slice(3, 5), 16) || 185;
  const b = parseInt(hexColor.slice(5, 7), 16) || 129;

  const cx = 7.5;
  const cy = 7.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const idx = (y * size + x) * 4;
      if (dist <= 6.2) {
        buf[idx] = b;
        buf[idx + 1] = g;
        buf[idx + 2] = r;
        buf[idx + 3] = 255;
      } else if (dist <= 7.2) {
        buf[idx] = 30;
        buf[idx + 1] = 30;
        buf[idx + 2] = 35;
        buf[idx + 3] = 220;
      } else {
        buf[idx] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 0;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function setWindowMode(mode) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const display = screen.getDisplayMatching(mainWindow.getBounds());
  const workArea = display.workArea;

  if (currentMode === 'pill' && mode === 'expanded') {
    const b = mainWindow.getBounds();
    pillPosition = { x: b.x, y: b.y };
    persistWindowPosition(true);
  }

  currentMode = mode;
  isProgrammaticMove = true;

  if (mode === 'pill') {
    const targetX = pillPosition
      ? pillPosition.x
      : workArea.x + workArea.width - WIDGET_WIDTH - 20;
    const targetY = pillPosition ? pillPosition.y : workArea.y + 16;

    mainWindow.setResizable(false);
    mainWindow.setMinimumSize(WIDGET_WIDTH, PILL_HEIGHT);
    mainWindow.setMaximumSize(WIDGET_WIDTH, PILL_HEIGHT);
    mainWindow.setBounds({
      x: Math.max(workArea.x, Math.min(targetX, workArea.x + workArea.width - WIDGET_WIDTH)),
      y: Math.max(workArea.y, Math.min(targetY, workArea.y + workArea.height - PILL_HEIGHT)),
      width: WIDGET_WIDTH,
      height: PILL_HEIGHT
    });
  } else {
    const currentBounds = mainWindow.getBounds();
    let targetX = currentBounds.x;
    let targetY = currentBounds.y;

    if (targetX < workArea.x + 8) targetX = workArea.x + 8;
    if (targetX + WIDGET_WIDTH > workArea.x + workArea.width - 8) {
      targetX = workArea.x + workArea.width - WIDGET_WIDTH - 8;
    }
    if (targetY + EXPANDED_HEIGHT > workArea.y + workArea.height - 8) {
      targetY = Math.max(workArea.y + 8, workArea.y + workArea.height - EXPANDED_HEIGHT - 8);
    }

    mainWindow.setMinimumSize(WIDGET_WIDTH, 380);
    mainWindow.setMaximumSize(WIDGET_WIDTH, 1200);
    mainWindow.setResizable(true);
    mainWindow.setBounds({
      x: targetX,
      y: targetY,
      width: WIDGET_WIDTH,
      height: EXPANDED_HEIGHT
    });
  }

  setTimeout(() => {
    isProgrammaticMove = false;
  }, 80);

  mainWindow.setSkipTaskbar(true);
  enforceAlwaysOnTop();
  mainWindow.webContents.send('widget:modeChanged', currentMode);
}

function showDesktopNotification(alertObj) {
  if (!Notification.isSupported()) return;
  const isReset = alertObj.alertType === 'quota_reset';
  const isApproval = alertObj.alertType === 'waiting_approval';
  const title = isReset
    ? `🎁 ${alertObj.projectName || 'Reseteo de Cuota Claude'}`
    : isApproval
    ? `⚠️ Permiso requerido · ${alertObj.projectName}`
    : `✅ Terminó y espera respuesta · ${alertObj.projectName}`;
  const body = `${alertObj.providerLabel}: ${alertObj.title}\n${alertObj.message || ''}`;

  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  const notif = new Notification({
    title,
    body: body.slice(0, 220),
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    silent: true
  });

  notif.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      setWindowMode('expanded');
      mainWindow.focus();
    }
    if (!isReset) {
      focusSessionWindow({
        id: alertObj.sessionId,
        provider: alertObj.provider,
        workspace: alertObj.workspace,
        title: alertObj.title
      });
    }
  });

  notif.show();
}

function setupTray(port) {
  tray = new Tray(createStatusTrayIcon('#10b981'));
  tray.setToolTip('AI Pulse Widget · Claude & AGY Monitor');

  const updateMenu = () => {
    const cfg = widgetServer ? widgetServer.getConfig() : { autoHideFullscreen: true };
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Modo Píldora Compacta (HUD)',
        click: () => {
          manualGamingHide = false;
          hiddenByFullscreen = false;
          mainWindow.show();
          setWindowMode('pill');
          updateMenu();
        }
      },
      {
        label: 'Expandir Panel Completo',
        click: () => {
          manualGamingHide = false;
          hiddenByFullscreen = false;
          mainWindow.show();
          setWindowMode('expanded');
          mainWindow.focus();
          updateMenu();
        }
      },
      { type: 'separator' },
      {
        label: 'Siempre encima (Always on Top)',
        type: 'checkbox',
        checked: cfg.alwaysOnTop !== false,
        click: (menuItem) => {
          if (widgetServer) {
            widgetServer.updateConfig({ alwaysOnTop: Boolean(menuItem.checked) });
            widgetServer.forceBroadcast();
          }
          enforceAlwaysOnTop(true);
          updateMenu();
        }
      },
      {
        label: 'Modo Juego Automático (Ocultar en Fullscreen)',
        type: 'checkbox',
        checked: cfg.autoHideFullscreen !== false,
        click: (menuItem) => {
          if (widgetServer) {
            widgetServer.updateConfig({ autoHideFullscreen: menuItem.checked });
          }
          if (!menuItem.checked && hiddenByFullscreen) {
            hiddenByFullscreen = false;
            if (!manualGamingHide && mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.showInactive();
              enforceAlwaysOnTop(true);
              if (widgetServer) widgetServer.forceBroadcast();
            }
          }
          updateMenu();
        }
      },
      {
        label: 'Ocultar HUD temporalmente (Modo Juego Manual)',
        type: 'checkbox',
        checked: manualGamingHide,
        click: (menuItem) => {
          manualGamingHide = Boolean(menuItem.checked);
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (manualGamingHide) {
              mainWindow.setAlwaysOnTop(false);
              mainWindow.hide();
            } else {
              hiddenByFullscreen = false;
              mainWindow.showInactive();
              enforceAlwaysOnTop(true);
              if (widgetServer) widgetServer.forceBroadcast();
            }
          }
          updateMenu();
        }
      },
      { type: 'separator' },
      {
        label: `Abrir en Navegador (localhost:${port})`,
        click: () => {
          shell.openExternal(`http://localhost:${port}?mode=web`);
        }
      },
      { type: 'separator' },
      {
        label: 'Salir del Widget',
        click: () => {
          app.isQuitting = true;
          app.quit();
        }
      }
    ]);
    tray.setContextMenu(contextMenu);
  };

  updateTrayMenuFn = updateMenu;
  updateMenu();

  tray.on('click', () => {
    if (!mainWindow) return;
    if (!mainWindow.isVisible()) {
      manualGamingHide = false;
      hiddenByFullscreen = false;
      mainWindow.show();
      enforceAlwaysOnTop(true);
      mainWindow.focus();
      if (widgetServer) widgetServer.forceBroadcast();
      updateMenu();
    } else if (currentMode === 'pill') {
      setWindowMode('expanded');
      mainWindow.focus();
    } else {
      setWindowMode('pill');
    }
  });
}

async function initApp() {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      manualGamingHide = false;
      hiddenByFullscreen = false;
      mainWindow.setSkipTaskbar(true);
      setWindowMode(currentMode);
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.reloadIgnoringCache();
    }
  });

  widgetServer = createWidgetServer({
    isRendererVisible: () =>
      Boolean(
        mainWindow &&
          !mainWindow.isDestroyed() &&
          mainWindow.isVisible() &&
          !hiddenByFullscreen &&
          !manualGamingHide
      ),
    onAlert: (alertObj, cfg) => {
      if (cfg.desktopNotifications !== false) {
        showDesktopNotification(alertObj);
      }
      if (tray) {
        const color = alertObj.alertType === 'waiting_approval' ? '#f59e0b' : '#10b981';
        tray.setImage(createStatusTrayIcon(color));
      }
    },
    onConfigChange: (cfg) => {
      applyLoginItemSetting(cfg.launchAtStartup !== false);
      if (mainWindow && !mainWindow.isDestroyed()) {
        enforceAlwaysOnTop(true);
        if (typeof cfg.opacity === 'number') {
          applyWindowOpacity(cfg.opacity);
        }
        if (cfg.autoHideFullscreen === false && hiddenByFullscreen) {
          evaluateFullscreenState(null);
        }
      }
      if (updateTrayMenuFn) updateTrayMenuFn();
    },
    onWindowControl: (body) => {
      if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
      if (body.mode === 'pill' || body.mode === 'expanded') {
        setWindowMode(body.mode);
      }
      if (body.action === 'ensureTopmost') {
        enforceAlwaysOnTop();
        setTimeout(() => enforceAlwaysOnTop(), 80);
        setTimeout(() => enforceAlwaysOnTop(), 300);
      } else if (body.action === 'hide') {
        mainWindow.hide();
      } else if (body.action === 'quit') {
        persistWindowPosition(true);
        app.isQuitting = true;
        app.quit();
      } else if (body.action === 'reload') {
        mainWindow.webContents.reloadIgnoringCache();
      } else if (body.action === 'relaunch') {
        persistWindowPosition(true);
        app.isQuitting = true;
        app.relaunch();
        app.exit(0);
      }
      return { ok: true, mode: currentMode };
    }
  });

  const { port, config } = await widgetServer.start();
  applyLoginItemSetting(config.launchAtStartup !== false);

  const primaryDisplay = screen.getPrimaryDisplay();
  const defaultWorkArea = primaryDisplay.workArea;
  let startX = defaultWorkArea.x + defaultWorkArea.width - PILL_WIDTH - 20;
  let startY = defaultWorkArea.y + 16;

  if (
    config.windowPosition &&
    typeof config.windowPosition.x === 'number' &&
    typeof config.windowPosition.y === 'number'
  ) {
    const savedX = Math.round(config.windowPosition.x);
    const savedY = Math.round(config.windowPosition.y);
    const targetDisplay = screen.getDisplayMatching({
      x: savedX,
      y: savedY,
      width: PILL_WIDTH,
      height: PILL_HEIGHT
    });
    const wa = (targetDisplay && targetDisplay.workArea) || defaultWorkArea;
    startX = Math.max(wa.x, Math.min(savedX, wa.x + wa.width - PILL_WIDTH));
    startY = Math.max(wa.y, Math.min(savedY, wa.y + wa.height - PILL_HEIGHT));
  }
  pillPosition = { x: startX, y: startY };

  const customIconPath = path.join(__dirname, 'assets', 'icon.ico');
  mainWindow = new BrowserWindow({
    x: startX,
    y: startY,
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    frame: false,
    transparent: false,
    roundedCorners: true,
    resizable: false,
    show: false,
    alwaysOnTop: config.alwaysOnTop !== false,
    skipTaskbar: true,
    hasShadow: true,
    backgroundColor: '#090705',
    icon: fs.existsSync(customIconPath) ? customIconPath : undefined,
    title: 'AI Pulse Widget',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setSkipTaskbar(true);
  enforceAlwaysOnTop(true);
  if (typeof config.opacity === 'number') {
    applyWindowOpacity(config.opacity);
  }

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setSkipTaskbar(true);
    enforceAlwaysOnTop();
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setSkipTaskbar(true);
    enforceAlwaysOnTop();
    if (!hiddenByFullscreen && !manualGamingHide) {
      mainWindow.show();
    }
    mainWindow.webContents.send('widget:modeChanged', currentMode);
  });

  mainWindow.on('show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setSkipTaskbar(true);
      enforceAlwaysOnTop();
    }
  });

  mainWindow.on('restore', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setSkipTaskbar(true);
      enforceAlwaysOnTop();
    }
  });

  mainWindow.on('blur', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => enforceAlwaysOnTop(), 450);
    }
  });

  mainWindow.on('moved', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !isProgrammaticMove) {
      const b = mainWindow.getBounds();
      pillPosition = { x: b.x, y: b.y };
      persistWindowPosition(false);
    }
  });

  mainWindow.on('close', () => {
    if (mainWindow && !mainWindow.isDestroyed() && currentMode === 'pill') {
      const b = mainWindow.getBounds();
      pillPosition = { x: b.x, y: b.y };
    }
    persistWindowPosition(true);
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  setupTray(port);

  fullscreenWatcher = startFullscreenWatcher({
    onForegroundWindow: (fgInfo) => {
      evaluateFullscreenState(fgInfo);
    }
  });

  ipcMain.handle('widget:setMode', (_e, mode) => {
    setWindowMode(mode);
    return currentMode;
  });

  ipcMain.handle('widget:getMode', () => currentMode);

  ipcMain.handle('widget:setAlwaysOnTop', (_e, flag) => {
    const enabled = Boolean(flag);
    if (widgetServer) {
      widgetServer.updateConfig({ alwaysOnTop: enabled });
    }
    enforceAlwaysOnTop();
    if (updateTrayMenuFn) updateTrayMenuFn();
    return true;
  });

  ipcMain.handle('widget:setOpacity', (_e, val) => {
    applyWindowOpacity(Number(val) || 1);
    return true;
  });

  ipcMain.handle('widget:openExternal', (_e, url) => {
    const raw = String(url || '').trim();
    if (/^https?:\/\//i.test(raw)) {
      shell.openExternal(raw);
      return true;
    }
    return false;
  });

  ipcMain.handle('widget:copyText', (_e, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });

  ipcMain.handle('widget:hideToTray', () => {
    if (mainWindow) mainWindow.hide();
    return true;
  });

  ipcMain.handle('widget:quitApp', () => {
    app.isQuitting = true;
    app.quit();
  });
}

app.whenReady().then(initApp);

app.on('before-quit', () => {
  persistWindowPosition(true);
  if (fullscreenWatcher) fullscreenWatcher.stop();
  if (widgetServer) widgetServer.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
