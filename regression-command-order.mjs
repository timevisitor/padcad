/**
 * 动作全序回归（D2）：跳步必须与底栏时间线走同一个入口 jumpToStep（进命令栈）
 *
 * 独立复核实测（REQUEST_CHANGES D2）：左栏结构树 `renderFeatTree` 的行点击是裸
 * `gotoStep(i)`，而底栏时间线 `renderTree` 已改成 `jumpToStep`。后果：
 *   改参数（undoDepth=1）→ 左树点第 1 步（hIndex 2→0，undoDepth 仍 1）→ 按撤销：
 *   弹的是「把拉伸深度改为 9mm」，hIndex 被一起搬回 2 —— **一次撤销回滚两个用户动作**，
 *   跳步本身无法单独撤销。
 *
 * 两条互相独立的判据：
 *   ① 行为：把 main.js 的 `gotoStep` / `jumpToStep` / `undo` 原文抠进 vm（其余是边界替身），
 *      断言「跳步 = 一步命令 + 标签对 + 撤销只撤跳步」；
 *   ② 源码契约：两个入口的点击处理器都必须调用 jumpToStep，不许出现裸 gotoStep(i)。
 *      只断言 ① 会被「jumpToStep 行为对但没人调用」骗过；只断言 ② 会被「调了但没进栈」骗过。
 *
 * 场景：60×40×8 底板 + 两个 r5 凸台（深 4 / 深 7），解析体积可闭式核对。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import opencascade from "replicad-opencascadejs";
import { setOC, measureVolume } from "replicad";
import { createCommandStack, commitStepOp, rebuildInto } from "./src/param-edit.js";

setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));

const L = 60, W = 40, T = 8, R = 5, HA = 4, HB = 7;
const V = (a, b) => L * W * T + Math.PI * R * R * (a + b);
const near = (got, want, what = "") =>
  assert.ok(Number.isFinite(got) && Math.abs(got - want) < 1e-5, `${what} ${got} != ${want}`);

const source = fs.readFileSync("./src/main.js", "utf8");
function appFunction(name) {
  const m = source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "m"));
  assert.ok(m, `main.js 里找不到 function ${name}（改名了就同步改夹具）`);
  return m[0];
}

const plane = { kind: "datum", name: "XY", origin: [0, 0, T], normal: [0, 0, 1], xDir: [1, 0, 0] };
const boss = (x, depth) => ({ type: "extrude", plane, entities: [{ kind: "circle", c: [x, 0], r: R }], depth, grow: 0 });
const rows = () => [
  { label: "底板", detail: "解析底板", icon: "◆", op: { type: "primitive", shape: "box", size: [L, W, T] } },
  { label: "左凸台", detail: `+${HA}mm`, icon: "⬒", op: boss(-16, HA) },
  { label: "右凸台", detail: `+${HB}mm`, icon: "⬒", op: boss(16, HB) },
];

function doc() {
  const history = rows();
  rebuildInto(history, history.length - 1);
  const c = {
    history, hIndex: 2, shape: null, mode: "select",
    performance,
    commitStepOp,
    // 边界替身：gotoStep 里的浮层/模式清理与本回归无关
    dim: { hide() {} },
    cancelEdit() {}, exitSketch() {}, exitEdgeMode() {}, exitLinkMode() {}, cancelSmartDim() {},
    selectFace() {},
    viewer: { clearHighlight() {}, clearSketchLines() {}, setEdgeData() {} },
    refresh() {}, renderTree() {},
    lastMessage: "",
    setStats(t) { c.lastMessage = String(t); },
    $: () => ({ textContent: "" }),
  };
  c.shape = history[2].shape;
  const ctx = vm.createContext(c);
  c.docCommands = createCommandStack({
    read: () => ({ history: c.history, hIndex: c.hIndex }),
    write: (snap) => {
      c.history = snap.history;
      c.hIndex = snap.hIndex;
      c.shape = c.hIndex >= 0 ? (c.history[c.hIndex]?.shape ?? null) : null;
    },
  });
  for (const name of ["gotoStep", "jumpToStep", "undo", "redo", "detailOf"]) {
    vm.runInContext(appFunction(name), ctx);
  }
  c.ctx = ctx;
  c.volume = () => measureVolume(c.shape);
  c.edit = (index, newOp) => c.docCommands.run(`改第 ${index + 1} 步参数`, () => {
    const out = commitStepOp(c.history, c.hIndex, index, newOp, c.detailOf);
    c.history = out.history;
    c.shape = out.shape;
    return out;
  });
  c.jump = (i) => vm.runInContext(`jumpToStep(${i})`, ctx);
  return c;
}

test("场景几何先对得上解析值", () => {
  const d = doc();
  near(d.volume(), V(HA, HB), "基线体积");
});

test("跳步 = 一步命令：标签可读，撤销只回游标、不动几何定义", () => {
  const d = doc();
  d.jump(0);
  assert.equal(d.hIndex, 0, "游标跳到第 1 步");
  assert.equal(d.docCommands.undoDepth, 1, "跳步必须进命令栈");
  assert.match(String(d.docCommands.undoLabel), /回到第 1 步/);
  near(d.volume(), L * W * T, "画面切到第 1 步的几何");
  assert.equal(d.docCommands.undo(), "回到第 1 步：底板");
  assert.equal(d.hIndex, 2, "撤销跳步后游标回来");
  near(d.volume(), V(HA, HB), "几何回到末步");
  assert.equal(d.history[2].op.depth, HB, "跳步没有改任何定义");
});

test("改参数 → 跳步 → 撤销：只撤跳步；再撤销才轮到参数（这就是 D2 的核心）", () => {
  const d = doc();
  d.edit(1, boss(-16, 9));
  near(d.volume(), V(9, HB), "改参数后体积");
  assert.equal(d.docCommands.undoDepth, 1);

  d.jump(0);
  assert.equal(d.hIndex, 0);
  assert.equal(d.docCommands.undoDepth, 2, "跳步自己占一步");

  d.undo();
  assert.equal(d.hIndex, 2, "第一次撤销只回跳步（不许把参数一起搬走）");
  assert.equal(d.history[1].op.depth, 9, "参数改动仍在");
  near(d.volume(), V(9, HB), "几何仍是改后的");

  d.undo();
  assert.equal(d.history[1].op.depth, HA, "第二次撤销才撤参数");
  near(d.volume(), V(HA, HB));
  assert.equal(d.hIndex, 2, "参数撤销不搬游标");
});

test("同一位置重复跳步不占额外撤销步", () => {
  const d = doc();
  d.jump(2);                       // 本来就在末步 → 无变化
  assert.equal(d.docCommands.undoDepth, 0);
  d.jump(1);
  d.jump(1);
  assert.equal(d.docCommands.undoDepth, 1, "第二次同位置跳步无变化，不许再多一步");
});

test("源码契约：左栏结构树与底栏时间线用同一个 jumpToStep 入口", () => {
  const feat = source.slice(source.indexOf('for (const n of el.querySelectorAll(".ft-node"))'));
  const featHandler = feat.slice(0, 900);
  assert.match(featHandler, /jumpToStep\(i\)/, "左栏结构树点行必须走 jumpToStep（进命令栈）");
  assert.equal(/^\s*gotoStep\(i\);/m.test(featHandler), false, "不许再有裸 gotoStep(i)");

  const timeline = source.slice(source.indexOf('for (const it of el.querySelectorAll(".tree-item"))'));
  assert.match(timeline.slice(0, 800), /jumpToStep\(\+it\.dataset\.i\)/, "底栏时间线必须走 jumpToStep");
});

test("B1 收尾：底栏 ✎ 只对游标之后的步骤先跳步（否则确认后截断下游特征）", () => {
  const at = source.indexOf('const ed = ev.target.closest?.("[data-ed]")');
  assert.ok(at > 0, "找不到底栏 ✎ 的处理代码（改了就同步改夹具）");
  const block = source.slice(at, at + 700);
  // 游标之后的步骤：先 jumpToStep 落位（进命令栈，不再静默搬游标）
  assert.match(block, /if \(i > hIndex\) jumpToStep\(i\)/, "底栏 ✎ 必须先判断游标再跳步");
  // 游标之前的步骤：绝对不许先跳 —— 跳完再确认改参数会按「回滚位置改参数」截断下游分支
  assert.equal(/^\s*jumpToStep\(i\);$/m.test(block), false, "不许无条件 jumpToStep(i)（会把游标往回搬）");
  assert.match(block, /editStep\(i\)/, "跳步之后仍要打开参数面板");
});
