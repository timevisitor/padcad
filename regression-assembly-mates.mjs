/**
 * 装配配合求解回归（v6 装配路 · asm）
 *
 * 判据全部是解析值：
 *   两块 60×40×8 板（中心 Ø6 通孔）：
 *     面贴面重合 → 上板底面 z = 8，残差 < 1e-9，剩 3 DOF
 *     + 同轴（两个 Ø6 孔）→ 孔轴线距离 < 1e-6，剩 1 DOF
 *     + 侧面角度 0° → 剩 0 DOF
 *     距离配合 5 → 上板底面 z = 13（间隙 5）
 *     同一对面同时要求重合 + 距离 5 → 报 conflict，且两条配合都被点名
 *   平行 / 垂直 / 锁定 / 压制 / 拖动保配合 各一条。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import opencascade from "replicad-opencascadejs";
import { setOC, makeBaseBox, makeCylinder, measureVolume } from "replicad";
import * as A from "./src/assembly.js";
import { solveAssembly, dragInstance, suppressMate, setMateValue } from "./src/assembly-mates.js";

setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));

const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b} (tol ${tol})`);
const V = (s) => measureVolume(s);
const vlen = (v) => Math.hypot(...v);

/** 60×40×8 板，中心 Ø6 通孔（底面 z=0，顶面 z=8） */
function plate() {
  const box = makeBaseBox(60, 40, 8);
  const hole = makeCylinder(3, 20, [0, 0, -6], [0, 0, 1]);
  return box.clone().cut(hole);
}
function faceWhere(shape, pred, label) {
  const f = shape.faces.find((x) => { try { return pred(x); } catch (_) { return false; } });
  if (!f) throw new Error(`找不到面：${label}`);
  return f;
}
const topFace = (s) => faceWhere(s, (f) => Math.abs(f.center.z - 8) < 1e-6, "顶面 z=8");
const bottomFace = (s) => faceWhere(s, (f) => Math.abs(f.center.z) < 1e-6, "+Z 法向的底面");
const sideFace = (s, sign = 1) => faceWhere(s, (f) => Math.abs(f.center.y - 20 * sign) < 1e-6, "侧面 y=±20");
const cylFace = (s) => faceWhere(s, (f) => f.surface.surfaceType === "CYLINDRE", "孔壁");
const circleEdge = (s) => {
  const e = s.edges.find((x) => { try { return x.geomType === "CIRCLE"; } catch (_) { return false; } });
  if (!e) throw new Error("找不到圆边");
  return e;
};

/** 两条轴线的最短距离（平行时取点到线距离） */
function axisDistance(ra, rb) {
  const d1 = ra.direction, d2 = rb.direction;
  const w = [rb.point[0] - ra.point[0], rb.point[1] - ra.point[1], rb.point[2] - ra.point[2]];
  const cr = [d1[1] * d2[2] - d1[2] * d2[1], d1[2] * d2[0] - d1[0] * d2[2], d1[0] * d2[1] - d1[1] * d2[0]];
  const cl = vlen(cr);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (cl < 1e-9) {
    return vlen([w[0] - d1[0] * dot(w, d1), w[1] - d1[1] * dot(w, d1), w[2] - d1[2] * dot(w, d1)]);
  }
  return Math.abs(dot(w, [cr[0] / cl, cr[1] / cl, cr[2] / cl]));
}

/** 两个实例的装配夹具：i1 固定，i2 在 (13,-7,20) */
function twoPlateAssembly() {
  const pA = plate(), pB = plate();
  const asm = A.createAssembly("两板");
  const part = A.addPart(asm, { name: "板", source: { kind: "project", project: { v: 1, features: [] } } });
  const i1 = A.addInstance(asm, { partId: part.id, name: "下板" });
  const i2 = A.addInstance(asm, { partId: part.id, name: "上板", transform: { t: [13, -7, 20], r: A.quatIdentity() } });
  return { pA, pB, asm, i1, i2, part };
}

