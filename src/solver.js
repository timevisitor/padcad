/**
 * 2D 草图约束求解器
 *
 * 参考 jsketcher 的做法（Levenberg-Marquardt + 阻尼最小二乘），
 * 但用**数值 Jacobian** 而不是手写解析梯度：
 * 参数规模很小（典型几十个自由度），数值微分的额外开销可以忽略，
 * 而"给每种约束手写解析梯度"恰恰是这类代码最容易出错的地方 ——
 * 梯度写错了求解器不会报错，只会静默地收敛到错误位置。
 *
 * 模型：草图 = 一组自由度(Param) + 一组约束(Constraint)。
 * 每个约束给出一个误差标量（要让它趋近 0），求解器最小化 0.5·Σerror²。
 *
 * 欠约束（方程少于未知数）是正常的 —— 用户不可能一开始就把尺寸标全，
 * 这时解法是无穷多组，求解器只保证"往最近的合法位置走"，不会乱跳。
 * 过约束/自相矛盾（比如同时要求 w=20 和 w=30）会检测出来并报错。
 */

/** 一个可求解的自由度：用访问器包住实体里的某个数字 */
export class Param {
  constructor(get, set, name) {
    this.get = get;
    this.set = set;
    this.name = name;
  }
  get value() { return this.get(); }
  set value(v) { this.set(v); }
}

/** 点引用：两个自由度组成一个点 */
export class PointRef {
  constructor(x, y) { this.x = x; this.y = y; }
  get vx() { return this.x.value; }
  get vy() { return this.y.value; }
}

/** 把草图实体展开成自由度列表 */
export function collectParams(entities) {
  const params = [];
  const add = (get, set, name) => params.push(new Param(get, set, name));

  entities.forEach((e, i) => {
    /*
     * ⚠ 引用来的图元（e.ref === true）是**从模型投影过来的参考**，不是用户画的，
     * 不参与求解 —— 必须跳过。
     * 不跳的话，一条 48 点采样的引用折线会塞进 96 个自由度，
     * 屏幕上的"剩余自由度"会变成几百（用户实测看到 458），
     * 而且求解器会去动这些参考点，把投影形状拉变形。
     */
    if (e.ref) return;
    if (e.kind === "rect") {
      add(() => e.c[0], (v) => { e.c[0] = v; }, `#${i}.cx`);
      add(() => e.c[1], (v) => { e.c[1] = v; }, `#${i}.cy`);
      add(() => e.w, (v) => { e.w = v; }, `#${i}.w`);
      add(() => e.h, (v) => { e.h = v; }, `#${i}.h`);
    } else if (e.kind === "circle") {
      add(() => e.c[0], (v) => { e.c[0] = v; }, `#${i}.cx`);
      add(() => e.c[1], (v) => { e.c[1] = v; }, `#${i}.cy`);
      add(() => e.r, (v) => { e.r = v; }, `#${i}.r`);
    } else if (e.kind === "polyline") {
      e.pts.forEach((_, k) => {
        add(() => e.pts[k][0], (v) => { e.pts[k][0] = v; }, `#${i}.p${k}.x`);
        add(() => e.pts[k][1], (v) => { e.pts[k][1] = v; }, `#${i}.p${k}.y`);
      });
    }
  });
  return params;
}

/** 取一个实体的具名点（矩形角点、圆心、折线顶点） */
export function pointOf(entities, index, which) {
  const e = entities[index];
  if (!e) return null;
  // 引用图元是常量参考，不能当成自由度（否则约束会去动它）
  if (e.ref) return null;
  const mk = (gx, gy, sx, sy, tag) => new PointRef(
    new Param(gx, sx, `#${index}.${tag}.x`),
    new Param(gy, sy, `#${index}.${tag}.y`),
  );
  if (e.kind === "rect") {
    const hw = () => e.w / 2, hh = () => e.h / 2;
    const map = {
      center: [() => e.c[0], () => e.c[1]],
      bl: [() => e.c[0] - hw(), () => e.c[1] - hh()],
      br: [() => e.c[0] + hw(), () => e.c[1] - hh()],
      tr: [() => e.c[0] + hw(), () => e.c[1] + hh()],
      tl: [() => e.c[0] - hw(), () => e.c[1] + hh()],
    };
    const m = map[which];
    if (!m) return null;
    return mk(m[0], m[1],
      (v) => { e.c[0] += v - m[0](); },   // 简化：角点移动直接平移矩形中心
      (v) => { e.c[1] += v - m[1](); }, which);
  }
  if (e.kind === "circle" && which === "center") {
    return mk(() => e.c[0], () => e.c[1], (v) => { e.c[0] = v; }, (v) => { e.c[1] = v; }, "center");
  }
  if (e.kind === "polyline") {
    const k = parseInt(String(which).replace("p", ""), 10);
    if (!Number.isFinite(k) || !e.pts[k]) return null;
    return mk(() => e.pts[k][0], () => e.pts[k][1],
      (v) => { e.pts[k][0] = v; }, (v) => { e.pts[k][1] = v; }, `p${k}`);
  }
  return null;
}

// ---------------------------------------------------------------- 约束
export class Constraint {
  constructor(params, label) { this.params = params; this._label = label; }
  error() { throw new Error("约束未实现 error()"); }
  get label() { return this._label; }
}

/** 两点距离 = value */
export class Distance extends Constraint {
  constructor(p1, p2, value) { super([p1.x, p1.y, p2.x, p2.y], "距离"); this.p1 = p1; this.p2 = p2; this.value = value; }
  error() { return Math.hypot(this.p1.vx - this.p2.vx, this.p1.vy - this.p2.vy) - this.value; }
}

