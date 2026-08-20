const captureButton = document.querySelector("#captureButton");
const captureTitle = document.querySelector("#captureTitle");
const captureHint = document.querySelector("#captureHint");
const stepMarker = document.querySelector("#stepMarker");
const status = document.querySelector("#status");
const emptyState = document.querySelector("#emptyState");
const tableWrap = document.querySelector("#tableWrap");
const recordRows = document.querySelector("#recordRows");
let capturing = false;

function render(store) {
  document.querySelector("#capturedAt").textContent = store.lastCapturedAt
    ? new Date(store.lastCapturedAt).toLocaleString() : "—";
  document.querySelector("#recordCount").textContent = store.records.length;
  document.querySelector("#captureCount").textContent = store.captures.length;
  emptyState.hidden = store.records.length > 0;
  tableWrap.hidden = store.records.length === 0;
  recordRows.replaceChildren();

  for (const record of store.records.slice(0, 100)) {
    const row = document.createElement("tr");
    for (const value of [record.resultId, record.poolId, new Date(record.timestampMs).toLocaleString()]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    recordRows.append(row);
  }
}

function setCapturing(active) {
  capturing = active;
  captureButton.disabled = false;
  captureButton.textContent = active ? "手动完成" : "开始捕获";
  captureTitle.textContent = active ? "正在监听游戏连接" : "准备捕获";
  captureHint.textContent = active
    ? "进入“全部记录”，鼠标停在下一页箭头上按 F8；也可手动翻完后点完成。"
    : "点击开始，然后在游戏里进入“契约记录 → 全部记录”。";
  stepMarker.textContent = active ? "2" : "1";
}

captureButton.addEventListener("click", async () => {
  captureButton.disabled = true;
  status.textContent = capturing ? "正在停止并解析…" : "正在请求管理员权限…";
  try {
    if (!capturing) {
      await window.nightfall.startCapture();
      setCapturing(true);
      status.textContent = "捕获已开始。打开全部记录后，把鼠标停在下一页箭头上按 F8。";
    } else {
      const result = await window.nightfall.finishCapture();
      setCapturing(false);
      render(result.store);
      status.textContent = `完成：本地共有 ${result.store.records.length} 条记录。`;
    }
  } catch (error) {
    setCapturing(false);
    status.textContent = error.message;
  } finally {
    captureButton.disabled = false;
  }
});

window.nightfall.onAutoStatus((payload) => {
  if (payload.state === "running") {
    captureButton.disabled = true;
    status.textContent = "正在自动翻页，请暂时不要移动鼠标或切换窗口…";
  } else if (payload.state === "done") {
    setCapturing(false);
    render(payload.store);
    status.textContent = `全量捕获完成：${payload.store.records.length} 条记录。`;
  } else {
    setCapturing(false);
    status.textContent = payload.message;
  }
});

document.querySelector("#exportJson").addEventListener("click", () => window.nightfall.exportJson());
document.querySelector("#exportCsv").addEventListener("click", () => window.nightfall.exportCsv());

window.nightfall.getData().then(render).catch((error) => { status.textContent = error.message; });
