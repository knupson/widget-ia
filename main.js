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

let mainWindow = null;
let tray = null;
let widgetServer = null;
let currentMode = 'pill'; // Arranca como píldora compacta flotante
let pillPosition = null; // { x, y }

const WIDGET_WIDTH = 516;
const PILL_WIDTH = WIDGET_WIDTH;
const PILL_HEIGHT = 54;
const EXPANDED_WIDTH = WIDGET_WIDTH;
const EXPANDED_HEIGHT = 640;

function enforceAlwaysOnTop() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const cfg = widgetServer ? widgetServer.getConfig() : { alwaysOnTop: true };
  if (cfg.alwaysOnTop !== false) {
    // En Windows, SwitchToThisWindow puede quitar WS_EX_TOPMOST de la ventana previa;
    // alternar false -> true con nivel 'screen-saver' fuerza a Chromium/Win32 a reaplicar HWND_TOPMOST sin robar foco.
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  } else {
    mainWindow.setAlwaysOnTop(false);
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
  }

  currentMode = mode;

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
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Modo Píldora Compacta (HUD)',
        click: () => {
          mainWindow.show();
          setWindowMode('pill');
        }
      },
      {
        label: 'Expandir Panel Completo',
        click: () => {
          mainWindow.show();
          setWindowMode('expanded');
          mainWindow.focus();
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

  updateMenu();

  tray.on('click', () => {
    if (!mainWindow) return;
    if (!mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
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
      mainWindow.setSkipTaskbar(true);
      setWindowMode(currentMode);
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.reloadIgnoringCache();
    }
  });

  widgetServer = createWidgetServer({
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
      if (mainWindow && !mainWindow.isDestroyed()) {
        enforceAlwaysOnTop();
        if (typeof cfg.opacity === 'number') {
          mainWindow.setOpacity(Math.max(0.4, Math.min(1, cfg.opacity)));
        }
      }
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
        app.isQuitting = true;
        app.quit();
      } else if (body.action === 'reload') {
        mainWindow.webContents.reloadIgnoringCache();
      } else if (body.action === 'relaunch') {
        app.isQuitting = true;
        app.relaunch();
        app.exit(0);
      }
      return { ok: true, mode: currentMode };
    }
  });

  const { port, config } = await widgetServer.start();

  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workArea;
  const startX = workArea.x + workArea.width - PILL_WIDTH - 20;
  const startY = workArea.y + 16;
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
  enforceAlwaysOnTop();
  if (typeof config.opacity === 'number') {
    mainWindow.setOpacity(Math.max(0.4, Math.min(1, config.opacity)));
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
    mainWindow.show();
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
      enforceAlwaysOnTop();
      setTimeout(() => enforceAlwaysOnTop(), 100);
    }
  });

  mainWindow.on('moved', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const b = mainWindow.getBounds();
      if (currentMode === 'pill') {
        pillPosition = { x: b.x, y: b.y };
      } else if (pillPosition) {
        pillPosition.x = b.x;
      }
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  setupTray(port);

  ipcMain.handle('widget:setMode', (_e, mode) => {
    setWindowMode(mode);
    return currentMode;
  });

  ipcMain.handle('widget:getMode', () => currentMode);

  ipcMain.handle('widget:setAlwaysOnTop', (_e, flag) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (Boolean(flag)) {
        mainWindow.setAlwaysOnTop(false);
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
      } else {
        mainWindow.setAlwaysOnTop(false);
      }
    }
    return true;
  });

  ipcMain.handle('widget:setOpacity', (_e, val) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setOpacity(Math.max(0.4, Math.min(1, Number(val) || 0.96)));
    }
    return true;
  });

  ipcMain.handle('widget:openExternal', (_e, url) => {
    shell.openExternal(url);
    return true;
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
  if (widgetServer) widgetServer.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
