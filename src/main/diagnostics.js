// 诊断信息收集：把排障时最常问的几件事一次性列成可复制的文本，
// 让用户把它贴给维护者即可定位，不用来回猜四五轮。
// formatDiagnostics 是纯函数，便于单测；collectDiagnostics 负责实际取数。

const FIREWALL_RULE_NAME = "夜幕之下抽卡记录导出";

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
    `内存完整性(HVCI)是否开启：${yesNo(data.memoryIntegrityOn)}${data.memoryIntegrityOn ? "（会拦截接管驱动，建议关闭后重启）" : ""}`,
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
  let memoryIntegrityOn = null;
  if (typeof runPowerShell === "function") {
    try {
      const out = await runPowerShell(
        `if (Get-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`,
      );
      firewallRulePresent = out.trim() === "yes";
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
    memoryIntegrityOn,
    notes,
    collectedAt,
  });
}

module.exports = { FIREWALL_RULE_NAME, collectDiagnostics, formatDiagnostics, listIpv4 };
