const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  openPrint(url) {
    return ipcRenderer.invoke("open-print", url);
  },
  pickRestoreDb() {
    return ipcRenderer.invoke("pick-restore-db");
  },
  restoreDb(filePath) {
    return ipcRenderer.invoke("restore-db", filePath);
  },
});
