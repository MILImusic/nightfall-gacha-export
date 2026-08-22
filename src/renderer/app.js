const captureButton = document.querySelector("#captureButton");
const captureTitle = document.querySelector("#captureTitle");
const captureHint = document.querySelector("#captureHint");
const stepMarker = document.querySelector("#stepMarker");
const status = document.querySelector("#status");
const emptyState = document.querySelector("#emptyState");
const pityProgress = document.querySelector("#pityProgress");
const pityProgressSection = document.querySelector(".pity-progress-section");
const detailPanel = document.querySelector("#detailPanel");
const recordRows = document.querySelector("#recordRows");
const poolFilters = document.querySelector("#poolFilters");
const previewPanel = document.querySelector("#previewPanel");
const raritySummary = document.querySelector("#raritySummary");
const previewPageStatus = document.querySelector("#previewPageStatus");
const previousPreviewPage = document.querySelector("#previousPreviewPage");
const nextPreviewPage = document.querySelector("#nextPreviewPage");
const pageStatus = document.querySelector("#pageStatus");
const previousPage = document.querySelector("#previousPage");
const nextPage = document.querySelector("#nextPage");
const updateButton = document.querySelector("#updateButton");
const PAGE_SIZE = 10;
const PREVIEW_SIX_SIZE = 6;
const PREVIEW_FIVE_SIZE = 12;
let currentStore = null;
let activePool = "all";
let proxyConnected = false;
let viewMode = "preview";
let detailPage = 1;
let previewPage = 1;
let pendingUpdate = null;

function recordsForActivePool() {
  if (!currentStore) return [];
  return activePool === "all"
    ? currentStore.records
    : currentStore.records.filter((record) => String(record.poolId) === activePool);
}

function pityKind(groupId) {
  if (groupId?.startsWith("starter:")) return { label: "新手池", order: 0, className: "starter" };
  if (groupId === "standard") return { label: "常驻池", order: 1, className: "standard" };
  if (groupId === "selection:standard") return { label: "常驻限定池", order: 2, className: "selection" };
  if (groupId === "limited:directional") return { label: "限定池", order: 3, className: "limited" };
  return { label: "其他池", order: 4, className: "other" };
}

function renderPityProgress() {
  pityProgress.replaceChildren();
  let groups = (currentStore?.pityProgress ?? []).filter((group) => !group.completed);
  if (activePool !== "all") {
    const groupId = recordsForActivePool()[0]?.pityGroup;
    groups = groups.filter((group) => group.id === groupId);
  }
  for (const group of groups) {
    const kind = pityKind(group.id);
    const card = document.createElement("div");
    card.className = `pity-progress-card ${kind.className}`;
    const name = document.createElement("span");
    name.textContent = group.name;
    const count = document.createElement("strong");
    count.textContent = `${group.exact ? "" : "约 "}${group.currentPity} 抽`;
    card.append(name, count);
    pityProgress.append(card);
  }
  pityProgressSection.hidden = groups.length === 0;
}

