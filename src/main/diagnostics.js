// 诊断信息收集：把排障时最常问的几件事一次性列成可复制的文本，
// 让用户把它贴给维护者即可定位，不用来回猜四五轮。
// formatDiagnostics 是纯函数，便于单测；collectDiagnostics 负责实际取数。

const FIREWALL_RULE_NAME = "夜幕之下抽卡记录导出";
const GAME_PORT = 12090;
// 游戏主进程名，模糊匹配以兼容改名或别的发行版本。
// 游戏内嵌的浏览器插件进程走 443，不是主连接，因此按端口而非进程数判断状态。
const GAME_PROCESS_HINT = /nightfall|yemu|yemuzhixia/i;

// 加速器/代理残留 DNS 的特征：本机回环或基准测试保留段（Clash/加速器 fake-ip 常用 198.18/15）。
function isResidueDns(address) {
  return /^127\.|^198\.1[89]\./.test(address);
}

// 代理/VPN 类虚拟网卡的命名特征（Clash Meta/mihomo、cfw-tap、各类 TUN/TAP/VPN）。
const VIRTUAL_ADAPTER_HINT = /clash|meta|mihomo|sing|cfw|tun|tap|wireguard|openvpn|vpn/i;

// entries 形如 ["WLAN:198.18.0.2,223.5.5.5", "以太网:192.168.1.1"]。
// 把含残留特征地址的网卡分成两类：virtual=代理自己的虚拟网卡（说明代理还在运行），
// physical=物理网卡被改了 DNS（代理退了但没恢复）。两类的修法完全不同。
// 入参为 null（未知）时返回 null。
function classifyDnsResidue(entries) {
  if (entries == null) return null;
  const virtual = [];
  const physical = [];
  for (const entry of entries) {
    const alias = entry.split(":")[0];
    const servers = entry.split(":").slice(1).join(":");
    if (!servers.split(",").some((address) => isResidueDns(address.trim()))) continue;
    (VIRTUAL_ADAPTER_HINT.test(alias) ? virtual : physical).push(entry);
  }
  return { virtual, physical };
}

// entries 形如 ["ReignofNightfall|203.0.113.10:12090|Established", ...]（游戏进程的外部连接）。
// 判定游戏此刻处在哪一档：null=未知 / absent=进程没跑 / idle=进程在但没连服务器 /
// connected=连着 12090（正常）/ other=连着别的端口（端口变了或换了发行版本）。
function classifyGameState(entries) {
  if (entries == null) return null;
  if (!entries.length) return { state: "absent", ports: [] };
  const ports = [];
  for (const entry of entries) {
    const [, endpoint = ""] = entry.split("|");
    const port = Number.parseInt(endpoint.split(":").pop(), 10);
    if (Number.isInteger(port) && !ports.includes(port)) ports.push(port);
  }
  if (!ports.length) return { state: "idle", ports: [] };
  if (ports.includes(GAME_PORT)) return { state: "connected", ports };
  // 443/80 是登录页、公告、CDN 这类附属连接，只有它们说明主连接还没建立。
  const meaningful = ports.filter((port) => port !== 443 && port !== 80);
  return meaningful.length ? { state: "other", ports: meaningful } : { state: "idle", ports };
}

// profileStates 形如 "Domain=True,Private=True,Public=False"；categories 形如 "Private;Public"。
// 判断"当前所在网络的防火墙是否还开着"：全部相关 profile 都关掉时返回 false——
// 此时根本不需要放行规则，再提示"规则不存在"就是误导用户做无用功。
function firewallActiveForNetwork(profileStates, categories) {
  if (!profileStates || !categories) return null;
  const states = new Map();
  for (const pair of profileStates.split(",")) {
    const [name, value] = pair.split("=").map((item) => item?.trim());
    if (name) states.set(name, String(value).toLowerCase() === "true");
  }
  const categoryToProfile = { Public: "Public", Private: "Private", DomainAuthenticated: "Domain" };
  const current = categories.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
  if (!states.size || !current.length) return null;
  const relevant = current.map((category) => states.get(categoryToProfile[category] ?? category));
  if (relevant.every((value) => value === undefined)) return null;
  return relevant.some((value) => value === true);
}

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

