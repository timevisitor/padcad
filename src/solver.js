/**
 * 2D 草图约束求解器
 *
 * 模型：草图 = 一组自由度(Param) + 一组约束(Constraint)。
 * 每个约束给出一个误差标量（要让它趋近 0），求解器最小化 0.5·Σerror²。
 *
 * 欠约束（方程少于未知数）是正常的 —— 用户不可能一开始就把尺寸标全，
 * 这时解法是无穷多组，求解器只保证"往最近的合法位置走"，不会乱跳。
 * 过约束/自相矛盾（比如同时要求 w=20 和 w=30）会检测出来并报错。
 *
 * v6 的两处改动（都保留 v5 的调用方式，只加不改）：
 *   1. **分量残差**：求解器内部把每条约束拆成 1~k 条标量方程（equations()）。
 *      对 hypot 型约束（重合/固定点/中点/对称/固定整个图元），error()² 恰好等于分量平方和，
 *      所以目标函数**完全不变**，但数值性质天差地别：两条线段「水平 + 端点重合」v5 要 125 次迭代，
 *      拆成分量后 2 次（见 regression-sketch-solver.mjs 与 智能草图/solver-bench.json）。
 *   2. **DogLeg 默认 + LM 兜底**：省掉 LM 每步的 λ 试错扫描；DogLeg 没解到位时自动回落 LM。
 *
 * 约束定义仍是可序列化纯数据（buildConstraint），旧工程照常重放。
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
  // 每个参数都带 entity 下标 —— 稀疏 Jacobian 与「按图元着色」都要用它把参数归到图元上
  const add = (get, set, name, entity = null) => {
    const p = new Param(get, set, name);
    p.entity = entity;
    params.push(p);
  };

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
      add(() => e.c[0], (v) => { e.c[0] = v; }, `#${i}.cx`, i);
      add(() => e.c[1], (v) => { e.c[1] = v; }, `#${i}.cy`, i);
      add(() => e.w, (v) => { e.w = v; }, `#${i}.w`, i);
      add(() => e.h, (v) => { e.h = v; }, `#${i}.h`, i);
    } else if (e.kind === "circle") {
      add(() => e.c[0], (v) => { e.c[0] = v; }, `#${i}.cx`, i);
      add(() => e.c[1], (v) => { e.c[1] = v; }, `#${i}.cy`, i);
      add(() => e.r, (v) => { e.r = v; }, `#${i}.r`, i);
    } else if (e.kind === "polyline") {
      e.pts.forEach((_, k) => {
        add(() => e.pts[k][0], (v) => { e.pts[k][0] = v; }, `#${i}.p${k}.x`, i);
        add(() => e.pts[k][1], (v) => { e.pts[k][1] = v; }, `#${i}.p${k}.y`, i);
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
  /**
   * 这个约束对应的**标量方程**列表（诊断用，不参与求解）。
   *
   * 为什么需要：error() 是单个残差（求解器只要一个标量），但有的约束一条残差
   * 其实代表 2~k 个独立方程 —— Coincident 的 hypot(dx,dy)、PointFixed 的 hypot、
   * Midpoint、Symmetric、MultiFixed 都是。
   * 用 error() 的条数当方程数会**低估秩**，于是"完全定义"的草图会被算成还剩 1~2 个自由度
   * （实测：矩形标完宽高 + 固定中心，n−m 给出 1，真实是 0）。
   * 所以诊断必须按分量化后的方程行数算，求解仍走 error()。
   */
  equations() { return [this.error()]; }
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
  // 钉住一个点 = 两个独立方程（x、y 各一条）。error() 用 hypot 只是为了残差单调好看
  equations() { return [this.p.vx - this.x, this.p.vy - this.y]; }
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
  equations() { return this._split(); }
  _split() {
    const mx = (this.p1.vx + this.p2.vx) / 2, my = (this.p1.vy + this.p2.vy) / 2;
    return [this.p.vx - mx, this.p.vy - my];
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
  equations() {
    const ax = this.p2.vx - this.p1.vx, ay = this.p2.vy - this.p1.vy;
    const L = Math.hypot(ax, ay);
    if (L < 1e-9) return [0, 0];
    const ux = ax / L, uy = ay / L;
    const vx = this.b.vx - this.a.vx, vy = this.b.vy - this.a.vy;
    const mx = (this.a.vx + this.b.vx) / 2 - this.p1.vx;
    const my = (this.a.vy + this.b.vy) / 2 - this.p1.vy;
    return [vx * ux + vy * uy, mx * uy - my * ux];
  }
}

/** 两个点重合（点到点重合） */
export class Coincident extends Constraint {
  constructor(a, b) { super([a.x, a.y, b.x, b.y], "重合"); this.a = a; this.b = b; }
  error() { return Math.hypot(this.a.vx - this.b.vx, this.a.vy - this.b.vy); }
  // 重合 = 两个方程（x 相等、y 相等）
  equations() { return [this.a.vx - this.b.vx, this.a.vy - this.b.vy]; }
}