function renderRows() {
  recordRows.replaceChildren();
  const records = recordsForActivePool().filter((item) => item.rarity >= 5);
  const totalPages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  detailPage = Math.min(detailPage, totalPages);
  const offset = (detailPage - 1) * PAGE_SIZE;
  for (const record of records.slice(offset, offset + PAGE_SIZE)) {
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
  pageStatus.textContent = `第 ${detailPage} / ${totalPages} 页`;
  previousPage.disabled = detailPage <= 1;
  nextPage.disabled = detailPage >= totalPages;
  detailPanel.hidden = viewMode !== "details" || recordsForActivePool().length === 0;
}

function renderRaritySummary() {
  const records = recordsForActivePool();
  const sixes = records.filter((record) => record.rarity === 6);
  const fives = records.filter((record) => record.rarity === 5);
  raritySummary.replaceChildren();

  const fiveCounts = new Map();
  for (const record of fives) {
    const name = `${record.name ?? record.resultId} · ${record.character ?? "未知"}`;
    const key = `${record.pityGroup}\0${name}`;
    const current = fiveCounts.get(key) ?? {
      name, count: 0, pityGroup: record.pityGroup, latestTimestampMs: record.timestampMs,
    };
    current.count += 1;
    current.latestTimestampMs = Math.max(current.latestTimestampMs, record.timestampMs);
    fiveCounts.set(key, current);
  }
  const fiveEntries = [...fiveCounts.values()].sort((a, b) => activePool === "all"
    ? b.latestTimestampMs - a.latestTimestampMs
    : b.count - a.count);
  const totalPages = Math.max(
    1,
    Math.ceil(sixes.length / PREVIEW_SIX_SIZE),
    Math.ceil(fiveEntries.length / PREVIEW_FIVE_SIZE),
  );
  previewPage = Math.min(previewPage, totalPages);
  const sixOffset = (previewPage - 1) * PREVIEW_SIX_SIZE;
  const fiveOffset = (previewPage - 1) * PREVIEW_FIVE_SIZE;
  const visibleSixes = sixes.slice(sixOffset, sixOffset + PREVIEW_SIX_SIZE);
  const visibleFives = fiveEntries.slice(fiveOffset, fiveOffset + PREVIEW_FIVE_SIZE);

  const sixBlock = document.createElement("div");
  sixBlock.className = "rarity-block six-star-block";
  sixBlock.innerHTML = `<div class="rarity-heading"><span>六星</span><strong>${sixes.length}</strong></div>`;
  const sixList = document.createElement("div");
  sixList.className = "six-star-list";
  for (const record of visibleSixes) {
    const card = document.createElement("article");
    card.className = "six-star-card";
    const orderWarning = record.exactOrder ? "" : " · 顺序待重新获取校准";
    card.innerHTML = `<strong></strong><span></span><em class="pity-badge"></em><small></small>`;
    const title = card.querySelector("strong");
    if (activePool === "all") {
      const kind = pityKind(record.pityGroup);
      const badge = document.createElement("b");
      badge.className = `pool-kind-badge ${kind.className}`;
      badge.textContent = kind.label;
      title.append(badge, document.createTextNode(record.name ?? `结果 ${record.resultId}`));
    } else {
      title.textContent = record.name ?? `结果 ${record.resultId}`;
    }
    card.querySelector("span").textContent = record.character ?? "未知角色";
    card.querySelector(".pity-badge").textContent = `${record.exactOrder ? "第" : "约第"} ${record.sixStarPity} 抽获得`;
    const sourcePool = record.poolName ?? record.pityGroupName ?? "未知卡池";
    card.querySelector("small").textContent = `${record.pityGroupName}累计第 ${record.poolPullNumber} 抽 · ${sourcePool}${orderWarning}`;
    sixList.append(card);
  }
  if (sixes.length === 0) sixList.textContent = "该范围内还没有六星记录";
  else if (visibleSixes.length === 0) sixList.textContent = "本页没有六星记录";
  sixBlock.append(sixList);

  const fiveBlock = document.createElement("div");
  fiveBlock.className = "rarity-block five-star-block";
  fiveBlock.innerHTML = `<div class="rarity-heading"><span>五星</span><strong>${fives.length}</strong></div>`;
  const fiveList = document.createElement("div");
  fiveList.className = "five-star-list";
  for (const entry of visibleFives) {
    const chip = document.createElement("span");
    if (activePool === "all") {
      const kind = pityKind(entry.pityGroup);
      const badge = document.createElement("b");
      badge.className = `pool-kind-badge ${kind.className}`;
      badge.textContent = kind.label;
      chip.append(badge, document.createTextNode(`${entry.name} ×${entry.count}`));
    } else {
      chip.textContent = `${entry.name} ×${entry.count}`;
    }
    fiveList.append(chip);
  }
  if (fives.length === 0) fiveList.textContent = "该范围内还没有五星记录";
  else if (visibleFives.length === 0) fiveList.textContent = "本页没有五星记录";
  fiveBlock.append(fiveList);
  raritySummary.append(sixBlock, fiveBlock);
  previewPageStatus.textContent = `第 ${previewPage} / ${totalPages} 页`;
  previousPreviewPage.disabled = previewPage <= 1;
  nextPreviewPage.disabled = previewPage >= totalPages;
  previewPanel.hidden = viewMode !== "preview" || records.length === 0;
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
  const sixes = store.records.filter((record) => record.rarity === 6 && Number.isFinite(record.sixStarPity));
  const average = sixes.length
    ? sixes.reduce((sum, record) => sum + record.sixStarPity, 0) / sixes.length
    : null;
  document.querySelector("#averageSixPity").textContent = average === null
    ? "—"
    : `${sixes.every((record) => record.exactOrder) ? "" : "约 "}${average.toFixed(1)} 抽`;
  emptyState.hidden = store.records.length > 0;
  renderPoolFilters(store);
  renderPityProgress();
  renderRaritySummary();
  renderRows();
}

poolFilters.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-pool-id]");
  if (!button) return;
  activePool = button.dataset.poolId;
  detailPage = 1;
  previewPage = 1;
  renderPoolFilters(currentStore);
  renderPityProgress();
  renderRaritySummary();
  renderRows();
});