// 上一次抓取的收据。断在第几页、错误码是多少、断的那一页 requestId 是多少——
// requestId 是单字节（255 之后绕回 0），"每次都在 190 多页断"最像的解释就是它绕了回去。
// 这一段是把假设变成证据的唯一途径，所以宁可诊断文本长一点，也要把断点那几页原样带出来。
function formatLastCapture(capture) {
  if (!capture) return ["上一次读取记录：（还没有成功读取过）"];
  const lines = [
    `上一次读取记录：${capture.capturedAt ?? "时间未知"}`,
    `  · 结果：${capture.complete ? "完整" : "中途中断（这份记录不完整）"}`,
    `  · 取得/服务器总数：${capture.imported ?? "?"}/${capture.expectedTotal ?? "?"}，共 ${capture.pageCount ?? "?"} 页`,
  ];
  if (capture.resumedFromPage) lines.push(`  · 本次是续抓：从第 ${capture.resumedFromPage + 1} 页接着抓`);
  const stop = capture.interrupted;
  if (stop) {
    lines.push(`  · 断点：第 ${stop.page} 页（offset ${stop.offset}），原因 ${stop.reason}`);
    lines.push(`  · 断点详情：${stop.message ?? "（无）"}`);
    if (stop.requestId != null) lines.push(`  · 断点 requestId=${stop.requestId}，sequence=${stop.sequence}`);
    if (stop.returnedOffset != null) lines.push(`  · 服务器返回的 offset：${stop.returnedOffset}`);
  }
  if (capture.trace?.length) {
    lines.push("  · 最后几页的请求轨迹（页/offset/requestId/错误码/条数/重试）：");
    for (const item of capture.trace.slice(-8)) {
      lines.push(`      ${item.page}/${item.offset}/${item.requestId ?? "-"}/${item.errorCode ?? "-"}/${item.records ?? "-"}/${item.retries ?? 0}${item.failed ? ` 失败：${item.failed}` : ""}`);
    }
  }
  return lines;
}

// 探针状态：{ state: "ok" | "timeout" | "missing" | "failed", detail }；null=没跑过（非 Windows 或尚未采集）。
// 下面那些「未知」十有八九都是它没跑起来，所以要单独说清楚，而不是让用户对着一排未知猜。
function powerShellProbeBroken(probe) {
  return Boolean(probe && probe.state && probe.state !== "ok");
}

