const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { UPDATE_ASSET, checkForUpdate, downloadUpdate, isNewerVersion, scheduleWindowsInstall } = require("../src/main/updater");

test("语义版本只把真正的新版本判为更新", () => {
  assert.equal(isNewerVersion("v0.2.0", "0.1.9"), true);
  assert.equal(isNewerVersion("0.1.0", "0.1.0"), false);
  assert.equal(isNewerVersion("0.0.9", "0.1.0"), false);
});

test("检查更新要求发布包含直更包与校验文件", async () => {
  const response = {
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: "v0.2.0",
      assets: [
        { name: UPDATE_ASSET, browser_download_url: "https://example.test/app" },
        { name: `${UPDATE_ASSET}.sha256`, browser_download_url: "https://example.test/hash" },
      ],
    }),
  };
  const result = await checkForUpdate("0.1.0", async () => response);
  assert.equal(result.available, true);
  assert.equal(result.latestVersion, "0.2.0");
  assert.equal(result.packageUrl, "https://example.test/app");
});

test("下载更新必须通过SHA-256才写入pending文件", async () => {
  const bytes = Buffer.from("verified app.asar");
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nightfall-update-"));
  const fetchImpl = async (url) => url.endsWith("hash")
    ? { ok: true, text: async () => `${digest}  ${UPDATE_ASSET}\n` }
    : { ok: true, arrayBuffer: async () => bytes };
  const result = await downloadUpdate({ packageUrl: "https://x/app", checksumUrl: "https://x/hash" }, directory, fetchImpl);
  assert.deepEqual(await fs.readFile(result.pendingPath), bytes);
  await fs.rm(directory, { recursive: true, force: true });
});

test("校验不一致时拒绝落地更新", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nightfall-update-bad-"));
  const fetchImpl = async (url) => url.endsWith("hash")
    ? { ok: true, text: async () => `${"0".repeat(64)}  ${UPDATE_ASSET}\n` }
    : { ok: true, arrayBuffer: async () => Buffer.from("tampered") };
  await assert.rejects(
    downloadUpdate({ packageUrl: "https://x/app", checksumUrl: "https://x/hash" }, directory, fetchImpl),
    /校验失败/,
  );
  await fs.rm(directory, { recursive: true, force: true });
});

test("Windows更新脚本支持中文路径并以独立进程启动", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "夜幕更新-"));
  const calls = [];
  const child = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const result = await scheduleWindowsInstall({
    pendingPath: path.join(directory, "更新.pending"),
    targetPath: "U:\\工具\\夜幕之下\\app.asar",
    executablePath: "U:\\工具\\夜幕之下\\夜幕.exe",
    processId: 42,
    spawnImpl: (...args) => { calls.push(args); return child; },
  });
  const script = await fs.readFile(result.scriptPath, "utf8");
  assert.equal(script.codePointAt(0), 0xfeff);
  assert.match(script, /while \(Get-Process -Id \$processId/);
  assert.equal(calls[0][0], "powershell.exe");
  assert.equal(calls[0][2].detached, true);
  assert.equal(child.unrefCalled, true);
  await fs.rm(directory, { recursive: true, force: true });
});
