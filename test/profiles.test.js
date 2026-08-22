const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeFingerprint,
  fingerprintMatches,
  identifyProfile,
  nextProfileId,
  nextProfileName,
} = require("../src/main/profiles");

const rec = (poolId, resultId, timestampMs, historyPosition) => ({
  poolId, resultId, timestampMs, historyPosition,
});

test("computeFingerprint 取最早的若干条，historyPosition 越大越早", () => {
  const records = [
    rec(20001, 501, 1700000300000, 1),
    rec(20001, 502, 1700000200000, 2),
    rec(30001, 601, 1700000100000, 3),
  ];
  assert.deepEqual(computeFingerprint(records, 2), ["30001:601:1700000100000", "20001:502:1700000200000"]);
  assert.equal(computeFingerprint([]), null);
  assert.equal(computeFingerprint(null), null);
});

test("computeFingerprint 缺 historyPosition 时退回时间戳升序", () => {
  const records = [rec(1, 2, 300), rec(1, 3, 100), rec(1, 4, 200)];
  assert.deepEqual(computeFingerprint(records, 2), ["1:3:100", "1:4:200"]);
});

test("fingerprintMatches 允许长度不等，短的必须是长的前缀", () => {
  const full = ["a", "b", "c", "d"];
  assert.equal(fingerprintMatches(full, ["a", "b"]), true, "账号早期指纹短，之后只在后面补齐");
  assert.equal(fingerprintMatches(["a", "b"], full), true);
  assert.equal(fingerprintMatches(full, ["a", "x"]), false);
  assert.equal(fingerprintMatches(full, []), false);
  assert.equal(fingerprintMatches(full, null), false);
});

test("identifyProfile 认出同一个账号", () => {
  const records = [rec(1, 10, 100, 2), rec(1, 11, 200, 1)];
  const profiles = [{ id: "p1", fingerprint: ["1:10:100", "1:11:200"] }];
  assert.deepEqual(identifyProfile({ records, profiles, activeId: "p1" }), { verdict: "same", profileId: "p1" });
});

test("identifyProfile 认出这是另一个已有档案的号", () => {
  const records = [rec(9, 99, 900, 1)];
  const profiles = [
    { id: "p1", fingerprint: ["1:10:100"] },
    { id: "p2", fingerprint: ["9:99:900"] },
  ];
  assert.deepEqual(identifyProfile({ records, profiles, activeId: "p1" }), { verdict: "other", profileId: "p2" });
});

test("identifyProfile 谁都对不上就是新账号", () => {
  const records = [rec(7, 77, 700, 1)];
  const profiles = [{ id: "p1", fingerprint: ["1:10:100"] }];
  assert.deepEqual(identifyProfile({ records, profiles, activeId: "p1" }), { verdict: "unknown", profileId: null });
});

test("identifyProfile 空档案首次抓取直接认领，不当成冲突", () => {
  const records = [rec(1, 10, 100, 1)];
  const profiles = [{ id: "p1", fingerprint: null }];
  assert.deepEqual(identifyProfile({ records, profiles, activeId: "p1" }), { verdict: "adopt", profileId: "p1" });
});

test("identifyProfile 没有记录时不拦截（服务器返回空历史）", () => {
  const profiles = [{ id: "p1", fingerprint: ["1:10:100"] }];
  assert.deepEqual(identifyProfile({ records: [], profiles, activeId: "p1" }), { verdict: "same", profileId: "p1" });
});

test("identifyProfile 同一账号新增记录后指纹仍匹配（增量不误报）", () => {
  // 老档案存了 2 条指纹；这次读到 5 条，最早两条不变
  const profiles = [{ id: "p1", fingerprint: ["1:10:100", "1:11:200"] }];
  const records = [
    rec(1, 10, 100, 5), rec(1, 11, 200, 4), rec(1, 12, 300, 3), rec(1, 13, 400, 2), rec(1, 14, 500, 1),
  ];
  assert.deepEqual(identifyProfile({ records, profiles, activeId: "p1" }), { verdict: "same", profileId: "p1" });
});

test("nextProfileId / nextProfileName 跳过已占用的", () => {
  assert.equal(nextProfileId([{ id: "p1" }, { id: "p2" }]), "p3");
  assert.equal(nextProfileId([{ id: "p2" }]), "p1");
  assert.equal(nextProfileName([{ name: "账号1" }, { name: "大号" }]), "账号2");
  assert.equal(nextProfileName([]), "账号1");
});

test("sameAccountByOverlap 对'历史记录过期'免疫（指纹会漂移，重叠不会）", () => {
  const { sameAccountByOverlap } = require("../src/main/profiles");
  // 同一账号：90天前最早那批过期消失了，但中段大量重合
  const stored = Array.from({ length: 40 }, (_, i) => rec(1, i, 1000 + i, 40 - i));
  const afterExpiry = Array.from({ length: 40 }, (_, i) => rec(1, i + 15, 1015 + i, 40 - i));
  assert.equal(sameAccountByOverlap(afterExpiry, stored), true, "还剩25条重合，仍判为同一账号");
  // 不同账号：零重合
  const other = Array.from({ length: 40 }, (_, i) => rec(9, 900 + i, 90000 + i, 40 - i));
  assert.equal(sameAccountByOverlap(other, stored), false);
  // 小号只有几抽：靠比例而非绝对数
  const small = [rec(1, 0, 1000, 3), rec(1, 1, 1001, 2), rec(1, 2, 1002, 1)];
  assert.equal(sameAccountByOverlap(small, stored), true, "3条全中，比例100%");
  assert.equal(sameAccountByOverlap([rec(5, 5, 5, 1)], stored), false);
});

test("identifyProfile 用重叠度判定，过期后不再误报为新账号", () => {
  const stored = Array.from({ length: 30 }, (_, i) => rec(1, i, 1000 + i, 30 - i));
  const profiles = [{ id: "p1", fingerprint: ["1:0:1000", "1:1:1001"] }];
  // 最早两条（正是老指纹）已过期消失
  const afterExpiry = stored.slice(2);
  assert.deepEqual(
    identifyProfile({ records: afterExpiry, profiles, activeId: "p1", storedRecords: { p1: stored } }),
    { verdict: "same", profileId: "p1" },
  );
});

test("identifyProfile 认出另一档案靠重叠，不再依赖最早几条", () => {
  const a = Array.from({ length: 20 }, (_, i) => rec(1, i, 1000 + i, 20 - i));
  const b = Array.from({ length: 20 }, (_, i) => rec(2, i, 5000 + i, 20 - i));
  const profiles = [{ id: "p1", fingerprint: null }, { id: "p2", fingerprint: null }];
  assert.deepEqual(
    identifyProfile({ records: b, profiles, activeId: "p1", storedRecords: { p1: a, p2: b } }),
    { verdict: "other", profileId: "p2" },
  );
});
