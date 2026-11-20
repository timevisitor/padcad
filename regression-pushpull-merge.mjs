/**
 * 同面连续推拉合并 → 必须走统一撤销栈（回归，真 OCCT，vm 跑 main.js 生产源码）
 *
 * 为什么单独一个文件：
 *   `commitPushPull` 的「同一个面继续推拉 → 合并成同一个特征」分支原来是就地改
 *   `history[hIndex].op / .detail / .shape` 然后 return —— 既没有 `docCommands.run`
 *   也没有 `replaceStep`，于是：
 *     ① 合并这一步没有任何撤销快照，按撤销会落到 `gotoStep(hIndex-1)`，
 *        把**原来那次推拉整个撤掉**（甚至退到更早的参数），而不是回到合并前的深度；
 *     ② 旧行被就地改写，命令栈里更早的快照与「当前历史」共享同一行对象 → 重做会拿到错几何。
 *   本文件把生产函数整段抠进 vm 沙箱（不重写实现），用真实 OCCT 几何 + 解析体积判定。
 *
 * 判据口径（与项目既有约定一致）：几何对不对只看体积与解析值；再加「特征条数 /
 * 撤销栈深度 / 历史行引用」判动作顺序，避免「几何碰巧对了但多记/漏记一步」。
 *
 * 场景：60×40×8 底板（解析体积 19200）。同面推拉 +5 → +3 合并成 +8。
 * 与父验收刻意不同（父用 74×46×9 + 双凸台），避免重复同一夹具。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import opencascade from "replicad-opencascadejs";
import { setOC, measureVolume } from "replicad";
import { Vector3 } from "three";
import { meshOf } from "./src/kernel.js";
import * as OPS from "./src/ops.js";
import { createCommandStack, replaceStep, appendStep, rebuildInto, commitStepOp } from "./src/param-edit.js";
import { markSnapshot } from "./src/history-cache.js";
import { rebuild } from "./src/replay.js";

setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));

const L = 60, W = 40, T = 8;
/** 解析体积：L×W×高（推拉只改高度/宽度，都是解析值） */
const vol = (h) => L * W * h;
const near = (got, want, what = "", eps = 1e-5) =>
  assert.ok(Number.isFinite(got) && Math.abs(got - want) < eps, `${what} ${got} != ${want}`);

const source = fs.readFileSync("./src/main.js", "utf8");
function appFunction(name) {
  const m = source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "m"));
  assert.ok(m, `main.js 里找不到 function ${name}（改名了就同步改夹具）`);
  return m[0];
}

const baseRow = () => ({
  label: "底板", detail: "60 × 40 × 8", icon: "◆",
  op: { type: "primitive", shape: "box", size: [L, W, T] },
});

/** 按法向 + 轴向坐标找面（不靠 faceId 稳定，每次重建后重新找 —— 与真人重选面等价） */
function faceWith(sh, normal, axis, at) {
  for (const g of meshOf(sh).faceGroups) {
    const i = OPS.faceInfo(sh, g.faceId);
    if (!i) continue;
    const dot = i.normal[0] * normal[0] + i.normal[1] * normal[1] + i.normal[2] * normal[2];
    if (dot < 0.99) continue;
    if (at != null && Math.abs(i.center[axis] - at) > 1e-6) continue;
    return { faceId: g.faceId, info: i };
  }
  throw new Error(`找不到法向 ${normal.join(",")} 且 ${axis}=${at} 的面`);
}
const topFace = (sh, atZ) => faceWith(sh, [0, 0, 1], "z", atZ);
const sideFace = (sh, atX) => faceWith(sh, [1, 0, 0], "x", atX);

/**
 * 沙箱 = main.js 的「文档 + 命令栈」最小外壳。
 * 生产函数（commitPushPull / commit / applyPushPull / undo / redo / detailOf …）按源码原文跑；
 * 只替换 DOM / 视口 / 刷新这些边界。history、hIndex、shape 就是 main.js 的模块级变量。
 */