test("参考解析：平面面 → plane，孔壁 → axis（半径 3），圆边 → axis", () => {
  const p = plate();
  const top = A.refFromFace(p, topFace(p).hashCode);
  assert.equal(top.kind, "plane");
  close(top.point[2], 8);
  close(top.normal[2], 1);

  const hole = A.refFromFace(p, cylFace(p).hashCode);
  assert.equal(hole.kind, "axis");
  close(vlen(hole.direction), 1, 1e-12);
  close(hole.direction[2], 1, 1e-9);
  close(hole.radius, 3, 1e-9);

  const circ = A.refFromEdge(p, circleEdge(p).hashCode);
  assert.equal(circ.kind, "axis");
  close(circ.radius, 3, 1e-9);
  close(Math.abs(circ.direction[2]), 1, 1e-9);

  const line = p.edges.find((e) => e.geomType === "LINE");
  const lineRef = A.refFromEdge(p, line.hashCode);
  assert.equal(lineRef.kind, "axis");
  close(vlen(lineRef.direction), 1, 1e-12);

  const verts = A.verticesOf(p);
  assert.ok(verts.length >= 8, `顶点数 ${verts.length}`);
  const vert = A.refFromVertex(p, verts[0].hashCode);
  assert.equal(vert.kind, "point");
  assert.equal(vert.point.length, 3);

  const auto = A.refFromTopo(p, topFace(p).hashCode);
  assert.equal(auto.kind, "plane");
});

test("面贴面重合：上板底面落在 z=8，残差 < 1e-9，剩 3 个自由度", () => {
  const { pA, pB, asm, i1, i2 } = twoPlateAssembly();
  A.addMate(asm, {
    type: "coincident",
    a: { inst: i1.id, ref: A.refFromFace(pA, topFace(pA).hashCode) },
    b: { inst: i2.id, ref: A.refFromFace(pB, bottomFace(pB).hashCode) },
  });
  const res = solveAssembly(asm);
  assert.equal(res.status, "solved");
  assert.ok(res.maxResidual < 1e-9, `残差 ${res.maxResidual}`);
  close(asm.instances[1].transform.t[2], 8, 1e-6);
  assert.equal(res.dof, 3);
  assert.equal(res.rank, 3);
  // 面内平移不做约束：x/y 保持初值
  close(asm.instances[1].transform.t[0], 13, 1e-6);
  close(asm.instances[1].transform.t[1], -7, 1e-6);
});

test("加同轴（两个 Ø6 孔）：孔轴线距离 < 1e-6，剩 1 个自由度", () => {
  const { pA, pB, asm, i1, i2 } = twoPlateAssembly();
  A.addMate(asm, {
    type: "coincident",
    a: { inst: i1.id, ref: A.refFromFace(pA, topFace(pA).hashCode) },
    b: { inst: i2.id, ref: A.refFromFace(pB, bottomFace(pB).hashCode) },
  });
  A.addMate(asm, {
    type: "concentric",
    a: { inst: i1.id, ref: A.refFromFace(pA, cylFace(pA).hashCode) },
    b: { inst: i2.id, ref: A.refFromFace(pB, cylFace(pB).hashCode) },
  });
  const res = solveAssembly(asm);
  assert.equal(res.status, "solved");
  assert.ok(res.maxResidual < 1e-9, `残差 ${res.maxResidual}`);
  assert.equal(res.dof, 1, `剩 ${res.dof} 个自由度`);
  const poseA = A.poseFromTransform(asm.instances[0].transform);
  const poseB = A.poseFromTransform(asm.instances[1].transform);
  const axA = A.transformRef(A.refFromFace(pA, cylFace(pA).hashCode), poseA);
  const axB = A.transformRef(A.refFromFace(pB, cylFace(pB).hashCode), poseB);
  const d = axisDistance(axA, axB);
  assert.ok(d < 1e-6, `孔轴线距离 ${d}`);
  close(asm.instances[1].transform.t[2], 8, 1e-6);
});

test("再加侧面角度 0°：剩 0 个自由度（完全约束）", () => {
  const { pA, pB, asm, i1, i2 } = twoPlateAssembly();
  const refTopA = A.refFromFace(pA, topFace(pA).hashCode);
  const refBotB = A.refFromFace(pB, bottomFace(pB).hashCode);
  A.addMate(asm, { type: "coincident", a: { inst: i1.id, ref: refTopA }, b: { inst: i2.id, ref: refBotB } });
  A.addMate(asm, {
    type: "concentric",
    a: { inst: i1.id, ref: A.refFromFace(pA, cylFace(pA).hashCode) },
    b: { inst: i2.id, ref: A.refFromFace(pB, cylFace(pB).hashCode) },
  });
  A.addMate(asm, {
    type: "angle", value: 0,
    a: { inst: i1.id, ref: A.refFromFace(pA, sideFace(pA, 1).hashCode) },
    b: { inst: i2.id, ref: A.refFromFace(pB, sideFace(pB, 1).hashCode) },
  });
  const res = solveAssembly(asm);
  assert.equal(res.status, "solved");
  assert.equal(res.dof, 0);
  assert.equal(res.rank, 6);
});