document.querySelector(".view-switch").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-view]");
  if (!button) return;
  viewMode = button.dataset.view;
  detailPage = 1;
  previewPage = 1;
  for (const item of document.querySelectorAll(".view-switch button")) {
    const active = item.dataset.view === viewMode;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
  }
  renderRaritySummary();
  renderRows();
});

previousPage.addEventListener("click", () => {
  detailPage = Math.max(1, detailPage - 1);
  renderRows();
});

nextPage.addEventListener("click", () => {
  detailPage += 1;
  renderRows();
});

previousPreviewPage.addEventListener("click", () => {
  previewPage = Math.max(1, previewPage - 1);
  renderRaritySummary();
});

nextPreviewPage.addEventListener("click", () => {
  previewPage += 1;
  renderRaritySummary();
});

// 界面层的启动看门狗：比主进程的 30 秒超时略长，用来兜住"主进程调用永不返回"的情况。
const START_WATCHDOG_MS = 40000;
function startProxyWatchdog() {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(
        "启动接管超过 40 秒没有任何结果。最常见的原因是管理员授权弹窗没有被点到——它可能被挡在其他窗口后面（按 Alt+Tab 找找），" +
        "或者你的系统关闭/改动过用户账户控制(UAC)导致授权流程卡住。" +
        "最可靠的办法：完全退出本工具，右键工具图标选「以管理员身份运行」再打开——这样就不再需要授权弹窗。",
      ));
    }, START_WATCHDOG_MS);
  });
}