function scene() {
  const rows = [baseRow()];
  rebuildInto(rows, 0);
  const els = new Map();
  const el = () => ({
    textContent: "", value: "", disabled: false,
    classList: { add() {}, remove() {}, contains() { return false; } },
  });
  const c = {
    history: rows, hIndex: 0, shape: rows[0].shape,
    mode: "select", busy: false, selectedFaceId: null, selSnap: null,
    performance, THREE: { Vector3 }, OPS,
    renderCalls: 0, treeCalls: 0, lastMessage: "",
    failNextRenderTree: false,
    // 生产模块（与 main.js 的 import 是同一份）
    commitStepOp, replaceStep, appendStep, markSnapshot, rebuildInto, rebuild,
    FEATURE_ICON: {},
    setStats(t) { c.lastMessage = String(t); },
    $: (id) => { if (!els.has(id)) els.set(id, el()); return els.get(id); },
    viewer: { meshData: null, setMesh(m) { this.meshData = m; }, clearHighlight() {}, clearSketchLines() {}, setEdgeData() {}, highlightFace() {} },
    exitSketch() {},
    // 生产 gotoStep 对文档的唯一作用就是这三行（其余是浮层/模式清理）
    gotoStep(i) {
      if (i < 0 || i >= c.history.length || i === c.hIndex) return;
      c.hIndex = i;
      c.shape = c.history[i].shape;
      c.refresh();
    },
    refresh() {
      c.renderCalls++;
      c.viewer.setMesh(meshOf(c.shape));
    },
    renderTree() {
      c.treeCalls++;
      if (c.failNextRenderTree) { c.failNextRenderTree = false; throw new Error("注入失败：特征树重绘抛错"); }
    },
    selectFace(id) { c.selectedFaceId = id; },
    remapSelection() { return null; },     // 生产里按几何重映射；本夹具由测试自己重选面
  };
  const ctx = vm.createContext(c);
  c.docCommands = createCommandStack({
    read: () => ({ history: c.history, hIndex: c.hIndex }),
    // 与生产 writeDoc 同义：实体一律从行里取（这一步也就是「失败/撤销时画面必须回到已提交态」）
    write: (snap) => {
      c.history = snap.history;
      c.hIndex = snap.hIndex;
      c.shape = c.hIndex >= 0 ? (c.history[c.hIndex]?.shape ?? null) : null;
      c.refresh();
      c.renderTree();
    },
  });
  for (const name of [
    "sameFaceAsPrevPushPull", "commitPushPull", "applyPushPull", "isPlanarPushPullFace",
    "commit", "detailOf", "featureDisplayName", "undo", "redo",
  ]) {
    vm.runInContext(appFunction(name), ctx);
  }
  c.ctx = ctx;
  /** 与 main.js applyEdit 同一路径：进事务 → 换定义 + 重建 */
  c.edit = (index, newOp) => c.docCommands.run(`改第 ${index + 1} 步参数`, () => {
    const out = commitStepOp(c.history, c.hIndex, index, newOp, c.detailOf);
    c.history = out.history;
    c.shape = out.shape;
    c.refresh();
    c.renderTree();
    return out;
  });
  /** 推拉（公开生产入口 applyPushPull：先真选面，再推） */
  c.push = (faceId, dist) => {
    c.selectFace(faceId);
    vm.runInContext(`applyPushPull(${dist})`, ctx);
  };
  c.volume = () => measureVolume(c.shape);
  c.pushRow = () => c.history.filter((r) => r.op?.type === "pushpull");
  return c;
}

test("场景几何先对得上解析值（下面的判据才有意义）", () => {
  const d = scene();
  near(d.volume(), vol(T), "基线体积");
  assert.equal(d.history.length, 1);
  assert.equal(d.docCommands.undoDepth, 0);
});

