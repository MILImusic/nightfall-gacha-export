const cards = require("../data/cards.json");

const cardById = new Map(cards.map((card) => [card.id, card]));
const SHARED_SELECTION_POOLS = new Set([20002, 20003, 20004, 20005, 20006, 20007]);
const SHARED_LIMITED_POOLS = new Set([30001, 30002, 30003, 30004, 30005]);

function pityGroupForPool(poolId) {
  const id = Number(poolId);
  if (SHARED_LIMITED_POOLS.has(id)) return { id: "limited:directional", name: "限时定向契约（继承）" };
  if (SHARED_SELECTION_POOLS.has(id)) return { id: "selection:standard", name: "常驻遴选契约（继承）" };
  if (id === 20001) return { id: "standard", name: "常规契约" };
  if (id === 10001) return { id: "starter", name: "起始契约" };
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
        ...metrics.get(record.key),
        exactOrder: Number.isInteger(record.historyPosition),
      };
    }),
  };
}

module.exports = { cards, enrichStore, pityGroupForPool };
