/**
 * 对象捕捉（OSNAP）引擎 —— 参考 SolidWorks / Shapr3D 的捕捉标记语义
 *
 * 为什么需要：手指在平板上点不准（±10px 是常态），但 CAD 要的是精确。
 * 捕捉让用户"差不多点一下"，落到精确的特征点上。
 *
 * 三条设计原则：
 * 1. 判定在**屏幕空间**做（容差 24px，匹配手指精度）
 * 2. 返回的坐标必须是**精确几何值**，绝不能是屏幕反算出来的近似值
 *    —— 否则"看起来对齐了"但实际差 0.3mm，STEP 出去加工会出问题
 * 3. 冲突时按优先级：端点 > 圆心 > 中点 > 象限点 > 原点
 *    （用户画图时最想要的是端点，其次圆心）
 */

export const SNAP_KINDS = {
  endpoint: { label: "端点", rank: 0, mark: "square" },
  center: { label: "圆心", rank: 1, mark: "circle" },
  midpoint: { label: "中点", rank: 2, mark: "triangle" },
  quadrant: { label: "象限点", rank: 3, mark: "diamond" },
  origin: { label: "原点", rank: 4, mark: "cross" },
  intersection: { label: "交点", rank: 5, mark: "x" },
};

const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/**
 * 从一个草图实体里提取所有可捕捉的特征点（草图 2D 坐标）
 * @param entityIndex 传了就顺带给出 solver 能用的点引用 {e, p} ——
 *                    「智能尺寸」要把它存成约束，只有坐标是不够的
 */
export function candidatesOf(e, entityIndex = null) {
  const out = [];
  if (!e) return out;
  const ref = (p) => (entityIndex == null ? null : { e: entityIndex, p });

  if (e.kind === "rect") {
    const [cx, cy] = e.c, hw = e.w / 2, hh = e.h / 2;
    const corners = [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh]];
    const names = ["bl", "br", "tr", "tl"];
    for (let i = 0; i < 4; i++) out.push({ p: corners[i], kind: "endpoint", ref: ref(names[i]) });
    // 四条边的中点（中点不能作为约束目标 —— solver 里没有这个点，
    // 所以 ref 给 null，只用于捕捉显示）
    for (let i = 0; i < 4; i++) out.push({ p: mid(corners[i], corners[(i + 1) % 4]), kind: "midpoint", ref: null });
    out.push({ p: [cx, cy], kind: "center", ref: ref("center") });      // 矩形中心
  } else if (e.kind === "circle") {
    const [cx, cy] = e.c;
    out.push({ p: [cx, cy], kind: "center", ref: ref("center") });
    for (const a of [0, 90, 180, 270]) {
      const r = (a * Math.PI) / 180;
      // 象限点不是 solver 的参数化点，只能捕捉不能约束
      out.push({ p: [cx + Math.cos(r) * e.r, cy + Math.sin(r) * e.r], kind: "quadrant", ref: null });
    }
  } else if (e.kind === "polyline") {
    const P = e.pts;
    for (let i = 0; i < P.length; i++) out.push({ p: [P[i][0], P[i][1]], kind: "endpoint", ref: ref(`p${i}`) });
    for (let i = 0; i < P.length - 1; i++) out.push({ p: mid(P[i], P[i + 1]), kind: "midpoint", ref: null });
    if (e.closed && P.length > 2) out.push({ p: mid(P[P.length - 1], P[0]), kind: "midpoint", ref: null });
  }
  return out;
}

/** 两线段交点（不含端点，端点已由 endpoint 覆盖）；平行/共线返回 null */
function segIntersect(a1, a2, b1, b2) {
  const d1x = a2[0] - a1[0], d1y = a2[1] - a1[1];
  const d2x = b2[0] - b1[0], d2y = b2[1] - b1[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;                 // 平行或共线
  const t = ((b1[0] - a1[0]) * d2y - (b1[1] - a1[1]) * d2x) / den;
  const u = ((b1[0] - a1[0]) * d1y - (b1[1] - a1[1]) * d1x) / den;
  if (t < 1e-6 || t > 1 - 1e-6 || u < 1e-6 || u > 1 - 1e-6) return null;   // 交点落在端点或延长线上
  return [a1[0] + t * d1x, a1[1] + t * d1y];
}

/** 把一个实体拆成线段列表（用于求交点） */
function segmentsOf(e) {
  const segs = [];
  if (e.kind === "rect") {
    const [cx, cy] = e.c, hw = e.w / 2, hh = e.h / 2;
    const c = [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh]];
    for (let i = 0; i < 4; i++) segs.push([c[i], c[(i + 1) % 4]]);
  } else if (e.kind === "polyline") {
    const P = e.pts;
    for (let i = 0; i < P.length - 1; i++) segs.push([P[i], P[i + 1]]);
    if (e.closed && P.length > 2) segs.push([P[P.length - 1], P[0]]);
  }
  return segs;
}

