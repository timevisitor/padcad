/**
 * A1 回归：生成型特征（拉伸/旋转/扫掠/放样/阵列）的 toolShape 必须落在**事务内**的行上，
 * 否则「撤销 → 重做」之后这一行没有 toolShape，阵列/镜像的源列表变空、直接报
 * 「先创建草图拉伸、旋转等特征…」——用户看到的是**功能坏了**，不是几何坏了。
 *
 * 为什么必须单独钉这一条（独立代码审查 A1，2026-11-16）：
 *   统一命令栈的 `after` 快照在 `docCommands.run()` 返回**之前**就拍完了
 *   （src/param-edit.js 的 `freeze`）；而 5 处 `history[history.length - 1].toolShape = tool`
 *   原来写在 `commit()` **之后**（事务外）→ 快照里这一行没有 toolShape。
 *   撤销后重做把快照行装回来 → `history[hIndex].toolShape === undefined`。
 *   `replay.js` 会在下一次重建时自愈，所以它是个「假失败窗口」：
 *   几何一直是对的，但用户点了阵列就是打不开。
 *
 * 两条互相独立的判据（缺一条会被骗过）：
 *   ① 行为：真 `commit()` 源码 + 真命令栈 —— 撤/重做后 toolShape 仍在、源列表非空；
 *   ② 源码契约：`commit` 的 tool 参数在行构造时落地（事务内），且 5 个生成型落笔点
 *      都把产出实体交给 commit，全仓不再有「事务外补写 toolShape」。
 *
 * 反向对照（证明断言抓得住旧缺陷）：把行上的 toolShape 删掉（复刻修前状态）时，
 * 同一个 `openPatternEditor` 必须给出那句错误提示且不打开面板。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { createCommandStack, appendStep } from "./src/param-edit.js";
import { normalizePatternOp } from "./src/pattern.js";

const source = fs.readFileSync("./src/main.js", "utf8");
function appFunction(name) {
  const m = source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "m"));
  assert.ok(m, `main.js 里找不到 function ${name}（改名了就同步改夹具）`);
  return m[0];
}
const near = (a, b, what = "") => assert.ok(Number.isFinite(a) && Math.abs(a - b) < 1e-9, `${what} ${a} != ${b}`);

const BASE = {
  id: "S0",
  // pattern.js 的 boundsOf 会读 boundingBox 并要求能 clone（真实体同款最小形状）
  boundingBox: { center: [0, 0, 4], width: 60, height: 40, depth: 8 },
  clone() { return this; },
  faces: [],
};
/**
 * 底板自己也带 toolShape —— 这不是凑数：脚本通道（main.js 的 `shape: r.shape, toolShape: r.tool || null`）
 * 给**每一行**都记了产出体，所以「底板/长方体」本来就在源列表里。
 * 父验收实测：删掉拉伸行的 toolShape 后，源列表**仍非空**（只剩 {value:'0', 长方体}）→
 * 只断言「列表非空」会被底板骗过。本夹具因此必须断言命中的是拉伸那一行的 index。
 */
const BASE_TOOL = { id: "T-base-box" };

