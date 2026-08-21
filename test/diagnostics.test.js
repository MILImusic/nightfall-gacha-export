const test = require("node:test");
const assert = require("node:assert/strict");
const {
  collectDiagnostics,
  collectDiagnosticsData,
  firewallCovers,
  formatDiagnostics,
  classifyDnsResidue,
  classifyGameState,
  isResidueDns,
  listIpv4,
  preflightWarnings,
} = require("../src/main/diagnostics");

test("classifyGameState 分辨游戏的四种状态", () => {
  // 游戏主连接走 12090，旁边的 443 是登录页/公告（示例地址取自文档保留段 RFC5737）
  assert.deepEqual(
    classifyGameState([
      "ReignofNightfall|203.0.113.10:12090|Established",
      "ReignofNightfall|203.0.113.20:443|Established",
    ]),
    { state: "connected", ports: [12090, 443] },
  );
  // 进程没跑
  assert.deepEqual(classifyGameState([]), { state: "absent", ports: [] });
  // 进程在但一条外部连接都没有
  assert.deepEqual(classifyGameState(["ReignofNightfall|-|-"]), { state: "idle", ports: [] });
  // 只连了登录页/CDN，主连接还没建立 → 仍算没连上
  assert.deepEqual(classifyGameState(["ReignofNightfall|203.0.113.30:443|Established"]), {
    state: "idle",
    ports: [443],
  });
  // 端口变了
  assert.deepEqual(classifyGameState(["ReignofNightfall|1.2.3.4:13000|Established"]), {
    state: "other",
    ports: [13000],
  });
  assert.equal(classifyGameState(null), null);
});

test("preflightWarnings 覆盖游戏状态：端口变了要报，没连上要催登录", () => {
  const other = preflightWarnings({ gameState: { state: "other", ports: [13000] } });
  assert.equal(other.length, 1);
  assert.match(other[0], /连的是 13000 端口，本工具当前接管的是 12090/);
  assert.match(other[0], /点一次「启动连接接管」即可自动切换/);
  // 接管已经适配到游戏正在用的端口时不再报警
  assert.deepEqual(
    preflightWarnings({ gameState: { state: "other", ports: [12085] }, activeGamePort: 12085 }),
    [],
  );
  // 接管守着自适应端口、游戏又换到第三个端口时仍要报，且提示里是当前接管端口
  const adapted = preflightWarnings({ gameState: { state: "other", ports: [13000] }, activeGamePort: 12085 });
  assert.equal(adapted.length, 1);
  assert.match(adapted[0], /本工具当前接管的是 12085/);
  const idle = preflightWarnings({ gameState: { state: "idle", ports: [] }, redirectorAlive: true });
  assert.equal(idle.length, 1);
  assert.match(idle[0], /还没有连上游戏服务器/);
  // 接管都没启动时不催登录（正常流程就是先接管后开游戏）
  assert.deepEqual(preflightWarnings({ gameState: { state: "idle", ports: [] }, redirectorAlive: false }), []);
  assert.deepEqual(preflightWarnings({ gameState: { state: "connected", ports: [12090] } }), []);
  assert.deepEqual(preflightWarnings({ gameState: { state: "absent", ports: [] }, redirectorAlive: true }), []);
});

test("isResidueDns 识别回环与 fake-ip 段，放过正常 DNS", () => {
  assert.equal(isResidueDns("127.0.0.1"), true);
  assert.equal(isResidueDns("198.18.0.2"), true);
  assert.equal(isResidueDns("198.19.255.1"), true);
  assert.equal(isResidueDns("223.5.5.5"), false);
  assert.equal(isResidueDns("192.168.1.1"), false);
  assert.equal(isResidueDns("198.180.0.1"), false);
});

