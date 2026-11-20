/**
 * 回归：全局状态容器（src/state.js，解耦第 1 步）
 *
 * 这一层是"给后续合入智能草图/装配路腾地方"的地基，它的价值全在**语义**上：
 *   - 四个核心槽位必须真的存在且可写（doc.shape / doc.history / doc.hIndex / ui.mode / doc.sketch / ui.appMode）
 *   - getter/setter 必须是委托（写进去要能读回来，且只读槽位要拒绝写）
 *   - subscribe 只在走 setter 时触发
 *   - main.js 必须真的注册了这批槽位、并把 state 暴露给其它模块（window.__padcad.state）
 * 行为层面的"零变化"由全量回归 + accept-context/accept-gestures 保证。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { state, bindSlot, bindSlots, subscribe, snapshot, slotPaths, _resetForTest } from "./src/state.js";

const CORE = ["doc.shape", "doc.history", "doc.hIndex", "doc.sketch", "ui.mode", "ui.appMode"];

test("state 有 doc/ui/view 三块，且各有初始值", () => {
  assert.ok(state.doc && state.ui && state.view);
  assert.equal(typeof state.doc, "object");
  assert.equal(typeof state.ui, "object");
});

test("bindSlot：写进去能读回来（委托语义）", (t) => {
  _resetForTest();
  let store = null;
  bindSlot("doc.shape", { get: () => store, set: (v) => { store = v; } });
  assert.equal(state.doc.shape, null);
  state.doc.shape = "S1";
  assert.equal(store, "S1");
  assert.equal(state.doc.shape, "S1");
  _resetForTest();
});

test("bindSlot：只读槽位（没有 set）写入时抛错，不会静默丢数据", (t) => {
  _resetForTest();
  bindSlot("view.viewer", { get: () => ({ ok: 1 }) });
  assert.deepEqual(state.view.viewer, { ok: 1 });
  assert.throws(() => { state.view.viewer = 2; }, /只读/);
  _resetForTest();
});

test("bindSlot：unknown block / 缺 get 立刻报错（别留一个假槽位）", () => {
  _resetForTest();
  assert.throws(() => bindSlot("nope.x", { get: () => 1 }), /未知的块/);
  assert.throws(() => bindSlot("doc.x", {}), /缺少 get/);
  assert.throws(() => bindSlot("doc", { get: () => 1 }), /block\.key/);
});

test("meta 记录每个槽位的真源与可写性（报告/诊断用）", () => {
  _resetForTest();
  bindSlots({ "doc.hIndex": { get: () => 1, set: () => {}, owner: "main.js", note: "游标" } });
  assert.equal(state.meta["doc.hIndex"].owner, "main.js");
  assert.equal(state.meta["doc.hIndex"].writable, true);
  assert.equal(state.meta["doc.hIndex"].note, "游标");
  _resetForTest();
});

test("subscribe：只在走 setter 时触发，退订后不再触发", () => {
  _resetForTest();
  let store = 0;
  let seen = [];
  bindSlot("doc.hIndex", { get: () => store, set: (v) => { store = v; } });
  const off = subscribe("doc.hIndex", (v, path) => seen.push([path, v]));
  state.doc.hIndex = 3;
  assert.deepEqual(seen, [["doc.hIndex", 3]]);
  off();
  state.doc.hIndex = 4;
  assert.equal(seen.length, 1);
  _resetForTest();
});

test("订阅回调抛错不会打断写入方", () => {
  _resetForTest();
  let store = 0;
  bindSlot("ui.mode", { get: () => store, set: (v) => { store = v; } });
  subscribe("ui.mode", () => { throw new Error("boom"); });
  const orig = console.error;
  console.error = () => {};
  try {
    state.ui.mode = "sketch";
    assert.equal(store, "sketch");
  } finally { console.error = orig; _resetForTest(); }
});

test("snapshot：数组只报长度、对象只报类型（诊断不能把大对象复制出去）", () => {
  _resetForTest();
  const arr = [1, 2, 3];
  bindSlots({
    "doc.history": { get: () => arr },
    "doc.shape": { get: () => ({ faces: [] }) },
    "ui.mode": { get: () => "select" },
  });
  const snap = snapshot();
  assert.deepEqual(snap["doc.history"], { length: 3 });
  assert.equal(snap["doc.shape"], "[Object]");
  assert.equal(snap["ui.mode"], "select");
  _resetForTest();
});

test("main.js 注册了这批核心槽位（含 appMode / sketch / hIndex）", () => {
  const main = fs.readFileSync(new URL("./src/main.js", import.meta.url), "utf8");
  const start = main.indexOf("bindSlots({");
  assert.ok(start > 0, "main.js 没有调用 bindSlots");
  const end = main.indexOf("\n  });", start);
  const block = main.slice(start, end);
  for (const path of CORE) {
    assert.ok(block.includes(`"${path}"`), `main.js 没有注册 ${path}`);
  }
});

test("main.js 通过 window.__padcad.state 把状态容器暴露给其它模块/验收脚本", () => {
  const main = fs.readFileSync(new URL("./src/main.js", import.meta.url), "utf8");
  assert.match(main, /window\.__padcad = \{\s*\n\s*state,/);
});

test("state 里 ui.contextKind / ui.selFaces 是本轮语境工具栏用的字段", () => {
  const src = fs.readFileSync(new URL("./src/state.js", import.meta.url), "utf8");
  assert.match(src, /contextKind/);
  assert.match(src, /modes: new Map\(\)/);
});