/** 两点水平（y 相等） */
export class Horizontal extends Constraint {
  constructor(p1, p2) { super([p1.y, p2.y], "水平"); this.p1 = p1; this.p2 = p2; }
  error() { return this.p1.vy - this.p2.vy; }
}

/** 两点竖直（x 相等） */
export class Vertical extends Constraint {
  constructor(p1, p2) { super([p1.x, p2.x], "竖直"); this.p1 = p1; this.p2 = p2; }
  error() { return this.p1.vx - this.p2.vx; }
}

/** 单一自由度 = 值（半径、宽、高……） */
export class Fixed extends Constraint {
  constructor(param, value, label = "尺寸") { super([param], label); this.param = param; this.value = value; }
  error() { return this.param.value - this.value; }
}

/** 两个自由度相等 */
export class Equal extends Constraint {
  constructor(a, b, label = "相等") { super([a, b], label); this.a = a; this.b = b; }
  error() { return this.a.value - this.b.value; }
}

/** 点在给定坐标上（把某个自由度钉住） */
export class PointFixed extends Constraint {
  constructor(p, x, y, label = "固定点") { super([p.x, p.y], label); this.p = p; this.x = x; this.y = y; }
  error() { return Math.hypot(this.p.vx - this.x, this.p.vy - this.y); }
}

/** 圆与直线相切：圆心到直线距离 = 半径 */
export class Tangent extends Constraint {
  constructor(circleCenter, radiusParam, p1, p2) {
    super([circleCenter.x, circleCenter.y, radiusParam, p1.x, p1.y, p2.x, p2.y], "相切");
    this.c = circleCenter; this.r = radiusParam; this.p1 = p1; this.p2 = p2;
  }
  error() {
    const dx = this.p2.vx - this.p1.vx, dy = this.p2.vy - this.p1.vy;
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) return 0;
    // 点到直线距离
    const d = Math.abs((this.c.vx - this.p1.vx) * dy - (this.c.vy - this.p1.vy) * dx) / L;
    return d - this.r.value;
  }
}

/**
 * 两条线的夹角 = 目标角度（弧度）
 *
 * 用叉积/点积构造，避免 atan2 的跳变：把第二条线的方向绕公共夹角旋转，看落点偏差。
 * 更稳的写法是让 **单位方向向量的夹角** 满足目标：
 *   sin(θ)·(u1·u2) − cos(θ)·|u1×u2| = 0   （θ 为目标夹角）
 * 但是这个式子在 θ=0 附近梯度退化，所以改用「旋转后的方向与实际方向之差」。
 */
const wrapLineAngle = angle => Math.atan2(Math.sin(2 * angle), Math.cos(2 * angle)) / 2;
const angleOfVectors = (ax, ay, bx, by) => Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
function nearestAngleTarget(current, target) {
  return Math.abs(wrapLineAngle(current - target)) <= Math.abs(wrapLineAngle(current + target)) ? target : -target;
}

export class Angle extends Constraint {
  constructor(p1, p2, p3, p4, valueRad, label = "角度") {
    super([p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, p4.x, p4.y], label);
    this.p1 = p1; this.p2 = p2; this.p3 = p3; this.p4 = p4;
    this.value = valueRad;
    const dx1 = p2.vx - p1.vx, dy1 = p2.vy - p1.vy;
    const dx2 = p4.vx - p3.vx, dy2 = p4.vy - p3.vy;
    this.target = nearestAngleTarget(angleOfVectors(dx1, dy1, dx2, dy2), valueRad);
    this.scale = Math.max(1, Math.min(Math.hypot(dx1, dy1), Math.hypot(dx2, dy2)) / 2);
  }
  error() {
    const dx1 = this.p2.vx - this.p1.vx, dy1 = this.p2.vy - this.p1.vy;
    const dx2 = this.p4.vx - this.p3.vx, dy2 = this.p4.vy - this.p3.vy;
    const L1 = Math.hypot(dx1, dy1), L2 = Math.hypot(dx2, dy2);
    if (L1 < 1e-9 || L2 < 1e-9) return 0;
    // 无向直线的夹角允许正负两侧。固定初始最近分支，避免确认已有尺寸时翻转图形。
    // 比例固定，不能靠把线缩短来减小角度残差。
    return wrapLineAngle(angleOfVectors(dx1, dy1, dx2, dy2) - this.target) * this.scale;
  }
}

/** 两条线平行：单位方向向量的叉积 = 0 */
export class Parallel extends Constraint {
  constructor(p1, p2, p3, p4) { super([p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, p4.x, p4.y], "平行"); this.p1 = p1; this.p2 = p2; this.p3 = p3; this.p4 = p4; }
  error() {
    const dx1 = this.p2.vx - this.p1.vx, dy1 = this.p2.vy - this.p1.vy;
    const dx2 = this.p4.vx - this.p3.vx, dy2 = this.p4.vy - this.p3.vy;
    const L1 = Math.hypot(dx1, dy1), L2 = Math.hypot(dx2, dy2);
    if (L1 < 1e-9 || L2 < 1e-9) return 0;
    return (dx1 / L1) * (dy2 / L2) - (dy1 / L1) * (dx2 / L2);
  }
}

