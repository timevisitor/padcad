import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { Vector3 } from "three";
import { SketchSession } from "./src/sketch.js";
import { solveSketch } from "./src/solver.js";
import * as ELEM from "./src/elements.js";

const main = fs.readFileSync(new URL("./src/main.js", import.meta.url), "utf8");
function appFunction(name) {
  const start = main.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing application function ${name}`);
  const lineEnd = main.indexOf("\n", start);
  // The only single-line declarations loaded here have no nested function bodies.
  if (main.slice(start, lineEnd).trimEnd().endsWith("}")) return main.slice(start, lineEnd);
  const end = main.indexOf("\n}", start);
  assert.ok(end > start);
  return main.slice(start, end + 2);
}

function session(entities, constraints = []) {
  const sketch = new SketchSession(null, null, {
    name: "XY", origin: new Vector3(), normal: new Vector3(0, 0, 1),
    xDir: new Vector3(1, 0, 0), occtPlane: { origin: [0, 0, 0] },
  });
  sketch.entities = structuredClone(entities);
  sketch.constraints = structuredClone(constraints);
  return sketch;
}

function application(sketch) {
  const context = vm.createContext({
    sketch, dimEntity: 0, smartSpec: null, smartSel: [], relSel: [],
    performance, solveSketch, ELEM,
    redrawSketch() {}, renderDimPanel() {}, setStats() {}, showOverdefined() {},
    smartDimHighlight() {}, relHighlight() {}, refreshRelPad() {}, showDimEdit() {},
    // 状态栏的自由度文案（main.js 里走 sketch-dof 的真实分析）。这里只测约束记账，不测文案。
    sketchDofLine() { return "剩余自由度 0"; },
  });
  const functions = ["restoreEntities", "applyDim", "smartDimReset", "relReset", "buildRelSpec", "applyRelation", "applySmartSpec",
  // 从动尺寸：applySmartSpec 会经这两个函数创建可保存的测量定义
  "addDrivenDim", "measureFromSpec"];
  if (main.includes("function constraintTargetKey(")) functions.push("constraintTargetKey");
  for (const name of functions) vm.runInContext(appFunction(name), context);
  return context;
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
const data = value => JSON.parse(JSON.stringify(value));
const line = (a, b) => ({ kind: "polyline", pts: [a, b], closed: false });
const lineSel = e => ({ kind: "line", e, seg: 0 });

test("failed dimension replacement restores both geometry and the previous dimension", () => {
  const sketch = session([{ kind: "rect", c: [0, 0], w: 20, h: 10 }], [
    { type: "fixed", e: 0, k: "w", value: 20, label: "宽 20" },
    { type: "fix", e: 0, at: [0, 0, 20, 10], label: "固定" },
  ]);
  const before = data({ entities: sketch.entities, constraints: sketch.constraints });
  const app = application(sketch);
  app.applyDim("w", 30);
  assert.deepEqual(data({ entities: sketch.entities, constraints: sketch.constraints }), before);
});

test("editing one circle diameter replaces its old driving dimension despite label changes", () => {
  const sketch = session([{ kind: "circle", c: [0, 0], r: 5 }]);
  const app = application(sketch);
  for (const diameter of [20, 12]) {
    app.smartSpec = ELEM.smartRule(sketch, [{ kind: "circle", e: 0 }]);
    assert.equal(app.applySmartSpec(diameter), true);
    assert.equal(sketch.constraints.length, 1);
    near(sketch.entities[0].r, diameter / 2);
  }
});

test("failed smart dimension replacement retains the previous driving constraint", () => {
  const sketch = session([{ kind: "circle", c: [0, 0], r: 5 }], [
    { type: "fixed", e: 0, k: "r", value: 5, label: "直径 10.00" },
    { type: "fix", e: 0, at: [0, 0, 5], label: "固定" },
  ]);
  const before = data({ entities: sketch.entities, constraints: sketch.constraints });
  const app = application(sketch);
  app.smartSpec = ELEM.smartRule(sketch, [{ kind: "circle", e: 0 }]);
  assert.equal(app.applySmartSpec(14), false);
  assert.deepEqual(data({ entities: sketch.entities, constraints: sketch.constraints }), before);
});

test("angle relation stays pending until confirmation and then uses the entered angle", () => {
  const sketch = session([line([0, 0], [10, 10]), line([0, 0], [20, 0])], [
    { type: "fix", e: 1, at: [0, 0, 20, 0], label: "固定参考线" },
  ]);
  const app = application(sketch);
  app.relSel = [lineSel(0), lineSel(1)];
  const before = data(sketch.entities);
  assert.equal(app.applyRelation("angle"), true);
  assert.equal(sketch.constraints.length, 1);
  assert.deepEqual(data(sketch.entities), before);
  assert.ok(app.smartSpec);
  assert.equal(app.applySmartSpec(30), true);
  assert.equal(sketch.constraints.length, 2);
  near(ELEM.lineAngle(ELEM.geometryOf(sketch, lineSel(0)), ELEM.geometryOf(sketch, lineSel(1))), 30);
});

test("cancelling a pending angle relation leaves no constraint or geometry change", () => {
  const sketch = session([line([0, 0], [10, 10]), line([0, 0], [20, 0])]);
  const app = application(sketch);
  const before = data(sketch.entities);
  app.relSel = [lineSel(0), lineSel(1)];
  app.applyRelation("angle");
  app.smartDimReset();
  assert.equal(sketch.constraints.length, 0);
  assert.deepEqual(data(sketch.entities), before);
});

test("parallel lines expose their true zero-degree angle in the relation editor", () => {
  const sketch = session([line([0, 0], [10, 0]), line([0, 5], [20, 5])]);
  const app = application(sketch);
  app.relSel = [lineSel(0), lineSel(1)];
  app.applyRelation("angle");
  assert.ok(app.smartSpec);
  near(app.smartSpec.value, 0);
});

test("reference-only dimensions save the measured value even if an edited value is supplied", () => {
  const sketch = session([]);
  const app = application(sketch);
  app.smartSpec = ELEM.smartRule(sketch, [
    { kind: "projPoint", p: [0, 0] }, { kind: "projPoint", p: [3, 4] },
  ]);
  assert.equal(app.applySmartSpec(999), true);
  // 从动标注现在存的是**测量定义**（测哪两点），值在绘制时现算 ——
  // 所以这里验证"能算出 5"，而不是"存了一个 5"（后者几何一变就过期）
  assert.ok(sketch.dimNotes[0].measure, "应当存下测量定义");
  const ev = ELEM.evalMeasure(sketch, sketch.dimNotes[0].measure);
  assert.ok(ev, "测量定义应当可求值");
  near(ev.value, 5);
  assert.equal(sketch.constraints.length, 0);
});

test("driven dimension recomputes when geometry moves instead of freezing the value", () => {
  /*
   * 这是从动尺寸与"存一个数值快照"的本质区别：
   *   存快照 → 几何一动值就过期，显示的还是老数
   *   存测量定义 → 每次绘制现算，值跟着几何走
   * 同时它必须**不产生任何约束**（不参与求解）。
   */
  const sketch = session([{ kind: "circle", c: [0, 0], r: 5 }]);
  const m = { kind: "dist2pt", a: { e: 0, p: "center" }, b: { e: null, at: [10, 0] } };
  near(ELEM.evalMeasure(sketch, m).value, 10);
  // 把圆心挪到 x=4 → 到 (10,0) 的距离应当是 6
  sketch.entities[0].c[0] = 4;
  near(ELEM.evalMeasure(sketch, m).value, 6, 1e-9);
  // 挪远 → 20
  sketch.entities[0].c[0] = -10;
  near(ELEM.evalMeasure(sketch, m).value, 20, 1e-9);
  // 从动尺寸不参与求解：约束表应当仍然是空的
  assert.equal(sketch.constraints.length, 0);
});

test("driven diameter follows the radius", () => {
  const sketch = session([{ kind: "circle", c: [1, 2], r: 7 }]);
  const m = { kind: "diameter", e: 0 };
  near(ELEM.evalMeasure(sketch, m).value, 14);
  sketch.entities[0].r = 9.5;
  near(ELEM.evalMeasure(sketch, m).value, 19, 1e-9);
  assert.equal(sketch.constraints.length, 0);
});

test("driven distance to a model-projected line follows the point", () => {
  const sketch = session([{ kind: "circle", c: [0, 0], r: 3 }]);
  // 引用线（模型投影来的）竖直放在 x=25
  const m = { kind: "dist2line", a: { e: 0, p: "center" }, line: [[25, -20], [25, 20]] };
  near(ELEM.evalMeasure(sketch, m).value, 25);
  sketch.entities[0].c[0] = 5;
  near(ELEM.evalMeasure(sketch, m).value, 20, 1e-9);
  assert.equal(sketch.constraints.length, 0);
});

test("reversing point selection updates the same distance instead of adding a conflict", () => {
  const sketch = session([line([0, 0], [10, 0])]);
  const app = application(sketch);
  const points = [{ kind: "point", e: 0, p: "p0" }, { kind: "point", e: 0, p: "p1" }];
  app.smartSpec = ELEM.smartRule(sketch, points);
  assert.equal(app.applySmartSpec(20), true);
  app.smartSpec = ELEM.smartRule(sketch, points.slice().reverse());
  assert.equal(app.applySmartSpec(30), true);
  assert.equal(sketch.constraints.length, 1);
  near(Math.hypot(sketch.entities[0].pts[1][0] - sketch.entities[0].pts[0][0], sketch.entities[0].pts[1][1] - sketch.entities[0].pts[0][1]), 30);
});
