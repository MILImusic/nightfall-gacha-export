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
  const records = new Map(store.records.map((record) => [record.key, record]));
  for (const record of capture.records) records.set(record.key, record);
  store.records = [...records.values()].sort((a, b) => b.timestampMs - a.timestampMs || b.resultId - a.resultId || a.key.localeCompare(b.key));
  store.lastCapturedAt = capturedAt;
  store.captures.push({
    capturedAt,
    expectedTotal: capture.expectedTotal,
    imported: capture.records.length,
    pageCount: capture.pageCount,
    complete: capture.complete,
  });
  await saveStore(filePath, store);
  return store;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(store) {
  const header = ["recordId", "poolId", "resultId", "timestamp", "timestampMs"];
  const rows = [header, ...store.records.map((record) => [
    record.key, record.poolId, record.resultId, record.timestamp, record.timestampMs,
  ])];
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

module.exports = { emptyStore, loadStore, mergeCapture, saveStore, toCsv };
