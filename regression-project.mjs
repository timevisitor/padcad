import assert from "node:assert/strict";
import { markSnapshot } from "./src/history-cache.js";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import opencascade from "replicad-opencascadejs";
import { setOC, measureVolume } from "replicad";
import { projectDefinition, restoreProject, withoutFeature, cacheRebuild, escapeHTML } from "./src/project.js";
import { rebuild } from "./src/replay.js";

setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));
const base = () => ({ label: "Base", op: { type: "base" } });
const move = (dx = 4) => ({ label: "Move", op: { type: "move3d", dx } });
const definition = (h, index = h.length - 1) => projectDefinition("测试工程", h, index);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);

test("saved rollback position retains both its geometry and redo snapshots", () => {
  const p = restoreProject(definition([base(), move()], 0));
  assert.equal(p.hIndex, 0);
  near(p.shape.boundingBox.center[0], 0);
  near(p.history[1].shape.boundingBox.center[0], 4);
});

test("suppression survives save/open and has a valid undo snapshot", () => {
  const p = restoreProject(definition([base(), { ...move(), suppressed: true }]));
  assert.equal(p.history[1].suppressed, true);
  assert.equal(p.history[0].shape, p.history[1].shape);
  near(p.shape.boundingBox.center[0], 0);
});

test("invalid project fails without mutating the supplied or current document", () => {
  const current = restoreProject(definition([base(), move(12)]));
  const broken = definition([base(), { op: { type: "not-a-feature" } }]);
  const copy = JSON.stringify(broken);
  assert.throws(() => restoreProject(broken));
  assert.equal(JSON.stringify(broken), copy);
  near(current.shape.boundingBox.center[0], 12);
});

test("failed deletion leaves the source history and references untouched", () => {
  const h = [base(), move(), { op: { type: "mirror", source: 1 } }];
  assert.throws(() => withoutFeature(h, 1), /引用/);
  assert.equal(h.length, 3);
  assert.equal(h[2].op.source, 1);
  assert.throws(() => withoutFeature(h, 0), /依赖/);
});

test("deletion adjusts later pattern/mirror references without mutating originals", () => {
  const h = [base(), move(), move(), { op: { type: "pattern", source: 2 } }];
  const next = withoutFeature(h, 1);
  assert.equal(next[2].op.source, 1);
  assert.equal(h[3].op.source, 2);
});

test("saved feature data is detached from live edits", () => {
  const h = [base(), move()];
  const p = definition(h);
  h[1].op.dx = 19;
  assert.equal(p.features[1].op.dx, 4);
  assert.equal(escapeHTML('<零件 & "A">'), "&lt;零件 &amp; &quot;A&quot;&gt;");
});

test("project with more than 60 features remains rebuildable", () => {
  const h = [base(), ...Array.from({ length: 62 }, () => move(1))];
  const p = restoreProject(definition(h));
  assert.equal(p.history.length, 63);
  near(p.shape.boundingBox.center[0], 62);
});

test("rebuild refreshes tools and clears tools of suppressed features", () => {
  const h = [base(), move()];
  const r = rebuild(h, 1);
  h[1].toolShape = { stale: true };
  cacheRebuild(h, r);
  assert.equal(h[1].toolShape, null);
  near(measureVolume(h[1].shape), measureVolume(h[0].shape));
});

// Run the actual application history functions with only the presentation layer stubbed.
const main = fs.readFileSync("./src/main.js", "utf8");
function appFunction(name, nextMarker) {
  const start = main.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  const end = main.indexOf(nextMarker, start);
  assert.ok(end > start);
  return main.slice(start, end);
}

test("application commit keeps the base after 60 operations and forks after undo", () => {
  const context = vm.createContext({ history: [], hIndex: -1, shape: {}, FEATURE_ICON: {}, markSnapshot, renderTree() {} });
  vm.runInContext(appFunction("commit", "/** 跳到历史"), context);
  for (let i = 0; i < 65; i++) vm.runInContext(`commit('step${i}', '', 'base', {type:'base'})`, context);
  assert.equal(context.history.length, 65);
  assert.equal(context.history[0].label, "step0");
  context.hIndex = 2;
  vm.runInContext("commit('new')", context);
  assert.equal(context.history.length, 4);
});

test("application failed delete rolls back model, cursor, and full history", () => {
  const h = [base(), move(), move()];
  const originalShape = {};
  const context = vm.createContext({ history: h, hIndex: 2, shape: originalShape,
    mode: "select", cancelEdit() {},
    withoutFeature, featureDisplayName: (x) => x.label,
    rebuild() { throw new Error("downstream reference lost"); },
    refresh() {}, renderFeatTree() {}, renderTree() {}, setStats() {},
  });
  vm.runInContext(appFunction("deleteStep", "function gotoStep("), context);
  vm.runInContext("deleteStep(1)", context);
  assert.equal(context.history, h);
  assert.equal(context.history.length, 3);
  assert.equal(context.shape, originalShape);
  assert.equal(context.hIndex, 2);
});

test("STEP viewing preserves the kernel's shared-vertex triangle indices", () => {
  let received;
  const context = vm.createContext({ viewMesh: null, Uint32Array,
    viewer: { setMesh(mesh) { received = mesh; }, invalidate() {} }, applyViewDisplay() {},
    parsed: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      normals: new Float32Array(12), triangles: new Uint32Array([0, 1, 2, 0, 2, 3]), triangleCount: 2,
    },
  });
  vm.runInContext(appFunction("displayImportedMesh", "function applyViewDisplay("), context);
  vm.runInContext("displayImportedMesh(parsed, 'test.step')", context);
  assert.deepEqual([...received.triangles], [0, 1, 2, 0, 2, 3]);
  assert.ok(Math.max(...received.triangles) < received.vertices.length / 3);
});

test("extrusion bubble entry updates the same depth used by the apply buttons", () => {
  const input = { value: "5" };
  const context = vm.createContext({ dimRaf: 1, dimTarget: 5, dimBase: {}, awaitingExtrude: true,
    cancelAnimationFrame() {}, $: () => input, previewExtrude() {},
  });
  vm.runInContext(appFunction("commitDimValue", "/** 圆角/倒角：手柄"), context);
  vm.runInContext("commitDimValue(12)", context);
  assert.equal(input.value, "12");
  assert.equal(context.dimBase, null);
  assert.equal(context.dimRaf, 0);
});
