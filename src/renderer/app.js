const captureButton = document.querySelector("#captureButton");
const captureTitle = document.querySelector("#captureTitle");
const captureHint = document.querySelector("#captureHint");
const stepMarker = document.querySelector("#stepMarker");
const status = document.querySelector("#status");
const emptyState = document.querySelector("#emptyState");
const tableWrap = document.querySelector("#tableWrap");
const recordRows = document.querySelector("#recordRows");
const poolFilters = document.querySelector("#poolFilters");
const raritySummary = document.querySelector("#raritySummary");
let currentStore = null;
let activePool = "all";
let proxyConnected = false;

function recordsForActivePool() {
  if (!currentStore) return [];
  return activePool === "all"
    ? currentStore.records
    : currentStore.records.filter((record) => String(record.poolId) === activePool);
}

function renderRows() {
  recordRows.replaceChildren();
  for (const record of recordsForActivePool().filter((item) => item.rarity >= 5).slice(0, 100)) {
    const row = document.createElement("tr");
    row.className = `rarity-${record.rarity}`;
    const title = record.name ? `${record.name} · ${record.character}` : `结果 ${record.resultId}`;
    const position = record.rarity === 6
      ? `${record.pityGroupName}第 ${record.poolPullNumber} 抽 · ${record.sixStarPity} 抽出`
      : `${record.pityGroupName}第 ${record.poolPullNumber} 抽`;
    for (const value of [title, `${record.rarity ?? "?"} 星`, position, new Date(record.timestampMs).toLocaleString()]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    recordRows.append(row);
  }
}

function renderRaritySummary() {
  const records = recordsForActivePool();
  const sixes = records.filter((record) => record.rarity === 6);
  const fives = records.filter((record) => record.rarity === 5);
  raritySummary.replaceChildren();

  const sixBlock = document.createElement("div");
  sixBlock.className = "rarity-block six-star-block";
  sixBlock.innerHTML = `<div class="rarity-heading"><span>六星</span><strong>${sixes.length}</strong></div>`;
  const sixList = document.createElement("div");
  sixList.className = "six-star-list";
  for (const record of sixes) {
    const card = document.createElement("article");
    card.className = "six-star-card";
    const orderWarning = record.exactOrder ? "" : " · 顺序待重新获取校准";
    card.innerHTML = `<strong></strong><span></span><small></small>`;
    card.querySelector("strong").textContent = record.name ?? `结果 ${record.resultId}`;
    card.querySelector("span").textContent = record.character ?? "未知角色";
    const sourcePool = record.poolName ?? record.pityGroupName ?? "未知卡池";
    card.querySelector("small").textContent = `${record.pityGroupName}第 ${record.poolPullNumber} 抽 · ${record.sixStarPity} 抽出 · ${sourcePool}${orderWarning}`;
    sixList.append(card);
  }
  if (sixes.length === 0) sixList.textContent = "该范围内还没有六星记录";
  sixBlock.append(sixList);

  const fiveCounts = new Map();
  for (const record of fives) {
    const key = `${record.name ?? record.resultId} · ${record.character ?? "未知"}`;
    fiveCounts.set(key, (fiveCounts.get(key) ?? 0) + 1);
  }
  const fiveBlock = document.createElement("div");
  fiveBlock.className = "rarity-block five-star-block";
  fiveBlock.innerHTML = `<div class="rarity-heading"><span>五星</span><strong>${fives.length}</strong></div>`;
  const fiveList = document.createElement("div");
  fiveList.className = "five-star-list";
  for (const [name, count] of [...fiveCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const chip = document.createElement("span");
    chip.textContent = `${name} ×${count}`;
    fiveList.append(chip);
  }
  if (fives.length === 0) fiveList.textContent = "该范围内还没有五星记录";
  fiveBlock.append(fiveList);
  raritySummary.append(sixBlock, fiveBlock);
  raritySummary.hidden = records.length === 0;
}

function renderPoolFilters(store) {
  const counts = new Map();
  const names = new Map();
  for (const record of store.records) {
    const id = String(record.poolId);
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (record.poolName) names.set(id, record.poolName);
  }
  if (activePool !== "all" && !counts.has(activePool)) activePool = "all";
  poolFilters.replaceChildren();
  const options = [["all", "全部", store.records.length],
    ...[...counts.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([id, count]) => [id, names.get(id) ?? "未知卡池", count])];
  for (const [id, label, count] of options) {
    const button = document.createElement("button");
    button.className = `pool-filter${activePool === id ? " active" : ""}`;
    button.type = "button";
    button.dataset.poolId = id;
    button.append(document.createTextNode(label));
    const number = document.createElement("strong");
    number.textContent = count;
    button.append(number);
    poolFilters.append(button);
  }
  poolFilters.hidden = store.records.length === 0;
}

function render(store) {
  currentStore = store;
  document.querySelector("#capturedAt").textContent = store.lastCapturedAt
    ? new Date(store.lastCapturedAt).toLocaleString() : "—";
  document.querySelector("#recordCount").textContent = store.records.length;
  document.querySelector("#captureCount").textContent = store.captures.length;
  emptyState.hidden = store.records.length > 0;
  tableWrap.hidden = store.records.length === 0;
  renderPoolFilters(store);
  renderRaritySummary();
  renderRows();
}

poolFilters.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-pool-id]");
  if (!button) return;
  activePool = button.dataset.poolId;
  renderPoolFilters(currentStore);
  renderRaritySummary();
  renderRows();
});