test("核心：同面连续推拉合并成同一个特征，撤销回到合并前的深度（不许把原推拉撤掉）", () => {
  const d = scene();
  const f1 = topFace(d.shape, T);
  d.push(f1.faceId, 5);
  near(d.volume(), vol(T + 5), "第一次推拉体积");
  assert.equal(d.history.length, 2, "第一次推拉应新增一个特征");
  assert.equal(d.docCommands.undoDepth, 1);

  const f2 = topFace(d.shape, T + 5);
  d.push(f2.faceId, 3);
  near(d.volume(), vol(T + 8), "同面合并后的体积");
  assert.equal(d.history.length, 2, "同面合并仍然是同一个特征（不是新增）");
  assert.equal(d.pushRow().length, 1, "推拉特征只有一条");
  assert.equal(d.history[1].op.dist, T + 8 - T, "特征深度 = 5 + 3");
  assert.equal(d.docCommands.undoDepth, 2, "合并也必须占一步撤销（统一动作顺序）");

  const label = d.docCommands.undo();
  assert.ok(label, "撤销必须由命令栈完成，而不是退回历史步进");
  near(d.volume(), vol(T + 5), "撤销回合并前的深度 5");
  assert.equal(d.history.length, 2, "撤销合并后仍是同一个特征（不要撤掉原推拉）");
  assert.equal(d.history[1].op.dist, 5, "定义回到 5");
  near(d.volume(), measureVolume(d.history[d.hIndex].shape), "画面与文档一致");

  assert.ok(d.docCommands.redo(), "重做必须回到合并后");
  near(d.volume(), vol(T + 8), "重做回 8");
  assert.equal(d.history[1].op.dist, 8);
});

test("改参数后同面合并：两次撤销逐级回退（合并 → 改参数），重做逐级前进", () => {
  const d = scene();
  d.push(topFace(d.shape, T).faceId, 5);
  d.edit(1, { ...d.history[1].op, dist: 4 });
  near(d.volume(), vol(T + 4), "改参数后体积");
  assert.equal(d.docCommands.undoDepth, 2);

  d.push(topFace(d.shape, T + 4).faceId, 3);
  assert.equal(d.history[1].op.dist, 7, "合并后深度 = 4 + 3");
  near(d.volume(), vol(T + 7));
  assert.equal(d.docCommands.undoDepth, 3, "合并只该多一步");

  d.undo();
  near(d.volume(), vol(T + 4), "第一次撤销回 4（参数值，不是 5）");
  assert.equal(d.history[1].op.dist, 4);
  d.undo();
  near(d.volume(), vol(T + 5), "第二次撤销回 5（改参数之前）");
  assert.equal(d.history[1].op.dist, 5);
  d.redo();
  near(d.volume(), vol(T + 4), "重做 1 → 4");
  d.redo();
  near(d.volume(), vol(T + 7), "重做 2 → 7");
});

test("新增特征先撤后参数：合并后的新特征先被撤销，再撤合并", () => {
  const d = scene();
  d.push(topFace(d.shape, T).faceId, 5);
  d.push(topFace(d.shape, T + 5).faceId, 3);
  const pushVol = d.volume();
  // 新增一个可辨识的特征（+X 侧面推拉 2mm）—— 走生产 applyPushPull
  d.push(sideFace(d.shape, L / 2).faceId, 2);
  near(d.volume(), (L + 2) * W * (T + 8), "侧面推拉后体积");
  assert.equal(d.history.length, 3, "换面推拉必须新增特征");
  assert.equal(d.docCommands.undoDepth, 3);

  d.undo();
  near(d.volume(), pushVol, "先撤掉新特征，合并后的 8 还在");
  assert.equal(d.history.length, 2);
  assert.equal(d.history[1].op.dist, 8);
  d.undo();
  near(d.volume(), vol(T + 5), "再撤一步才回合并前");
  assert.equal(d.history[1].op.dist, 5);
});

