import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import opencascade from "replicad-opencascadejs";
import * as R from "replicad";
import { Vector3 } from "three";
import * as OPS from "./src/ops.js";
import { SketchSession } from "./src/sketch.js";
import { rebuild, replayOp, resolvePlane } from "./src/replay.js";
import { projectDefinition, restoreProject } from "./src/project.js";

R.setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));
const near = (actual, expected, tolerance = 1e-5) => assert.ok(
  Math.abs(actual - expected) <= tolerance, `${actual} should equal ${expected}`,
);
const pointNear = (actual, expected) => actual.forEach((value, axis) => near(value, expected[axis]));
const clone = (value) => JSON.parse(JSON.stringify(value));

function supportingFace(shape, normal, planePoint) {
  const n = new Vector3(...normal);
  const p = new Vector3(...planePoint);
  const face = shape.faces.find((candidate) => {
    const fn = new Vector3(...OPS.normalOf(candidate));
    return fn.dot(n) > 0.99999
      && Math.abs(new Vector3(candidate.center.x, candidate.center.y, candidate.center.z).sub(p).dot(n)) < 1e-5;
  });
  assert.ok(face, `supporting face at ${planePoint} with normal ${normal} exists`);
  return face;
}

function circleOnFace(shape, face, center, radius = 3, originOffset = [0, 0]) {
  const sketch = new SketchSession(shape, face.hashCode);
  const plane = clone(sketch.planeDesc);
  // The support-face reference and the chosen sketch origin are independent data.
  sketch.origin.addScaledVector(sketch.xDir, originOffset[0]).addScaledVector(sketch.yDir, originOffset[1]);
  plane.origin = sketch.origin.toArray();
  const c = sketch.to2D(new Vector3(...center));
  return {
    type: "extrude", plane, entities: [{ kind: "circle", c: [c.x, c.y], r: radius }],
    selected: [], constraints: [], depth: 6, grow: 0,
  };
}

function apply(shape, op) {
  const context = {};
  return { shape: replayOp(shape, op, context), tool: context.tool };
}

function twoBosses(plate, normal, planePoint, firstCenter, secondCenter, originOffset) {
  const right = circleOnFace(plate, supportingFace(plate, normal, planePoint), firstCenter);
  const rightResult = apply(plate, right);
  const left = circleOnFace(rightResult.shape, supportingFace(rightResult.shape, normal, planePoint), secondCenter, 2, originOffset);
  return { right, left, before: apply(rightResult.shape, left), supportBefore: left.plane.faceRef.center };
}

test("resizing the first boss on the starter plate does not move the second boss", () => {
  const plate = OPS.starterModel();
  const { right, left } = twoBosses(plate, [0, 0, 1], [0, 0, 8], [15, 0, 8], [-15, 0, 8]);
  const history = [{ op: { type: "base" } }, { op: right }, { op: left }];
  const original = rebuild(history, 2);
  pointNear(original.tools[2].boundingBox.center, [-15, 0, 11]);
  const edited = clone(right);
  edited.entities[0].r = 6;
  const result = rebuild(history, 2, { 1: edited });
  const supportAfter = supportingFace(result.snapshots[1].shape, [0, 0, 1], [0, 0, 8]).center;
  assert.ok(Math.abs(supportAfter.x - left.plane.faceRef.center[0]) > 0.1, "the face centroid really changed");
  pointNear(result.tools[2].boundingBox.center, [-15, 0, 11]);
  near(R.measureVolume(result.shape) - R.measureVolume(original.shape), Math.PI * (36 - 9) * 6);
  assert.equal(right.entities[0].r, 3, "rebuild does not mutate the source definition");
});

test("legacy face-plane data without origin uses its saved reference center", () => {
  const plate = OPS.starterModel();
  const { right, left } = twoBosses(plate, [0, 0, 1], [0, 0, 8], [15, 0, 8], [-15, 0, 8]);
  delete left.plane.origin;
  pointNear(apply(apply(plate, right).shape, left).tool.boundingBox.center, [-15, 0, 11]);
  right.entities[0].r = 6;
  pointNear(apply(apply(plate, right).shape, left).tool.boundingBox.center, [-15, 0, 11]);
});

test("large boss diameter changes can recover the broad support face beyond centroid tolerance", () => {
  const plate = OPS.starterModel();
  const { right, left } = twoBosses(plate, [0, 0, 1], [0, 0, 8], [15, 0, 8], [-15, 0, 8]);
  right.entities[0].r = 12;
  const changed = apply(plate, right).shape;
  const support = supportingFace(changed, [0, 0, 1], [0, 0, 8]);
  assert.ok(Math.abs(support.center.x - left.plane.faceRef.center[0]) > 2.5);
  pointNear(apply(changed, left).tool.boundingBox.center, [-15, 0, 11]);
  // Normal movement and in-plane centroid changes may happen together.
  pointNear(apply(changed.translate([0, 0, 7]), left).tool.boundingBox.center, [-15, 0, 18]);
});

test("support recovery rejects ambiguous parallel faces instead of choosing the nearest height", () => {
  const old = R.makeBaseBox(60, 40, 8);
  const op = circleOnFace(old, supportingFace(old, [0, 0, 1], [0, 0, 8]), [-15, 0, 8]);
  const a = R.makeBaseBox(30, 20, 2).translate([6, 0, 10]);
  const b = R.makeBaseBox(30, 20, 2).translate([-6, 0, 14]);
  assert.throws(() => resolvePlane(R.makeCompound([a, b]), op.plane), /多个.*无法唯一/);
});