function formatPowerShellProbe(probe) {
  if (!probe || !probe.state) return "未知";
  if (probe.state === "ok") return "正常";
  if (probe.state === "timeout") return `超时（${probe.detail ?? "未返回"}）——所有依赖它的检测项都会显示未知`;
  if (probe.state === "missing") return "未找到 powershell.exe——所有依赖它的检测项都会显示未知";
  return `运行失败（${probe.detail ?? "原因不明"}）——多半被安全软件拦截，所有依赖它的检测项都会显示未知`;
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
    `检测程序(PowerShell)是否正常：${formatPowerShellProbe(data.powerShellProbe)}`,
    `当前网络的防火墙是否开启：${yesNo(data.firewallEnabled)}${data.firewallEnabled === false ? "（已关闭，无需放行规则）" : ""}`,
    `防火墙放行规则是否存在：${yesNo(data.firewallRulePresent)}${data.firewallRulePresent === false && data.firewallEnabled === false ? "（防火墙已关闭，不影响使用）" : ""}`,
    `防火墙规则是否覆盖当前网络：${yesNo(data.firewallCoversNetwork)}${
      data.firewallCoversNetwork === false
        ? `（规则放行：${data.firewallProfiles}；当前网络：${data.networkCategories}——把规则的"公用"也勾上，或把当前网络改成"专用"）`
        : data.networkCategories
          ? `（当前网络：${data.networkCategories}）`
          : ""
    }`,
    `内存完整性(HVCI)是否开启：${yesNo(data.memoryIntegrityOn)}${data.memoryIntegrityOn ? "（会拦截接管驱动，建议关闭后重启）" : ""}`,
    `系统代理是否开启：${yesNo(data.systemProxyOn)}${data.systemProxyOn ? `（${data.systemProxyServer || "地址未知"}——说明有代理/加速器类软件在运行，可能抢走游戏流量）` : ""}`,
    `各网卡 DNS：${
      data.dnsEntries == null ? "未知" : data.dnsEntries.length ? data.dnsEntries.join("；") : "（无）"
    }`,
    `游戏进程与其连接：${
      data.gameConnections == null
        ? "未知"
        : data.gameConnections.length
          ? data.gameConnections.join("；")
          : "（没有找到游戏进程——游戏还没启动）"
    }`,
    `系统 UAC 是否开启：${yesNo(data.uacEnabled)}${data.uacEnabled === false ? "（已关闭：程序默认即拥有管理员权限，旧版本在此环境下请求提权可能卡住）" : ""}`,
    `本工具是否以管理员身份运行：${yesNo(data.elevated)}${data.elevated === false ? "（未提权，启动接管时需要通过 UAC 授权弹窗）" : ""}`,
    `记住的游戏端口：${
      data.rememberedPort == null
        ? "（无记录，将按探测结果或默认值）"
        : data.rememberedPort === "unreadable"
          ? "读取失败——端口记忆文件损坏，已按默认值继续（不影响使用）"
          : data.rememberedPort
    }`,
    `本工具接管的端口：${data.activeGamePort ?? GAME_PORT}${data.activeGamePort && data.activeGamePort !== GAME_PORT ? "（已自动适配，非默认值）" : ""}`,
    `游戏端口(${GAME_PORT})的 TCP 连接：${
      data.gamePortConnections == null
        ? "未知"
        : data.gamePortConnections.length
          ? `${data.gamePortConnections.length} 条（${data.gamePortConnections.join("；")}）${data.proxyConnected === false ? "——有连接但未经过本工具，流量被其他软件截走或接管未生效" : ""}`
          : `无${data.redirectorAlive ? "——游戏还没有建立连接，请在接管开启的状态下进入一次游戏里的「契约 → 抽卡记录」界面" : ""}`
    }`,
  ];
  lines.push(...formatLastCapture(data.lastCapture));
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

