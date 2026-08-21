const test = require("node:test");
const assert = require("node:assert/strict");
const { collectDiagnostics, firewallCovers, formatDiagnostics, listIpv4 } = require("../src/main/diagnostics");

test("listIpv4 只取非内部 IPv4", () => {
  const result = listIpv4({
    lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    eth: [
      { family: "IPv4", address: "192.168.1.5", internal: false },
      { family: "IPv6", address: "fe80::1", internal: false },
    ],
    vmware: [{ family: "IPv4", address: "192.168.140.1", internal: false }],
  });
  assert.deepEqual(result, [
    { name: "eth", address: "192.168.1.5" },
    { name: "vmware", address: "192.168.140.1" },
  ]);
});

test("formatDiagnostics 三态是/否/未知都能渲染", () => {
  const text = formatDiagnostics({
    version: "0.1.3",
    osVersion: "Windows 11 Pro",
    osRelease: "10.0.22631",
    proxyAddress: "192.168.1.5",
    interfaces: [{ name: "eth", address: "192.168.1.5" }],
    redirectorAlive: true,
    proxyConnected: false,
    firewallRulePresent: null,
    memoryIntegrityOn: true,
    notes: ["示例备注"],
    collectedAt: "2026-08-21T12:30:00.000Z",
  });
  assert.match(text, /软件版本：0\.1\.3/);
  assert.match(text, /连接接管驱动是否在运行：是/);
  assert.match(text, /是否已接管游戏连接：否/);
  assert.match(text, /防火墙放行规则是否存在：未知/);
  assert.match(text, /内存完整性\(HVCI\)是否开启：是（会拦截接管驱动/);
  assert.match(text, /· 示例备注/);
  assert.match(text, /· eth: 192\.168\.1\.5/);
});

test("formatDiagnostics 没选出地址时给出说明", () => {
  const text = formatDiagnostics({ version: "0.1.3", proxyAddress: null, interfaces: [] });
  assert.match(text, /未能选出/);
  assert.match(text, /本机 IPv4 网卡：\n {2}（无）/);
});

test("firewallCovers 判定规则 Profile 与当前网络类别", () => {
  assert.equal(firewallCovers("Any", "Public"), true);
  assert.equal(firewallCovers("Private", "Public"), false);
  assert.equal(firewallCovers("Private, Public", "Public"), true);
  assert.equal(firewallCovers("Private", "Private;Public"), false);
  assert.equal(firewallCovers("Domain", "DomainAuthenticated"), true);
  assert.equal(firewallCovers(null, "Public"), null);
  assert.equal(firewallCovers("Private", null), null);
});

test("formatDiagnostics 防火墙不覆盖当前网络时给出修法", () => {
  const text = formatDiagnostics({
    version: "0.1.3",
    firewallRulePresent: true,
    firewallCoversNetwork: false,
    firewallProfiles: "Private",
    networkCategories: "Public",
  });
  assert.match(text, /防火墙规则是否覆盖当前网络：否（规则放行：Private；当前网络：Public——把规则的"公用"也勾上/);
});

test("formatDiagnostics 游戏端口连接三态", () => {
  const withConnections = formatDiagnostics({
    version: "0.1.3",
    proxyConnected: false,
    gamePortConnections: ["Established -> 203.0.113.5"],
  });
  assert.match(withConnections, /游戏端口\(12090\)的 TCP 连接：1 条（Established -> 203\.0\.113\.5）——有连接但未经过本工具/);
  const noConnections = formatDiagnostics({ version: "0.1.3", redirectorAlive: true, gamePortConnections: [] });
  assert.match(noConnections, /游戏端口\(12090\)的 TCP 连接：无——游戏还没有建立连接/);
  const unknown = formatDiagnostics({ version: "0.1.3", gamePortConnections: null });
  assert.match(unknown, /游戏端口\(12090\)的 TCP 连接：未知/);
});

