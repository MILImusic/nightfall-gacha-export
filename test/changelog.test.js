const test = require("node:test");
const assert = require("node:assert/strict");
const { decideWhatsNew, notesFor } = require("../src/main/changelog");

test("decideWhatsNew 同版本无事可做", () => {
  assert.equal(decideWhatsNew({ prevVersion: "0.1.4", disclaimerAccepted: true, currentVersion: "0.1.4" }), "none");
});

test("decideWhatsNew 全新安装只记录不弹窗（免责声明优先）", () => {
  assert.equal(decideWhatsNew({ prevVersion: null, disclaimerAccepted: false, currentVersion: "0.1.4" }), "record");
});

test("decideWhatsNew 老用户（接受过免责声明）升级到有文案的版本弹窗", () => {
  assert.equal(decideWhatsNew({ prevVersion: null, disclaimerAccepted: true, currentVersion: "0.1.4" }), "show");
  assert.equal(decideWhatsNew({ prevVersion: "0.1.3", disclaimerAccepted: true, currentVersion: "0.1.4" }), "show");
});

test("decideWhatsNew 目标版本没写文案时静默记录", () => {
  assert.equal(decideWhatsNew({ prevVersion: "0.1.4", disclaimerAccepted: true, currentVersion: "0.9.9" }), "record");
});

test("notesFor 未登记版本返回空数组", () => {
  assert.deepEqual(notesFor("0.0.1"), []);
  assert.equal(notesFor("0.1.4").length > 0, true);
});
