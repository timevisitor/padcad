/**
 * 参数编辑 → **视口渲染** 契约回归（真 OCCT，把 main.js 的 applyEdit/previewEdit 抠进 vm）
 *
 * 为什么单独一个文件（父验收实测缺口，2026-11-16）：
 *   父会话的真实触摸验收抓到一条只在**画面**上出现的失败 ——
 *   左凸台 13 → 输入 19 → 👁 预览 → 输入原值 13 → ✔ 确认：
 *   体积 / 包围盒 / 历史定义全都是提交态的 13，但 `viewer.meshData` 的 z 跨度
 *   还是预览的 19（实测 28 而不是 23）。也就是说「文档对了，屏幕没跟上」。
 *   regression-param-edit.mjs 只看 measureVolume / 历史定义，**结构上抓不到这一类**
 *   （它的被测对象是 src/param-edit.js 的纯数据层，压根没有视口）。
 *
 * 这个夹具因此断言两件互相独立的事：
 *   ① 渲染调用：值没变但曾预览过时，applyEdit 必须重画一次（renderCalls 增加）；
 *   ② 网格实际高度：从真实 `meshOf(shape)` 的 vertices 取 z 跨度，跟解析值比。
 * 只断言 ① 会被「重画了但画的是旧 shape」骗过；只断言 ② 会在实现换成
 * 「直接改缓存」时误报。两条一起才钉住「屏幕 = 提交态几何」。
 *
 * 场景与父验收刻意不同：52×34×11 底板 + 两个同半径 r5 凸台（左 12 高、右 4 高），
 * 被测凸台是**更高**的那个 —— 否则整体包围盒由另一个凸台决定，网格高度看不出差别。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import opencascade from "replicad-opencascadejs";
import { setOC, measureVolume } from "replicad";
import { meshOf } from "./src/kernel.js";
import { rebuild, RefLost } from "./src/replay.js";
import { cacheRebuild } from "./src/project.js";
import { createCommandStack, commitStepOp, rebuildInto } from "./src/param-edit.js";

setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));

const source = fs.readFileSync("./src/main.js", "utf8");
function appFunction(name) {
  const m = source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "m"));
  assert.ok(m, `main.js 里找不到 function ${name}（改名了就同步改夹具）`);
  return m[0];
}
function appConst(name) {
  const m = source.match(new RegExp(`^const ${name} = [^]*?^\\};`, "m"));
  assert.ok(m, `main.js 里找不到 const ${name}`);
  return m[0];
}

const L = 52, W = 34, T = 11, R = 5, HA = 12, HB = 4;
/** 解析体积（与实现无关）：底板 + 两个凸台 */
const V = (a, b) => L * W * T + Math.PI * R * R * (a + b);
const near = (got, want, what = "") =>
  assert.ok(Number.isFinite(got) && Math.abs(got - want) < 1e-5, `${what} ${got} != ${want}`);

/** 从视口网格的顶点里取 z 跨度 —— 这是「屏幕上多高」的唯一实测口径 */
function meshHeight(m) {
  const v = m?.vertices ?? m?.triangles;
  assert.ok(v && v.length, "视口里没有网格");
  let lo = Infinity, hi = -Infinity;
  for (let i = 2; i < v.length; i += 3) { lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); }
  return hi - lo;
}

const plane = { kind: "datum", name: "XY", origin: [0, 0, T], normal: [0, 0, 1], xDir: [1, 0, 0] };
const boss = (x, depth) => ({ type: "extrude", plane, entities: [{ kind: "circle", c: [x, 0], r: R }], depth, grow: 0 });
const rows = () => [
  { label: "底板", detail: "解析底板", icon: "◆", op: { type: "primitive", shape: "box", size: [L, W, T] } },
  { label: "左凸台", detail: `+${HA}mm`, icon: "⬒", op: boss(-14, HA) },
  { label: "右凸台", detail: `+${HB}mm`, icon: "⬒", op: boss(14, HB) },
];

