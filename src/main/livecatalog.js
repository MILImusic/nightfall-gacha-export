const fs = require("node:fs/promises");
const path = require("node:path");

const NOTICE_URL_PATTERN = /https:\/\/noticemgr\.happymaker\.com\.cn\/+noticeinfo\/v5\/getNoticeInfo\.json\?[^\s"']+/g;
const REMOTE_CATALOG_URL = "https://raw.githubusercontent.com/MILImusic/nightfall-gacha-export/main/src/data/remote-catalog.json";

function plainText(html = "") {
  return String(html)
    .replace(/<[^>]*>/g, " ")
    .replaceAll("&middot;", "·")
    .replaceAll("&ldquo;", "“")
    .replaceAll("&rdquo;", "”")
    .replaceAll("&mdash;", "—")
    .replaceAll("&hellip;", "…")
    .replaceAll("&nbsp;", " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitStyle(value) {
  const [name, ...rest] = value.split("·");
  return { name: name.trim(), character: rest.join("·").trim() || null };
}

function parseContractNotice(notice) {
  const title = String(notice.noticeName ?? "");
  const text = plainText(notice.noticeContent);
  if (title.includes("遴选契约")) {
    const poolName = text.match(/本期主题为[「“]([^」”]+)[」”]/)?.[1];
    const style = text.match(/常驻6星风格[「“]([^」”]+)[」”]/)?.[1];
    return poolName && style ? { kind: "selection", poolName, ...splitStyle(style), rarity: 6 } : null;
  }
  const poolName = title.match(/「([^」]+)」限时契约/)?.[1];
  const style = text.match(/限定6星风格[「“]([^」”]+)[」”]/)?.[1];
  return poolName && style ? { kind: "limited", poolName, ...splitStyle(style), rarity: 6 } : null;
}

function inNamespace(kind, value) {
  const id = Number(value);
  return kind === "limited" ? id >= 30000 && id < 40000 : id >= 20002 && id < 30000;
}

function buildDynamicCatalog({ poolSnapshot = [], records = [], knownCardIds = [] }, notices) {
  const result = { pools: [], cards: [], resolutions: [] };
  const known = new Set(knownCardIds.map(Number));
  for (const kind of ["limited", "selection"]) {
    const notice = notices.find((item) => item?.kind === kind);
    if (!notice) continue;
    const candidates = poolSnapshot.filter((item) => inNamespace(kind, item.poolId));
    const recordPoolIds = records.filter((item) => inNamespace(kind, item.poolId)).map((item) => Number(item.poolId));
    const poolId = Math.max(0, ...candidates.map((item) => Number(item.poolId)), ...recordPoolIds);
    if (!poolId) continue;
    const pool = candidates.find((item) => Number(item.poolId) === poolId);
    let resultId = Number(pool?.relatedItemId) || 0;
    let idSource = resultId ? "game-protocol" : null;
    // 某些客户端不会在本次接管后重发 0x000c0b。仅当新池里恰好只有一个
    // 静态表未见过的结果 ID 时，才能无歧义地把公告六星与它对应；否则宁可待识别。
    if (!resultId) {
      const unknown = [...new Set(records
        .filter((item) => Number(item.poolId) === poolId && !known.has(Number(item.resultId)))
        .map((item) => Number(item.resultId)))];
      if (unknown.length === 1) {
        resultId = unknown[0];
        idSource = "unique-unknown-fallback";
      }
    }
    result.pools.push({ id: poolId, name: notice.poolName, source: "official-notice" });
    if (!resultId) continue;
    result.cards.push({
      id: resultId, name: notice.name, character: notice.character,
      rarity: notice.rarity, source: `official-notice+${idSource}`,
    });
    result.resolutions.push({ kind, poolId, resultId, idSource });
  }
  return result;
}

async function noticeUrlFromLog(logPath) {
  const content = await fs.readFile(logPath, "utf8");
  return [...content.matchAll(NOTICE_URL_PATTERN)].at(-1)?.[0]?.replaceAll("&amp;", "&") ?? null;
}

async function fetchJson(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`公告服务返回 HTTP ${response.status}`);
  return response.json();
}

function normalizeRemoteCatalog(value) {
  if (value?.version !== 1 || !Array.isArray(value.pools) || !Array.isArray(value.cards)) {
    throw new Error("远程目录格式无效");
  }
  const pools = value.pools.map((item) => ({ id: Number(item.id), name: String(item.name ?? "").trim(), source: "remote-catalog" }));
  const cards = value.cards.map((item) => ({
    id: Number(item.id), name: String(item.name ?? "").trim(),
    character: String(item.character ?? "").trim(), rarity: Number(item.rarity), source: "remote-catalog",
  }));
  if (pools.some((item) => !Number.isSafeInteger(item.id) || item.id <= 0 || !item.name) ||
      cards.some((item) => !Number.isSafeInteger(item.id) || item.id <= 0 || !item.name || !item.character || ![4, 5, 6].includes(item.rarity))) {
    throw new Error("远程目录含非法条目");
  }
  return { pools, cards };
}

function mergeCatalogs(...catalogs) {
  const pools = new Map();
  const cards = new Map();
  for (const catalog of catalogs) {
    for (const item of catalog?.pools ?? []) pools.set(Number(item.id), item);
    for (const item of catalog?.cards ?? []) cards.set(Number(item.id), item);
  }
  return { pools: [...pools.values()], cards: [...cards.values()] };
}

async function fetchRemoteCatalog(fetchImpl = fetch) {
  return normalizeRemoteCatalog(await fetchJson(REMOTE_CATALOG_URL, fetchImpl));
}

async function refreshLiveCatalog({ logPath, poolSnapshot, records, knownCardIds, cachePath, fetchImpl = fetch }) {
  const cached = await loadLiveCatalog(cachePath);
  let remote = { pools: [], cards: [] };
  let remoteStatus = "ok";
  try { remote = await fetchRemoteCatalog(fetchImpl); }
  catch (error) { remoteStatus = `fallback-cache: ${error.message}`; }
  const listUrl = await noticeUrlFromLog(logPath);
  if (!listUrl) throw new Error("游戏日志里没有公告地址，请先启动一次游戏");
  const list = await fetchJson(listUrl, fetchImpl);
  const entries = Object.values(list?.data?.value ?? {}).flat()
    .filter((item) => item?.title?.includes("限时契约") || item?.title?.includes("遴选契约"));
  const notices = [];
  for (const entry of entries) {
    const detailUrl = `https://noticemgr.happymaker.com.cn/noticeinfo/v4/queryNoticeInfo.json?id=${entry.id}&langCode=zh-CN&version=0`;
    notices.push(parseContractNotice((await fetchJson(detailUrl, fetchImpl))?.data?.value));
  }
  const dynamic = buildDynamicCatalog({ poolSnapshot, records, knownCardIds }, notices);
  const catalog = {
    ...mergeCatalogs(cached, remote, dynamic), resolutions: dynamic.resolutions,
    updatedAt: new Date().toISOString(), listUrl,
    remoteCatalogUrl: REMOTE_CATALOG_URL, remoteStatus,
  };
  if (catalog.cards.length) {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(`${cachePath}.tmp`, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    await fs.rename(`${cachePath}.tmp`, cachePath);
  }
  return catalog;
}

async function loadLiveCatalog(cachePath) {
  try {
    const value = JSON.parse(await fs.readFile(cachePath, "utf8"));
    return Array.isArray(value?.pools) && Array.isArray(value?.cards) ? value : { pools: [], cards: [] };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return { pools: [], cards: [] };
    throw error;
  }
}

module.exports = {
  REMOTE_CATALOG_URL, buildDynamicCatalog, fetchRemoteCatalog, loadLiveCatalog, mergeCatalogs,
  normalizeRemoteCatalog, noticeUrlFromLog, parseContractNotice, plainText, refreshLiveCatalog,
};
