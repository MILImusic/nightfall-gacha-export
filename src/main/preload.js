const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nightfall", {
  fetchHistory: () => ipcRenderer.invoke("history:fetch"),
  startProxy: () => ipcRenderer.invoke("proxy:start"),
  getProxyStatus: () => ipcRenderer.invoke("proxy:status"),
  getData: () => ipcRenderer.invoke("data:get"),
  exportJson: () => ipcRenderer.invoke("data:export-json"),
  exportCsv: () => ipcRenderer.invoke("data:export-csv"),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  collectDiagnostics: () => ipcRenderer.invoke("diagnostics:collect"),
  preflightCheck: () => ipcRenderer.invoke("preflight:check"),
  getWhatsNew: () => ipcRenderer.invoke("whatsnew:get"),
  ackWhatsNew: () => ipcRenderer.invoke("whatsnew:ack"),
  getDisclaimerAccepted: () => ipcRenderer.invoke("disclaimer:get"),
  acceptDisclaimer: () => ipcRenderer.invoke("disclaimer:accept"),
  onProgress: (callback) => ipcRenderer.on("history:progress", (_event, payload) => callback(payload)),
});
