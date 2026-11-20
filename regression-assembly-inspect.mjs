/**
 * 装配检查回归（v6 装配路 · asm）：干涉 + 爆炸视图
 *
 * 判据：两个 10×10×10 盒沿 X 重叠 5mm → 公共体积 = 5×10×10 = 500（精确值，容差 1e-6 相对）
 *      面贴面（正好挨着）不算干涉；离得很远的对被包围盒预筛掉
 *      爆炸视图：位姿按 方向×距离×factor 平移，resetExplode 逐位还原，配合数据不动
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import opencascade from "replicad-opencascadejs";
import { setOC, makeBaseBox, measureVolume } from "replicad";
import * as A from "./src/assembly.js";
import {
  interferenceReport, assemblyMassProperties, autoExplode, setExplodeStep,
  explodePoses, applyExplode, resetExplode, isExploded, shapeBounds, boundsOverlap,
} from "./src/assembly-inspect.js";

setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));

const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b} (tol ${tol})`);
const box = () => makeBaseBox(10, 10, 10);

function assemblyOf(positions) {
  const asm = A.createAssembly("盒组");
  const part = A.addPart(asm, { name: "盒", source: { kind: "project", project: { v: 1, features: [] } } });
  const shapes = new Map([[part.id, box()]]);
  for (const [i, p] of positions.entries()) {
    A.addInstance(asm, { partId: part.id, name: `盒${i + 1}`, transform: { t: p, r: A.quatIdentity() } });
  }
  return { asm, part, shapes };
}

test("干涉：两个 10³ 盒沿 X 重叠 5mm → 公共体积 500", () => {
  const { asm, shapes } = assemblyOf([[0, 0, 0], [5, 0, 0]]);
  const r = interferenceReport(asm, shapes);
  assert.equal(r.pairs.length, 1);
  close(r.pairs[0].volume, 5 * 10 * 10, 1e-6);
  close(r.totalVolume, 500, 1e-6);
  assert.equal(r.checked, 1);
});

test("面贴面（正好挨着）不算干涉，但确实被算作包围盒相交", () => {
  const { asm, shapes } = assemblyOf([[0, 0, 0], [10, 0, 0]]);
  const r = interferenceReport(asm, shapes);
  assert.equal(r.pairs.length, 0);
  assert.equal(r.checked, 1, "包围盒接触 → 进内核核对");
  close(r.totalVolume, 0, 1e-12);
});

test("离得远的对被包围盒预筛掉（不进内核）", () => {
  const { asm, shapes } = assemblyOf([[0, 0, 0], [100, 0, 0], [0, 200, 0]]);
  const r = interferenceReport(asm, shapes);
  assert.equal(r.pairs.length, 0);
  assert.equal(r.checked, 0);
  assert.equal(r.skipped, 3);
});

test("三件里只有一对真干涉，另一对只接触", () => {
  const { asm, shapes } = assemblyOf([[0, 0, 0], [5, 0, 0], [0, 10, 0]]);
  const r = interferenceReport(asm, shapes);
  assert.equal(r.pairs.length, 1);
  close(r.pairs[0].volume, 500, 1e-6);
  const names = r.pairs[0].names.join("/");
  assert.ok(names.includes("盒1") && names.includes("盒2"), names);
});

test("隐藏实例默认不参与干涉检查", () => {
  const { asm, shapes } = assemblyOf([[0, 0, 0], [5, 0, 0]]);
  asm.instances[1].visible = false;
  assert.equal(interferenceReport(asm, shapes).pairs.length, 0);
  assert.equal(interferenceReport(asm, shapes, { includeHidden: true }).pairs.length, 1);
});

test("包围盒工具：相交判定与尺寸", () => {
  const s = box();
  const b = shapeBounds(s);
  close(b.size[0], 10, 1e-9);
  close(b.min[2], 0, 1e-9);
  setTimeout(() => {}, 0);
  assert.equal(boundsOverlap(b, { min: [5, 0, 0], max: [20, 10, 10] }), true);
  assert.equal(boundsOverlap(b, { min: [11, 0, 0], max: [20, 10, 10] }), false);
});

test("爆炸视图：位姿 = 原位置 + 方向×距离×factor，reset 逐位还原", () => {
  const { asm, shapes } = assemblyOf([[0, 0, 0], [0, 0, 20]]);
  A.addMate(asm, {
    type: "coincident",
    a: { inst: asm.instances[0].id, ref: A.refFromFace(shapes.get(asm.parts[0].id), topFaceId(shapes.get(asm.parts[0].id))) },
    b: { inst: asm.instances[1].id, ref: A.refFromFace(shapes.get(asm.parts[0].id), bottomFaceId(shapes.get(asm.parts[0].id))) },
  });
  const before = JSON.parse(JSON.stringify(asm.instances));
  const matesBefore = JSON.stringify(asm.mates);
  setExplodeStep(asm, { instance: asm.instances[0].id, dir: [0, 0, -1], distance: 30 });
  setExplodeStep(asm, { instance: asm.instances[1].id, dir: [0, 0, 1], distance: 30 });
  assert.equal(explodePoses(asm, 1)[asm.instances[1].id].t[2], 50);

  applyExplode(asm, 1);
  assert.equal(isExploded(asm), true);
  close(asm.instances[0].transform.t[2], -30, 1e-12);
  close(asm.instances[1].transform.t[2], 50, 1e-12);
  // 半程
  applyExplode(asm, 0.5);
  close(asm.instances[1].transform.t[2], 35, 1e-12);
  applyExplode(asm, 0);
  assert.deepEqual(asm.instances[1].transform.t, [0, 0, 20]);

  applyExplode(asm, 1);
  resetExplode(asm);
  assert.equal(isExploded(asm), false);
  assert.deepEqual(asm.instances, before, "爆炸复位必须逐位一致");
  assert.equal(JSON.stringify(asm.mates), matesBefore, "爆炸不得改动配合");
});

test("一键爆炸：每个实例一条步骤，中心重合的退化为 +Z", () => {
  const { asm, shapes } = assemblyOf([[0, 0, 0], [0, 0, 20], [0, 0, 40]]);
  const steps = autoExplode(asm, shapes, { gap: 25 });
  assert.equal(steps.length, 3);
  const poses = explodePoses(asm, 1);
  // 最上面那件向上走、最下面那件向下走（沿装配中心 → 实例中心）
  assert.ok(poses[asm.instances[2].id].t[2] > 40, JSON.stringify(poses[asm.instances[2].id]));
  assert.ok(poses[asm.instances[0].id].t[2] < 0, JSON.stringify(poses[asm.instances[0].id]));
  // 中间那件方向退化 → +Z
  const mid = poses[asm.instances[1].id];
  close(mid.t[0], 0, 1e-9);
  close(mid.t[1], 0, 1e-9);
  assert.ok(mid.t[2] > 20);
});

test("装配总质量属性：体积逐件相加", () => {
  const { asm, shapes } = assemblyOf([[0, 0, 0], [0, 0, 20], [0, 0, 40]]);
  const p = assemblyMassProperties(asm, shapes);
  close(p.volume, 3000, 1e-6);
  close(p.bbox.min[2], 0, 1e-9);
  close(p.bbox.max[2], 50, 1e-9);
  assert.equal(p.instances, 3);
});


test("干涉检查不得吃掉实例形状（检查前后体积/包围盒一致）", () => {
  const { asm, shapes } = assemblyOf([[0, 0, 0], [5, 0, 0]]);
  const before = A.assemblyShapes(asm, shapes).map(({ shape }) => measureVolume(shape));
  const beforeBox = A.assemblyShapes(asm, shapes).map(({ shape }) => shapeBounds(shape).size);
  interferenceReport(asm, shapes);
  const after = A.assemblyShapes(asm, shapes).map(({ shape }) => measureVolume(shape));
  const afterBox = A.assemblyShapes(asm, shapes).map(({ shape }) => shapeBounds(shape).size);
  close(before[0], 1000, 1e-6);
  for (let i = 0; i < before.length; i++) {
    close(after[i], before[i], 1e-9);
    assert.deepEqual(afterBox[i], beforeBox[i]);
  }
});

test("实例形状缓存按零件对象隔离：两套装配体都用 p1 也不会串几何", () => {
  const small = assemblyOf([[0, 0, 0]]);
  const other = (() => {
    const asm = A.createAssembly("大盒");
    const part = A.addPart(asm, { name: "大盒", source: { kind: "project", project: { v: 1, features: [] } } });
    const shapes = new Map([[part.id, makeBaseBox(50, 30, 20)]]);
    A.addInstance(asm, { partId: part.id, name: "大", transform: { t: [0, 0, 0], r: A.quatIdentity() } });
    return { asm, part, shapes };
  })();
  assert.equal(small.asm.parts[0].id, other.part.id, "同名 partId 是本测试的前提");
  const v1 = measureVolume(A.assemblyShapes(small.asm, small.shapes)[0].shape);
  const v2 = measureVolume(A.assemblyShapes(other.asm, other.shapes)[0].shape);
  close(v1, 1000, 1e-6);
  close(v2, 50 * 30 * 20, 1e-6);
});

function topFaceId(shape) {
  const f = shape.faces.find((x) => Math.abs(x.center.z - 10) < 1e-9);
  return f.hashCode;
}
function bottomFaceId(shape) {
  const f = shape.faces.find((x) => Math.abs(x.center.z) < 1e-9);
  return f.hashCode;
}