/** 两条线垂直：单位方向向量的点积 = 0 */
export class Perpendicular extends Constraint {
  constructor(p1, p2, p3, p4) { super([p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, p4.x, p4.y], "垂直"); this.p1 = p1; this.p2 = p2; this.p3 = p3; this.p4 = p4; }
  error() {
    const dx1 = this.p2.vx - this.p1.vx, dy1 = this.p2.vy - this.p1.vy;
    const dx2 = this.p4.vx - this.p3.vx, dy2 = this.p4.vy - this.p3.vy;
    const L1 = Math.hypot(dx1, dy1), L2 = Math.hypot(dx2, dy2);
    if (L1 < 1e-9 || L2 < 1e-9) return 0;
    return (dx1 / L1) * (dx2 / L2) + (dy1 / L1) * (dy2 / L2);
  }
}

/** 点 P 落在 P1、P2 的中点 */
export class Midpoint extends Constraint {
  constructor(p, p1, p2) { super([p.x, p.y, p1.x, p1.y, p2.x, p2.y], "中点"); this.p = p; this.p1 = p1; this.p2 = p2; }
  error() {
    const mx = (this.p1.vx + this.p2.vx) / 2, my = (this.p1.vy + this.p2.vy) / 2;
    return Math.hypot(this.p.vx - mx, this.p.vy - my);
  }
}

/**
 * 两点关于一条直线对称
 * 判据（等价于"镜面反射"，无需开方，数值上更稳）：
 *   ① 两点连线垂直于对称轴
 *   ② 两点中点在对称轴上
 */
export class Symmetric extends Constraint {
  constructor(a, b, p1, p2) { super([a.x, a.y, b.x, b.y, p1.x, p1.y, p2.x, p2.y], "对称"); this.a = a; this.b = b; this.p1 = p1; this.p2 = p2; }
  error() {
    const ax = this.p2.vx - this.p1.vx, ay = this.p2.vy - this.p1.vy;
    const L = Math.hypot(ax, ay);
    if (L < 1e-9) return 0;
    const ux = ax / L, uy = ay / L;
    // 连线方向
    const vx = this.b.vx - this.a.vx, vy = this.b.vy - this.a.vy;
    // ① 垂直于轴：v 在轴方向上的投影应为 0
    const along = vx * ux + vy * uy;
    // ② 中点到轴的距离应为 0
    const mx = (this.a.vx + this.b.vx) / 2 - this.p1.vx;
    const my = (this.a.vy + this.b.vy) / 2 - this.p1.vy;
    const perp = mx * uy - my * ux;
    return Math.hypot(along, perp);
  }
}

/** 两个点重合（点到点重合） */
export class Coincident extends Constraint {
  constructor(a, b) { super([a.x, a.y, b.x, b.y], "重合"); this.a = a; this.b = b; }
  error() { return Math.hypot(this.a.vx - this.b.vx, this.a.vy - this.b.vy); }
}

/** 点到固定点（常量坐标）的距离 = value —— 用于标注"到模型投影点"的尺寸 */
export class DistanceToFixedPoint extends Constraint {
  constructor(p, fx, fy, value, label = "距离") {
    super([p.x, p.y], label);
    this.p = p; this.fx = fx; this.fy = fy; this.value = value;
  }
  error() { return Math.hypot(this.p.vx - this.fx, this.p.vy - this.fy) - this.value; }
}

/**
 * 点到固定直线（由两个常量点定义）的距离 = value。
 *
 * 用途：草图的尺寸要标注到**模型上的边**（比如"这个孔中心离那条棱 20mm"）。
 * 那条棱在草图平面里的投影是一条**常量直线** —— 它不参与求解，
 * 所以直接把它当固定参考，只让草图的点动。
 */
export class DistanceToFixedLine extends Constraint {
  constructor(p, a, b, value, label = "到参考线") {
    super([p.x, p.y], label);
    this.p = p;
    this.ax = a[0]; this.ay = a[1];
    this.bx = b[0]; this.by = b[1];
    this.value = value;
  }
  error() {
    const dx = this.bx - this.ax, dy = this.by - this.ay;
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) return 0;
    // 点到无限长直线的距离（绝对值），再减去目标值
    const d = Math.abs((this.p.vx - this.ax) * dy - (this.p.vy - this.ay) * dx) / L;
    return d - this.value;
  }
}

/**
 * 点到「由两个 PointRef 定义的线段所在直线」的距离 = value。
 *
 * 与 DistanceToFixedLine 的区别：那条参考线是**常量**（模型投影来的，不会动），
 * 这里两个端点都是**自由度**（草图自己的线，求解时会动）。
 * 用途：标注两条草图线之间的距离（SolidWorks 的"线距"就是取一条线的端点到另一条线）。
 */
export class DistanceToLine extends Constraint {
  constructor(p, a, b, value, label = "线距") {
    super([p.x, p.y, a.x, a.y, b.x, b.y], label);
    this.p = p; this.a = a; this.b = b; this.value = value;
  }
  error() {
    const dx = this.b.vx - this.a.vx, dy = this.b.vy - this.a.vy;
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) return 0;
    const d = Math.abs((this.p.vx - this.a.vx) * dy - (this.p.vy - this.a.vy) * dx) / L;
    return d - this.value;
  }
}

