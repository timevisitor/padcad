/**
 * v6 智能草图 · 拖动保约束回归
 *
 * 判据：拖到哪必须**精确**到哪（机械臂式断言，1e-9），被约束住时必须 blocked 且**原几何一点不动**，
 * 已有约束在拖动后必须仍然成立（用解析几何量核对）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { dragSolve, dragPreview, connectedComponent } from "./src/sketch-drag.js";
import { solveSketch } from "./src/solver.js";

const rect = (c = [0, 0], w = 20, h = 10) => [{ kind: "rect", c: c.slice(), w, h }];
/*
 * 拖动的收敛判据是**残差**（tolErr=1e-9），软目标残差还乘了权重 0.02，
 * 所以落点误差量级 ≈ 5e-8 mm（实测 2e-8 ~ 5e-8，即 0.05 纳米）。
 * 断言取 1e-6 mm：比任何加工公差低 3 个数量级，同时不会因为浮点噪声抖动。
 * 需要更严的调用方传 opts 里的 weight/tolErr 自己调。
 */
const EXACT = 1e-6;
const near = (a, b, tol = EXACT, msg = "") => assert.ok(Math.abs(a - b) <= tol, `${msg} |${a} − ${b}| = ${Math.abs(a - b)}`);

test("自由矩形：拖中心到目标，宽高不变，未 blocked", () => {
  const ents = rect();
  const r = dragSolve(ents, [], { kind: "entity", e: 0, to: [5, 3] });
  assert.equal(r.blocked, false);
  assert.equal(r.ok, true);
  near(r.entities[0].c[0], 5, EXACT, "cx");
  near(r.entities[0].c[1], 3, EXACT, "cy");
  near(r.entities[0].w, 20, 1e-12, "w");
  near(r.entities[0].h, 10, 1e-12, "h");
  assert.equal(r.component, 1);
});

test("完全定义的矩形：拖不动，返回 blocked 且几何一点不变", () => {
  const ents = rect([1, 2], 20, 10);
  const before = structuredClone(ents);
  const r = dragSolve(ents, [{ type: "fix", e: 0, at: [1, 2, 20, 10] }], { kind: "entity", e: 0, to: [9, 9] });
  assert.equal(r.blocked, true);
  assert.equal(r.ok, false);
  assert.ok(r.moved > 1, `应差得很远（moved=${r.moved}）`);
  assert.deepEqual(r.entities, before);          // 回滚，不返回半拉子几何
  assert.match(r.reason, /拖不动/);
});

test("只标了宽高：中心能拖，尺寸被保住（约束没破）", () => {
  const ents = rect();
  const specs = [{ type: "fixed", e: 0, k: "w", value: 20 }, { type: "fixed", e: 0, k: "h", value: 10 }];
  const r = dragSolve(ents, specs, { kind: "entity", e: 0, to: [12, -7] });
  assert.equal(r.blocked, false);
  near(r.entities[0].c[0], 12, EXACT, "cx");
  near(r.entities[0].c[1], -7, EXACT, "cy");
  near(r.entities[0].w, 20, EXACT, "w 必须仍是 20");
  near(r.entities[0].h, 10, EXACT, "h 必须仍是 10");
});

test("水平约束的线段：拖端点，另一端 y 跟着变，水平仍然成立", () => {
  const ents = [{ kind: "polyline", pts: [[0, 0], [10, 0]], closed: false }];
  const specs = [{ type: "horizontal", a: { e: 0, p: "p0" }, b: { e: 0, p: "p1" } }];
  const r = dragSolve(ents, specs, { kind: "point", ref: { e: 0, p: "p1" }, to: [12, 5] });
  assert.equal(r.blocked, false);
  const [p0, p1] = r.entities[0].pts;
  near(p1[0], 12, EXACT, "p1.x");
  near(p1[1], 5, EXACT, "p1.y");
  near(p0[1], p1[1], EXACT, "两点 y 必须相等");
  const again = solveSketch(r.entities, specs);
  assert.equal(again.ok, true);
});

test("端点被固定：拖它 → blocked，坐标不变", () => {
  const ents = [{ kind: "polyline", pts: [[0, 0], [10, 0]], closed: false }];
  const r = dragSolve(ents, [{ type: "fixedPoint", p: { e: 0, p: "p0" }, x: 0, y: 0 }],
    { kind: "point", ref: { e: 0, p: "p0" }, to: [5, 5] });
  assert.equal(r.blocked, true);
  assert.deepEqual(r.entities[0].pts, [[0, 0], [10, 0]]);
});

