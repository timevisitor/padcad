import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import * as THREE from "three";
import opencascade from "replicad-opencascadejs";
import { setOC, makeCylinder } from "replicad";
import * as OPS from "./src/ops.js";
import { DimHandle } from "./src/handle.js";

const source = fs.readFileSync("./src/main.js", "utf8");
const noop = () => {};
const appFunction = name => {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "m"));
  assert.ok(match, `missing ${name}`);
  return match[0];
};
const callback = name => {
  const match = source.match(new RegExp(`^viewer\\.cam\\.${name} = [^]*?^\\};`, "m"));
  assert.ok(match, `missing ${name}`);
  return match[0];
};

class Element {
  constructor() {
    this.events = new Map();
    const classes = new Set(["hidden"]);
    this.classList = { add: (...xs) => xs.forEach(x => classes.add(x)),
      remove: (...xs) => xs.forEach(x => classes.delete(x)), contains: x => classes.has(x) };
    this.innerHTML = ""; this.style = {}; this.value = "5";
    this.input = { value: "5" }; this.button = {};
  }
  querySelector(selector) { return selector === "#dist" ? this.input : this.button; }
  addEventListener(name, cb) { this.events.set(name, [...(this.events.get(name) || []), cb]); }
  setPointerCapture() {}
  emit(name, x = 100) {
    for (const cb of this.events.get(name) || []) cb({ pointerId: 1, clientX: x, clientY: 100,
      preventDefault: noop, stopPropagation: noop });
  }
}

function fixture(functions = []) {
  const elements = new Map();
  const getElement = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  globalThis.document = { getElementById: getElement };
  const planar = { geomType: "PLANE", hashCode: 1 }, curved = { geomType: "CYLINDER", hashCode: 2 };
  const original = { faces: [planar, curved] };
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 1000);
  camera.position.set(20, -60, 30); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const frames = new Map(); let frameId = 0;
  const c = vm.createContext({ THREE, DimHandle, performance, shape: original, mode: "select", busy: false,
    discardCurvedPreview: noop,
    selectedFaceId: 2, selSnap: { center: [0, 0, 0], normal: new THREE.Vector3(1, 0, 0) },
    curvedDriver: { kind: "sketchCircle", value: 4 }, faceClass: { kind: "cylinder" },
    dimBase: null, dimRaf: 0, dimTarget: null, dim: null, awaitingExtrude: false,
    edgeSel: [], edgeKind: "fillet", drag: null, grabState: null, drawing: null,
    // 拖动事件按帧合并所需的状态（见 main.js 的 flushDragFrame）。
    _dragFrame: 0, _dragEvent: null,
    sketch: null, snapGuides: [], snap: { clear: noop },
    canvas: { getBoundingClientRect: () => ({ width: 800, height: 800, left: 0, top: 0 }) },
    $: getElement, OPS: { findFace: (base, id) => base?.faces?.find(f => f.hashCode === id),
      edgePointSets: () => [], pushPullFace: () => { c.pushed++; return c.preview; }, volumeOf: () => 1,
      filletEdges: () => { c.edgeApplied++; return { shape: c.preview, ok: 1 }; },
      chamferEdges: () => { c.edgeApplied++; return { shape: c.preview, ok: 1 }; } },
  });
  c.preview = { faces: original.faces }; c.pushed = 0; c.curvedApplied = 0; c.edgeApplied = 0;
  c.commits = []; c.wires = []; c.refreshes = 0;
  c.viewer = { cam: {}, camera, invalidate: noop, clearHighlight: noop, highlightEdges: noop,
    clearPreviewWire: noop, setEdgeData: noop, pickAt: () => ({ faceId: c.selectedFaceId }),
    setPreviewWire: wire => c.wires.push(wire) };
  c.requestAnimationFrame = cb => { frames.set(++frameId, cb); return frameId; };
  c.cancelAnimationFrame = id => frames.delete(id);
  c.flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb()); };
  c.pending = () => frames.size;
  c.refresh = () => { c.refreshes++; };
  c.setStats = message => { c.message = message; };
  c.showPicker = noop; c.renderTree = noop;
  c.setMode = value => { c.mode = value; };
  c.filletWireframe = value => ({ value });
  c.makeEdgeRefs = () => [{}];
  c.previewCurvedDim = () => { c.shape = c.preview; c.curvedApplied++; };
  c.commitCurvedDim = () => { c.curvedApplied++; };
  c.commitPushPull = (...args) => c.commits.push(args);
  c.commit = (...args) => c.commits.push(args);
  c.showPushPullDim = noop; c.selectFace = noop;
  for (const name of ["isPlanarPushPullFace", "flushDragFrame", "applyDrag", ...functions]) vm.runInContext(appFunction(name), c);
  c.original = original;
  return c;
}

