const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const {
  buildClientFrame,
  decodeHistoryRequest,
  decodeHistoryResponse,
  extractHistoryCapture,
  encodeHistoryRequest,
  reassembleSegments,
  splitFrames,
} = require("../src/protocol/nightfall");
const { aggregatePages, frameStream, NightfallProxy, selectProxyAddress } = require("../src/main/proxy");

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

function serverFrame(payload, requestId = 7, errorCode = 0) {
  const header = Buffer.alloc(8);
  Buffer.from("000c08", "hex").copy(header, 0);
  header.writeUInt16BE(errorCode, 4);
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
    offset: 0,
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

test("构造任意页的历史请求", () => {
  assert.deepEqual(decodeHistoryRequest(encodeHistoryRequest(0, 152)), { poolId: 0, pageIndex: 152 });
  const frame = buildClientFrame("000c08", encodeHistoryRequest(0, 152), 153);
  assert.equal(frame.subarray(8, 11).toString("hex"), "000c08");
  assert.equal(frame[12], 153);
});

test("代理拆分跨 TCP chunk 的完整帧", () => {
  const first = serverFrame(Buffer.concat([field(1, 0), field(2, 1)]));
  const second = serverFrame(Buffer.concat([field(1, 0), field(2, 2)]), 8);
  const frames = [];
  const receive = frameStream((frame) => frames.push(frame));
  receive(first.subarray(0, 5));
  receive(Buffer.concat([first.subarray(5), second]));
  assert.deepEqual(frames, [first, second]);
});

test("代理汇总时按真实卡池保留重复并分别计数", () => {
  const capture = aggregatePages([
    { total: 3, records: [
      { poolId: 10, resultId: 1, timestampMs: 3 },
      { poolId: 20, resultId: 1, timestampMs: 2 },
    ] },
    { total: 3, records: [{ poolId: 10, resultId: 1, timestampMs: 3 }] },
  ]);
  assert.equal(capture.complete, true);
  assert.equal(capture.records.filter((item) => item.poolId === 10).length, 2);
  assert.notEqual(capture.records[0].key, capture.records[1].key);
});

test("接管地址跳过 Clash fake-ip 与 Tailscale，优先真实局域网", () => {
  assert.equal(selectProxyAddress({
    clash: [{ family: "IPv4", internal: false, address: "198.18.0.1" }],
    tailscale: [{ family: "IPv4", internal: false, address: "100.80.24.125" }],
    ethernet: [{ family: "IPv4", internal: false, address: "192.168.99.2" }],
  }), "192.168.99.2");
});

test("透明代理在同一游戏连接内注入请求且不把响应塞回游戏", async () => {
  let upstreamSocket;
  const upstreamRequests = [];
  let throttledOnce = false;
  const upstream = net.createServer((socket) => {
    upstreamSocket = socket;
    const receive = frameStream((request) => {
      upstreamRequests.push(Buffer.from(request));
      const requestId = request[12];
      const page = decodeHistoryRequest(request.subarray(13)).pageIndex;
      if (page === 5 && !throttledOnce) {
        throttledOnce = true;
        socket.write(serverFrame(Buffer.alloc(0), requestId, 142));
        return;
      }
      const payload = Buffer.concat([
        field(1, page), field(2, 15),
        ...Array.from({ length: 5 }, (_, index) =>
          messageField(3, record(30005, 13001028 + page + index, 1787210305712 - page - index))),
      ]);
      socket.write(serverFrame(payload, requestId));
    });
    socket.on("data", receive);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = new NightfallProxy({ proxyPort: 0, altPort: upstream.address().port, timeoutMs: 1000 });
  await proxy.listen();
  const game = net.createConnection({ host: "127.0.0.1", port: proxy.server.address().port });
  const gameFrames = [];
  game.on("data", frameStream((frame) => gameFrames.push(Buffer.from(frame))));
  await new Promise((resolve) => upstream.once("connection", resolve));
  game.write(clientFrame(Buffer.concat([field(1, 0), field(2, 0)]), 56));
  await new Promise((resolve) => setTimeout(resolve, 10));
  gameFrames.length = 0;
  const progress = [];
  const capture = await proxy.fetchAll({ intervalMs: 0, retryDelaysMs: [0], onProgress: (item) => progress.push(item) });
  assert.equal(capture.records.length, 15);
  assert.equal(capture.records[0].poolId, 30005);
  assert.equal(progress.some((item) => item.throttled && item.errorCode === 142), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(gameFrames.length, 0);
  assert.deepEqual(upstreamRequests.slice(-4).map((frame) => decodeHistoryRequest(frame.subarray(13)).pageIndex), [0, 5, 5, 10]);
  assert.equal(upstreamRequests.at(-1).readUInt32BE(4), 60);
  assert.equal(upstreamRequests.at(-1)[12], 60);

  game.write(clientFrame(Buffer.concat([field(1, 0), field(2, 1)]), 57));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(upstreamRequests.at(-1).readUInt32BE(4), 61);
  assert.equal(upstreamRequests.at(-1)[12], 61);
  assert.equal(gameFrames.at(-1)[10], 57);
  assert.equal(gameFrames.at(-1)[11], 58);
  game.destroy();
  upstreamSocket?.destroy();
  await proxy.close();
  await new Promise((resolve) => upstream.close(resolve));
});
