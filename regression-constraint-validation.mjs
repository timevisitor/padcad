import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import opencascade from "replicad-opencascadejs";
import { setOC, measureVolume } from "replicad";
import * as Solver from "./src/solver.js";
import { rebuild } from "./src/replay.js";

const entities = () => [
  { kind: "rect", c: [0, 0], w: 20, h: 10 },
  { kind: "circle", c: [3, 4], r: 3 },
  { kind: "circle", c: [10, 4], r: 3 },
  { kind: "polyline", pts: [[0, 0], [10, 0], [10, 10]], closed: false },
  { kind: "polyline", pts: [[0, 5], [10, 5]], closed: false, ref: true },
];
const point = { e: 3, p: "p0" };
const line = { e: 3, seg: 0 };
const badDefinitions = [
  ["unknown type", { type: "futureConstraint", value: 4 }, /futureConstraint.*未知/],
  ["missing type", { e: 0, k: "w", value: 4 }, /类型.*缺少|缺少.*类型/],
  ["null constraint", null, /对象/],
  ["missing value", { type: "fixed", e: 0, k: "w" }, /fixed.*value/],
  ["NaN value", { type: "fixed", e: 0, k: "w", value: NaN }, /fixed.*value/],
  ["infinite value", { type: "distance", a: point, b: { e: 3, p: "p1" }, value: Infinity }, /distance.*value/],
  ["string value", { type: "fixed", e: 0, k: "w", value: "20" }, /fixed.*value/],
  ["wrong parameter for entity", { type: "fixed", e: 1, k: "w", value: 20 }, /fixed.*参数/],
  ["missing point reference", { type: "distance", a: point, value: 4 }, /distance.*b/],
  ["lost entity reference", { type: "distance", a: point, b: { e: 99, p: "center" }, value: 4 }, /distance.*图元/],
  ["fractional entity reference", { type: "fixed", e: 0.5, k: "w", value: 4 }, /fixed.*图元/],
  ["malformed point name", { type: "distance", a: point, b: { e: 3, p: "p1oops" }, value: 4 }, /distance.*点/],
  ["missing segment", { type: "angle", l1: { e: 0 }, l2: line, value: 45 }, /angle.*seg/],
  ["out of range segment", { type: "parallel", l1: { e: 0, seg: 4 }, l2: line }, /parallel.*seg/],
  ["projected entity as movable reference", { type: "parallel", l1: { e: 4, seg: 0 }, l2: line }, /parallel.*参考/],
  ["malformed fixed point", { type: "distToFixedPoint", p: point, at: [0, NaN], value: 4 }, /distToFixedPoint.*at/],
  ["missing fixed-point coordinate", { type: "fixedPoint", p: point, x: 0 }, /fixedPoint.*y/],
  ["degenerate reference line", { type: "distToFixedLine", p: point, line: [[0, 0], [0, 0]], value: 4 }, /distToFixedLine.*重合/],
  ["malformed fixed-line endpoint", { type: "angleToFixedLine", l: line, ref: [[0, 0], [10]], value: 4 }, /angleToFixedLine.*ref/],
  ["bad pointToLine reference", { type: "pointToLine", p: point, l1: { e: null, at: [0, 0] }, l2: null, value: 4 }, /pointToLine.*l2/],
  ["incomplete fix snapshot", { type: "fix", e: 0, at: [0, 0, 20] }, /fix.*快照/],
  ["NaN fix snapshot", { type: "fix", e: 1, at: [0, 0, NaN] }, /fix.*快照/],
  ["invalid tangent circle", { type: "tangent", e: 0, l: line }, /tangent.*圆/],
  ["invalid equal parameter", { type: "equal", e: 0, f: 1, k: "w" }, /equal.*参数/],
];

