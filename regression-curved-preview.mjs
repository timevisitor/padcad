import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import * as THREE from "three";
import opencascade from "replicad-opencascadejs";
import { setOC, measureVolume } from "replicad";
import { DimHandle } from "./src/handle.js";
import { SketchSession } from "./src/sketch.js";
import { findSurfaceDrivers, readCylinderFace } from "./src/surface-drivers.js";
import { rebuildPreview } from "./src/preview-rebuild.js";
import { meshOf } from "./src/kernel.js";
import * as OPS from "./src/ops.js";
import { solveSketch } from "./src/solver.js";
import { rebuild, RefLost } from "./src/replay.js";
import { cacheRebuild, projectDefinition, restoreProject } from "./src/project.js";

setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));
const source = fs.readFileSync("./src/main.js", "utf8");
const noop = () => {};
const near = (a, b, tolerance = 1e-4) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const definitions = history => JSON.stringify(history.map(h => ({ op: h.op, detail: h.detail, suppressed: h.suppressed })));

class Element {
  constructor() {
    this.events = new Map();
    const classes = new Set(["hidden"]);
    this.classList = { add: (...names) => names.forEach(n => classes.add(n)),
      remove: (...names) => names.forEach(n => classes.delete(n)), contains: n => classes.has(n) };
    this.style = {};
  }
  addEventListener(name, cb) { this.events.set(name, [...(this.events.get(name) || []), cb]); }
  emit(name, x = 100, id = 1) {
    for (const cb of this.events.get(name) || []) cb({ pointerId: id, clientX: x, clientY: 100,
      preventDefault: noop, stopPropagation: noop });
  }
  setPointerCapture() {}
}

function threeCircleHistory() {
  const history = [{ label: "起始零件", op: { type: "base" } }];
  cacheRebuild(history, rebuild(history, 0));
  for (const x of [20, -20]) {
    const base = history.at(-1).shape;
    const top = base.faces.find(face => face.geomType === "PLANE" && Math.abs(face.center.z - 8) < 1e-5 && OPS.normalOf(face)[2] > 0.99);
    assert.ok(top);
    const sketch = new SketchSession(base, top.hashCode);
    const center = sketch.to2D(new THREE.Vector3(x, 0, 8));
    history.push({ label: x > 0 ? "右柱（先建）" : "左柱（后建）", op: { type: "extrude", plane: sketch.planeDesc,
      entities: [{ kind: "circle", c: [center.x, center.y], r: 6 }], constraints: [], depth: 8, grow: 0 } });
    cacheRebuild(history, rebuild(history, history.length - 1));
  }
  return history;
}

