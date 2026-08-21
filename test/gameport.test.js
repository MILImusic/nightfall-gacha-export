const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_GAME_PORT,
  candidatePorts,
  detectGamePort,
  portMismatch,
  resolveGamePort,
} = require("../src/main/gameport");

test("candidatePorts 剔除登录页/CDN 的附属端口，只留游戏主连接候选", () => {
  assert.deepEqual(
    candidatePorts([
      "ReignofNightfall|203.0.113.10:12085|Established",
      "ReignofNightfall|203.0.113.20:443|Established",
      "ReignofNightfall|203.0.113.30:80|Established",
    ]),
    [12085],
  );
  // 多条主连接时，出现次数多的排前面
  assert.deepEqual(
    candidatePorts([
      "ReignofNightfall|203.0.113.10:12090|Established",
      "ReignofNightfall|203.0.113.11:12085|Established",
      "ReignofNightfall|203.0.113.12:12085|Established",
    ]),
    [12085, 12090],
  );
  assert.deepEqual(candidatePorts([]), []);
  assert.deepEqual(candidatePorts(null), []);
  // 进程在但没有连接时的占位行
  assert.deepEqual(candidatePorts(["ReignofNightfall|-|-"]), []);
});

test("detectGamePort 取出真实端口；探不到返回 null", () => {
  assert.equal(detectGamePort(["ReignofNightfall|203.0.113.10:12085|Established"]), 12085);
  assert.equal(detectGamePort(["ReignofNightfall|203.0.113.10:443|Established"]), null);
  assert.equal(detectGamePort([]), null);
});

test("resolveGamePort 优先级：探到的 > 记住的 > 默认", () => {
  assert.deepEqual(resolveGamePort({ detected: 12085, remembered: 12090 }), { port: 12085, source: "detected" });
  assert.deepEqual(resolveGamePort({ detected: null, remembered: 12085 }), { port: 12085, source: "remembered" });
  assert.deepEqual(resolveGamePort({ detected: null, remembered: null }), {
    port: DEFAULT_GAME_PORT,
    source: "default",
  });
  assert.deepEqual(resolveGamePort(), { port: DEFAULT_GAME_PORT, source: "default" });
});

test("resolveGamePort 拒绝非法端口，回落到下一优先级", () => {
  assert.deepEqual(resolveGamePort({ detected: 0, remembered: 12085 }), { port: 12085, source: "remembered" });
  assert.deepEqual(resolveGamePort({ detected: 70000, remembered: null }), {
    port: DEFAULT_GAME_PORT,
    source: "default",
  });
  assert.deepEqual(resolveGamePort({ detected: "12085", remembered: null }), {
    port: DEFAULT_GAME_PORT,
    source: "default",
  });
});

test("portMismatch 只在接管端口与游戏实际端口不同时报告", () => {
  assert.deepEqual(
    portMismatch({ activePort: 12090, entries: ["ReignofNightfall|203.0.113.10:12085|Established"] }),
    { activePort: 12090, detected: 12085 },
  );
  assert.equal(
    portMismatch({ activePort: 12085, entries: ["ReignofNightfall|203.0.113.10:12085|Established"] }),
    null,
  );
  // 游戏没开或只有附属连接时不报告
  assert.equal(portMismatch({ activePort: 12090, entries: [] }), null);
  assert.equal(portMismatch({ activePort: 12090, entries: ["ReignofNightfall|203.0.113.10:443|Established"] }), null);
  assert.equal(portMismatch({ activePort: null, entries: ["ReignofNightfall|203.0.113.10:12085|Established"] }), null);
});
