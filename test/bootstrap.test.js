const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  cleanupLegacyArtifacts,
  finalizeUpdate,
  isNewerVersion,
  payloadRoot,
  pointerPath,
  resolvePayload,
} = require("../src/main/bootstrap");

function makeUserData(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function plantPayload(userData, version, bytes) {
  const name = `app-${version}.asar`;
  fs.mkdirSync(payloadRoot(userData), { recursive: true });
  fs.writeFileSync(path.join(payloadRoot(userData), name), bytes);
  fs.writeFileSync(pointerPath(userData), JSON.stringify({ version, file: name, sha256: sha256(bytes) }));
  return name;
}

test("finalizeUpdate把pending落成版本文件并写指针", () => {
  const userData = makeUserData("nightfall-boot-");
  const bytes = Buffer.from("payload v0.2.0");
  const pending = path.join(userData, "updates", "app.asar.pending");
  fs.mkdirSync(path.dirname(pending), { recursive: true });
  fs.writeFileSync(pending, bytes);
  const result = finalizeUpdate({ userData, pendingPath: pending, version: "0.2.0", sha256: sha256(bytes) });
  assert.equal(fs.existsSync(pending), false);
  assert.deepEqual(fs.readFileSync(result.payloadFile), bytes);
  const pointer = JSON.parse(fs.readFileSync(result.pointerFile, "utf8"));
  assert.equal(pointer.version, "0.2.0");
  assert.equal(pointer.file, "app-0.2.0.asar");
  assert.equal(fs.existsSync(`${result.pointerFile}.tmp`), false);
  fs.rmSync(userData, { recursive: true, force: true });
});

test("finalizeUpdate落盘校验不一致时删除产物并报错", () => {
  const userData = makeUserData("nightfall-boot-bad-");
  const pending = path.join(userData, "updates", "app.asar.pending");
  fs.mkdirSync(path.dirname(pending), { recursive: true });
  fs.writeFileSync(pending, Buffer.from("tampered"));
  assert.throws(
    () => finalizeUpdate({ userData, pendingPath: pending, version: "0.2.0", sha256: "0".repeat(64) }),
    /落盘校验失败/,
  );
  assert.equal(fs.existsSync(path.join(payloadRoot(userData), "app-0.2.0.asar")), false);
  assert.equal(fs.existsSync(pointerPath(userData)), false);
  fs.rmSync(userData, { recursive: true, force: true });
});

test("finalizeUpdate清理旧版本payload", () => {
  const userData = makeUserData("nightfall-boot-clean-");
  plantPayload(userData, "0.2.0", Buffer.from("old payload"));
  const bytes = Buffer.from("payload v0.3.0");
  const pending = path.join(userData, "updates", "app.asar.pending");
  fs.mkdirSync(path.dirname(pending), { recursive: true });
  fs.writeFileSync(pending, bytes);
  finalizeUpdate({ userData, pendingPath: pending, version: "0.3.0", sha256: sha256(bytes) });
  assert.equal(fs.existsSync(path.join(payloadRoot(userData), "app-0.2.0.asar")), false);
  assert.equal(fs.existsSync(path.join(payloadRoot(userData), "app-0.3.0.asar")), true);
  fs.rmSync(userData, { recursive: true, force: true });
});

test("resolvePayload只接受比内置更新的完整payload", () => {
  const userData = makeUserData("nightfall-resolve-");
  const bytes = Buffer.from("payload v0.2.0");
  plantPayload(userData, "0.2.0", bytes);
  const resolved = resolvePayload({ userData, embeddedVersion: "0.1.2" });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.version, "0.2.0");
  assert.equal(resolved.mainPath, path.join(payloadRoot(userData), "app-0.2.0.asar", "src", "main", "main.js"));
  fs.rmSync(userData, { recursive: true, force: true });
});

test("内置版本追平后旧payload作废并被清掉", () => {
  const userData = makeUserData("nightfall-stale-");
  plantPayload(userData, "0.2.0", Buffer.from("payload v0.2.0"));
  const resolved = resolvePayload({ userData, embeddedVersion: "0.2.0" });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "stale");
  assert.equal(fs.existsSync(pointerPath(userData)), false);
  assert.equal(fs.existsSync(path.join(payloadRoot(userData), "app-0.2.0.asar")), false);
  fs.rmSync(userData, { recursive: true, force: true });
});

