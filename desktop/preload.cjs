// Minimal, safe bridge between the UI (web/src/lib/desktop.ts) and the desktop app.
const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');

contextBridge.exposeInMainWorld('cadre', {
  platform: process.platform,
  pickFiles: (opts) => ipcRenderer.invoke('pick-files', opts || {}),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  setZoom: (z) => { try { webFrame.setZoomFactor(Math.max(0.6, Math.min(2, Number(z) || 1))); } catch { /* window closed */ } },
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  reveal: (p) => ipcRenderer.send('reveal', p),
  openExternal: (u) => ipcRenderer.send('open-external', u),
  onMenu: (cb) => {
    const h = (_e, action) => cb(action);
    ipcRenderer.on('menu', h);
    return () => ipcRenderer.removeListener('menu', h);
  },
});