test("ordinary push-pull eligibility uses the native face type, including a real cylinder end cap", async () => {
  setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));
  const c = fixture(), solid = makeCylinder(3, 8);
  c.OPS = OPS;
  const side = solid.faces.find(f => f.geomType === "CYLINDRE");
  const cap = solid.faces.find(f => f.geomType === "PLANE");
  assert.ok(side && cap);
  assert.equal(c.isPlanarPushPullFace(solid, side.hashCode), false);
  assert.equal(c.isPlanarPushPullFace(solid, cap.hashCode), true);
  assert.equal(c.isPlanarPushPullFace(solid, -1), false);
});

test("curved picker exposes size guidance without a direct push-pull button; planar picker remains usable", () => {
  const c = fixture(["showPicker", "applyPushPull"]);
  const info = id => ({ faceId: id, normal: [1, 0, 0], center: [0, 0, 0] });
  c.showPicker(info(2));
  assert.doesNotMatch(c.$("picker").innerHTML, /data-act="apply"/);
  assert.match(c.$("picker").innerHTML, /橙色手柄/);
  c.selectedFaceId = 1; c.showPicker(info(1));
  assert.match(c.$("picker").innerHTML, /data-act="apply"/);
  c.$("picker").input.value = "2.5"; c.$("picker").button.onclick();
  assert.equal(c.commits.length, 1); assert.equal(c.commits[0][2], 2.5);
});

test("picker command also rejects direct invocation on a curved or stale face and during other tools", () => {
  const c = fixture(["applyPushPull"]);
  c.applyPushPull(2);
  c.curvedDriver = null; c.applyPushPull(2);
  c.selectedFaceId = 999; c.applyPushPull(2);
  c.selectedFaceId = 1; c.mode = "shell"; c.applyPushPull(2);
  c.mode = "select"; c.applyPushPull(NaN);
  assert.equal(c.commits.length, 0); assert.equal(c.shape, c.original);
  c.applyPushPull(-2); assert.equal(c.commits.length, 1);
});

test("canvas direct drag cannot start on a cylinder or while a size handle owns the gesture", () => {
  const c = fixture(); c.mode = "pushpull";
  vm.runInContext(callback("onDragStart"), c);
  assert.equal(c.viewer.cam.onDragStart({ clientX: 100, clientY: 100 }), false);
  assert.equal(c.drag, null);
  c.selectedFaceId = 1;
  c.dim = { _drag: {} };
  assert.equal(c.viewer.cam.onDragStart({ clientX: 100, clientY: 100 }), false);
  c.dim = null;
  assert.equal(c.viewer.cam.onDragStart({ clientX: 100, clientY: 100 }), true);
  assert.equal(c.drag.faceId, 1);
});

test("invalid legacy curved canvas drags are cancelled at preview and release without editing geometry", () => {
  for (const phase of ["preview", "release"]) {
    const c = fixture(["previewDrag"]); c.mode = "pushpull";
    c.drag = { baseShape: c.original, faceId: 2, dist: 8, raf: 0 };
    c.shape = c.preview;
    if (phase === "preview") c.previewDrag();
    else { vm.runInContext(callback("onDragEnd"), c); c.viewer.cam.onDragEnd({}); }
    assert.equal(c.shape, c.original); assert.equal(c.drag, null);
    assert.equal(c.pushed, 0); assert.equal(c.commits.length, 0);
  }
});

