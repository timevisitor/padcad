import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import * as THREE from "three";
import { OrbitCam } from "./src/camera.js";

class Element {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  }
  append(...children) { for (const child of children) { this.children.push(child); child.parent = this; } }
  remove() { this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  contains(target) { return target === this || this.children.some((child) => child.contains(target)); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  emit(name, properties = {}) {
    const event = { target: this, preventDefault() {}, stopPropagation() {}, ...properties };
    for (const listener of this.listeners.get(name) || []) listener(event);
  }
  focus() { this.focused = true; }
}

function fixture() {
  const canvas = new Element("canvas");
  const camera = new THREE.PerspectiveCamera(38, 1.5, .5, 20000);
  const cam = new OrbitCam(camera, canvas);
  return { cam, camera };
}
const nearVector = (actual, expected) => assert.ok(actual.distanceTo(new THREE.Vector3(...expected)) < 1e-9,
  `${actual.toArray()} != ${expected}`);

test("real sketch front-view command fits a 60mm model in wide and portrait canvases", () => {
  const main = fs.readFileSync(new URL("./src/main.js", import.meta.url), "utf8");
  const command = main.match(/^function faceSketchPlane\([^]*?^}/m)?.[0];
  assert.ok(command, "missing faceSketchPlane application function");
  for (const [width, height] of [[1040, 548], [560, 1028]]) {
    const { cam, camera } = fixture();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    // A 60 × 40 × 8mm plate, with its sketch origin at the top-face center.
    // Offset it from the world origin to also protect the existing target semantics.
    const origin = new THREE.Vector3(12, -7, 8);
    const bbox = new THREE.Box3(
      origin.clone().add(new THREE.Vector3(-30, -20, -8)),
      origin.clone().add(new THREE.Vector3(30, 20, 0)),
    );
    const sketch = { origin, normal: new THREE.Vector3(0, 0, 1), xDir: new THREE.Vector3(1, 0, 0) };
    const context = vm.createContext({
      THREE, sketch, viewer: { cam, camera, bbox, invalidate() {} },
      setPlanarMode(value) { cam.setPlanar(value); }, setStats() {},
    });
    vm.runInContext(command, context);
    context.faceSketchPlane();
    assert.equal(cam.planar, true);
    nearVector(origin, [12, -7, 8]);
    nearVector(cam.target, origin.toArray());
    nearVector(cam.dir, [0, 0, 1]);
    for (const x of [bbox.min.x, bbox.max.x]) {
      for (const y of [bbox.min.y, bbox.max.y]) {
        for (const z of [bbox.min.z, bbox.max.z]) {
          const projected = new THREE.Vector3(x, y, z).project(camera);
          assert.ok(Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 && Math.abs(projected.z) < 1,
            `${width} × ${height}: plate corner projects outside viewport at ${projected.toArray()}`);
        }
      }
    }
  }
});

const views = [
  ["front", [0, -1, 0], [0, 0, 1], [1, 0, 0]],
  ["back", [0, 1, 0], [0, 0, 1], [-1, 0, 0]],
  ["left", [-1, 0, 0], [0, 0, 1], [0, -1, 0]],
  ["right", [1, 0, 0], [0, 0, 1], [0, 1, 0]],
  ["top", [0, 0, 1], [0, 1, 0], [1, 0, 0]],
  ["bottom", [0, 0, -1], [0, -1, 0], [1, 0, 0]],
];

for (const [name, normal, up, right] of views) {
  test(`${name} view uses the correct Z-up direction and screen axes`, () => {
    const { cam, camera } = fixture();
    cam.target.set(15, -20, 7);
    cam.dist = 177;
    assert.equal(cam.setStandardView(name), true);
    nearVector(cam.dir, normal);
    nearVector(camera.up, up);
    nearVector(new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0), right);
    nearVector(new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1), up);
    nearVector(cam.target, [15, -20, 7]);
    assert.equal(cam.dist, 177);
    assert.equal(cam.standardView, name);
    assert.equal(camera.isPerspectiveCamera, true);
  });
}

test("isometric view has equal axis components and clears a previous sketch up vector", () => {
  const { cam, camera } = fixture();
  cam.frameNormal(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1));
  cam.setStandardView("iso");
  nearVector(cam.dir, [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)]);
  nearVector(camera.up, [0, 0, 1]);
  assert.equal(cam.customUp, null);
  assert.equal(cam.standardView, "iso");
});

test("unknown view names leave the camera untouched", () => {
  const { cam, camera } = fixture();
  const before = camera.matrixWorld.toArray();
  for (const name of ["orthographic", "constructor", "__proto__", "", null]) {
    assert.equal(cam.setStandardView(name), false);
    assert.deepEqual(camera.matrixWorld.toArray(), before);
  }
});

