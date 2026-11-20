/**
 * 参数编辑事务 / 撤销栈回归（模块级，真 OCCT，无 DOM）
 *
 * 判据来源：本项目既定的「体积守恒」规则 —— 几何对不对只看体积与解析值的差。
 * 场景与父会话验收（74×46×9 + 两个 r4 凸台）刻意不同：这里是 60×40×8 底板 +
 * 两个**同半径 r6**、高度 5 / 9 的凸台，专门钉住「改目标不许动另一个同径对象」。
 *
 * 被测的是生产代码：src/param-edit.js（main.js 的 applyEdit / commit / undo 都走它）
 * 与 src/replay.js、src/project.js。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import opencascade from "replicad-opencascadejs";
import { setOC, measureVolume } from "replicad";
import {
  MAX_UNDO, createCommandStack, replaceStep, appendStep, commitStepOp, rebuildInto,
} from "./src/param-edit.js";
import { projectDefinition, restoreProject } from "./src/project.js";

setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));

const L = 60, W = 40, T = 8, R = 6, HA = 5, HB = 9;
/** 解析体积（与实现无关）：底板 + 两个凸台 */
const V = (a, b) => L * W * T + Math.PI * R * R * (a + b);
const near = (got, want, what = "") =>
  assert.ok(Number.isFinite(got) && Math.abs(got - want) < 1e-5, `${what} ${got} != ${want}`);

const plane = { kind: "datum", name: "XY", origin: [0, 0, T], normal: [0, 0, 1], xDir: [1, 0, 0] };
const boss = (x, depth) => ({
  type: "extrude", plane, entities: [{ kind: "circle", c: [x, 0], r: R }], depth, grow: 0,
});
const baseRow = () => ({
  label: "底板", detail: "解析底板", icon: "◆",
  op: { type: "primitive", shape: "box", size: [L, W, T] },
});
const bossRow = (x, depth, label) => ({ label, detail: `+${depth}mm`, icon: "⬒", op: boss(x, depth) });

/**
 * 被测文档的最薄外壳：只有 history / hIndex 两个字段 —— 与 main.js 的
 * 快照约定一致（实体就从 history[hIndex].shape 取，不另存 shape）。
 */
function makeDoc(rows) {
  const doc = { history: rows, hIndex: rows.length - 1 };
  rebuildInto(doc.history, doc.hIndex);       // 先把每步实体算出来（等价于打开工程时的重放）
  const stack = createCommandStack({
    read: () => ({ history: doc.history, hIndex: doc.hIndex }),
    write: (s) => { doc.history = s.history; doc.hIndex = s.hIndex; },
  });
  const rebuildAll = () => { rebuildInto(doc.history, doc.hIndex); };
  return {
    doc, stack,
    get volume() { return measureVolume(doc.history[doc.hIndex].shape); },
    get ops() { return doc.history.map((r) => r.op); },
    get rowCount() { return doc.history.length; },
    /** 与 main.js applyEdit 同一路径：进事务 → 换定义 + 重建（失败由事务回滚） */
    edit(index, newOp, label = `改第 ${index + 1} 步参数`) {
      return stack.run(label, () => {
        const out = commitStepOp(doc.history, doc.hIndex, index, newOp, () => "detail");
        doc.history = out.history;
        return out;
      });
    },
    /** 与 main.js commit() 同一路径：追加一个结构特征 */
    add(row) {
      return stack.run(`新建「${row.label}」`, () => {
        const out = appendStep(doc.history, doc.hIndex, row);
        doc.history = out.history;
        doc.hIndex = out.hIndex;
        rebuildAll();
      });
    },
  };
}

const scene = () => makeDoc([baseRow(), bossRow(-16, HA, "左凸台"), bossRow(16, HB, "右凸台")]);

test("场景几何先对得上解析值（下面的判据才有意义）", () => {
  const d = scene();
  near(d.volume, V(HA, HB), "基线体积");
});