test("high-rate drag events collapse into one frame and release still keeps the last position", () => {
  const c = fixture();
  c.mode = "pushpull";
  c.drag = { baseShape: c.original, faceId: 1, dist: 0, raf: 0,
    start: { x: 0, y: 0 }, screenDir: new THREE.Vector2(1, 0), pxPerUnit: 1 };
  vm.runInContext(callback("onDrag"), c);
  vm.runInContext(callback("onDragEnd"), c);
  // Pad 7 Ultra 的触摸采样是 240Hz，一屏刷新内会来好几个事件。
  for (let i = 1; i <= 6; i++) c.viewer.cam.onDrag({ clientX: i * 10, clientY: 0 });
  assert.equal(c.pending(), 1, "同一刷新周期内的多次移动只排一帧");
  assert.equal(c._dragEvent.clientX, 60, "只保留本帧最后一个事件");
  c.viewer.cam.onDragEnd({ clientX: 60, clientY: 0 });
  assert.equal(c._dragFrame, 0, "松手要撤掉待处理的那一帧");
  assert.equal(c.commits.length, 1, "推拉只提交一次");
  assert.equal(c.commits[0][2], 60, "合并不能把最终位移丢掉");
});

test("switching from cylinder drag to edge or shell tools cancels the old preview before clearing its source", () => {
  for (const next of ["fillet", "chamfer", "shell"]) {
    const c = fixture(["setupDim", "scheduleDimPreview", "applyDimPreview", "commitDimValue",
      "enterEdgeMode", "enterShellMode", "exitEdgeMode", "showEdgeDim"]);
    c.setupDim();
    c.dim.show({ anchor: new THREE.Vector3(), dir: new THREE.Vector3(1, 0, 0), value: 8, min: 0.2, max: 400 });
    c.dim._axis = { x: 1, y: 0, ppu: 10 };
    const dot = c.$("dimDot");
    dot.emit("pointerdown"); dot.emit("pointermove", 140); c.flush();
    assert.equal(c.shape, c.preview); assert.equal(c.curvedApplied, 1);
    dot.emit("pointermove", 160);
    const hide = c.dim.hide.bind(c.dim);
    let cancelContext;
    c.dim.hide = () => { cancelContext = { mode: c.mode, driver: c.curvedDriver }; hide(); };
    if (next === "shell") c.enterShellMode(); else c.enterEdgeMode(next);
    c.flush();
    assert.equal(cancelContext.mode, "select"); assert.ok(cancelContext.driver);
    assert.equal(c.shape, c.original); assert.equal(c.dimBase, null);
    assert.equal(c.curvedDriver, null); assert.equal(c.faceClass, null);
    assert.equal(c.pending(), 0); assert.equal(c.mode, next);
    if (next === "shell") continue;
    c.edgeSel = [{ mid: [0, 0, 0], dir: [1, 0, 0] }]; c.showEdgeDim(2);
    c.dim._axis = { x: 1, y: 0, ppu: 10 };
    dot.emit("pointerdown"); dot.emit("pointermove", 120); c.flush();
    dot.emit("pointerup", 120);
    assert.equal(c.curvedApplied, 1); assert.equal(c.edgeApplied, 1);
    assert.equal(c.commits[0][2], next); assert.equal(c.commits[0][3].radius, 4);
  }
});

test("edge previews and commits cannot consume a stale curved driver even if a caller missed cleanup", () => {
  for (const mode of ["fillet", "chamfer"]) {
    const c = fixture(["applyDimPreview", "commitDimValue", "exitEdgeMode"]);
    c.mode = mode; c.edgeKind = mode; c.edgeSel = [{ mid: [0, 0, 0] }]; c.dimBase = c.original;
    c.applyDimPreview(2); assert.equal(c.wires.length, 1);
    c.commitDimValue(2);
    assert.equal(c.curvedApplied, 0); assert.equal(c.edgeApplied, 1);
    assert.equal(c.commits[0][2], mode);
  }
});

test("an unowned curved size handle cannot fall back to ordinary push-pull", () => {
  const c = fixture(["applyDimPreview", "commitDimValue"]);
  c.curvedDriver = null; c.dimBase = c.original;
  c.applyDimPreview(4); c.commitDimValue(4);
  assert.equal(c.pushed, 0); assert.equal(c.commits.length, 0);
  assert.equal(c.shape, c.original); assert.equal(c.dimBase, null);
});
