/**
 * 装配体数据模型（v6 装配路 · asm）
 *
 * 为什么单独一个模块：PadCAD 之前「一个文档 = 一条 history = 一个实体」，
 * project.js 的 v1 工程格式只装得下一个零件。装配体要的是
 * 「零件（几份几何）× 实例（位姿） × 配合（约束）」，是另一层数据结构，
 * 硬塞进 history 会把 replay 的语义搅乱（replay 的每个 op 都是"改这个实体"）。
 *
 * 设计约束（与主工程保持一致）：
 *  - 单位 mm、Z-up、makeBaseBox 底面 z=0 —— 和 primitives.js 的既有约定一样。
 *  - 存的是「定义」不是「结果」：零件的几何来源是 project.js 的 v1 工程定义
 *    或 STEP 字节，实例只存位姿；打开文件时再 rebuild（同 project.js 的思路）。
 *  - 参考（ref）存**几何值**（点/法向/方向），不存拓扑哈希：哈希每做一次布尔就全变，
 *    而装配体存档必须能在另一台机器、另一次 rebuild 后仍然可用。这和 replay.js
 *    「用几何特征重定位」的既有约定是同一条。
 *  - embind 对象（OCCT 句柄）必须保引用，否则 JS 侧 GC 后内核对象失效 —— 滚动 keepAlive。
 *
 * 本文件只被 assembly-*.js 与（将来的）UI 使用，不改任何既有模块。
 */
import { getOC, cast, iterTopo } from "replicad";

export const ASM_VERSION = 1;
export const ASM_KIND = "asm";

// ---------------------------------------------------------------- 四元数 / 位姿
// 全部用纯数据（数组、普通对象），求解器与回归测试都不需要内核。
// 四元数约定 [x, y, z, w]（与 three.js 的 Vector4 顺序一致，便于 UI 直接喂）。

export const quatIdentity = () => [0, 0, 0, 1];