test("相切约束：拖圆心之后「圆心到直线的距离 = 半径」仍然精确成立", () => {
  const ents = [
    { kind: "circle", c: [0, 0], r: 5 },
    { kind: "polyline", pts: [[-10, 5], [10, 5]], closed: false },
  ];
  const specs = [{ type: "tangent", e: 0, l: { e: 1, seg: 0 } }];
  const r = dragSolve(ents, specs, { kind: "entity", e: 0, to: [3, 3] });
  assert.equal(r.blocked, false);
  const [c, p0, p1] = [r.entities[0].c, r.entities[1].pts[0], r.entities[1].pts[1]];
  const ux = p1[0] - p0[0], uy = p1[1] - p0[1];
  const L = Math.hypot(ux, uy);
  const d = Math.abs((c[0] - p0[0]) * uy - (c[1] - p0[1]) * ux) / L;
  near(d, r.entities[0].r, 1e-6, "圆心到直线的距离应等于半径");
});

test("互不相连的图元：拖一个，另一个一个字节都不动（连通分量隔离）", () => {
  const ents = [
    { kind: "rect", c: [0, 0], w: 10, h: 10 },
    { kind: "circle", c: [100, 100], r: 5 },
  ];
  const comp = connectedComponent(ents, [], [0], { maxHops: 4 });
  assert.deepEqual([...comp], [0]);
  const r = dragSolve(ents, [], { kind: "entity", e: 0, to: [1, 1] });
  assert.deepEqual(r.entities[1], ents[1]);
  assert.equal(r.component, 1);
});

test("整块拖动折线：所有顶点一起平移（形状不变）", () => {
  const ents = [{ kind: "polyline", pts: [[0, 0], [10, 0], [10, 5]], closed: false }];
  const r = dragSolve(ents, [], { kind: "entity", e: 0, delta: [4, -3] });
  assert.equal(r.blocked, false);
  const [a, b, c] = r.entities[0].pts;
  near(a[0], 4); near(a[1], -3);
  near(b[0], 14); near(b[1], -3);      // 第二个顶点跟着平移同一向量
  near(c[0], 14); near(c[1], 2);
  // 形状守恒：三条边长与原来完全一致
  const len = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);
  near(len(a, b), 10, EXACT, "边长 1");
  near(len(b, c), 5, EXACT, "边长 2");
});

test("dragSolve 不改入参（UI 每帧都要拿原几何去算）", () => {
  const ents = rect();
  const before = structuredClone(ents);
  dragSolve(ents, [], { kind: "entity", e: 0, to: [9, 9] });
  assert.deepEqual(ents, before);
});

test("dragPreview 与 dragSolve 同语义（blocked 时给原几何）", () => {
  const ents = rect();
  const a = dragPreview(ents, [], { kind: "entity", e: 0, to: [2, 2] });
  assert.equal(a.blocked, false);
  near(a.entities[0].c[0], 2, EXACT);
  const b = dragPreview(ents, [{ type: "fix", e: 0, at: [0, 0, 20, 10] }], { kind: "entity", e: 0, to: [2, 2] });
  assert.equal(b.blocked, true);
  assert.deepEqual(b.entities, ents);
});

test("引用图元不能拖（它是模型投影，不是用户画的）", () => {
  const ents = [{ kind: "polyline", pts: [[0, 0], [10, 0]], closed: false, ref: true }];
  const r = dragSolve(ents, [], { kind: "entity", e: 0, to: [1, 1] });
  assert.equal(r.blocked, true);
  assert.match(r.reason, /引用图元/);
});

test("性能：50 图元规模单次拖动 < 8ms（取 7 次中位数）", () => {
  const ents = [];
  for (let i = 0; i < 25; i++) ents.push({ kind: "rect", c: [i * 12, 0], w: 8, h: 6 });
  for (let i = 0; i < 25; i++) ents.push({ kind: "circle", c: [i * 12, 20], r: 3 });
  const specs = [];
  for (let i = 0; i < 25; i++) specs.push({ type: "fixed", e: i, k: "w", value: 8 });
  for (let i = 25; i < 50; i++) specs.push({ type: "fixed", e: i, k: "r", value: 3 });
  const times = [];
  for (let k = 0; k < 7; k++) {
    times.push(dragSolve(ents, specs, { kind: "entity", e: 3, to: [40 + k * 0.5, 4] }).ms);
  }
  times.sort((a, b) => a - b);
  const median = times[3];
  assert.ok(median < 8, `50 图元拖动中位数 ${median.toFixed(2)}ms 应 < 8ms`);
});

test("拖动结果的 dof 语义：分析得到的自由度不因拖动改变（约束没被删）", () => {
  const ents = [{ kind: "polyline", pts: [[0, 0], [10, 0]], closed: false }];
  const specs = [{ type: "horizontal", a: { e: 0, p: "p0" }, b: { e: 0, p: "p1" } }];
  const r = dragSolve(ents, specs, { kind: "point", ref: { e: 0, p: "p0" }, to: [0, 3] });
  assert.equal(r.blocked, false);
  const solved = solveSketch(r.entities, specs);
  assert.equal(solved.ok, true);
  assert.equal(solved.dof, 3);      // 4 参数 − 1 条水平方程
});