/** 真 commit + 真命令栈 + 真 openPatternEditor；其余边界一律替身（不建几何） */
function doc() {
  const c = {
    history: [{ label: "底板", detail: "", icon: "◆", op: { type: "base" }, shape: BASE, toolShape: BASE_TOOL }],
    hIndex: 0,
    shape: BASE,
    mode: "select",
    appMode: "model",
    lastMessage: "",
    patternSession: null,
    FEATURE_ICON: { base: "▣", extrude: "⬒", revolve: "↻", sweep: "∼", loft: "⌒", pattern: "⁘", mirror: "⇋" },
    featureDisplayName: (h, i) => h.customName || `${h.label}${i}`,
    normalizePatternOp,
    patternPanel: {
      opened: null,
      open(o) { c.patternPanel.opened = o; },
      status(m) { c.lastMessage = String(m); },
      close() { c.patternPanel.opened = null; },
    },
    markSnapshot() {},
    appendStep,
    renderTree() {},
    setStats(t) { c.lastMessage = String(t); },
    cancelEdit() {}, selectFace() {}, refresh() {},
    exitEdgeMode() { c.mode = "select"; }, exitLinkMode() { c.mode = "select"; },
    cancelSmartDim() { c.mode = "select"; }, exitSketch() { c.mode = "select"; },
    gotoStep(i) { c.hIndex = i; },
    setMode(m) { c.mode = m; },
    patternSessionOf: () => c.ctx.patternSession ?? null,
  };
  const ctx = vm.createContext(c);
  c.docCommands = createCommandStack({
    read: () => ({ history: c.history, hIndex: c.hIndex }),
    write: (snap) => {
      c.history = snap.history;
      c.hIndex = snap.hIndex;
      c.shape = c.hIndex >= 0 ? (c.history[c.hIndex]?.shape ?? null) : null;
    },
  });
  for (const name of ["commit", "openPatternEditor"]) vm.runInContext(appFunction(name), ctx);
  c.ctx = ctx;
  /** 直接走真 commit（第 5 参 = 这个特征产出的那块材料） */
  c.commitWithTool = (type, op, tool) => vm.runInContext(
    `commit(${JSON.stringify(type)}, "detail", ${JSON.stringify(type)}, opArg, toolArg)`,
    Object.assign(ctx, { opArg: op, toolArg: tool }),
  );
  return c;
}

const TOOL = { id: "T-tool-shape" };

test("五种生成型特征：toolShape 在 commit 内就落到行上（事务内）", () => {
  for (const type of ["extrude", "revolve", "sweep", "loft", "pattern"]) {
    const d = doc();
    d.commitWithTool(type, { type, depth: 5 }, TOOL);
    assert.equal(d.history.length, 2, `${type}: 应该新增一行`);
    assert.equal(d.history[d.hIndex].toolShape, TOOL, `${type}: 行上必须有 toolShape`);
    assert.equal(d.docCommands.undoDepth, 1, `${type}: 新建特征占一步`);
  }
});

test("A1 核心：撤销 → 重做之后 toolShape 仍在（修前这里是 undefined）", () => {
  for (const type of ["extrude", "revolve", "sweep", "loft", "pattern"]) {
    const d = doc();
    d.commitWithTool(type, { type, depth: 5 }, TOOL);
    assert.equal(d.docCommands.undo(), `新建「${type}」`);
    assert.equal(d.history.length, 1, `${type}: 撤销后回到只有底板`);
    assert.equal(d.docCommands.redo(), `新建「${type}」`);
    assert.equal(d.history.length, 2);
    assert.equal(d.hIndex, 1);
    assert.deepEqual(d.history[d.hIndex].toolShape, TOOL, `${type}: 重做后 toolShape 丢了`);
  }
});

test("A1 核心：撤销→重做后阵列/镜像源列表仍含「拉伸」那一行（不是只看非空）", () => {
  const d = doc();
  d.commitWithTool("extrude", { type: "extrude", depth: 5 }, TOOL);
  d.docCommands.undo();
  d.docCommands.redo();
  assert.equal(d.patternPanel.opened, null, "前置：还没有打开过面板");
  d.mode = "select";
  vm.runInContext("openPatternEditor('linear')", d.ctx);
  const opened = d.patternPanel.opened;
  assert.ok(opened, `面板没打开 —— 状态栏说：${d.lastMessage}`);
  const indexes = opened.sources.map((s) => s.index);
  // 底板（index 0）自带 toolShape，所以列表本来就非空 —— 必须命中拉伸那一行
  assert.deepEqual(indexes, [0, 1], `源列表必须同时含底板与拉伸，实际 ${JSON.stringify(indexes)}`);
  assert.ok(!/先创建草图拉伸/.test(d.lastMessage), `状态栏不该报源为空：${d.lastMessage}`);
  // 面板真的能把源选成 1 并读出来（读不动的话用户还是没法阵列）
  const chosen = opened.op?.source;
  assert.equal(chosen, 1, `默认源必须指向拉伸那一行，实际 ${chosen}`);
});