export function quatNormalize(q = quatIdentity()) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(n > 1e-15)) return quatIdentity();
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** a ⊗ b：先做 b 的旋转，再做 a 的旋转（等价矩阵 Ra·Rb） */
export function quatMultiply(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export const quatConjugate = (q) => [-q[0], -q[1], -q[2], q[3]];

/** 旋转向量（轴×角，Rodrigues）→ 四元数 */
export function quatFromRotationVector(rv) {
  const theta = Math.hypot(rv[0], rv[1], rv[2]);
  if (!(theta > 1e-15)) return quatIdentity();
  const s = Math.sin(theta / 2) / theta;
  return [rv[0] * s, rv[1] * s, rv[2] * s, Math.cos(theta / 2)];
}

export function quatFromAxisAngle(axis, rad) {
  const L = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const s = Math.sin(rad / 2);
  return [axis[0] / L * s, axis[1] / L * s, axis[2] / L * s, Math.cos(rad / 2)];
}

/** 行主序 3×3 旋转矩阵 */
export function quatToMatrix(qIn) {
  const [x, y, z, w] = quatNormalize(qIn);
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

export function matrixToQuat(m) {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4;
  }
  return quatNormalize([x, y, z, w]);
}

export function quatRotate(q, v) {
  const m = quatToMatrix(q);
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export const vAdd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vSub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vScale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const vDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vCross = (a, b) => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
export const vLen = (a) => Math.hypot(a[0], a[1], a[2]);
export function vNorm(a) { const L = vLen(a) || 1; return [a[0] / L, a[1] / L, a[2] / L]; }

/** 位姿：{ t:[x,y,z], R:[9] 行主序 }；把局部点变世界点：R·p + t */
export function poseFromTransform(tr = {}) {
  return { t: [...(tr.t || [0, 0, 0])], R: quatToMatrix(tr.r || quatIdentity()) };
}

export function transformFromPose(pose) {
  return { t: [...pose.t], r: matrixToQuat(pose.R) };
}

export const identityTransform = () => ({ t: [0, 0, 0], r: quatIdentity() });

export const applyPose = (pose, p) => vAdd(quatRotate(matrixToQuat(pose.R), p), pose.t);
export const applyPoseDir = (pose, d) => quatRotate(matrixToQuat(pose.R), d);

/** a ∘ b：先 b 后 a */
export function poseCompose(a, b) {
  return { t: applyPose(a, b.t), R: matMul(a.R, b.R) };
}

export function poseInvert(p) {
  const Rt = matTranspose(p.R);
  return { t: vScale(matVec(Rt, p.t), -1), R: Rt };
}

export function matVec(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}
export function matMul(a, b) {
  const out = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return out;
}
export function matTranspose(m) {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

/** 两个旋转之间的误差向量（小角度近似，用于 lock 配合与收敛判定） */
export function rotationError(Ra, Rb) {
  let v = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const a = [Ra[i], Ra[3 + i], Ra[6 + i]];   // Ra 的第 i 列 = 局部第 i 轴在世界系的方向
    const b = [Rb[i], Rb[3 + i], Rb[6 + i]];
    const c = vCross(a, b);
    v = [v[0] + c[0] * 0.5, v[1] + c[1] * 0.5, v[2] + c[2] * 0.5];
  }
  return v;
}

// ---------------------------------------------------------------- 数据模型
let seqCache = null;
function nextId(list, prefix) {
  let max = 0;
  for (const item of list) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(item.id || "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

export function createAssembly(name = "装配体") {
  return {
    v: ASM_VERSION,
    kind: ASM_KIND,
    name: String(name || "装配体"),
    parts: [],
    instances: [],
    mates: [],
    explode: [],       // [{ id, instance, dir:[x,y,z], distance, label }]
    unit: "mm",
  };
}

/**
 * 加一个零件（几何来源）。source 三种：
 *  { kind:"project", project:<v1 工程定义> }  —— 主工程存的 .pjson，内嵌进来
 *  { kind:"step", data:"<base64 STEP>" }       —— 导入的 STEP（多实体已合体）
 *  { kind:"inline", script:"..." }             —— 内联脚本（model-script.js 的脚本串）
 */
export function addPart(asm, { name, source, id } = {}) {
  if (!source || !["project", "step", "inline"].includes(source.kind)) {
    throw new Error("零件来源必须是 project / step / inline 之一");
  }
  if (source.kind === "project" && !source.project) throw new Error("project 来源必须带工程定义");
  if (source.kind === "step" && !source.data) throw new Error("step 来源必须带 base64 数据");
  if (source.kind === "inline" && !source.script) throw new Error("inline 来源必须带脚本");
  const part = {
    id: id || nextId(asm.parts, "p"),
    name: String(name || `零件${asm.parts.length + 1}`),
    source,
  };
  asm.parts.push(part);
  return part;
}

/** 加实例。首个实例默认固定（= SolidWorks 插入第一个零件的绿勾）。 */
export function addInstance(asm, { partId, name, transform, fixed, color, visible } = {}) {
  if (!asm.parts.some((p) => p.id === partId)) throw new Error(`零件 ${partId} 不存在`);
  const part = asm.parts.find((p) => p.id === partId);
  const samePart = asm.instances.filter((i) => i.partId === partId).length;
  const inst = {
    id: nextId(asm.instances, "i"),
    partId,
    name: String(name || `${part.name}${samePart + 1}`),
    transform: normalizeTransform(transform),
    fixed: fixed === undefined ? asm.instances.length === 0 : !!fixed,
    color: color || null,
    visible: visible === undefined ? true : !!visible,
  };
  asm.instances.push(inst);
  return inst;
}

/** 内部便捷方法（不污染存档 JSON：序列化时只挑字段） */
export function partInstanceCount(asm, partId) {
  return asm.instances.filter((i) => i.partId === partId).length;
}

export function normalizeTransform(tr = {}) {
  const t = Array.isArray(tr.t) && tr.t.length === 3 && tr.t.every(Number.isFinite)
    ? tr.t.map(Number) : [0, 0, 0];
  const r = Array.isArray(tr.r) && tr.r.length === 4 && tr.r.every(Number.isFinite)
    ? quatNormalize(tr.r.map(Number)) : quatIdentity();
  return { t, r };
}

export function removeInstance(asm, instId) {
  const i = asm.instances.findIndex((x) => x.id === instId);
  if (i < 0) throw new Error(`实例 ${instId} 不存在`);
  asm.instances.splice(i, 1);
  asm.mates = asm.mates.filter((m) => m.a.inst !== instId && m.b.inst !== instId);
  asm.explode = asm.explode.filter((s) => s.instance !== instId);
  return asm;
}

export function removePart(asm, partId) {
  for (const inst of asm.instances.filter((i) => i.partId === partId)) removeInstance(asm, inst.id);
  asm.parts = asm.parts.filter((p) => p.id !== partId);
  return asm;
}

export function addMate(asm, mate) {
  const m = {
    id: mate.id || nextId(asm.mates, "m"),
    type: mate.type,
    a: { inst: mate.a?.inst, ref: mate.a?.ref || null },
    b: { inst: mate.b?.inst, ref: mate.b?.ref || null },
    value: Number.isFinite(Number(mate.value)) ? Number(mate.value) : 0,
    flip: mate.flip === undefined || mate.flip === null ? autoFlip(asm, mate) : !!mate.flip,
    suppressed: !!mate.suppressed,
    label: mate.label || null,
  };
  if (mate.rel) m.rel = mate.rel;
  asm.mates.push(m);
  return m;
}

/**
 * 面-面重合/距离配合的对齐方向（SolidWorks 的「同向对齐 / 反向对齐」）未指定时，按两面**当前**法向取最近的一种。
 * 原因（父代理复算实测）：两个朝向相同的面加距离配合，若固定按“反向”求解，需要把实例转 180°——
 * 那里恰是驻点（残差对绕法向的旋转梯度为零），LM 停在原地并报 conflict（残差 1.97）。
 */
function autoFlip(asm, mate) {
  if (!["coincident", "distance"].includes(mate.type)) return false;
  const ra = mate.a?.ref, rb = mate.b?.ref;
  if (ra?.kind !== "plane" || rb?.kind !== "plane") return false;
  const ia = instanceById(asm, mate.a.inst), ib = instanceById(asm, mate.b.inst);
  if (!ia || !ib) return false;
  const na = transformRef(ra, poseFromTransform(ia.transform)).normal;
  const nb = transformRef(rb, poseFromTransform(ib.transform)).normal;
  return vDot(na, nb) > 0;
}

export function removeMate(asm, mateId) {
  const i = asm.mates.findIndex((m) => m.id === mateId);
  if (i < 0) throw new Error(`配合 ${mateId} 不存在`);
  asm.mates.splice(i, 1);
  return asm;
}

export const instanceById = (asm, id) => asm.instances.find((i) => i.id === id) || null;
export const partById = (asm, id) => asm.parts.find((p) => p.id === id) || null;

// ---------------------------------------------------------------- 参考（ref）
/**
 * ref 一律存在**零件局部坐标系**里：
 *   { kind:"plane", point:[x,y,z], normal:[x,y,z] }
 *   { kind:"axis",  point:[x,y,z], direction:[x,y,z], radius?:number, curve?:string }
 *   { kind:"point", point:[x,y,z] }
 * 实例位姿变化时不用改 ref —— 求解时再变换到世界系。
 */
export const REF_KINDS = ["plane", "axis", "point"];

export function makeRef(kind, data) {
  if (!REF_KINDS.includes(kind)) throw new Error(`未知参考类型 ${kind}`);
  if (kind === "plane") {
    return { kind, point: data.point.map(Number), normal: vNorm(data.normal) };
  }
  if (kind === "axis") {
    return {
      kind, point: data.point.map(Number), direction: vNorm(data.direction),
      ...(Number.isFinite(data.radius) ? { radius: Number(data.radius) } : {}),
      ...(data.curve ? { curve: data.curve } : {}),
    };
  }
  return { kind, point: data.point.map(Number) };
}

export function transformRef(ref, pose) {
  if (ref.kind === "plane") {
    return { ...ref, point: applyPose(pose, ref.point), normal: vNorm(applyPoseDir(pose, ref.normal)) };
  }
  if (ref.kind === "axis") {
    return { ...ref, point: applyPose(pose, ref.point), direction: vNorm(applyPoseDir(pose, ref.direction)) };
  }
  return { ...ref, point: applyPose(pose, ref.point) };
}

const tupleOf = (v) => (Array.isArray(v) ? v : [v.x, v.y, v.z]);

function findFace(shape, faceId) {
  return (shape.faces || []).find((f) => f.hashCode === faceId) || null;
}
function findEdge(shape, edgeId) {
  return (shape.edges || []).find((e) => e.hashCode === edgeId) || null;
}
function findVertex(shape, vertexId) {
  return verticesOf(shape).find((v) => v.hashCode === vertexId) || null;
}

/**
 * 拓扑顶点列表。
 * 坑：replicad 1.1.0 的 Shape **没有** `vertices` getter（只有 faces/edges/wires/solids），
 * 探针实测 `shape.vertices === undefined`；所以这里用 iterTopo 自己走一遍再 cast 成 Vertex。
 */
export function verticesOf(shape) {
  if (!shape) return [];
  try { return Array.from(iterTopo(shape.wrapped, "vertex"), (v) => cast(v)); } catch (_) { return []; }
}

/** 平面面的外法向（面在参数中心处，指向实体外侧） */
function faceNormal(face) {
  try {
    const c = face.center;
    const uv = face.uvCoordinates([c.x, c.y, c.z]);
    const n = face.normalAt(uv[0], uv[1]);
    return vNorm(tupleOf(n));
  } catch (_) { /* 落到下一档 */ }
  try { return vNorm(tupleOf(face.normalAt())); } catch (_) { /* noop */ }
  return [0, 0, 1];
}

/** 圆柱/圆锥面的轴线（照 surface-drivers.readCylinderFace 的做法，但返回纯数据） */
function axisFromCurvedSurface(face) {
  const keep = [];
  const k = (x) => { keep.push(x); return x; };
  try {
    const surf = k(face.surface);
    const type = surf.surfaceType;
    if (type !== "CYLINDRE" && type !== "CONE") return null;
    const prim = k(type === "CYLINDRE" ? surf.wrapped.Cylinder() : surf.wrapped.Cone());
    const loc = k(prim.Location ? prim.Location() : prim.Apex());
    const ax = k(prim.Axis());
    const dir = k(ax.Direction());
    const point = [loc.X(), loc.Y(), loc.Z()];
    const direction = [dir.X(), dir.Y(), dir.Z()];
    if (![...point, ...direction].every(Number.isFinite)) return null;
    const out = { point, direction: vNorm(direction) };
    if (type === "CYLINDRE") {
      const r = prim.Radius();
      if (Number.isFinite(r)) out.radius = r;
    }
    return out;
  } catch (_) { return null; }
  finally { for (const o of keep.reverse()) { try { o.delete?.(); } catch (_) { /* noop */ } } }
}

/**
 * 面 → 参考：平面给 plane，圆柱/圆锥面给 axis，球面给 point。
 * 选中一个面就足够做 coincident / distance / concentric（孔）—— 对应 SW 的「智能配合」。
 */
export function refFromFace(shape, faceId) {
  const face = findFace(shape, faceId);
  if (!face) throw new Error("选中的面已经不存在了，请重新选择");
  let type = "未知";
  try { type = face.geomType; } catch (_) { /* noop */ }
  if (type === "PLANE") {
    const c = face.center;
    return makeRef("plane", { point: tupleOf(c), normal: faceNormal(face) });
  }
  if (type === "CYLINDRE" || type === "CONE") {
    const ax = axisFromCurvedSurface(face);
    if (!ax) throw new Error("这个曲面解析不出轴线（可能是自由曲面）");
    return makeRef("axis", ax);
  }
  if (type === "SPHERE") {
    const c = face.center;
    return makeRef("point", { point: tupleOf(c) });
  }
  throw new Error(`暂不支持用「${type}」面做配合参考`);
}

/** 边 → 参考：直线边给 axis（中点+方向），圆边给 axis（圆心+轴向），其他给两端点中点 */
export function refFromEdge(shape, edgeId) {
  const edge = findEdge(shape, edgeId);
  if (!edge) throw new Error("选中的边已经不存在了，请重新选择");
  let type = "未知";
  try { type = edge.geomType; } catch (_) { /* noop */ }
  if (type === "LINE") {
    const a = tupleOf(edge.startPoint), b = tupleOf(edge.endPoint);
    return makeRef("axis", { point: vScale(vAdd(a, b), 0.5), direction: vSub(b, a) });
  }
  if (type === "CIRCLE") {
    const oc = getOC();
    const ad = new oc.BRepAdaptor_Curve(edge.wrapped);
    try {
      const circ = ad.Circle();
      const loc = circ.Location();
      const dir = circ.Axis().Direction();
      return makeRef("axis", {
        point: [loc.X(), loc.Y(), loc.Z()],
        direction: [dir.X(), dir.Y(), dir.Z()],
        radius: circ.Radius(), curve: "circle",
      });
    } finally { try { ad.delete(); } catch (_) { /* noop */ } }
  }
  const a = tupleOf(edge.startPoint), b = tupleOf(edge.endPoint);
  return makeRef("axis", { point: vScale(vAdd(a, b), 0.5), direction: vSub(b, a) });
}

/** 顶点 → 点参考（可以给 Vertex 包装对象，也可以给 hashCode） */
export function refFromVertex(shape, vertexIdOrVertex) {
  if (vertexIdOrVertex && typeof vertexIdOrVertex === "object" && typeof vertexIdOrVertex.asTuple === "function") {
    return makeRef("point", { point: vertexIdOrVertex.asTuple() });
  }
  const v = findVertex(shape, vertexIdOrVertex);
  if (!v) throw new Error("选中的顶点已经不存在了，请重新选择");
  return makeRef("point", { point: v.asTuple() });
}

/** 自动判定（UI 只给一个拓扑 hashCode 时用）：面 → 边 → 顶点依次试 */
export function refFromTopo(shape, topoId) {
  if (findFace(shape, topoId) || findEdge(shape, topoId) || findVertex(shape, topoId)) {
    if (findFace(shape, topoId)) return refFromFace(shape, topoId);
    if (findEdge(shape, topoId)) return refFromEdge(shape, topoId);
    return refFromVertex(shape, topoId);
  }
  throw new Error("这个对象不是面/边/顶点，不能做配合参考");
}

/**
 * 参考 → 连接器（Onshape mate connector 的最小子集）：{ origin, zAxis }。
 * 以后要给副轴/象限留口子，只加字段，不改求解器。
 */
export function connectorOf(ref) {
  if (ref.kind === "plane") return { origin: ref.point, zAxis: ref.normal };
  if (ref.kind === "axis") return { origin: ref.point, zAxis: ref.direction };
  return { origin: ref.point, zAxis: null };
}

// ---------------------------------------------------------------- 实例几何
const _keep = [];
function keepAlive(...objs) { _keep.push(...objs); if (_keep.length > 600) _keep.splice(0, 200); }

/** 位姿 → OCCT gp_Trsf（行主序 3×4，探针实测 SetValues 就是这个顺序） */
export function trsfFromTransform(transform) {
  const oc = getOC();
  const R = quatToMatrix(normalizeTransform(transform).r);
  const [tx, ty, tz] = normalizeTransform(transform).t;
  const trsf = new oc.gp_Trsf();
  trsf.SetValues(
    R[0], R[1], R[2], tx,
    R[3], R[4], R[5], ty,
    R[6], R[7], R[8], tz,
  );
  keepAlive(trsf);
  return trsf;
}

/**
 * 零件形状 + 位姿 → 实例形状。
 * 坑：replicad 的 translate/rotate **会消费输入**，所以这里必须 clone 后再交给
 * BRepBuilderAPI_Transform（transform 本身不消费 clone 出来的副本以外的任何东西）。
 */
export function shapeAtTransform(shape, transform) {
  if (!shape) throw new Error("没有零件形状可放置");
  const oc = getOC();
  const src = shape.clone ? shape.clone() : shape;
  const trsf = trsfFromTransform(transform);
  const mk = new oc.BRepBuilderAPI_Transform(src.wrapped, trsf, true);
  keepAlive(mk);
  mk.Build();
  if (!mk.IsDone()) throw new Error("实例变换失败");
  const out = cast(mk.Shape());
  keepAlive(out);
  return out;
}

/**
 * 真正复制一份形状（新 TopoDS，不与原对象共享）。
 * 坑：replicad 的 `shape.clone()` 只是**重新包装同一个 TopoDS 句柄**，
 * 布尔运算（intersect/cut/fuse）会消费它 —— 实测用 clone() 做干涉检查后，
 * 原实例形状的体积会变（46727.65 变成 35626.33）。所以任何要进布尔的场合
 * 都必须先过这里（用恒等变换走一遍 BRepBuilderAPI_Transform，得到独立实体）。
 */
export function copyShape(shape) {
  return shapeAtTransform(shape, identityTransform());
}

// 缓存必须按「零件形状对象」分组，不能用 partId：partId（p1/p2…）在每个装配体里都会重号，
// 实测两套样例都用 p1 的时候，上底板拿到了另一套的「底板」几何（体积对不上、还报假干涉）。
const shapeCache = new WeakMap();   // baseShape → Map(位姿键 → 实例形状)
const cacheKey = (tr) => `${tr.t.map((v) => v.toFixed(6)).join(",")}|${tr.r.map((v) => v.toFixed(6)).join(",")}`;

/** 实例形状（带缓存：拖动/爆炸时同一零件只克隆一次） */
export function instanceShape(instance, partShapes, { cache = true } = {}) {
  const base = partShapes instanceof Map ? partShapes.get(instance.partId) : partShapes?.[instance.partId];
  if (!base) throw new Error(`零件 ${instance.partId} 的几何还没加载`);
  const key = cacheKey(instance.transform);
  let bucket = null;
  if (cache) {
    bucket = shapeCache.get(base);
    if (!bucket) { bucket = new Map(); shapeCache.set(base, bucket); }
    if (bucket.has(key)) return bucket.get(key);
  }
  const made = shapeAtTransform(base, instance.transform);
  if (bucket) {
    if (bucket.size > 32) bucket.delete(bucket.keys().next().value);
    bucket.set(key, made);
  }
  return made;
}

export function clearShapeCache() { /* WeakMap 无法遍历，交给 GC；此函数保留为 API 兼容 */ }

/** 全部实例 → [{ instance, shape }]（一次克隆一遍，UI 渲染用） */
export function assemblyShapes(asm, partShapes, opts) {
  return asm.instances.map((instance) => ({ instance, shape: instanceShape(instance, partShapes, opts) }));
}

/** 装配体总包围盒（世界系） */
export function assemblyBounds(asm, partShapes) {
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const { shape } of assemblyShapes(asm, partShapes)) {
    const bb = shape.boundingBox;
    const lo = [bb.center[0] - bb.width / 2, bb.center[1] - bb.height / 2, bb.center[2] - bb.depth / 2];
    const hi = [bb.center[0] + bb.width / 2, bb.center[1] + bb.height / 2, bb.center[2] + bb.depth / 2];
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], lo[i]); max[i] = Math.max(max[i], hi[i]); }
  }
  return { min, max, size: vSub(max, min) };
}

