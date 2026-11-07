/**
 * 基础形体（Box / Cylinder / Sphere / Cone / Torus）与螺旋（弹簧）
 *
 * 来源：对照 Yi3D（Apache-2.0）的特征清单补齐 ——
 * 它的 Primitives 就是这六种，弹簧是 `helix.py` / `samples/spring.py` 里的
 * 「圆截面沿螺旋线扫掠」。这里不改写内核，只用 replicad / OCCT 原生类实现，
 * 每个形体的体积都能对上解析公式（回归测试逐个对账）。
 *
 * 全部实测确认过的 API 事实（探针 probe-helix-primitives / probe-cone3）：
 *   makeBaseBox(w,h,d)   以原点为 XY 中心、**底面在 z=0**（不是角点在原点）
 *   makeCylinder(r,h,loc,dir)  loc 是**底面圆心**
 *   makeSphere(r)        球心在原点
 *   BRepPrimAPI_MakeTorus(ax, R, r)   R=环半径、r=管半径，ax 的 Z 是环轴
 *   **BRepPrimAPI_MakeCone 没被编译进这份 wasm**（`oc.BRepPrimAPI_MakeCone is not a constructor`），
 *   所以圆台/圆锥走「平面轮廓 + BRepPrimAPI_MakeRevol」——
 *   实测体积与 πh(r₁²+r₁r₂+r₂²)/3 完全吻合（2911.2092 对 2911.2092；
 *   r₂=0 的真锥 2094.3951 对 2094.3951）。
 *   注意 `makePolygon(pts)` 返回的**已经是 Face**，不要再套 makeFace（会报
 *   `Cannot pass "false" as a TopoDS_Wire`）。
 *   sketch.revolve() 走不通：同样的梯形轮廓回转出来体积 0、包围盒扁平（实测），别用。
 *   makeHelix(pitch, height, radius, center, dir, lefthand) → Wire，
 *   `.tangentAt(0)` 给出起点切向，用它当截面平面的法向（Yi3D spring.py 的算法）。
 */
import {
  cast, getOC, makeBaseBox, makeCylinder, makeSphere, makeHelix, makePolygon, Plane,
  drawCircle, genericSweep, measureVolume,
} from "replicad";

/** embind 对象要留引用，否则 JS 侧被回收后内核对象失效 */
const _keep = [];
function keepAlive(...objs) {
  _keep.push(...objs);
  while (_keep.length > 600) _keep.splice(0, 200);
}

