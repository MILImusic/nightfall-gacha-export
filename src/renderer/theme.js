// 主题切换：浅色 / 夜间。独立作用域避免与 app.js 的顶层 const 冲突。
(() => {
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
    // 同时告诉主进程：下次开窗要用对应的底色，否则冷启动会闪一下反色
    window.nightfall?.saveTheme?.(root.dataset.theme);
    syncLabel();
  });

  // 接管状态点：app.js 改写 #captureTitle 时同步高亮。
  const captureTitle = document.querySelector("#captureTitle");
  const dot = document.querySelector(".status-dot");
  new MutationObserver(() => {
    dot.classList.toggle("live", captureTitle.textContent.includes("已接管"));
  }).observe(captureTitle, { childList: true, characterData: true, subtree: true });
})();
