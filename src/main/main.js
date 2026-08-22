// 若数据目录里有已校验的新版本 payload，这里直接把控制权交给它；本文件
// 其余部分不再执行。必须先于任何 ipcMain 注册与副作用。
if (require("./bootstrap").maybeHandover()) return;

const { app, BrowserWindow, dialog, ipcMain, Menu } = require("electron");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { clearHandoverFlag, finalizeUpdate } = require("./bootstrap");
const { ALT_PORT, NightfallProxy, PROXY_PORT, selectProxyAddress } = require("./proxy");
const { loadStore, mergeCapture, toCsv } = require("./store");
const { identifyProfile } = require("./profiles");
const profileStore = require("./profilestore");
const { enrichStore } = require("./catalog");
const { checkForUpdate, downloadUpdate } = require("./updater");
const { collectDiagnostics, collectDiagnosticsData, preflightWarnings } = require("./diagnostics");
const { decideWhatsNew, notesFor } = require("./changelog");
const { DEFAULT_GAME_PORT, detectGamePort, portMismatch, resolveGamePort } = require("./gameport");

// 启动接管的等待上限：超过它就判定为“授权弹窗没点/被拦截”，给用户明确报错，
// 而不是让按钮永远停在“正在启动”。
const PROXY_START_TIMEOUT_MS = 30000;

// app.getVersion() 在 payload 模式下仍返回外壳 EXE 的版本；运行版本一律
// 以当前加载的 package.json 为准。
const RUNTIME_VERSION = require("../../package.json").version;

let fetching = false;
let mainWindow;
let redirectorPid = null;
let activeGamePort = DEFAULT_GAME_PORT;
const proxy = new NightfallProxy();
const execFileAsync = promisify(execFile);

function resourcePath(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(app.getAppPath(), "resources", name);
}

