const { app, BrowserWindow, dialog, globalShortcut, ipcMain } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { autoPaginate, capturePaths, startCapture, stopAndParseCapture } = require("./capture");
const { loadStore, mergeCapture, toCsv } = require("./store");

let captureActive = false;
let paginationActive = false;
let mainWindow;

function resourcePath(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(app.getAppPath(), "resources", name);
}

function dataPath() {
  return path.join(app.getPath("userData"), "records.json");
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 840,
    minHeight: 600,
    backgroundColor: "#111318",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  window.loadFile(path.join(__dirname, "../renderer/index.html"));
  mainWindow = window;
}

async function finishCapture() {
  if (!captureActive) throw new Error("尚未开始捕获");
  const paths = capturePaths(app.getPath("temp"));
  try {
    const capture = await stopAndParseCapture({ scriptPath: resourcePath("capture.ps1"), ...paths });
    if (capture.records.length === 0) {
      throw new Error("没有捕获到抽卡历史。请先打开“契约记录”，再点“全部记录”。");
    }
    if (!capture.complete) {
      throw new Error(`只读到 ${capture.records.length}/${capture.expectedTotal || "?"} 条。请重新开始捕获，再把鼠标放在下一页箭头上按 F8 自动翻页。`);
    }
    return mergeCapture(dataPath(), { ...capture, capturedAt: new Date().toISOString() });
  } finally {
    captureActive = false;
  }
}

ipcMain.handle("capture:start", async () => {
  if (process.platform !== "win32") throw new Error("数据捕获仅支持 Windows");
  if (captureActive) return { active: true };
  const paths = capturePaths(app.getPath("temp"));
  await startCapture({ scriptPath: resourcePath("capture.ps1"), ...paths });
  captureActive = true;
  return { active: true };
});

ipcMain.handle("capture:finish", async () => {
  const store = await finishCapture();
  return { active: false, store };
});

ipcMain.handle("data:get", () => loadStore(dataPath()));

ipcMain.handle("data:export-json", async () => {
  const store = await loadStore(dataPath());
  const result = await dialog.showSaveDialog({ defaultPath: "nightfall-gacha-records.json", filters: [{ name: "JSON", extensions: ["json"] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  return { canceled: false };
});

ipcMain.handle("data:export-csv", async () => {
  const store = await loadStore(dataPath());
  const result = await dialog.showSaveDialog({ defaultPath: "nightfall-gacha-records.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, `\ufeff${toCsv(store)}`, "utf8");
  return { canceled: false };
});

app.whenReady().then(() => {
  createWindow();
  globalShortcut.register("F8", async () => {
    if (!captureActive || paginationActive) return;
    paginationActive = true;
    mainWindow?.webContents.send("capture:auto-status", { state: "running" });
    try {
      await autoPaginate({ scriptPath: resourcePath("paginate.ps1") });
      const store = await finishCapture();
      mainWindow?.webContents.send("capture:auto-status", { state: "done", store });
    } catch (error) {
      mainWindow?.webContents.send("capture:auto-status", { state: "error", message: error.message });
    } finally {
      paginationActive = false;
    }
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => globalShortcut.unregisterAll());
