// 若数据目录里有已校验的新版本 payload，这里直接把控制权交给它；本文件
// 其余部分不再执行。必须先于任何 ipcMain 注册与副作用。
if (require("./bootstrap").maybeHandover()) return;

const { app, BrowserWindow, dialog, ipcMain, Menu } = require("electron");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { finalizeUpdate } = require("./bootstrap");
const { ALT_PORT, NightfallProxy, PROXY_PORT, selectProxyAddress } = require("./proxy");
const { loadStore, mergeCapture, toCsv } = require("./store");
const { enrichStore } = require("./catalog");
const { checkForUpdate, downloadUpdate } = require("./updater");
const { collectDiagnostics, collectDiagnosticsData, preflightWarnings } = require("./diagnostics");
const { decideWhatsNew, notesFor } = require("./changelog");

// 启动接管的等待上限：超过它就判定为“授权弹窗没点/被拦截”，给用户明确报错，
// 而不是让按钮永远停在“正在启动”。
const PROXY_START_TIMEOUT_MS = 30000;

// app.getVersion() 在 payload 模式下仍返回外壳 EXE 的版本；运行版本一律
// 以当前加载的 package.json 为准。
const RUNTIME_VERSION = require("../../package.json").version;

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
    icon: resourcePath("icon.png"),
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
    const existing = await loadStore(dataPath());
    const capture = await proxy.fetchAll({ knownStore: existing, onProgress: (progress) => mainWindow?.webContents.send("history:progress", progress) });
    if (!capture.complete) throw new Error(`只读到 ${capture.records.length}/${capture.expectedTotal} 条，未写入本地记录`);
    const store = await mergeCapture(dataPath(), { ...capture, capturedAt: new Date().toISOString() });
    return { store: enrichStore(store), incremental: Boolean(capture.incremental), newCount: capture.newCount ?? capture.records.length };
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
    let stdout;
    try {
      ({ stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { windowsHide: true, timeout: PROXY_START_TIMEOUT_MS },
      ));
    } catch (error) {
      if (error.killed || error.signal === "SIGTERM" || error.code === "ETIMEDOUT") {
        throw new Error(
          "启动连接接管超时（30 秒未完成）。常见原因：管理员授权弹窗被挡在其他窗口后面没有点击，或被杀毒软件 / 系统“内存完整性”拦截。" +
          "请按 Alt+Tab 找到授权弹窗点“是”，或临时关闭拦截后重试；仍不行可点右上角“复制诊断信息”发给作者。",
        );
      }
      throw error;
    }
    redirectorPid = Number.parseInt(stdout.trim(), 10);
    if (!Number.isInteger(redirectorPid)) {
      throw new Error("未取得连接接管进程编号：管理员授权可能被取消了。请重试，并在授权弹窗中点“是”。");
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!redirectorAlive()) throw new Error("连接接管驱动启动失败");
  }
  return { started: true, connected: proxy.connected() };
});

async function runDiagnosticsPowerShell(script) {
  // 中文 Windows 的控制台默认 GBK，中文网卡名（如"以太网"）会在 stdout 乱码，强制 UTF-8 输出。
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${script}`],
    { windowsHide: true, timeout: 8000 },
  );
  return stdout;
}

function diagnosticsInputs() {
  return {
    version: RUNTIME_VERSION,
    osVersion: os.version(),
    osRelease: os.release(),
    interfaces: os.networkInterfaces(),
    selectAddress: selectProxyAddress,
    redirectorAlive: redirectorAlive(),
    proxyConnected: proxy.connected(),
    runPowerShell: process.platform === "win32" ? runDiagnosticsPowerShell : null,
    collectedAt: new Date().toISOString(),
  };
}

ipcMain.handle("diagnostics:collect", async () => collectDiagnostics(diagnosticsInputs()));

ipcMain.handle("preflight:check", async () => {
  const data = await collectDiagnosticsData(diagnosticsInputs());
  return { warnings: preflightWarnings(data) };
});

// 一键修复网络残留：只做无需提权、不会误伤用户主动配置的两件事。
// DNS 被改的情况只提示不代改（见 preflightWarnings）——没有"原样"快照，重置会误伤手动配 DNS 的用户。
ipcMain.handle("netfix:apply", async () => {
  if (process.platform !== "win32") throw new Error("修复网络残留仅支持 Windows");
  const done = [];
  const failed = [];
  try {
    await runDiagnosticsPowerShell(
      "Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name ProxyEnable -Value 0",
    );
    done.push("已关闭系统代理");
  } catch {
    failed.push("关闭系统代理失败");
  }
  try {
    await execFileAsync("ipconfig", ["/flushdns"], { windowsHide: true, timeout: 8000 });
    done.push("已清空 DNS 缓存");
  } catch {
    failed.push("清空 DNS 缓存失败");
  }
  return { done, failed };
});

function disclaimerPath() {
  return path.join(app.getPath("userData"), "disclaimer.json");
}

ipcMain.handle("disclaimer:get", async () => {
  try {
    const raw = await fs.readFile(disclaimerPath(), "utf8");
    return Boolean(JSON.parse(raw)?.accepted);
  } catch {
    return false;
  }
});

ipcMain.handle("disclaimer:accept", async () => {
  await fs.writeFile(
    disclaimerPath(),
    `${JSON.stringify({ accepted: true, acceptedAt: new Date().toISOString(), version: RUNTIME_VERSION })}\n`,
    "utf8",
  );
  return true;
});

function whatsnewPath() {
  return path.join(app.getPath("userData"), "whatsnew.json");
}

async function readJsonQuiet(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function recordWhatsnewVersion() {
  await fs.writeFile(
    whatsnewPath(),
    `${JSON.stringify({ version: RUNTIME_VERSION, seenAt: new Date().toISOString() })}\n`,
    "utf8",
  );
}

ipcMain.handle("whatsnew:get", async () => {
  const prevVersion = (await readJsonQuiet(whatsnewPath()))?.version ?? null;
  const disclaimerAccepted = Boolean((await readJsonQuiet(disclaimerPath()))?.accepted);
  const decision = decideWhatsNew({ prevVersion, disclaimerAccepted, currentVersion: RUNTIME_VERSION });
  if (decision === "record") await recordWhatsnewVersion();
  if (decision !== "show") return { show: false };
  return { show: true, version: RUNTIME_VERSION, notes: notesFor(RUNTIME_VERSION) };
});

ipcMain.handle("whatsnew:ack", async () => {
  await recordWhatsnewVersion();
  return true;
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

ipcMain.handle("update:check", () => checkForUpdate(RUNTIME_VERSION));

ipcMain.handle("update:install", async () => {
  if (!app.isPackaged || process.platform !== "win32") throw new Error("直更只在已安装的 Windows 版本中可用");
  const update = await checkForUpdate(RUNTIME_VERSION);
  if (!update.available) return update;
  const downloaded = await downloadUpdate(update, path.join(app.getPath("userData"), "updates"));
  finalizeUpdate({
    userData: app.getPath("userData"),
    pendingPath: downloaded.pendingPath,
    version: update.latestVersion,
    sha256: downloaded.sha256,
  });
  // 不再依赖任何外部进程：应用自己重启，下次启动由 bootstrap 加载新版本。
  setTimeout(() => {
    app.relaunch();
    app.quit();
  }, 250);
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