/** 两条线的夹角，其中一条是常量参考线（模型投影来的） */
export class AngleToFixedLine extends Constraint {
  constructor(p1, p2, a, b, valueRad, label = "角度") {
    super([p1.x, p1.y, p2.x, p2.y], label);
    this.p1 = p1; this.p2 = p2;
    this.ax = a[0]; this.ay = a[1];
    this.bx = b[0]; this.by = b[1];
    this.value = valueRad;
    const dx = p2.vx - p1.vx, dy = p2.vy - p1.vy;
    this.target = nearestAngleTarget(angleOfVectors(dx, dy, this.bx - this.ax, this.by - this.ay), valueRad);
    this.scale = Math.max(1, Math.hypot(dx, dy) / 2);
  }
  error() {
    const dx1 = this.p2.vx - this.p1.vx, dy1 = this.p2.vy - this.p1.vy;
    const L1 = Math.hypot(dx1, dy1);
    const dx2 = this.bx - this.ax, dy2 = this.by - this.ay;
    const L2 = Math.hypot(dx2, dy2);
    if (L1 < 1e-9 || L2 < 1e-9) return 0;
    return wrapLineAngle(angleOfVectors(dx1, dy1, dx2, dy2) - this.target) * this.scale;
  }
}

/** 一组参数各自钉死在给定值上（"固定"整个元素用） */
export class MultiFixed extends Constraint {
  constructor(params, values, label = "固定") { super(params, label); this.values = values; }
  error() {
    let s = 0;
    for (let i = 0; i < this.params.length; i++) {
      const d = this.params[i].value - this.values[i];
      s += d * d;
    }
    return Math.sqrt(s);
  }
}

// ---------------------------------------------------------------- 可序列化的约束描述
/**
 * 约束要能存进历史、参与参数化重放，所以不能直接存对象引用 ——
 * 这里用「实体下标 + 点数/参数名」的纯数据来描述，用时再还原成 Constraint 对象。
 *
 * 例：{ type: "fixed", e: 0, k: "w", value: 20 }
 *     { type: "distance", a: { e: 0, p: "p0" }, b: { e: 0, p: "p1" }, value: 30 }
 */
export function paramName(e, k) { return `#${e}.${k}`; }

/**
 * 把「线元素引用」{e, seg} 解析成两个端点 PointRef。
 * 线不是一个独立实体，而是矩形/折线的一条边，所以这里要展开。
 * （与 elements.js 的 lineEndpoints 保持同一套命名：矩形 bl/br/tr/tl、折线 p0/p1/...）
 */
export function lineRefPts(entities, ref) {
  const e = entities[ref?.e];
  if (!e || e.ref || !Number.isInteger(ref.seg)) return null;
  const pt = (p) => pointOf(entities, ref.e, p);
  if (e.kind === "rect") {
    const names = [["bl", "br"], ["br", "tr"], ["tr", "tl"], ["tl", "bl"]];
    const k = ((ref.seg % 4) + 4) % 4;
    return [pt(names[k][0]), pt(names[k][1])];
  }
  if (e.kind === "polyline") {
    const n = e.closed ? e.pts.length : e.pts.length - 1;
    if (ref.seg < 0 || ref.seg >= n) return null;
    return [pt(`p${ref.seg}`), pt(`p${(ref.seg + 1) % e.pts.length}`)];
  }
  return null;
}

