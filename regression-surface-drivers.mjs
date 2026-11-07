import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import opencascade from "replicad-opencascadejs";
import * as R from "replicad";
import * as THREE from "three";
import { rebuild, makeEdgeRefs } from "./src/replay.js";
import { cacheRebuild } from "./src/project.js";
import * as OPS from "./src/ops.js";
import { readCylinderFace, findSurfaceDrivers } from "./src/surface-drivers.js";

R.setOC(await opencascade({ wasmBinary: fs.readFileSync(new URL("./public/replicad_single.wasm", import.meta.url)) }));
const near = (a, b, tolerance = 1e-5) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const plane = origin => ({ kind: "datum", name: "XY", origin, normal: [0, 0, 1], xDir: [1, 0, 0] });
const base = () => ({ type: "base" });
const post = (x, y = 0, z = 8, r = 6, depth = 12) => ({ type: "extrude", plane: plane([x, y, z]),
  entities: [{ kind: "circle", c: [0, 0], r }], constraints: [], selected: [], depth, grow: 0 });
function build(ops) {
  const history = ops.map(op => ({ op: structuredClone(op) }));
  const hIndex = history.length - 1;
  const result = rebuild(history, hIndex);
  cacheRebuild(history, result);
  return { history, hIndex, shape: result.shape };
}
function cylinders(shape) {
  const faces = shape.faces;
  try { return faces.flatMap(face => {
    const cylinder = readCylinderFace(face);
    return cylinder ? [{ ...cylinder, faceId: face.hashCode }] : [];
  }); } finally { faces.forEach(face => face.delete()); }
}
function at(context, center, radius = 6) {
  const hits = cylinders(context.shape).filter(c => Math.abs(c.radius - radius) < 1e-5
    && Math.hypot(...c.ends[0].map((v, i) => (v + c.ends[1][i]) / 2 - center[i])) < 1e-4);
  assert.equal(hits.length, 1, `one cylinder at ${center} R${radius}`);
  return hits[0];
}
function driverAt(context, center, radius = 6) {
  return findSurfaceDrivers({ ...context, faceId: at(context, center, radius).faceId });
}
function expectDriver(found, index, kind = "sketchCircle", sub = 0) {
  assert.equal(found.length, 1);
  assert.equal(found[0].i, index);
  assert.equal(found[0].kind, kind);
  if (kind === "sketchCircle") assert.equal(found[0].sub, sub);
  return found[0];
}

test("native cylinder reader identifies finite trimmed bounds and opposite hole/wall orientation", () => {
  const context = build([base(), post(20), post(-20)]);
  const hole = at(context, [0, 0, 4]);
  assert.deepEqual(hole.axis, [0, 0, 1]);
  assert.deepEqual(hole.axisPoint, [0, 0, -6]);
  assert.deepEqual(hole.range, [6, 14]);
  assert.deepEqual(hole.ends, [[0, 0, 0], [0, 0, 8]]);
  assert.equal(hole.polarity, -1);
  assert.equal(at(context, [20, 0, 14]).polarity, 1);
  const faces = context.shape.faces;
  try { assert.equal(readCylinderFace(faces.find(face => face.geomType === "PLANE")), null); }
  finally { faces.forEach(face => face.delete()); }
});

test("initial hole and two equal-radius posts resolve independently in either creation order", () => {
  for (const order of [[20, -20], [-20, 20]]) {
    const context = build([base(), ...order.map(x => post(x))]);
    expectDriver(driverAt(context, [0, 0, 4]), 0, "baseHole");
    for (let index = 0; index < order.length; index++) expectDriver(driverAt(context, [order[index], 0, 14]), index + 1);
  }
});

test("multiple equal-radius circles in one sketch resolve the correct entity", () => {
  const op = post(0);
  op.entities = [{ kind: "circle", c: [20, 0], r: 6 }, { kind: "circle", c: [-20, 0], r: 6 }];
  const context = build([base(), op]);
  expectDriver(driverAt(context, [20, 0, 14]), 1, "sketchCircle", 0);
  expectDriver(driverAt(context, [-20, 0, 14]), 1, "sketchCircle", 1);
});

test("axis range distinguishes coaxial equal-radius cylinders at separate heights", () => {
  const context = build([base(), post(20, 0, 8, 6, 4), post(20, 0, 24, 6, 4)]);
  expectDriver(driverAt(context, [20, 0, 10]), 1);
  expectDriver(driverAt(context, [20, 0, 26]), 2);
});

test("resolved circle dimensions are used without changing stored sketch definitions", () => {
  const op = post(20, 0, 8, 3);
  op.constraints = [{ type: "fixed", e: 0, k: "r", value: 6, label: "R6" }];
  const context = build([base(), op]);
  const before = JSON.stringify(context.history.map(step => step.op));
  const volume = R.measureVolume(context.shape);
  const found = expectDriver(driverAt(context, [20, 0, 14]), 1);
  near(found.value, 6);
  assert.equal(JSON.stringify(context.history.map(step => step.op)), before);
  near(R.measureVolume(context.shape), volume);
});

test("cut circle maps a hole to its own feature, not a nearby post or the base hole", () => {
  const context = build([base(), post(20), post(-20, 0, 8, 6, -8)]);
  expectDriver(driverAt(context, [-20, 0, 4]), 2);
  expectDriver(driverAt(context, [20, 0, 14]), 1);
  expectDriver(driverAt(context, [0, 0, 4]), 0, "baseHole");
});