captureButton.addEventListener("click", async () => {
  captureButton.disabled = true;
  try {
    if (!proxyConnected) {
      captureButton.textContent = "正在启动";
      captureTitle.textContent = "正在启动连接接管";
      // 已经以管理员身份运行时不会弹授权窗口，别让用户干等一个不会出现的弹窗。
      status.textContent = toolElevated
        ? "正在启动接管（已是管理员身份，无需授权弹窗）…"
        : "请在弹出的管理员授权窗口中点“是”；若没看到，按 Alt+Tab 找一下，它可能被其他窗口挡住。";
      // 看门狗：主进程那条提权调用有可能卡在等待 UAC 而永不返回（用户改过 UAC 策略时尤其如此），
      // 底层超时未必杀得掉那个等待中的进程。这一层完全在界面里，保证按钮不会永远停在"正在启动"。
      await Promise.race([window.nightfall.startProxy(), startProxyWatchdog()]);
      status.textContent = "接管已启动。现在登录游戏即可；如果游戏已经登录着，进入一次「契约 → 抽卡记录」界面。接管成功后按钮会自动变成“获取全部记录”。";
      proxyStartedAt = Date.now();
      void runPreflight();
      return;
    }
    await runFetch();
  } catch (error) {
    const reason = humanizeError(error);
    if (!proxyConnected) showFailure("接管没能启动", reason, "");
    else status.textContent = reason;
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
  if (payload.fallback) {
    status.textContent = "增量重叠校验未通过，已自动切换为全量校验…";
    return;
  }
  stepMarker.textContent = `${payload.current}/${payload.total}`;
  status.textContent = `${payload.incremental ? "正在增量读取" : "正在读取"}第 ${payload.current}/${payload.total} 页，已取得 ${payload.records} 条…`;
});

document.querySelector("#exportJson").addEventListener("click", () => window.nightfall.exportJson());
document.querySelector("#exportCsv").addEventListener("click", () => window.nightfall.exportCsv());

const diagnosticsButton = document.querySelector("#diagnosticsButton");
diagnosticsButton.addEventListener("click", async () => {
  diagnosticsButton.disabled = true;
  const original = diagnosticsButton.textContent;
  try {
    const text = await window.nightfall.collectDiagnostics();
    await navigator.clipboard.writeText(text);
    diagnosticsButton.textContent = "已复制";
    status.textContent = "诊断信息已复制到剪贴板，直接粘贴给作者即可。";
  } catch (error) {
    status.textContent = `收集诊断信息失败：${error.message}`;
  } finally {
    setTimeout(() => { diagnosticsButton.textContent = original; }, 1500);
    diagnosticsButton.disabled = false;
  }
});

const netfixButton = document.querySelector("#netfixButton");
netfixButton.addEventListener("click", async () => {
  netfixButton.disabled = true;
  try {
    const result = await window.nightfall.applyNetworkFix();
    const parts = [...result.done, ...result.failed];
    status.textContent = parts.length
      ? `${parts.join("；")}。若 DNS 曾被加速器改过，请按上方提示手动改回“自动获得”。`
      : "没有可修复的残留。";
    void runPreflight();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    netfixButton.disabled = false;
  }
});


// ── 账号档案 ────────────────────────────────────────────────
// 协议里没有账号标识，档案靠用户自己切；但读取时会用记录指纹核对，
// 对不上就弹窗拦住，避免两个号的记录混进同一份档案。
const profileSelect = document.querySelector("#profileSelect");
const conflictOverlay = document.querySelector("#profileConflictOverlay");
let profileState = { activeId: null, profiles: [] };

function renderProfiles() {
  profileSelect.replaceChildren(
    ...profileState.profiles.map((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.recordCount ? `${item.name}（${item.recordCount}）` : item.name;
      option.selected = item.id === profileState.activeId;
      return option;
    }),
  );
}

async function refreshProfiles() {
  try {
    profileState = await window.nightfall.listProfiles();
    renderProfiles();
  } catch (error) {
    // 不挡主流程，但必须留痕：静默失败会让下拉框空着而没人知道原因
    console.error("[profiles] 读取档案列表失败：", error);
    status.textContent = `账号列表加载失败：${humanizeError(error)}`;
  }
}

profileSelect.addEventListener("change", async () => {
  try {
    profileState = await window.nightfall.switchProfile(profileSelect.value);
    renderProfiles();
    render(await window.nightfall.getData());
    status.textContent = `已切换到「${profileState.profiles.find((p) => p.id === profileState.activeId)?.name ?? ""}」。`;
  } catch (error) {
    showFailure("切换账号失败", humanizeError(error), "");
  }
});

// Electron 的渲染进程不实现 window.prompt（打包后调用直接返回 null），
// 所以新建/重命名/删除一律走自己的弹窗。
const profileEditOverlay = document.querySelector("#profileEditOverlay");
const profileNameInput = document.querySelector("#profileNameInput");
const profileDeleteOverlay = document.querySelector("#profileDeleteOverlay");
const profileDeleteInput = document.querySelector("#profileDeleteConfirmInput");
let editMode = null; // "create" | "edit"

function openProfileEdit(mode) {
  editMode = mode;
  const current = profileState.profiles.find((item) => item.id === profileState.activeId);
  const isCreate = mode === "create";
  document.querySelector("#profileEditTitle").textContent = isCreate ? "新建账号档案" : "账号档案";
  document.querySelector("#profileEditHint").textContent = isCreate
    ? "给新账号起个名字，方便自己分辨（例如：大号、小号、代练）。留空会自动命名。"
    : "改名后立刻生效。删除需要再确认一次。";
  profileNameInput.value = isCreate ? "" : (current?.name ?? "");
  document.querySelector("#profileEditStats").textContent = isCreate || !current
    ? ""
    : `当前有 ${current.recordCount} 条记录${current.lastCapturedAt ? `，最近读取 ${new Date(current.lastCapturedAt).toLocaleString()}` : ""}`;
  const onlyOne = profileState.profiles.length <= 1;
  const deleteButton = document.querySelector("#profileEditDelete");
  deleteButton.hidden = isCreate;
  deleteButton.textContent = onlyOne ? "清空这个账号的记录…" : "删除这个账号档案…";
  profileEditOverlay.hidden = false;
  profileNameInput.focus();
}

// 顶栏下拉菜单（账号管理、导出共用一套开合逻辑）
const openMenus = [];
function setupMenu(buttonSelector, menuSelector, onOpen) {
  const button = document.querySelector(buttonSelector);
  const menu = document.querySelector(menuSelector);
  const close = () => { menu.hidden = true; button.setAttribute("aria-expanded", "false"); };
  openMenus.push(close);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const opening = menu.hidden;
    for (const other of openMenus) other(); // 同时只开一个
    if (opening) {
      onOpen?.();
      menu.hidden = false;
      button.setAttribute("aria-expanded", "true");
    }
  });
  menu.addEventListener("click", () => close());
  return close;
}
document.addEventListener("click", () => { for (const close of openMenus) close(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") for (const close of openMenus) close();
});

// 「管理」下拉：新建 / 重命名 / 删除都收在这里，顶栏只留一个入口
const profileMenu = document.querySelector("#profileMenu");
setupMenu("#profileManage", "#profileMenu", () => {
  // 删除项的措辞取决于是不是唯一的档案：唯一时不能真删，只能清空
  document.querySelector("#profileMenuDelete").textContent =
    profileState.profiles.length <= 1 ? "清空当前账号的记录" : "删除当前账号";
});
setupMenu("#exportMenuButton", "#exportMenu");

profileMenu.addEventListener("click", (event) => {
  const action = event.target.closest("button")?.dataset.action;
  if (!action) return;
  if (action === "create") openProfileEdit("create");
  else if (action === "rename") openProfileEdit("edit");
  else if (action === "delete") openProfileDelete();
});
document.querySelector("#profileEditCancel").addEventListener("click", () => { profileEditOverlay.hidden = true; });

document.querySelector("#profileEditSave").addEventListener("click", async () => {
  const name = profileNameInput.value;
  profileEditOverlay.hidden = true;
  try {
    profileState = editMode === "create"
      ? await window.nightfall.createProfile(name)
      : await window.nightfall.renameProfile(profileState.activeId, name);
    renderProfiles();
    render(await window.nightfall.getData());
    status.textContent = editMode === "create"
      ? "新账号档案已建好，之后读取的记录会存进这里。"
      : "账号名已更新。";
  } catch (error) {
    showFailure(editMode === "create" ? "新建账号失败" : "改名失败", humanizeError(error), "");
  }
});

// 删除：二次弹窗 + 必须打出账号名才能点确认
function openProfileDelete() {
  const current = profileState.profiles.find((item) => item.id === profileState.activeId);
  if (!current) return;
  profileEditOverlay.hidden = true;
  const onlyOne = profileState.profiles.length <= 1;
  document.querySelector("#profileDeleteTitle").textContent = onlyOne ? "确认清空这个账号的记录" : "确认删除账号档案";
  document.querySelector("#profileDeleteWarn").textContent = onlyOne
    ? `「${current.name}」是目前唯一的账号档案，里面有 ${current.recordCount} 条抽卡记录。它不会被删掉（列表不能为空），但记录会被清空、名字重置。`
    : `你正要删除「${current.name}」，它里面有 ${current.recordCount} 条抽卡记录。`;
  document.querySelector("#profileDeleteConfirm").textContent = onlyOne ? "确认清空" : "确认删除";
  profileDeleteInput.value = "";
  document.querySelector("#profileDeleteConfirm").disabled = true;
  profileDeleteOverlay.hidden = false;
  profileDeleteInput.focus();
}

document.querySelector("#profileEditDelete").addEventListener("click", openProfileDelete);

profileDeleteInput.addEventListener("input", () => {
  const current = profileState.profiles.find((item) => item.id === profileState.activeId);
  document.querySelector("#profileDeleteConfirm").disabled =
    profileDeleteInput.value.trim() !== (current?.name ?? "").trim();
});

document.querySelector("#profileDeleteCancel").addEventListener("click", () => {
  profileDeleteOverlay.hidden = true;
  status.textContent = "已取消删除，记录没有改动。";
});

document.querySelector("#profileDeleteConfirm").addEventListener("click", async () => {
  const current = profileState.profiles.find((item) => item.id === profileState.activeId);
  profileDeleteOverlay.hidden = true;
  if (!current) return;
  try {
    profileState = await window.nightfall.deleteProfile(current.id);
    renderProfiles();
    render(await window.nightfall.getData());
    status.textContent = profileState.cleared
      ? `已清空「${current.name}」的记录（原记录在数据目录里留了一份备份）。`
      : `已删除「${current.name}」，记录文件在数据目录里保留了一份备份。`;
  } catch (error) {
    showFailure("删除失败", humanizeError(error), "");
  }
});

// 读取时发现指纹对不上：停下来问，别默默合并
let pendingConflict = null;
function showProfileConflict(conflict) {
  pendingConflict = conflict;
  const reason = document.querySelector("#conflictReason");
  const primary = document.querySelector("#conflictPrimary");
  if (conflict.verdict === "other") {
    reason.textContent = `这份记录看起来属于「${conflict.otherProfileName}」，而当前选中的是「${conflict.activeProfileName}」。`;
    primary.textContent = `切换到「${conflict.otherProfileName}」并读取`;
  } else {
    reason.textContent = `这份记录和「${conflict.activeProfileName}」里已有的对不上，像是另一个还没建过档案的账号。`;
    primary.textContent = "新建一个账号档案并读取";
  }
  conflictOverlay.hidden = false;
}

document.querySelector("#conflictCancel").addEventListener("click", () => {
  conflictOverlay.hidden = true;
  pendingConflict = null;
  status.textContent = "已取消，本地记录没有改动。";
});

document.querySelector("#conflictPrimary").addEventListener("click", async () => {
  const conflict = pendingConflict;
  conflictOverlay.hidden = true;
  pendingConflict = null;
  if (!conflict) return;
  try {
    profileState = conflict.verdict === "other"
      ? await window.nightfall.switchProfile(conflict.otherProfileId)
      : await window.nightfall.createProfile("");
    renderProfiles();
    await runFetch({ force: true });
  } catch (error) {
    showFailure("切换账号失败", humanizeError(error), "");
  }
});

document.querySelector("#conflictMerge").addEventListener("click", async () => {
  conflictOverlay.hidden = true;
  pendingConflict = null;
  await runFetch({ force: true });
});

const disclaimerOverlay = document.querySelector("#disclaimerOverlay");
document.querySelector("#disclaimerAccept").addEventListener("click", async () => {
  try {
    await window.nightfall.acceptDisclaimer();
  } catch {}
  disclaimerOverlay.hidden = true;
});

async function gateOnDisclaimer() {
  try {
    const accepted = await window.nightfall.getDisclaimerAccepted();
    disclaimerOverlay.hidden = Boolean(accepted);
  } catch {
    disclaimerOverlay.hidden = true;
  }
}


// 读取记录。冲突弹窗确认后会带 force 再调一次。
async function runFetch(options = {}) {
  captureButton.disabled = true;
  captureButton.textContent = "正在获取";
  captureTitle.textContent = "正在读取契约记录";
  status.textContent = "正在通过游戏当前连接读取…";
  try {
    const result = await window.nightfall.fetchHistory(options);
    if (result?.conflict) {
      showProfileConflict(result.conflict);
      status.textContent = "已暂停：请先确认这份记录属于哪个账号。";
      return;
    }
    render(result.store);
    await refreshProfiles();
    status.textContent = result.incremental
      ? `增量获取完成：新增 ${result.newCount} 条，本地共有 ${result.store.records.length} 条记录。`
      : `全量获取完成：本地共有 ${result.store.records.length} 条记录。`;
  } catch (error) {
    status.textContent = humanizeError(error);
  } finally {
    captureButton.disabled = false;
    captureButton.textContent = proxyConnected ? "获取全部记录" : "启动连接接管";
    captureTitle.textContent = proxyConnected ? "连接已接管" : "准备接管";
  }
}

void refreshProfiles();

void gateOnDisclaimer();

const whatsnewOverlay = document.querySelector("#whatsnewOverlay");
document.querySelector("#whatsnewAck").addEventListener("click", async () => {
  try {
    await window.nightfall.ackWhatsNew();
  } catch {}
  whatsnewOverlay.hidden = true;
});

async function showWhatsNewOnLaunch() {
  try {
    const result = await window.nightfall.getWhatsNew();
    if (!result.show) return;
    document.querySelector("#whatsnewTitle").textContent = `v${result.version} 更新内容`;
    document.querySelector("#whatsnewList").replaceChildren(
      ...result.notes.map((note) => {
        const item = document.createElement("li");
        item.textContent = note;
        return item;
      }),
    );
    whatsnewOverlay.hidden = false;
  } catch {
    // 更新说明弹不出来不影响使用。
  }
}

void showWhatsNewOnLaunch();

const failureOverlay = document.querySelector("#failureOverlay");
document.querySelector("#failureClose").addEventListener("click", () => {
  failureOverlay.hidden = true;
});

// 重要失败一律弹窗：状态栏那行小字用户在等待时几乎不会看，这是"更新失败没提示"同一课。
function showFailure(title, reason, hint) {
  document.querySelector("#failureTitle").textContent = title;
  document.querySelector("#failureReason").textContent = reason;
  const hintNode = document.querySelector("#failureHint");
  hintNode.textContent = hint ?? "";
  hintNode.hidden = !hint;
  failureOverlay.hidden = false;
  status.textContent = `${title}：${reason}`;
}

// IPC 抛出的错误在渲染进程侧会被套上 "Error invoking remote method 'x': Error: " 前缀，
// 直接显示给用户是技术噪音，剥掉只留真正的原因。
function humanizeError(error) {
  const raw = error?.message ?? String(error);
  return raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, "").trim() || "未知错误";
}

