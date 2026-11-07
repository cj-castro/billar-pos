const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  getUrl: () => ipcRenderer.invoke('cfg:get'),
  saveUrl: (url) => ipcRenderer.invoke('cfg:save', url), // tests, saves, navigates
  retry: () => ipcRenderer.invoke('cfg:retry'),
});
