/**
 * 装配存档 / STEP 导出 / BOM 回归（v6 装配路 · asm）
 *
 * 判据：
 *  base64 往返字节完全一致
 *  存档 → 恢复 → 每个实例的体积、包围盒、位姿逐位一致；配合求解结果一致（再解 0 次迭代）
 *  project 来源（内嵌 v1 工程定义）与 step 来源（内嵌 STEP 字节）都能重建
 *  装配体导出 STEP → readStepBytes 读回：实体数 = 实例数，总体积 = 各实例体积之和（相对误差 < 1e-6）
 *  BOM：零件名 / 数量正确
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import opencascade from "replicad-opencascadejs";
import { setOC, makeBaseBox, makeCylinder, measureVolume } from "replicad";
import * as A from "./src/assembly.js";
import { solveAssembly } from "./src/assembly-mates.js";
import { projectDefinition } from "./src/project.js";
import { readStepBytes } from "./src/step-io.js";
import {
  bytesToBase64, base64ToBytes, assemblyDefinition, serializeAssembly, restoreAssembly,
  restoreAssemblyJSON, exportAssemblySTEP, assemblyBOM, bomText, instanceNames,
  partSourceFromProject, partSourceFromStepBytes, partSourceFromScript,
} from "./src/assembly-io.js";

setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));

const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b} (tol ${tol})`);
const vol = (s) => measureVolume(s);
const bbox = (s) => {
  const b = s.boundingBox;
  return [b.width, b.height, b.depth].map((v) => Math.round(v * 1e6) / 1e6);
};

const plateProject = () => projectDefinition("板", [
  { label: "底板", detail: "60×40×8", icon: "▪", op: { type: "primitive", shape: "box", size: [60, 40, 8] } },
], 0);

function twoPlateAssembly() {
  const asm = A.createAssembly("两板装配");
  const part = A.addPart(asm, { name: "板", source: partSourceFromProject(plateProject()) });
  const i1 = A.addInstance(asm, { partId: part.id, name: "下板" });
  const i2 = A.addInstance(asm, { partId: part.id, name: "上板", transform: { t: [7, 3, 20], r: [0, 0, 0, 1] } });
  return { asm, part, i1, i2 };
}

test("base64 往返：任意字节（含 0x00 / 0xFF）完全一致", () => {
  const cases = [
    new Uint8Array([]),
    new Uint8Array([0]),
    new Uint8Array([0, 255, 128, 1]),
    new Uint8Array(Array.from({ length: 257 }, (_, i) => i & 255)),
  ];
  for (const c of cases) {
    const back = base64ToBytes(bytesToBase64(c));
    assert.equal(back.length, c.length);
    assert.deepEqual([...back], [...c]);
  }
});

test("存档往返：实例位姿 / 体积 / 包围盒逐位一致，恢复后求解 0 次迭代", () => {
  const { asm, part, i1, i2 } = twoPlateAssembly();
  // 用项目件做一次面贴面重合
  const { partShapes } = restoreAssembly(assemblyDefinition(asm));
  const shape = partShapes.get(part.id);
  const top = shape.faces.find((f) => Math.abs(f.center.z - 8) < 1e-6);
  const bottom = shape.faces.find((f) => Math.abs(f.center.z) < 1e-6 && f.center.x < 1);
  A.addMate(asm, {
    type: "coincident",
    a: { inst: i1.id, ref: A.refFromFace(shape, top.hashCode) },
    b: { inst: i2.id, ref: A.refFromFace(shape, bottom.hashCode) },
  });
  const before = solveAssembly(asm);
  assert.equal(before.status, "solved");
  assert.equal(before.dof, 3);

  const text = serializeAssembly(asm);
  const { assembly: back, partShapes: backShapes } = restoreAssemblyJSON(text);
  assert.equal(back.name, "两板装配");
  assert.equal(back.instances.length, 2);
  assert.equal(back.mates.length, 1);

  // 位姿逐位一致
  assert.deepEqual(back.instances, JSON.parse(JSON.stringify(asm.instances)));
  // 几何一致
  close(vol(backShapes.get(part.id)), vol(shape), 1e-9);
  assert.deepEqual(bbox(backShapes.get(part.id)), bbox(shape));

  // 每个实例体积 / 包围盒一致
  const live = A.assemblyShapes(asm, partShapes);
  const restored = A.assemblyShapes(back, backShapes);
  assert.equal(live.length, restored.length);
  for (let i = 0; i < live.length; i++) {
    close(vol(restored[i].shape), vol(live[i].shape), 1e-6);
    assert.deepEqual(bbox(restored[i].shape), bbox(live[i].shape));
  }

  // 配合与求解结果一致：已经解好的装配体再解一次不应移动任何东西
  const again = solveAssembly(back);
  assert.equal(again.status, "solved");
  assert.equal(again.iterations, 0);
  assert.equal(again.dof, before.dof);
  assert.deepEqual(back.instances, JSON.parse(JSON.stringify(asm.instances)));
});

test("存档里零件几何是内嵌的：删掉原工程文件也能重开", () => {
  const { asm } = twoPlateAssembly();
  const def = assemblyDefinition(asm);
  // 存档里必须同时有 v1 工程定义，而不是路径
  assert.equal(def.parts[0].source.kind, "project");
  assert.ok(Array.isArray(def.parts[0].source.project.features));
  assert.equal(def.parts[0].source.project.features[0].op.type, "primitive");
  const { partShapes } = restoreAssembly(def);
  close(vol(partShapes.get(def.parts[0].id)), 60 * 40 * 8, 1e-6);
});

test("STEP 来源零件：内嵌 base64 字节，恢复后体积一致", async () => {
  const cyl = makeCylinder(5, 30, [0, 0, 0], [0, 0, 1]);
  const bytes = new Uint8Array(await cyl.blobSTEP().arrayBuffer());
  const asm = A.createAssembly("销");
  const part = A.addPart(asm, { name: "销", source: partSourceFromStepBytes(bytes) });
  A.addInstance(asm, { partId: part.id, name: "销1" });
  const { assembly: back, partShapes } = restoreAssembly(assemblyDefinition(asm));
  assert.equal(back.parts[0].source.kind, "step");
  close(vol(partShapes.get(back.parts[0].id)), Math.PI * 25 * 30, 1e-3);
});

test("inline 脚本零件：恢复时按脚本重放", () => {
  const asm = A.createAssembly("脚本件");
  const part = A.addPart(asm, {
    name: "脚本盒",
    source: partSourceFromScript({ v: 1, steps: [{ op: { type: "primitive", shape: "box", size: [10, 10, 10] } }] }),
  });
  A.addInstance(asm, { partId: part.id, name: "盒1" });
  const { partShapes } = restoreAssembly(assemblyDefinition(asm));
  close(vol(partShapes.get(part.id)), 1000, 1e-6);
});

test("装配体导出 STEP：实体数 = 实例数，总体积 = 各实例之和", async () => {
  const { asm, part } = twoPlateAssembly();
  const i3 = A.addInstance(asm, { partId: part.id, name: "上板", transform: { t: [0, 0, 40], r: [0, 0, 0, 1] } });
  // STEP 里同名实例自动加序号，避免 XCAF 名字互相覆盖
  assert.deepEqual(instanceNames(asm), ["下板", "上板", "上板#2"]);
  assert.equal(i3.partId, part.id);
  const { partShapes } = restoreAssembly(assemblyDefinition(asm));
  const blob = exportAssemblySTEP(asm, partShapes);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const r = readStepBytes(bytes, { name: "asm.step" });
  assert.equal(r.solids, 3, `读回实体数 ${r.solids}`);
  const expected = asm.instances.reduce((s, inst) => s + vol(A.shapeAtTransform(partShapes.get(inst.partId), inst.transform)), 0);
  close(vol(r.shape), expected, expected * 1e-6);
  // 名字唯一
  const names = instanceNames(asm);
  assert.equal(new Set(names).size, names.length, names.join(","));
});

test("BOM：零件名 / 数量 / 实例清单", () => {
  const { asm, part } = twoPlateAssembly();
  A.addInstance(asm, { partId: part.id, name: "板3", transform: { t: [0, 0, 60], r: [0, 0, 0, 1] } });
  const bom = assemblyBOM(asm);
  assert.equal(bom.length, 1);
  assert.equal(bom[0].qty, 3);
  assert.equal(bom[0].partName, "板");
  assert.equal(bom[0].source, "project");
  assert.deepEqual(bom[0].instances, ["下板", "上板", "板3"]);
  const text = bomText(asm);
  assert.ok(text.includes("合计\t3"), text);
});

test("坏存档：版本不符 / 缺零件 都要给人看得懂的错", () => {
  const { asm } = twoPlateAssembly();
  const def = assemblyDefinition(asm);
  assert.throws(() => restoreAssembly({ ...def, v: 2 }), /版本/);
  assert.throws(() => restoreAssembly({ ...def, parts: [] }), /没有任何零件/);
  assert.throws(() => restoreAssembly({ ...def, kind: "pjson" }), /不是装配体文件/);
  assert.throws(() => restoreAssemblyJSON("{oops"), /不是合法 JSON/);
  assert.throws(() => restoreAssembly({ ...def, instances: [] }), /没有任何实例/);
  // 实例引用了不存在的零件
  assert.throws(() => restoreAssembly({ ...def, instances: [{ ...def.instances[0], partId: "p99" }] }), /引用的零件不存在/);
});

test("存档不含只用于显示的字段（爆炸基准、求解缓存）", () => {
  const { asm } = twoPlateAssembly();
  asm.__explodeBase = { i1: { t: [1, 2, 3], r: [0, 0, 0, 1] } };
  asm.explodeFactor = 1;
  const def = assemblyDefinition(asm);
  const text = JSON.stringify(def);
  assert.ok(!text.includes("__explodeBase"));
  assert.ok(!text.includes("explodeFactor"));
  const keys = Object.keys(def).sort();
  assert.deepEqual(keys, ["explode", "instances", "kind", "mates", "name", "parts", "savedAt", "unit", "v"]);
});
