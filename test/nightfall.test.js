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
const {
  aggregateIncremental,
  aggregatePages,
  frameStream,
  incrementalPlan,
  NightfallProxy,
  resumePlan,
  selectProxyAddress,
} = require("../src/main/proxy");

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

test("已有完整记录时只抓新增记录和一页重叠校验", () => {
  const knownRecords = Array.from({ length: 10 }, (_, index) => ({
    poolId: 10,
    resultId: 100 + index,
    timestampMs: 1000 - index,
    historyPosition: index + 1,
  }));
  const knownStore = {
    records: knownRecords,
    captures: [{ complete: true, expectedTotal: 10 }],
  };
  const first = {
    total: 12,
    records: [
      { poolId: 20, resultId: 201, timestampMs: 2001 },
      { poolId: 20, resultId: 202, timestampMs: 2000 },
      ...knownRecords.slice(0, 3),
    ],
  };
  const second = { total: 12, records: knownRecords.slice(3, 8) };
  const plan = incrementalPlan(first, knownStore);
  assert.deepEqual({ newCount: plan.newCount, overlapCount: plan.overlapCount, requiredPages: plan.requiredPages }, {
    newCount: 2,
    overlapCount: 5,
    requiredPages: 2,
  });
  const capture = aggregateIncremental([first, second], plan);
  assert.equal(capture.incremental, true);
  assert.equal(capture.newCount, 2);
  assert.equal(capture.expectedTotal, 12);
  assert.deepEqual(capture.records.map((item) => item.historyPosition), [1, 2]);
});

test("增量重叠不一致时拒绝捷径并回落全量", () => {
  const knownStore = {
    records: [{ poolId: 10, resultId: 100, timestampMs: 1000, historyPosition: 1 }],
    captures: [{ complete: true, expectedTotal: 1 }],
  };
  const first = {
    total: 2,
    records: [
      { poolId: 20, resultId: 200, timestampMs: 2000 },
      { poolId: 10, resultId: 999, timestampMs: 1000 },
    ],
  };
  const plan = incrementalPlan(first, knownStore);
  assert.equal(aggregateIncremental([first], plan), null);
});

test("旧记录没有稳定历史位置时强制全量读取", () => {
  assert.equal(incrementalPlan({ total: 2, records: [{ poolId: 1, resultId: 2, timestampMs: 3 }] }, {
    records: [{ poolId: 1, resultId: 2, timestampMs: 3 }],
    captures: [{ complete: true, expectedTotal: 1 }],
  }), null);
});

test("fetchAll 增量路径只请求新增量和一页重叠", async () => {
  const knownRecords = Array.from({ length: 10 }, (_, index) => ({
    poolId: 10,
    resultId: 100 + index,
    timestampMs: 1000 - index,
    historyPosition: index + 1,
  }));
  const allRecords = [
    { poolId: 20, resultId: 201, timestampMs: 2001 },
    { poolId: 20, resultId: 202, timestampMs: 2000 },
    ...knownRecords,
  ];
  const offsets = [];
  const proxy = new NightfallProxy();
  proxy.requestPage = async (offset) => {
    offsets.push(offset);
    return { errorCode: 0, offset, total: allRecords.length, records: allRecords.slice(offset, offset + 5) };
  };
  const capture = await proxy.fetchAll({
    intervalMs: 0,
    knownStore: { records: knownRecords, captures: [{ complete: true, expectedTotal: 10 }] },
  });
  assert.deepEqual(offsets, [0, 5]);
  assert.equal(capture.incremental, true);
  assert.equal(capture.newCount, 2);
});

test("fetchAll 增量指纹失败后从已取页继续完成全量", async () => {
  const knownRecords = Array.from({ length: 10 }, (_, index) => ({
    poolId: 10,
    resultId: 100 + index,
    timestampMs: 1000 - index,
    historyPosition: index + 1,
  }));
  const allRecords = [
    { poolId: 20, resultId: 201, timestampMs: 2001 },
    { poolId: 20, resultId: 202, timestampMs: 2000 },
    ...knownRecords.map((item, index) => index === 0 ? { ...item, resultId: 999 } : item),
  ];
  const offsets = [];
  const progress = [];
  const proxy = new NightfallProxy();
  proxy.requestPage = async (offset) => {
    offsets.push(offset);
    return { errorCode: 0, offset, total: allRecords.length, records: allRecords.slice(offset, offset + 5) };
  };
  const capture = await proxy.fetchAll({
    intervalMs: 0,
    onProgress: (item) => progress.push(item),
    knownStore: { records: knownRecords, captures: [{ complete: true, expectedTotal: 10 }] },
  });
  assert.deepEqual(offsets, [0, 5, 10]);
  assert.equal(progress.some((item) => item.fallback), true);
  assert.equal(capture.incremental, undefined);
  assert.equal(capture.complete, true);
  assert.equal(capture.records.length, 12);
});

