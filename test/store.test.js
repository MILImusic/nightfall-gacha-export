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

test("抓到一半的记录也会落库，并且收据标成不完整", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nightfall-store-partial-"));
  const file = path.join(directory, "history.json");
  const partial = Array.from({ length: 15 }, (_, index) => ({
    key: `p-${index}`, poolId: 1, resultId: 10 + index, timestampMs: 500 - index, historyPosition: index + 1,
  }));
  const store = await mergeCapture(file, {
    expectedTotal: 30,
    pageCount: 3,
    complete: false,
    records: partial,
    interrupted: { reason: "errorCode", page: 4, offset: 15, errorCode: 142, requestId: 15, sequence: 15 },
    trace: [{ page: 1, offset: 0, requestId: 0, errorCode: 0, records: 5, retries: 0 }],
  });
  assert.equal(store.records.length, 15, "读到的必须存下来，不能因为不完整就全丢");
  const receipt = store.captures.at(-1);
  assert.equal(receipt.complete, false);
  assert.equal(receipt.interrupted.page, 4);
  assert.equal(receipt.interrupted.requestId, 15, "断点 requestId 要落盘，否则没法查根因");
  assert.equal(receipt.trace.length, 1);
});

test("续抓补齐后收据变完整，条数对不上仍然拒绝写入", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nightfall-store-resume-"));
  const file = path.join(directory, "history.json");
  const make = (count, from = 0) => Array.from({ length: count }, (_, index) => ({
    key: `r-${from + index}`, poolId: 1, resultId: 10 + from + index,
    timestampMs: 500 - from - index, historyPosition: from + index + 1,
  }));
  await mergeCapture(file, { expectedTotal: 30, pageCount: 3, complete: false, records: make(15) });
  const store = await mergeCapture(file, { expectedTotal: 30, pageCount: 6, complete: true, records: make(30) });
  assert.equal(store.records.length, 30);
  assert.equal(store.captures.at(-1).complete, true);
  await assert.rejects(
    mergeCapture(file, { expectedTotal: 99, pageCount: 6, complete: true, records: make(30) }),
    /不一致/,
  );
});