/**
 * 捕捉引擎。
 * 用法：每帧（或每次指针移动）调 update(cursorPx, project, sources)，
 * 拿到 best 就能知道当前吸附到哪个特征点；用 apply() 把坐标换成精确值。
 */
export class SnapEngine {
  constructor() {
    this.enabled = true;
    this.tolPx = 26;         // 屏幕空间容差（手指精度）
    this.best = null;        // 当前命中的候选点
    this.showIntersections = true;
  }

  setEnabled(v) { this.enabled = !!v; if (!v) this.best = null; }

  /**
   * @param cursorPx [x,y] 手指的屏幕坐标
   * @param project  (p2d) => [x,y] 把草图坐标投影到屏幕
   * @param sources  [{entities, origin}] 候选来源
   * @returns 命中的候选点 {p, kind, screen, dist} 或 null
   */
  update(cursorPx, project, sources = []) {
    if (!this.enabled) { this.best = null; return null; }
    let best = null, bestScore = Infinity;

    const consider = (p, kind) => {
      const sx = project(p);
      if (!sx || !isFinite(sx[0])) return;
      const d = Math.hypot(sx[0] - cursorPx[0], sx[1] - cursorPx[1]);
      if (d > this.tolPx) return;
      const rank = SNAP_KINDS[kind]?.rank ?? 9;
      // 距离为主，优先级为辅：同类型里最近的胜出，但端点能压过稍近的中点
      const score = d + rank * 5;
      if (score < bestScore) {
        bestScore = score;
        best = { p: [p[0], p[1]], kind, screen: sx, dist: d, score };
      }
    };

    for (const src of sources) {
      for (const e of src.entities || []) {
        for (const c of candidatesOf(e)) consider(c.p, c.kind);
      }
      // 世界原点（在草图坐标系里是 -originShift 投影后的位置）
      if (src.origin) consider(src.origin, "origin");
    }

    // 交点单独一轮：开销比点特征大，只在没有更好的候选时才考虑
    if (this.showIntersections && bestScore > 6) {
      const all = [];
      for (const src of sources) for (const e of src.entities || []) all.push(...segmentsOf(e));
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const x = segIntersect(all[i][0], all[i][1], all[j][0], all[j][1]);
          if (x) consider(x, "intersection");
        }
      }
    }

    this.best = best;
    return best;
  }

  /** 把手指位置替换成捕捉到的精确坐标 */
  apply(p2d) {
    return this.best ? [this.best.p[0], this.best.p[1]] : p2d;
  }

  clear() { this.best = null; }
}

/**
 * 对象捕捉追踪（OTRACK）：从捕捉点引出的水平/垂直辅助线。
 * 只在光标接近该延伸线时激活 —— 这是 SolidWorks 里画"和上一个端点等高的线"的手法。
 */
export function computeTracking(cursor2d, anchors, project, tolPx = 14) {
  const guides = [];
  if (!anchors || !anchors.length) return guides;
  const cs = project(cursor2d);
  if (!cs) return guides;

  // 去重：多个锚点常常落在同一条延伸线上（比如矩形的两个角点同高），
  // 不去重就会叠画成同一条线
  const seenH = new Set(), seenV = new Set();
  for (const a of anchors) {
    const as = project(a.p);
    if (!as) continue;
    // 水平延伸
    if (Math.abs(cs[1] - as[1]) <= tolPx) {
      const key = a.p[1].toFixed(6);
      if (!seenH.has(key)) {
        seenH.add(key);
        guides.push({ kind: "h", from: a.p, y: a.p[1], label: "水平", value: a.p[1] });
      }
    }
    // 垂直延伸
    if (Math.abs(cs[0] - as[0]) <= tolPx) {
      const key = a.p[0].toFixed(6);
      if (!seenV.has(key)) {
        seenV.add(key);
        guides.push({ kind: "v", from: a.p, x: a.p[0], label: "竖直", value: a.p[0] });
      }
    }
  }
  return guides;
}
