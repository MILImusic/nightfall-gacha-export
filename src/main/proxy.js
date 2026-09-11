const net = require("node:net");
const os = require("node:os");
const {
  buildClientFrame,
  decodeHistoryResponse,
  decodePoolCatalogResponse,
  encodeHistoryRequest,
  HISTORY_COMMAND,
  POOL_CATALOG_COMMAND,
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

// 把已存的记录还原成"抓过的页"，用于断点续抓：aggregatePages 会按页序重排
// historyPosition，所以这里必须按 historyPosition 升序切块，顺序错了整份记录都会错位。
function chunkIntoPages(records, pageSize, total) {
  const pages = [];
  for (let index = 0; index < records.length; index += pageSize) {
    pages.push({ total, offset: index, records: records.slice(index, index + pageSize) });
  }
  return pages;
}

// 上次抓到一半就断了 → 这次从断点接着抓，而不是从第 0 页重来。
// 任何一项对不上就返回 null（＝老老实实全量重抓）：宁可多抓一遍，也不能把
// 错位的两截拼成一份看起来完整的记录。
function resumePlan(firstPage, knownStore) {
  const captures = knownStore?.captures ?? [];
  const last = captures[captures.length - 1];
  if (!last || last.complete) return null;
  const known = knownStore?.records ?? [];
  if (known.length === 0) return null;
  if (!known.every((record) => Number.isInteger(record.historyPosition))) return null;
  // 期间又抽了卡 → 服务器那边整体后移，旧的 offset 全部失效，只能从头
  if (firstPage.total !== last.expectedTotal) return null;
  if (known.length !== last.imported) return null;
  const pageSize = Math.max(1, firstPage.records.length);
  // 只在整页边界上接，半页接不回去
  if (known.length % pageSize !== 0) return null;
  if (known.length >= firstPage.total) return null;
  const ordered = [...known].sort((a, b) => a.historyPosition - b.historyPosition);
  const head = ordered.slice(0, pageSize).map(recordToken);
  const fresh = firstPage.records.map(recordToken);
  if (head.length !== fresh.length || head.some((token, index) => token !== fresh[index])) return null;
  return {
    resumeFromPage: known.length / pageSize,
    knownPages: chunkIntoPages(ordered, pageSize, firstPage.total),
  };
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
    this.poolCatalog = [];
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
      if (command === POOL_CATALOG_COMMAND && frame.readUInt16BE(8) === 0) {
        try {
          const decoded = decodePoolCatalogResponse(frame.subarray(12));
          if (decoded.length) this.poolCatalog = decoded;
        } catch {
          // 目录帧只用于补展示名称；解析失败不能影响游戏原始连接。
        }
      }
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

  catalogSnapshot() {
    return this.poolCatalog.map((item) => ({ ...item }));
  }

  requestPage(offset) {
    if (!this.connected()) return Promise.reject(new Error("尚未接管游戏连接，请先启动接管，再进入一次游戏里的「契约 → 抽卡记录」界面"));
    if (this.waiter) return Promise.reject(new Error("已有历史请求正在进行"));
    if (this.lastUpstreamSequence === null) return Promise.reject(new Error("尚未观察到游戏协议序号，请先进入游戏里的「契约 → 抽卡记录」界面"));
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
      // requestId 是单字节、到 255 会绕回 0；sequence 不绕。两个都带出来，
      // 断线日志才能回答"断的那一页 requestId 是不是刚好绕回去了"。
      requestId,
      sequence,
      ...decodeHistoryResponse(frame.subarray(12)),
    }));
  }

  async fetchAll({ knownStore, onProgress, intervalMs = 1200, retryDelaysMs = [2500, 5000, 8000] } = {}) {
    const pages = [];
    // 断线日志：留住第 1 页和最近 TRACE_TAIL 页。中间几百页对排查没用，
    // 但"断的那一页 requestId/sequence 是多少"必须留住——这是目前唯一
    // 能证伪 requestId 单字节回绕（255→0）假设的证据。
    const TRACE_TAIL = 30;
    const trace = [];
    const pushTrace = (entry) => {
      trace.push(entry);
      if (trace.length > TRACE_TAIL + 1) trace.splice(1, 1);
    };
    const countRecords = () => pages.reduce((sum, item) => sum + item.records.length, 0);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const requestWithRetry = async (offset, pageNumber) => {
      let response = await this.requestPage(offset);
      let retries = 0;
      for (let attempt = 0; response.errorCode !== 0 && attempt < retryDelaysMs.length; attempt++) {
        const waitMs = retryDelaysMs[attempt];
        onProgress?.({ throttled: true, page: pageNumber, waitMs, errorCode: response.errorCode });
        await wait(waitMs);
        response = await this.requestPage(offset);
        retries += 1;
      }
      pushTrace({
        page: pageNumber,
        offset,
        requestId: response.requestId,
        sequence: response.sequence,
        errorCode: response.errorCode,
        returnedOffset: response.offset,
        records: response.records?.length ?? 0,
        retries,
      });
      return response;
    };

    const first = await requestWithRetry(0, 1);
    if (first.errorCode !== 0) throw new Error(`服务器拒绝读取首页（错误 ${first.errorCode}）`);
    if (first.offset !== 0 || first.total <= 0) throw new Error(`服务器返回了异常的首条偏移 ${first.offset}`);
    const pageSize = Math.max(1, first.records.length);
    const totalPages = Math.ceil(first.total / pageSize);

    // 抓到一半停下来：返回 null 表示这一段跑完了，返回对象表示断在哪一页。
    // 这里不再 throw —— 一 throw 前面几百页就全丢了，那正是"每次都在 190 页断、
    // 一条记录都没留下"的成因。
    const fetchRange = async (from, to, progressTotal, incremental) => {
      for (let pageIndex = from; pageIndex < to; pageIndex++) {
        await wait(intervalMs);
        const offset = pageIndex * pageSize;
        const pageNumber = pageIndex + 1;
        let page;
        try {
          page = await requestWithRetry(offset, pageNumber);
        } catch (error) {
          pushTrace({ page: pageNumber, offset, failed: error.message });
          return { reason: "request", message: `第 ${pageNumber} 页请求失败（${error.message}）`, page: pageNumber, offset };
        }
        if (page.errorCode !== 0) {
          return {
            reason: "errorCode",
            message: `第 ${pageNumber} 页读取失败（错误 ${page.errorCode}）`,
            page: pageNumber, offset, errorCode: page.errorCode,
            requestId: page.requestId, sequence: page.sequence,
          };
        }
        if (page.offset !== offset) {
          return {
            reason: "offset",
            message: `第 ${pageNumber} 页偏移不匹配（请求 ${offset}，返回 ${page.offset}）`,
            page: pageNumber, offset, returnedOffset: page.offset,
            requestId: page.requestId, sequence: page.sequence,
          };
        }
        pages.push(page);
        onProgress?.({ current: pageNumber, total: progressTotal, records: countRecords(), incremental });
      }
      return null;
    };

    const plan = incrementalPlan(first, knownStore);
    if (plan) {
      pages.push(first);
      const plannedPages = Math.min(plan.requiredPages, totalPages);
      onProgress?.({ current: 1, total: plannedPages, records: first.records.length, incremental: true });
      const stopped = await fetchRange(1, plannedPages, plannedPages, true);
      // 增量被打断：用户本来就有一份完整存档，这几页新记录接不回去也不该
      // 硬塞。什么都不存、直接报错，重来一次即可——他没有任何损失。
      if (stopped) throw Object.assign(new Error(stopped.message), { interrupted: stopped, trace });
      const incremental = aggregateIncremental(pages, plan);
      if (incremental) return { ...incremental, trace };
      onProgress?.({ fallback: true, current: pages.length, total: totalPages, records: countRecords() });
      const stoppedFull = await fetchRange(pages.length, totalPages, totalPages, false);
      return { ...aggregatePages(pages), trace, interrupted: stoppedFull ?? null };
    }

    // 上次抓到一半就断了 → 从断点接着抓，不从第 0 页重来
    const resume = resumePlan(first, knownStore);
    if (resume) {
      pages.push(...resume.knownPages);
      onProgress?.({ resumed: true, current: resume.resumeFromPage, total: totalPages, records: countRecords() });
    } else {
      pages.push(first);
      onProgress?.({ current: 1, total: totalPages, records: first.records.length, incremental: false });
    }
    const stopped = await fetchRange(pages.length, totalPages, totalPages, false);
    return {
      ...aggregatePages(pages),
      trace,
      interrupted: stopped ?? null,
      resumedFromPage: resume ? resume.resumeFromPage : null,
    };
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
  resumePlan,
  selectProxyAddress,
};