test("classifyDnsResidue 区分代理虚拟网卡与被改DNS的物理网卡（真实环境的常见形态）", () => {
  // 常见形态：代理的 TUN 网卡拿 fake-ip 段、tap 网卡拿私有段，物理网卡 DNS 正常
  const result = classifyDnsResidue([
    "Meta:198.18.0.2",
    "cfw-tap:10.0.0.1",
    "以太网:192.168.1.1",
    "WLAN:192.168.1.1,192.168.1.1",
  ]);
  assert.deepEqual(result, { virtual: ["Meta:198.18.0.2"], physical: [] });
  // 代理退了但物理网卡 DNS 没恢复
  assert.deepEqual(classifyDnsResidue(["WLAN:198.18.0.2,223.5.5.5", "vEthernet:127.0.0.1"]), {
    virtual: [],
    physical: ["WLAN:198.18.0.2,223.5.5.5", "vEthernet:127.0.0.1"],
  });
  assert.deepEqual(classifyDnsResidue(["WLAN:223.5.5.5"]), { virtual: [], physical: [] });
  assert.equal(classifyDnsResidue(null), null);
});

test("preflightWarnings DNS 两类残留话术不同，未知不误报", () => {
  const virtual = preflightWarnings({ dnsEntries: ["Meta:198.18.0.2"] });
  assert.equal(virtual.length, 1);
  assert.match(virtual[0], /虚拟网卡仍在活动（Meta:198\.18\.0\.2）/);
  assert.match(virtual[0], /彻底退出代理与加速器/);
  const physical = preflightWarnings({ dnsEntries: ["WLAN:198.18.0.2"] });
  assert.equal(physical.length, 1);
  assert.match(physical[0], /DNS 还指向已退出的代理\/加速器（WLAN:198\.18\.0\.2）/);
  assert.match(physical[0], /自动获得/);
  assert.deepEqual(preflightWarnings({ dnsEntries: null }), []);
  assert.deepEqual(preflightWarnings({ dnsEntries: ["WLAN:223.5.5.5"] }), []);
});

test("preflightWarnings 按严重程度列出命中的环境问题", () => {
  const warnings = preflightWarnings({
    memoryIntegrityOn: true,
    firewallCoversNetwork: false,
    firewallProfiles: "Private",
    networkCategories: "Public",
    systemProxyOn: true,
    systemProxyServer: "127.0.0.1:7897",
    firewallRulePresent: true,
  });
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /内存完整性\(HVCI\)/);
  assert.match(warnings[1], /规则放行：Private；当前网络：Public/);
  assert.match(warnings[2], /127\.0\.0\.1:7897/);
});

test("preflightWarnings 规则缺失给首弹勾选引导，环境干净时为空", () => {
  const missing = preflightWarnings({ firewallRulePresent: false });
  assert.equal(missing.length, 1);
  assert.match(missing[0], /“专用网络”和“公用网络”两项都勾上/);
  assert.deepEqual(
    preflightWarnings({
      memoryIntegrityOn: false,
      firewallCoversNetwork: true,
      systemProxyOn: false,
      firewallRulePresent: true,
    }),
    [],
  );
  // 全未知（如查询失败）不误报
  assert.deepEqual(preflightWarnings({}), []);
});

test("collectDiagnosticsData 返回结构化数据供体检复用", async () => {
  const data = await collectDiagnosticsData({
    version: "0.1.3",
    interfaces: {},
    selectAddress: () => "192.168.1.5",
    redirectorAlive: true,
    proxyConnected: false,
    runPowerShell: async (script) => (script.includes("Internet Settings") ? "1|127.0.0.1:7897" : ""),
    collectedAt: "2026-08-21T12:30:00.000Z",
  });
  assert.equal(data.systemProxyOn, true);
  assert.equal(data.systemProxyServer, "127.0.0.1:7897");
  assert.equal(preflightWarnings(data).length >= 1, true);
});

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

test("firewallCovers 兼容真机形态：弹窗生成的多条单 Profile 规则 + 多网卡多类别", () => {
  // 防火墙弹窗生成的是多条单 Profile 规则（TCP/UDP × 专用/公用），多网卡机器会报多个网络类别
  assert.equal(firewallCovers("Private;Private;Public;Public", "Private;Private;Public;Private"), true);
  // 弹窗只勾了"家用/专用"而当前有网卡被判公用（广东用户案）
  assert.equal(firewallCovers("Private;Private", "Private;Public"), false);
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
    if (script.includes("Get-Process")) return "ReignofNightfall|203.0.113.10:12090|Established\r\n";
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
  assert.equal(calls.length, 6);
  assert.match(text, /游戏进程与其连接：ReignofNightfall\|203\.0\.113\.10:12090\|Established/);
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