test("零距离合并不占撤销步", () => {
  const d = scene();
  d.push(topFace(d.shape, T).faceId, 5);
  const before = d.history;
  d.push(topFace(d.shape, T + 5).faceId, 0);
  assert.equal(d.history, before, "零距离不许换历史数组");
  assert.equal(d.docCommands.undoDepth, 1, "零距离不占撤销步");
  assert.equal(d.history[1].op.dist, 5);
  near(d.volume(), vol(T + 5));
});

test("不同面推拉不合并：各自一条特征、各自一步撤销，且不动上一条定义", () => {
  const d = scene();
  d.push(topFace(d.shape, T).faceId, 5);
  const topOp = JSON.stringify(d.history[1].op);
  d.push(sideFace(d.shape, L / 2).faceId, 2);
  assert.equal(d.history.length, 3, "异面推拉必须新增特征");
  assert.equal(JSON.stringify(d.history[1].op), topOp, "上一条推拉定义不许被改");
  assert.equal(d.docCommands.undoDepth, 2);
  near(d.volume(), (L + 2) * W * (T + 5));
});

test("合并事务失败不污染：定义、实体、撤销栈都不动，之后再撤销撤的是上一条命令", () => {
  const d = scene();
  d.push(topFace(d.shape, T).faceId, 5);
  const histBefore = d.history;
  const f = topFace(d.shape, T + 5);
  d.failNextRenderTree = true;
  assert.throws(() => d.push(f.faceId, 3), /注入失败/);
  assert.equal(d.docCommands.undoDepth, 1, "失败不许增加撤销步");
  assert.equal(d.history[1].op.dist, 5, "失败后定义保持合并前");
  near(d.volume(), vol(T + 5), "失败后实体回到已提交几何");
  assert.notEqual(d.history, histBefore, "失败由事务写回快照（新数组），不是留在半途");
  d.docCommands.undo();
  near(d.volume(), vol(T), "再撤销撤的是最初那次推拉");
  assert.equal(d.history.length, 1);
});

test("撤销后重新合并：旧重做分支被丢弃，且只换被合并的那一行", () => {
  const d = scene();
  d.push(topFace(d.shape, T).faceId, 5);
  const baseRowRef = d.history[0];
  d.push(topFace(d.shape, T + 5).faceId, 3);
  assert.equal(d.history[0], baseRowRef, "改动之前的行必须原样复用（增量重建靠它）");
  const mergedRow = d.history[1];

  d.docCommands.undo();
  assert.equal(d.docCommands.redoDepth, 1);
  d.push(topFace(d.shape, T + 5).faceId, 4);
  assert.equal(d.docCommands.redoDepth, 0, "新命令必须清空重做栈");
  assert.equal(d.history[1].op.dist, 9, "新合并在 5 的基础上重算，不是沿用被撤销的 8");
  assert.equal(d.docCommands.undoDepth, 2);
  d.docCommands.undo();
  assert.equal(d.history[1].op.dist, 5, "撤销新合并回 5");
  assert.notEqual(d.history[1], mergedRow, "被撤销的合并行不许与当前行共享对象");
});

test("回滚位置（hIndex 不在末步）合并：截断过期重做分支，一次撤销整体还原", () => {
  const d = scene();
  d.push(topFace(d.shape, T).faceId, 5);              // 第 2 步
  d.push(sideFace(d.shape, L / 2).faceId, 2);         // 第 3 步
  const fullLen = d.history.length;
  assert.equal(fullLen, 3);
  d.gotoStep(1);                                      // 回到第 2 步（后面一步成为重做分支）
  near(d.volume(), vol(T + 5));
  d.push(topFace(d.shape, T + 5).faceId, 3);           // 在这里合并
  assert.equal(d.history.length, 2, "回滚位置合并后必须截断（后面的快照是按旧定义算的）");
  near(d.volume(), vol(T + 8));
  d.docCommands.undo();
  assert.equal(d.history.length, fullLen, "撤销要把整条分支还原");
  assert.equal(d.hIndex, 1);
  near(d.volume(), vol(T + 5));
});
