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

test("CSV 保留结果 ID、卡池与毫秒时间", () => {
  const csv = toCsv({ records: [firstRecord] });
  assert.match(csv, /recordId,poolId,resultId,timestamp,timestampMs/);
  assert.match(csv, /30005,13001028,2026-08-20T07:18:25.712Z,1787210305712/);
});