// ---------------------------------------------------------------- 校验
const MATE_REF_RULES = {
  coincident: [["plane", "plane"], ["point", "point"], ["point", "plane"], ["plane", "point"]],
  concentric: [["axis", "axis"]],
  distance: [["plane", "plane"], ["point", "point"], ["point", "plane"], ["plane", "point"]],
  angle: [["plane", "plane"], ["axis", "axis"]],
  parallel: [["plane", "plane"], ["axis", "axis"], ["plane", "axis"], ["axis", "plane"]],
  perpendicular: [["plane", "plane"], ["axis", "axis"], ["plane", "axis"], ["axis", "plane"]],
  lock: [["any", "any"]],
};
export const MATE_TYPES = Object.keys(MATE_REF_RULES);

/** 某种配合 + 一对参考类型 是否合法（UI 径向菜单就是按这个过滤） */
export function refsCompatible(type, kindA, kindB) {
  const rules = MATE_REF_RULES[type];
  if (!rules) return false;
  return rules.some(([x, y]) => (x === "any" || x === kindA) && (y === "any" || y === kindB));
}

/** 该配合在当前参考组合下「名义上」削减多少自由度（用于过定义提示） */
export function nominalDofRemoved(type, kindA, kindB) {
  if (type === "lock") return 6;
  if (type === "coincident") {
    if (kindA === "plane" && kindB === "plane") return 3;
    if (kindA === "point" && kindB === "point") return 3;
    return 1;
  }
  if (type === "concentric") return 4;
  if (type === "distance") return kindA === "plane" && kindB === "plane" ? 3 : 1;
  if (type === "angle") return 1;
  if (type === "parallel") return 2;
  if (type === "perpendicular") return 1;
  return 0;
}

