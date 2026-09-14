const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  openPrint(url) {
    return ipcRenderer.invoke("open-print", url);
  },
});