function fixture({ axis = "Z", downstream = false, cursor = null, multiple = false, targetX = 0 } = {}) {
  const plane = axis === "Z"
    ? { kind: "datum", name: "XY", origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] }
    : { kind: "datum", name: "YZ", origin: [3, 4, 5], normal: [1, 0, 0], xDir: [0, 1, 0] };
  const rows = multiple ? threeCircleHistory() : [{ label: "圆柱", op: { type: "extrude", plane, entities: [{ kind: "circle", c: [0, 0], r: 2 }],
    constraints: [{ type: "fixed", e: 0, k: "r", value: 2 }], depth: 5, grow: 0 } }];
  if (downstream) rows.push({ label: "阵列", op: { type: "pattern", kind: "linear", source: 0,
    count: 3, spacing: 20, direction: [1, 0, 0], operation: "fuse" } });
  cacheRebuild(rows, rebuild(rows, rows.length - 1));
  const hIndex = cursor ?? rows.length - 1;
  const shape = rows[hIndex].shape;
  const initialMesh = meshOf(shape);
  const face = initialMesh.faceGroups.find(g => OPS.classifyFace(initialMesh, g.faceId)?.kind === "cylinder");
  assert.ok(face, "fixture must have a selectable cylindrical face");
  const elements = new Map(["dimHandle", "dimDot", "dimValue", "dimLeader", "stats"].map(id => [id, new Element()]));
  globalThis.document = { getElementById: id => elements.get(id) };
  const c = vm.createContext({ history: rows, hIndex, shape, dimBase: null, dimTarget: null, dimRaf: 0, dim: null,
    curvedDriver: { i: 0, sub: 0, key: "r", kind: "sketchCircle", value: 2 }, faceClass: { kind: "cylinder" },
    selectedFaceId: face.faceId, selSnap: {}, mode: "select", awaitingExtrude: false,
    DimHandle, THREE, OPS: { ...OPS, pushPullFace() { throw new Error("曲面尺寸不应调用普通面推拉"); } },
    solveSketch, rebuild, rebuildPreview, cacheRebuild, RefLost, performance, findSurfaceDrivers, readCylinderFace,
    curvedPreviewResult: null,
    meshOf, api: { measureVolume }, bbox: null, canvas: {}, renderTree: noop, cancelEdit: noop,
  });
  const frames = new Map(); let frameId = 0;
  c.requestAnimationFrame = cb => { frames.set(++frameId, cb); return frameId; };
  c.cancelAnimationFrame = id => frames.delete(id);
  c.$ = id => elements.get(id);
  c.setStats = message => { c.message = message; elements.get("stats").textContent = message; };
  c.selectFace = () => { c.dim.hide(); c.curvedDriver = null; c.faceClass = null; };
  c.viewer = { invalidate: noop, clearHighlight: noop, clearPreviewWire: noop,
    clearSketchLines: noop, setMesh: data => { c.mesh = data; }, setEdgeData: noop };
  const functions = ["curvedDimSpec", "refresh", "setupDim", "scheduleDimPreview", "applyDimPreview", "commitDimValue",
    "commitCurvedDim", "detailOf", "acceptRebuild", "curvedDimOperation", "previewCurvedDim", "discardCurvedPreview", "gotoStep"];
  for (const name of functions) {
    const fn = source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "m"));
    assert.ok(fn, `missing ${name}`); vm.runInContext(fn[0], c);
  }
  c.flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb()); };
  c.pendingFrames = () => frames.size;
  c.setupDim();
  c.dim.show({ anchor: new THREE.Vector3(), dir: new THREE.Vector3(1, 0, 0), value: 4, prefix: "Ø", min: 0.2, max: 400 });
  c.dim._axis = { x: 1, y: 0, ppu: 10 };
  c.refresh();
  c.dot = elements.get("dimDot");
  if (multiple) {
    c.viewer.highlightFace = noop;
    c.showPicker = noop;
    c.classifyCached = () => ({ kind: "plane" });
    c.showPushPullDim = () => { throw new Error("圆柱不可回退成平面推拉"); };
    for (const name of ["radialDir", "showCurvedDim", "findCurvedDriver", "selectFace"]) {
      vm.runInContext(source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "m"))[0], c);
    }
    c.pickCylinder = x => {
      const face = c.shape.faces.find(f => {
        const cylinder = readCylinderFace(f);
        return cylinder && Math.abs(cylinder.axisPoint[0] - x) < 1e-4;
      });
      assert.ok(face, `cylinder at ${x} must exist`);
      c.selectFace(face.hashCode);
      c.dim._axis = { x: 1, y: 0, ppu: 10 };
      return face.hashCode;
    };
    c.pickCylinder(targetX);
  }
  return c;
}

function meshSpan(c, component) {
  const values = Array.from(c.mesh.vertices).filter((_, i) => i % 3 === component);
  return Math.max(...values) - Math.min(...values);
}

test("drag previews the requested cylinder diameter in the actual mesh before pointerup", () => {
  for (const axis of ["Z", "X"]) {
    const c = fixture({ axis }), initial = c.shape, before = definitions(c.history), cached = c.history[0].shape;
    c.dot.emit("pointerdown");
    for (const [x, diameter] of [[140, 8], [120, 6], [80, 2]]) {
      c.dot.emit("pointermove", x); c.flush();
      near(c.dim.value, diameter);
      near(measureVolume(c.shape), Math.PI * (diameter / 2) ** 2 * 5);
      near(meshSpan(c, axis === "Z" ? 0 : 1), diameter, 0.1);
      assert.equal(definitions(c.history), before);
      assert.equal(c.history[0].shape, cached);
    }
    near(measureVolume(initial), Math.PI * 4 * 5, 1e-3);
    c.dot.emit("pointercancel", 80);
    assert.equal(c.shape, initial);
  }
});

