const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { UPDATE_ASSET, checkForUpdate, downloadUpdate, isNewerVersion } = require("../src/main/updater");

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