test("距离配合 5：上板底面 z=13（间隙恰为 5）", () => {
  const { pA, pB, asm, i1, i2 } = twoPlateAssembly();
  A.addMate(asm, {
    type: "distance", value: 5,
    a: { inst: i1.id, ref: A.refFromFace(pA, topFace(pA).hashCode) },
    b: { inst: i2.id, ref: A.refFromFace(pB, bottomFace(pB).hashCode) },
  });
  const res = solveAssembly(asm);
  assert.equal(res.status, "solved");
  close(asm.instances[1].transform.t[2], 13, 1e-6);
  const poseA = A.poseFromTransform(asm.instances[0].transform);
  const poseB = A.poseFromTransform(asm.instances[1].transform);
  const pAworld = A.transformRef(A.refFromFace(pA, topFace(pA).hashCode), poseA).point;
  const pBworld = A.transformRef(A.refFromFace(pB, bottomFace(pB).hashCode), poseB).point;
  close(pBworld[2] - pAworld[2], 5, 1e-6);
});

test("矛盾配合（同一对面既要重合又要距离 5）→ conflict，两条都被点名", () => {
  const { pA, pB, asm, i1, i2 } = twoPlateAssembly();
  const refTopA = A.refFromFace(pA, topFace(pA).hashCode);
  const refBotB = A.refFromFace(pB, bottomFace(pB).hashCode);
  const m1 = A.addMate(asm, { type: "coincident", a: { inst: i1.id, ref: refTopA }, b: { inst: i2.id, ref: refBotB } });
  const m2 = A.addMate(asm, { type: "distance", value: 5, a: { inst: i1.id, ref: refTopA }, b: { inst: i2.id, ref: refBotB } });
  const res = solveAssembly(asm);
  assert.equal(res.status, "conflict");
  assert.equal(res.ok, false);
  assert.ok(res.conflicts.includes(m1.id), `冲突列表 ${res.conflicts}`);
  assert.ok(res.conflicts.includes(m2.id), `冲突列表 ${res.conflicts}`);
  // 解不出零残差，但位姿停在最小二乘点上：z 落在 8 与 13 之间
  const z = asm.instances[1].transform.t[2];
  assert.ok(z > 8.5 && z < 12.5, `z=${z}`);
});

test("平行配合：从偏转 20° 拉回平行（法向点积 = 1）", () => {
  const { pA, pB, asm, i1, i2 } = twoPlateAssembly();
  const tilt = A.quatFromAxisAngle([0, 0, 1], (20 * Math.PI) / 180);
  asm.instances[1].transform = { t: [13, -7, 20], r: tilt };
  A.addMate(asm, {
    type: "parallel",
    a: { inst: i1.id, ref: A.refFromFace(pA, sideFace(pA, 1).hashCode) },
    b: { inst: i2.id, ref: A.refFromFace(pB, sideFace(pB, 1).hashCode) },
  });
  const res = solveAssembly(asm);
  assert.equal(res.status, "solved");
  const poseA = A.poseFromTransform(asm.instances[0].transform);
  const poseB = A.poseFromTransform(asm.instances[1].transform);
  const nA = A.transformRef(A.refFromFace(pA, sideFace(pA, 1).hashCode), poseA).normal;
  const nB = A.transformRef(A.refFromFace(pB, sideFace(pB, 1).hashCode), poseB).normal;
  close(Math.abs(nA[0] * nB[0] + nA[1] * nB[1] + nA[2] * nB[2]), 1, 1e-8);
  assert.equal(res.dof, 4);   // 只剩 2 平移 + 2 转动（绕/沿该法向）
});

