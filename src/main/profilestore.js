// 档案的落盘层：索引 + 每档案一个记录文件，并负责把老用户的单文件记录迁进来。
// 目录结构（userData 下）：
//   records.json          老版本单文件；迁移后保留不动，作为回退备份
//   profiles/index.json   { version, activeId, profiles: [...] }
//   profiles/<id>.json    单个档案的 store（结构与原 records.json 完全一致）

const fs = require("node:fs/promises");
const path = require("node:path");
const { loadStore, saveStore } = require("./store");
const {
  computeFingerprint,
  emptyIndex,
  makeProfile,
  nextProfileId,
  nextProfileName,
} = require("./profiles");

function profilesDirectory(userData) {
  return path.join(userData, "profiles");
}

function indexPath(userData) {
  return path.join(profilesDirectory(userData), "index.json");
}

function profileDataPath(userData, id) {
  return path.join(profilesDirectory(userData), `${id}.json`);
}

function legacyDataPath(userData) {
  return path.join(userData, "records.json");
}

async function readIndex(userData) {
  try {
    const parsed = JSON.parse(await fs.readFile(indexPath(userData), "utf8"));
    if (parsed?.version === 1 && Array.isArray(parsed.profiles)) return parsed;
  } catch {
    // 读不到或格式不对都按"还没有索引"处理，交给迁移逻辑
  }
  return null;
}

async function writeIndex(userData, index) {
  await fs.mkdir(profilesDirectory(userData), { recursive: true });
  const temporary = `${indexPath(userData)}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await fs.rename(temporary, indexPath(userData));
}

// 首次启用多档案：把已有的 records.json 原样收编为"账号1"，老用户无感。
// 老文件不删——万一新结构出问题还能退回去。
async function ensureIndex(userData, now = new Date().toISOString()) {
  const existing = await readIndex(userData);
  if (existing) return existing;
  const index = emptyIndex();
  const id = nextProfileId([]);
  const profile = makeProfile({ id, name: nextProfileName([]), createdAt: now });
  const legacy = await loadStore(legacyDataPath(userData));
  if (legacy.records.length) {
    profile.fingerprint = computeFingerprint(legacy.records);
    profile.recordCount = legacy.records.length;
    profile.lastCapturedAt = legacy.lastCapturedAt;
    await saveStore(profileDataPath(userData, id), legacy);
  } else {
    await saveStore(profileDataPath(userData, id), legacy);
  }
  index.profiles.push(profile);
  index.activeId = id;
  await writeIndex(userData, index);
  return index;
}

async function listProfiles(userData) {
  const index = await ensureIndex(userData);
  return { activeId: index.activeId, profiles: index.profiles };
}

async function activeProfileId(userData) {
  const index = await ensureIndex(userData);
  return index.activeId;
}

async function createProfile(userData, { name, now = new Date().toISOString() } = {}) {
  const index = await ensureIndex(userData);
  const id = nextProfileId(index.profiles);
  const profile = makeProfile({
    id,
    name: (name ?? "").trim() || nextProfileName(index.profiles),
    createdAt: now,
  });
  await saveStore(profileDataPath(userData, id), { version: 2, lastCapturedAt: null, captures: [], records: [] });
  index.profiles.push(profile);
  index.activeId = id;
  await writeIndex(userData, index);
  return { activeId: index.activeId, profiles: index.profiles };
}

async function switchProfile(userData, id) {
  const index = await ensureIndex(userData);
  if (!index.profiles.some((item) => item.id === id)) throw new Error("找不到这个账号档案");
  index.activeId = id;
  await writeIndex(userData, index);
  return { activeId: index.activeId, profiles: index.profiles };
}

async function renameProfile(userData, id, name) {
  const index = await ensureIndex(userData);
  const profile = index.profiles.find((item) => item.id === id);
  if (!profile) throw new Error("找不到这个账号档案");
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw new Error("账号名不能为空");
  profile.name = trimmed.slice(0, 20);
  await writeIndex(userData, index);
  return { activeId: index.activeId, profiles: index.profiles };
}

// 删档案：记录文件改名为 .deleted-<时间> 而不是真删——误删可恢复。
// 删的是当前档案时自动切到剩下的第一个。
// 只剩最后一个时不能真删（系统不允许零档案），改为"清空记录并重置"——
// 用户想要的本来就是"清掉重来"，不是让档案列表变成空的。
async function deleteProfile(userData, id, now = new Date().toISOString()) {
  const index = await ensureIndex(userData);
  const target = index.profiles.find((item) => item.id === id);
  if (!target) throw new Error("找不到这个账号档案");
  if (index.profiles.length <= 1) {
    try {
      await fs.rename(
        profileDataPath(userData, id),
        `${profileDataPath(userData, id)}.deleted-${now.replace(/[:.]/g, "")}`,
      );
    } catch {
      // 没有记录文件就直接重建
    }
    await saveStore(profileDataPath(userData, id), { version: 2, lastCapturedAt: null, captures: [], records: [] });
    target.fingerprint = null;
    target.recordCount = 0;
    target.lastCapturedAt = null;
    target.name = nextProfileName([]);
    await writeIndex(userData, index);
    return { activeId: index.activeId, profiles: index.profiles, cleared: true };
  }
  index.profiles = index.profiles.filter((item) => item.id !== id);
  if (index.activeId === id) index.activeId = index.profiles[0].id;
  try {
    await fs.rename(
      profileDataPath(userData, id),
      `${profileDataPath(userData, id)}.deleted-${now.replace(/[:.]/g, "")}`,
    );
  } catch {
    // 记录文件不在就算了，索引已经摘掉
  }
  await writeIndex(userData, index);
  return { activeId: index.activeId, profiles: index.profiles };
}

// 每次写入记录后同步索引里的统计与指纹（指纹一旦确立就不再改动）。
async function syncProfileStats(userData, id, store) {
  const index = await ensureIndex(userData);
  const profile = index.profiles.find((item) => item.id === id);
  if (!profile) return index;
  profile.recordCount = store.records.length;
  profile.lastCapturedAt = store.lastCapturedAt;
  if (!profile.fingerprint?.length) profile.fingerprint = computeFingerprint(store.records);
  await writeIndex(userData, index);
  return index;
}

module.exports = {
  activeProfileId,
  createProfile,
  deleteProfile,
  ensureIndex,
  indexPath,
  legacyDataPath,
  listProfiles,
  profileDataPath,
  profilesDirectory,
  readIndex,
  renameProfile,
  switchProfile,
  syncProfileStats,
  writeIndex,
};