test("face sketches keep their in-plane position while following changed plate thickness", () => {
  const plate = R.makeBaseBox(60, 40, 8).translate([17, 31, 5]);
  const { right, left } = twoBosses(plate, [0, 0, 1], [17, 31, 13], [32, 31, 13], [2, 31, 13]);
  const taller = R.makeBaseBox(60, 40, 15).translate([17, 31, 5]);
  right.entities[0].r = 6;
  const result = apply(apply(taller, right).shape, left);
  pointNear(result.tool.boundingBox.center, [2, 31, 23]);
  near(result.tool.boundingBox.depth, 6);
  near(R.measureVolume(result.shape), 60 * 40 * 15 + Math.PI * (36 + 4) * 6);
});

for (const normal of [[1, 0, 0], [0, -1, 0], [0, 0, -1]]) {
  test(`offset side/bottom sketch origin stays stable for normal ${normal}`, () => {
    const plate = R.makeBaseBox(70, 70, 70).translate([17, 31, 5]);
    const face = plate.faces.find((candidate) => new Vector3(...OPS.normalOf(candidate)).dot(new Vector3(...normal)) > 0.99999);
    const frame = new SketchSession(plate, face.hashCode);
    const planePoint = frame.origin.toArray();
    const firstCenter = frame.to3D(14, 0).toArray();
    const secondCenter = frame.to3D(-14, 3).toArray();
    const { right, left, before } = twoBosses(plate, normal, planePoint, firstCenter, secondCenter, [5, -4]);
    const expected = secondCenter.map((value, axis) => value + normal[axis] * 3);
    pointNear(before.tool.boundingBox.center, expected);
    right.entities[0].r = 7;
    // Move the support in its normal direction as well as changing its centroid.
    const movement = normal.map((value) => value * 4);
    const translated = plate.translate(movement);
    const result = apply(apply(translated, right).shape, left);
    pointNear(result.tool.boundingBox.center, expected.map((value, axis) => value + movement[axis]));
    near(R.measureVolume(result.tool), Math.PI * 4 * 6);
  });
}

test("an oblique support frame follows only its normal displacement", () => {
  const angle = 37 * Math.PI / 180;
  const normal = [Math.sin(angle), 0, Math.cos(angle)];
  const plate = R.makeBaseBox(70, 70, 70).rotate(37, [0, 0, 0], [0, 1, 0]).translate([17, 31, 5]);
  const face = plate.faces.find((candidate) => new Vector3(...OPS.normalOf(candidate)).dot(new Vector3(...normal)) > 0.99999);
  const frame = new SketchSession(plate, face.hashCode);
  const secondCenter = frame.to3D(-14, 3).toArray();
  const { right, left } = twoBosses(plate, normal, frame.origin.toArray(), frame.to3D(14, 0).toArray(), secondCenter, [5, -4]);
  right.entities[0].r = 7;
  const changed = apply(plate.translate(normal.map((value) => value * 4)), right).shape;
  pointNear(apply(changed, left).tool.boundingBox.center, secondCenter.map((value, axis) => value + normal[axis] * 7));
});

test("saved face frames remain unchanged across repeated rebuild and project restore", () => {
  const plate = OPS.starterModel();
  const { right, left } = twoBosses(plate, [0, 0, 1], [0, 0, 8], [15, 0, 8], [-15, 0, 8]);
  const history = [{ op: { type: "base" } }, { op: right }, { op: left }];
  right.entities[0].r = 6;
  const definition = projectDefinition("Stable face origin", history, 2);
  const original = JSON.stringify(definition);
  for (let i = 0; i < 3; i++) {
    const restored = restoreProject(clone(definition));
    pointNear(restored.history[2].toolShape.boundingBox.center, [-15, 0, 11]);
    assert.equal(JSON.stringify(definition), original);
  }
});

test("datum origins remain absolute and do not depend on a support face", () => {
  const p = { kind: "datum", name: "XY", origin: [17, 31, 5], normal: [0, 0, 1], xDir: [1, 0, 0] };
  pointNear(resolvePlane(null, p).origin.toArray(), p.origin);
});

test("a restored sketch preserves its support reference independently of its offset origin", () => {
  const plate = OPS.starterModel();
  const { right, left } = twoBosses(plate, [0, 0, 1], [0, 0, 8], [15, 0, 8], [-15, 0, 8], [5, -4]);
  const changed = apply(plate, right).shape.translate([0, 0, 7]);
  const restored = new SketchSession(changed, null, { ...resolvePlane(changed, left.plane), name: "实体面" });
  assert.deepEqual(restored.planeDesc.faceRef, left.plane.faceRef);
  pointNear(restored.planeDesc.origin, left.plane.origin.map((value, axis) => value + (axis === 2 ? 7 : 0)));
  assert.equal(restored.planeDesc.kind, "face");
  assert.ok(restored.faceId != null, "the recovered support face remains available to editing tools");
  assert.ok(restored.face);
  restored.planeDesc.faceRef.center[0] = 999;
  assert.notEqual(left.plane.faceRef.center[0], 999, "saved input remains detached");
  assert.notEqual(restored.planeDesc.faceRef.center[0], 999, "getter does not expose mutable internal references");
});
