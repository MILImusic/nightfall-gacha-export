// 每个版本的"更新内容"文案与"更新后是否弹窗"的判定。
// 文案面向玩家：说人话，不写内部实现名。
// decideWhatsNew 是纯函数：依据上次记录的版本与免责声明是否已接受过，判定本次启动的动作。

const CHANGELOG = {
  "0.1.4": [
    "启动时自动体检：检测到系统代理/加速器、防火墙没放行当前网络、内存完整性(HVCI)开启等会导致接管失败的问题时，界面会直接给出黄色提示和解决办法，不用再去猜。",
    "接管开启后 30 秒内游戏还没连上来时，会提示你重新登录游戏（先接管、后登录）。",
    "新增「修复网络残留」按钮：一键关闭代理/加速器退出后残留的系统代理并清空 DNS 缓存；若检测到 DNS 仍指向已退出的加速器，会提示你改回“自动获得”（不会替你改，避免误伤自己配的 DNS）。",
    "「复制诊断信息」新增四项：系统代理开关、防火墙规则是否覆盖当前网络、各网卡 DNS、游戏端口连接状态，远程排障一次定位。",
    "更新到新版本后会像这样自动展示更新内容。",
  ],
};

function notesFor(version) {
  return CHANGELOG[version] ?? [];
}

// prevVersion: whatsnew.json 里记录的上次运行版本（无文件为 null）
// disclaimerAccepted: 免责声明是否接受过（v0.1.3 起的老用户标志）
// 返回 "show"（弹更新内容）| "record"（静默记录当前版本）| "none"（无事可做）
function decideWhatsNew({ prevVersion, disclaimerAccepted, currentVersion }) {
  if (prevVersion === currentVersion) return "none";
  if (prevVersion == null && !disclaimerAccepted) return "record"; // 全新安装：只看免责声明，不叠加弹窗
  if (!notesFor(currentVersion).length) return "record"; // 本版没写文案就别弹空窗
  return "show";
}

module.exports = { CHANGELOG, decideWhatsNew, notesFor };
