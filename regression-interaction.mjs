import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { OrbitCam } from "./src/camera.js";
import { DimHandle } from "./src/handle.js";
import { Viewer } from "./src/viewer.js";

class Element {
  constructor() {
    this.listeners = new Map();
    this.classes = new Set();
    this.style = {};
    this.clientWidth = 1000;
    this.clientHeight = 800;
    this.textContent = "";
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name),
    };
  }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }
  emit(type, properties = {}) {
    const event = { type, preventDefault() {}, stopPropagation() {}, ...properties };
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  set innerHTML(value) {
    const input = new Element();
    input.value = /value="([^"]*)"/.exec(value)?.[1] || "";
    input.focus = () => {};
    input.select = () => {};
    input.blur = () => input.emit("blur");
    this.input = input;
  }
  querySelector() { return this.input; }
}

const point = (pointerId, clientX = 100, clientY = 100, pointerType) => {
  const p = { pointerId, clientX, clientY };
  if (pointerType) p.pointerType = pointerType;
  return p;
};
function cameraFixture(height = 800) {
  const dom = new Element();
  dom.clientHeight = height;
  const camera = new THREE.PerspectiveCamera(38, dom.clientWidth / height, 0.5, 20000);
  return { dom, camera, cam: new OrbitCam(camera, dom) };
}

test("single tap remains a selection; two-finger gesture never becomes a tap", () => {
  const { dom, cam } = cameraFixture();
  let taps = 0;
  cam.onTap = () => taps++;
  dom.emit("pointerdown", point(1));
  dom.emit("pointerup", point(1));
  assert.equal(taps, 1);
  dom.emit("pointerdown", point(1));
  dom.emit("pointerdown", point(2, 150));
  dom.emit("pointerup", point(2, 150));
  dom.emit("pointerup", point(1));
  assert.equal(taps, 1);
  dom.emit("pointerdown", point(1));
  dom.emit("pointerup", point(1));
  assert.equal(taps, 2, "a new single-pointer gesture is independent");
});

test("single-finger drag orbits the view", () => {
  const { dom, cam } = cameraFixture();
  const az0 = cam.az, el0 = cam.el;
  dom.emit("pointerdown", point(1, 100, 100, "touch"));
  dom.emit("pointermove", point(1, 160, 120, "touch"));
  dom.emit("pointerup", point(1, 160, 120, "touch"));
  assert.ok(Math.abs(cam.az - az0) > 1e-6, "azimuth should change");
  assert.ok(Math.abs(cam.el - el0) > 1e-6, "elevation should change");
});

test("long press opens the context menu and suppresses tap selection", async () => {
  const { dom, cam } = cameraFixture();
  let taps = 0, menus = 0;
  cam.onTap = () => taps++;
  cam.onLongPress = () => menus++;
  dom.emit("pointerdown", point(1, 100, 100, "touch"));
  await new Promise((r) => setTimeout(r, 520));
  assert.equal(menus, 1, "long press should open the menu once");
  dom.emit("pointerup", point(1, 100, 100, "touch"));
  assert.equal(taps, 0, "long press must not become a selection tap");
});

test("stylus draws through onDragStart and does not orbit the view", () => {
  const { dom, cam } = cameraFixture();
  let drags = 0;
  const az0 = cam.az, el0 = cam.el;
  cam.onDragStart = () => true;
  cam.onDrag = () => drags++;
  dom.emit("pointerdown", point(1, 100, 100, "pen"));
  dom.emit("pointermove", point(1, 180, 140, "pen"));
  dom.emit("pointerup", point(1, 180, 140, "pen"));
  assert.equal(drags, 1, "pen drag should go to drawing/editing");
  assert.equal(cam.az, az0, "pen must not rotate azimuth");
  assert.equal(cam.el, el0, "pen must not rotate elevation");
});

test("two-finger drag pans the view target", () => {
  const { dom, cam, camera } = cameraFixture();
  const before = cam.target.clone();
  dom.emit("pointerdown", point(1, 100, 100, "touch"));
  dom.emit("pointerdown", point(2, 200, 100, "touch"));
  dom.emit("pointermove", point(1, 130, 130, "touch"));
  dom.emit("pointermove", point(2, 230, 130, "touch"));
  dom.emit("pointerup", point(2, 230, 130, "touch"));
  dom.emit("pointerup", point(1, 130, 130, "touch"));
  assert.ok(cam.target.distanceTo(before) > 1e-6, "target should pan");
  camera.updateMatrixWorld();
});