test("一次参数提交 = 恰好一步撤销，只改目标、不动另一个同径凸台", () => {
  const d = scene();
  const other = JSON.stringify(d.ops[2]);
  d.edit(1, boss(-16, 13));
  assert.equal(d.stack.undoDepth, 1, "一次提交必须只记一步");
  assert.equal(d.stack.redoDepth, 0);
  assert.equal(d.doc.hIndex, 2, "参数提交不改变历史游标");
  near(d.volume, V(13, HB), "改后体积");
  assert.equal(d.ops[1].depth, 13);
  assert.equal(JSON.stringify(d.ops[2]), other, "另一个同径凸台的定义不许被碰");
  near(d.doc.history[2].toolShape.boundingBox.center[0], 16, "另一个凸台的增量体位置不变");
});

test("撤销恢复旧值与旧几何且游标不倒退；重做恢复改后几何", () => {
  const d = scene();
  d.edit(1, boss(-16, 13));
  const label = d.stack.undo();
  assert.match(String(label), /参数/);
  near(d.volume, V(HA, HB), "撤销后体积");
  assert.equal(d.ops[1].depth, HA, "撤销后旧参数必须回到定义里");
  assert.equal(d.doc.hIndex, 2, "撤销的是命令，不是历史游标");
  assert.equal(d.stack.undoDepth, 0);
  assert.equal(d.stack.redoDepth, 1);
  assert.equal(d.stack.redo(), label);
  near(d.volume, V(13, HB), "重做后体积");
  assert.equal(d.ops[1].depth, 13);
  assert.equal(d.doc.hIndex, 2);
});

test("连续两次编辑 → 连续撤销逐步回退 → 连续重做逐步前进", () => {
  const d = scene();
  d.edit(1, boss(-16, 13));
  d.edit(2, boss(16, 14));
  near(d.volume, V(13, 14));
  assert.equal(d.stack.undoDepth, 2);
  d.stack.undo();
  near(d.volume, V(13, HB), "第一次撤销只回退后一个");
  assert.equal(d.ops[1].depth, 13, "第一次撤销不许动更早的编辑");
  d.stack.undo();
  near(d.volume, V(HA, HB), "第二次撤销回到基线");
  assert.equal(d.ops[1].depth, HA);
  assert.equal(d.ops[2].depth, HB);
  d.stack.redo();
  near(d.volume, V(13, HB));
  d.stack.redo();
  near(d.volume, V(13, 14));
  assert.equal(d.ops[2].depth, 14);
});

test("编辑 → 撤销 → 新编辑：旧重做分支被丢弃，不许复活", () => {
  const d = scene();
  d.edit(1, boss(-16, 13));
  d.stack.undo();
  assert.equal(d.stack.redoDepth, 1);
  d.edit(2, boss(16, 14));
  assert.equal(d.stack.redoDepth, 0, "新命令必须清空重做栈");
  assert.equal(d.stack.undo(), "改第 3 步参数");
  near(d.volume, V(HA, HB), "撤销新编辑后回到基线（不是被丢弃的 13）");
  assert.equal(d.ops[1].depth, HA);
});

test("无变化提交不占撤销步、不重建、不改历史", () => {
  const d = scene();
  const before = d.doc.history;
  const out = d.edit(1, boss(-16, HA));
  assert.equal(out.changed, false);
  assert.equal(d.doc.history, before, "无变化时历史数组引用都不许换");
  assert.equal(d.stack.undoDepth, 0, "无变化不占撤销步");
  near(d.volume, V(HA, HB));
});