test("whole-model rotation and translation preserve the original circle and base-hole drivers", () => {
  for (const pivotMode of ["origin", "center"]) {
    const original = build([base(), post(20), post(-20)]);
    const pivot = pivotMode === "center" ? new THREE.Vector3(...original.shape.boundingBox.center) : new THREE.Vector3();
    const move = { type: "move3d", rot: 37, axis: "Y", pivot: pivotMode, dx: 9, dy: 4, dz: 11 };
    const context = build([base(), post(20), post(-20), move]);
    const moved = p => new THREE.Vector3(...p).sub(pivot).applyAxisAngle(new THREE.Vector3(0, 1, 0), 37 * Math.PI / 180)
      .add(pivot).add(new THREE.Vector3(9, 4, 11)).toArray();
    expectDriver(driverAt(context, moved([0, 0, 4])), 0, "baseHole");
    expectDriver(driverAt(context, moved([20, 0, 14])), 1);
    expectDriver(driverAt(context, moved([-20, 0, 14])), 2);
  }
});

test("linear copies resolve to their source circle including a post coaxial with the base hole", () => {
  const context = build([base(), post(-20), { type: "pattern", kind: "linear", source: 1, count: 3,
    direction: [1, 0, 0], spacing: 20, operation: "fuse" }]);
  for (const x of [-20, 0, 20]) expectDriver(driverAt(context, [x, 0, 14]), 1);
  expectDriver(driverAt(context, [0, 0, 4]), 0, "baseHole");
});

test("circular copies and mirror copies resolve to their source circle", () => {
  const circular = build([base(), post(15, 0, 8, 3), { type: "pattern", kind: "circular", source: 1,
    count: 4, axisDir: [0, 0, 1], axisPoint: [0, 0, 8], angle: 360, operation: "fuse" }]);
  for (const [x, y] of [[15, 0], [0, 15], [-15, 0], [0, -15]]) expectDriver(driverAt(circular, [x, y, 14], 3), 1);
  const mirror = build([base(), post(20), { type: "mirror", source: 1, plane: "YZ", at: "offset", offset: 3, operation: "fuse" }]);
  expectDriver(driverAt(mirror, [-14, 0, 14]), 1);
});

test("pattern after move uses the original source-tool coordinates just like replay", () => {
  const context = build([base(), post(20), { type: "move3d", dx: 100 },
    { type: "pattern", kind: "linear", source: 1, count: 2, direction: [1, 0, 0], spacing: 10, operation: "fuse" }]);
  expectDriver(driverAt(context, [120, 0, 14]), 1);
  expectDriver(driverAt(context, [30, 0, 14]), 1);
  expectDriver(driverAt(context, [100, 0, 4]), 0, "baseHole");
});

test("different source circles producing the same cylinder are rejected as ambiguous", () => {
  const context = build([base(), post(20), post(20)]);
  assert.deepEqual(driverAt(context, [20, 0, 14]), []);
});

test("unrelated native cylinders do not fall back to the only available circle", () => {
  const context = build([base(), post(20, 0, 8, 4)]);
  context.shape = context.shape.clone().fuse(R.makeCylinder(4.1, 12, [-20, 0, 8], [0, 0, 1]));
  assert.deepEqual(driverAt(context, [-20, 0, 14], 4.1), []);
  assert.deepEqual(findSurfaceDrivers({ ...context, faceId: -1 }), []);
});

test("suppressed, future, reference-only and unselected circles cannot become drivers", () => {
  const context = build([base(), post(20), post(-20)]);
  const leftFace = at(context, [-20, 0, 14]).faceId;
  assert.deepEqual(findSurfaceDrivers({ ...context, hIndex: 1, faceId: leftFace }), []);
  context.history[2].suppressed = true;
  assert.deepEqual(findSurfaceDrivers({ ...context, faceId: leftFace }), []);
  context.history[2].suppressed = false;
  context.history[2].op.entities[0].ref = true;
  assert.deepEqual(findSurfaceDrivers({ ...context, faceId: leftFace }), []);
  delete context.history[2].op.entities[0].ref;
  context.history[2].op.selected = [1];
  assert.deepEqual(findSurfaceDrivers({ ...context, faceId: leftFace }), []);
});

test("new cylindrical fillet faces resolve only to the step that created them", () => {
  const block = { ...post(0, 0, 0), entities: [{ kind: "rect", c: [0, 0], w: 60, h: 40 }], depth: 8 };
  const initial = build([block]);
  const mids = initial.shape.edges.map(OPS.edgeMidPoint).filter(p => p && Math.abs(p[0] - 30) < 1e-5 && Math.abs(p[1] - 20) < 1e-5);
  assert.equal(mids.length, 1);
  const context = build([block, { type: "fillet", radius: 2, edgeRefs: makeEdgeRefs(initial.shape, mids) }]);
  const fillet = cylinders(context.shape).find(c => Math.abs(c.radius - 2) < 1e-5);
  assert.ok(fillet);
  expectDriver(findSurfaceDrivers({ ...context, faceId: fillet.faceId }), 1, "fillet");
});