for (const [name, invalid, message] of badDefinitions) {
  test(`invalid ${name} is diagnosed before any valid constraint can move geometry`, () => {
    const ents = entities();
    const before = structuredClone(ents);
    const specs = [{ type: "fixed", e: 0, k: "w", value: 30 }, invalid];
    const specBefore = structuredClone(specs);
    const result = Solver.solveSketch(ents, specs);
    assert.equal(result.ok, false);
    assert.equal(result.iterations, 0);
    assert.equal(result.conflicted, true);
    assert.ok(result.conflicts.some(text => /第 2 条/.test(text) && message.test(text)), result.conflicts.join("; "));
    assert.equal(result.invalidConstraints[0].index, 1);
    assert.equal(result.invalidConstraints[0].type, invalid?.type || "缺少类型");
    assert.deepEqual(ents, before);
    assert.deepEqual(specs, specBefore);
  });
}

test("buildConstraints throws a dedicated error containing all bad definitions", () => {
  assert.throws(() => Solver.buildConstraints(entities(), [badDefinitions[0][1], badDefinitions[3][1]]), error => {
    assert.equal(error.name, "InvalidConstraintError");
    assert.equal(error.invalidConstraints.length, 2);
    assert.match(error.message, /第 1 条.*futureConstraint/);
    assert.match(error.message, /第 2 条.*fixed/);
    return true;
  });
});

test("malformed constraint collections do not become an empty successful solve", () => {
  for (const specs of [null, {}, "", 0]) {
    const ents = entities();
    const before = structuredClone(ents);
    const result = Solver.solveSketch(ents, specs);
    assert.equal(result.ok, false);
    assert.match(result.conflicts.join(";"), /约束列表.*数组/);
    assert.deepEqual(ents, before);
  }
});

test("missing array entries are diagnosed rather than skipped by iteration", () => {
  const specs = new Array(1);
  const missingSpec = Solver.solveSketch(entities(), specs);
  assert.equal(missingSpec.ok, false);
  assert.equal(missingSpec.invalidConstraints[0].index, 0);
  const ents = entities();
  delete ents[1];
  assert.equal(Solver.solveSketch(ents, []).ok, false);
  const missingCoordinate = entities();
  delete missingCoordinate[1].c[0];
  const invalidCoordinate = Solver.solveSketch(missingCoordinate, []);
  assert.equal(invalidCoordinate.ok, false);
  assert.ok(invalidCoordinate.invalidConstraints.length);
});

test("non-finite sketch coordinates fail even when there are no constraints", () => {
  const ents = entities();
  ents[1].c[0] = NaN;
  const before = structuredClone(ents);
  const result = Solver.solveSketch(ents, []);
  assert.equal(result.ok, false);
  assert.ok(result.invalidConstraints.length);
  assert.match(result.conflicts.join(";"), /图元.*有限/);
  assert.deepEqual(ents, before);
});

test("constant references cannot report success when their specified distance is impossible", () => {
  const result = Solver.solveSketch([], [{ type: "distance", a: { e: null, at: [0, 0] }, b: { e: null, at: [3, 4] }, value: 9 }]);
  assert.equal(result.ok, false);
  assert.equal(result.maxErr, 4);
});

test("direct solve refuses NaN parameters and NaN residuals without modifying parameters", () => {
  let value = NaN;
  const param = new Solver.Param(() => value, v => { value = v; }, "invalid.x");
  assert.equal(Solver.solve([param], []).ok, false);
  assert.ok(Number.isNaN(value));
  value = 5;
  assert.equal(Solver.solve([param], [{ error: () => NaN, label: "坏残差" }]).ok, false);
  assert.equal(value, 5);
});

