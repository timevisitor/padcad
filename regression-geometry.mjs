import assert from "node:assert/strict";
import fs from "node:fs";
import opencascade from "replicad-opencascadejs";
import * as R from "replicad";
import { Vector3 } from "three";
import { smartRule, geometryOf, isParallel } from "./src/elements.js";
import { solveSketch, buildConstraint } from "./src/solver.js";
import { SketchSession } from "./src/sketch.js";
import { sweepNormal, loftWires } from "./src/features.js";

let passed = 0, failed = 0;
const near = (actual, expected, tolerance = 1e-5) => assert.ok(
  Math.abs(actual - expected) <= tolerance, `${actual} should equal ${expected}`,
);
function check(name, run) {
  try { run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}
const line = (a, b, ref = false) => ({ kind: "polyline", pts: [a, b], closed: false, ref });
const lineSel = e => ({ kind: "line", e, seg: 0 });
const fixedLine = { type: "fix", e: 1, at: [0, 0, 20, 0] };

check("perpendicular lines receive an angle dimension", () => {
  const sketch = { entities: [line([0, 0], [20, 0]), line([0, 0], [0, 20])] };
  assert.equal(isParallel(geometryOf(sketch, lineSel(0)), geometryOf(sketch, lineSel(1))), false);
  const rule = smartRule(sketch, [lineSel(0), lineSel(1)]);
  assert.equal(rule.type, "angle"); near(rule.value, 90);
});

check("circle-to-line dimension constrains perpendicular distance", () => {
  const sketch = { entities: [{ kind: "circle", c: [10, 5], r: 2 }, line([0, 0], [20, 0])] };
  const rule = smartRule(sketch, [{ kind: "circle", e: 0 }, lineSel(1)]);
  const result = solveSketch(sketch.entities, [fixedLine, { ...rule.spec, value: 8 }]);
  assert.ok(result.ok); near(sketch.entities[0].c[0], 10); near(sketch.entities[0].c[1], 8);
});

check("point-to-line dimension constrains perpendicular distance", () => {
  const sketch = { entities: [line([10, 5], [12, 7]), line([0, 0], [20, 0])] };
  const rule = smartRule(sketch, [{ kind: "point", e: 0, p: "p0", p2: [10, 5] }, lineSel(1)]);
  const result = solveSketch(sketch.entities, [fixedLine, { ...rule.spec, value: 8 }]);
  assert.ok(result.ok); near(sketch.entities[0].pts[0][0], 10); near(sketch.entities[0].pts[0][1], 8);
});

check("point references resolve current coordinates without cached p2", () => {
  const sketch = { entities: [line([10, 5], [13, 9])] };
  const rule = smartRule(sketch, [{ kind: "point", e: 0, p: "p0" }, { kind: "point", e: 0, p: "p1" }]);
  near(rule.value, 5);
});

check("projected-point dimension can drive a sketch point", () => {
  const sketch = { entities: [line([3, 4], [8, 9])] };
  const rule = smartRule(sketch, [{ kind: "point", e: 0, p: "p0", p2: [3, 4] }, { kind: "projPoint", p: [0, 0] }]);
  assert.equal(rule.spec.type, "distToFixedPoint");
  assert.ok(solveSketch(sketch.entities, [{ ...rule.spec, value: 10 }]).ok);
  near(Math.hypot(...sketch.entities[0].pts[0]), 10);
});

check("projected-line angle builds a valid fixed-reference constraint", () => {
  const sketch = { entities: [line([0, 0], [10, 10])] };
  const rule = smartRule(sketch, [lineSel(0), { kind: "projLine", a: [0, 0], b: [10, 0] }]);
  assert.equal(rule.spec.type, "angleToFixedLine");
  assert.ok(buildConstraint(sketch.entities, rule.spec));
  assert.ok(solveSketch(sketch.entities, [rule.spec]).ok);
  sketch.entities[0].pts.flat().forEach((value, i) => near(value, [0, 0, 10, 10][i]));
});

check("angle dimensions preserve either existing side of the reference", () => {
  for (const sign of [-1, 1]) {
    const sketch = { entities: [line([0, 0], [10, sign * 10]), line([0, 0], [10, 0])] };
    const before = sketch.entities.map(e => e.pts.flat());
    const rule = smartRule(sketch, [lineSel(0), lineSel(1)]);
    assert.ok(solveSketch(sketch.entities, [rule.spec]).ok);
    sketch.entities.forEach((e, i) => e.pts.flat().forEach((value, j) => near(value, before[i][j])));
  }
});

check("fixed-reference measurements never create driving constraints", () => {
  const sketch = { entities: [line([0, 0], [20, 0], true)] };
  assert.equal(smartRule(sketch, [lineSel(0)]).spec, null);
  assert.equal(smartRule(sketch, [{ kind: "projPoint", p: [0, 0] }, { kind: "projPoint", p: [3, 4] }]).spec, null);
  assert.equal(smartRule(sketch, [{ kind: "projLine", a: [0, 0], b: [20, 0] }, { kind: "projLine", a: [0, 0], b: [10, 10] }]).spec, null);
});

check("stale or incomplete constraint references are safely rejected", () => {
  const entities = [line([0, 0], [10, 0]), line([0, 1], [10, 1], true)];
  assert.equal(buildConstraint(entities, { type: "distance", a: null, b: { e: 0, p: "p0" }, value: 5 }), null);
  assert.equal(buildConstraint(entities, { type: "parallel", l1: lineSel(0), l2: lineSel(1) }), null);
});

R.setOC(await opencascade({ wasmBinary: fs.readFileSync(new URL("./public/replicad_single.wasm", import.meta.url)) }));

for (const direction of [[0, 0, 1], [0, 0, -1], [1, 0, 0]]) {
  check(`sweep follows normal ${direction.join(",")}`, () => {
    const origin = [7, 11, 13];
    const plane = new R.Plane(origin, null, direction);
    const profile = R.drawCircle(2).sketchOnPlane(plane);
    const solid = sweepNormal(profile, 10, origin, direction);
    near(R.measureVolume(solid), Math.PI * 4 * 10);
    solid.boundingBox.center.forEach((v, i) => near(v, origin[i] + direction[i] * 5));
  });
}

check("face sketch drawings stay at the displayed world position", () => {
  const plate = R.makeBaseBox(60, 40, 8).translate([17, 31, 5]);
  const top = plate.faces.find(face => face.normalAt().z > 0.99);
  const sketch = new SketchSession(plate, top.hashCode);
  sketch.entities.push({ kind: "circle", c: [3, 7], r: 2 });
  const expected = sketch.to3D(3, 7).toArray();
  const drawing = sketch.toDrawings()[0];
  drawing.wire.boundingBox.center.forEach((v, i) => near(v, expected[i]));
});

check("face sketch revolve uses the same world frame as its preview", () => {
  const plate = R.makeBaseBox(60, 40, 8).translate([17, 31, 5]);
  const top = plate.faces.find(face => face.normalAt().z > 0.99);
  const sketch = new SketchSession(plate, top.hashCode);
  sketch.entities.push({ kind: "rect", c: [5, 4], w: 10, h: 8 });
  const expected = sketch.to3D(0, 4).toArray();
  const solid = sketch.revolveSolid(360, 0);
  near(R.measureVolume(solid), Math.PI * 100 * 8);
  solid.boundingBox.center.forEach((v, i) => near(v, expected[i]));
});

check("rotating a circle keeps an exact circular profile", () => {
  const plate = R.makeBaseBox(60, 40, 8);
  const top = plate.faces.find(face => face.normalAt().z > 0.99);
  const sketch = new SketchSession(plate, top.hashCode);
  sketch.entities.push({ kind: "circle", c: [10, 0], r: 3 });
  sketch.rotateEntities([0], 45);
  assert.equal(sketch.entities[0].kind, "circle");
  near(R.measureVolume(sketch.buildSolid(5)), Math.PI * 9 * 5);
});

check("first positive extrusion works on an empty document", () => {
  const sketch = new SketchSession(null, null, {
    name: "XY", origin: new Vector3(0, 0, 0),
    normal: new Vector3(0, 0, 1), xDir: new Vector3(1, 0, 0), occtPlane: R.makePlane("XY"),
  });
  sketch.entities.push({ kind: "rect", c: [0, 0], w: 10, h: 8 });
  near(R.measureVolume(sketch.apply(5)), 400);
  assert.throws(() => sketch.apply(-5), /先拉伸/);
});

check("coplanar loft sections are rejected instead of reporting a zero-volume success", () => {
  const wires = [16, 8].map(size => R.drawRectangle(size, size).sketchOnPlane("XY").wire);
  assert.throws(() => loftWires(wires), /放样失败.*闭合截面/);
});

check("separated loft sections retain the independently calculated frustum volume", () => {
  const wires = [
    R.drawRectangle(16, 16).sketchOnPlane("XY", [0, 0, 0]).wire,
    R.drawRectangle(8, 8).sketchOnPlane("XY", [0, 0, 20]).wire,
  ];
  const expected = 20 / 3 * (16 ** 2 + 16 * 8 + 8 ** 2);
  const solid = loftWires(wires);
  near(R.measureVolume(solid), expected);
  near(solid.boundingBox.depth, 20);
});

console.log(`Geometry regressions: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