export function validateAssembly(asm) {
  const errors = [];
  if (!asm || asm.v !== ASM_VERSION) errors.push("装配体版本不支持");
  const partIds = new Set((asm?.parts || []).map((p) => p.id));
  const instIds = new Set((asm?.instances || []).map((i) => i.id));
  for (const inst of asm?.instances || []) {
    if (!partIds.has(inst.partId)) errors.push(`实例 ${inst.name}（${inst.id}）引用的零件 ${inst.partId} 不存在`);
  }
  for (const m of asm?.mates || []) {
    if (!MATE_TYPES.includes(m.type)) errors.push(`配合 ${m.id} 的类型 ${m.type} 不认识`);
    for (const side of ["a", "b"]) {
      const s = m[side];
      if (!s?.inst) { errors.push(`配合 ${m.id} 缺少 ${side} 侧实例`); continue; }
      if (!instIds.has(s.inst)) errors.push(`配合 ${m.id} 引用的实例 ${s.inst} 不存在`);
      if (m.type !== "lock" && !s.ref) errors.push(`配合 ${m.id} 的 ${side} 侧缺少几何参考`);
    }
    if (m.type !== "lock" && m.a?.ref && m.b?.ref
      && !refsCompatible(m.type, m.a.ref.kind, m.b.ref.kind)) {
      errors.push(`配合 ${m.id}（${m.type}）不能用在 ${m.a.ref.kind}-${m.b.ref.kind} 参考上`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function cloneAssembly(asm) { return JSON.parse(JSON.stringify(asm)); }
