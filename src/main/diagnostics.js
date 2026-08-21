// 诊断信息收集：把排障时最常问的几件事一次性列成可复制的文本，
// 让用户把它贴给维护者即可定位，不用来回猜四五轮。
// formatDiagnostics 是纯函数，便于单测；collectDiagnostics 负责实际取数。

const FIREWALL_RULE_NAME = "夜幕之下抽卡记录导出";
const GAME_PORT = 12090;

// 规则 Profile（如 "Private, Public" / "Any"）是否覆盖当前网络类别（如 "Public"）。
// 任一参数缺失返回 null=未知。
function firewallCovers(profiles, categories) {
  if (!profiles || !categories) return null;
  const categoryToProfile = { Public: "Public", Private: "Private", DomainAuthenticated: "Domain" };
  const ruleProfiles = profiles.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
  const current = categories.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
  if (!ruleProfiles.length || !current.length) return null;
  if (ruleProfiles.includes("Any")) return true;
  return current.every((category) => ruleProfiles.includes(categoryToProfile[category] ?? category));
}

function formatDiagnostics(data) {
  const yesNo = (value) => (value === true ? "是" : value === false ? "否" : "未知");
  const lines = [
    "=== 夜幕之下抽卡记录导出 · 诊断信息 ===",
    `软件版本：${data.version ?? "未知"}`,
    `系统：${data.osVersion ?? "未知"}（${data.osRelease ?? "?"}）`,
    `选中的本机网卡地址：${data.proxyAddress ?? "（未能选出——可能没有可用局域网地址）"}`,
    "本机 IPv4 网卡：",
    ...(data.interfaces?.length
      ? data.interfaces.map((item) => `  · ${item.name}: ${item.address}`)
      : ["  （无）"]),
    `连接接管驱动是否在运行：${yesNo(data.redirectorAlive)}`,
    `是否已接管游戏连接：${yesNo(data.proxyConnected)}`,
    `防火墙放行规则是否存在：${yesNo(data.firewallRulePresent)}`,
    `防火墙规则是否覆盖当前网络：${yesNo(data.firewallCoversNetwork)}${
      data.firewallCoversNetwork === false
        ? `（规则放行：${data.firewallProfiles}；当前网络：${data.networkCategories}——把规则的"公用"也勾上，或把当前网络改成"专用"）`
        : data.networkCategories
          ? `（当前网络：${data.networkCategories}）`
          : ""
    }`,
    `内存完整性(HVCI)是否开启：${yesNo(data.memoryIntegrityOn)}${data.memoryIntegrityOn ? "（会拦截接管驱动，建议关闭后重启）" : ""}`,
    `系统代理是否开启：${yesNo(data.systemProxyOn)}${data.systemProxyOn ? `（${data.systemProxyServer || "地址未知"}——说明有代理/加速器类软件在运行，可能抢走游戏流量）` : ""}`,
    `游戏端口(${GAME_PORT})的 TCP 连接：${
      data.gamePortConnections == null
        ? "未知"
        : data.gamePortConnections.length
          ? `${data.gamePortConnections.length} 条（${data.gamePortConnections.join("；")}）${data.proxyConnected === false ? "——有连接但未经过本工具，流量被其他软件截走或接管未生效" : ""}`
          : `无${data.redirectorAlive ? "——游戏还没有建立连接，请在接管开启的状态下重新登录游戏" : ""}`
    }`,
  ];
  if (data.notes?.length) {
    lines.push("备注：", ...data.notes.map((note) => `  · ${note}`));
  }
  lines.push(`采集时间：${data.collectedAt ?? "未知"}`);
  return lines.join("\n");
}

function listIpv4(interfaces) {
  const result = [];
  for (const [name, entries] of Object.entries(interfaces ?? {})) {
    for (const entry of entries ?? []) {
      if (entry && entry.family === "IPv4" && !entry.internal) {
        result.push({ name, address: entry.address });
      }
    }
  }
  return result;
}

// runPowerShell(command): Promise<string> —— 由调用方注入，测试时可替身。
async function collectDiagnostics({
  version,
  osVersion,
  osRelease,
  interfaces,
  selectAddress,
  redirectorAlive,
  proxyConnected,
  runPowerShell,
  collectedAt,
}) {
  const notes = [];
  let proxyAddress = null;
  try {
    proxyAddress = selectAddress();
  } catch (error) {
    notes.push(`选取网卡地址失败：${error.message}`);
  }

  let firewallRulePresent = null;
  let firewallProfiles = null;
  let networkCategories = null;
  let memoryIntegrityOn = null;
  let systemProxyOn = null;
  let systemProxyServer = null;
  let gamePortConnections = null;
  if (typeof runPowerShell === "function") {
    try {
      const out = await runPowerShell(
        `$r = Get-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue; ` +
          "$p = ($r | ForEach-Object { \"$($_.Profile)\" }) -join ';'; " +
          "$c = (Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.NetworkCategory)\" }) -join ';'; " +
          '"$p|$c"',
      );
      const [profilesPart, categoriesPart = ""] = out.trim().split("|");
      firewallRulePresent = profilesPart.trim() !== "";
      firewallProfiles = profilesPart.trim() || null;
      networkCategories = categoriesPart.trim() || null;
    } catch (error) {
      notes.push(`查询防火墙规则失败：${error.message}`);
    }
    try {
      const out = await runPowerShell(
        "(Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity' -Name Enabled -ErrorAction SilentlyContinue).Enabled",
      );
      const value = out.trim();
      if (value === "1") memoryIntegrityOn = true;
      else if (value === "0" || value === "") memoryIntegrityOn = false;
    } catch (error) {
      notes.push(`查询内存完整性失败：${error.message}`);
    }
    try {
      const out = await runPowerShell(
        "$p = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue; \"$($p.ProxyEnable)|$($p.ProxyServer)\"",
      );
      const [enable, ...serverParts] = out.trim().split("|");
      if (enable === "1") {
        systemProxyOn = true;
        systemProxyServer = serverParts.join("|").trim() || null;
      } else if (enable === "0" || enable === "") {
        systemProxyOn = false;
      }
    } catch (error) {
      notes.push(`查询系统代理失败：${error.message}`);
    }
    try {
      const out = await runPowerShell(
        `$c = Get-NetTCPConnection -RemotePort ${GAME_PORT} -ErrorAction SilentlyContinue; ` +
          "($c | ForEach-Object { \"$($_.State) -> $($_.RemoteAddress)\" }) -join ';'",
      );
      gamePortConnections = out.trim() ? out.trim().split(";").map((item) => item.trim()).filter(Boolean) : [];
    } catch (error) {
      notes.push(`查询游戏端口连接失败：${error.message}`);
    }
  }

  return formatDiagnostics({
    version,
    osVersion,
    osRelease,
    proxyAddress,
    interfaces: listIpv4(interfaces),
    redirectorAlive,
    proxyConnected,
    firewallRulePresent,
    firewallProfiles,
    networkCategories,
    firewallCoversNetwork: firewallCovers(firewallProfiles, networkCategories),
    memoryIntegrityOn,
    systemProxyOn,
    systemProxyServer,
    gamePortConnections,
    notes,
    collectedAt,
  });
}

module.exports = { FIREWALL_RULE_NAME, GAME_PORT, collectDiagnostics, firewallCovers, formatDiagnostics, listIpv4 };