test("失败提交：抛错、定义与几何均不动、不进撤销栈，且恢复已提交画面", () => {
  const d = scene();
  d.edit(1, boss(-16, 13));
  const histAfterEdit = d.doc.history;
  const volBefore = d.volume;
  // ① 未知特征类型（重放必然失败）
  assert.throws(() => d.edit(2, { type: "not-a-feature" }), /未知的操作类型/);
  // ② 真正的内核失败：圆角半径远大于板厚，OCCT 做不出来
  const badFillet = { type: "fillet", radius: 50, edgeRefs: [{ mid: [30, 20, 0], norm: [0, 0, 0], dir: [0, 0, 1] }] };
  assert.throws(() => d.edit(1, badFillet), (e) => !!e);
  assert.equal(d.stack.undoDepth, 1, "失败不许增加撤销步");
  assert.equal(d.stack.redoDepth, 0);
  assert.equal(d.doc.hIndex, 2);
  assert.equal(d.ops[1].depth, 13, "失败后定义保持上一次成功的值");
  near(d.doc.history[2].toolShape.boundingBox.center[0], 16, "另一个凸台位置不变");
  near(d.volume, volBefore, "失败后必须回到已提交几何");
  assert.notEqual(d.doc.history, histAfterEdit, "失败后由事务写回快照（新数组），不是留在半途状态");
  // 失败之后撤销仍然只撤那一次成功提交
  d.stack.undo();
  near(d.volume, V(HA, HB), "失败后撤销回到基线");
});

test("失败后必须还原半途改动（预览态）：事务 catch 无条件写回快照", () => {
  const d = scene();
  d.edit(1, boss(-16, 13));
  const before = d.doc.history;
  assert.throws(() => d.stack.run("坏动作", () => {
    // 模拟 main.js：先把候选定义/候选实体挂上去（预览态），随后重建失败
    d.doc.history = replaceStep(d.doc.history, 2, { op: { type: "not-a-feature" } });
    rebuildInto(d.doc.history, d.doc.hIndex);
  }));
  assert.equal(d.stack.undoDepth, 1, "失败动作不进栈");
  assert.notEqual(d.doc.history, before, "必须写回快照（新数组）");
  assert.equal(d.ops[2].depth, HB, "半途改过的定义必须被还原");
  near(d.volume, V(13, HB), "画面回到已提交几何");
});

test("嵌套事务只压一次栈（内层 commit 不再单开一步）", () => {
  const d = scene();
  d.stack.run("外层动作", () => {
    const a = commitStepOp(d.doc.history, d.doc.hIndex, 1, boss(-16, 13), () => "d");
    d.doc.history = a.history;
    const b = appendStep(d.doc.history, d.doc.hIndex, bossRow(0, 4, "中间台"));
    d.doc.history = b.history; d.doc.hIndex = b.hIndex;
    rebuildInto(d.doc.history, d.doc.hIndex);
  });
  assert.equal(d.stack.undoDepth, 1, "嵌套动作 = 一步");
  near(d.volume, V(13, HB) + Math.PI * R * R * 4);
  d.stack.undo();
  near(d.volume, V(HA, HB), "一步退回嵌套动作之前");
  assert.equal(d.rowCount, 3);
});

test("结构变更与参数编辑交错：撤销严格后进先出，不互相绕过", () => {
  const d = scene();
  d.edit(1, boss(-16, 13));
  d.edit(2, boss(16, 14));
  d.add({ label: "中间新特征", detail: "6×8×5", icon: "◆",
    op: { type: "primitive", shape: "box", size: [6, 8, 5], at: [0, 0, T], mode: "add" } });
  near(d.volume, V(13, 14) + 6 * 8 * 5);
  assert.equal(d.rowCount, 4);
  d.stack.undo();
  near(d.volume, V(13, 14), "先撤销最新的结构，不是先撤旧参数");
  assert.equal(d.rowCount, 3);
  assert.equal(d.ops[1].depth, 13);
  d.stack.undo();
  near(d.volume, V(13, HB), "再撤销，才轮到更早的参数");
  assert.equal(d.ops[2].depth, HB);
  d.stack.undo();
  near(d.volume, V(HA, HB));
  d.stack.redo(); d.stack.redo(); d.stack.redo();
  near(d.volume, V(13, 14) + 6 * 8 * 5, "重做三步要能原样回来");
  assert.equal(d.rowCount, 4);
});

