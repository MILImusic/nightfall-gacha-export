const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PAYLOAD_ENV_FLAG = "NIGHTFALL_PAYLOAD_ACTIVE";
const POINTER_FILE = "current.json";
const PAYLOAD_NAME_PATTERN = /^app-[0-9A-Za-z.-]+\.asar$/;

function versionParts(version) {
  return String(version).replace(/^v/i, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function isNewerVersion(candidate, current) {
  const next = versionParts(candidate);
  const installed = versionParts(current);
  for (let index = 0; index < Math.max(next.length, installed.length); index += 1) {
    if ((next[index] ?? 0) !== (installed[index] ?? 0)) return (next[index] ?? 0) > (installed[index] ?? 0);
  }
  return false;
}

// Electron patches fs so "*.asar" paths resolve into the archive; raw file
// operations on the archive itself need the patch suspended.
function withRealFs(operation) {
  const previous = process.noAsar;
  process.noAsar = true;
  try {
    return operation();
  } finally {
    process.noAsar = previous;
  }
}

function payloadRoot(userData) {
  return path.join(userData, "app-versions");
}

function pointerPath(userData) {
  return path.join(payloadRoot(userData), POINTER_FILE);
}

function updatesDirectory(userData) {
  return path.join(userData, "updates");
}

function logUpdateEvent(userData, message) {
  try {
    const line = `${new Date().toISOString()} ${message}\n`;
    fs.mkdirSync(updatesDirectory(userData), { recursive: true });
    fs.appendFileSync(path.join(updatesDirectory(userData), "update-flow.log"), line, "utf8");
  } catch {
    // 日志失败不能影响启动或更新流程
  }
}

function sha256File(filePath) {
  const bytes = withRealFs(() => fs.readFileSync(filePath));
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function readPointer(userData) {
  try {
    const raw = withRealFs(() => fs.readFileSync(pointerPath(userData), "utf8"));
    const pointer = JSON.parse(raw);
    if (!pointer || typeof pointer !== "object") return null;
    return pointer;
  } catch {
    return null;
  }
}

function quarantinePointer(userData, reason) {
  const source = pointerPath(userData);
  const target = path.join(payloadRoot(userData), `current.${reason}-${Date.now()}.json`);
  try {
    withRealFs(() => fs.renameSync(source, target));
  } catch {
    try {
      withRealFs(() => fs.unlinkSync(source));
    } catch {
      // 指针无法移除时启动仍继续走内置版本
    }
  }
  logUpdateEvent(userData, `pointer quarantined: ${reason}`);
}

function cleanupPayloads(userData, keepName) {
  let entries = [];
  try {
    entries = withRealFs(() => fs.readdirSync(payloadRoot(userData)));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!PAYLOAD_NAME_PATTERN.test(entry) || entry === keepName) continue;
    try {
      withRealFs(() => fs.unlinkSync(path.join(payloadRoot(userData), entry)));
    } catch {
      // 正在被占用的旧版本留给下次启动清理
    }
  }
}

// 0.1.0/0.1.1 的 PowerShell 直更方案已废止；清掉它留下的脚本和未安装的包。
function cleanupLegacyArtifacts(userData) {
  let entries = [];
  try {
    entries = fs.readdirSync(updatesDirectory(userData));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry !== "install-update.ps1" && !entry.endsWith(".pending") && !entry.endsWith(".pending.tmp")) continue;
    try {
      withRealFs(() => fs.unlinkSync(path.join(updatesDirectory(userData), entry)));
      logUpdateEvent(userData, `legacy artifact removed: ${entry}`);
    } catch {
      // 留着不影响新机制
    }
  }
}

function resolvePayload({ userData, embeddedVersion }) {
  const pointer = readPointer(userData);
  if (!pointer) return { ok: false, reason: "no_pointer" };
  const { version, file, sha256 } = pointer;
  if (typeof version !== "string" || typeof file !== "string" || typeof sha256 !== "string") {
    quarantinePointer(userData, "malformed");
    return { ok: false, reason: "malformed" };
  }
  if (!PAYLOAD_NAME_PATTERN.test(file) || file.includes("/") || file.includes("\\")) {
    quarantinePointer(userData, "badname");
    return { ok: false, reason: "badname" };
  }
  if (!isNewerVersion(version, embeddedVersion)) {
    // 内置版本已经追平（例如整包升级之后），旧 payload 全部作废。
    quarantinePointer(userData, "stale");
    cleanupPayloads(userData, null);
    return { ok: false, reason: "stale" };
  }
  const payloadFile = path.join(payloadRoot(userData), file);
  const exists = withRealFs(() => fs.existsSync(payloadFile));
  if (!exists) {
    quarantinePointer(userData, "missing");
    return { ok: false, reason: "missing" };
  }
  let actual;
  try {
    actual = sha256File(payloadFile);
  } catch {
    quarantinePointer(userData, "unreadable");
    return { ok: false, reason: "unreadable" };
  }
  if (actual !== sha256.toLowerCase()) {
    quarantinePointer(userData, "checksum");
    return { ok: false, reason: "checksum" };
  }
  return {
    ok: true,
    version,
    payloadFile,
    mainPath: path.join(payloadFile, "src", "main", "main.js"),
  };
}

function finalizeUpdate({ userData, pendingPath, version, sha256 }) {
  if (!/^[0-9A-Za-z.-]+$/.test(String(version))) throw new Error("更新版本号不合法");
  const destinationName = `app-${version}.asar`;
  const destination = path.join(payloadRoot(userData), destinationName);
  fs.mkdirSync(payloadRoot(userData), { recursive: true });
  withRealFs(() => fs.renameSync(pendingPath, destination));
  const actual = sha256File(destination);
  if (actual !== String(sha256).toLowerCase()) {
    withRealFs(() => fs.unlinkSync(destination));
    throw new Error("更新文件落盘校验失败，本次更新已取消");
  }
  const pointer = { version, file: destinationName, sha256: actual, installedAt: new Date().toISOString() };
  const temporary = `${pointerPath(userData)}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, pointerPath(userData));
  cleanupPayloads(userData, destinationName);
  logUpdateEvent(userData, `update finalized: v${version} -> ${destinationName}`);
  return { pointerFile: pointerPath(userData), payloadFile: destination };
}

// 在内置 main 最顶部调用。返回 true 表示已把控制权交给新版本（或崩溃后已
// 安排重启），内置 main 不应再继续执行。
function maybeHandover() {
  if (process.env[PAYLOAD_ENV_FLAG]) return false;
  // eslint-disable-next-line global-require
  const { app } = require("electron");
  if (!app.isPackaged) return false;
  const userData = app.getPath("userData");
  const embeddedVersion = require("../../package.json").version;
  cleanupLegacyArtifacts(userData);
  const resolved = resolvePayload({ userData, embeddedVersion });
  if (!resolved.ok) return false;
  process.env[PAYLOAD_ENV_FLAG] = resolved.version;
  logUpdateEvent(userData, `boot: handover ${embeddedVersion} -> ${resolved.version}`);
  try {
    require(resolved.mainPath);
    return true;
  } catch (error) {
    delete process.env[PAYLOAD_ENV_FLAG];
    quarantinePointer(userData, "crashed");
    logUpdateEvent(userData, `payload crashed at boot: ${error?.message ?? error}`);
    app.relaunch();
    app.exit(1);
    return true;
  }
}

module.exports = {
  PAYLOAD_ENV_FLAG,
  cleanupLegacyArtifacts,
  cleanupPayloads,
  finalizeUpdate,
  isNewerVersion,
  logUpdateEvent,
  maybeHandover,
  payloadRoot,
  pointerPath,
  resolvePayload,
};
