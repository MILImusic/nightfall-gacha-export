const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { saveStore, loadStore } = require("../src/main/store");
const ps = require("../src/main/profilestore");

async function tempUserData() {
  return fs.mkdtemp(path.join(os.tmpdir(), "nightfall-profiles-"));
}

test("首次启用把老的 records.json 收编为账号1，且不删除原文件", async () => {
  const dir = await tempUserData();
  const legacy = { version: 2, lastCapturedAt: "2026-08-01T00:00:00.000Z", captures: [], records: [
    { poolId: 1, resultId: 10, timestampMs: 100, historyPosition: 2, key: "1:10:100:1" },
    { poolId: 1, resultId: 11, timestampMs: 200, historyPosition: 1, key: "1:11:200:1" },
  ] };
  await saveStore(ps.legacyDataPath(dir), legacy);

  const { activeId, profiles } = await ps.listProfiles(dir);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, "账号1");
  assert.equal(profiles[0].recordCount, 2);
  assert.deepEqual(profiles[0].fingerprint, ["1:10:100", "1:11:200"]);
  // 记录已复制进档案文件
  const moved = await loadStore(ps.profileDataPath(dir, activeId));
  assert.equal(moved.records.length, 2);
  // 老文件保留作为回退
  assert.equal((await loadStore(ps.legacyDataPath(dir))).records.length, 2);
});

test("全新用户没有老文件时建一个空档案", async () => {
  const dir = await tempUserData();
  const { profiles } = await ps.listProfiles(dir);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].recordCount, 0);
  assert.equal(profiles[0].fingerprint, null);
});

test("新建/切换/重命名档案", async () => {
  const dir = await tempUserData();
  await ps.listProfiles(dir);
  let state = await ps.createProfile(dir, { name: "小号" });
  assert.equal(state.profiles.length, 2);
  assert.equal(state.activeId, state.profiles[1].id, "新建后自动切过去");
  state = await ps.renameProfile(dir, state.activeId, "  二号机  ");
  assert.equal(state.profiles[1].name, "二号机", "名字两端空白会被去掉");
  state = await ps.switchProfile(dir, state.profiles[0].id);
  assert.equal(state.activeId, state.profiles[0].id);
  await assert.rejects(() => ps.switchProfile(dir, "nope"), /找不到/);
  await assert.rejects(() => ps.renameProfile(dir, state.activeId, "   "), /不能为空/);
});

test("删除档案：至少留一个，删当前会自动切走，文件改名保留可恢复", async () => {
  const dir = await tempUserData();
  await ps.listProfiles(dir);
  let state = await ps.createProfile(dir, { name: "小号" });
  const removedId = state.activeId;
  state = await ps.deleteProfile(dir, removedId, "2026-08-22T03:04:05.000Z");
  assert.equal(state.profiles.length, 1);
  assert.notEqual(state.activeId, removedId, "删掉当前档案后自动切到剩下的");
  const leftovers = await fs.readdir(ps.profilesDirectory(dir));
  assert.ok(leftovers.some((f) => f.startsWith(`${removedId}.json.deleted-`)), "记录文件改名保留而不是真删");
  // 只剩最后一个时不再报错，改为清空并重置
  const cleared = await ps.deleteProfile(dir, state.activeId, "2026-08-22T04:05:06.000Z");
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.profiles.length, 1, "档案还在，列表不会变空");
  assert.equal(cleared.profiles[0].recordCount, 0);
  assert.equal(cleared.profiles[0].fingerprint, null);
  assert.equal(cleared.profiles[0].name, "账号1", "名字重置");
});

test("syncProfileStats 写回条数与指纹，且指纹只认第一次", async () => {
  const dir = await tempUserData();
  const { activeId } = await ps.listProfiles(dir);
  await ps.syncProfileStats(dir, activeId, {
    records: [{ poolId: 1, resultId: 10, timestampMs: 100, historyPosition: 1 }],
    lastCapturedAt: "2026-08-22T00:00:00.000Z",
  });
  let state = await ps.listProfiles(dir);
  assert.deepEqual(state.profiles[0].fingerprint, ["1:10:100"]);
  assert.equal(state.profiles[0].recordCount, 1);
  // 后续同步不会改写已确立的指纹
  await ps.syncProfileStats(dir, activeId, {
    records: [{ poolId: 9, resultId: 99, timestampMs: 900, historyPosition: 1 }],
    lastCapturedAt: "2026-08-22T01:00:00.000Z",
  });
  state = await ps.listProfiles(dir);
  assert.deepEqual(state.profiles[0].fingerprint, ["1:10:100"], "指纹是账号身份，不随后续读取变动");
});