/**
 * 沙箱 = main.js 的「文档 + 视口」最小外壳。
 * 生产函数（featureDisplayName / detailOf / closeEdit / previewEdit / applyEdit）
 * 全部按源码原文跑；只替换 DOM、viewer、刷新这些边界。
 */
function editor() {
  const ctl = { failNextRebuild: false };            // 重放失败注入开关（D3 用）
  const history = rows();
  rebuildInto(history, history.length - 1);          // 等价于打开工程时的重放
  const els = new Map();
  const el = () => {
    const cls = new Set();
    return {
      textContent: "", value: "", disabled: false, _cls: cls,
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
    };
  };
  const c = {
    history, hIndex: 2, shape: null,
    mode: "select", appMode: "model",
    editingStep: null, featPreviewing: false, featPreviewShape: null,
    selectedFaceId: null, selSnap: null,
    renderCalls: 0, lastMessage: "",
    performance, meshOf, commitStepOp, RefLost,
    // 重放边界：默认走真实 rebuild；注入失败用来复现「👁 预览失败」这条路径（如同父复核实测的 R50 圆角）
    rebuild: (h, i, ov) => {
      if (ctl.failNextRebuild) { ctl.failNextRebuild = false; throw new Error("注入失败：这一步重放不成立"); }
      return rebuild(h, i, ov);
    },
    renderTree: () => {},
    // 边界替身：applyEdit / writeDoc 清选中态时会收语境卡（生产里是 ui-context 的卡片）。
    // 这里只记录调用，卡片 DOM 不在本回归的判定范围内。
    showPickerCalls: 0, lastPickerArg: "never",
    showPicker: (info) => { c.showPickerCalls++; c.lastPickerArg = info; },
    setStats: (t) => { c.lastMessage = t; },
    dim: { hide() {} },
    viewer: {
      meshData: null,
      setMesh(m) { this.meshData = m; },
      clearHighlight() {}, highlightEdges() {}, clearSketchLines() {},
      setEdgeData() {}, clearPreviewWire() {},
    },
    $: (id) => { if (!els.has(id)) els.set(id, el()); return els.get(id); },
  };
  c.ctl = ctl;
  c.shape = history[2].shape;
  // refresh 与生产同义：把当前 shape 网格化后交给视口（这里只保留回归需要的部分）
  c.refresh = () => { c.renderCalls++; c.viewer.setMesh(meshOf(c.shape)); };
  const ctx = vm.createContext(c);
  c.docCommands = createCommandStack({
    read: () => ({ history: c.history, hIndex: c.hIndex }),
    write: (snap) => {
      c.history = snap.history;
      c.hIndex = snap.hIndex;
      c.shape = c.hIndex >= 0 ? (c.history[c.hIndex]?.shape ?? null) : null;
      c.viewer.setMesh(meshOf(c.shape));
    },
  });
  for (const name of ["featureDisplayName", "detailOf", "closeEdit", "previewEdit", "applyEdit"]) {
    vm.runInContext(appFunction(name), ctx);
  }
  vm.runInContext(appConst("EDITABLE"), ctx);
  /** 打开属性面板（editStep 的 DOM 部分；参数与生产一致） */
  c.openEdit = (i) => {
    c.editingStep = i;
    c.featPreviewShape = null;
    c.featPreviewing = false;
    c.$("featVal").value = String(c.history[i].op.depth);
    c.$("featPanel").classList.remove("hidden");
    c.$("featEye").classList.remove("on");
  };
  c.setValue = (v) => { c.$("featVal").value = String(v); };
  c.preview = (v) => { c.setValue(v); vm.runInContext("previewEdit()", ctx); };
  c.apply = (v) => { c.setValue(v); vm.runInContext("applyEdit()", ctx); };
  c.refresh();     // 打开文档时的首帧（等价于 main.js 建好模型后的 refresh）
  return c;
}

test("场景几何先对得上解析值（下面的判据才有意义）", () => {
  const c = editor();
  near(measureVolume(c.shape), V(HA, HB), "基线体积");
  near(meshHeight(c.viewer.meshData ?? meshOf(c.shape)), T + HA, "基线网格高度（高的那侧凸台决定）");
});

