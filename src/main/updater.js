const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REPOSITORY = "MILImusic/nightfall-gacha-export";
const UPDATE_ASSET = "nightfall-gacha-export-app.asar";
const CHECKSUM_ASSET = `${UPDATE_ASSET}.sha256`;

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

function releaseAssets(release) {
  const assets = new Map((release.assets ?? []).map((asset) => [asset.name, asset.browser_download_url]));
  return { packageUrl: assets.get(UPDATE_ASSET), checksumUrl: assets.get(CHECKSUM_ASSET) };
}

async function githubFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "nightfall-gacha-export",
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
}

async function checkForUpdate(currentVersion, fetchImpl = githubFetch) {
  const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/releases/latest`);
  if (response.status === 404) return { available: false, currentVersion, reason: "no_release" };
  if (!response.ok) throw new Error(`检查更新失败（GitHub ${response.status}）`);
  const release = await response.json();
  const latestVersion = String(release.tag_name ?? "").replace(/^v/i, "");
  const assets = releaseAssets(release);
  const available = isNewerVersion(latestVersion, currentVersion);
  return {
    available,
    currentVersion,
    latestVersion,
    reason: available ? "update_available" : "latest",
    ...assets,
  };
}

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

async function downloadUpdate(update, destinationDirectory, fetchImpl = githubFetch) {
  if (!update.packageUrl || !update.checksumUrl) throw new Error("这个版本缺少直更文件，请稍后重试");
  const [packageResponse, checksumResponse] = await Promise.all([
    fetchImpl(update.packageUrl, { headers: { Accept: "application/octet-stream" } }),
    fetchImpl(update.checksumUrl, { headers: { Accept: "text/plain" } }),
  ]);
  if (!packageResponse.ok || !checksumResponse.ok) throw new Error("下载更新失败，请检查网络后重试");
  const expected = (await checksumResponse.text()).trim().split(/\s+/)[0]?.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("更新校验文件格式错误");
  const bytes = Buffer.from(await packageResponse.arrayBuffer());
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error("更新文件校验失败，当前版本未被修改");
  await fs.mkdir(destinationDirectory, { recursive: true });
  const pendingPath = path.join(destinationDirectory, `${UPDATE_ASSET}.pending`);
  const temporaryPath = `${pendingPath}.tmp`;
  await fs.writeFile(temporaryPath, bytes);
  await fs.rename(temporaryPath, pendingPath);
  return { pendingPath, sha256: actual };
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function scheduleWindowsInstall({ pendingPath, targetPath, executablePath, processId, spawnImpl = spawn }) {
  const scriptPath = path.join(path.dirname(pendingPath), "install-update.ps1");
  const backupPath = `${targetPath}.update-backup`;
  const logPath = path.join(path.dirname(pendingPath), "update-error.log");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$processId = ${Number(processId)}`,
    `$pending = ${psQuote(pendingPath)}`,
    `$target = ${psQuote(targetPath)}`,
    `$backup = ${psQuote(backupPath)}`,
    `$executable = ${psQuote(executablePath)}`,
    `$log = ${psQuote(logPath)}`,
    "try {",
    "  while (Get-Process -Id $processId -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }",
    "  if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination $backup -Force }",
    "  Move-Item -LiteralPath $pending -Destination $target -Force",
    "  Start-Process -FilePath $executable",
    "} catch {",
    "  $_ | Out-File -LiteralPath $log -Encoding UTF8",
    "  if (Test-Path -LiteralPath $backup) { Copy-Item -LiteralPath $backup -Destination $target -Force }",
    "  Start-Process -FilePath $executable",
    "}",
    "Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue",
  ].join("\r\n");
  // Windows PowerShell 5.1 needs a BOM to read Chinese install paths as UTF-8.
  await fs.writeFile(scriptPath, `\ufeff${script}`, "utf8");
  const child = spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  return { scriptPath, backupPath };
}

module.exports = {
  CHECKSUM_ASSET,
  REPOSITORY,
  UPDATE_ASSET,
  checkForUpdate,
  downloadUpdate,
  isNewerVersion,
  releaseAssets,
  scheduleWindowsInstall,
  sha256,
};
