/**
 * 2D 图元生成（B 批 P0-2 的地基）
 *
 * 设计取舍：不新增 entity kind，全部生成**闭合折线**（现有的 polyline 通道）。
 * 理由：约束、捕捉、偏移、转换实体引用、拉伸、工程保存全部都认 polyline；
 * 新增 kind 要在 6 处加分支（selectors/elements/solver/replay/sketch/feattree），
 * 而采样精度可以按「弦高」控制，做到几何误差可断言。
 *
 * 精度约定：所有曲线按 segments 等分采样；圆/椭圆至少 48 段，
 * 采样多边形的面积与外接解析值之差可以写成断言（不靠肉眼）。
 */

const TAU = Math.PI * 2;

const pt = (c, r, a) => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];

/** 圆弧采样（含端点，逆时针 a0→a1） */
export function arcPoints({ center = [0, 0], r, a0 = 0, a1 = Math.PI, segments = 32 }) {
  if (!(r > 0)) throw new Error("圆弧半径必须大于 0");
  const n = Math.max(2, Math.round(segments));
  const out = [];
  for (let i = 0; i <= n; i++) out.push(pt(center, r, a0 + (a1 - a0) * (i / n)));
  return out;
}

/**
 * 三点圆弧：返回采样点（不含点共线时的错误结果，直接报错）
 * 判据：三个点必须不共线；半径由外接圆公式给出。
 */
export function arcThroughPoints(p1, p2, p3, { segments = 32 } = {}) {
  const [ax, ay] = p1, [bx, by] = p2, [cx, cy] = p3;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) throw new Error("三点共线，画不出圆弧");
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  let a1 = Math.atan2(ay - uy, ax - ux);
  let a2nd = Math.atan2(by - uy, bx - ux);
  let a3 = Math.atan2(cy - uy, cx - ux);
  // 让中间点落在扫过的区间里：分别试逆时针/顺时针
  const norm = (a) => ((a % TAU) + TAU) % TAU;
  const ccwSpan = norm(a3 - a1), midCcw = norm(a2nd - a1);
  const out = [];
  const n = Math.max(2, Math.round(segments));
  if (midCcw <= ccwSpan) {
    for (let i = 0; i <= n; i++) out.push(pt([ux, uy], r, a1 + ccwSpan * (i / n)));
  } else {
    const cwSpan = ccwSpan - TAU;                 // 负数
    for (let i = 0; i <= n; i++) out.push(pt([ux, uy], r, a1 + cwSpan * (i / n)));
  }
  return { points: out, center: [ux, uy], r };
}

/** 正多边形：inscribed=true 顶点落在半径 r 上；false 则边心距为 r（外切） */
export function polygonPoints({ center = [0, 0], r, sides = 6, rotation = 0, inscribed = true }) {
  const n = Math.round(sides);
  if (!(n >= 3)) throw new Error("多边形至少 3 条边");
  if (!(r > 0)) throw new Error("多边形外接半径必须大于 0");
  const R = inscribed ? r : r / Math.cos(Math.PI / n);
  const out = [];
  for (let i = 0; i < n; i++) out.push(pt(center, R, rotation + (TAU * i) / n));
  out.push(out[0].slice());
  return out;
}

/**
 * 槽口（两半圆 + 两边），a、b 是两个圆心，r 是半径
 *
 * 默认 64 段：弦高误差使采样面积比解析值低 (2π/n)²/6 ≈ 0.16%，
 * 对 2rL+πr² 这种要卡 ±1mm² 的断言是够的；以前 24 段会低 1.1%，测试卡不住。
 */
export function slotPoints({ a, b, r, segments = 64 }) {
  if (!(r > 0)) throw new Error("槽口半径必须大于 0");
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) throw new Error("槽口两端圆心不能重合（要画圆就用圆）");
  const ang = Math.atan2(dy, dx);
  const n = Math.max(6, Math.round(segments));
  const arcB = [];
  for (let i = 0; i <= n / 2; i++) arcB.push(pt(b, r, ang - Math.PI / 2 + (Math.PI * 2 * i) / n));
  const arcA = [];
  for (let i = 0; i <= n / 2; i++) arcA.push(pt(a, r, ang + Math.PI / 2 + (Math.PI * 2 * i) / n));
  return [...arcB, ...arcA, arcB[0].slice()];
}

/**
 * 椭圆采样
 *
 * 默认 96 段：弦高误差 ≈ (2π/n)²/6 = 0.07%，π·rx·ry 卡 ±1mm² 时才不会踩线
 * （64 段对 r=15 的圆已经低 1.14mm²，正好被 ±1 卡掉）。
 */
export function ellipsePoints({ center = [0, 0], rx, ry, rotation = 0, segments = 96 }) {
  if (!(rx > 0) || !(ry > 0)) throw new Error("椭圆两个半轴都要大于 0");
  const n = Math.max(12, Math.round(segments));
  const c = Math.cos(rotation), s = Math.sin(rotation);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = (TAU * i) / n;
    const x = rx * Math.cos(t), y = ry * Math.sin(t);
    out.push([center[0] + x * c - y * s, center[1] + x * s + y * c]);
  }
  return out;
}

/**
 * 折线围成的面积（鞋带公式，取绝对值）——测试与面板显示共用
 * 首尾是否重复都吃：重复收尾点的那一段叉积为 0，不影响结果。
 */
export function polygonArea(pts) {
  if (!Array.isArray(pts) || pts.length < 3) throw new Error("算面积至少要 3 个点");
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

/**
 * 转成建模/草图能直接用的 polyline 实体
 * @param closed 显式指定开合；不传则按「首尾点是否重合」自动判断
 *   （圆弧这类开口曲线的采样点首尾不重合，自动判断正好得到 closed:false）
 */
export function toPolylineEntity(pts, { name = null, closed = null } = {}) {
  if (!Array.isArray(pts) || pts.length < 3) throw new Error("折线至少需要 3 个点");
  const touches = pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
  const isClosed = closed === null ? touches : !!closed;
  return {
    kind: "polyline",
    // 闭合时去掉重复的收尾点（装配层会自己补 close）
    pts: (isClosed && touches ? pts.slice(0, -1) : pts).map((p) => [p[0], p[1]]),
    closed: isClosed,
    ...(name ? { name } : {}),
  };
}
