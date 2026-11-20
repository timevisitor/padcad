/**
 * 回归：提交路径的增量重建（replay.rebuild 自动选择复用起点）
 *
 * 判据一律是几何量（体积/包围盒/面数/边数）逐值对拍，
 * 外加「复用段的实体在续算之后仍然可用」——因为续算要 clone 起点，
 * 不能把 history 里那一步的实体 fuse 掉。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import opencascade from "replicad-opencascadejs";
import { setOC, measureVolume } from "replicad";
import { rebuild, replayStart, generatesTool } from "./src/replay.js";
import { cacheRebuild } from "./src/project.js";
import { markSnapshot } from "./src/history-cache.js";

setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));

const near = (a, b, tol = 1e-6, label = "") =>
  assert.ok(Math.abs(a - b) <= tol, `${label}${a} != ${b}`);
const zPlane = (z) => ({ kind: "datum", name: "XY", origin: [0, 0, z], normal: [0, 0, 1], xDir: [1, 0, 0] });
const plate = { type: "extrude", plane: zPlane(0), entities: [{ kind: "rect", c: [0, 0], w: 60, h: 40 }], constraints: [], depth: 8, grow: 0 };
const boss = (x, y, r = 4) => ({ type: "extrude", plane: zPlane(8), entities: [{ kind: "circle", c: [x, y], r }], constraints: [], depth: 6, grow: 0 });
const hole = (x, y, r = 2.5) => ({ type: "extrude", plane: zPlane(8), entities: [{ kind: "circle", c: [x, y], r }], constraints: [], depth: -14, grow: 0 });

/** 8 步：底板 + 4 凸台 + 2 孔 + 1 阵列（阵列依赖第 2 步的凸台当源） */
function fixture() {
  const ops = [
    plate,
    boss(-18, -10), boss(18, -10), boss(-18, 10), boss(18, 10),
    hole(0, -14), hole(0, 14),
    { type: "pattern", kind: "linear", source: 1, count: 2, spacing: 12, direction: [0, 1, 0], operation: "fuse" },
  ];
  return ops.map((op, i) => ({ label: `f${i}`, op }));
}
const withRadius = (op, r) => ({ ...op, entities: op.entities.map((e) => ({ ...e, r })) });

function fullHistory() {
  const history = fixture();
  cacheRebuild(history, rebuild(history, history.length - 1, {}, { full: true }));
  return history;
}
const signature = (shape) => {
  const bb = shape.boundingBox;
  return {
    volume: Math.round(measureVolume(shape) * 1e4) / 1e4,
    bbox: [bb.width, bb.height, bb.depth].map((v) => Math.round(v * 1e4) / 1e4),
    faces: shape.faces.length,
    edges: shape.edges.length,
  };
};
const disposeOwned = (result) => {
  new Set([...result.snapshots.map((s) => s.shape), ...result.tools].filter(Boolean))
    .forEach((shape) => { try { shape.delete(); } catch (_) {} });
};

test("增量提交重建只重算改动步到目标步，且与全量重放逐值一致", () => {
  const history = fullHistory();
  const target = history.length - 1;
  const override = { 3: withRadius(history[3].op, 5.5) };
  const before = history.map((row) => signature(row.shape));
  const incremental = rebuild(history, target, override);
  assert.equal(incremental.fromStep, 3, "改第 4 步 → 从第 4 步续算");
  assert.deepEqual(incremental.logs.map((l) => l.step), [3, 4, 5, 6, 7], "只记改动步到目标步");
  assert.equal(incremental.steps, target + 1 - 3);
  assert.equal(incremental.snapshots.length, target + 1, "快照仍覆盖整条历史");

  // 与「全新全量重放」逐值对拍
  const fresh = rebuild(fixture(), target, override, { full: true });
  assert.deepEqual(signature(incremental.shape), signature(fresh.shape));
  near(measureVolume(incremental.shape), measureVolume(fresh.shape), 1e-6, "体积 ");
  disposeOwned(fresh);

  // 复用段必须还是原来的对象，且续算之后仍然可用（没有被 fuse 消费）
  for (let i = 0; i < 3; i++) {
    assert.equal(incremental.snapshots[i].shape, history[i].shape, `第 ${i} 步快照应复用原对象`);
    assert.deepEqual(signature(history[i].shape), before[i], `第 ${i} 步实体不应被改动`);
  }
  // 复用段的 toolShape 也要带出来（下游阵列要用）
  assert.ok(incremental.tools[1], "复用段的 toolShape 不能丢");
});

