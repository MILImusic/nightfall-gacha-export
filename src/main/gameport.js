// 游戏通信端口的动态判定。
// 背景：12090 曾被当成固定值写死，但实测有玩家的客户端走 12085——端口会随
// 分区/版本变化，而游戏进程名是稳定的。因此改为：靠进程名找到游戏，再看它
// 实际连着哪个端口，把结果喂给接管程序（接管程序本来就接受端口参数）。
// 本文件只做判定，全部是纯函数，便于单测。

const DEFAULT_GAME_PORT = 12090;
// 登录页、公告、CDN 等附属连接走这些端口，不是游戏主连接。
const ANCILLARY_PORTS = new Set([80, 443, 8080, 8443]);

// entries 形如 ["ReignofNightfall|203.0.113.10:12085|Established"]。
// 返回候选端口，按"出现次数多的优先、其次端口号小的优先"排序（同一游戏可能
// 同时开着几条连接，主连接通常最稳定地重复出现）。
function candidatePorts(entries) {
  if (!Array.isArray(entries)) return [];
  const counts = new Map();
  for (const entry of entries) {
    const [, endpoint = ""] = String(entry).split("|");
    const port = Number.parseInt(endpoint.split(":").pop(), 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    if (ANCILLARY_PORTS.has(port)) continue;
    counts.set(port, (counts.get(port) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([port]) => port);
}

// 从当前游戏连接里探测主端口；探不到返回 null。
function detectGamePort(entries) {
  return candidatePorts(entries)[0] ?? null;
}

// 决定这次接管要守哪个端口，并说明理由（理由用于日志与界面提示）。
// 优先级：此刻探测到的 > 上次成功记住的 > 默认 12090。
function resolveGamePort({ detected = null, remembered = null, fallback = DEFAULT_GAME_PORT } = {}) {
  const valid = (port) => Number.isInteger(port) && port > 0 && port <= 65535;
  if (valid(detected)) {
    return { port: detected, source: "detected" };
  }
  if (valid(remembered)) {
    return { port: remembered, source: "remembered" };
  }
  return { port: valid(fallback) ? fallback : DEFAULT_GAME_PORT, source: "default" };
}

// 接管已经在守 activePort，但游戏此刻连的是别的端口——需要用新端口重启接管。
// 返回 null 表示不需要动作。
function portMismatch({ activePort, entries }) {
  const detected = detectGamePort(entries);
  if (!Number.isInteger(activePort) || detected === null) return null;
  if (detected === activePort) return null;
  return { activePort, detected };
}

module.exports = {
  ANCILLARY_PORTS,
  DEFAULT_GAME_PORT,
  candidatePorts,
  detectGamePort,
  portMismatch,
  resolveGamePort,
};
