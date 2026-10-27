const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  setMode: (mode) => ipcRenderer.invoke('widget:setMode', mode),
  setWindowMode: (mode) => ipcRenderer.invoke('widget:setMode', mode),
  getMode: () => ipcRenderer.invoke('widget:getMode'),
  getWindowMode: () => ipcRenderer.invoke('widget:getMode'),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('widget:setAlwaysOnTop', flag),
  setOpacity: (val) => ipcRenderer.invoke('widget:setOpacity', val),
  openExternal: (url) => ipcRenderer.invoke('widget:openExternal', url),
  copyText: (text) => ipcRenderer.invoke('widget:copyText', text),
  copyToClipboard: (text) => ipcRenderer.invoke('widget:copyText', text),
  hideToTray: () => ipcRenderer.invoke('widget:hideToTray'),
  quitApp: () => ipcRenderer.invoke('widget:quitApp'),
  onModeChanged: (callback) => {
    ipcRenderer.on('widget:modeChanged', (_event, mode) => callback(mode));
  },
  onWindowModeChanged: (callback) => {
    ipcRenderer.on('widget:modeChanged', (_event, mode) => callback(mode));
  }
});
