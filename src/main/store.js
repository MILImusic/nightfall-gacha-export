const fs = require("node:fs/promises");
const path = require("node:path");

function emptyStore() {
  return { version: 2, lastCapturedAt: null, captures: [], records: [] };
}

async function loadStore(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return parsed.version === 2 ? parsed : emptyStore();
  } catch (error) {
    if (error.code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function saveStore(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function mergeCapture(filePath, capture) {
  const store = await loadStore(filePath);
  const capturedAt = capture.capturedAt ?? new Date().toISOString();
  if (capture.incremental && capture.newCount > 0) {
    store.records = store.records.map((record) => ({
      ...record,
      historyPosition: Number.isInteger(record.historyPosition)
        ? record.historyPosition + capture.newCount
        : record.historyPosition,
    }));
  }
  const records = new Map(store.records.map((record) => [record.key, record]));
  for (const record of capture.records) records.set(record.key, record);
  store.records = [...records.values()].sort((a, b) => b.timestampMs - a.timestampMs || b.resultId - a.resultId || a.key.localeCompare(b.key));
  if (capture.complete && store.records.length !== capture.expectedTotal) {
    throw new Error(`本地合并后为 ${store.records.length} 条，与服务器 ${capture.expectedTotal} 条不一致，未写入`);
  }
  store.lastCapturedAt = capturedAt;
  store.captures.push({
    capturedAt,
    expectedTotal: capture.expectedTotal,
    imported: capture.records.length,
    pageCount: capture.pageCount,
    // complete=false 的收据不是"抓完了"，只是"抓到这儿断了"。
    // incrementalPlan 只认 complete=true 的收据当增量基准——别把这个条件放松，
    // 否则下次增量会从这个偏小的条数起算，把中间整段静默漏掉。
    complete: capture.complete,
    incremental: Boolean(capture.incremental),
    newCount: capture.newCount ?? capture.records.length,
    // 断在哪一页、错误码、当时的 requestId/sequence —— 用户报"每次都在 190 页断"
    // 时，这段是唯一能拿来定根因的东西
    interrupted: capture.interrupted ?? null,
    resumedFromPage: capture.resumedFromPage ?? null,
    trace: capture.trace ?? null,
  });
  await saveStore(filePath, store);
  return store;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(store) {
  const header = ["recordId", "poolId", "poolName", "resultId", "name", "character", "rarity", "poolPullNumber", "sixStarPity", "timestamp", "timestampMs"];
  const rows = [header, ...store.records.map((record) => [
    record.key, record.poolId, record.poolName, record.resultId, record.name, record.character, record.rarity,
    record.poolPullNumber, record.sixStarPity, record.timestamp, record.timestampMs,
  ])];
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

module.exports = { emptyStore, loadStore, mergeCapture, saveStore, toCsv };