test("system cancellation cannot select or commit a model operation", () => {
  const { dom, cam } = cameraFixture();
  let taps = 0, commits = 0, cancels = 0;
  cam.onTap = () => taps++;
  dom.emit("pointerdown", point(1));
  dom.emit("pointercancel", point(1));
  assert.equal(taps, 0);
  cam.onDragStart = () => true;
  cam.onDragEnd = () => commits++;
  cam.onDragCancel = () => cancels++;
  dom.emit("pointerdown", point(1));
  dom.emit("pointermove", point(1, 200));
  dom.emit("pointercancel", point(1, 200));
  dom.emit("lostpointercapture", point(1, 200));
  assert.equal(commits, 0);
  assert.equal(cancels, 1);
  assert.equal(cam.pointers.size, 0);
});

test("second finger cancels pending drawing and pinch responds on its first move", () => {
  const { dom, cam } = cameraFixture();
  let commits = 0, cancels = 0, taps = 0;
  cam.onDragStart = () => true;
  cam.onDragEnd = () => commits++;
  cam.onDragCancel = () => cancels++;
  cam.onTap = () => taps++;
  dom.emit("pointerdown", point(1));
  dom.emit("pointermove", point(1, 110));
  dom.emit("pointerdown", point(2, 210));
  assert.equal(cancels, 1);
  const before = cam.dist;
  dom.emit("pointermove", point(2, 310));
  assert.ok(Math.abs(cam.dist - before / 2) < 1e-9);
  dom.emit("pointerup", point(2, 310));
  dom.emit("pointerup", point(1, 110));
  assert.equal(commits, 0);
  assert.equal(taps, 0);
});

test("disabled camera ignores wheel zoom", () => {
  const { dom, cam } = cameraFixture();
  const before = cam.dist;
  cam.enabled = false;
  dom.emit("wheel", { deltaY: 120 });
  assert.equal(cam.dist, before);
  cam.enabled = true;
  dom.emit("wheel", { deltaY: 120 });
  assert.ok(cam.dist > before);
});

test("planar pan follows the pointer in both landscape and portrait", () => {
  for (const height of [480, 800, 1300]) {
    const { dom, cam, camera } = cameraFixture(height);
    cam.setPlanar(true);
    const origin = cam.target.clone();
    dom.emit("pointerdown", point(1));
    dom.emit("pointermove", point(1, 140, 130));
    const projected = origin.project(camera);
    assert.ok(Math.abs(projected.x * dom.clientWidth / 2 - 40) < 1e-8);
    assert.ok(Math.abs(-projected.y * height / 2 - 30) < 1e-8);
  }
});

test("sketch framing preserves the outward normal and aligns sketch X horizontally", () => {
  const { cam, camera } = cameraFixture();
  const cases = [
    [[0, 0, 1], [1, 0, 0]], [[0, 0, -1], [1, 0, 0]],
    [[1, 0, 0], [0, -1, 0]], [[-1, 0, 0], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0]], [[0, -1, 0], [-1, 0, 0]],
    [[1, 1, 1], [1, -1, 0]],
  ];
  for (const [normal, xDir] of cases) {
    const n = new THREE.Vector3(...normal).normalize();
    const x = new THREE.Vector3(...xDir).normalize();
    cam.frameNormal(n, x);
    assert.ok(cam.dir.distanceTo(n) < 1e-10, `normal ${normal}`);
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
    assert.ok(right.distanceTo(x) < 1e-10, `X direction ${xDir}`);
  }
});

test("fit contains all eight box corners for narrow and wide viewports", () => {
  const { cam, camera } = cameraFixture();
  const box = new THREE.Box3(new THREE.Vector3(-50, -20, -40), new THREE.Vector3(180, 250, 310));
  for (const aspect of [0.25, 0.6, 1, 2.2]) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    cam.fit(box);
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const p = new THREE.Vector3(x, y, z).project(camera);
          assert.ok(Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && Math.abs(p.z) < 1, `aspect ${aspect}`);
        }
      }
    }
  }
});