test("指针哈希不符时隔离指针拒绝加载", () => {
  const userData = makeUserData("nightfall-sum-");
  const name = plantPayload(userData, "0.2.0", Buffer.from("payload v0.2.0"));
  fs.writeFileSync(pointerPath(userData), JSON.stringify({ version: "0.2.0", file: name, sha256: "f".repeat(64) }));
  const resolved = resolvePayload({ userData, embeddedVersion: "0.1.2" });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "checksum");
  assert.equal(fs.existsSync(pointerPath(userData)), false);
  const quarantined = fs.readdirSync(payloadRoot(userData)).filter((entry) => entry.startsWith("current.checksum-"));
  assert.equal(quarantined.length, 1);
  fs.rmSync(userData, { recursive: true, force: true });
});

test("指针文件名越界或缺文件都被拒绝", () => {
  const userData = makeUserData("nightfall-name-");
  fs.mkdirSync(payloadRoot(userData), { recursive: true });
  fs.writeFileSync(pointerPath(userData), JSON.stringify({ version: "9.9.9", file: "..\\evil.asar", sha256: "0".repeat(64) }));
  assert.equal(resolvePayload({ userData, embeddedVersion: "0.1.2" }).reason, "badname");
  fs.writeFileSync(pointerPath(userData), JSON.stringify({ version: "9.9.9", file: "app-9.9.9.asar", sha256: "0".repeat(64) }));
  assert.equal(resolvePayload({ userData, embeddedVersion: "0.1.2" }).reason, "missing");
  fs.rmSync(userData, { recursive: true, force: true });
});

test("清理0.1.x遗留的更新脚本与pending包", () => {
  const userData = makeUserData("nightfall-legacy-");
  const updates = path.join(userData, "updates");
  fs.mkdirSync(updates, { recursive: true });
  fs.writeFileSync(path.join(updates, "install-update.ps1"), "legacy");
  fs.writeFileSync(path.join(updates, "nightfall-gacha-export-app.asar.pending"), "legacy");
  fs.writeFileSync(path.join(updates, "keep.txt"), "keep");
  cleanupLegacyArtifacts(userData);
  assert.equal(fs.existsSync(path.join(updates, "install-update.ps1")), false);
  assert.equal(fs.existsSync(path.join(updates, "nightfall-gacha-export-app.asar.pending")), false);
  assert.equal(fs.existsSync(path.join(updates, "keep.txt")), true);
  fs.rmSync(userData, { recursive: true, force: true });
});

test("bootstrap与updater的版本比较语义一致", () => {
  assert.equal(isNewerVersion("0.1.2", "0.1.1"), true);
  assert.equal(isNewerVersion("0.1.2", "0.1.2"), false);
  assert.equal(isNewerVersion("v0.2.0", "0.10.0"), false);
});

test("clearHandoverFlag 清掉交接标记——relaunch 前必须调用，否则新进程跑回内置旧版", () => {
  const { PAYLOAD_ENV_FLAG, clearHandoverFlag } = require("../src/main/bootstrap");
  const previous = process.env[PAYLOAD_ENV_FLAG];
  try {
    process.env[PAYLOAD_ENV_FLAG] = "0.1.5";
    clearHandoverFlag();
    assert.equal(PAYLOAD_ENV_FLAG in process.env, false);
    // 幂等：没有标记时再调用也不抛
    clearHandoverFlag();
    assert.equal(PAYLOAD_ENV_FLAG in process.env, false);
  } finally {
    if (previous === undefined) delete process.env[PAYLOAD_ENV_FLAG];
    else process.env[PAYLOAD_ENV_FLAG] = previous;
  }
});

test("更新路径与崩溃路径都在 relaunch 之前清标记（防回归）", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  // 只看真正的代码行：注释里也会提到 app.relaunch()，按行扫描并跳过注释，避免测试匹配到说明文字。
  const codeLines = (file) => fs.readFileSync(path.join(__dirname, file), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("//") && !line.startsWith("*"));
  for (const file of ["../src/main/main.js", "../src/main/bootstrap.js"]) {
    const lines = codeLines(file);
    const clearIndex = lines.findIndex((line) => /^clearHandoverFlag\(\);/.test(line));
    const relaunchIndex = lines.findIndex((line) => /^app\.relaunch\(\);/.test(line));
    assert.ok(clearIndex >= 0, `${file} 应调用 clearHandoverFlag()`);
    assert.ok(relaunchIndex >= 0, `${file} 应调用 app.relaunch()`);
    assert.ok(clearIndex < relaunchIndex, `${file} 必须先清标记再 relaunch`);
  }
});
