const cards = require("../data/cards.json");
const pools = require("../data/pools.json");

const cardById = new Map(cards.map((card) => [card.id, card]));
const poolById = new Map(pools.map((pool) => [pool.id, pool]));

function pityGroupForPool(poolId) {
  const id = Number(poolId);
  if (id >= 30000 && id < 40000) return { id: "limited:directional", name: "限时定向契约（继承）" };
  if (id >= 20002 && id < 30000) return { id: "selection:standard", name: "常驻遴选契约（继承）" };
  if (id === 20001) return { id: "standard", name: "常规契约" };
  if (id >= 10000 && id < 20000) return { id: `starter:${id}`, name: "起始契约" };
  return { id: `pool:${id}`, name: `卡池 ${id}` };
}

function chronology(records) {
  return [...records].sort((a, b) => {
    if (Number.isInteger(a.historyPosition) && Number.isInteger(b.historyPosition)) {
      return b.historyPosition - a.historyPosition;
    }
    return a.timestampMs - b.timestampMs || a.key.localeCompare(b.key);
  });
}

function enrichStore(store) {
  const metrics = new Map();
  const groups = new Map();
  for (const record of chronology(store.records)) {
    const group = pityGroupForPool(record.poolId);
    const state = groups.get(group.id) ?? { pulls: 0, sinceSix: 0 };
    state.pulls += 1;
    state.sinceSix += 1;
    const card = cardById.get(record.resultId);
    metrics.set(record.key, {
      poolPullNumber: state.pulls,
      sixStarPity: card?.rarity === 6 ? state.sinceSix : null,
      pityGroup: group.id,
      pityGroupName: group.name,
    });
    if (card?.rarity === 6) state.sinceSix = 0;
    groups.set(group.id, state);
  }

  return {
    ...store,
    records: store.records.map((record) => {
      const card = cardById.get(record.resultId);
      return {
        ...record,
        name: card?.name ?? null,
        character: card?.character ?? null,
        rarity: card?.rarity ?? null,
        poolName: poolById.get(Number(record.poolId))?.name ?? null,
        ...metrics.get(record.key),
        exactOrder: Number.isInteger(record.historyPosition),
      };
    }),
  };
}

module.exports = { cards, pools, enrichStore, pityGroupForPool };