test("selected standard view reflects real pose after orbit, pan, fit and rolled sketch framing", () => {
  const { cam } = fixture();
  cam.setStandardView("front");
  cam.target.set(3, 5, 8);
  cam.dist *= 1.5;
  cam.update();
  assert.equal(cam.standardView, "front");
  cam.fit(new THREE.Box3(new THREE.Vector3(-10, -20, -30), new THREE.Vector3(10, 20, 30)));
  assert.equal(cam.standardView, "front");
  cam.az += .1;
  cam.update();
  assert.equal(cam.standardView, null);
  cam.frameNormal(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
  assert.equal(cam.standardView, null, "same normal with a different screen roll is not the standard top view");
});

// Load the actual UI module with its CSS import omitted in the Node environment.
const source = fs.readFileSync(new URL("./src/view-controls.js", import.meta.url), "utf8")
  .replace('import "./view-controls.css";', "")
  .replace("export function installViewControls", "function installViewControls");
function controllerFixture() {
  const { cam, camera } = fixture();
  const document = new Element("document");
  document.body = new Element("body");
  document.createElement = (tag) => new Element(tag);
  const context = vm.createContext({ document });
  vm.runInContext(source, context);
  const messages = [];
  let sketchMode = false;
  const geometry = new THREE.BoxGeometry(10, 20, 30);
  const viewer = { cam, camera, geometry, bbox: new THREE.Box3(new THREE.Vector3(-5, -10, -15), new THREE.Vector3(5, 10, 15)) };
  const controls = context.installViewControls({ viewer, isSketchMode: () => sketchMode, onMessage: (message) => messages.push(message) });
  const root = document.body.children[0];
  const [trigger, panel] = root.children;
  const [current, grid, hint] = panel.children;
  const buttons = Object.fromEntries(grid.children.map((button) => [button.dataset.view, button]));
  return { cam, camera, viewer, controls, document, trigger, panel, current, hint, buttons, messages,
    setSketchMode: (enabled) => { sketchMode = enabled; controls.refresh(); } };
}

test("view control selects a view without editing model geometry or framing distance", () => {
  const { controls, viewer, cam, buttons, panel, trigger, current } = controllerFixture();
  const positions = Array.from(viewer.geometry.attributes.position.array);
  const bbox = viewer.bbox.clone();
  const distance = cam.dist;
  controls.open();
  assert.equal(panel.hidden, false);
  buttons.top.emit("click");
  assert.equal(cam.standardView, "top");
  assert.equal(current.textContent, "当前：顶视");
  assert.equal(buttons.top.attributes.get("aria-pressed"), "true");
  assert.equal(panel.hidden, true);
  assert.equal(trigger.attributes.get("aria-expanded"), "false");
  assert.equal(cam.dist, distance);
  assert.deepEqual(Array.from(viewer.geometry.attributes.position.array), positions);
  assert.ok(viewer.bbox.equals(bbox));
  cam.az += .2;
  cam.el -= .2;
  cam.update();
  assert.equal(buttons.top.attributes.get("aria-pressed"), "false");
  assert.equal(current.textContent, "当前：自由视角");
});

test("sketch mode disables world views but keeps fit available", () => {
  const { setSketchMode, buttons, cam, hint, messages } = controllerFixture();
  cam.setStandardView("top");
  setSketchMode(true);
  const before = cam.camera.matrixWorld.toArray();
  for (const [name, button] of Object.entries(buttons)) {
    if (name === "fit") assert.notEqual(button.disabled, true);
    else assert.equal(button.disabled, true);
  }
  assert.match(hint.textContent, /先退出草图/);
  buttons.front.emit("click");
  assert.deepEqual(cam.camera.matrixWorld.toArray(), before);
  assert.match(messages.at(-1), /先退出草图/);
  const distance = cam.dist;
  buttons.fit.emit("click");
  assert.equal(cam.standardView, "top");
  assert.notEqual(cam.dist, distance);
  setSketchMode(false);
  assert.equal(buttons.front.disabled, false);
});

test("outside pointer and Escape close the panel; disposal removes subscriptions", () => {
  const { controls, panel, trigger, document, cam, current } = controllerFixture();
  trigger.emit("click");
  assert.equal(panel.hidden, false);
  document.emit("pointerdown", { target: trigger });
  assert.equal(panel.hidden, false);
  document.emit("pointerdown", { target: document.body });
  assert.equal(panel.hidden, true);
  controls.open();
  document.emit("keydown", { key: "Escape" });
  assert.equal(panel.hidden, true);
  assert.equal(trigger.focused, true);
  const text = current.textContent;
  controls.dispose();
  controls.dispose();
  assert.equal(document.body.children.length, 0);
  assert.equal(document.listeners.get("pointerdown").size, 0);
  assert.equal(document.listeners.get("keydown").size, 0);
  cam.setStandardView("bottom");
  assert.equal(current.textContent, text);
});

test("fit on an empty document gives feedback without touching the camera", () => {
  const { controls, viewer, camera, buttons, messages } = controllerFixture();
  viewer.bbox = null;
  const before = camera.matrixWorld.toArray();
  controls.open();
  buttons.fit.emit("click");
  assert.deepEqual(camera.matrixWorld.toArray(), before);
  assert.match(messages.at(-1), /没有可适配/);
});
