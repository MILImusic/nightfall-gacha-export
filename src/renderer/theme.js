// 主题切换：浅色 / 夜间。与 app.js 独立，挂在 index.html 末尾。
const root = document.documentElement;
const toggle = document.querySelector("#themeToggle");
const saved = localStorage.getItem("nightfall.theme");
if (saved === "dark" || saved === "light") root.dataset.theme = saved;

function syncLabel() {
  toggle.textContent = root.dataset.theme === "dark" ? "浅色" : "夜间";
}
syncLabel();

toggle.addEventListener("click", () => {
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("nightfall.theme", root.dataset.theme);
  syncLabel();
});

// 接管状态点：app.js 改写 #captureTitle 时同步高亮。
const captureTitle = document.querySelector("#captureTitle");
const dot = document.querySelector(".status-dot");
new MutationObserver(() => {
  dot.classList.toggle("live", captureTitle.textContent.includes("已接管"));
}).observe(captureTitle, { childList: true, characterData: true, subtree: true });