// 启动前体检：把会导致"接管不上"的已知环境问题翻成人话，给界面挂黄条用。
// 顺序即严重程度：HVCI 直接拦驱动 > 防火墙不覆盖 > 系统代理抢流量 > 规则还没建。
function preflightWarnings(data) {
  const warnings = [];
  if (powerShellProbeBroken(data.powerShellProbe)) {
    warnings.push(
      `本工具的检测程序（PowerShell）没能运行（${formatPowerShellProbe(data.powerShellProbe).split("——")[0]}），防火墙、游戏端口、DNS 等都无法检测：` +
        "请检查 360、电脑管家、火绒之类的安全软件是否拦截了 PowerShell，暂时退出后重开工具；若游戏用的不是默认端口，接管也会因探测不到而失败。",
    );
  }
  if (data.memoryIntegrityOn) {
    warnings.push(
      "系统「内存完整性(HVCI)」开启中，会拦截接管驱动：到「Windows 安全中心 → 设备安全性 → 内核隔离」关闭它，重启电脑后再试。",
    );
  }
  if (data.firewallCoversNetwork === false && data.firewallEnabled !== false) {
    warnings.push(
      `防火墙放行规则没有覆盖当前网络（规则放行：${data.firewallProfiles}；当前网络：${data.networkCategories}）：` +
        "到「控制面板 → Windows Defender 防火墙 → 允许应用」把本工具的“公用”一列也勾上，或把当前网络改成“专用”。",
    );
  }
  if (data.systemProxyOn) {
    warnings.push(
      `检测到系统代理已开启（${data.systemProxyServer || "地址未知"}），代理/加速器可能抢走游戏流量：请彻底退出代理与加速器（含右下角托盘图标）后再启动接管。`,
    );
  }
  const residue = classifyDnsResidue(data.dnsEntries);
  if (residue?.virtual.length) {
    warnings.push(
      `检测到代理/加速器的虚拟网卡仍在活动（${residue.virtual.join("；")}）：TUN/虚拟网卡模式的代理与连接接管冲突，` +
        "请彻底退出代理与加速器（含右下角托盘图标）后再启动接管。",
    );
  }
  if (residue?.physical.length) {
    warnings.push(
      `你的 DNS 还指向已退出的代理/加速器（${residue.physical.join("；")}）：到「设置 → 网络和 Internet → 更改适配器选项」，` +
        "对应网卡右键属性 → IPv4 → 把 DNS 改回“自动获得”，否则整台电脑都可能上不了网。",
    );
  }
  if (data.firewallRulePresent === false && data.firewallEnabled !== false) {
    warnings.push(
      "还没有本工具的防火墙放行规则：启动接管后若弹出 Windows 防火墙询问窗口，请把“专用网络”和“公用网络”两项都勾上再点“允许访问”。",
    );
  }
  const takeoverPort = Number.isInteger(data.activeGamePort) ? data.activeGamePort : GAME_PORT;
  if (data.gameState?.state === "other" && !data.gameState.ports.includes(takeoverPort)) {
    warnings.push(
      `你的游戏连的是 ${data.gameState.ports.join("、")} 端口，本工具当前接管的是 ${takeoverPort}：` +
        "点一次「启动连接接管」即可自动切换到游戏正在用的端口（若接管已在运行，请先关闭工具再重开）。",
    );
  }
  if (data.elevated === false && data.redirectorAlive === false) {
    warnings.push(
      "本工具当前不是以管理员身份运行：点「启动连接接管」时会弹出管理员授权窗口，它可能被其他窗口挡住、" +
        "或因系统 UAC 设置被改动而卡住。更稳妥的做法是完全退出工具，右键工具图标选「以管理员身份运行」再打开——这样无需授权弹窗。",
    );
  }
  if (data.gameState?.state === "idle" && data.redirectorAlive) {
    warnings.push("游戏已经打开，但还没有连上游戏服务器：游戏不用重启——先完成登录；若已登录，进入一次「契约 → 抽卡记录」界面即可。");
  }
  if (data.rememberedPort === "unreadable") {
    warnings.push(
      "记住游戏端口的文件已损坏，本次会按默认端口接管：若接管不上，请删除数据目录里的 gameport.json 后重开工具，让它重新探测。",
    );
  }
  return warnings;
}