const num = (v, name) => {
  const x = Number(v);
  if (!Number.isFinite(x)) throw new Error(`${name} 必须是数字（收到 ${JSON.stringify(v)}）`);
  return x;
};
const pos = (v, name, dflt = [0, 0, 0]) => {
  if (v == null) return dflt.slice();
  if (!Array.isArray(v) || v.length !== 3) throw new Error(`${name} 必须是 [x,y,z]`);
  return v.map((k) => num(k, name));
};
const vecOf = (v) => (Array.isArray(v) ? v : [v.x, v.y, v.z]);
function unit(v, name) {
  const a = pos(v, name);
  const L = Math.hypot(a[0], a[1], a[2]);
  if (L < 1e-9) throw new Error(`${name} 不能是零向量`);
  return a.map((k) => k / L);
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 取一个与 dir 垂直的单位向量（用来铺圆台轮廓所在平面） */
export function perpTo(dir) {
  const d = unit(dir, "方向");
  let u = cross([0, 0, 1], d);
  if (Math.hypot(...u) < 1e-6) u = cross([1, 0, 0], d);
  return unit(u, "垂直方向");
}

/**
 * 把「以 +Z 为轴、底面在原点」的标准形体搬到 dir 方向 + at 位置。
 * rotate 会消费原对象，所以先 clone。
 */
export function alignZTo(shape, dir = [0, 0, 1], at = [0, 0, 0]) {
  const d = unit(dir, "方向");
  const p = pos(at, "位置");
  const z = [0, 0, 1];
  const dv = Math.max(-1, Math.min(1, dot(z, d)));
  let out = shape.clone ? shape.clone() : shape;
  if (dv < 1 - 1e-12) {
    const ax = cross(z, d);
    const al = Math.hypot(...ax);
    const ang = (Math.acos(dv) * 180) / Math.PI;
    out = al > 1e-9 ? out.rotate(ang, [0, 0, 0], ax.map((k) => k / al)) : out.rotate(180, [0, 0, 0], [1, 0, 0]);
  }
  if (p[0] || p[1] || p[2]) out = out.translate(p[0], p[1], p[2]);
  return out;
}

/** 圆柱：at = 底面圆心，dir = 轴向 */
export function cylinderSolid({ r, h, at = [0, 0, 0], dir = [0, 0, 1] }) {
  const rr = num(r, "半径"), hh = num(h, "高度");
  if (rr <= 0 || hh <= 0) throw new Error("圆柱的半径和高度都要大于 0");
  return makeCylinder(rr, hh, pos(at, "底面圆心"), unit(dir, "轴向"));
}

/** 长方体：size=[宽(x),深(y),高(z)]，at = **底面中心** */
export function boxSolid({ size, at = [0, 0, 0] }) {
  if (!Array.isArray(size) || size.length !== 3) throw new Error("长方体需要 size:[宽,深,高]");
  const [w, d, h] = size.map((v, i) => num(v, ["宽", "深", "高"][i]));
  if (w <= 0 || d <= 0 || h <= 0) throw new Error("长方体的三个尺寸都要大于 0");
  const b = makeBaseBox(w, d, h);
  const p = pos(at, "底面中心");
  return (p[0] || p[1] || p[2]) ? b.translate(p[0], p[1], p[2]) : b;
}

/** 球：at = 球心 */
export function sphereSolid({ r, at = [0, 0, 0] }) {
  const rr = num(r, "半径");
  if (rr <= 0) throw new Error("球的半径要大于 0");
  const s = makeSphere(rr);
  const p = pos(at, "球心");
  return (p[0] || p[1] || p[2]) ? s.translate(p[0], p[1], p[2]) : s;
}

/** 圆环：R = 环半径，r = 管半径，at = 环心，dir = 环轴 */
export function torusSolid({ R, r, at = [0, 0, 0], dir = [0, 0, 1] }) {
  const RR = num(R, "环半径"), rr = num(r, "管半径");
  if (RR <= 0 || rr <= 0) throw new Error("圆环的两个半径都要大于 0");
  if (rr >= RR) throw new Error("管半径必须小于环半径（否则环心会自交）");
  const oc = getOC();
  const ax = new oc.gp_Ax2(new oc.gp_Pnt(...pos(at, "环心")), new oc.gp_Dir(...unit(dir, "环轴")));
  const mk = new oc.BRepPrimAPI_MakeTorus(ax, RR, rr);
  mk.Build();
  const shp = mk.Shape();
  const out = cast(shp);
  keepAlive(ax, mk, shp);
  return out;
}

/**
 * 圆锥 / 圆台：r1 = 底面半径，r2 = 顶面半径（0 就是真锥），h = 高。
 * 平面轮廓 + MakeRevol（MakeCone 在这个 wasm 里没有）。
 */
export function coneSolid({ r1, r2 = 0, h, at = [0, 0, 0], dir = [0, 0, 1] }) {
  const a = num(r1, "底面半径"), b = num(r2, "顶面半径"), hh = num(h, "高");
  if (a <= 0 || b < 0 || hh <= 0) throw new Error("圆锥的半径要大于等于 0、高要大于 0");
  if (b > a) throw new Error("顶面半径不能大于底面半径（要倒过来就把 dir 反向）");
  const base = pos(at, "底面圆心");
  const d = unit(dir, "轴向");
  const u = perpTo(d);
  const P = (k, hi) => [base[0] + u[0] * k + d[0] * hi, base[1] + u[1] * k + d[1] * hi, base[2] + u[2] * k + d[2] * hi];
  const pts = b > 1e-9
    ? [P(0, 0), P(a, 0), P(b, hh), P(0, hh)]
    : [P(0, 0), P(a, 0), P(0, hh)];
  const face = makePolygon(pts);
  const oc = getOC();
  const ax1 = new oc.gp_Ax1(new oc.gp_Pnt(...base), new oc.gp_Dir(...d));
  const mk = new oc.BRepPrimAPI_MakeRevol(face.wrapped, ax1, 2 * Math.PI, true);
  mk.Build();
  const shp = mk.Shape();
  const out = cast(shp);
  keepAlive(face, ax1, mk, shp);
  return out;
}

/**
 * 螺旋（弹簧）：圆截面沿螺旋线扫掠。
 * R 螺旋半径（中径/2）· wireR 钢丝半径 · pitch 螺距 · turns 圈数
 * dir/at 轴方向与起点（螺旋轴），clockwise 左旋，startAngle 起始相位
 */
export function helixSolid({ R, wireR, pitch, turns, at = [0, 0, 0], dir = [0, 0, 1], clockwise = false, startAngle = 0 }) {
  const RR = num(R, "螺旋半径"), wr = num(wireR, "钢丝半径");
  const pt = num(pitch, "螺距"), tn = num(turns, "圈数");
  if (RR <= 0 || wr <= 0) throw new Error("螺旋半径和钢丝半径都要大于 0");
  if (pt <= 0 || tn <= 0) throw new Error("螺距和圈数都要大于 0");
  if (wr >= RR) throw new Error("钢丝半径必须小于螺旋半径（否则线圈会自交）");
  const height = pt * tn;
  const helix = makeHelix(pt, height, RR, [0, 0, 0], [0, 0, 1], !!clockwise);
  // 起点切向 —— 直接从内核取，别靠手算（左/右手旋向不同，符号很容易写反）
  const start = vecOf(helix.startPoint);
  const t0 = vecOf(helix.tangentAt(0));
  const nrm = unit(t0, "起点切向");
  let xDir = cross([0, 0, 1], nrm);
  if (Math.hypot(...xDir) < 1e-6) xDir = [1, 0, 0];
  const plane = new Plane(start, unit(xDir, "截面 x 轴"), nrm);
  const profile = drawCircle(wr).sketchOnPlane(plane);
  let solid = genericSweep(profile.wire, helix, { forceProfileSpineOthogonality: true });
  const ang = num(startAngle, "起始角") || 0;
  if (ang) solid = solid.rotate(ang, [0, 0, 0], [0, 0, 1]);
  const out = alignZTo(solid, dir, at);
  keepAlive(helix, profile, solid);
  return out;
}

/** 体积（失败返回 0，不抛）—— 校验用 */
export function solidVolume(shape) {
  try { return measureVolume(shape); } catch (_) { return 0; }
}

/** 按脚本里的 spec 造形体的统一入口（replay 与测试共用） */
export function primitiveSolid(op = {}) {
  const kind = String(op.shape || op.kind || "").toLowerCase();
  switch (kind) {
    case "box": return boxSolid(op);
    case "cylinder": return cylinderSolid(op);
    case "sphere": return sphereSolid(op);
    case "cone": return coneSolid(op);
    case "torus": return torusSolid(op);
    default:
      throw new Error(`不认识的形体「${op.shape || op.kind}」（可用 box / cylinder / sphere / cone / torus）`);
  }
}

/** 解析公式（脚本 expect.volume 直接写它，或用它做独立复算） */
export const formulas = {
  box: (w, d, h) => w * d * h,
  cylinder: (r, h) => Math.PI * r * r * h,
  sphere: (r) => (4 / 3) * Math.PI * r ** 3,
  torus: (R, r) => 2 * Math.PI ** 2 * R * r * r,
  cone: (r1, r2, h) => (Math.PI * h / 3) * (r1 * r1 + r1 * r2 + r2 * r2),
  /** 弹簧：截面圆面积 × 螺旋线长度（斜边展开） */
  helix: (wireR, R, pitch, turns) => Math.PI * wireR * wireR * Math.sqrt((2 * Math.PI * R) ** 2 + pitch ** 2) * turns,
};