test("垂直配合：两侧面法向点积 = 0", () => {
  const { pA, pB, asm, i1, i2 } = twoPlateAssembly();
  A.addMate(asm, {
    type: "perpendicular",
    a: { inst: i1.id, ref: A.refFromFace(pA, sideFace(pA, 1).hashCode) },
    b: { inst: i2.id, ref: A.refFromFace(pB, sideFace(pB, 1).hashCode) },
  });
  const res = solveAssembly(asm);
  assert.equal(res.status, "solved");
  const poseA = A.poseFromTransform(asm.instances[0].transform);
  const poseB = A.poseFromTransform(asm.instances[1].transform);
  const nA = A.transformRef(A.refFromFace(pA, sideFace(pA, 1).hashCode), poseA).normal;
  const nB = A.transformRef(A.refFromFace(pB, sideFace(pB, 1).hashCode), poseB).normal;
  close(nA[0] * nB[0] + nA[1] * nB[1] + nA[2] * nB[2], 0, 1e-8);
});

test("锁定（lock）：i3 与 i2 冻结成刚体，i2 被面配合带走时 i3 同步平移", () => {
  const { pA, pB, asm, i1, i2 } = twoPlateAssembly();
  const i3 = A.addInstance(asm, { partId: asm.parts[0].id, name: "第三件", transform: { t: [50, 0, 0], r: A.quatIdentity() } });
  A.addMate(asm, { type: "lock", a: { inst: i3.id, ref: null }, b: { inst: i2.id, ref: null } });
  A.addMate(asm, {
    type: "coincident",
    a: { inst: i1.id, ref: A.refFromFace(pA, topFace(pA).hashCode) },
    b: { inst: i2.id, ref: A.refFromFace(pB, bottomFace(pB).hashCode) },
  });
  const res = solveAssembly(asm);
  assert.equal(res.status, "solved", JSON.stringify(res.conflicts));
  const t2 = asm.instances[1].transform.t;
  const t3 = asm.instances[2].transform.t;
  close(t2[2], 8, 1e-6);
  // 初始相对位姿：(50,0,0) − (13,−7,20) = (37,7,−20)；i2 下沉到 z=8 后 i3 同步
  close(t3[0] - t2[0], 37, 1e-6);
  close(t3[1] - t2[1], 7, 1e-6);
  close(t3[2] - t2[2], -20, 1e-6);
});

test("压制配合后实例重新变自由（DOF 回到 6）", () => {
  const { pA, pB, asm, i1, i2 } = twoPlateAssembly();
  const m = A.addMate(asm, {
    type: "coincident",
    a: { inst: i1.id, ref: A.refFromFace(pA, topFace(pA).hashCode) },
    b: { inst: i2.id, ref: A.refFromFace(pB, bottomFace(pB).hashCode) },
  });
  assert.equal(solveAssembly(asm).dof, 3);
  const res = suppressMate(asm, m.id, true);
  assert.equal(res.status, "solved");
  assert.equal(res.dof, 6);
  assert.equal(asm.mates[0].suppressed, true);
});

test("拖动保配合：在面内拖到 (25,30)，z 仍被压在 8", () => {
  const { pA, pB, asm, i1, i2 } = twoPlateAssembly();
  A.addMate(asm, {
    type: "coincident",
    a: { inst: i1.id, ref: A.refFromFace(pA, topFace(pA).hashCode) },
    b: { inst: i2.id, ref: A.refFromFace(pB, bottomFace(pB).hashCode) },
  });
  const res = dragInstance(asm, i2.id, { t: [25, 30, 8], r: A.quatIdentity() });
  assert.equal(res.status, "solved");
  const t = asm.instances[1].transform.t;
  close(t[0], 25, 1e-6); close(t[1], 30, 1e-6); close(t[2], 8, 1e-6);
  // 拖离配合面（z=30）应当报冲突，而不是默默接受
  const bad = dragInstance(asm, i2.id, { t: [25, 30, 30], r: A.quatIdentity() });
  assert.equal(bad.status, "conflict");
});

test("配合值与参考类型的兼容性过滤（UI 径向菜单的依据）", () => {
  assert.equal(A.refsCompatible("coincident", "plane", "plane"), true);
  assert.equal(A.refsCompatible("coincident", "axis", "plane"), false);
  assert.equal(A.refsCompatible("concentric", "axis", "axis"), true);
  assert.equal(A.refsCompatible("distance", "point", "plane"), true);
  assert.equal(A.refsCompatible("angle", "axis", "axis"), true);
  assert.equal(A.nominalDofRemoved("coincident", "plane", "plane"), 3);
  assert.equal(A.nominalDofRemoved("concentric", "axis", "axis"), 4);
  assert.equal(A.nominalDofRemoved("lock", "any", "any"), 6);
});