/** 把可序列化描述还原成 Constraint 对象 */
export function buildConstraint(entities, spec) {
  if (!spec || typeof spec !== "object") return null;
  const pt = (ref) => {
    if (!ref) return null;
    if (ref.e === null && Array.isArray(ref.at) && ref.at.length === 2 && ref.at.every(Number.isFinite)) {
      return new PointRef(new Param(() => ref.at[0], () => {}, "reference.x"), new Param(() => ref.at[1], () => {}, "reference.y"));
    }
    return pointOf(entities, ref.e, ref.p);
  };
  const lin = (ref) => lineRefPts(entities, ref);
  const par = (ref, fn) => new Param(() => fn(), () => {}, paramName(ref.e, ref.k));

  switch (spec.type) {
    case "fixed": {
      // 尺寸：把实体的某个参数钉在 value 上
      const e = entities[spec.e];
      if (!e) return null;
      const getters = {
        w: () => e.w, h: () => e.h, r: () => e.r,
        cx: () => e.c?.[0], cy: () => e.c?.[1],
      };
      const setters = {
        w: (v) => { e.w = v; }, h: (v) => { e.h = v; }, r: (v) => { e.r = v; },
        cx: (v) => { e.c[0] = v; }, cy: (v) => { e.c[1] = v; },
      };
      const g = getters[spec.k], s = setters[spec.k];
      if (!g || !s) return null;
      return new Fixed(new Param(g, s, paramName(spec.e, spec.k)), spec.value, spec.label || "尺寸");
    }
    case "distance": {
      const a = pt(spec.a), b = pt(spec.b);
      if (!a || !b) return null;
      return new Distance(a, b, spec.value);
    }
    case "horizontal": {
      const a = pt(spec.a), b = pt(spec.b);
      return a && b ? new Horizontal(a, b) : null;
    }
    case "vertical": {
      const a = pt(spec.a), b = pt(spec.b);
      return a && b ? new Vertical(a, b) : null;
    }
    case "fixedPoint": {
      const p = pt(spec.p);
      return p ? new PointFixed(p, spec.x, spec.y, spec.label || "固定点") : null;
    }
    case "equal": {
      // 两个实体的同名参数相等（比如两圆同半径）
      const ea = entities[spec.e], eb = entities[spec.f];
      if (!ea || !eb) return null;
      const gs = { r: (x) => x.r, w: (x) => x.w, h: (x) => x.h };
      const ss = { r: (x, v) => { x.r = v; }, w: (x, v) => { x.w = v; }, h: (x, v) => { x.h = v; } };
      const g = gs[spec.k], s = ss[spec.k];
      if (!g || !s) return null;
      return new Equal(
        new Param(() => g(ea), (v) => s(ea, v), paramName(spec.e, spec.k)),
        new Param(() => g(eb), (v) => s(eb, v), paramName(spec.f, spec.k)),
        spec.label || "相等",
      );
    }
    case "angle": {
      const l1 = lin(spec.l1), l2 = lin(spec.l2);
      if (!l1 || !l2) return null;
      return new Angle(l1[0], l1[1], l2[0], l2[1], (spec.value * Math.PI) / 180, spec.label || "角度");
    }
    case "parallel": {
      const l1 = lin(spec.l1), l2 = lin(spec.l2);
      if (!l1 || !l2) return null;
      return new Parallel(l1[0], l1[1], l2[0], l2[1]);
    }
    case "perpendicular": {
      const l1 = lin(spec.l1), l2 = lin(spec.l2);
      if (!l1 || !l2) return null;
      return new Perpendicular(l1[0], l1[1], l2[0], l2[1]);
    }
    case "midpoint": {
      const p = pt(spec.p), l = lin(spec.l);
      if (!p || !l) return null;
      return new Midpoint(p, l[0], l[1]);
    }
    case "symmetric": {
      const a = pt(spec.a), b = pt(spec.b), l = lin(spec.l);
      if (!a || !b || !l) return null;
      return new Symmetric(a, b, l[0], l[1]);
    }
    // ---- 标注到「模型投影」上的固定参考几何（这些参考不参与求解，只当常量）----
    case "distToFixedPoint": {
      const p = pt(spec.p);
      if (!p || !Array.isArray(spec.at)) return null;
      return new DistanceToFixedPoint(p, spec.at[0], spec.at[1], spec.value, spec.label || "距离");
    }
    case "distToFixedLine": {
      const p = pt(spec.p);
      if (!p || !Array.isArray(spec.line) || spec.line.length < 2) return null;
      return new DistanceToFixedLine(p, spec.line[0], spec.line[1], spec.value, spec.label || "到参考线");
    }
    case "angleToFixedLine": {
      const l = lin(spec.l);
      if (!l || !Array.isArray(spec.ref) || spec.ref.length < 2) return null;
      return new AngleToFixedLine(l[0], l[1], spec.ref[0], spec.ref[1],
        (spec.value * Math.PI) / 180, spec.label || "角度");
    }
    case "pointToLine": {
      // 点到「另一条线」的距离。线可能是草图线（会动）也可能是引用线（常量）。
      const p = pt(spec.p);
      if (!p) return null;
      const isConst = (r) => r && r.e === null && Array.isArray(r.at);
      if (isConst(spec.l1) && isConst(spec.l2)) {
        // 两边都是常量 → 退化成"点到固定直线"（引用线的场景）
        return new DistanceToFixedLine(p, spec.l1.at, spec.l2.at, spec.value, spec.label || "线距");
      }
      const a = pt(spec.l1), b = pt(spec.l2);
      if (!a || !b) return null;
      return new DistanceToLine(p, a, b, spec.value, spec.label || "线距");
    }
    case "coincident": {
      const a = pt(spec.a), b = pt(spec.b);
      if (!a || !b) return null;
      return new Coincident(a, b);
    }
    case "tangent": {
      const e = entities[spec.e];
      if (!e || e.kind !== "circle") return null;
      const l = lin(spec.l);
      if (!l) return null;
      const r = new Param(() => e.r, (v) => { e.r = v; }, paramName(spec.e, "r"));
      const c = pt({ e: spec.e, p: "center" });
      if (!c) return null;
      return new Tangent(c, r, l[0], l[1]);
    }
    case "fix": {
      // 固定整个元素：把它的每个自由度都钉在当前值上
      // （SolidWorks 的"固定"就是这么做的 —— 元素整体不动，但仍然可以只读地看尺寸）
      //
      // 关键：值必须在**添加约束那一刻**快照下来（spec.at），不能每次求解时现取 ——
      // 否则"先把元素拖走再求解"会把新位置当成目标，等于没固定（实测踩到）。
      const e = entities[spec.e];
      if (!e) return null;
      const snap = spec.at || null;
      const params = [];
      if (e.kind === "rect") {
        params.push(new Param(() => e.c[0], (v) => { e.c[0] = v; }, paramName(spec.e, "cx")));
        params.push(new Param(() => e.c[1], (v) => { e.c[1] = v; }, paramName(spec.e, "cy")));
        params.push(new Param(() => e.w, (v) => { e.w = v; }, paramName(spec.e, "w")));
        params.push(new Param(() => e.h, (v) => { e.h = v; }, paramName(spec.e, "h")));
        return new MultiFixed(params, snap || [e.c[0], e.c[1], e.w, e.h]);
      }
      if (e.kind === "circle") {
        params.push(new Param(() => e.c[0], (v) => { e.c[0] = v; }, paramName(spec.e, "cx")));
        params.push(new Param(() => e.c[1], (v) => { e.c[1] = v; }, paramName(spec.e, "cy")));
        params.push(new Param(() => e.r, (v) => { e.r = v; }, paramName(spec.e, "r")));
        return new MultiFixed(params, snap || [e.c[0], e.c[1], e.r]);
      }
      if (e.kind === "polyline") {
        const vals = [];
        e.pts.forEach((_, k) => {
          params.push(new Param(() => e.pts[k][0], (v) => { e.pts[k][0] = v; }, paramName(spec.e, `p${k}.x`)));
          params.push(new Param(() => e.pts[k][1], (v) => { e.pts[k][1] = v; }, paramName(spec.e, `p${k}.y`)));
        });
        if (snap) snap.forEach((v) => vals.push(v));
        else e.pts.forEach((q) => vals.push(q[0], q[1]));
        return new MultiFixed(params, vals);
      }
      return null;
    }
    default:
      return null;
  }
}

