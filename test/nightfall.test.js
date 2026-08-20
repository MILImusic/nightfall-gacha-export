const test = require("node:test");
const assert = require("node:assert/strict");
const {
  decodeHistoryRequest,
  decodeHistoryResponse,
  extractHistoryCapture,
  reassembleSegments,
  splitFrames,
} = require("../src/protocol/nightfall");

function varint(value) {
  let current = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    if (current) byte |= 0x80;
    bytes.push(byte);
  } while (current);
  return Buffer.from(bytes);
}

function field(number, value) {
  return Buffer.concat([varint(number << 3), varint(value)]);
}

function messageField(number, value) {
  return Buffer.concat([varint((number << 3) | 2), varint(value.length), value]);
}

function record(poolId, resultId, timestampMs) {
  return Buffer.concat([field(1, poolId), field(2, resultId), field(3, timestampMs)]);
}

function clientFrame(payload, requestId = 7) {
  const header = Buffer.alloc(9);
  header.writeUInt32BE(requestId, 0);
  Buffer.from("000c08", "hex").copy(header, 4);
  header[8] = requestId;
  const body = Buffer.concat([header, payload]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  return Buffer.concat([size, body]);
}

function serverFrame(payload, requestId = 7) {
  const header = Buffer.alloc(8);
  Buffer.from("000c08", "hex").copy(header, 0);
  header[6] = requestId;
  header[7] = requestId + 1;
  const body = Buffer.concat([header, payload]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  return Buffer.concat([size, body]);
}

test("解码全部记录请求与逐抽响应", () => {
  assert.deepEqual(decodeHistoryRequest(Buffer.concat([field(1, 0), field(2, 12)])), { poolId: 0, pageIndex: 12 });
  const payload = Buffer.concat([
    field(1, 0), field(2, 762),
    messageField(3, record(30005, 13001028, 1787210305712)),
  ]);
  assert.deepEqual(decodeHistoryResponse(payload), {
    status: 0,
    total: 762,
    records: [{
      poolId: 30005,
      resultId: 13001028,
      timestampMs: 1787210305712,
      timestamp: "2026-08-20T07:18:25.712Z",
    }],
  });
});

test("重复结果和相同毫秒不会被错误合并", () => {
  const requestPayload = Buffer.concat([field(1, 0), field(2, 0)]);
  const responsePayload = Buffer.concat([
    field(1, 0), field(2, 2),
    messageField(3, record(1, 99, 1000)),
    messageField(3, record(1, 99, 1000)),
  ]);
  const client = clientFrame(requestPayload);
  const server = serverFrame(responsePayload);
  const capture = extractHistoryCapture([
    { sourceAddress: "192.0.2.2", destinationAddress: "203.0.113.1", sourcePort: 50000, destinationPort: 12090, sequence: 10, payload: client },
    { sourceAddress: "203.0.113.1", destinationAddress: "192.0.2.2", sourcePort: 12090, destinationPort: 50000, sequence: 20, payload: server },
  ]);
  assert.equal(capture.records.length, 2);
  assert.notEqual(capture.records[0].key, capture.records[1].key);
  assert.equal(capture.complete, true);
});

test("TCP 重组会去掉重传重叠", () => {
  assert.equal(reassembleSegments([
    { sequence: 10, payload: Buffer.from("abcdef") },
    { sequence: 13, payload: Buffer.from("defghi") },
  ]).toString(), "abcdefghi");
});

test("拆帧会保留完整帧并忽略截断尾部", () => {
  const complete = serverFrame(Buffer.concat([field(1, 0), field(2, 0)]));
  assert.deepEqual(splitFrames(Buffer.concat([complete, Buffer.from([0, 0, 0])])), [complete]);
});