test("接管地址跳过 Clash fake-ip 与 Tailscale，优先真实局域网", () => {
  assert.equal(selectProxyAddress({
    clash: [{ family: "IPv4", internal: false, address: "198.18.0.1" }],
    tailscale: [{ family: "IPv4", internal: false, address: "100.80.24.125" }],
    ethernet: [{ family: "IPv4", internal: false, address: "192.168.1.20" }],
  }), "192.168.1.20");
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

// ── 抓到一半断了：部分落库 + 断点续抓 + 断线日志 ───────────────────────────
// 背景：有玩家反复报"导到 190 多页就掉线"，而当时 fetchAll 一遇到失败页就 throw，
// 前面几百页全部丢弃、一条不落库，所以他抓了好几次手上仍然是 0 条记录。

function makeRecords(count) {
  return Array.from({ length: count }, (_, index) => ({
    poolId: 10,
    resultId: 1000 + index,
    timestampMs: 9000 - index,
  }));
}

// 第 stopAtPage 页（1 起数）开始一直返回限流码，模拟"每次都断在同一页"
function stubProxy(allRecords, { pageSize = 5, stopAtPage = null, errorCode = 142 } = {}) {
  const offsets = [];
  const proxy = new NightfallProxy();
  proxy.requestPage = async (offset) => {
    offsets.push(offset);
    const pageNumber = Math.floor(offset / pageSize) + 1;
    if (stopAtPage && pageNumber >= stopAtPage) {
      return { errorCode, offset, total: allRecords.length, records: [], requestId: offset & 0xff, sequence: offset };
    }
    return {
      errorCode: 0, offset, total: allRecords.length,
      records: allRecords.slice(offset, offset + pageSize),
      requestId: offset & 0xff, sequence: offset,
    };
  };
  return { proxy, offsets };
}

test("中途断掉时保留已读页而不是全部丢弃", async () => {
  const all = makeRecords(30);
  const { proxy } = stubProxy(all, { stopAtPage: 4 });
  const capture = await proxy.fetchAll({ intervalMs: 0, retryDelaysMs: [0] });
  assert.equal(capture.complete, false);
  assert.equal(capture.records.length, 15, "前三页 15 条必须留下来");
  assert.equal(capture.expectedTotal, 30);
  assert.equal(capture.interrupted.page, 4);
  assert.equal(capture.interrupted.errorCode, 142);
});

test("断线日志记下断点那一页的 requestId 和 sequence", async () => {
  const all = makeRecords(30);
  const { proxy } = stubProxy(all, { stopAtPage: 4 });
  const capture = await proxy.fetchAll({ intervalMs: 0, retryDelaysMs: [0] });
  assert.equal(capture.interrupted.requestId, 15);
  assert.equal(capture.interrupted.sequence, 15);
  assert.ok(capture.trace.length > 0, "轨迹不能是空的");
  assert.equal(capture.trace[0].page, 1, "第 1 页必须一直留在轨迹里");
  assert.equal(capture.trace.at(-1).errorCode, 142, "最后一条必须是失败的那页");
});

test("断线轨迹不会无上限增长", async () => {
  const all = makeRecords(500);
  const { proxy } = stubProxy(all);
  const capture = await proxy.fetchAll({ intervalMs: 0, retryDelaysMs: [0] });
  assert.equal(capture.complete, true);
  assert.ok(capture.trace.length <= 31, `轨迹应被截到 31 条以内，实际 ${capture.trace.length}`);
  assert.equal(capture.trace[0].page, 1);
});

test("上次断在第 4 页时从第 4 页接着抓，不从头重来", async () => {
  const all = makeRecords(30);
  const known = makeRecords(15).map((record, index) => ({ ...record, historyPosition: index + 1 }));
  const { proxy, offsets } = stubProxy(all);
  const capture = await proxy.fetchAll({
    intervalMs: 0,
    knownStore: { records: known, captures: [{ complete: false, expectedTotal: 30, imported: 15 }] },
  });
  assert.deepEqual(offsets, [0, 15, 20, 25], "只抓首页校验 + 断点之后的页");
  assert.equal(capture.resumedFromPage, 3);
  assert.equal(capture.complete, true);
  assert.equal(capture.records.length, 30);
});

test("期间又抽了卡就不许续抓，必须从头全量", async () => {
  const all = makeRecords(35);
  const known = makeRecords(15).map((record, index) => ({ ...record, historyPosition: index + 1 }));
  const { proxy, offsets } = stubProxy(all);
  const capture = await proxy.fetchAll({
    intervalMs: 0,
    knownStore: { records: known, captures: [{ complete: false, expectedTotal: 30, imported: 15 }] },
  });
  assert.equal(capture.resumedFromPage, null);
  assert.deepEqual(offsets.slice(0, 3), [0, 5, 10], "必须从第 0 页老实重抓");
  assert.equal(capture.records.length, 35);
});

test("首页对不上时拒绝续抓", () => {
  const known = makeRecords(15).map((record, index) => ({ ...record, historyPosition: index + 1 }));
  const firstPage = { total: 30, records: makeRecords(5).map((r) => ({ ...r, resultId: r.resultId + 500 })) };
  assert.equal(resumePlan(firstPage, {
    records: known, captures: [{ complete: false, expectedTotal: 30, imported: 15 }],
  }), null);
});

// ★ cc 点名的失败条件，专门造一次：不完整的存档绝不能被当成增量基准。
// 若被当成基准，增量会从偏小的条数起算，把中间整段静默漏掉——而且不会报错。
test("不完整的存档不能当增量基准（哪怕条数正好对得上）", () => {
  const known = makeRecords(15).map((record, index) => ({ ...record, historyPosition: index + 1 }));
  const firstPage = { total: 30, records: makeRecords(5) };
  // 故意把 expectedTotal 造成和条数一致，避开"条数对不上"那道门，
  // 只剩 complete 这一道 —— 删掉 incrementalPlan 里的 complete 过滤，这条必须变红
  assert.equal(incrementalPlan(firstPage, {
    records: known,
    captures: [{ complete: false, expectedTotal: 15, imported: 15 }],
  }), null, "complete:false 的收据被当成了增量基准");
});

test("存档里有不完整收据时整份重抓而不是走增量捷径", async () => {
  const all = makeRecords(30);
  const known = makeRecords(15).map((record, index) => ({ ...record, historyPosition: index + 1 }));
  const { proxy } = stubProxy(all);
  const capture = await proxy.fetchAll({
    intervalMs: 0,
    knownStore: { records: known, captures: [{ complete: false, expectedTotal: 15, imported: 15 }] },
  });
  assert.notEqual(capture.incremental, true);
  assert.equal(capture.records.length, 30, "少一条都说明中间漏了一段");
});

test("已有完整存档时增量被打断则什么都不存，直接报错", async () => {
  const known = makeRecords(20).map((record, index) => ({ ...record, historyPosition: index + 1 }));
  const all = [...makeRecords(10).map((r) => ({ ...r, poolId: 99, resultId: r.resultId + 7000, timestampMs: r.timestampMs + 7000 })), ...known];
  const { proxy } = stubProxy(all, { stopAtPage: 2 });
  await assert.rejects(
    proxy.fetchAll({
      intervalMs: 0,
      retryDelaysMs: [0],
      knownStore: { records: known, captures: [{ complete: true, expectedTotal: 20 }] },
    }),
    /第 2 页读取失败/,
    "用户已有完整存档，半截增量不许硬塞进去",
  );
});

// 端到端走一遍那位玩家的真实遭遇：第一次抓到一半断掉，第二次接着抓完。
// 这条如果红了，说明"抓几次都拿不到记录"的问题回来了。
test("端到端：第一次断在半路也拿得到记录，第二次续抓补齐", async () => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");
  const { loadStore, mergeCapture } = require("../src/main/store");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nightfall-e2e-"));
  const file = path.join(directory, "history.json");
  const all = makeRecords(30);

  const broken = stubProxy(all, { stopAtPage: 4 });
  const firstRun = await broken.proxy.fetchAll({ intervalMs: 0, retryDelaysMs: [0] });
  assert.equal(firstRun.complete, false);
  const afterFirst = await mergeCapture(file, { ...firstRun, capturedAt: "2026-08-27T00:00:00.000Z" });
  assert.equal(afterFirst.records.length, 15, "断了也得有记录可用，不能是 0 条");

  const healed = stubProxy(all);
  const secondRun = await healed.proxy.fetchAll({ intervalMs: 0, knownStore: await loadStore(file) });
  assert.equal(secondRun.resumedFromPage, 3, "第二次必须从断点接着抓");
  assert.deepEqual(healed.offsets, [0, 15, 20, 25]);
  const afterSecond = await mergeCapture(file, { ...secondRun, capturedAt: "2026-08-27T00:05:00.000Z" });
  assert.equal(afterSecond.records.length, 30);
  assert.equal(afterSecond.captures.at(-1).complete, true);
  assert.equal(new Set(afterSecond.records.map((item) => item.key)).size, 30, "续抓不许产生重复记录");
  const positions = afterSecond.records.map((item) => item.historyPosition).sort((a, b) => a - b);
  assert.deepEqual(positions, Array.from({ length: 30 }, (_, index) => index + 1), "历史位置必须连续无断层");
});