/** 损坏的约束定义必须保留并报错，不能跳过后继续生成看似成功的模型。 */
export class InvalidConstraintError extends Error {
  constructor(invalidConstraints) {
    super(invalidConstraints.map((issue) => issue.message).join("；"));
    this.name = "InvalidConstraintError";
    this.invalidConstraints = invalidConstraints;
  }
}

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const finitePoint = point => Array.isArray(point) && point.length === 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]);

function sketchDataProblems(entities) {
  if (!Array.isArray(entities)) return [{ index: null, type: "草图数据", reason: "图元列表必须是数组", message: "草图图元列表必须是数组" }];
  const issues = [];
  Array.from(entities).forEach((entity, index) => {
    let reason = null;
    if (!isRecord(entity)) reason = "图元必须是对象";
    else if (entity.kind === "rect" || entity.kind === "circle") {
      if (!finitePoint(entity.c)) reason = "圆心或中心 c 必须包含两个有限数值";
      else if (entity.kind === "rect" && (!Number.isFinite(entity.w) || !Number.isFinite(entity.h) || entity.w <= 0 || entity.h <= 0)) reason = "矩形宽高必须是有限正数";
      else if (entity.kind === "circle" && (!Number.isFinite(entity.r) || entity.r <= 0)) reason = "圆半径必须是有限正数";
    } else if (entity.kind === "polyline") {
      if (!Array.isArray(entity.pts) || entity.pts.length < 2 || !Array.from(entity.pts).every(finitePoint)) reason = "折线必须包含至少两个有限坐标点";
    } else reason = `未知图元类型 ${String(entity.kind)}`;
    if (reason) issues.push({ index: null, entityIndex: index, type: "草图数据", reason, message: `第 ${index + 1} 个草图图元无效：${reason}` });
  });
  return issues;
}

function checkConstraintDefinition(entities, spec) {
  const require = (condition, reason) => { if (!condition) throw new Error(reason); };
  require(isRecord(spec), "约束必须是对象");
  require(typeof spec.type === "string" && spec.type.length > 0, "缺少约束类型 type");
  if (spec.label !== undefined) require(typeof spec.label === "string", "label 必须是文字");
  const number = (value, key) => require(Number.isFinite(value), `${key} 必须是有限数值`);
  const entity = (index, key) => {
    require(Number.isInteger(index) && index >= 0 && index < entities.length, `${key} 引用的图元不存在或图元下标无效`);
    const e = entities[index];
    require(!e.ref, `${key} 是固定参考图元，请使用固定参考坐标约束`);
    return e;
  };
  const point = (ref, key) => {
    require(isRecord(ref), `${key} 缺少有效的点引用`);
    if (ref.e === null) {
      require(finitePoint(ref.at), `${key}.at 必须包含两个有限坐标`);
      return ref.at;
    }
    const e = entity(ref.e, key);
    const valid = e.kind === "rect" ? ["center", "bl", "br", "tr", "tl"].includes(ref.p)
      : e.kind === "circle" ? ref.p === "center"
      : typeof ref.p === "string" && /^p(0|[1-9]\d*)$/.test(ref.p) && Number(ref.p.slice(1)) < e.pts.length;
    require(valid, `${key}.p 引用的点不存在或点名无效`);
    const resolved = pointOf(entities, ref.e, ref.p);
    return [resolved.vx, resolved.vy];
  };
  const distinct = (a, b, key) => require(Math.hypot(b[0] - a[0], b[1] - a[1]) >= 1e-9, `${key} 的两个端点重合，无法定义直线`);
  const line = (ref, key) => {
    require(isRecord(ref), `${key} 缺少有效的直线引用`);
    const e = entity(ref.e, key);
    const count = e.kind === "rect" ? 4 : e.kind === "polyline" ? e.pts.length - (e.closed ? 0 : 1) : 0;
    require(Number.isInteger(ref.seg) && ref.seg >= 0 && ref.seg < count, `${key}.seg 线段下标缺失或超出图元范围`);
    const [a, b] = lineRefPts(entities, ref);
    distinct([a.vx, a.vy], [b.vx, b.vy], key);
  };
  const fixedLine = (points, key) => {
    require(Array.isArray(points) && points.length === 2 && finitePoint(points[0]) && finitePoint(points[1]), `${key} 必须包含两个有限坐标端点`);
    distinct(points[0], points[1], key);
  };
  const parameter = (index, key, field) => {
    const e = entity(index, field);
    const allowed = e.kind === "rect" ? ["w", "h", "cx", "cy"] : e.kind === "circle" ? ["r", "cx", "cy"] : [];
    require(allowed.includes(key), `${field} 的参数 ${String(key)} 不适用于这个图元`);
  };
  const distance = () => { number(spec.value, "value"); require(spec.value >= 0, "value 距离不能为负数"); };
  switch (spec.type) {
    case "fixed":
      parameter(spec.e, spec.k, "e"); number(spec.value, "value");
      if (["r", "w", "h"].includes(spec.k)) require(spec.value > 0, "value 尺寸必须大于零");
      break;
    case "distance":
      point(spec.a, "a"); point(spec.b, "b"); distance(); break;
    case "horizontal": case "vertical": case "coincident":
      point(spec.a, "a"); point(spec.b, "b"); break;
    case "fixedPoint":
      point(spec.p, "p"); number(spec.x, "x"); number(spec.y, "y"); break;
    case "equal":
      require(["r", "w", "h"].includes(spec.k), "相等约束的参数 k 必须是 r、w 或 h");
      parameter(spec.e, spec.k, "e"); parameter(spec.f, spec.k, "f"); break;
    case "angle": case "parallel": case "perpendicular":
      line(spec.l1, "l1"); line(spec.l2, "l2");
      if (spec.type === "angle") number(spec.value, "value");
      break;
    case "midpoint":
      point(spec.p, "p"); line(spec.l, "l"); break;
    case "symmetric":
      point(spec.a, "a"); point(spec.b, "b"); line(spec.l, "l"); break;
    case "distToFixedPoint":
      point(spec.p, "p"); require(finitePoint(spec.at), "at 必须包含两个有限坐标"); distance(); break;
    case "distToFixedLine":
      point(spec.p, "p"); fixedLine(spec.line, "line"); distance(); break;
    case "angleToFixedLine":
      line(spec.l, "l"); fixedLine(spec.ref, "ref"); number(spec.value, "value"); break;
    case "pointToLine": {
      point(spec.p, "p"); const a = point(spec.l1, "l1"), b = point(spec.l2, "l2");
      distinct(a, b, "l1/l2"); distance(); break;
    }
    case "tangent":
      require(entity(spec.e, "e").kind === "circle", "e 必须引用圆图元"); line(spec.l, "l"); break;
    case "fix": {
      const e = entity(spec.e, "e");
      // 老工程没有 at 时沿用其当前几何；存在但损坏的快照绝不能退回当前值。
      if (spec.at !== undefined) {
        const count = e.kind === "rect" ? 4 : e.kind === "circle" ? 3 : e.pts.length * 2;
        require(Array.isArray(spec.at) && spec.at.length === count && Array.from(spec.at).every(Number.isFinite), `固定快照 at 必须包含 ${count} 个有限数值`);
        if (e.kind === "rect") require(spec.at[2] > 0 && spec.at[3] > 0, "固定快照中的宽高必须为正数");
        if (e.kind === "circle") require(spec.at[2] > 0, "固定快照中的半径必须为正数");
      }
      break;
    }
    default: throw new Error(`未知约束类型 ${spec.type}`);
  }
}

