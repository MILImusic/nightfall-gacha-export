const net = require("node:net");
const os = require("node:os");
const {
  buildClientFrame,
  decodeHistoryResponse,
  encodeHistoryRequest,
  HISTORY_COMMAND,
} = require("../protocol/nightfall");

const PROXY_PORT = 34010;
const ALT_PORT = 43010;

function isSynthetic(address) {
  const parts = address.split(".").map(Number);
  return (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 169 && parts[1] === 254);
}

function selectProxyAddress(interfaces = os.networkInterfaces()) {
  const candidates = Object.values(interfaces).flat().filter((item) =>
    item && item.family === "IPv4" && !item.internal && !isSynthetic(item.address));
  const preferred = candidates.find((item) => /^192\.168\./.test(item.address)) ||
    candidates.find((item) => /^10\./.test(item.address)) || candidates[0];
  if (!preferred) throw new Error("没有找到可用于连接接管的本机 IPv4 地址");
  return preferred.address;
}

function frameStream(onFrame) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE(0) + 4;
      if (length < 12 || length > 16 * 1024 * 1024) throw new Error("游戏连接出现非法帧");
      if (buffered.length < length) return;
      onFrame(buffered.subarray(0, length));
      buffered = buffered.subarray(length);
    }
  };
}

function aggregatePages(pages) {
  const occurrences = new Map();
  const records = [];
  let historyPosition = 0;
  for (const page of pages) {
    for (const record of page.records) {
      const signature = `${record.poolId}:${record.resultId}:${record.timestampMs}`;
      const occurrence = (occurrences.get(signature) ?? 0) + 1;
      occurrences.set(signature, occurrence);
      historyPosition += 1;
      records.push({ ...record, historyPosition, key: `${signature}:${occurrence}` });
    }
  }
  records.sort((a, b) => b.timestampMs - a.timestampMs || b.resultId - a.resultId || a.key.localeCompare(b.key));
  return {
    expectedTotal: pages[0]?.total ?? 0,
    pageCount: pages.length,
    records,
    complete: pages.length > 0 && records.length >= pages[0].total,
  };
}

function recordToken(record) {
  return `${record.poolId}:${record.resultId}:${record.timestampMs}`;
}

function incrementalPlan(firstPage, knownStore) {
  const lastCapture = [...(knownStore?.captures ?? [])].reverse().find((capture) => capture.complete);
  const knownRecords = knownStore?.records ?? [];
  if (!lastCapture || lastCapture.expectedTotal !== knownRecords.length || knownRecords.length === 0) return null;
  if (!knownRecords.every((record) => Number.isInteger(record.historyPosition))) return null;
  if (firstPage.total < lastCapture.expectedTotal || firstPage.records.length === 0) return null;
  const newCount = firstPage.total - lastCapture.expectedTotal;
  const overlapCount = Math.min(firstPage.records.length, knownRecords.length);
  const requiredRecords = newCount + overlapCount;
  return {
    newCount,
    overlapCount,
    requiredPages: Math.max(1, Math.ceil(requiredRecords / firstPage.records.length)),
    knownTokens: [...knownRecords]
      .sort((a, b) => a.historyPosition - b.historyPosition)
      .slice(0, overlapCount)
      .map(recordToken),
  };
}

function aggregateIncremental(pages, plan) {
  const fetched = pages.flatMap((page) => page.records);
  const overlap = fetched.slice(plan.newCount, plan.newCount + plan.overlapCount).map(recordToken);
  if (overlap.length !== plan.knownTokens.length || overlap.some((token, index) => token !== plan.knownTokens[index])) return null;
  const added = fetched.slice(0, plan.newCount);
  const partial = aggregatePages([{ total: added.length, records: added }]);
  return {
    ...partial,
    expectedTotal: pages[0].total,
    pageCount: pages.length,
    complete: true,
    incremental: true,
    newCount: added.length,
  };
}

