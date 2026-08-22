// 多账号档案：谁的记录归谁。
// 《夜幕之下》的协议里没有任何账号标识（响应只有卡池ID、结果ID、时间戳），
// 不像原神能从抽卡链接直接拿到 UID。所以这里用"历史记录本身"当账号指纹：
// 同一个账号最早那几抽是永远不变的，把它们的 key 拼起来撞号概率约等于零。
// 指纹的用途不是替用户分类，是在合并之前拦住"这份记录不属于当前档案"。

const FINGERPRINT_SIZE = 8;

// 记录的稳定标识：卡池+结果+毫秒时间（与 store 的 key 同源，但去掉同值序号后缀，
// 因为序号依赖读取顺序，跨设备可能不同）。
function recordSignature(record) {
  return `${record.poolId}:${record.resultId}:${record.timestampMs}`;
}

// 取最早的若干条组成指纹。历史位置优先（服务器给的真实顺序），缺失时退回时间戳。
function computeFingerprint(records, size = FINGERPRINT_SIZE) {
  if (!Array.isArray(records) || records.length === 0) return null;
  const sorted = [...records].sort((a, b) => {
    const pa = Number.isInteger(a.historyPosition) ? a.historyPosition : null;
    const pb = Number.isInteger(b.historyPosition) ? b.historyPosition : null;
    if (pa !== null && pb !== null) return pb - pa; // historyPosition 越大越早
    return a.timestampMs - b.timestampMs;
  });
  return sorted.slice(0, size).map(recordSignature);
}

// 两个指纹是否指向同一个账号：短的那个必须是长的前缀。
// 允许长度不等——账号早期抽数少时指纹短，之后不会变，只会在后面补齐。
function fingerprintMatches(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.every((item, index) => item === longer[index]);
}

// 记录重叠度：同一个账号的两批记录必然大量重合，不同账号几乎零重合。
// 这是比"最早几条指纹"更稳的判据——游戏若对历史记录有保留期，最早的记录会
// 随时间消失，指纹会整体漂移；而重叠度只看"共同拥有多少条"，对过期免疫。
function overlapRatio(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return 0;
  const setB = new Set(b.map(recordSignature));
  let hit = 0;
  for (const record of a) if (setB.has(recordSignature(record))) hit += 1;
  return hit / Math.min(a.length, b.length);
}

// 判定两批记录是否同一个账号：重合比例够高，或绝对重合条数够多。
// 双阈值是为了兼顾两端——小号只有十几抽时看比例，大号几千条时看绝对数。
const OVERLAP_RATIO_THRESHOLD = 0.3;
const OVERLAP_COUNT_THRESHOLD = 10;
function sameAccountByOverlap(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return false;
  const setB = new Set(b.map(recordSignature));
  let hit = 0;
  for (const record of a) if (setB.has(recordSignature(record))) hit += 1;
  if (hit >= OVERLAP_COUNT_THRESHOLD) return true;
  return hit / Math.min(a.length, b.length) >= OVERLAP_RATIO_THRESHOLD;
}

// 拿本次读到的记录去比对所有档案，判断这份数据属于谁。
// 返回 { verdict, profileId }：
//   same    → 就是当前档案，正常合并
//   other   → 是另一个已有档案的号（附 profileId），该切过去
//   unknown → 谁都对不上，多半是新账号
//   adopt   → 当前档案还没有指纹（空档案首次抓取），直接认领
// storedRecords: id → 该档案已存的记录数组（有几个档案就查几份，档案数量个位数，代价可忽略）
function identifyProfile({ records, profiles, activeId, storedRecords = {} }) {
  if (!Array.isArray(records) || !records.length) return { verdict: "same", profileId: activeId };
  const list = Array.isArray(profiles) ? profiles : [];
  const active = list.find((item) => item.id === activeId);
  const activeStored = storedRecords[activeId] ?? [];
  const incoming = computeFingerprint(records);

  // 当前档案还是空的（没记录也没指纹）——首次抓取，直接认领
  if (active && !activeStored.length && !active.fingerprint?.length) {
    return { verdict: "adopt", profileId: activeId };
  }
  // 主判据：与当前档案的记录重叠
  if (sameAccountByOverlap(records, activeStored)) return { verdict: "same", profileId: activeId };
  // 退路：档案有指纹但本地记录读不到时，仍用指纹兜一层
  if (!activeStored.length && active && fingerprintMatches(incoming, active.fingerprint)) {
    return { verdict: "same", profileId: activeId };
  }
  // 是不是别的档案的号
  for (const item of list) {
    if (item.id === activeId) continue;
    const stored = storedRecords[item.id] ?? [];
    if (sameAccountByOverlap(records, stored)) return { verdict: "other", profileId: item.id };
    if (!stored.length && fingerprintMatches(incoming, item.fingerprint)) {
      return { verdict: "other", profileId: item.id };
    }
  }
  return { verdict: "unknown", profileId: null };
}

// 档案索引的默认形态。老用户没有索引文件时，用它把现有单文件记录迁成"档案1"。
function emptyIndex() {
  return { version: 1, activeId: null, profiles: [] };
}

function makeProfile({ id, name, fingerprint = null, createdAt }) {
  return { id, name, fingerprint, createdAt, recordCount: 0, lastCapturedAt: null };
}

// 生成不与现有档案冲突的新 id（纯递增，避免依赖随机数——同一份索引在任何机器上可复现）。
function nextProfileId(profiles) {
  const used = new Set((profiles ?? []).map((item) => item.id));
  let index = 1;
  while (used.has(`p${index}`)) index += 1;
  return `p${index}`;
}

// 新档案的默认名：账号1、账号2……跳过已占用的名字。
function nextProfileName(profiles) {
  const used = new Set((profiles ?? []).map((item) => item.name));
  let index = 1;
  while (used.has(`账号${index}`)) index += 1;
  return `账号${index}`;
}

module.exports = {
  FINGERPRINT_SIZE,
  OVERLAP_COUNT_THRESHOLD,
  OVERLAP_RATIO_THRESHOLD,
  overlapRatio,
  sameAccountByOverlap,
  computeFingerprint,
  emptyIndex,
  fingerprintMatches,
  identifyProfile,
  makeProfile,
  nextProfileId,
  nextProfileName,
  recordSignature,
};