test("collectDiagnostics 解析防火墙、HVCI 与系统代理的 PowerShell 输出", async () => {
  const calls = [];
  const runPowerShell = async (script) => {
    calls.push(script);
    if (script.includes("Get-NetFirewallRule")) return "Private, Public|Private\r\n";
    if (script.includes("HypervisorEnforcedCodeIntegrity")) return "1\r\n";
    if (script.includes("Internet Settings")) return "1|127.0.0.1:7897\r\n";
    if (script.includes("Get-NetTCPConnection")) return "Established -> 203.0.113.5\r\n";
    return "";
  };
  const text = await collectDiagnostics({
    version: "0.1.3",
    osVersion: "Windows 11",
    osRelease: "10.0.22631",
    interfaces: { eth: [{ family: "IPv4", address: "192.168.1.5", internal: false }] },
    selectAddress: () => "192.168.1.5",
    redirectorAlive: false,
    proxyConnected: false,
    runPowerShell,
    collectedAt: "2026-08-21T12:30:00.000Z",
  });
  assert.equal(calls.length, 4);
  assert.match(text, /防火墙放行规则是否存在：是/);
  assert.match(text, /防火墙规则是否覆盖当前网络：是（当前网络：Private）/);
  assert.match(text, /内存完整性\(HVCI\)是否开启：是/);
  assert.match(text, /系统代理是否开启：是（127\.0\.0\.1:7897——说明有代理\/加速器类软件在运行/);
  assert.match(text, /游戏端口\(12090\)的 TCP 连接：1 条/);
});

test("collectDiagnostics 防火墙规则缺失时报否且覆盖未知", async () => {
  const runPowerShell = async (script) => {
    if (script.includes("Get-NetFirewallRule")) return "|Public\r\n";
    return "";
  };
  const text = await collectDiagnostics({
    version: "0.1.3",
    interfaces: {},
    selectAddress: () => "192.168.1.5",
    redirectorAlive: true,
    proxyConnected: false,
    runPowerShell,
    collectedAt: "2026-08-21T12:30:00.000Z",
  });
  assert.match(text, /防火墙放行规则是否存在：否/);
  assert.match(text, /防火墙规则是否覆盖当前网络：未知（当前网络：Public）/);
});

test("collectDiagnostics 系统代理关闭时报否", async () => {
  const runPowerShell = async (script) => {
    if (script.includes("Internet Settings")) return "0|\r\n";
    return "";
  };
  const text = await collectDiagnostics({
    version: "0.1.3",
    interfaces: {},
    selectAddress: () => "192.168.1.5",
    redirectorAlive: true,
    proxyConnected: false,
    runPowerShell,
    collectedAt: "2026-08-21T12:30:00.000Z",
  });
  assert.match(text, /系统代理是否开启：否/);
});

test("collectDiagnostics 选址异常记入备注而不抛出", async () => {
  const text = await collectDiagnostics({
    version: "0.1.3",
    interfaces: {},
    selectAddress: () => { throw new Error("没有找到可用于连接接管的本机 IPv4 地址"); },
    redirectorAlive: false,
    proxyConnected: false,
    runPowerShell: null,
    collectedAt: "2026-08-21T12:30:00.000Z",
  });
  assert.match(text, /选取网卡地址失败：没有找到/);
});

test("collectDiagnostics 无 runPowerShell 时防火墙/HVCI 保持未知", async () => {
  const text = await collectDiagnostics({
    version: "0.1.3",
    interfaces: {},
    selectAddress: () => "192.168.1.5",
    redirectorAlive: true,
    proxyConnected: true,
    runPowerShell: null,
    collectedAt: "2026-08-21T12:30:00.000Z",
  });
  assert.match(text, /防火墙放行规则是否存在：未知/);
  assert.match(text, /防火墙规则是否覆盖当前网络：未知/);
  assert.match(text, /内存完整性\(HVCI\)是否开启：未知/);
  assert.match(text, /系统代理是否开启：未知/);
  assert.match(text, /游戏端口\(12090\)的 TCP 连接：未知/);
});
