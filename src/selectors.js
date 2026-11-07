/**
 * 几何选择器 —— 用「几何意图」代替交互点选的 faceRef / edgeRef
 *
 * 为什么单独一个模块：重放引擎（replay.js）和脚本引擎（model-script.js）都要用它，
 * 放在任何一边都会造成循环 import。
 *
 * 设计纪律（照 Yi3D SKILL.md 的「禁止猜测」）：
 *   命中多个同样合格的候选时**报错**，绝不挑一个给你 —— 静默用错的面/边
 *   会产生看起来成功、实际错误的几何，比报错危险得多。
 */
import * as OPS from "./ops.js";
import { DistanceQuery } from "replicad";

const DEG = Math.PI / 180;
const num = (v, name) => {
  const x = Number(v);
  if (!Number.isFinite(x)) throw new Error(`${name} 必须是数字（收到 ${JSON.stringify(v)}）`);
  return x;
};
const vec3 = (v, name) => {
  if (!Array.isArray(v) || v.length !== 3) throw new Error(`${name} 必须是 [x,y,z]`);
  return v.map((k) => num(k, name));
};
const unit = (v, name) => {
  const a = vec3(v, name);
  const L = Math.hypot(a[0], a[1], a[2]);
  if (L < 1e-9) throw new Error(`${name} 不能是零向量`);
  return a.map((k) => k / L);
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const fmt = (p) => `[${p.map((v) => (+v).toFixed(2)).join(", ")}]`;

/**
 * 面选择器
 *   { at:[x,y,z], normal:[nx,ny,nz], angleTol:5, type:"PLANE", uniqueTol:0.25 }
 *   at   参考点（必填）
 *   normal 只要法向与它夹角在 angleTol 内的面（给了它，排序用「到该平面的垂距」，
 *          大平面上比「到面中心距离」靠谱）
 *   type  只要这种面类型（OCCT 的 geomType：PLANE / CYLINDRE / CONE / TORUS）
 * @returns faceId
 */
export function resolveFaceSelector(shape, sel = {}) {
  if (!shape) throw new Error("当前没有实体，没法按几何找面");
  if (!sel || typeof sel !== "object" || Array.isArray(sel)) throw new Error("面选择器必须是对象");
  const at = vec3(sel.at, "面选择器的 at");
  const nWant = sel.normal != null ? unit(sel.normal, "面选择器的 normal") : null;
  const angleTol = sel.angleTol != null ? num(sel.angleTol, "angleTol") : 5;
  const cosMin = Math.cos(Math.min(89.9, Math.max(0, angleTol)) * DEG);
  const want = sel.type ? String(sel.type).toUpperCase() : null;
  const cands = [];
  for (const f of shape.faces) {
    let c = null, type = null, n = null;
    try { const k = f.center; c = [k.x, k.y, k.z]; } catch (_) { continue; }
    try { type = f.geomType || null; } catch (_) { type = null; }
    if (want && String(type).toUpperCase() !== want) continue;
    try { n = OPS.normalOf(f); } catch (_) { n = null; }
    if (nWant && (!n || dot(n, nWant) < cosMin)) continue;
    const rel = [c[0] - at[0], c[1] - at[1], c[2] - at[2]];
    /*
     * 两级排序（踩过的坑）：
     *   ① 沿法向的垂距 —— 决定「是不是这个高度的那个面」。
     *      只按「到面中心的距离」排，大零件上会挑到隔壁那个面。
     *   ② 面内距离 —— 同一高度上若有共面的多张面（被切开/分离的），
     *      用参考点在面内的偏移区分。只按①排的话这些面完全并列，永远选不出来。
     * 两级都必须唯一，否则报错（绝不猜）。
     */
    const along = nWant ? Math.abs(dot(rel, nWant)) : dist(c, at);
    const perp = nWant ? Math.hypot(
      rel[0] - dot(rel, nWant) * nWant[0],
      rel[1] - dot(rel, nWant) * nWant[1],
      rel[2] - dot(rel, nWant) * nWant[2],
    ) : 0;
    cands.push({ faceId: f.hashCode, center: c, normal: n, type, along, perp });
  }
  if (!cands.length) {
    throw new Error(`找不到符合条件的面（参考点 ${fmt(at)}${nWant ? `，法向 ${fmt(nWant)}` : ""}${want ? `，类型 ${want}` : ""}）`);
  }
  const uniqueTol = sel.uniqueTol != null ? num(sel.uniqueTol, "uniqueTol") : 0.25;
  // ① 先按「沿法向的垂距」筛出同一高度的那批
  cands.sort((a, b) => a.along - b.along);
  const sameLevel = cands.filter((c) => c.along - cands[0].along < uniqueTol);
  // ② 再用「面内距离」在其中定位置
  sameLevel.sort((a, b) => a.perp - b.perp);
  if (sameLevel.length > 1 && sameLevel[1].perp - sameLevel[0].perp < uniqueTol) {
    throw new Error(`有多个面同时符合选择条件（中心 ${fmt(sameLevel[0].center)} 与 ${fmt(sameLevel[1].center)}），`
      + "请把 at 指得更明确，或加 normal 限定");
  }
  const best = sameLevel[0];
  if (sameLevel.length > 1 && cands.some((c) => !sameLevel.includes(c) && c.along - best.along < uniqueTol)) {
    throw new Error(`有多个面同时符合选择条件（含不同高度的候选，最近的是 ${fmt(best.center)}），请把 at 指得更明确`);
  }
  return best.faceId;
}

/**
 * 棱边选择器 —— 返回一组**边中点**（内核的圆角/倒角/找边都按中点走）
 *   { at:[x,y,z], dir:[dx,dy,dz], of:<面选择器>, closed:true|false, all:false, uniqueTol:0.5 }
 *   at     按「离它最近」排序；不给 at 就必须给 all:true 或 of
 *   dir    只要与它平行的直线边（|点积| > 0.999）
 *   of     只要落在某个面上的边（用内核算的真实 DistanceQuery，不靠 uv 猜）
 *   closed 只要闭合边（孔口圆边）或只要非闭合边
 *   all    true = 全部命中；false = 只返回最近的一条（同样近就报错）
 * @returns 中点数[[x,y,z], ...]
 */
export function resolveEdgesSelector(shape, sel = {}) {
  if (!shape) throw new Error("当前没有实体，没法按几何找边");
  if (!sel || typeof sel !== "object" || Array.isArray(sel)) throw new Error("边选择器必须是对象");
  const at = sel.at != null ? vec3(sel.at, "边选择器的 at") : null;
  const dir = sel.dir != null ? unit(sel.dir, "边选择器的 dir") : null;
  const all = !!sel.all;
  if (!at && !all && !sel.of) throw new Error("边选择器要么给 at（找最近一条），要么给 all:true（全部），要么给 of（某个面上的边）");
  const faces = sel.of ? [OPS.findFace(shape, resolveFaceSelector(shape, sel.of))] : null;

  const out = [];
  for (const e of shape.edges) {
    if (sel.closed === true && !e.isClosed) continue;
    if (sel.closed === false && e.isClosed) continue;
    if (dir) {
      if (!OPS.edgeIsStraight(e)) continue;
      const t = OPS.edgeTangentAt(e, 0.5);
      if (!t || Math.abs(dot(t, dir)) < 0.999) continue;
    }
    if (faces) {
      const q = new DistanceQuery(e);
      let on = false;
      try { on = faces.some((f) => { try { return q.distanceTo(f) < 1e-6; } catch (_) { return false; } }); }
      finally { try { q.delete(); } catch (_) {} }
      if (!on) continue;
    }
    const mid = OPS.edgeMidPoint(e);
    if (!mid) continue;
    out.push({ mid, d: at ? dist(mid, at) : 0 });
  }
  if (!out.length) throw new Error("找不到符合条件的棱边（at/dir/of/closed 是不是卡得太严了）");
  out.sort((a, b) => a.d - b.d);
  if (all) return out.map((o) => o.mid);
  const uniqueTol = sel.uniqueTol != null ? num(sel.uniqueTol, "uniqueTol") : 0.5;
  if (out.length > 1 && out[1].d - out[0].d < uniqueTol) {
    throw new Error(`有两条边同样符合条件（中点 ${fmt(out[0].mid)} 与 ${fmt(out[1].mid)}），`
      + "请把 at 指得更贴近其中一条，或用 dir/of 再限定");
  }
  return [out[0].mid];
}

/** 面选择器 → 面的几何信息（脚本报告里用） */
export function describeFace(shape, faceId) {
  if (faceId == null) return null;
  const f = OPS.findFace(shape, faceId);
  if (!f) return null;
  let c = null, type = null;
  try { const k = f.center; c = [+k.x.toFixed(4), +k.y.toFixed(4), +k.z.toFixed(4)]; } catch (_) {}
  try { type = f.geomType; } catch (_) {}
  return { faceId, center: c, type, normal: OPS.normalOf(f) };
}
