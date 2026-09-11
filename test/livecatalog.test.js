const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildDynamicCatalog, mergeCatalogs, normalizeRemoteCatalog, parseContractNotice,
} = require("../src/main/livecatalog");

test("从官方限定契约公告提取池名与六星风格", () => {
  assert.deepEqual(parseContractNotice({
    noticeName: "「隐秘的归属」限时契约",
    noticeContent: "<p>活动限定6星风格「杯中藏锋&middot;某某人」召唤概率提升。</p>",
  }), {
    kind: "limited", poolName: "隐秘的归属",
    name: "杯中藏锋", character: "某某人", rarity: 6,
  });
});

test("从官方遴选公告提取主题与六星风格", () => {
  assert.deepEqual(parseContractNotice({
    noticeName: "「遴选契约」限时开启",
    noticeContent: "<p>本期主题为「天才不必孑立」。常驻6星风格「科技部长&middot;提线人」召唤概率提升。</p>",
  }), {
    kind: "selection", poolName: "天才不必孑立",
    name: "科技部长", character: "提线人", rarity: 6,
  });
});

test("用游戏协议的关联 ID 与官方公告合成动态目录", () => {
  const catalog = buildDynamicCatalog({ poolSnapshot: [
    { poolId: 30006, relatedItemId: 13001099 },
    { poolId: 20010, relatedItemId: 13001098 },
  ] }, [
    { kind: "limited", poolName: "隐秘的归属", name: "杯中藏锋", character: "某某人", rarity: 6 },
    { kind: "selection", poolName: "天才不必孑立", name: "科技部长", character: "提线人", rarity: 6 },
  ]);
  assert.deepEqual(catalog.pools, [
    { id: 30006, name: "隐秘的归属", source: "official-notice" },
    { id: 20010, name: "天才不必孑立", source: "official-notice" },
  ]);
  assert.equal(catalog.cards[0].id, 13001099);
  assert.equal(catalog.cards[1].id, 13001098);
  assert.equal(catalog.resolutions[0].idSource, "game-protocol");
});

test("目录帧缺席时只对唯一未知结果做无歧义映射", () => {
  const notices = [{
    kind: "limited", poolName: "隐秘的归属",
    name: "杯中藏锋", character: "某某人", rarity: 6,
  }];
  const catalog = buildDynamicCatalog({
    records: [{ poolId: 30006, resultId: 13001029 }, { poolId: 30006, resultId: 13001028 }],
    knownCardIds: [13001028],
  }, notices);
  assert.equal(catalog.pools[0].id, 30006);
  assert.equal(catalog.cards[0].id, 13001029);
  assert.equal(catalog.resolutions[0].idSource, "unique-unknown-fallback");

  const ambiguous = buildDynamicCatalog({
    records: [{ poolId: 30006, resultId: 13001029 }, { poolId: 30006, resultId: 13001030 }],
    knownCardIds: [],
  }, notices);
  assert.equal(ambiguous.cards.length, 0);
});

test("远程目录严校验并标记来源", () => {
  const catalog = normalizeRemoteCatalog({
    version: 1,
    pools: [{ id: 30006, name: "隐秘的归属" }],
    cards: [{ id: 13001029, name: "杯中藏锋", character: "某某人", rarity: 6 }],
  });
  assert.equal(catalog.cards[0].source, "remote-catalog");
  assert.throws(() => normalizeRemoteCatalog({ version: 1, pools: [], cards: [{ id: "x" }] }), /非法条目/);
});

test("实时目录优先覆盖远程目录，远程目录覆盖旧缓存", () => {
  const merged = mergeCatalogs(
    { pools: [{ id: 30006, name: "旧缓存" }], cards: [] },
    { pools: [{ id: 30006, name: "远程" }], cards: [{ id: 1, name: "远程卡" }] },
    { pools: [{ id: 30006, name: "官方实时" }], cards: [] },
  );
  assert.equal(merged.pools[0].name, "官方实时");
  assert.equal(merged.cards[0].name, "远程卡");
});
