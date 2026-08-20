const { app, BrowserWindow, dialog, ipcMain, Menu } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { ALT_PORT, NightfallProxy, PROXY_PORT, selectProxyAddress } = require("./proxy");
const { loadStore, mergeCapture, toCsv } = require("./store");
const { enrichStore } = require("./catalog");
const { checkForUpdate, downloadUpdate, scheduleWindowsInstall } = require("./updater");

let fetching = false;
let mainWindow;
let redirectorPid = null;
const proxy = new NightfallProxy();
const execFileAsync = promisify(execFile);

function resourcePath(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(app.getAppPath(), "resources", name);
}

function dataPath() {
  return path.join(app.getPath("userData"), "records.json");
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function redirectorAlive() {
  if (!redirectorPid) return false;
  try {
    process.kill(redirectorPid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    redirectorPid = null;
    return false;
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 840,
    minHeight: 600,
    backgroundColor: "#111318",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  window.loadFile(path.join(__dirname, "../renderer/index.html"));
  mainWindow = window;
}

ipcMain.handle("history:fetch", async () => {
  if (process.platform !== "win32") throw new Error("数据捕获仅支持 Windows");
  if (fetching) throw new Error("正在获取记录，请稍候");
  fetching = true;
  try {
    const capture = await proxy.fetchAll({ onProgress: (progress) => mainWindow?.webContents.send("history:progress", progress) });
    if (!capture.complete) throw new Error(`只读到 ${capture.records.length}/${capture.expectedTotal} 条，未写入本地记录`);
    const store = await mergeCapture(dataPath(), { ...capture, capturedAt: new Date().toISOString() });
    return { store: enrichStore(store) };
  } finally {
    fetching = false;
  }
});

ipcMain.handle("proxy:status", () => ({ started: redirectorAlive(), connected: proxy.connected() }));

ipcMain.handle("proxy:start", async () => {
  if (process.platform !== "win32") throw new Error("连接接管仅支持 Windows");
  await proxy.listen();
  if (!redirectorAlive()) {
    const executable = resourcePath("windivert/nightfall-redirect.exe");
    const argumentList = `12090 ${PROXY_PORT} ${ALT_PORT} ${selectProxyAddress()} ${process.pid}`;
    const command = `$p=Start-Process -FilePath ${quotePowerShell(executable)} ` +
      `-ArgumentList ${quotePowerShell(argumentList)} -Verb RunAs -WindowStyle Hidden -PassThru; $p.Id`;
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true });
    redirectorPid = Number.parseInt(stdout.trim(), 10);
    if (!Number.isInteger(redirectorPid)) throw new Error("未取得连接接管进程编号");
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!redirectorAlive()) throw new Error("连接接管驱动启动失败");
  }
  return { started: true, connected: proxy.connected() };
});

ipcMain.handle("data:get", async () => enrichStore(await loadStore(dataPath())));

ipcMain.handle("data:export-json", async () => {
  const store = enrichStore(await loadStore(dataPath()));
  const result = await dialog.showSaveDialog({ defaultPath: "nightfall-gacha-records.json", filters: [{ name: "JSON", extensions: ["json"] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  return { canceled: false };
});

ipcMain.handle("data:export-csv", async () => {
  const store = enrichStore(await loadStore(dataPath()));
  const result = await dialog.showSaveDialog({ defaultPath: "nightfall-gacha-records.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, `\ufeff${toCsv(store)}`, "utf8");
  return { canceled: false };
});

ipcMain.handle("update:check", () => checkForUpdate(app.getVersion()));

ipcMain.handle("update:install", async () => {
  if (!app.isPackaged || process.platform !== "win32") throw new Error("直更只在已安装的 Windows 版本中可用");
  const update = await checkForUpdate(app.getVersion());
  if (!update.available) return update;
  const downloaded = await downloadUpdate(update, path.join(app.getPath("userData"), "updates"));
  await scheduleWindowsInstall({
    pendingPath: downloaded.pendingPath,
    targetPath: path.join(process.resourcesPath, "app.asar"),
    executablePath: process.execPath,
    processId: process.pid,
  });
  setTimeout(() => app.quit(), 250);
  return { ...update, installing: true };
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => { void proxy.close(); });