test("预览只改画面：网格高度跟着候选值走，历史与撤销栈都不动", () => {
  const c = editor();
  const before = c.history;
  c.openEdit(1);
  c.preview(20);
  near(meshHeight(c.viewer.meshData), T + 20, "预览网格高度");
  assert.equal(c.history, before, "预览不许换历史数组");
  assert.equal(c.docCommands.undoDepth, 0, "预览不占撤销步");
  assert.equal(c.featPreviewing, true);
});

test("预览后确认原值：网格必须按提交态重画（父验收实测的失败点）", () => {
  const c = editor();
  const other = JSON.stringify(c.history[2].op);
  c.openEdit(1);
  c.preview(20);
  near(meshHeight(c.viewer.meshData), T + 20, "预览态网格高度");
  const rendersBefore = c.renderCalls;

  c.apply(HA);                                   // 输入原值 → ✔

  // ① 渲染调用：必须重画过一次
  assert.ok(c.renderCalls > rendersBefore, "确认原值后必须重画视口（否则屏幕上留着预览网格）");
  // ② 网格实际高度 = 提交态
  near(meshHeight(c.viewer.meshData), T + HA, "确认原值后的网格高度");
  near(measureVolume(c.shape), V(HA, HB), "确认原值后的体积");
  // ③ 其它对象、撤销栈、面板状态都不许被牵连
  assert.equal(JSON.stringify(c.history[2].op), other, "另一个同径凸台的定义不许被碰");
  assert.equal(c.docCommands.undoDepth, 0, "无变化提交不占撤销步");
  near(c.history[2].toolShape.boundingBox.center[0], 14, "另一个凸台的增量体位置不变");
  assert.equal(c.featPreviewing, false, "预览态必须收干净");
  assert.equal(c.editingStep, null, "编辑面板必须关掉");
  assert.equal(c.$("featPanel").classList.contains("hidden"), true, "面板 DOM 也要收起");
  assert.match(c.lastMessage, /本来就是/, "状态条要说明没有产生修改");
});

test("无预览时确认原值：不重画、不占撤销步（别为了修这条 bug 到处乱刷）", () => {
  const c = editor();
  c.openEdit(1);
  const rendersBefore = c.renderCalls;
  c.apply(HA);
  assert.equal(c.renderCalls, rendersBefore, "没有预览就没有要恢复的画面，不该重建");
  assert.equal(c.docCommands.undoDepth, 0);
  near(meshHeight(c.viewer.meshData), T + HA, "网格高度保持提交态");
  assert.equal(c.editingStep, null);
});

test("预览后确认为新值：网格画到新值，且只记一步撤销", () => {
  const c = editor();
  c.openEdit(1);
  c.preview(20);
  c.apply(18);
  near(meshHeight(c.viewer.meshData), T + 18, "新值网格高度");
  near(measureVolume(c.shape), V(18, HB), "新值体积");
  assert.equal(c.docCommands.undoDepth, 1, "一次提交 = 一步撤销");
  assert.equal(c.history[1].op.depth, 18);
});

test("预览 → 确认原值 之后撤销，撤的是上一次真实编辑（空提交不许插队）", () => {
  const c = editor();
  c.openEdit(1);
  c.apply(18);                                   // 第一次真实编辑
  assert.equal(c.docCommands.undoDepth, 1);
  const committed = c.renderCalls;

  c.openEdit(1);
  c.preview(25);                                 // 看一个更大的值
  near(meshHeight(c.viewer.meshData), T + 25, "预览网格高度");
  c.apply(18);                                   // 回到当前定义值 → 无变化

  assert.equal(c.docCommands.undoDepth, 1, "无变化提交不许压栈");
  near(meshHeight(c.viewer.meshData), T + 18, "确认后网格回到提交态");
  assert.ok(c.renderCalls > committed, "必须重画过");

  assert.ok(c.docCommands.undo(), "撤销应撤掉那次真实编辑");
  near(measureVolume(c.shape), V(HA, HB), "撤销回到基线");
  near(meshHeight(c.viewer.meshData), T + HA, "撤销后的网格也必须跟上");
  assert.equal(c.history[1].op.depth, HA);
});