test("pending drag updates use the latest value and cancel restores geometry without changing history", () => {
  for (const ending of ["pointercancel", "lostpointercapture", "hide"]) {
    const c = fixture(), original = c.shape, before = definitions(c.history);
    c.dot.emit("pointerdown"); c.dot.emit("pointermove", 140); c.dot.emit("pointermove", 160);
    assert.equal(c.pendingFrames(), 1); c.flush();
    near(measureVolume(c.shape), Math.PI * 25 * 5);
    c.dot.emit("pointermove", 170);
    if (ending === "hide") c.dim.hide(); else c.dot.emit(ending, 170);
    c.flush();
    assert.equal(c.shape, original); near(meshSpan(c, 0), 4, 0.1);
    assert.equal(definitions(c.history), before);
    assert.equal(c.dim.value, 4); assert.equal(c.pendingFrames(), 0);
  }
});

test("pointerup commits the final diameter once, rebuilds downstream and survives project restore", () => {
  const c = fixture({ downstream: true }), previous = definitions(c.history);
  c.dot.emit("pointerdown"); c.dot.emit("pointermove", 140); c.flush();
  near(measureVolume(c.shape), 3 * Math.PI * 16 * 5);
  assert.equal(definitions(c.history), previous);
  c.dot.emit("pointermove", 160); c.dot.emit("pointerup", 160); c.flush();
  assert.equal(c.history.length, 2); assert.equal(c.history[0].op.entities[0].r, 5);
  assert.equal(c.history[0].op.constraints[0].value, 5);
  near(measureVolume(c.shape), 3 * Math.PI * 25 * 5);
  near(measureVolume(c.history[0].shape), Math.PI * 25 * 5);
  const restored = restoreProject(projectDefinition("直径预览回归", c.history, c.hIndex));
  near(measureVolume(restored.shape), measureVolume(c.shape));
});

test("failed preview preserves the last valid mesh, then failed commit restores the original model and value", () => {
  const c = fixture(), original = c.shape, before = definitions(c.history);
  c.dot.emit("pointerdown"); c.dot.emit("pointermove", 140); c.flush();
  const preview = c.shape, mesh = c.mesh;
  c.rebuild = () => { throw new Error("下游引用失效"); };
  c.rebuildPreview = c.rebuild;
  c.dot.emit("pointermove", 160); c.flush();
  assert.equal(c.shape, preview); assert.equal(c.mesh, mesh);
  assert.match(c.message, /下游引用失效/);
  c.dot.emit("pointerup", 160);
  assert.equal(c.shape, original); near(meshSpan(c, 0), 4, 0.1);
  assert.equal(definitions(c.history), before); assert.equal(c.dim.value, 4);
  assert.match(c.message, /下游引用失效/);
});

test("empty preview mesh cannot replace the last valid displayed solid", () => {
  const c = fixture(), original = c.shape, mesh = c.mesh;
  c.meshOf = () => ({ triCount: 0, triangles: new Uint32Array() });
  c.dot.emit("pointerdown"); c.dot.emit("pointermove", 140); c.flush();
  assert.equal(c.shape, original); assert.equal(c.mesh, mesh);
  assert.match(c.message, /预览|网格/);
});

test("preview and cancel at a rollback position preserve the redo branch", () => {
  const c = fixture({ downstream: true, cursor: 0 }), before = definitions(c.history), future = c.history[1].shape;
  c.dot.emit("pointerdown"); c.dot.emit("pointermove", 140); c.flush();
  near(measureVolume(c.shape), Math.PI * 16 * 5);
  c.dot.emit("pointercancel", 140);
  assert.equal(c.history.length, 2); assert.equal(c.hIndex, 0);
  assert.equal(c.history[1].shape, future); assert.equal(definitions(c.history), before);
});

test("history navigation during a drag cancels before replacing the displayed snapshot", () => {
  const c = fixture({ downstream: true }), target = c.history[0].shape;
  c.dot.emit("pointerdown"); c.dot.emit("pointermove", 140); c.flush();
  c.dot.emit("pointermove", 160);
  c.gotoStep(0); c.flush();
  assert.equal(c.hIndex, 0); assert.equal(c.shape, target);
  near(measureVolume(c.shape), Math.PI * 4 * 5);
  near(meshSpan(c, 0), 4, 0.1);
  assert.equal(c.dimBase, null); assert.equal(c.pendingFrames(), 0);
  c.dot.emit("pointerup", 160);
  assert.equal(c.history[0].op.entities[0].r, 2);
});

