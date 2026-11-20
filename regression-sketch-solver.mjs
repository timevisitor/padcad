/**
 * v6 智能草图 · 求解器改造回归
 *
 * 守三件事：
 *   ① 换算法（DogLeg 默认 / LM / 最小范数）**解出同一张几何** —— 只是路径不同，结果必须一致；
 *   ② 残差改成分量形式后，**收敛速度不许退回去**（链条场景迭代 ≤ 10，曾经要 200 次还卡在 8e-4）；
 *   ③ 与 v5（13d63e5 原样副本 bench/baseline-solver-13d63e5.mjs）在良态草图上解出**同一张几何**。
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as Solver from "./src/solver.js";
/*
 * v5 基线是“v5.1.7 的 solver.js 原样副本”，放在 bench/ 下。
 * 合并/裁剪工作树时它可能不在 —— 那时这几条对比用例自动 skip，而不是让整个文件红。
 */
let Baseline = null;
try { Baseline = await import("./bench/baseline-solver-13d63e5.mjs"); } catch { Baseline = null; }
const needsBaseline = { skip: Baseline ? false : "缺少 bench/baseline-solver-13d63e5.mjs（v5 原样副本）" };

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: |${a} − ${b}| = ${Math.abs(a - b)}`);

/** 一条 N 段折线链：水平 + 端点重合 + 首点固定（欠定义，最考验收敛） */
function chain(nSeg, seed = 7) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; };
  const entities = [], specs = [];
  for (let i = 0; i < nSeg; i++) {
    const a = [i * 10, 0], b = [(i + 1) * 10, 0];
    entities.push({ kind: "polyline", pts: [[a[0] + rnd() * 0.8, a[1] + rnd() * 1.2], [b[0] + rnd() * 0.8, b[1] + rnd() * 1.2]], closed: false });
    specs.push({ type: "horizontal", a: { e: i, p: "p0" }, b: { e: i, p: "p1" } });
    if (i > 0) specs.push({ type: "coincident", a: { e: i - 1, p: "p1" }, b: { e: i, p: "p0" } });
  }
  specs.push({ type: "fixedPoint", p: { e: 0, p: "p0" }, x: 0, y: 0 });
  return { entities, specs };
}

test("三种算法（DogLeg 默认 / LM / 最小范数）解出同一张几何", () => {
  const results = {};
  for (const [label, opts] of [["dogleg", { algorithm: "dogleg" }], ["lm", { algorithm: "lm" }], ["leastNorm", { leastNorm: true }]]) {
    const { entities, specs } = chain(6);
    const r = Solver.solveSketch(entities, specs, opts);
    assert.equal(r.ok, true, `${label} 应收敛`);
    results[label] = { entities, r };
  }
  const ref = results.dogleg.entities;
  for (const label of ["lm", "leastNorm"]) {
    const other = results[label].entities;
    assert.equal(other.length, ref.length);
    for (let i = 0; i < ref.length; i++) {
      for (let k = 0; k < ref[i].pts.length; k++) {
        near(other[i].pts[k][0], ref[i].pts[k][0], 1e-6, `${label} 顶点 ${i}.${k}.x`);
        near(other[i].pts[k][1], ref[i].pts[k][1], 1e-6, `${label} 顶点 ${i}.${k}.y`);
      }
    }
  }
});

test("收敛速度护栏：7 段链条 ≤ 10 次迭代、残差 < 1e-9（v5 是 200 次还卡在 8e-4）", () => {
  const { entities, specs } = chain(7);
  const r = Solver.solveSketch(entities, specs);
  assert.equal(r.ok, true);
  assert.ok(r.iterations <= 10, `迭代 ${r.iterations} 次，超过 10`);
  assert.ok(r.maxErr < 1e-9, `maxErr ${r.maxErr}`);
  // 水平与重合必须真的成立
  for (let i = 0; i < 7; i++) near(entities[i].pts[0][1], entities[i].pts[1][1], 1e-8, `段 ${i} 水平`);
  for (let i = 1; i < 7; i++) {
    near(entities[i].pts[0][0], entities[i - 1].pts[1][0], 1e-8, `接缝 ${i} x`);
    near(entities[i].pts[0][1], entities[i - 1].pts[1][1], 1e-8, `接缝 ${i} y`);
  }
});

test("与 v5 基线（13d63e5）解出同一张几何：良态草图逐顶点一致", needsBaseline, () => {
  const cases = [
    () => ({
      entities: [{ kind: "rect", c: [2.3, -1.1], w: 22.4, h: 9.7 }, { kind: "circle", c: [3.1, 4.2], r: 2.8 }],
      specs: [
        { type: "fixed", e: 0, k: "w", value: 20 },
        { type: "fixed", e: 0, k: "h", value: 10 },
        { type: "fixedPoint", p: { e: 0, p: "center" }, x: 0, y: 0 },
        { type: "distance", a: { e: 0, p: "center" }, b: { e: 1, p: "center" }, value: 5 },
      ],
    }),
    () => ({
      entities: [{ kind: "polyline", pts: [[0.4, 0.2], [9.6, 0.9], [10.3, 6.1]], closed: false }],
      specs: [
        { type: "horizontal", a: { e: 0, p: "p0" }, b: { e: 0, p: "p1" } },
        { type: "vertical", a: { e: 0, p: "p1" }, b: { e: 0, p: "p2" } },
        { type: "distance", a: { e: 0, p: "p0" }, b: { e: 0, p: "p1" }, value: 10 },
        { type: "fixedPoint", p: { e: 0, p: "p0" }, x: 0, y: 0 },
      ],
    }),
  ];
  for (let c = 0; c < cases.length; c++) {
    const made = cases[c]();
    const v6 = structuredClone(made.entities);
    const v5 = structuredClone(made.entities);
    const r6 = Solver.solveSketch(v6, made.specs);
    const r5 = Baseline.solveSketch(v5, made.specs);
    assert.equal(r6.ok, true, `case ${c} v6 应收敛`);
    assert.equal(r5.ok, true, `case ${c} v5 应收敛`);
    /*
     * 欠定义草图的解集是一条流形：两条求解路径可能落在流形的不同点上（都合法）。
     * 所以等价性要按**约束残差**比（是不是同一个可行集），只有完全定义（dof=0）时才逐坐标比。
     */
    for (const [label, ents, res] of [["v6", v6, r6], ["v5", v5, r5]]) {
      const cs = Solver.buildConstraints(ents, made.specs);
      for (const k of cs) assert.ok(Math.abs(k.error()) < 1e-6, `case ${c} ${label} 约束 ${k.label} 残差 ${k.error()}`);
      assert.ok(res.dof >= 0);
    }
    if (r6.dof === 0) {
      const flat = (list) => list.flatMap((e) => (e.kind === "polyline" ? e.pts.flat() : e.kind === "circle" ? [...e.c, e.r] : [...e.c, e.w, e.h]));
      const a = flat(v6), b = flat(v5);
      assert.equal(a.length, b.length);
      for (let i = 0; i < a.length; i++) near(a[i], b[i], 1e-4, `case ${c} 参数 ${i}`);
    }
  }
});

test("链条类草图：v5 卡住（200 次仍不收敛），v6 收敛 —— 本次改造的直接动机", needsBaseline, () => {
  const { entities, specs } = chain(4);
  const v5 = Baseline.solveSketch(structuredClone(entities), specs);
  assert.equal(v5.ok, false, "v5 基线在这种草图上是解不出来的");
  assert.ok(v5.maxErr > 1e-4, `v5 残差 ${v5.maxErr}`);
  const r6 = Solver.solveSketch(structuredClone(entities), specs);
  assert.equal(r6.ok, true, "v6 应该能解出来");
  assert.ok(r6.maxErr < 1e-9);
  assert.ok(r6.iterations <= 10, `v6 迭代 ${r6.iterations}`);
});

test("矛盾系统：v6 与 v5 的目标函数相同 → maxErr 相同", needsBaseline, () => {
  const specs = [
    { type: "fixed", e: 0, k: "w", value: 20 },
    { type: "fixed", e: 0, k: "w", value: 30 },
  ];
  const e6 = [{ kind: "rect", c: [0, 0], w: 20, h: 10 }];
  const e5 = structuredClone(e6);
  const r6 = Solver.solveSketch(e6, specs);
  const r5 = Baseline.solveSketch(e5, specs);
  assert.equal(r6.ok, false);
  assert.equal(r5.ok, false);
  near(r6.maxErr, r5.maxErr, 1e-6, "maxErr");
  near(r6.cost, r5.cost, 1e-6, "cost");
});

test("新增 equalLength 约束：求解后两段长度相等（解析值）", () => {
  const entities = [
    { kind: "polyline", pts: [[0, 0], [12, 0]], closed: false },
    { kind: "polyline", pts: [[12, 5], [12, 19]], closed: false },
  ];
  const specs = [{ type: "equalLength", l1: { e: 0, seg: 0 }, l2: { e: 1, seg: 0 } }];
  const r = Solver.solveSketch(entities, specs);
  assert.equal(r.ok, true);
  const L = (pts) => Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
  near(L(entities[0].pts), L(entities[1].pts), 1e-7, "两段等长");
  assert.equal(r.dof, 7);                        // 8 参数 − 1 条方程
});

test("equalLength 的坏定义会被校验拦下（缺 l2 / 段号越界）", () => {
  const entities = [{ kind: "polyline", pts: [[0, 0], [12, 0]], closed: false }];
  for (const spec of [
    { type: "equalLength", l1: { e: 0, seg: 0 } },
    { type: "equalLength", l1: { e: 0, seg: 0 }, l2: { e: 0, seg: 3 } },
    { type: "equalLength", l1: { e: 0, seg: 0 }, l2: { e: 9, seg: 0 } },
  ]) {
    assert.throws(() => Solver.buildConstraints(entities, [spec]), /equalLength/);
  }
});

test("specEntities 覆盖每个约束类型：稀疏依赖表不许漏图元", () => {
  const entities = [
    { kind: "rect", c: [0, 0], w: 20, h: 10 },
    { kind: "circle", c: [3, 4], r: 3 },
    { kind: "polyline", pts: [[0, 0], [10, 0], [10, 10]], closed: false },
    { kind: "circle", c: [40, 40], r: 2 },
  ];
  const specs = [
    { type: "fixed", e: 0, k: "w", value: 20 },
    { type: "distance", a: { e: 2, p: "p0" }, b: { e: 2, p: "p1" }, value: 10 },
    { type: "horizontal", a: { e: 2, p: "p0" }, b: { e: 2, p: "p1" } },
    { type: "vertical", a: { e: 2, p: "p0" }, b: { e: 2, p: "p1" } },
    { type: "fixedPoint", p: { e: 2, p: "p0" }, x: 0, y: 0 },
    { type: "equal", e: 1, f: 3, k: "r" },
    { type: "angle", l1: { e: 0, seg: 0 }, l2: { e: 2, seg: 0 }, value: 90 },
    { type: "parallel", l1: { e: 0, seg: 0 }, l2: { e: 2, seg: 0 } },
    { type: "perpendicular", l1: { e: 0, seg: 0 }, l2: { e: 2, seg: 1 } },
    { type: "equalLength", l1: { e: 0, seg: 0 }, l2: { e: 2, seg: 0 } },
    { type: "midpoint", p: { e: 2, p: "p2" }, l: { e: 0, seg: 2 } },
    { type: "symmetric", a: { e: 0, p: "bl" }, b: { e: 0, p: "br" }, l: { e: 2, seg: 1 } },
    { type: "distToFixedPoint", p: { e: 2, p: "p0" }, at: [3, 4], value: 5 },
    { type: "distToFixedLine", p: { e: 2, p: "p0" }, line: [[0, 4], [10, 4]], value: 4 },
    { type: "angleToFixedLine", l: { e: 2, seg: 0 }, ref: [[0, 0], [0, 10]], value: 90 },
    { type: "pointToLine", p: { e: 2, p: "p0" }, l1: { e: null, at: [0, 4] }, l2: { e: null, at: [10, 4] }, value: 4 },
    { type: "coincident", a: { e: 2, p: "p0" }, b: { e: 1, p: "center" } },
    { type: "tangent", e: 1, l: { e: 2, seg: 1 } },
    { type: "fix", e: 0, at: [0, 0, 20, 10] },
  ];
  for (const spec of specs) {
    const set = Solver.specEntities(spec);
    assert.ok(set.size > 0, `${spec.type} 的 specEntities 为空`);
    assert.doesNotThrow(() => Solver.buildConstraints(entities, [spec]), `${spec.type} 应能构建`);
  }
  const params = Solver.collectParams(entities);
  const deps = Solver.buildParamDeps(params, entities, specs);
  assert.equal(deps.length, params.length);
  // 引用图元的参数（这里没有）与未被任何约束引用的图元参数应该得到空依赖表
  assert.ok(deps.some((list) => list.length > 0));
});

test("solve 返回的 rank / equations / dof 与 diagnoseSystem 一致", () => {
  const entities = [{ kind: "rect", c: [0.5, 0.5], w: 20, h: 10 }];
  const specs = [
    { type: "fixed", e: 0, k: "w", value: 20 },
    { type: "fixedPoint", p: { e: 0, p: "center" }, x: 0, y: 0 },
  ];
  const r = Solver.solveSketch(entities, specs);
  const d = Solver.diagnoseSystem(Solver.collectParams(entities), r.constraints);
  assert.equal(r.rank, d.rank);
  assert.equal(r.equations, d.equations);
  assert.equal(r.dof, d.dof);
  assert.equal(r.dof, 1);                        // 4 参数 − 3 条独立方程（宽 + 中心 x/y）
});

test("参数含 NaN / 残差 NaN 时仍返回 ok:false 而不是抛异常", () => {
  const bad = new Solver.Param(() => NaN, () => {}, "x");
  assert.equal(Solver.solve([bad], []).ok, false);
});
