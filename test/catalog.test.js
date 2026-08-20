const test = require("node:test");
const assert = require("node:assert/strict");
const { cards, enrichStore, pityGroupForPool } = require("../src/main/catalog");

function record(key, resultId, historyPosition, poolId = 30005) {
  return { key, resultId, historyPosition, poolId, timestampMs: historyPosition };
}

test("卡牌表的内部 ID 唯一，且含当前限定六星", () => {
  assert.equal(new Set(cards.map((card) => card.id)).size, cards.length);
  assert.deepEqual(cards.find((card) => card.id === 13001021), {
    id: 13001021, name: "净世雨", character: "雨仙", rarity: 6,
  });
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

test("未确认规则的新限定池不会擅自并入继承组", () => {
  assert.notEqual(pityGroupForPool(30006).id, pityGroupForPool(30005).id);
});