function constraintIssue(index, spec, reason) {
  const type = typeof spec?.type === "string" && spec.type ? spec.type : "缺少类型";
  return { index, type, reason, message: `第 ${index + 1} 条约束（${type}）无效：${reason}` };
}

/** 批量构建：先完整验证，再构建；任何坏定义都会阻止整个批次。 */
export function buildConstraints(entities, specs = []) {
  const issues = sketchDataProblems(entities);
  if (!Array.isArray(specs)) issues.push({ index: null, type: "约束列表", reason: "必须是数组", message: "约束列表无效：必须是数组" });
  if (issues.length) throw new InvalidConstraintError(issues);
  const out = [];
  Array.from(specs).forEach((spec, index) => {
    try {
      checkConstraintDefinition(entities, spec);
      const constraint = buildConstraint(entities, spec);
      if (!constraint) throw new Error("无法构建约束，请检查引用字段");
      if (!Number.isFinite(constraint.error())) throw new Error("约束计算产生了非有限残差");
      out.push(constraint);
    } catch (error) {
      issues.push(constraintIssue(index, spec, error.message || String(error)));
    }
  });
  if (issues.length) throw new InvalidConstraintError(issues);
  return out;
}

/** 对一张草图求解全部约束；返回求解结果 + 求解前的坐标备份（方便回滚） */
export function solveSketch(entities, specs, opts = {}) {
  const backup = structuredClone(entities);
  let constraints;
  try { constraints = buildConstraints(entities, specs); }
  catch (error) {
    if (!(error instanceof InvalidConstraintError)) throw error;
    return {
      ok: false, iterations: 0, cost: Infinity, ms: 0, maxErr: Infinity,
      dof: 0, dofApproximate: true, conflicted: true,
      conflicts: error.invalidConstraints.map(issue => issue.message), invalidConstraints: error.invalidConstraints,
      backup, entities, params: [], constraints: [],
    };
  }
  const params = collectParams(entities);
  const res = solve(params, constraints, opts);
  return { ...res, invalidConstraints: [], backup, entities, params, constraints };
}
// ---------------------------------------------------------------- 线性代数
/** 解 A x = b（高斯消元 + 部分主元）。A 会被就地修改 */
function solveLinear(A, b) {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[piv][i])) piv = k;
    if (Math.abs(A[piv][i]) < 1e-14) return null;          // 奇异
    if (piv !== i) { const t = A[piv]; A[piv] = A[i]; A[i] = t; const tb = b[piv]; b[piv] = b[i]; b[i] = tb; }
    for (let k = i + 1; k < n; k++) {
      const f = A[k][i] / A[i][i];
      if (f === 0) continue;
      for (let j = i; j < n; j++) A[k][j] -= f * A[i][j];
      b[k] -= f * b[i];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j];
    x[i] = s / A[i][i];
  }
  return x.every((v) => isFinite(v)) ? x : null;
}

