// The renderer's only way out of its sandbox: three calls to the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('focusTimer', {
  load: () => ipcRenderer.invoke('focus:load'),
  finished: (session) => ipcRenderer.invoke('focus:finished', session),
  running: (running) => ipcRenderer.send('focus:running', running),
});