captureButton.addEventListener("click", async () => {
  captureButton.disabled = true;
  try {
    if (!proxyConnected) {
      captureButton.textContent = "正在启动";
      captureTitle.textContent = "正在启动连接接管";
      status.textContent = "请在 UAC 窗口中允许管理员权限…";
      await window.nightfall.startProxy();
      status.textContent = "接管已启动。请现在启动或重新登录游戏；连接成功后按钮会自动变成“获取全部记录”。";
      return;
    }
    captureButton.textContent = "正在获取";
    captureTitle.textContent = "正在读取契约记录";
    status.textContent = "正在通过游戏当前连接读取…";
    const result = await window.nightfall.fetchHistory();
    render(result.store);
    status.textContent = `全量获取完成：本地共有 ${result.store.records.length} 条记录。`;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    captureButton.disabled = false;
    captureButton.textContent = proxyConnected ? "获取全部记录" : "启动连接接管";
    captureTitle.textContent = proxyConnected ? "连接已接管" : "准备接管";
  }
});

window.nightfall.onProgress((payload) => {
  if (payload.throttled) {
    status.textContent = `第 ${payload.page} 页触发服务器限流（${payload.errorCode}），等待 ${Math.ceil(payload.waitMs / 1000)} 秒后自动重试…`;
    return;
  }
  stepMarker.textContent = `${payload.current}/${payload.total}`;
  status.textContent = `正在读取第 ${payload.current}/${payload.total} 页，已取得 ${payload.records} 条…`;
});

document.querySelector("#exportJson").addEventListener("click", () => window.nightfall.exportJson());
document.querySelector("#exportCsv").addEventListener("click", () => window.nightfall.exportCsv());

window.nightfall.getData().then(render).catch((error) => { status.textContent = error.message; });
setInterval(async () => {
  try {
    const next = await window.nightfall.getProxyStatus();
    if (next.connected !== proxyConnected) {
      proxyConnected = next.connected;
      captureButton.textContent = proxyConnected ? "获取全部记录" : "启动连接接管";
      captureTitle.textContent = proxyConnected ? "连接已接管" : "准备接管";
      if (proxyConnected) status.textContent = "已接管游戏的当前连接。进入契约记录后即可获取全部记录。";
    }
  } catch {}
}, 1000);