/**
 * D3（独立复核 REQUEST_CHANGES）：👁 预览失败原来只改文案，几何停在上一次预览。
 * 判据同样要三条一起断：① 文档几何回提交态 ② 视口网格回提交态（屏幕上多高）
 * ③ 面板还开着、可以继续改值（不许用 cancelEdit 把面板关掉）。
 */
test("核心D3：第二次预览失败必须退回提交态（几何+网格），面板保留可编辑", () => {
  const c = editor();
  c.openEdit(1);
  c.preview(20);                                  // ① 成功预览（候选几何挂上屏幕）
  near(meshHeight(c.viewer.meshData), T + 20, "预览网格高度");
  assert.equal(c.featPreviewing, true);
  const rendersBefore = c.renderCalls;

  c.ctl.failNextRebuild = true;
  c.preview(50);                                  // ② 预览失败

  near(measureVolume(c.shape), V(HA, HB), "失败后文档几何必须是提交态（不是上一次预览的 20）");
  near(meshHeight(c.viewer.meshData), T + HA, "失败后网格必须是提交态（屏幕上不许留预览）");
  assert.ok(c.renderCalls > rendersBefore, "失败也必须重画一次（否则视口留着上一次预览网格）");
  assert.equal(c.featPreviewing, false, "预览态必须收干净");
  assert.equal(c.featPreviewShape, null);
  assert.equal(c.$("featEye").classList.contains("on"), false, "👁 不许还亮着");
  assert.equal(c.editingStep, 1, "面板必须留着（用户要能改成能用的值）");
  assert.equal(c.$("featPanel").classList.contains("hidden"), false, "面板 DOM 不许被关掉");
  assert.equal(c.docCommands.undoDepth, 0, "失败预览不写定义、不占撤销步");
  assert.match(c.lastMessage, /预览失败/);
  // ③ 面板还能继续用：改成合法值再确认，正常落进历史
  c.apply(16);
  near(measureVolume(c.shape), V(16, HB), "失败后仍可继续提交新值");
  assert.equal(c.docCommands.undoDepth, 1);
});

test("D3 对照：第一次预览就失败时不动已提交几何，也不误关面板", () => {
  const c = editor();
  c.openEdit(1);
  const rendersBefore = c.renderCalls;
  c.ctl.failNextRebuild = true;
  c.preview(50);
  near(measureVolume(c.shape), V(HA, HB), "从未预览过：几何保持提交态");
  near(meshHeight(c.viewer.meshData), T + HA, "网格保持提交态");
  assert.equal(c.renderCalls, rendersBefore, "没有要恢复的画面，不该凭空重建");
  assert.equal(c.featPreviewing, false);
  assert.equal(c.editingStep, 1, "面板保留");
  assert.equal(c.$("featPanel").classList.contains("hidden"), false);
  assert.equal(c.docCommands.undoDepth, 0);
});

/**
 * 语境卡必须在「清选中态」时一起收起（本轮探针实测的连带缺陷）：
 * 改完参数后 applyEdit 把 selectedFaceId 置空却没收卡，卡片留在屏幕上并在下次重建时
 * 重新定位到画面中部，下一次点面命中的是卡上的按钮（mode 变成 pickface）——
 * 独立复核脚本的 T3「第二次选面唤不出语境卡」就是这条。
 */
test("改参数确认后必须收起语境卡（showPicker(null)）", () => {
  const c = editor();
  c.openEdit(1);
  c.apply(16);
  assert.ok(c.showPickerCalls >= 1, "确认后必须调 showPicker 收卡");
  assert.equal(c.lastPickerArg, null, "收卡要传 null（hideContextCard），不是留着旧面信息");
});