test("存档校验：未知配合类型 / 缺参考 / 不存在实例 都被点名", () => {
  const { pA, asm, i1, i2 } = twoPlateAssembly();
  const ok = A.validateAssembly(asm);
  assert.equal(ok.ok, true, ok.errors.join("; "));
  asm.mates.push({ id: "mx", type: "gear", a: { inst: i1.id, ref: null }, b: { inst: i2.id, ref: null } });
  asm.mates.push({ id: "my", type: "coincident", a: { inst: "i99", ref: null }, b: { inst: i2.id, ref: null } });
  const bad = A.validateAssembly(asm);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes("gear")));
  assert.ok(bad.errors.some((e) => e.includes("i99")));
  assert.ok(bad.errors.some((e) => e.includes("缺少几何参考")));
});

test("实例形状：位姿变换后体积守恒、包围盒跟着走（内核侧）", () => {
  const p = plate();
  const vol = V(p);
  const moved = A.shapeAtTransform(p, { t: [100, 0, 0], r: A.quatFromAxisAngle([0, 0, 1], Math.PI / 2) });
  close(V(moved), vol, 1e-6);
  const bb = moved.boundingBox;
  close(bb.center[0], 100, 1e-6);
  close(bb.width, 40, 1e-6);      // 绕 Z 转 90°：60×40 → 40×60
  close(bb.height, 60, 1e-6);
  // 源实体没被消费
  close(V(p), vol, 1e-6);
});

test("求解是幂等的：已经解好的装配体再解一次，位姿逐位不变", () => {
  const { pA, pB, asm, i1, i2 } = twoPlateAssembly();
  A.addMate(asm, {
    type: "coincident",
    a: { inst: i1.id, ref: A.refFromFace(pA, topFace(pA).hashCode) },
    b: { inst: i2.id, ref: A.refFromFace(pB, bottomFace(pB).hashCode) },
  });
  A.addMate(asm, {
    type: "concentric",
    a: { inst: i1.id, ref: A.refFromFace(pA, cylFace(pA).hashCode) },
    b: { inst: i2.id, ref: A.refFromFace(pB, cylFace(pB).hashCode) },
  });
  solveAssembly(asm);
  const before = JSON.parse(JSON.stringify(asm.instances));
  const again = solveAssembly(asm);
  assert.equal(again.iterations, 0);
  assert.deepEqual(asm.instances, before);
});

test("父代理复算补：同向面距离配合未指定 flip 时自动同向，不卡驻点误报冲突", () => {
  const base = makeBaseBox(100, 50, 10), cube = makeBaseBox(20, 20, 20);
  const fw = (s, pred) => s.faces.find((f) => { try { return pred(f); } catch (_) { return false; } });
  const asm = A.createAssembly("同向距离");
  const pb = A.addPart(asm, { name: "底板", source: { kind: "inline", script: "x" } });
  const pc = A.addPart(asm, { name: "方块", source: { kind: "inline", script: "x" } });
  const ib = A.addInstance(asm, { partId: pb.id });
  const ic = A.addInstance(asm, { partId: pc.id, transform: { t: [7, 4, 33], r: A.quatFromAxisAngle([1, 1, 0], 0.3) } });
  A.addMate(asm, { type: "coincident", a: { inst: ib.id, ref: A.refFromFace(base, fw(base, (f) => Math.abs(f.center.z - 10) < 1e-6).hashCode) },
    b: { inst: ic.id, ref: A.refFromFace(cube, fw(cube, (f) => Math.abs(f.center.z) < 1e-6).hashCode) } });
  assert.equal(solveAssembly(asm).status, "solved");
  const m = A.addMate(asm, { type: "distance", value: 15, a: { inst: ib.id, ref: A.refFromFace(base, fw(base, (f) => Math.abs(f.center.x - 50) < 1e-6).hashCode) },
    b: { inst: ic.id, ref: A.refFromFace(cube, fw(cube, (f) => Math.abs(f.center.x - 10) < 1e-6).hashCode) } });
  assert.equal(m.flip, true);
  const r = solveAssembly(asm);
  assert.equal(r.status, "solved");
  assert.equal(r.dof, 1);
  close(asm.instances[1].transform.t[0] + 10, 65, 1e-6);
  // 显式 flip:false 仍按用户指定（反向）
  const m2 = A.addMate(A.createAssembly("x"), { type: "distance", value: 1, flip: false, a: { inst: "i1", ref: null }, b: { inst: "i2", ref: null } });
  assert.equal(m2.flip, false);
});
