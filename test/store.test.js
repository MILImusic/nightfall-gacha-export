const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { mergeCapture, toCsv } = require("../src/main/store");

const firstRecord = {
  key: "30005:13001028:1787210305712:1",
  poolId: 30005,
  resultId: 13001028,
  timestampMs: 1787210305712,
  timestamp: "2026-08-20T07:18:25.712Z",
};

test("相同记录不重复写入，新记录会合并", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nightfall-store-"));
  const file = path.join(directory, "records.json");
  await mergeCapture(file, { capturedAt: "2026-01-01", expectedTotal: 1, pageCount: 1, complete: true, records: [firstRecord] });
  const store = await mergeCapture(file, { capturedAt: "2026-01-02", expectedTotal: 1, pageCount: 1, complete: true, records: [firstRecord] });
  assert.equal(store.records.length, 1);
  assert.equal(store.captures.length, 2);
});

test("增量合并会保留旧记录并平移历史位置", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nightfall-store-incremental-"));
  const file = path.join(directory, "history.json");
  const oldRecords = Array.from({ length: 3 }, (_, index) => ({
    key: `old-${index}`,
    poolId: 1,
    resultId: 10 + index,
    timestampMs: 100 - index,
    historyPosition: index + 1,
  }));
  await mergeCapture(file, { expectedTotal: 3, pageCount: 1, complete: true, records: oldRecords });
  const store = await mergeCapture(file, {
    expectedTotal: 5,
    pageCount: 1,
    complete: true,
    incremental: true,
    newCount: 2,
    records: [
      { key: "new-1", poolId: 2, resultId: 21, timestampMs: 201, historyPosition: 1 },
      { key: "new-2", poolId: 2, resultId: 22, timestampMs: 200, historyPosition: 2 },
    ],
  });
  assert.equal(store.records.length, 5);
  assert.deepEqual(store.records.filter((item) => item.key.startsWith("old-")).map((item) => item.historyPosition), [3, 4, 5]);
  assert.equal(store.captures.at(-1).incremental, true);
  assert.equal(store.captures.at(-1).newCount, 2);
});

test("增量合并总数不一致时拒绝覆盖本地文件", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nightfall-store-reject-"));
  const file = path.join(directory, "history.json");
  await mergeCapture(file, {
    expectedTotal: 1,
    pageCount: 1,
    complete: true,
    records: [{ key: "old", poolId: 1, resultId: 1, timestampMs: 1, historyPosition: 1 }],
  });
  const before = await fs.readFile(file, "utf8");
  await assert.rejects(mergeCapture(file, {
    expectedTotal: 3,
    pageCount: 1,
    complete: true,
    incremental: true,
    newCount: 1,
    records: [{ key: "new", poolId: 1, resultId: 2, timestampMs: 2, historyPosition: 1 }],
  }), /本地合并后为 2 条/);
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("CSV 保留结果 ID、卡池与毫秒时间", () => {
  const csv = toCsv({ records: [firstRecord] });
  assert.match(csv, /recordId,poolId,poolName,resultId,name,character,rarity,poolPullNumber,sixStarPity,timestamp,timestampMs/);
  assert.match(csv, /30005,,13001028,,,,,,2026-08-20T07:18:25.712Z,1787210305712/);
});