function handleFixture(callbacks = {}) {
  const elements = new Map(["dimHandle", "dimDot", "dimValue", "dimLeader"].map((id) => [id, new Element()]));
  globalThis.document = { getElementById: (id) => elements.get(id) };
  const handle = new DimHandle(callbacks);
  const canvas = new Element();
  const camera = new THREE.PerspectiveCamera(38, 1000 / 800, 0.5, 20000);
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  handle.show({ anchor: new THREE.Vector3(), dir: new THREE.Vector3(1, 0, 0), value: 10 });
  return { handle, canvas, camera };
}

test("offset canvas keeps dimension projection and diagonal drag in client coordinates", () => {
  const previews = [], commits = [];
  const { handle, camera, canvas } = handleFixture({
    onPreview: value => previews.push(value), onCommit: value => commits.push(value),
  });
  // 1280 × 800 workspace minus its 240px browser, 142px ribbon and 110px footer.
  const rect = { left: 240, top: 142, width: 1040, height: 548 };
  canvas.clientWidth = rect.width;
  canvas.clientHeight = rect.height;
  canvas.getBoundingClientRect = () => rect;
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
  handle.show({ anchor: new THREE.Vector3(), dir: new THREE.Vector3(0.6, 0.8, 0), value: 10 });
  handle.sync(camera, canvas);

  // Independent perspective scale for the z=0 plane, 100mm in front of the camera.
  const pixelsPerMM = rect.height / (2 * 100 * Math.tan(38 * Math.PI / 360));
  const startX = rect.left + rect.width / 2 + 6 * pixelsPerMM;
  const startY = rect.top + rect.height / 2 - 8 * pixelsPerMM;
  const transform = /^translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(handle.el.style.transform);
  assert.ok(transform);
  assert.ok(Math.abs(Number(transform[1]) - startX) < 1e-8);
  assert.ok(Math.abs(Number(transform[2]) - startY) < 1e-8);
  assert.equal(handle.el.classList.contains("clamped"), false);

  const endX = startX + 3 * pixelsPerMM, endY = startY - 4 * pixelsPerMM;
  handle.dot.emit("pointerdown", point(1, startX, startY));
  handle.dot.emit("pointermove", point(1, endX, endY));
  assert.equal(handle.value, 15);
  handle.sync(camera, canvas);
  assert.ok(Math.abs(handle._scr.x - endX) < 1e-8);
  assert.ok(Math.abs(handle._scr.y - endY) < 1e-8);
  handle.dot.emit("pointerup", point(1, endX, endY));
  handle.dot.emit("lostpointercapture", point(1, endX, endY));
  assert.deepEqual(previews, [15]);
  assert.deepEqual(commits, [15]);
});

test("offset canvas raycasts faces and picks edges at their client-space positions", () => {
  const viewer = Object.create(Viewer.prototype);
  const { camera, canvas } = handleFixture();
  const rect = { left: 240, top: 142, width: 1040, height: 548 };
  canvas.getBoundingClientRect = () => rect;
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
  viewer.canvas = canvas;
  viewer.camera = camera;
  viewer.raycaster = new THREE.Raycaster();
  const geometry = new THREE.PlaneGeometry(20, 20);
  const material = new THREE.MeshBasicMaterial();
  viewer.solidMesh = new THREE.Mesh(geometry, material);
  viewer.solidMesh.updateMatrixWorld();
  viewer.meshData = { faceGroups: [{ start: 0, count: 2, faceId: 31 }] };
  try {
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const hit = viewer.pickAt(x, y);
    assert.equal(hit?.faceId, 31);
    assert.ok(hit.point.length() < 1e-8);
    assert.equal(viewer.pickAt(rect.width / 2, rect.height / 2), null);
    const edge = { pts: [[-10, 0, 0], [10, 0, 0]] };
    viewer.setEdgeData([edge]);
    assert.equal(viewer.pickEdgeAt(x, y), edge);
    assert.equal(viewer.pickEdgeAt(rect.width / 2, rect.height / 2), null);
  } finally {
    geometry.dispose();
    material.dispose();
  }
});

test("offscreen handle keeps the true projected drag direction", () => {
  const { handle, camera, canvas } = handleFixture();
  handle.show({ anchor: new THREE.Vector3(1000, 0, 0), dir: new THREE.Vector3(-1, 0, 0), value: 10 });
  handle.sync(camera, canvas);
  assert.ok(handle.el.classList.contains("clamped"));
  assert.ok(handle._axis.x < -0.999);
  const expectedPixelsPerMM = canvas.clientHeight / (2 * 100 * Math.tan(38 * Math.PI / 360));
  assert.ok(Math.abs(handle._axis.ppu - expectedPixelsPerMM) < 1e-8);
});