test("逐个改动每一步都能与全量重放对上，且不破坏被复用的历史实体", () => {
  const history = fullHistory();
  const target = history.length - 1;
  const before = history.map((row) => signature(row.shape));
  for (let step = 0; step <= target; step++) {
    const op = history[step].op;
    if (!op.entities?.length) continue;               // 阵列步由下一条用例覆盖
    const override = { [step]: withRadius(op, 3.3) };
    const inc = rebuild(history, target, override);
    const full = rebuild(fixture(), target, override, { full: true });
    assert.deepEqual(signature(inc.shape), signature(full.shape), `改第 ${step} 步后几何必须一致`);
    assert.equal(inc.fromStep, step, `改第 ${step} 步应从它开始`);
    assert.ok(inc.logs.every((l) => l.step >= step));
    disposeOwned(full);
  }
  // 原历史仍然完好（增量重建不许破坏被复用的实体）
  history.forEach((row, i) => assert.deepEqual(signature(row.shape), before[i], `第 ${i} 步被改动了`));
});

test("只改阵列步时复用段仍把源特征交给阵列", () => {
  const history = fullHistory();
  const target = history.length - 1;
  const patternStep = target;
  assert.ok(generatesTool(history[5].op));
  const override = { [patternStep]: { ...history[patternStep].op, count: 3 } };
  const inc = rebuild(history, target, override);
  const full = rebuild(fixture(), target, override, { full: true });
  assert.equal(inc.fromStep, patternStep, "只改阵列步时不必重算前面");
  assert.deepEqual(signature(inc.shape), signature(full.shape), "阵列仍从复用段拿到源特征");
  assert.ok(inc.tools[patternStep], "阵列产出的增量体要留下");
  disposeOwned(full);
});

test("压制改变定义 → 从被压制的步重算", () => {
  const history = fullHistory();
  const target = history.length - 1;
  history[2].suppressed = true;
  const inc = rebuild(history, target);
  assert.equal(inc.fromStep, 2, "压制改变了定义，必须从被压制的步重算");
  const expected = rebuild(fixture().map((row, i) => (i === 2 ? { ...row, suppressed: true } : row)), target, {}, { full: true });
  assert.deepEqual(signature(inc.shape), signature(expected.shape));
  disposeOwned(expected);
  history[2].suppressed = false;
});

test("中途快照被删掉 → 从该步整段重算并修好历史", () => {
  const history = fullHistory();
  const target = history.length - 1;
  history[2].shape.delete();
  const inc = rebuild(history, target, { [target]: { ...history[target].op, count: 3 } });
  assert.equal(inc.fromStep, 2, "坏掉的中途快照必须被整段重算（不能拿死实体当起点）");
  const expected = rebuild(fixture(), target, { [target]: { ...history[target].op, count: 3 } }, { full: true });
  assert.deepEqual(signature(inc.shape), signature(expected.shape));
  disposeOwned(expected);
  cacheRebuild(history, inc);
  assert.ok(measureVolume(history[2].shape) > 0, "重算后历史里的实体应该恢复可用");
});

test("没有缓存（刚恢复的空历史）→ 从第 0 步全量重放", () => {
  const history = fixture();
  assert.equal(replayStart(history, history.length - 1, {}), 0);
  const result = rebuild(history, history.length - 1);
  assert.equal(result.fromStep, 0);
  assert.equal(result.steps, history.length);
});

test("没有任何改动 → 只重算目标步", () => {
  const history = fullHistory();
  const target = history.length - 1;
  const inc = rebuild(history, target);
  assert.equal(inc.fromStep, target, "全都能复用就只重算目标步");
  assert.equal(inc.logs.length, 1);
  assert.ok(measureVolume(inc.shape) > 0);
});

test("连续两次增量重建都能命中缓存（标记不被弄脏）", () => {
  // 写 op → cacheRebuild 的顺序与 main.js 的 applyEdit 一致
  const history = fullHistory();
  const target = history.length - 1;
  const patched = { ...history[target - 1].op, depth: 5 };
  const first = rebuild(history, target, { [target - 1]: patched });
  history[target - 1].op = patched;
  cacheRebuild(history, first);
  const second = rebuild(history, target, { [target]: { ...history[target].op, count: 3 } });
  assert.equal(second.fromStep, target, "第二次重建应直接复用（缓存没被弄脏）");
  assert.ok(measureVolume(second.shape) > 0);
});

test("手工改 op 而不重新标记 → 判脏；重新标记后恢复复用", () => {
  const history = fullHistory();
  const target = history.length - 1;
  history[1].op = { ...history[1].op, depth: 999 };   // 不调用 markSnapshot
  assert.equal(replayStart(history, target, {}), 1, "定义变了就要从该步重算");
  markSnapshot(history[1]);
  assert.equal(replayStart(history, target, {}), target);
});