// runPowerShell(command): Promise<string> —— 由调用方注入，测试时可替身。
// 返回结构化数据；collectDiagnostics 在其上套一层文本格式化。
async function collectDiagnosticsData({
  version,
  osVersion,
  osRelease,
  interfaces,
  selectAddress,
  redirectorAlive,
  proxyConnected,
  runPowerShell,
  powerShellProbe = null,
  collectedAt,
  activeGamePort = null,
  elevated = null,
  rememberedPort = null,
  lastCapture = null,
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
  let firewallEnabled = null;
  let memoryIntegrityOn = null;
  let uacEnabled = null;
  let systemProxyOn = null;
  let systemProxyServer = null;
  let gamePortConnections = null;
  let gameConnections = null;
  let dnsEntries = null;
  if (typeof runPowerShell === "function") {
    try {
      const out = await runPowerShell(
        `$r = Get-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Action -eq 'Allow' }; ` +
          "$p = ($r | ForEach-Object { \"$($_.Profile)\" }) -join ';'; " +
          "$c = (Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.NetworkCategory)\" }) -join ';'; " +
          "$e = (Get-NetFirewallProfile -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Name)=$($_.Enabled)\" }) -join ','; " +
          '"$p|$c|$e"',
      );
      const [profilesPart, categoriesPart = "", statesPart = ""] = out.trim().split("|");
      firewallRulePresent = profilesPart.trim() !== "";
      firewallProfiles = profilesPart.trim() || null;
      networkCategories = categoriesPart.trim() || null;
      firewallEnabled = firewallActiveForNetwork(statesPart.trim(), categoriesPart.trim());
    } catch (error) {
      notes.push(`查询防火墙规则失败：${error.message}`);
    }
    try {
      const out = await runPowerShell(
        "$h = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity' -Name Enabled -ErrorAction SilentlyContinue).Enabled; " +
          "$u = (Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name EnableLUA -ErrorAction SilentlyContinue).EnableLUA; " +
          '"$h|$u"',
      );
      const [hvciValue = "", uacValue = ""] = out.trim().split("|");
      if (hvciValue.trim() === "1") memoryIntegrityOn = true;
      else if (hvciValue.trim() === "0" || hvciValue.trim() === "") memoryIntegrityOn = false;
      const uac = uacValue.trim();
      if (uac === "1") uacEnabled = true;
      else if (uac === "0") uacEnabled = false;
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
    try {
      // 按进程名找游戏，列出它自己的外部连接——比只看 12090 端口更硬：
      // 能区分"游戏没开"、"游戏开着没连服务器"、"连的不是 12090"三种情况。
      const out = await runPowerShell(
        `$g = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '${GAME_PROCESS_HINT.source}' }; ` +
          "$rows = @(); " +
          "foreach ($p in $g) { " +
          "  $cs = Get-NetTCPConnection -OwningProcess $p.Id -ErrorAction SilentlyContinue | " +
          "        Where-Object { $_.RemoteAddress -notmatch '^(127\\.|0\\.0\\.0\\.0|::)' }; " +
          "  if ($cs) { foreach ($c in $cs) { $rows += \"$($p.ProcessName)|$($c.RemoteAddress):$($c.RemotePort)|$($c.State)\" } } " +
          "  else { $rows += \"$($p.ProcessName)|-|-\" } " +
          "}; " +
          "($rows | Sort-Object -Unique) -join ';'",
      );
      gameConnections = out.trim() ? out.trim().split(";").map((item) => item.trim()).filter(Boolean) : [];
    } catch (error) {
      notes.push(`查询游戏进程连接失败：${error.message}`);
    }
    try {
      const out = await runPowerShell(
        "(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | " +
          "Where-Object { $_.ServerAddresses } | " +
          "ForEach-Object { \"$($_.InterfaceAlias):$($_.ServerAddresses -join ',')\" }) -join ';'",
      );
      dnsEntries = out.trim() ? out.trim().split(";").map((item) => item.trim()).filter(Boolean) : [];
    } catch (error) {
      notes.push(`查询 DNS 配置失败：${error.message}`);
    }
  }

  // 探针状态要在上面所有 PowerShell 调用之后再读：调用方（main.js）在每次调用时更新它。
  const probe = typeof powerShellProbe === "function" ? powerShellProbe() : powerShellProbe;

  return {
    version,
    osVersion,
    osRelease,
    proxyAddress,
    interfaces: listIpv4(interfaces),
    redirectorAlive,
    proxyConnected,
    powerShellProbe: probe ?? null,
    firewallRulePresent,
    firewallProfiles,
    networkCategories,
    firewallEnabled,
    firewallCoversNetwork: firewallCovers(firewallProfiles, networkCategories),
    memoryIntegrityOn,
    uacEnabled,
    systemProxyOn,
    systemProxyServer,
    gamePortConnections,
    gameConnections,
    gameState: classifyGameState(gameConnections),
    activeGamePort,
    rememberedPort,
    elevated,
    dnsEntries,
    notes,
    lastCapture,
    collectedAt,
  };
}

async function collectDiagnostics(inputs) {
  return formatDiagnostics(await collectDiagnosticsData(inputs));
}

module.exports = {
  FIREWALL_RULE_NAME,
  GAME_PORT,
  collectDiagnostics,
  collectDiagnosticsData,
  firewallCovers,
  classifyDnsResidue,
  classifyGameState,
  firewallActiveForNetwork,
  formatDiagnostics,
  formatLastCapture,
  formatPowerShellProbe,
  isResidueDns,
  listIpv4,
  powerShellProbeBroken,
  preflightWarnings,
};