test("撤销后保存重开：落盘的是已提交的旧值，重开几何与撤销后一致", () => {
  const d = scene();
  d.edit(1, boss(-16, 13));
  const savedAfterEdit = projectDefinition("测试", d.doc.history, d.doc.hIndex);
  d.stack.undo();
  const savedAfterUndo = projectDefinition("测试", d.doc.history, d.doc.hIndex);
  // 落盘文件里不许出现运行时实体/哈希
  const text = JSON.stringify(savedAfterUndo);
  assert.equal(/"(wrapped|_wrapped|hashCode|toolShape)"/.test(text), false, "工程文件不许序列化运行时实体");
  assert.equal(savedAfterUndo.features[1].op.depth, HA, "撤销后保存的必须是旧值");
  assert.equal(savedAfterEdit.features[1].op.depth, 13, "改后保存的必须是新值");
  const reopenedOld = restoreProject(savedAfterUndo);
  const reopenedNew = restoreProject(savedAfterEdit);
  near(measureVolume(reopenedOld.shape), V(HA, HB), "重开旧值");
  near(measureVolume(reopenedNew.shape), V(13, HB), "重开新值");
  near(reopenedOld.history[2].toolShape.boundingBox.center[0], 16, "重开后另一个凸台位置不变");
});

test("文档边界：clear 之后撤销栈为空，不会跨文档撤销", () => {
  const d = scene();
  d.edit(1, boss(-16, 13));
  d.stack.clear();
  assert.equal(d.stack.undoDepth, 0);
  assert.equal(d.stack.redoDepth, 0);
  assert.equal(d.stack.undo(), null, "没有命令可撤销时返回 null（交给历史步进）");
  near(d.volume, V(13, HB), "clear 不许动文档本身");
});

test("快照与当前历史隔离：撤销后篡改当前行，重做仍给出正确几何", () => {
  const d = scene();
  d.edit(1, boss(-16, 13));
  const liveRows = d.doc.history.slice();
  d.stack.undo();
  // 还原出来的行必须是新对象，不能和快照共享可变行
  assert.notEqual(d.doc.history[1], liveRows[1]);
  d.doc.history[1].shape = null;            // 恶意破坏当前行
  d.doc.history[1].op = { type: "extrude", depth: 99 };
  d.stack.redo();
  near(d.volume, V(13, HB), "重做必须来自快照，不受当前行被改的污染");
  assert.equal(d.ops[1].depth, 13);
  d.stack.undo();
  near(d.volume, V(HA, HB), "再撤销仍能回到基线");
});

test("撤销栈有上限，且不因超限错位", () => {
  const rows = [baseRow()];
  const doc = { history: rows, hIndex: 0 };
  const stack = createCommandStack({
    read: () => ({ history: doc.history, hIndex: doc.hIndex }),
    write: (s) => { doc.history = s.history; doc.hIndex = s.hIndex; },
    limit: 3,
  });
  for (let k = 1; k <= 5; k++) {
    stack.run(`第 ${k} 次`, () => {
      doc.history = replaceStep(doc.history, 0, { detail: `d${k}` });
    });
  }
  assert.equal(stack.undoDepth, 3);
  assert.equal(MAX_UNDO >= 3, true);
  stack.undo(); stack.undo(); stack.undo();
  assert.equal(stack.undo(), null);
  assert.equal(doc.history[0].detail, "d2", "只保留最近 3 步 → 最早可回到 d2");
});

test("replaceStep 不可变：入参数组与其它行不被改写", () => {
  const rows = [baseRow(), bossRow(-16, HA, "左"), bossRow(16, HB, "右")];
  const next = replaceStep(rows, 1, { detail: "x" });
  assert.notEqual(next, rows, "换代而不是就地改");
  assert.equal(next[0], rows[0], "改动之前的行原样复用（增量重放靠它）");
  assert.notEqual(next[1], rows[1], "被改的行必须是新对象");
  assert.notEqual(next[2], rows[2], "改动之后的行也要换新，避免回填 shape 时污染旧数组/旧快照");
  assert.equal(rows[1].detail, "+5mm", "入参数组保持原样");
  assert.equal(next[1].detail, "x");
  assert.equal(next[1].op, rows[1].op, "未改的字段共享同一引用，不做深拷贝");
  assert.equal(next[2].op, rows[2].op);
});
