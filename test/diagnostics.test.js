const test = require("node:test");
const assert = require("node:assert/strict");
const { collectDiagnostics, formatDiagnostics, listIpv4 } = require("../src/main/diagnostics");

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

test("collectDiagnostics 解析防火墙、HVCI 与系统代理的 PowerShell 输出", async () => {
  const calls = [];
  const runPowerShell = async (script) => {
    calls.push(script);
    if (script.includes("Get-NetFirewallRule")) return "yes\r\n";
    if (script.includes("HypervisorEnforcedCodeIntegrity")) return "1\r\n";
    if (script.includes("Internet Settings")) return "1|127.0.0.1:7897\r\n";
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
  assert.equal(calls.length, 3);
  assert.match(text, /防火墙放行规则是否存在：是/);
  assert.match(text, /内存完整性\(HVCI\)是否开启：是/);
  assert.match(text, /系统代理是否开启：是（127\.0\.0\.1:7897——说明有代理\/加速器类软件在运行/);
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
  assert.match(text, /内存完整性\(HVCI\)是否开启：未知/);
  assert.match(text, /系统代理是否开启：未知/);
});
