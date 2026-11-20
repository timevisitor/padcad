/**
 * v6 智能草图 · 自由度/冲突分析回归
 *
 * 全部用**解析值**断言：每个用例的自由度、秩、冗余/冲突的归属都是纸上算得出来的整数，
 * 不靠“看着差不多”。判据来源见 智能草图/调研.md（JSketcher diagnose、planegcs System::diagnose）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as Solver from "./src/solver.js";
import {
  analyzeSketch, summarizeAnalysis, entityColors, stateOfEntity, SKETCH_STATES,
} from "./src/sketch-dof.js";

const rect = (c = [0, 0], w = 20, h = 10) => [{ kind: "rect", c: c.slice(), w, h }];
const fullRect = () => [
  { type: "fixed", e: 0, k: "w", value: 20, label: "宽 20" },
  { type: "fixed", e: 0, k: "h", value: 10, label: "高 10" },
  { type: "fixedPoint", p: { e: 0, p: "center" }, x: 0, y: 0, label: "中心固定" },
];

test("自由矩形：4 个参数就是 4 个自由度，图元状态是欠定义（蓝）", () => {
  const a = analyzeSketch(rect(), []);
  assert.equal(a.params, 4);
  assert.equal(a.rank, 0);
  assert.equal(a.dof, 4);
  assert.equal(a.dofApproximate, false);
  assert.equal(a.status, "underdefined");
  assert.equal(a.entities.length, 1);
  assert.equal(a.entities[0].state, "underdefined");
  assert.equal(a.entities[0].color, SKETCH_STATES.underdefined.color);
  assert.equal(SKETCH_STATES.underdefined.color, "#2f6fed");   // SW：欠定义 = 蓝
  assert.deepEqual(a.entities[0].movableParams.sort(), ["#0.cx", "#0.cy", "#0.h", "#0.w"]);
});

test("矩形 + 宽高尺寸 + 固定中心：自由度 0，图元完全定义（黑）", () => {
  const a = analyzeSketch(rect(), fullRect());
  assert.equal(a.params, 4);
  assert.equal(a.rank, 4);
  assert.equal(a.dof, 0);
  assert.equal(a.status, "defined");
  assert.equal(a.entities[0].state, "defined");
  assert.equal(a.entities[0].color, SKETCH_STATES.defined.color);
  assert.equal(SKETCH_STATES.defined.color, "#1f2328");        // SW：完全定义 = 黑
  assert.equal(a.redundant.length, 0);
  assert.equal(a.conflicts.length, 0);
  assert.deepEqual(a.messages, ["完全定义（没有剩余自由度）"]);
  assert.equal(summarizeAnalysis(a), "完全定义");
});

test("重复的宽尺寸识别为冗余，而不是冲突（几何仍然完全定义）", () => {
  const specs = [...fullRect(), { type: "fixed", e: 0, k: "w", value: 20, label: "宽 20 重复" }];
  const a = analyzeSketch(rect(), specs);
  assert.equal(a.dof, 0);
  assert.equal(a.status, "defined");
  assert.equal(a.redundant.length, 1);
  assert.equal(a.redundant[0].index, 3);          // 后加的那条才算冗余
  assert.deepEqual(a.redundant[0].with, [0]);
  assert.equal(a.conflicts.length, 0);
  assert.match(a.messages[1], /#4（宽 20 重复）是冗余的/);
});

test("角点距离 = 宽 是**线性相关**的方程：同样判成冗余，自由度不变", () => {
  const specs = [...fullRect(), { type: "distance", a: { e: 0, p: "bl" }, b: { e: 0, p: "br" }, value: 20, label: "底边 20" }];
  const a = analyzeSketch(rect(), specs);
  assert.equal(a.dof, 0);
  assert.equal(a.redundant.length, 1);
  assert.equal(a.redundant[0].index, 3);
  assert.equal(a.conflicts.length, 0);
});

test("两条矛盾的宽尺寸：识别为冲突、指出是哪两条、并给出可删的那条", () => {
  const specs = [
    { type: "fixed", e: 0, k: "w", value: 20, label: "宽 20" },
    { type: "fixed", e: 0, k: "w", value: 30, label: "宽 30" },
  ];
  const a = analyzeSketch(rect(), specs);
  assert.equal(a.status, "overdefined");
  assert.equal(a.dof, 3);                        // 只定了一个方向：w
  assert.equal(a.conflicts.length, 1);
  const c = a.conflicts[0];
  // 两条尺寸在残差上并列（解停在 w=25，两边各差 5），谁当“元凶”取决于浮点尾数，
  // 所以这里断言**语义**而不是具体下标：组必须是这两条、能指出对方、且给出可删的一条。
  assert.deepEqual(c.group, [0, 1]);
  assert.deepEqual([...c.with, c.index].sort(), [0, 1]);
  assert.ok(c.removable === 0 || c.removable === 1);
  assert.deepEqual(c.pair.sort(), [0, 1]);
  assert.match(a.messages[1], /#1（宽 20）|#2（宽 30）/);
  assert.match(a.messages.join("、"), /冲突/);
  // 「删掉之后能解通」这件事要真的成立：把 removable 拿掉，剩下的不再冲突
  const rest = specs.filter((_, i) => i !== c.removable);
  const after = analyzeSketch(rect(), rest);
  assert.equal(after.conflicts.length, 0);
  assert.equal(after.status, "underdefined");
  // 反向：把**另一条**留下也能解通（说明这两条本身各自都没问题，只是不能共存）
  const other = analyzeSketch(rect(), [specs[c.removable]]);
  assert.equal(other.conflicts.length, 0);
  assert.equal(a.entities[0].state, "conflict");
  assert.equal(a.entities[0].color, SKETCH_STATES.conflict.color);
  assert.equal(SKETCH_STATES.conflict.color, "#e0362c");        // SW：过定义 = 红
  // 求解器停在两者之间：|20−25| = |30−25| = 5
  assert.equal(a.solve.ok, false);
  assert.ok(Math.abs(a.solve.maxErr - 5) < 1e-6, `maxErr=${a.solve.maxErr}`);
  assert.equal(summarizeAnalysis(a).startsWith("过定义"), true);
});

test("线段端点重合 + 水平：秩 2（水平被重合吸收），自由度 2 —— 解析值", () => {
  const ents = [{ kind: "polyline", pts: [[0, 0], [10, 2]], closed: false }];
  const specs = [
    { type: "coincident", a: { e: 0, p: "p0" }, b: { e: 0, p: "p1" }, label: "重合" },
    { type: "horizontal", a: { e: 0, p: "p0" }, b: { e: 0, p: "p1" }, label: "水平" },
  ];
  const a = analyzeSketch(ents, specs);
  assert.equal(a.params, 4);
  assert.equal(a.rank, 2);                       // 重合 2 条方程；水平与其中一条相同
  assert.equal(a.dof, 2);
  assert.equal(a.redundant.length, 1);
  assert.equal(a.redundant[0].index, 1);         // 水平是冗余的
  assert.equal(a.status, "underdefined");        // 端点重合后仍可整体平移/拉伸
});

test("两段折线首尾重合 + 都水平：8 参数、秩 4、自由度 4（解析值）", () => {
  const ents = [
    { kind: "polyline", pts: [[0, 0], [10, 0]], closed: false },
    { kind: "polyline", pts: [[10, 0], [10, 5]], closed: false },
  ];
  const specs = [
    { type: "coincident", a: { e: 0, p: "p1" }, b: { e: 1, p: "p0" } },   // 2 条方程
    { type: "horizontal", a: { e: 0, p: "p0" }, b: { e: 0, p: "p1" } },   // y0 = y1
    { type: "horizontal", a: { e: 1, p: "p0" }, b: { e: 1, p: "p1" } },   // y2 = y3（与 y1=y2 联立后仍独立）
  ];
  const a = analyzeSketch(ents, specs);
  assert.equal(a.params, 8);
  // 方程：重合 x1=x2、y1=y2（2 条）+ 水平 y0=y1 + 水平 y2=y3 = 4 条独立方程
  assert.equal(a.rank, 4);
  assert.equal(a.dof, 4);
  assert.equal(a.status, "underdefined");
  assert.equal(a.redundant.length, 0);
});

test("fixedPoint 是**两条**方程：只固定中心就能吃掉 2 个自由度", () => {
  const a = analyzeSketch(rect(), [{ type: "fixedPoint", p: { e: 0, p: "center" }, x: 5, y: 5 }]);
  assert.equal(a.params, 4);
  assert.equal(a.rank, 2);
  assert.equal(a.dof, 2);
  assert.deepEqual(a.entities[0].movableParams.sort(), ["#0.h", "#0.w"]);
  // 参数级可动度：中心两个参数被钉住 → mobility 0
  const byName = Object.fromEntries(a.paramsList.map((p) => [p.name, p]));
  assert.equal(byName["#0.cx"].mobility, 0);
  assert.equal(byName["#0.cy"].mobility, 0);
  assert.ok(byName["#0.w"].mobility > 0.9);
});

test("coincident 也是两条方程（不是一条 hypot）", () => {
  const ents = [{ kind: "polyline", pts: [[0, 0], [0, 0]], closed: false }];
  const a = analyzeSketch(ents, [{ type: "coincident", a: { e: 0, p: "p0" }, b: { e: 0, p: "p1" } }]);
  assert.equal(a.params, 4);
  assert.equal(a.rank, 2);
  assert.equal(a.dof, 2);
});

test("引用图元不算自由度，也不参与状态着色（灰）", () => {
  const ents = [
    { kind: "rect", c: [0, 0], w: 20, h: 10 },
    { kind: "polyline", pts: [[0, 5], [10, 5]], closed: false, ref: true },
  ];
  const a = analyzeSketch(ents, []);
  assert.equal(a.params, 4);
  assert.equal(a.dof, 4);
  assert.equal(a.entities[1].state, "reference");
  assert.equal(a.entities[1].color, SKETCH_STATES.reference.color);
});

test("analyzeSketch 不改动入参（UI 每次重绘都要调它）", () => {
  const ents = rect([1, 2], 30, 40);
  const specs = [fullRect()[2]];
  const before = structuredClone(ents);
  const specBefore = structuredClone(specs);
  analyzeSketch(ents, specs);
  assert.deepEqual(ents, before);
  assert.deepEqual(specs, specBefore);
});

test("solveSketch 与 analyzeSketch 的自由度一致（同一个秩定义）", () => {
  const ents = rect();
  const specs = fullRect();
  const solved = Solver.solveSketch(ents, specs);
  const a = analyzeSketch(rect(), specs);
  assert.equal(solved.dof, 0);
  assert.equal(solved.dof, a.dof);
  assert.equal(solved.rank, a.rank);
  assert.equal(solved.dofApproximate, false);
  assert.equal(solved.equations, a.equations);
});

test("坏约束定义：分析能给出 invalid 状态，不抛异常", () => {
  const a = analyzeSketch(rect(), [{ type: "futureConstraint", value: 1 }]);
  assert.equal(a.status, "invalid");
  assert.equal(a.ok, false);
  assert.ok(a.messages.length > 0);
  assert.ok(a.invalidConstraints.length > 0);
});

test("稀疏 Jacobian 与稠密 Jacobian 逐元素相同（性能优化的正确性护栏）", () => {
  const ents = [
    { kind: "rect", c: [0, 0], w: 20, h: 10 },
    { kind: "circle", c: [3, 4], r: 3 },
    { kind: "polyline", pts: [[0, 0], [10, 0], [10, 10]], closed: false },
  ];
  const specs = [
    { type: "fixed", e: 0, k: "w", value: 20 },
    { type: "distance", a: { e: 2, p: "p0" }, b: { e: 2, p: "p1" }, value: 10 },
    { type: "horizontal", a: { e: 2, p: "p0" }, b: { e: 2, p: "p1" } },
    { type: "tangent", e: 1, l: { e: 2, seg: 1 } },
    { type: "parallel", l1: { e: 0, seg: 0 }, l2: { e: 2, seg: 0 } },
    { type: "coincident", a: { e: 1, p: "center" }, b: { e: 2, p: "p2" } },
    { type: "symmetric", a: { e: 0, p: "bl" }, b: { e: 0, p: "br" }, l: { e: 2, seg: 1 } },
    { type: "equalLength", l1: { e: 0, seg: 1 }, l2: { e: 2, seg: 1 } },
    { type: "midpoint", p: { e: 2, p: "p2" }, l: { e: 0, seg: 2 } },
  ];
  const cs = Solver.buildConstraints(ents, specs);
  const params = Solver.collectParams(ents);
  const rows = Solver.constraintEquationRows(cs);
  const deps = Solver.buildParamDeps(params, ents, specs);
  const dense = Solver.equationJacobian(params, cs, rows, null);
  const sparse = Solver.equationJacobian(params, cs, rows, deps);
  assert.equal(dense.length, rows.length);
  let maxDiff = 0;
  for (let i = 0; i < dense.length; i++) {
    for (let j = 0; j < dense[i].length; j++) maxDiff = Math.max(maxDiff, Math.abs(dense[i][j] - sparse[i][j]));
  }
  assert.equal(maxDiff, 0);
  // 稀疏表确实“稀疏”：绝大多数 (参数, 约束) 对不相关
  const related = deps.reduce((s, list) => s + list.length, 0);
  assert.ok(related < params.length * specs.length, `${related} 应远小于 ${params.length * specs.length}`);
});

test("带冗余约束时求解仍成功，但 dof 按真实秩算（不是 n − m）", () => {
  const ents = rect();
  const specs = [
    { type: "fixed", e: 0, k: "w", value: 20 },
    { type: "fixed", e: 0, k: "w", value: 20 },     // 重复
  ];
  const r = Solver.solveSketch(ents, specs);
  assert.equal(r.ok, true);
  assert.equal(r.dof, 3);                           // n=4, rank=1
  assert.equal(r.equations, 2);                     // 两条方程
  assert.ok(Array.isArray(r.dependent));
  assert.ok(r.dependent.length > 0);
});

test("stateOfEntity / entityColors 供 UI 逐图元上色", () => {
  const a = analyzeSketch(rect(), fullRect());
  assert.equal(stateOfEntity(a, 0).state, "defined");
  assert.equal(stateOfEntity(a, 99), null);
  assert.deepEqual(entityColors(a), { 0: "#1f2328" });
});