/**
 * 两条线段等长：|P2−P1| = |P4−P3|
 * SolidWorks 的「相等」用在两条直线上就是这个语义（我们的 equal 只管 r/w/h 三个参数）。
 * 诊断上只算一条方程，求解上也只一条 —— 长度相等本身就是一个标量条件。
 */
export class EqualLength extends Constraint {
  constructor(p1, p2, p3, p4) { super([p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, p4.x, p4.y], "等长"); this.p1 = p1; this.p2 = p2; this.p3 = p3; this.p4 = p4; }
  error() {
    const L1 = Math.hypot(this.p2.vx - this.p1.vx, this.p2.vy - this.p1.vy);
    const L2 = Math.hypot(this.p4.vx - this.p3.vx, this.p4.vy - this.p3.vy);
    return L1 - L2;
  }
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
  // 「固定整个元素」= 每个自由度一条方程（矩形 4 条、圆 3 条、折线 2×点数条）
  equations() { return this.params.map((p, i) => p.value - this.values[i]); }
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
    case "equalLength": {
      const l1 = lin(spec.l1), l2 = lin(spec.l2);
      if (!l1 || !l2) return null;
      return new EqualLength(l1[0], l1[1], l2[0], l2[1]);
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
    case "equalLength":
      line(spec.l1, "l1"); line(spec.l2, "l2"); break;
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
  /*
   * 两件新东西（v6 智能草图）：
   * 1) paramDeps —— 「参数 → 引用它的约束」稀疏表，Jacobian 只算相关行（数值与全算逐位相同）；
   * 2) diagnose —— 解完顺手算 rank(J)，返回**真实**自由度（dofApproximate:false）。
   *    旧的 n−m 估算在“约束相关”和“一条残差代表两个方程”两种情况下都会算错。
   * 不需要诊断的调用方（拖动、批量重放）传 opts.exactDof = false 可跳掉这一步。
   */
  const paramDeps = buildParamDeps(params, entities, specs);
  const res = solve(params, constraints, {
    ...opts,
    paramDeps,
    diagnose: opts.exactDof !== false,
  });
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

const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function maxAbsElement(A) {
  let mx = 0;
  for (let i = 0; i < A.length; i++) {
    const row = A[i];
    for (let j = 0; j < row.length; j++) {
      const v = Math.abs(row[j]);
      if (v > mx) mx = v;
    }
  }
  return mx;
}

/**
 * 带列主元的 Householder QR —— 只要秩和 R（不显式构造 Q）。
 *
 * 为什么用 QR 而不是 SVD：planegcs 在 GCS.cpp:4855-4890 的注释里把账算得很清楚 ——
 * QR 便宜、能给出秩、全主元时还能追踪**列**（= 约束或参数）之间的依赖关系；
 * SVD 对秩更稳但贵一到两个数量级。我们的规模（几十~几百）用全主元 QR 足够。
 *
 * 秩判据用**相对阈值**：数值 Jacobian 的每个元素只有 ~1e-10 的相对精度，
 * 绝对阈值在“坐标量级 1000mm”的草图上会把真实的方向误判成噪声。
 *
 * @returns {{rank:number, R:number[][], perm:number[], threshold:number}}
 */
export function qrRank(A, m, n, relTol = 1e-8) {
  const R = new Array(m);
  for (let i = 0; i < m; i++) R[i] = Array.from(A[i]);
  const perm = new Array(n);
  for (let i = 0; i < n; i++) perm[i] = i;
  const threshold = Math.max(1e-12, relTol * Math.max(1, maxAbsElement(R)));
  let rank = 0;
  const steps = Math.min(m, n);
  for (let k = 0; k < steps; k++) {
    let bestJ = -1, bestNorm2 = 0;
    for (let j = k; j < n; j++) {
      let s = 0;
      for (let i = k; i < m; i++) s += R[i][j] * R[i][j];
      if (s > bestNorm2) { bestNorm2 = s; bestJ = j; }
    }
    const sigma = Math.sqrt(bestNorm2);
    if (bestJ < 0 || !(sigma > threshold)) break;      // 剩下的列全在噪声水平 → 秩到此为止
    if (bestJ !== k) {
      for (let i = 0; i < m; i++) { const t = R[i][k]; R[i][k] = R[i][bestJ]; R[i][bestJ] = t; }
      const tp = perm[k]; perm[k] = perm[bestJ]; perm[bestJ] = tp;
    }
    const alpha = R[k][k] > 0 ? -sigma : sigma;
    const v = new Float64Array(m - k);
    v[0] = R[k][k] - alpha;
    for (let i = k + 1; i < m; i++) v[i - k] = R[i][k];
    let vv = 0;
    for (let i = 0; i < v.length; i++) vv += v[i] * v[i];
    if (vv > 0) {
      const beta = 2 / vv;
      for (let j = k; j < n; j++) {
        let s = 0;
        for (let i = k; i < m; i++) s += v[i - k] * R[i][j];
        const f = beta * s;
        if (f !== 0) for (let i = k; i < m; i++) R[i][j] -= f * v[i - k];
      }
    }
    R[k][k] = alpha;
    for (let i = k + 1; i < m; i++) R[i][k] = 0;      // 消掉下三角的浮点残渣
    rank++;
  }
  return { rank, R, perm, threshold };
}

/**
 * 把 R 里「主元之上仍残留的非零」消干净，让依赖关系显式出现在超秩列上。
 * 对应 planegcs 的 eliminateNonZerosOverPivotInUpperTriangularMatrix()。
 */
function eliminateAbovePivot(R, rank, cols) {
  for (let k = rank - 1; k >= 0; k--) {
    const piv = R[k][k];
    if (!(Math.abs(piv) > 1e-300)) continue;
    for (let i = 0; i < k; i++) {
      const f = R[i][k] / piv;
      if (f === 0) continue;
      for (let j = k; j < cols; j++) R[i][j] -= f * R[k][j];
    }
  }
}

/**
 * 找出**线性相关的方程行**（= 冗余或冲突的约束）。
 *
 * 做法与 planegcs identifyConflictingRedundantConstraints 一致：对 Jᵀ 做全主元 QR，
 * 前 rank 列是独立的，第 rank 列之后每一列就是一个“多余”的方程；
 * 它在 R 里非零的那些主元行就是它依赖的方程 —— 这一组就是 conflict group。
 *
 * @returns {{rank:number, groups:number[][]}} groups 里是**方程行号**
 */
export function dependentRowGroups(J, m, n, relTol = 1e-8) {
  if (!m || !n) return { rank: 0, groups: [] };
  const Jt = new Array(n);
  for (let j = 0; j < n; j++) {
    const row = new Array(m);
    for (let i = 0; i < m; i++) row[i] = J[i][j];
    Jt[j] = row;
  }
  const { rank, R, perm } = qrRank(Jt, n, m, relTol);
  if (rank >= m) return { rank, groups: [] };
  eliminateAbovePivot(R, rank, m);
  const groups = [];
  for (let j = rank; j < m; j++) {
    const members = [];
    for (let row = 0; row < rank; row++) {
      if (Math.abs(R[row][j]) > 1e-10) members.push(perm[row]);
    }
    members.push(perm[j]);
    groups.push(members);
  }
  return { rank, groups };
}

/**
 * Jacobian 的零空间（J x = 0 的解空间）—— 它描述“图形还能往哪儿动”。
 * 由 QR 的 R 直接回代得到：自由列取 1，主元列由 R11 z = −R12 e_c 解出。
 */
export function nullSpace(J, m, n, relTol = 1e-8) {
  if (!n) return { rank: 0, basis: [] };
  const { rank, R, perm } = qrRank(J, m, n, relTol);
  const basis = [];
  for (let c = rank; c < n; c++) {
    const x = new Array(n).fill(0);
    const z = new Array(rank).fill(0);
    for (let i = rank - 1; i >= 0; i--) {
      let s = R[i][c] || 0;
      for (let k = i + 1; k < rank; k++) s += R[i][k] * z[k];
      z[i] = Math.abs(R[i][i]) > 1e-300 ? -s / R[i][i] : 0;
    }
    for (let i = 0; i < rank; i++) x[perm[i]] = z[i];
    x[perm[c]] = 1;
    basis.push(x);
  }
  return { rank, basis };
}

/**
 * 每个参数的「可动度」∈[0,1]：零空间基做 Gram-Schmidt 正化后，分量平方和的平方根。
 * 0 = 这个自由度被完全定死（黑），>0 = 还能动（蓝）。比“单看某个基向量”严格：
 * 只有**所有**零空间方向在这一维都为 0，这个参数才是真的不动。
 */
export function mobilityOf(basis, n) {
  const mob = new Array(n).fill(0);
  if (!basis.length) return mob;
  const ortho = [];
  for (const v of basis) {
    const w = v.slice();
    for (let pass = 0; pass < 2; pass++) {
      for (const q of ortho) {
        let d = 0;
        for (let i = 0; i < n; i++) d += w[i] * q[i];
        if (d === 0) continue;
        for (let i = 0; i < n; i++) w[i] -= d * q[i];
      }
    }
    let norm = 0;
    for (let i = 0; i < n; i++) norm += w[i] * w[i];
    norm = Math.sqrt(norm);
    if (norm > 1e-9) {
      for (let i = 0; i < n; i++) w[i] /= norm;
      ortho.push(w);
    }
  }
  for (const w of ortho) for (let i = 0; i < n; i++) mob[i] += w[i] * w[i];
  for (let i = 0; i < n; i++) mob[i] = Math.sqrt(mob[i]);
  return mob;
}

// ---------------------------------------------------------------- 方程行（诊断用）
/**
 * 把一个约束拆成若干**标量方程行**。行数才是它真正占用的“方程数”，
 * 用于秩/自由度分析；求解仍走 error()（一个标量残差），行为完全不变。
 */
export function constraintEquationRows(constraints) {
  const rows = [];
  constraints.forEach((c, ci) => {
    let count = 1;
    try {
      const eqs = c.equations();
      if (Array.isArray(eqs) && eqs.length) count = eqs.length;
    } catch (_) { count = 1; }
    for (let k = 0; k < count; k++) rows.push({ ci, k });
  });
  return rows;
}

/**
 * 分量化方程的数值 Jacobian（中心差分，步长与求解器一致）。
 * deps（可选）= 每个参数依赖的**约束下标**，用来只算相关行 —— 稀疏化，
 * 数学上与逐条全算完全等价（回归 regression-sketch-dof.mjs 有逐元素比对）。
 */
export function equationJacobian(params, constraints, rows, deps = null) {
  const n = params.length;
  const J = rows.map(() => new Array(n).fill(0));
  const byCi = new Map();
  rows.forEach((row, idx) => {
    if (!byCi.has(row.ci)) byCi.set(row.ci, []);
    byCi.get(row.ci).push(idx);
  });
  const cis = [...byCi.keys()];
  for (let j = 0; j < n; j++) {
    const p = params[j];
    const old = p.value;
    const h = Math.max(1e-6, Math.abs(old) * 1e-6);
    const list = deps ? deps[j] ?? [] : cis;
    if (!list.length) continue;
    const plus = new Map();
    p.value = old + h;
    for (const ci of list) { try { plus.set(ci, constraints[ci].equations()); } catch (_) { plus.set(ci, []); } }
    const minus = new Map();
    p.value = old - h;
    for (const ci of list) { try { minus.set(ci, constraints[ci].equations()); } catch (_) { minus.set(ci, []); } }
    p.value = old;
    for (const ci of list) {
      const ep = plus.get(ci) || [], em = minus.get(ci) || [];
      for (const rIdx of byCi.get(ci) || []) {
        const k = rows[rIdx].k;
        J[rIdx][j] = ((ep[k] ?? 0) - (em[k] ?? 0)) / (2 * h);
      }
    }
  }
  return J;
}

/**
 * 系统诊断：真实自由度、秩、以及“哪些约束是多余的”。
 * @returns {{rank:number, dof:number, dofApproximate:false, equations:number, dependent:Array, mobility:number[]}}
 */
export function diagnoseSystem(params, constraints, opts = {}) {
  const n = params.length;
  const relTol = opts.rankTol ?? 1e-8;
  const rows = constraintEquationRows(constraints);
  const J = equationJacobian(params, constraints, rows, opts.paramDeps || null);
  const { rank } = qrRank(J, rows.length, n, relTol);
  const { groups } = dependentRowGroups(J, rows.length, n, relTol);
  const { basis } = nullSpace(J, rows.length, n, relTol);
  const mobility = mobilityOf(basis, n);
  // 方程行 → 约束下标去重；同一组的成员一起去重
  const seen = new Map();
  groups.forEach((g, gi) => {
    const cset = [];
    for (const r of g) {
      const ci = rows[r]?.ci;
      if (ci != null && !cset.includes(ci)) cset.push(ci);
    }
    cset.forEach((ci) => {
      if (!seen.has(ci)) seen.set(ci, { index: ci, group: cset.slice(), groupIndex: gi });
    });
  });
  return {
    rank,
    dof: Math.max(0, n - rank),
    dofApproximate: false,
    equations: rows.length,
    dependent: [...seen.values()].sort((a, b) => a.index - b.index),
    mobility,
    nullSpaceDim: Math.max(0, n - rank),
  };
}

/**
 * 一个 spec 引用了哪些图元下标（常量引用 {e:null, at} 不算）。
 * 用途：给数值 Jacobian 建“参数 → 约束”的稀疏依赖表。
 */
export function specEntities(spec) {
  const out = new Set();
  const ref = (r) => { if (r && typeof r === "object" && Number.isInteger(r.e)) out.add(r.e); };
  switch (spec?.type) {
    case "fixed": case "fix": ref(spec); break;
    case "equal": ref({ e: spec.e }); ref({ e: spec.f }); break;
    case "distance": case "horizontal": case "vertical": case "coincident":
      ref(spec.a); ref(spec.b); break;
    case "fixedPoint": case "distToFixedPoint": case "distToFixedLine": ref(spec.p); break;
    case "angle": case "parallel": case "perpendicular": case "equalLength":
      ref(spec.l1); ref(spec.l2); break;
    case "midpoint": ref(spec.p); ref(spec.l); break;
    case "symmetric": ref(spec.a); ref(spec.b); ref(spec.l); break;
    case "angleToFixedLine": ref(spec.l); break;
    case "pointToLine": ref(spec.p); ref(spec.l1); ref(spec.l2); break;
    case "tangent": ref({ e: spec.e }); ref(spec.l); break;
    default: break;
  }
  return out;
}

/**
 * 建「参数 → 依赖的约束下标」表。只按**图元**粒度筛：同一图元的参数可能被任意一条
 * 引用它的约束影响，所以一张表就够，且绝不会漏（比按参数名匹配安全）。
 */
export function buildParamDeps(params, entities, specs) {
  if (!Array.isArray(specs)) return null;
  const touched = specs.map((s) => specEntities(s));
  return params.map((p) => {
    const e = p.entity;
    const list = [];
    if (e == null) return list;
    for (let i = 0; i < touched.length; i++) if (touched[i].has(e)) list.push(i);
    return list;
  });
}

// ---------------------------------------------------------------- 求解核心
/*
 * 求解器内部用的是**分量残差**（每条约束可拆成 1~k 条标量方程），而不是 error() 的标量残差。
 *
 * 为什么这不是“改语义”而是“改配方”：对 hypot 型约束（Coincident / PointFixed / Midpoint /
 * Symmetric / MultiFixed），error()² 恰好等于分量平方和 —— 目标函数 **一模一样**
 * （最小化 Σ error² ≡ 最小化 Σ 分量²），区别只在数值上：
 *   - 标量 hypot 在残差趋 0 处是**锥形**的，二阶导数发散，LM 只能线性收敛
 *     （实测：两条线段「水平 + 端点重合」这种几乎线性的方程组，标量残差要 125 次迭代才到 1e-9，
 *      加长到 7 段就干脆卡在 8e-4 不动）；
 *   - 拆成分量后每个方程都是光滑的一次式，同样的场景 2 次迭代就到 1e-9。
 * planegcs 也是这么做的（一条几何约束编译成多条 solver 方程）。
 */

/** 每条约束占几行方程（1~k），以及行号起点 */
function buildRowMap(constraints) {
  const rowStart = new Int32Array(constraints.length + 1);
  let rows = 0;
  for (let i = 0; i < constraints.length; i++) {
    rowStart[i] = rows;
    let count = 1;
    try {
      const eq = constraints[i].equations();
      if (Array.isArray(eq) && eq.length) count = eq.length;
    } catch (_) { count = 1; }
    rows += count;
  }
  rowStart[constraints.length] = rows;
  return { rowStart, rows };
}

/** 取一条约束的分量方程；坏约束退回标量残差（求解器不该因为诊断接口而崩） */
function equationsOf(c) {
  try {
    const eq = c.equations();
    if (Array.isArray(eq) && eq.length) return eq;
  } catch (_) { /* 退回标量 */ }
  return [c.error()];
}

function residualVector(constraints, rowStart, rows) {
  const out = new Array(rows);
  for (let i = 0; i < constraints.length; i++) {
    const eq = equationsOf(constraints[i]);
    for (let r = rowStart[i]; r < rowStart[i + 1]; r++) out[r] = eq[r - rowStart[i]] ?? 0;
  }
  return out;
}

/**
 * 数值 Jacobian（中心差分）。
 * 步长必须取 ~1e-6：太小（1e-7 及以下）会让分子 (rp-rm) 落进浮点抵消区，
 * Jacobian 只剩 1e-9 左右的精度，残差就再也降不下去了 —— 实测卡在 3e-6。
 * 中心差分的最优步长量级是 eps^(1/3) ≈ 6e-6。
 *
 * deps 非空时只对被该参数所属图元引用的那些约束求值（稀疏）：条目数值与全算**逐位相同**，
 * 省掉的只是无关约束的重复计算（50 图元规模下 Jacobian 时间约降到 1/4）。
 */
function buildJacobian(params, constraints, n, rowStart, rows, deps) {
  const J = new Array(rows);
  for (let i = 0; i < rows; i++) J[i] = new Array(n).fill(0);
  const allIdx = constraints.map((_, i) => i);
  for (let j = 0; j < n; j++) {
    const p = params[j];
    const old = p.value;
    const h = Math.max(1e-6, Math.abs(old) * 1e-6);
    const idxs = deps ? deps[j] : allIdx;
    if (!idxs.length) continue;                     // 没有任何约束引用这个图元 → 整列为 0
    p.value = old + h;
    const plus = idxs.map((i) => equationsOf(constraints[i]));
    p.value = old - h;
    const minus = idxs.map((i) => equationsOf(constraints[i]));
    p.value = old;
    for (let t = 0; t < idxs.length; t++) {
      const ci = idxs[t], s = rowStart[ci], e = rowStart[ci + 1];
      const ep = plus[t], em = minus[t];
      for (let r = s; r < e; r++) J[r][j] = ((ep[r - s] ?? 0) - (em[r - s] ?? 0)) / (2 * h);
    }
  }
  return J;
}

/** 每条约束的残差是否超阈（冲突标签用） */
function conflictLabels(constraints, rowStart, rv, tol) {
  const out = [];
  for (let i = 0; i < constraints.length; i++) {
    for (let r = rowStart[i]; r < rowStart[i + 1]; r++) {
      if (Math.abs(rv[r]) > tol) { out.push(constraints[i].label); break; }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 求解
/**
 * 求解入口。默认算法是 **DogLeg 信赖域**（v6 换的默认），失败自动回落 LM；
 * 传 opts.algorithm = "lm" 可强制回到 v5 的算法（残差同样是分量形式）。
 * 对比数据见 智能草图/solver-bench.json。
 *
 * @param params       自由度列表
 * @param constraints  约束列表
 * @param opts.maxIter 最大迭代
 * @param opts.tolErr  最大残差收敛阈值
 * @param opts.algorithm  "dogleg"（默认）| "lm"
 * @param opts.paramDeps  每个参数依赖的约束下标（稀疏 Jacobian）
 * @param opts.leastNorm  m < n 时用最小范数步（线性方程组从 n 阶降到 m 阶）
 * @param opts.diagnose   true 时附带秩/真实自由度诊断（dofApproximate:false）
 */
export function solve(params, constraints, opts = {}) {
  const maxIter = opts.maxIter ?? 200;
  const tolErr = opts.tolErr ?? 1e-9;
  const okTol = opts.okTol ?? 1e-6;
  const n = params.length, m = constraints.length;
  const t0 = nowMs();
  const deps = opts.paramDeps || null;
  const { rowStart, rows } = buildRowMap(constraints);

  function finish(out) {
    if (!opts.diagnose) return out;
    try {
      const d = diagnoseSystem(params, constraints, { paramDeps: deps, rankTol: opts.rankTol });
      return { ...out, rank: d.rank, equations: d.equations, dof: d.dof, dofApproximate: false,
        dependent: d.dependent, mobility: d.mobility };
    } catch (error) {
      return out;                                        // 诊断失败不影响求解结论
    }
  }
  const invalidResult = (conflicts) => ({ ok: false, iterations: 0, cost: Infinity, ms: 0, maxErr: Infinity,
    dof: Math.max(0, n - m), dofApproximate: true, conflicted: true, conflicts });
  if (params.some((param) => !Number.isFinite(param.value))) return invalidResult(["草图参数包含非有限数值"]);
  if (!m) {
    return finish({ ok: true, iterations: 0, cost: 0, ms: 0, maxErr: 0, dof: n, dofApproximate: false,
      conflicted: false, conflicts: [] });
  }

  const residuals = () => residualVector(constraints, rowStart, rows);
  const costOf = (r) => r.reduce((s, x) => s + x * x, 0);
  const maxAbs = (r) => r.reduce((s, x) => Math.max(s, Math.abs(x)), 0);

  let r;
  try { r = residuals(); }
  catch (error) { return invalidResult([`约束计算失败：${error.message || error}`]); }
  if (r.some((value) => !Number.isFinite(value))) return invalidResult(["约束计算产生了非有限残差"]);
  let cost = costOf(r);
  if (!n) {
    const maxErr = maxAbs(r), ok = maxErr <= okTol;
    return finish({ ok, iterations: 0, cost, ms: 0, maxErr, dof: 0, dofApproximate: false, conflicted: !ok,
      conflicts: conflictLabels(constraints, rowStart, r, okTol) });
  }

  const core = { params, constraints, n, m: rows, residuals, costOf, maxAbs, rowStart };
  const jacobian = () => buildJacobian(params, constraints, n, rowStart, rows, deps);
  const runOpts = { maxIter, tolErr, okTol, delta0: opts.delta0, leastNorm: opts.leastNorm };
  let out;
  if (opts.algorithm === "lm") out = solveLM({ ...core, jacobian }, runOpts, r, cost);
  else {
    // 默认：DogLeg；没解到位时回落 LM 再解一次（只发生在矛盾/病态草图上）
    out = solveDogLeg({ ...core, jacobian }, runOpts, r, cost);
    if (!out.ok && opts.algorithm !== "dogleg") {
      const fallback = solveLM({ ...core, jacobian }, runOpts, r, cost);
      if (fallback.maxErr < out.maxErr) out = fallback;
    }
  }
  out.ms = nowMs() - t0;
  out.conflicts = conflictLabels(constraints, rowStart, out.residuals ?? r, 1e-5);
  return finish(out);
}

/** Levenberg-Marquardt（v5 的算法；残差改成分量形式，目标函数不变） */
function solveLM(core, opts, r0, cost0) {
  const { params, constraints, n, m, residuals, jacobian, costOf, maxAbs } = core;
  const maxIter = opts.maxIter ?? 200, tolErr = opts.tolErr ?? 1e-9, okTol = opts.okTol ?? 1e-6;
  let r = r0, cost = cost0;
  let lambda = 1e-3;
  let iter = 0;
  /*
   * 少自由度系统（m < n，CAD 草图绝大多数是这个情况）可以用**最小范数步**：
   *   dx = Jᵀ (J Jᵀ + λI)⁻¹ (−r)
   * 它等价于“在满足线性化约束的前提下，让参数改变量最小”，而且线性方程组的阶数从 n 降到 m。
   */
  const leastNorm = !!opts.leastNorm && m < n;

  while (iter < maxIter && maxAbs(r) > tolErr) {
    iter++;
    const J = jacobian();

    const g = new Array(n).fill(0);
    const H = leastNorm ? null : [];
    if (!leastNorm) for (let a = 0; a < n; a++) H.push(new Array(n).fill(0));
    for (let i = 0; i < m; i++) {
      const Ji = J[i];
      for (let a = 0; a < n; a++) {
        g[a] += Ji[a] * r[i];
        if (leastNorm || Ji[a] === 0) continue;
        for (let b = a; b < n; b++) H[a][b] += Ji[a] * Ji[b];
      }
    }
    if (!leastNorm) for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) H[a][b] = H[b][a];

    let S = null;
    if (leastNorm) {
      S = [];
      for (let i = 0; i < m; i++) S.push(new Array(m).fill(0));
      for (let i = 0; i < m; i++) {
        const Ji = J[i];
        for (let k = i; k < m; k++) {
          const Jk = J[k];
          let s = 0;
          for (let a = 0; a < n; a++) s += Ji[a] * Jk[a];
          S[i][k] = s;
          S[k][i] = s;
        }
      }
    }

    let step = null;
    for (let tryIdx = 0; tryIdx < 14; tryIdx++) {
      let dx;
      if (leastNorm) {
        const A = S.map((row, i) => row.map((v, j) => (i === j ? v + lambda * (1 + v) : v)));
        const y = solveLinear(A, r.map((v) => -v));
        if (!y) { lambda *= 4; continue; }
        dx = new Array(n).fill(0);
        for (let a = 0; a < n; a++) {
          let s = 0;
          for (let i = 0; i < m; i++) s += J[i][a] * y[i];
          dx[a] = s;
        }
      } else {
        const A = H.map((row, i) => row.map((v, j) => (i === j ? v + lambda * (1 + v) : v)));
        dx = solveLinear(A, g.map((v) => -v));
      }
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
  const okFlag = maxErr <= okTol;
  return {
    ok: okFlag,
    iterations: iter,
    cost,
    maxErr,
    ms: 0,
    dof: Math.max(0, n - m),
    dofApproximate: true,
    // 残差降不到 0 只有两种可能：约束互相矛盾，或方程冗余（过约束）。
    // 两者对用户都表现为"这些约束打架了"，所以列出来让他去删
    conflicted: !okFlag,
    conflicts: [],
    residuals: r,
  };
}

/**
 * DogLeg（信赖域）—— 参考 planegcs solve_DL（GCS.cpp:2285-2450）与 Moré-Sorensen 折线法。
 *
 * 与 LM 的区别：LM 每一步都要「λ 试错扫描」（我们这边最多 14 次试步，每次都重算全部残差），
 * DogLeg 用信赖域半径 δ 直接决定步长，一次成型；下降比 rho 只用来调 δ。
 * 基准数据见 智能草图/solver-bench.json（当前结论：在分量残差下 LM 与 DogLeg 互有胜负，
 * 所以默认仍是 LM；DogLeg 保留为 opts.algorithm="dogleg" 的可选项）。
 */
function solveDogLeg(core, opts, r0, cost0) {
  const { params, constraints, n, m, residuals, jacobian, costOf, maxAbs } = core;
  const maxIter = opts.maxIter ?? 200, tolErr = opts.tolErr ?? 1e-9, okTol = opts.okTol ?? 1e-6;
  const leastNorm = !!opts.leastNorm && m < n;
  let r = r0, cost = cost0;
  // 信赖域半径的初值要跟坐标量级挂钩：草图上坐标常常是几十上百，
  // 固定 1 会让前十几步都在原地挪（实测比 LM 还慢）。
  let xnorm = 0;
  for (const p of params) xnorm += p.value * p.value;
  let delta = opts.delta0 ?? Math.max(1e-3, 0.1 * Math.sqrt(xnorm) / Math.max(1, Math.sqrt(n)));
  let iter = 0;
  const H = new Array(n);
  const scaleTo = (v, len) => {
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    if (!(norm > 1e-300)) return null;
    const f = len / norm;
    return v.map((x) => x * f);
  };

  while (iter < maxIter && maxAbs(r) > tolErr) {
    iter++;
    const J = jacobian();

    const g = new Array(n).fill(0);
    if (!leastNorm) for (let a = 0; a < n; a++) H[a] = new Array(n).fill(0);
    for (let i = 0; i < m; i++) {
      const Ji = J[i];
      for (let a = 0; a < n; a++) {
        if (Ji[a] === 0) continue;
        g[a] += Ji[a] * r[i];
        if (leastNorm) continue;
        for (let b = a; b < n; b++) H[a][b] += Ji[a] * Ji[b];
      }
    }
    if (!leastNorm) for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) H[a][b] = H[b][a];

    let gn = 0;
    for (const v of g) gn += v * v;
    gn = Math.sqrt(gn);
    if (!(gn > 1e-14)) break;                       // 梯度为零：已经是极值点

    /*
     * Gauss-Newton 步。
     * 欠约束（m < n）时 JᵀJ 一定奇异，直接解不可靠；两种应对：
     *   leastNorm  → 用最小范数形式 h = Jᵀ(JJᵀ + εI)⁻¹(−r)，阶数 m（比 n 小），且天然“改动最小”
     *   否则       → 正常方程 + 一点岭
     */
    let hGN = null;
    if (leastNorm) {
      const S = [];
      for (let i = 0; i < m; i++) S.push(new Array(m).fill(0));
      for (let i = 0; i < m; i++) {
        const Ji = J[i];
        for (let k = i; k < m; k++) {
          const Jk = J[k];
          let s = 0;
          for (let a = 0; a < n; a++) s += Ji[a] * Jk[a];
          S[i][k] = s;
          S[k][i] = s;
        }
      }
      let tr = 0;
      for (let i = 0; i < m; i++) tr += S[i][i];
      const ridge = Math.max(1e-12, (tr / Math.max(1, m)) * 1e-10);
      const y = solveLinear(S.map((row, i) => row.map((v, k) => (i === k ? v + ridge : v))), r.map((v) => -v));
      if (y) {
        hGN = new Array(n).fill(0);
        for (let a = 0; a < n; a++) {
          let s = 0;
          for (let i = 0; i < m; i++) s += J[i][a] * y[i];
          hGN[a] = s;
        }
      }
    } else {
      hGN = solveLinear(H.map((row) => row.slice()), g.map((v) => -v));
      if (!hGN) {
        let tr = 0;
        for (let a = 0; a < n; a++) tr += H[a][a];
        const ridge = Math.max(1e-12, (tr / Math.max(1, n)) * 1e-10);
        hGN = solveLinear(H.map((row, a) => row.map((v, b) => (a === b ? v + ridge : v))), g.map((v) => -v));
      }
    }

    // 最速下降步：沿 −g，步长取最优 α = ‖g‖²/‖Jg‖²
    let alpha = 0;
    {
      let Jg2 = 0;
      for (let i = 0; i < m; i++) {
        let s = 0;
        const Ji = J[i];
        for (let a = 0; a < n; a++) s += Ji[a] * g[a];
        Jg2 += s * s;
      }
      alpha = Jg2 > 0 ? (gn * gn) / Jg2 : 0;
    }
    const hSD = g.map((v) => -alpha * v);
    let sdNorm = 0;
    for (const v of hSD) sdNorm += v * v;
    sdNorm = Math.sqrt(sdNorm);

    let h = null;
    if (!hGN) h = sdNorm > 1e-14 ? scaleTo(hSD, Math.min(sdNorm, delta)) : null;
    else {
      let gnNorm = 0;
      for (const v of hGN) gnNorm += v * v;
      gnNorm = Math.sqrt(gnNorm);
      if (gnNorm <= delta) h = hGN;
      else if (sdNorm >= delta) h = scaleTo(hSD, delta);
      else {
        const d = hGN.map((v, i) => v - hSD[i]);
        let dd = 0, dsd = 0;
        for (let i = 0; i < n; i++) { dd += d[i] * d[i]; dsd += d[i] * hSD[i]; }
        const c = delta * delta - sdNorm * sdNorm;
        const disc = dsd * dsd + dd * c;
        let beta = 0;
        if (dd > 1e-300 && disc >= 0) beta = (-dsd + Math.sqrt(disc)) / dd;
        beta = Math.max(0, Math.min(1, beta));
        h = hSD.map((v, i) => v + beta * d[i]);
      }
    }
    if (!h) break;

    const backup = params.map((p) => p.value);
    params.forEach((p, i) => { p.value = backup[i] + h[i]; });
    const rNew = residuals();
    const cNew = costOf(rNew);

    let predicted = 0;
    for (let i = 0; i < m; i++) {
      let Jh = 0;
      const Ji = J[i];
      for (let a = 0; a < n; a++) Jh += Ji[a] * h[a];
      predicted += r[i] * Jh + 0.5 * Jh * Jh;
    }
    const rho = predicted > 0 ? (cost - cNew) / predicted : (cNew < cost ? 1 : 0);

    if (isFinite(cNew) && cNew < cost) {
      r = rNew;
      cost = cNew;
      if (rho > 0.75) delta *= 2;
      else if (rho < 0.25) delta = Math.max(delta / 3, 1e-12);
    } else {
      params.forEach((p, i) => { p.value = backup[i]; });
      delta /= 3;
      if (delta < 1e-12) break;
    }
  }

  const maxErr = maxAbs(r);
  const okFlag = maxErr <= okTol;
  return {
    ok: okFlag,
    iterations: iter,
    cost,
    maxErr,
    ms: 0,
    dof: Math.max(0, n - m),
    dofApproximate: true,
    conflicted: !okFlag,
    conflicts: [],
    residuals: r,
  };
}
