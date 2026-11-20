/**
 * A2 回归：撤销/重做（以及失败回滚）装回文档时，必须把**绑在几何上的工具态**一起作废。
 *
 * 缺陷（独立代码审查 A2，2026-11-16）：
 *   撤销改成先弹命令栈之后，命令栈分支只走 `writeDoc()`；而 `gotoStep()` 里那组
 *   `exitEdgeMode / exitLinkMode / cancelSmartDim` 没有被复用 →
 *   在「圆角」模式选着 2 条棱边时按撤销，文档与 shape 换了，但 `mode` 仍是 `fillet`、
 *   `edgeSel` 还拿着旧几何的 mid、`#edgebar` 还开着；此时点「应用」→
 *   `applyEdgeTool` 拿旧 mid 去 `findEdgeNear(shape, mid, 0.6)` → 报「没有找到可用的边」。
 *   用户看到的是「圆角坏了」，实际是模式/选择没跟着文档清。
 *
 * 两条互相独立的判据：
 *   ① 行为：真 `writeDoc`/`undo`/`redo` + 真 `exitEdgeMode`/`exitLinkMode`/`cancelSmartDim`
 *      + 真命令栈 + 真 OCCT 实体 —— 撤销后 mode / edgeSel / #edgebar / #linkbar / #smartPad
 *      全部回到干净态，且画面几何是**快照**那一份（不是旧预览备份）。
 *   ② 源码契约：清理必须写在装回文档**之前**（`cancelSmartDim` 会把 shape 恢复成自己的
 *      旧备份，放后面会把刚装回来的实体盖回去），且参数面板（featPanel）不许被一刀关掉 ——
 *      失败回滚保留「面板可继续改值」是 D3 的既定语义。
 *
 * 场景与父验收刻意不同：52×34×11 底板 + 两凸台（r5，高 9 / 高 3）；父脚本用改名造栈，
 * 这里用「改参数」造栈，且逐条核对体积（不是只看栈深）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import opencascade from "replicad-opencascadejs";
import { setOC, measureVolume } from "replicad";
import { rebuild } from "./src/replay.js";
import { createCommandStack, commitStepOp, rebuildInto } from "./src/param-edit.js";
import { markSnapshot } from "./src/history-cache.js";

setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));

const source = fs.readFileSync("./src/main.js", "utf8");
function appFunction(name) {
  const m = source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "m"));
  assert.ok(m, `main.js 里找不到 function ${name}（改名了就同步改夹具）`);
  return m[0];
}

const L = 52, W = 34, T = 11, R = 5, HA = 9, HB = 3;
const V = (a, b) => L * W * T + Math.PI * R * R * (a + b);
const near = (got, want, what = "", eps = 1e-5) =>
  assert.ok(Number.isFinite(got) && Math.abs(got - want) < eps, `${what} ${got} != ${want}`);

const plane = { kind: "datum", name: "XY", origin: [0, 0, T], normal: [0, 0, 1], xDir: [1, 0, 0] };
const boss = (x, depth) => ({ type: "extrude", plane, entities: [{ kind: "circle", c: [x, 0], r: R }], depth, grow: 0 });
function makeRows() {
  const rows = [
    { label: "底板", detail: "解析底板", icon: "◆", op: { type: "primitive", shape: "box", size: [L, W, T] } },
    { label: "左凸台", detail: `+${HA}mm`, icon: "⬒", op: boss(-14, HA) },
    { label: "右凸台", detail: `+${HB}mm`, icon: "⬒", op: boss(14, HB) },
  ];
  rebuildInto(rows, rows.length - 1);
  return rows;
}

/** 假 DOM：只记 class 集合，够 writeDoc / exit* 断言可见性 */
function fakeEl() {
  const set = new Set(["hidden"]);
  return {
    value: "",
    textContent: "",
    get hidden() { return set.has("hidden"); },
    classList: {
      add: (c) => set.add(c), remove: (c) => set.delete(c),
      contains: (c) => set.has(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
    },
    _set: set,
  };
}

/**
 * 沙箱 = main.js 的「文档 + 工具态 + 浮现层」最小外壳。
 * 抽的是**真源码**：writeDoc / undo / redo / exitEdgeMode / exitLinkMode / cancelSmartDim / exitSmartDimMode
 */
function app({ mode = "select", smart = null } = {}) {
  const els = new Map();
  const c = {
    history: makeRows(), hIndex: 2, shape: null,
    mode,
    featPreviewShape: null, featPreviewing: false,
    selectedFaceId: 5, selSnap: { faceId: 5 },
    edgeSel: [{ hash: "E1", mid: [1, 0, T] }, { hash: "E2", mid: [2, 0, T] }],
    faceClass: { kind: "plane" }, curvedDriver: { i: 1 },
    linkSource: { faceId: 5, center: [0, 0, 0], normal: [0, 0, 1] }, linkTarget: null, linkTargetKind: "face",
    spA: { faceId: 5 }, spB: { faceId: 6 },
    spPreviewing: false, spPreviewShape: null,
    exited: [], stats: "",
    $: (id) => { if (!els.has(id)) els.set(id, fakeEl()); return els.get(id); },
    viewer: {
      cleared: 0, hlEdges: null, edgeData: null,
      clearPreviewWire() { c.viewer.cleared++; },
      clearHighlight() { c.viewer.cleared++; },
      clearSketchLines() {},
      highlightEdges(e) { c.viewer.hlEdges = e; },
      setEdgeData(d) { c.viewer.edgeData = d; },
    },
    dim: { hidden: 0, hide() { c.dim.hidden++; } },
    showPicker() {}, refresh() {}, renderTree() {}, renderFeatTree() {},
    setStats(t) { c.stats = String(t); },
    setMode(m) { c.mode = m; },
    gotoStep(i) { c.hIndex = i; c.shape = c.history[i]?.shape ?? null; },
    cancelEdit() { throw new Error("writeDoc 不许调用 cancelEdit（那会把参数面板关掉）"); },
    closeEdit() { throw new Error("writeDoc 不许调用 closeEdit"); },
    markSnapshot,
    performance,
  };
  if (smart) Object.assign(c, smart);
  const ctx = vm.createContext(c);
  c.ctx = ctx;
  // 命令栈的 write 必须走**真 writeDoc**（这正是被测的那段：撤销/重做/失败回滚都从它装文档）
  c.docCommands = createCommandStack({
    read: () => ({ history: c.history, hIndex: c.hIndex }),
    write: (snap) => { ctx.__snap = snap; vm.runInContext("writeDoc(__snap)", ctx); },
  });
  for (const name of ["writeDoc", "undo", "redo", "exitEdgeMode", "exitLinkMode", "cancelSmartDim", "exitSmartDimMode"]) {
    vm.runInContext(appFunction(name), ctx);
  }
  c.shape = c.history[2].shape;
  c.el = (id) => c.$(id);
  /** 改第 index 步参数（与 applyEdit 同一路径：进事务 → 换定义 → 重建） */
  c.edit = (index, newOp) => c.docCommands.run(`改第 ${index + 1} 步参数`, () => {
    const out = commitStepOp(c.history, c.hIndex, index, newOp, () => "detail");
    c.history = out.history;
    c.shape = out.shape;
  });
  c.vol = () => measureVolume(c.shape);
  c.snapTo = (i) => ({ history: c.history, hIndex: i });
  return c;
}

test("场景几何先对得上解析值", () => {
  const a = app();
  near(a.vol(), V(HA, HB), "基线体积");
});

for (const mode of ["fillet", "chamfer", "shell"]) {
  test(`A2 核心：${mode} 模式下撤销 → 模式/选边/边栏一起清（并按快照装回实体）`, () => {
    const a = app({ mode });
    a.edit(1, boss(-14, 6));                       // 造一步命令（栈深 1）
    near(a.vol(), V(6, HB), "改参数后");
    assert.equal(a.docCommands.undoDepth, 1);

    // 用户此刻正在这个模式里选着两条棱边
    a.mode = mode;
    a.edgeSel = [{ hash: "E1", mid: [1, 0, T] }, { hash: "E2", mid: [2, 0, T] }];
    a.$("edgebar").classList.remove("hidden");
    a.$("toolbar").classList.add("hidden");
    assert.equal(a.$("edgebar").hidden, false, "前置：边栏是开着的");

    assert.equal(a.undo(), "改第 2 步参数");
    assert.equal(a.mode, "select", "撤销后必须退出圆角/倒角/抽壳模式");
    assert.ok(Array.isArray(a.edgeSel) && a.edgeSel.length === 0, "撤销后不许留着旧几何的棱边选择");
    assert.equal(a.$("edgebar").hidden, true, "#edgebar 必须收起");
    assert.equal(a.$("toolbar").hidden, false, "工具栏必须回来");
    assert.ok(Array.isArray(a.viewer.hlEdges) && a.viewer.hlEdges.length === 0, "棱边高亮必须清掉");
    near(a.vol(), V(HA, HB), "实体必须是快照那一份（修前/修坏时这里是旧几何）");
    assert.equal(a.shape, a.history[a.hIndex].shape, "shape 必须与游标所指的行同一份");

    // 现在还能重做回改后的几何，且实体没被 OCCT 吃掉
    assert.equal(a.redo(), "改第 2 步参数");
    near(a.vol(), V(6, HB), "重做后");
    assert.equal(a.mode, "select", "重做也不许把模式带回来");
  });
}

test("A2：link 模式撤销 → 链接预览/链接栏/两端引用一起清", () => {
  const a = app({ mode: "link" });
  a.edit(1, boss(-14, 7));                        // 造栈
  a.mode = "link";
  a.linkSource = { faceId: 5 };
  a.linkTarget = { faceId: 6 };
  a.$("linkbar").classList.remove("hidden");
  a.viewer.edgeData = [{ hash: "E1" }];

  a.undo();
  assert.equal(a.mode, "select");
  assert.equal(a.linkSource, null);
  assert.equal(a.linkTarget, null);
  assert.equal(a.$("linkbar").hidden, true);
  assert.ok(Array.isArray(a.viewer.edgeData) && a.viewer.edgeData.length === 0, "链接用的边点集必须清掉");
  near(a.vol(), V(HA, HB), "按快照装回");
});

test("A2 顺序：smartdim 的旧预览备份不许盖掉刚装回的实体", () => {
  const a = app({ mode: "smartdim" });
  a.edit(1, boss(-14, 8));                        // 栈深 1（高 9 → 高 8）
  const staleBackup = a.history[0].shape;         // 只有底板：cancelSmartDim 会把这个写回 shape
  // 智能尺寸刚预览过一个**不同**的几何：它的回滚备份就是这份旧实体
  a.mode = "smartdim";
  a.spPreviewing = true;
  a.spPreviewShape = staleBackup;
  a.$("smartPad").classList.remove("hidden");

  a.undo();
  assert.equal(a.mode, "select", "撤销后必须退出智能尺寸模式");
  assert.equal(a.$("smartPad").hidden, true, "智能尺寸浮条必须收起");
  assert.equal(a.spPreviewing, false);
  assert.equal(a.spPreviewShape, null);
  assert.equal(a.shape, a.history[a.hIndex].shape, "实体必须是快照那一份");
  assert.notEqual(a.shape, staleBackup, "实体不许被 cancelSmartDim 的旧备份盖掉");
  near(a.vol(), V(HA, HB), "撤销只该退一步参数（回高 9），不该掉回只有底板");
});

test("A2 反面：mode=select 时不许乱清（参数面板/预览态语义保持 D3 既定行为）", () => {
  const a = app({ mode: "select" });
  a.edit(1, boss(-14, 5));
  a.featPreviewing = true;                        // 失败回滚时可能挂着预览态
  a.featPreviewShape = a.history[0].shape;
  const eye = a.$("featEye");
  eye.classList.add("on");

  a.undo();
  assert.equal(a.mode, "select");
  assert.equal(a.featPreviewing, false, "预览态必须收干净（旧行为）");
  assert.equal(a.featPreviewShape, null);
  assert.equal(eye.classList.contains("on"), false, "👁 高亮要摘掉");
  // 撤掉之后仍然可以继续编辑：面板没被关（writeDoc 里没有 cancelEdit/closeEdit —— 调了会抛）
  near(a.vol(), V(HA, HB));
  assert.equal(a.docCommands.undoDepth, 0);
});

test("A2 源码契约：清理写在装回文档之前，且只清几何相关的模式", () => {
  const body = appFunction("writeDoc");
  const assign = body.indexOf("history = snap.history");
  assert.ok(assign > 0, "writeDoc 里找不到装回文档那一行");
  for (const fn of ["exitEdgeMode", "exitLinkMode", "cancelSmartDim"]) {
    const at = body.indexOf(fn + "()");
    assert.ok(at > 0, `writeDoc 必须复用 ${fn}（与 gotoStep 同一组工具态清理）`);
    assert.ok(at < assign, `${fn}() 必须在 history = snap.history 之前（否则旧预览会盖回来）`);
  }
  assert.equal(/cancelEdit\(|closeEdit\(/.test(body), false,
    "writeDoc 不许关参数面板（失败回滚也要能继续改值）");
  assert.match(body, /mode === "fillet"|\["fillet", "chamfer", "shell"\]|fillet/, "必须按模式判断，别无条件清");
});