class NightfallProxy {
  constructor({ proxyPort = PROXY_PORT, altPort = ALT_PORT, timeoutMs = 10000 } = {}) {
    this.proxyPort = proxyPort;
    this.altPort = altPort;
    this.timeoutMs = timeoutMs;
    this.server = null;
    this.game = null;
    this.upstream = null;
    this.waiter = null;
    this.lastUpstreamSequence = null;
    this.injectedRequests = 0;
    this.hiddenServerFrames = 0;
    this.responseIds = new Map();
  }

  async listen() {
    if (this.server) return;
    this.server = net.createServer((game) => this.#accept(game));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.proxyPort, "0.0.0.0", resolve);
    });
  }

  #accept(game) {
    if (this.game && !this.game.destroyed) {
      game.destroy(new Error("已有游戏连接"));
      return;
    }
    const address = game.remoteAddress?.replace(/^::ffff:/, "");
    if (!address) return game.destroy(new Error("无法识别游戏服务器地址"));
    const upstream = net.createConnection({ host: address, port: this.altPort });
    this.game = game;
    this.upstream = upstream;

    const sendGame = frameStream((frame) => {
      if (frame.length < 13) return this.#disconnect(new Error("游戏请求帧过短"));
      const translated = Buffer.from(frame);
      const originalSequence = frame.readUInt32BE(4);
      const originalRequestId = frame[12];
      const upstreamSequence = (originalSequence + this.injectedRequests) >>> 0;
      const upstreamRequestId = (originalRequestId + this.injectedRequests) & 0xff;
      translated.writeUInt32BE(upstreamSequence, 4);
      translated[12] = upstreamRequestId;
      this.lastUpstreamSequence = upstreamSequence;
      this.responseIds.set(upstreamRequestId, originalRequestId);
      upstream.write(translated);
    });
    game.on("data", (chunk) => {
      try { sendGame(chunk); } catch (error) { this.#disconnect(error); }
    });
    const receive = frameStream((frame) => {
      const command = frame.subarray(4, 7).toString("hex");
      const requestId = frame[10];
      if (this.waiter && command === HISTORY_COMMAND && requestId === this.waiter.requestId) {
        const waiter = this.waiter;
        this.waiter = null;
        this.hiddenServerFrames += 1;
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
        return;
      }
      const translated = Buffer.from(frame);
      if (translated.length >= 12) {
        translated[11] = (translated[11] - this.hiddenServerFrames) & 0xff;
        if (this.responseIds.has(requestId)) {
          translated[10] = this.responseIds.get(requestId);
          this.responseIds.delete(requestId);
        }
      }
      game.write(translated);
    });
    upstream.on("data", (chunk) => {
      try { receive(chunk); } catch (error) { this.#disconnect(error); }
    });
    game.on("error", (error) => this.#disconnect(error));
    upstream.on("error", (error) => this.#disconnect(error));
    game.on("close", () => this.#disconnect(new Error("游戏连接已断开")));
    upstream.on("close", () => this.#disconnect(new Error("服务器连接已断开")));
  }

  #disconnect(error) {
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      this.waiter.reject(error);
      this.waiter = null;
    }
    this.game?.destroy();
    this.upstream?.destroy();
    this.game = null;
    this.upstream = null;
    this.lastUpstreamSequence = null;
    this.injectedRequests = 0;
    this.hiddenServerFrames = 0;
    this.responseIds.clear();
  }

  connected() {
    return Boolean(this.game && this.upstream && !this.game.destroyed &&
      !this.upstream.destroyed && this.upstream.readyState === "open");
  }

  requestPage(offset) {
    if (!this.connected()) return Promise.reject(new Error("尚未接管游戏连接，请先启动接管再重新登录游戏"));
    if (this.waiter) return Promise.reject(new Error("已有历史请求正在进行"));
    if (this.lastUpstreamSequence === null) return Promise.reject(new Error("尚未观察到游戏协议序号，请先进入契约记录"));
    const sequence = (this.lastUpstreamSequence + 1) >>> 0;
    const requestId = sequence & 0xff;
    this.lastUpstreamSequence = sequence;
    this.injectedRequests += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter?.requestId === requestId) this.waiter = null;
        reject(new Error("游戏服务器响应超时"));
      }, this.timeoutMs);
      this.waiter = { requestId, resolve, reject, timer };
      this.upstream.write(buildClientFrame(HISTORY_COMMAND, encodeHistoryRequest(0, offset), requestId));
    }).then((frame) => ({
      errorCode: frame.readUInt16BE(8),
      ...decodeHistoryResponse(frame.subarray(12)),
    }));
  }

  async fetchAll({ knownStore, onProgress, intervalMs = 1200, retryDelaysMs = [2500, 5000, 8000] } = {}) {
    const pages = [];
    const requestWithRetry = async (offset, pageNumber) => {
      let response = await this.requestPage(offset);
      for (let attempt = 0; response.errorCode !== 0 && attempt < retryDelaysMs.length; attempt++) {
        const waitMs = retryDelaysMs[attempt];
        onProgress?.({ throttled: true, page: pageNumber, waitMs, errorCode: response.errorCode });
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        response = await this.requestPage(offset);
      }
      return response;
    };
    const first = await requestWithRetry(0, 1);
    if (first.errorCode !== 0) throw new Error(`服务器拒绝读取首页（错误 ${first.errorCode}）`);
    if (first.offset !== 0 || first.total <= 0) throw new Error(`服务器返回了异常的首条偏移 ${first.offset}`);
    pages.push(first);
    const pageSize = Math.max(1, first.records.length);
    const totalPages = Math.ceil(first.total / pageSize);
    const plan = incrementalPlan(first, knownStore);
    const plannedPages = plan ? Math.min(plan.requiredPages, totalPages) : totalPages;
    onProgress?.({ current: 1, total: plannedPages, records: first.records.length, incremental: Boolean(plan) });
    for (let pageIndex = 1; pageIndex < plannedPages; pageIndex++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const offset = pageIndex * pageSize;
      const page = await requestWithRetry(offset, pageIndex + 1);
      if (page.errorCode !== 0) throw new Error(`第 ${pageIndex + 1} 页读取失败（错误 ${page.errorCode}）`);
      if (page.offset !== offset) throw new Error(`第 ${pageIndex + 1} 页偏移不匹配（请求 ${offset}，返回 ${page.offset}）`);
      pages.push(page);
      onProgress?.({ current: pageIndex + 1, total: plannedPages, records: pages.reduce((sum, item) => sum + item.records.length, 0), incremental: Boolean(plan) });
    }
    if (plan) {
      const incremental = aggregateIncremental(pages, plan);
      if (incremental) return incremental;
      onProgress?.({ fallback: true, current: pages.length, total: totalPages, records: pages.reduce((sum, item) => sum + item.records.length, 0) });
    }
    for (let pageIndex = pages.length; pageIndex < totalPages; pageIndex++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const offset = pageIndex * pageSize;
      const page = await requestWithRetry(offset, pageIndex + 1);
      if (page.errorCode !== 0) throw new Error(`第 ${pageIndex + 1} 页读取失败（错误 ${page.errorCode}）`);
      if (page.offset !== offset) throw new Error(`第 ${pageIndex + 1} 页偏移不匹配（请求 ${offset}，返回 ${page.offset}）`);
      pages.push(page);
      onProgress?.({ current: pageIndex + 1, total: totalPages, records: pages.reduce((sum, item) => sum + item.records.length, 0) });
    }
    return aggregatePages(pages);
  }

  async close() {
    this.#disconnect(new Error("代理已关闭"));
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = {
  ALT_PORT,
  NightfallProxy,
  PROXY_PORT,
  aggregateIncremental,
  aggregatePages,
  frameStream,
  incrementalPlan,
  selectProxyAddress,
};