function showUpdateFailure(reason) {
  showFailure(
    "更新失败",
    reason,
    "当前版本没有被改动，可以照常使用。你可以稍后再点一次「更新版本」，或到 GitHub 仓库的 Releases 页面手动下载最新压缩包。",
  );
  updateButton.textContent = "更新版本";
}

updateButton.addEventListener("click", async () => {
  updateButton.disabled = true;
  try {
    if (!pendingUpdate?.available) {
      showUpdateFailure("没有取得可用的新版本信息，可能是启动时的检查没有完成。请重开工具后再试。");
      return;
    }
    updateButton.textContent = "正在更新…";
    status.textContent = `正在下载并校验 v${pendingUpdate.latestVersion}，完成后会自动重启…`;
    const result = await window.nightfall.installUpdate();
    // 正常路径下主进程会在几百毫秒后重启应用；没有进入安装状态就是失败。
    if (!result?.installing) {
      showUpdateFailure(
        result?.available === false
          ? "服务器上没有找到比当前更新的版本，可能新版本刚刚被撤下。"
          : "更新没有进入安装状态，请稍后重试。",
      );
    }
  } catch (error) {
    showUpdateFailure(humanizeError(error));
  } finally {
    updateButton.disabled = false;
  }
});

async function detectUpdateOnLaunch() {
  try {
    const result = await window.nightfall.checkForUpdates();
    if (!result.available) return;
    pendingUpdate = result;
    updateButton.title = `发现 v${result.latestVersion}`;
    updateButton.hidden = false;
  } catch {
    // 启动检查完全静默；网络问题不应打扰记录读取。
  }
}

