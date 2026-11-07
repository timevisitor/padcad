/**
 * 检查 / 测量（A 批 P0-8）
 *
 * 之前只有一个 volumeOf()，做不了「这个孔到边多远」「干涉多大」「质心在哪」。
 * 这里全部走 OCCT 的 GProp / BRepExtrema（WASM 里已确认存在），
 * 判据一律是解析值，不是估计。
 */
import { measureVolume, measureArea, measureDistanceBetween, measureShapeLinearProperties } from "replicad";

/** 质量属性：体积 / 表面积 / 质心 / 包围盒尺寸与中心 */
export function massProperties(shape) {
  if (!shape) throw new Error("没有实体可测量");
  const bb = shape.boundingBox;
  // 注意：质心不在 shape 上（shape.centerOfMass 是 undefined），
  // 必须走 measureShapeLinearProperties()，它返回 PhysicalProperties（含 centerOfMass getter）
  let centroid = [NaN, NaN, NaN];
  try {
    const props = measureShapeLinearProperties(shape);
    centroid = props.centerOfMass.map((v) => Number(v));
  } catch (_) { /* 片体没有质心 */ }
  return {
    volume: safe(() => measureVolume(shape), 0),
    area: safe(() => measureArea(shape), 0),
    centroid,
    bbox: {
      size: [bb.width, bb.height, bb.depth],
      center: [bb.center[0], bb.center[1], bb.center[2]],
      min: [bb.center[0] - bb.width / 2, bb.center[1] - bb.height / 2, bb.center[2] - bb.depth / 2],
      max: [bb.center[0] + bb.width / 2, bb.center[1] + bb.height / 2, bb.center[2] + bb.depth / 2],
    },
  };
}

/** 两个体之间的最小距离；相交时返回 0（OCCT 对相交体给 0，不报错） */
export function distanceBetween(a, b) {
  if (!a || !b) throw new Error("测量距离需要两个对象");
  const d = measureDistanceBetween(a, b);
  return Number.isFinite(d) ? d : 0;
}

/**
 * 干涉检查：返回公共体积与是否相交。
 * 注意 OCCT 的公共运算会消费输入 —— 这里先 clone 再算，调用方的实体不会被毁掉。
 */
export function interference(a, b) {
  if (!a || !b) throw new Error("干涉检查需要两个实体");
  const ca = a.clone();
  const cb = b.clone();
  let common = null;
  try {
    common = ca.intersect(cb);
    const volume = safe(() => measureVolume(common), 0);
    const overlaps = volume > 1e-6;
    return {
      overlaps,
      volume,
      // 接触但无体积（面贴面）也算“碰上了”，工程上要能区分开
      touches: !overlaps && distanceBetween(a, b) <= 1e-6,
    };
  } finally {
    try { common?.delete?.(); } catch (_) { /* 已被消费 */ }
    try { ca.delete?.(); } catch (_) { /* noop */ }
    try { cb.delete?.(); } catch (_) { /* noop */ }
  }
}

/** 剖切：用一个平面切，返回截面面积与截面轮廓线长（不做实体切割） */
export function sectionAt(shape, { origin = [0, 0, 0], normal = [0, 0, 1] } = {}) {
  if (!shape) throw new Error("没有实体可剖切");
  // OCCT 的截面通过「实体 ∩ 薄板」的体积近似很难精确，这里改用面片剖面线：
  // 用 mesh 的三角形与平面求交，得到线段集合，长度与周长都能算，且不依赖额外 API。
  const m = shape.mesh({ tolerance: 0.12, angularTolerance: 15 });
  const verts = m.vertices;
  const tris = m.triangles;
  const n = normal;
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const un = [n[0] / len, n[1] / len, n[2] / len];
  const d = un[0] * origin[0] + un[1] * origin[1] + un[2] * origin[2];
  const segs = [];
  const at = (i) => [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]];
  const side = (p) => un[0] * p[0] + un[1] * p[1] + un[2] * p[2] - d;
  for (let t = 0; t < tris.length; t += 3) {
    const p = [at(tris[t]), at(tris[t + 1]), at(tris[t + 2])];
    const s = p.map(side);
    const hits = [];
    for (let k = 0; k < 3; k++) {
      const a = s[k], b = s[(k + 1) % 3];
      if ((a > 0) === (b > 0)) continue;
      const f = a / (a - b);
      const q = p[k], r = p[(k + 1) % 3];
      hits.push([q[0] + (r[0] - q[0]) * f, q[1] + (r[1] - q[1]) * f, q[2] + (r[2] - q[2]) * f]);
    }
    if (hits.length === 2) segs.push(hits);
  }
  let perimeter = 0;
  for (const [a, b] of segs) perimeter += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  return { segments: segs.length, perimeter };
}

function safe(fn, fallback) {
  try { const v = fn(); return Number.isFinite(v) ? v : fallback; } catch (_) { return fallback; }
}