// ---------------------------------------------------------------- 求解
/**
 * Levenberg-Marquardt。
 * @param params       自由度列表
 * @param constraints  约束列表
 * @param opts.maxIter 最大迭代
 * @param opts.tol     残差平方和收敛阈值
 */
export function solve(params, constraints, opts = {}) {
  const maxIter = opts.maxIter ?? 200;
  const tolErr = opts.tolErr ?? 1e-9;      // 判据是「最大残差」，不是 cost
  const n = params.length, m = constraints.length;
  const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
  const invalidResult = (conflicts) => ({ ok: false, iterations: 0, cost: Infinity, ms: 0, maxErr: Infinity,
    dof: Math.max(0, n - m), dofApproximate: true, conflicted: true, conflicts });
  if (params.some(param => !Number.isFinite(param.value))) return invalidResult(["草图参数包含非有限数值"]);
  if (!m) return { ok: true, iterations: 0, cost: 0, ms: 0, maxErr: 0, dof: n, dofApproximate: true, conflicted: false, conflicts: [] };

  const residuals = () => constraints.map((c) => c.error());
  const costOf = (r) => r.reduce((s, x) => s + x * x, 0);
  const maxAbs = (r) => r.reduce((s, x) => Math.max(s, Math.abs(x)), 0);

  let r;
  try { r = residuals(); }
  catch (error) { return invalidResult([`约束计算失败：${error.message || error}`]); }
  if (r.some(value => !Number.isFinite(value))) return invalidResult(["约束计算产生了非有限残差"]);
  let cost = costOf(r);
  if (!n) {
    const maxErr = maxAbs(r), ok = maxErr <= (opts.okTol ?? 1e-6);
    return { ok, iterations: 0, cost, ms: 0, maxErr, dof: 0, dofApproximate: true, conflicted: !ok,
      conflicts: constraints.filter((_, i) => Math.abs(r[i]) > (opts.okTol ?? 1e-6)).map(c => c.label) };
  }
  let lambda = 1e-3;
  let iter = 0;

  /**
   * 数值 Jacobian（中心差分）。
   * 步长必须取 ~1e-6：太小（1e-7 及以下）会让分子 (rp-rm) 落进浮点抵消区，
   * Jacobian 只剩 1e-9 左右的精度，残差就再也降不下去了 —— 实测卡在 3e-6。
   * 中心差分的最优步长量级是 eps^(1/3) ≈ 6e-6。
   */
  const jacobian = () => {
    const J = [];
    for (let i = 0; i < m; i++) J.push(new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      const p = params[j];
      const old = p.value;
      const h = Math.max(1e-6, Math.abs(old) * 1e-6);
      p.value = old + h;
      const rp = residuals();
      p.value = old - h;
      const rm = residuals();
      p.value = old;
      for (let i = 0; i < m; i++) J[i][j] = (rp[i] - rm[i]) / (2 * h);
    }
    return J;
  };

  while (iter < maxIter && maxAbs(r) > tolErr) {
    iter++;
    const J = jacobian();

    // 梯度 g = Jᵀ r，Hessian 近似 H = JᵀJ
    const g = new Array(n).fill(0);
    const H = [];
    for (let a = 0; a < n; a++) H.push(new Array(n).fill(0));
    for (let i = 0; i < m; i++) {
      const Ji = J[i];
      for (let a = 0; a < n; a++) {
        g[a] += Ji[a] * r[i];
        if (Ji[a] === 0) continue;
        for (let b = a; b < n; b++) H[a][b] += Ji[a] * Ji[b];
      }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) H[a][b] = H[b][a];

    let step = null;
    for (let tryIdx = 0; tryIdx < 14; tryIdx++) {
      const A = H.map((row, i) => row.map((v, j) => (i === j ? v + lambda * (1 + v) : v)));
      const dx = solveLinear(A, g.map((v) => -v));
      if (!dx) { lambda *= 4; continue; }

      // 限制单步长度：线性化只在邻域内有效，跨太大反而震荡
      let norm = 0;
      for (const v of dx) norm += v * v;
      norm = Math.sqrt(norm);
      if (!isFinite(norm) || norm > 1e6) { lambda *= 4; continue; }

      const backup = params.map((p) => p.value);
      params.forEach((p, i) => { p.value = backup[i] + dx[i]; });
      const rNew = residuals();
      const cNew = costOf(rNew);

      if (isFinite(cNew) && cNew < cost) { step = { rNew, cNew }; break; }
      params.forEach((p, i) => { p.value = backup[i]; });
      lambda *= 4;
      if (lambda > 1e12) break;
    }

    if (!step) break;                     // 无法再改进（梯度为零或数值极限）
    r = step.rNew;
    const improved = cost - step.cNew;
    cost = step.cNew;
    lambda = Math.max(lambda / 3, 1e-12);
    // 相对收敛：cost 已经降不动了。绝对阈值会把"接近但还没到位"误判成收敛
    if (improved <= cost * 1e-15 + 1e-18) break;
  }

  const maxErr = maxAbs(r);
  const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
  const okFlag = maxErr <= (opts.okTol ?? 1e-6);

  return {
    ok: okFlag,
    iterations: iter,
    cost,
    maxErr,
    ms,
    dof: Math.max(0, n - m),
    dofApproximate: true,
    // 残差降不到 0 只有两种可能：约束互相矛盾，或方程冗余（过约束）。
    // 两者对用户都表现为"这些约束打架了"，所以列出来让他去删
    conflicted: !okFlag,
    conflicts: constraints.filter((c) => Math.abs(c.error()) > 1e-5).map((c) => c.label),
  };
}