void detectUpdateOnLaunch();

// 启动前体检：把已知会导致"接管不上"的环境问题挂成黄条；应用打开与接管启动后各查一次。
const preflightBox = document.querySelector("#preflightWarnings");
let preflightItems = [];
let toolElevated = null;
let proxyStartedAt = null;
let waitingHintOn = false;

function renderPreflight() {
  const items = waitingHintOn
    ? [...preflightItems, "接管已开启，但游戏的连接还没有进来：游戏不用重启——还没登录就直接登录，已经登录了就进一次「契约 → 抽卡记录」（已经在该界面则退出去再进一次）。"]
    : preflightItems;
  preflightBox.replaceChildren(
    ...items.map((text) => {
      const item = document.createElement("div");
      item.className = "preflight-warning";
      item.textContent = text;
      return item;
    }),
  );
  preflightBox.hidden = items.length === 0;
}

async function runPreflight() {
  try {
    const result = await window.nightfall.preflightCheck();
    preflightItems = result.warnings ?? [];
    if (typeof result.elevated === "boolean") toolElevated = result.elevated;
  } catch {
    preflightItems = [];
  }
  renderPreflight();
}

void runPreflight();

window.nightfall.getData().then(render).catch((error) => { status.textContent = error.message; });
setInterval(async () => {
  try {
    const next = await window.nightfall.getProxyStatus();
    if (next.connected !== proxyConnected) {
      proxyConnected = next.connected;
      captureButton.textContent = proxyConnected ? "获取全部记录" : "启动连接接管";
      captureTitle.textContent = proxyConnected ? "连接已接管" : "准备接管";
      if (proxyConnected) status.textContent = "已接管游戏连接，现在可以点「获取全部记录」了。";
    }
    const shouldHint = Boolean(
      next.started && !next.connected && proxyStartedAt && Date.now() - proxyStartedAt > 30000,
    );
    if (shouldHint !== waitingHintOn) {
      waitingHintOn = shouldHint;
      renderPreflight();
    }
    if (next.connected) proxyStartedAt = null;
  } catch {}
}, 1000);
