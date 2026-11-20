import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import * as THREE from "three";
import opencascade from "replicad-opencascadejs";
import { setOC, measureVolume } from "replicad";
import { rebuild } from "./src/replay.js";
import { rebuildPreview } from "./src/preview-rebuild.js";
import { cacheRebuild } from "./src/project.js";
import { renderPixelRatio } from "./src/render-budget.js";
import { meshOf } from "./src/kernel.js";
import { Viewer } from "./src/viewer.js";

setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
function historyFixture() {
  const h = [{ op: { type: "base" } }];
  for (const x of [-24, -12, 0, 12, 24]) for (const y of [-12, 12]) {
    h.push({ op: { type: "extrude", plane: { kind: "datum", name: "XY", origin: [0, 0, 8], normal: [0, 0, 1], xDir: [1, 0, 0] },
      entities: [{ kind: "circle", c: [x, y], r: 2 }], constraints: [], depth: 4, grow: 0 } });
  }
  cacheRebuild(h, rebuild(h, h.length - 1));
  return h;
}
const change = row => ({ ...row.op, entities: row.op.entities.map(e => ({ ...e, r: 2.5 })) });
function disposeRebuild(result) {
  new Set([...result.snapshots.map(s => s.shape), ...result.tools].filter(Boolean)).forEach(shape => shape.delete());
}

test("high-density tablet uses bounded GPU pixels and restores quality without changing CSS size", () => {
  const width = 1600, height = 1000, dpr = 2;
  const idle = renderPixelRatio(width, height, dpr, true, false);
  const drag = renderPixelRatio(width, height, dpr, true, true);
  assert.ok(width * height * idle ** 2 <= 3_500_001);
  assert.ok(width * height * drag ** 2 <= 2_000_001);
  assert.ok(idle > drag); assert.ok(idle < dpr);
  assert.equal(renderPixelRatio(800, 500, 1, true, false), 1);
  assert.ok(renderPixelRatio(1200, 800, 1.25, false) <= 1.25);
});

test("preview replays only changed suffix, matches full rebuild and cannot dispose cached history", () => {
  const h = historyFixture(), target = h.length - 1, before = h.map(row => measureVolume(row.shape));
  const override = { [target]: change(h[target]) };
  const expected = rebuild(h, target, override), preview = rebuildPreview(h, target, override);
  assert.equal(preview.steps, 1); assert.equal(preview.fromStep, target);
  near(measureVolume(preview.shape), measureVolume(expected.shape));
  assert.ok(meshOf(preview.shape).triCount > 0);
  preview.dispose(); preview.dispose();
  h.forEach((row, i) => near(measureVolume(row.shape), before[i]));
  assert.throws(() => measureVolume(preview.shape));
  disposeRebuild(expected);
});

test("stale or missing prefix caches force a complete correct rebuild", () => {
  for (const stale of [true, false]) {
    const h = historyFixture(), target = h.length - 1;
    if (stale) h[0].op.holeRadius = 4; else h[1] = { ...h[1] };
    const override = { [target]: change(h[target]) };
    const expected = rebuild(h, target, override), preview = rebuildPreview(h, target, override);
    assert.equal(preview.fromStep, 0); near(measureVolume(preview.shape), measureVolume(expected.shape));
    preview.dispose(); disposeRebuild(expected);
  }
});

test("preview retains source tools for downstream patterns and rejects suppressed sources", () => {
  const h = historyFixture();
  h.push({ op: { type: "pattern", kind: "linear", source: 10, count: 2, spacing: 10, direction: [0, 0, 1], operation: "fuse" } });
  cacheRebuild(h, rebuild(h, 11));
  const op = { ...h[11].op, count: 3 };
  const result = rebuildPreview(h, 11, { 11: op }), full = rebuild(h, 11, { 11: op });
  assert.equal(result.fromStep, 11); near(measureVolume(result.shape), measureVolume(full.shape));
  result.dispose(); disposeRebuild(full);
  h[10].suppressed = true;
  assert.throws(() => rebuildPreview(h, 11, { 11: op }), /源特征/);
  assert.ok(measureVolume(h[11].shape) > 0);
});

test("preview omits expensive edge extraction then committed mesh restores CAD edges and releases buffers", () => {
  const h = historyFixture(), data = meshOf(h.at(-1).shape);
  const viewer = Object.create(Viewer.prototype);
  Object.assign(viewer, { body: new THREE.Group(), overlay: new THREE.Group(), invalidate() {}, setInteractiveQuality() {},
    edgeMesh: null,
    matBody: new THREE.MeshStandardMaterial(), matEdge: new THREE.LineBasicMaterial() });
  viewer.setMesh(data, { preview: true });
  assert.ok(viewer.solidMesh); assert.equal(viewer.edgeMesh, null);
  let disposed = 0;
  viewer.geometry.addEventListener("dispose", () => disposed++);
  viewer.setMesh(data);
  assert.equal(disposed, 1); assert.ok(viewer.edgeMesh.geometry.attributes.position.count > 0);
  viewer.setMesh(null);
  assert.equal(viewer.body.children.length, 0);
});

test("eleven-feature desktop benchmark records actual full vs incremental preview timings", () => {
  const h = historyFixture(), target = h.length - 1, override = { [target]: change(h[target]) };
  const fullMs = [], previewMs = [];
  for (let i = 0; i < 6; i++) {
    // { full: true } 显式要全量：这一条基准量的就是「全量 vs 只算改动那一步」，
    // 而且它下面会 dispose 结果的实体，必须让 rebuild 自己拥有这些实体（复用段是借 history 的）。
    let start = performance.now(); const full = rebuild(h, target, override, { full: true }); fullMs.push(performance.now() - start);
    start = performance.now(); const preview = rebuildPreview(h, target, override); previewMs.push(performance.now() - start);
    near(measureVolume(full.shape), measureVolume(preview.shape));
    preview.dispose(); disposeRebuild(full);
  }
  const median = values => values.slice(1).sort((a, b) => a - b)[2];
  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync("out/pad7-performance-benchmark.json", JSON.stringify({ environment: "Windows Node.js / OCCT WASM; not a Xiaomi device measurement",
    features: h.length, fullRebuildSteps: h.length, previewSteps: 1, fullMedianMs: median(fullMs), previewMedianMs: median(previewMs), fullMs, previewMs }, null, 2));
});