// 记录按账号档案分文件存；老用户的 records.json 首次启动时会被收编为"账号1"。
async function dataPath() {
  const userData = app.getPath("userData");
  const id = await profileStore.activeProfileId(userData);
  return profileStore.profileDataPath(userData, id);
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

// 窗口底色必须跟当前主题一致：内容不满一屏、或页面尚未绘制完时露出的就是它。
// 主题存在渲染进程的 localStorage 里主进程读不到，所以另存一份到 userData。
const THEME_BG = { light: "#fbfbfa", dark: "#0e0e0f" };
function themePath() {
  return path.join(app.getPath("userData"), "theme.json");
}
function readThemeSync() {
  try {
    const raw = require("node:fs").readFileSync(themePath(), "utf8");
    const value = JSON.parse(raw)?.theme;
    return value === "dark" || value === "light" ? value : "light";
  } catch {
    return "light";
  }
}

ipcMain.handle("theme:save", async (_event, theme) => {
  if (theme !== "dark" && theme !== "light") return false;
  await fs.writeFile(themePath(), `${JSON.stringify({ theme })}\n`, "utf8");
  return true;
});

function createWindow() {
  const window = new BrowserWindow({
    // 顶栏控件随版本增加（账号切换、诊断、修复、导出…），1040 宽已经挤到换行；
    // 高度留到 760 但不超过 1366x768 笔记本的可用高度。
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: THEME_BG[readThemeSync()],
    show: false,
    icon: resourcePath("icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  // 等首帧准备好再显示，避免用户看到未绘制的空窗口
  window.once("ready-to-show", () => window.show());
  window.loadFile(path.join(__dirname, "../renderer/index.html"));
  mainWindow = window;
}

ipcMain.handle("history:fetch", async (_event, options = {}) => {
  if (process.platform !== "win32") throw new Error("数据捕获仅支持 Windows");
  if (fetching) throw new Error("正在获取记录，请稍候");
  fetching = true;
  try {
    const userData = app.getPath("userData");
    const { activeId, profiles } = await profileStore.listProfiles(userData);
    const target = await dataPath();
    const existing = await loadStore(target);
    const capture = await proxy.fetchAll({ knownStore: existing, onProgress: (progress) => mainWindow?.webContents.send("history:progress", progress) });
    if (!capture.complete) throw new Error(`只读到 ${capture.records.length}/${capture.expectedTotal} 条，未写入本地记录`);

    // 合并之前先认人：协议里没有账号标识，靠最早几抽的指纹判断这份记录属于谁。
    // 判错就把小号并进大号，而且增量校验会在之后报错、脏了难修——所以宁可停下来问。
    const merged = capture.incremental ? [...existing.records, ...capture.records] : capture.records;
    // 把每个档案已存的记录一并交给判定——主判据是记录重叠度，对"历史记录过期"免疫
    const storedRecords = {};
    for (const item of profiles) {
      storedRecords[item.id] = item.id === activeId
        ? existing.records
        : (await loadStore(profileStore.profileDataPath(userData, item.id))).records;
    }
    const identity = identifyProfile({ records: merged, profiles, activeId, storedRecords });
    if (identity.verdict !== "same" && identity.verdict !== "adopt" && !options.force) {
      const other = profiles.find((item) => item.id === identity.profileId);
      return {
        conflict: {
          verdict: identity.verdict,
          otherProfileId: identity.profileId,
          otherProfileName: other?.name ?? null,
          activeProfileName: profiles.find((item) => item.id === activeId)?.name ?? null,
        },
      };
    }

    const store = await mergeCapture(target, { ...capture, capturedAt: new Date().toISOString() });
    await profileStore.syncProfileStats(userData, activeId, store);
    return { store: enrichStore(store), incremental: Boolean(capture.incremental), newCount: capture.newCount ?? capture.records.length };
  } finally {
    fetching = false;
  }
});

ipcMain.handle("profiles:list", async () => profileStore.listProfiles(app.getPath("userData")));
ipcMain.handle("profiles:create", async (_event, name) => profileStore.createProfile(app.getPath("userData"), { name }));
ipcMain.handle("profiles:switch", async (_event, id) => profileStore.switchProfile(app.getPath("userData"), id));
ipcMain.handle("profiles:rename", async (_event, id, name) => profileStore.renameProfile(app.getPath("userData"), id, name));
ipcMain.handle("profiles:delete", async (_event, id) => profileStore.deleteProfile(app.getPath("userData"), id));

ipcMain.handle("proxy:status", () => ({ started: redirectorAlive(), connected: proxy.connected(), gamePort: activeGamePort }));

// 工具自身是否以管理员身份运行。已提权时不需要再走 Start-Process -Verb RunAs——
// 那条提权调用会弹 UAC，而用户改过 UAC 策略时它可能永远不返回（按钮永远停在"正在启动"）。
let elevatedCache = null;
async function isElevated() {
  if (elevatedCache !== null) return elevatedCache;
  if (process.platform !== "win32") return (elevatedCache = false);
  try {
    const out = await runDiagnosticsPowerShell(
      "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())" +
        ".IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    );
    elevatedCache = out.trim().toLowerCase() === "true";
  } catch {
    elevatedCache = false;
  }
  return elevatedCache;
}

// 记住上次成功接管的游戏端口：游戏还没启动时探测不到，靠它避免退回可能错误的默认值。
function gamePortPath() {
  return path.join(app.getPath("userData"), "gameport.json");
}

async function rememberedGamePort() {
  const value = (await readJsonQuiet(gamePortPath()))?.port;
  return Number.isInteger(value) ? value : null;
}

async function rememberGamePort(port) {
  if (!Number.isInteger(port)) return;
  await fs.writeFile(
    gamePortPath(),
    `${JSON.stringify({ port, seenAt: new Date().toISOString() })}\n`,
    "utf8",
  );
}

// 探测游戏此刻实际连着的端口；游戏没开或查询失败都返回 null（不抛，接管照常走默认值）。
async function detectRunningGamePort() {
  if (process.platform !== "win32") return null;
  try {
    const data = await collectDiagnosticsData(diagnosticsInputs());
    return detectGamePort(data.gameConnections);
  } catch {
    return null;
  }
}

ipcMain.handle("proxy:start", async () => {
  if (process.platform !== "win32") throw new Error("连接接管仅支持 Windows");
  await proxy.listen();
  if (!redirectorAlive()) {
    const executable = resourcePath("windivert/nightfall-redirect.exe");
    const { port: gamePort, source: portSource } = resolveGamePort({
      detected: await detectRunningGamePort(),
      remembered: await rememberedGamePort(),
    });
    activeGamePort = gamePort;
    if (portSource === "detected") await rememberGamePort(gamePort);
    const argumentList = `${gamePort} ${PROXY_PORT} ${ALT_PORT} ${selectProxyAddress()} ${process.pid}`;
    // 已经是管理员就直接起进程：绕开 UAC 弹窗这一整个环节，也就不存在"卡在正在启动"。
    if (await isElevated()) {
      const child = spawn(executable, argumentList.split(" "), {
        windowsHide: true,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      if (!Number.isInteger(child.pid)) throw new Error("连接接管程序启动失败，请重试。");
      redirectorPid = child.pid;
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (!redirectorAlive()) throw new Error("连接接管驱动启动失败：可能被杀毒软件拦截，请临时关闭后重试。");
      return { started: true, connected: proxy.connected(), gamePort: activeGamePort, elevated: true };
    }
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
  return { started: true, connected: proxy.connected(), gamePort: activeGamePort };
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
    activeGamePort,
  };
}

ipcMain.handle("diagnostics:collect", async () =>
  collectDiagnostics({ ...diagnosticsInputs(), elevated: await isElevated() }));

ipcMain.handle("preflight:check", async () => {
  const elevated = await isElevated();
  const data = await collectDiagnosticsData({ ...diagnosticsInputs(), elevated });
  return { warnings: preflightWarnings(data), elevated };
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

ipcMain.handle("data:get", async () => enrichStore(await loadStore(await dataPath())));

ipcMain.handle("data:export-json", async () => {
  const store = enrichStore(await loadStore(await dataPath()));
  const result = await dialog.showSaveDialog({ defaultPath: "nightfall-gacha-records.json", filters: [{ name: "JSON", extensions: ["json"] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  return { canceled: false };
});

ipcMain.handle("data:export-csv", async () => {
  const store = enrichStore(await loadStore(await dataPath()));
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
  // 必须先清掉交接标记，否则 relaunch 出来的新进程继承它、跳过 handover 跑回内置旧版本。
  setTimeout(() => {
    clearHandoverFlag();
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
