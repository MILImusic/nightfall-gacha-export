const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nightfall", {
  startCapture: () => ipcRenderer.invoke("capture:start"),
  finishCapture: () => ipcRenderer.invoke("capture:finish"),
  getData: () => ipcRenderer.invoke("data:get"),
  exportJson: () => ipcRenderer.invoke("data:export-json"),
  exportCsv: () => ipcRenderer.invoke("data:export-csv"),
  onAutoStatus: (callback) => ipcRenderer.on("capture:auto-status", (_event, payload) => callback(payload)),
});