function assertThreeCircles(shape, expectedRadii) {
  const cylinders = shape.faces.map(readCylinderFace).filter(Boolean).sort((a, b) => a.axisPoint[0] - b.axisPoint[0]);
  assert.equal(cylinders.length, 3);
  cylinders.forEach((c, i) => {
    near(c.axisPoint[0], [-20, 0, 20][i]); near(c.axisPoint[1], 0);
    near(c.radius, expectedRadii[i]);
    assert.equal(c.polarity, i === 1 ? -1 : 1);
    const heights = c.ends.map(p => p[2]).sort((a, b) => a - b);
    near(heights[0], i === 1 ? 0 : 8); near(heights[1], i === 1 ? 8 : 16);
  });
}

test("starter hole and two sequential same-radius bosses preview and commit only their own diameter", () => {
  for (const targetX of [0, 20, -20]) {
    const c = fixture({ multiple: true, targetX }), before = definitions(c.history);
    const step = targetX === 0 ? 0 : targetX === 20 ? 1 : 2;
    assert.equal(c.curvedDriver.i, step);
    assert.equal(c.curvedDriver.kind, step === 0 ? "baseHole" : "sketchCircle");
    assert.equal(c.dim.value, 12);
    c.dot.emit("pointerdown");
    for (const [x, radius] of [[140, 8], [80, 5]]) {
      c.dot.emit("pointermove", x); c.flush();
      const expected = [6, 6, 6]; expected[[-20, 0, 20].indexOf(targetX)] = radius;
      assertThreeCircles(c.shape, expected);
      assert.equal(definitions(c.history), before);
      assert.ok(c.mesh.triCount > 0);
    }
    c.dot.emit("pointerup", 80);
    const expected = [6, 6, 6]; expected[[-20, 0, 20].indexOf(targetX)] = 5;
    assertThreeCircles(c.shape, expected);
    assert.equal(c.history.length, 3);
    assert.equal(step === 0 ? c.history[0].op.holeRadius : c.history[step].op.entities[0].r, 5);
    const restored = restoreProject(projectDefinition("孔和双柱", c.history, c.hIndex));
    assertThreeCircles(restored.shape, expected);
    c.shape = restored.shape; c.history = restored.history; c.hIndex = restored.hIndex;
    c.pickCylinder(targetX);
    assert.equal(c.curvedDriver.i, step);
    c.dot.emit("pointerdown"); c.dot.emit("pointermove", 120); c.flush(); c.dot.emit("pointercancel", 120);
    assertThreeCircles(c.shape, expected);
  }
});

test("a second touch on another cylinder cannot replace an active diameter drag source", () => {
  const c = fixture({ multiple: true, targetX: 20 });
  const selected = c.selectedFaceId, driver = c.curvedDriver;
  c.dot.emit("pointerdown"); c.dot.emit("pointermove", 140); c.flush();
  c.pickCylinder(-20);
  assert.equal(c.selectedFaceId, selected); assert.equal(c.curvedDriver, driver);
  assert.equal(c.dim.dragging, true);
  c.dot.emit("pointerup", 140);
  assertThreeCircles(c.shape, [6, 6, 8]);
});

test("invalid starter hole dimensions reject rebuilding while old definitions keep the 12 mm hole", () => {
  near(measureVolume(OPS.starterModel()), 60 * 40 * 8 - Math.PI * 6 ** 2 * 8);
  for (const holeRadius of [0, -1, Infinity, NaN, 20, 25]) assert.throws(() => OPS.starterModel({ holeRadius }), /孔直径/);
  const c = fixture({ multiple: true }), before = definitions(c.history), initial = c.shape;
  c.commitCurvedDim(40);
  assert.equal(c.shape, initial); assert.equal(definitions(c.history), before); assert.equal(c.dim.value, 12);
});

// Keep a reproducible document for independent browser validation; no user document is modified.
fs.writeFileSync("out/surface-driver-example.padcad.json", JSON.stringify(projectDefinition("圆孔与双柱手柄验证", threeCircleHistory(), 2), null, 2));