test("dimension drag belongs to one pointer and cancellation rolls back without commit", () => {
  let commits = 0, cancels = 0;
  const { handle, camera, canvas } = handleFixture({ onCommit: () => commits++, onCancel: () => cancels++ });
  handle.sync(camera, canvas);
  handle.dot.emit("pointerdown", point(1));
  handle.dot.emit("pointermove", point(2, 220));
  assert.equal(handle.value, 10);
  handle.dot.emit("pointerdown", point(2, 220));
  handle.dot.emit("pointermove", point(1, 120));
  assert.ok(handle.value > 10);
  handle.dot.emit("pointerup", point(2, 220));
  assert.equal(commits, 0);
  handle.dot.emit("pointercancel", point(1, 120));
  assert.equal(handle.value, 10);
  assert.equal(commits, 0);
  assert.equal(cancels, 1);
});

test("normal dimension drag still commits once", () => {
  let commits = 0;
  const { handle, camera, canvas } = handleFixture({ onCommit: () => commits++ });
  handle.sync(camera, canvas);
  handle.dot.emit("pointerdown", point(1));
  handle.dot.emit("pointermove", point(1, 120));
  handle.dot.emit("pointerup", point(1, 120));
  handle.dot.emit("lostpointercapture", point(1, 120));
  assert.equal(commits, 1);
});

test("hiding a dimension removes its leader and cancels a pending numeric edit", () => {
  let commits = 0;
  const { handle, camera, canvas } = handleFixture({ onCommit: () => commits++ });
  handle.anchor.set(1000, 0, 0);
  handle.sync(camera, canvas);
  assert.ok(handle.leaderEl.classList.contains("on"));
  handle.valEl.emit("click");
  const input = handle.valEl.input;
  input.value = "35";
  handle.hide();
  input.blur();
  assert.equal(commits, 0);
  assert.equal(handle.value, 10);
  assert.equal(handle.leaderEl.classList.contains("on"), false);
  assert.equal(handle.visible, false);
});

test("hiding during a dimension drag cancels its external preview", () => {
  let rolledBack = null;
  const { handle, camera, canvas } = handleFixture({ onCancel: (v) => { rolledBack = v; } });
  handle.sync(camera, canvas);
  handle.dot.emit("pointerdown", point(1));
  handle.dot.emit("pointermove", point(1, 130));
  assert.ok(handle.value > 10);
  handle.hide();
  assert.equal(rolledBack, 10);
  assert.equal(handle.value, 10);
  assert.equal(handle.visible, false);
});

test("deleting the model removes selected edge geometry", () => {
  const viewer = Object.create(Viewer.prototype);
  viewer.setInteractiveQuality = () => {};
  viewer.overlay = new THREE.Group();
  viewer.body = new THREE.Group();
  viewer.invalidate = () => {};
  viewer.matEdgeHi = new THREE.LineBasicMaterial();
  viewer.highlightEdges([{ pts: [[0, 0, 0], [1, 0, 0]] }]);
  assert.equal(viewer.overlay.children.length, 1);
  viewer.setMesh(null);
  assert.equal(viewer.overlay.children.length, 0);
  assert.equal(viewer.edgeHi, null);
});

test("edge picking rejects segments behind the camera", () => {
  const viewer = Object.create(Viewer.prototype);
  viewer.canvas = new Element();
  viewer.camera = new THREE.PerspectiveCamera(38, 1000 / 800, 0.5, 20000);
  viewer.camera.position.set(0, 0, 100);
  viewer.camera.lookAt(0, 0, 0);
  viewer.camera.updateMatrixWorld();
  viewer.setEdgeData([{ pts: [[-10, 0, 200], [10, 0, 200]] }]);
  assert.equal(viewer.pickEdgeAt(500, 400), null);
  const frontEdge = { pts: [[-10, 0, 0], [10, 0, 0]] };
  viewer.setEdgeData([frontEdge]);
  assert.equal(viewer.pickEdgeAt(500, 400), frontEdge);
});