test("反向对照：只删拉伸行的 toolShape 时，源列表仍非空但**没有拉伸**（父验收的陷阱）", () => {
  const d = doc();
  d.commitWithTool("extrude", { type: "extrude", depth: 5 }, TOOL);
  d.docCommands.undo();
  d.docCommands.redo();
  // 复刻修前状态：快照行里没有 toolShape
  delete d.history[d.hIndex].toolShape;
  d.patternPanel.opened = null;
  vm.runInContext("openPatternEditor('linear')", d.ctx);
  const opened = d.patternPanel.opened;
  const indexes = opened ? opened.sources.map((s) => s.index) : [];
  assert.deepEqual(indexes, [0], `只剩底板时才复刻出旧缺陷，实际 ${JSON.stringify(indexes)}`);
  assert.ok(!indexes.includes(1), "拉伸行不该还能当源");
});

test("失败 / 取消不占步：事务抛错整体回滚，行上不残留 toolShape", () => {
  const d = doc();
  const before = d.history;
  assert.throws(() => d.docCommands.run("新建「拉伸」", () => {
    d.commitWithTool("extrude", { type: "extrude", depth: 5 }, TOOL);
    throw new Error("内核失败（模拟）");
  }), /内核失败/);
  assert.equal(d.docCommands.undoDepth, 0, "失败不许占撤销步");
  assert.equal(d.history.length, 1, "回滚后只剩底板那一行");
  assert.equal(d.history[d.hIndex].toolShape, BASE_TOOL, "回滚必须还原原始行（不许留下半写的 toolShape）");

  // 取消 = 事务里什么都没改 → 同样不占步
  const ctx2 = doc();
  ctx2.docCommands.run("取消的操作", () => {});
  assert.equal(ctx2.docCommands.undoDepth, 0, "无变化不占步");
  assert.equal(ctx2.history.length, 1);
  void before;
});

test("源码契约：5 个生成型落笔点把产出交给 commit，且不再有任何事务外补写 toolShape", () => {
  assert.equal(/history\[history\.length - 1\]\.toolShape\s*=/.test(source), false,
    "不许再在 commit() 之后补写 toolShape（那不在 after 快照里）");
  assert.equal(/history\[hIndex\]\.toolShape\s*=/.test(source), false,
    "阵列分支同样不许事务外补写");

  const commitSrc = appFunction("commit");
  assert.match(commitSrc, /function commit\([^)]*tool/, "commit 必须接收 tool 参数");
  assert.match(commitSrc, /toolShape\s*:\s*tool/, "toolShape 必须在行构造时落地（事务内）");

  const bodies = {
    applyExtrude: /\bcommit\([^;]*?,\s*tool\s*\)/s,
    applyRevolve: /\bcommit\([^;]*?,\s*tool\s*\)/s,
    applySweep: /\bcommit\([^;]*?,\s*solid\s*\)/s,
    applyLoft: /\bcommit\([^;]*?,\s*solid\s*\)/s,
    evaluatePatternEditor: /\bcommit\([^;]*?,\s*result\.tool\s*\)/s,
  };
  for (const [name, re] of Object.entries(bodies)) {
    const body = appFunction(name);
    assert.match(body, re, `${name} 里没把工具实体交给 commit`);
  }
});

test("toolShape 缺省为 null —— 与 replay/预览的「无 toolShape」判定等价（不许变成别的真值）", () => {
  const d = doc();
  d.commitWithTool("pushpull", { type: "pushpull", dist: 3 }, null);
  assert.equal(d.history[d.hIndex].toolShape, null);
  assert.ok(!d.history[d.hIndex].toolShape, "falsy 语义必须保持（replay 用它判缺 toolShape）");
  near(1, 1);
});