test("all supported legacy constraint schemas still build, including fix without a saved snapshot", () => {
  const specs = [
    { type: "fixed", e: 0, k: "w", value: 20 },
    { type: "distance", a: point, b: { e: 3, p: "p1" }, value: 10 },
    { type: "horizontal", a: point, b: { e: 3, p: "p1" } },
    { type: "vertical", a: point, b: { e: 3, p: "p1" } },
    { type: "fixedPoint", p: point, x: 0, y: 0 },
    { type: "equal", e: 1, f: 2, k: "r" },
    { type: "angle", l1: line, l2: { e: 3, seg: 1 }, value: 90 },
    { type: "parallel", l1: line, l2: { e: 0, seg: 0 } },
    { type: "perpendicular", l1: line, l2: { e: 0, seg: 1 } },
    { type: "midpoint", p: point, l: line },
    { type: "symmetric", a: point, b: { e: 3, p: "p1" }, l: line },
    { type: "distToFixedPoint", p: point, at: [3, 4], value: 5 },
    { type: "distToFixedLine", p: point, line: [[0, 4], [10, 4]], value: 4 },
    { type: "angleToFixedLine", l: line, ref: [[0, 0], [0, 10]], value: 90 },
    { type: "pointToLine", p: point, l1: { e: null, at: [0, 4] }, l2: { e: null, at: [10, 4] }, value: 4 },
    { type: "coincident", a: point, b: { e: 3, p: "p1" } },
    { type: "tangent", e: 1, l: line },
    { type: "fix", e: 0 },
  ];
  const constraints = Solver.buildConstraints(entities(), specs);
  assert.equal(constraints.length, specs.length);
  assert.ok(constraints.every(constraint => Number.isFinite(constraint.error())));
  const result = Solver.solveSketch(entities(), [specs[0]]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.invalidConstraints, []);
  /*
   * v6：dof 改成**真实自由度**（n − rank(J)），dofApproximate 相应变成 false。
   * 这条断言原来写的是 true（v5 是 n − m 估算）。语义变化是 v6 明确要求的，
   * 判据也更强了：16 个自由度（矩形 4 + 圆 3 + 圆 3 + 折线 6，引用折线不计）减去
   * 1 条独立方程（宽 = 20），剩 15。
   */
  assert.equal(result.dofApproximate, false);
  assert.equal(result.dof, 15);
  assert.equal(result.rank, 1);
});

setOC(await opencascade({ wasmBinary: fs.readFileSync(new URL("./public/replicad_single.wasm", import.meta.url)) }));
const plane = { kind: "datum", name: "XY", origin: [0, 0, 8], normal: [0, 0, 1], xDir: [1, 0, 0] };
const extrusion = constraints => ({ type: "extrude", plane, entities: [{ kind: "rect", c: [0, 0], w: 8, h: 8 }], constraints, depth: 5, grow: 0 });

test("OCCT replay rejects unknown saved constraints and preserves the failing feature location", () => {
  const history = [{ label: "底板", op: { type: "base" } }, { label: "损坏草图", op: extrusion([{ type: "futureConstraint" }]) }];
  const before = structuredClone(history);
  assert.throws(() => rebuild(history, 1), error => {
    assert.equal(error.stepIndex, 1);
    assert.equal(error.stepLabel, "损坏草图");
    assert.match(error.message, /第 1 条.*futureConstraint.*未知/);
    assert.equal(error.invalidConstraints[0].type, "futureConstraint");
    return true;
  });
  assert.deepEqual(history, before);
});

test("OCCT replay rejects malformed saved constraint collections rather than dropping them", () => {
  for (const constraints of [null, {}, 0]) {
    assert.throws(() => rebuild([{ label: "坏约束列表", op: extrusion(constraints) }], 0), /约束列表.*数组/);
  }
});

test("OCCT replay still applies valid driving dimensions before creating the solid", () => {
  const history = [{ label: "合法草图", op: extrusion([{ type: "fixed", e: 0, k: "w", value: 12 }]) }];
  const result = rebuild(history, 0);
  assert.ok(Math.abs(measureVolume(result.shape) - 12 * 8 * 5) < 1e-6);
  assert.ok(Math.abs(result.shape.boundingBox.width - 12) < 1e-6);
  assert.equal(history[0].op.entities[0].w, 8);
});
