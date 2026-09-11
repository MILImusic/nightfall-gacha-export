const test = require("node:test");
const assert = require("node:assert/strict");
const { cards, pools, enrichStore, pityGroupForPool } = require("../src/main/catalog");

function record(key, resultId, historyPosition, poolId = 30005) {
  return { key, resultId, historyPosition, poolId, timestampMs: historyPosition };
}

test("卡牌表的内部 ID 唯一，且含当前限定六星", () => {
  assert.equal(new Set(cards.map((card) => card.id)).size, cards.length);
  assert.deepEqual(cards.find((card) => card.id === 13001021), {
    id: 13001021, name: "净世雨", character: "雨仙", rarity: 6,
  });
});

test("当前历史池都有中文名称", () => {
  const names = new Map(pools.map((pool) => [pool.id, pool.name]));
  for (const id of [10001, 20001, 30001, 30002, 30003, 30004, 30005]) {
    assert.ok(names.get(id), `缺少卡池 ${id} 的名称`);
  }
});

test("按每个卡池的服务器原始顺序计算六星抽数", () => {
  const store = enrichStore({ records: [
    record("new-six", 13001021, 1),
    record("five", 13001014, 2),
    record("four-2", 13001028, 3),
    record("old-six", 13001025, 4),
    record("four-1", 13001028, 5),
  ] });
  const byKey = new Map(store.records.map((item) => [item.key, item]));
  assert.equal(byKey.get("old-six").poolPullNumber, 2);
  assert.equal(byKey.get("old-six").sixStarPity, 2);
  assert.equal(byKey.get("new-six").poolPullNumber, 5);
  assert.equal(byKey.get("new-six").sixStarPity, 3);
  assert.equal(byKey.get("five").name, "末路医师");
});

test("不同期限定 UP 池共用同一条六星保底计数", () => {
  const store = enrichStore({ records: [
    record("new-six", 13001021, 1, 30005),
    record("new-four", 13001028, 2, 30005),
    record("old-five", 13001014, 3, 30004),
    record("old-six", 13001025, 4, 30004),
    record("old-four", 13001028, 5, 30004),
  ] });
  const byKey = new Map(store.records.map((item) => [item.key, item]));
  assert.equal(byKey.get("old-six").sixStarPity, 2);
  assert.equal(byKey.get("new-six").sixStarPity, 3);
  assert.equal(byKey.get("new-six").poolPullNumber, 5);
  assert.equal(byKey.get("new-six").pityGroup, "limited:directional");
});

test("新一期限定池按协议命名空间自动并入继承组", () => {
  assert.equal(pityGroupForPool(30006).id, pityGroupForPool(30005).id);
});

test("四种池分为四条保底链，常驻遴选跨期继承", () => {
  const starter = pityGroupForPool(10001).id;
  const standard = pityGroupForPool(20001).id;
  const selection = pityGroupForPool(20002).id;
  const limited = pityGroupForPool(30001).id;
  assert.equal(new Set([starter, standard, selection, limited]).size, 4);
  assert.equal(pityGroupForPool(20007).id, selection);
  assert.equal(pityGroupForPool(20008).id, selection);
  assert.equal(pityGroupForPool(20009).id, selection);
  assert.notEqual(selection, standard);
  assert.notEqual(selection, limited);
});

test("未知命名空间不会被静默归进既有保底链", () => {
  assert.match(pityGroupForPool(40001).id, /^pool:/);
});

test("当前已垫次数按继承组分别计算", () => {
  const store = enrichStore({ records: [
    record("limited-new", 13001028, 1, 30005),
    record("selection-new", 13001028, 2, 20009),
    record("limited-five", 13001014, 3, 30004),
    record("selection-six", 13001021, 4, 20002),
    record("limited-six", 13001025, 5, 30004),
    record("standard-new", 13001028, 6, 20001),
  ] });
  const progress = new Map(store.pityProgress.map((item) => [item.id, item]));
  assert.equal(progress.get("limited:directional").currentPity, 2);
  assert.equal(progress.get("selection:standard").currentPity, 1);
  assert.equal(progress.get("standard").currentPity, 1);
  assert.equal(progress.get("limited:directional").pulls, 3);
  assert.equal(progress.get("limited:directional").exact, true);
});

test("旧记录的当前已垫次数标为约数", () => {
  const store = enrichStore({ records: [
    { ...record("old", 13001028, 1, 30005), historyPosition: null },
  ] });
  assert.equal(store.pityProgress[0].currentPity, 1);
  assert.equal(store.pityProgress[0].exact, false);
});

test("起始契约满30抽后不再作为当前垫抽展示", () => {
  const records = Array.from({ length: 30 }, (_, index) =>
    record(`starter-${index}`, 13001028, index + 1, 10001));
  const store = enrichStore({ records });
  assert.equal(store.pityProgress[0].pulls, 30);
  assert.equal(store.pityProgress[0].completed, true);
});

test("动态目录覆盖静态表并参与六星保底计算", () => {
  const dynamic = {
    pools: [{ id: 30006, name: "隐秘的归属" }],
    cards: [{ id: 13001099, name: "杯中藏锋", character: "某某人", rarity: 6 }],
  };
  const store = enrichStore({ records: [
    record("new-six", 13001099, 1, 30006),
    record("old-five", 13001014, 2, 30005),
  ] }, dynamic);
  const latest = store.records.find((item) => item.key === "new-six");
  assert.equal(latest.name, "杯中藏锋");
  assert.equal(latest.character, "某某人");
  assert.equal(latest.poolName, "隐秘的归属");
  assert.equal(latest.rarity, 6);
  assert.equal(latest.sixStarPity, 2);
  assert.equal(latest.metadataKnown, true);
});

test("未知结果明确标记为待识别而不是伪装成普通低星", () => {
  const store = enrichStore({ records: [record("unknown", 99999999, 1, 30006)] });
  assert.equal(store.records[0].rarity, null);
  assert.equal(store.records[0].metadataKnown, false);
});
