import { candidatesOf } from "./snap.js";
/**
 * 草图元素（边级别）+ 智能尺寸规则
 *
 * 为什么需要这一层：草图实体是「矩形 / 圆 / 自由折线」，但智能尺寸要的是**元素级别**——
 * 点矩形的一条边，标注的应该是那条边（长度/平行关系/角度），而不是整个矩形。
 *
 * 元素的引用是可序列化的纯数据：
 *   { kind:"line",   e:0, seg:2 }     矩形或折线的第 seg 条边
 *   { kind:"circle", e:0 }            圆
 *   { kind:"point",  e:0, p:"tr" }    特征点（求解器能吃的那些）
 *
 * 标注规则照 SolidWorks（已核对官方文档与实际行为）：
 *   1 个圆          → 直径
 *   1 条线          → 长度
 *   2 个点          → 距离
 *   2 条平行线      → 线距
 *   2 条不平行线    → 角度
 *   2 个圆          → 圆心距
 *   圆 + 线         → 圆心到线的距离
 *   点 + 线         → 点到线距离
 *   点 + 圆         → 点到圆心的距离
 */

/** 把一条边拆成端点（用于取"线的两个端点"） */
function lineEndpoints(ent, seg) {
  if (ent.kind === "rect") {
    const [cx, cy] = ent.c, hw = ent.w / 2, hh = ent.h / 2;
    const c = [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh]];
    const names = [["bl", "br"], ["br", "tr"], ["tr", "tl"], ["tl", "bl"]];
    const k = ((seg % 4) + 4) % 4;
    return { a: c[k], b: c[(k + 1) % 4], refA: { e: null, p: names[k][0] }, refB: { e: null, p: names[k][1] } };
  }
  if (ent.kind === "polyline") {
    const P = ent.pts;
    const n = ent.closed ? P.length : P.length - 1;
    if (seg < 0 || seg >= n) return null;
    const i = seg, j = (seg + 1) % P.length;
    return { a: [P[i][0], P[i][1]], b: [P[j][0], P[j][1]], refA: { e: null, p: `p${i}` }, refB: { e: null, p: `p${j}` } };
  }
  return null;
}

/** 这个实体有几条边 */
export function segCountOf(ent) {
  if (!ent) return 0;
  if (ent.kind === "rect") return 4;
  if (ent.kind === "polyline") return ent.closed ? ent.pts.length : ent.pts.length - 1;
  return 0;
}

/** 元素 → 几何（点坐标 / 圆的圆心半径 / 线的两端点与方向） */
export function geometryOf(sketch, sel) {
  if (!sel) return null;
  /*
   * 「投影元素」：草图里引用的**模型上的点/线**，已经投影到草图平面。
   * 它们不是用户画的图元，没有实体下标，也不参与求解 —— 只当常量参考。
   *   { kind:"projPoint", p:[x,y] }              模型顶点投到平面的点
   *   { kind:"projLine",  a:[x,y], b:[x,y] }      模型棱边投到平面的线
   */
  if (sel.kind === "projPoint") {
    return { kind: "point", p: sel.p, ref: null, fixed: true, label: sel.label };
  }
  if (sel.kind === "projLine") {
    const dx = sel.b[0] - sel.a[0], dy = sel.b[1] - sel.a[1];
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) return null;
    return { kind: "line", a: sel.a, b: sel.b, dir: [dx / L, dy / L], len: L, fixed: true, label: sel.label };
  }
  const ent = sketch.entities[sel.e];
  if (!ent) return null;
  // 引用来的图元是常量参考（求解时不参与），标记成 fixed 让规则走"固定参考"分支
  const isRef = !!ent.ref;
  if (sel.kind === "circle") {
    if (ent.kind !== "circle") return null;
    return { kind: "circle", center: [ent.c[0], ent.c[1]], r: ent.r, fixed: isRef };
  }
  if (sel.kind === "line") {
    const ep = lineEndpoints(ent, sel.seg);
    if (!ep) return null;
    const dx = ep.b[0] - ep.a[0], dy = ep.b[1] - ep.a[1];
    const L = Math.hypot(dx, dy);
    return { kind: "line", a: ep.a, b: ep.b, dir: L > 1e-9 ? [dx / L, dy / L] : null, len: L,
             // 引用图元给 fixed（常量参考），普通图元才给可寻址的 refA/refB
             fixed: isRef, label: isRef ? "模型引用" : undefined,
             refA: isRef ? null : { e: sel.e, p: ep.refA.p },
             refB: isRef ? null : { e: sel.e, p: ep.refB.p } };
  }
  if (sel.kind === "point") {
    // 选择保存的是语义引用；坐标必须从当前图元读取，不能依赖上次拾取的缓存。
    let p = null;
    if (sel.p === "center" && ent.c) p = ent.c.slice();
    else if (ent.kind === "rect") {
      const corner = { bl: 0, br: 1, tr: 2, tl: 3 }[sel.p];
      if (corner !== undefined) p = lineEndpoints(ent, corner).a;
    } else if (ent.kind === "polyline" && /^p\d+$/.test(sel.p)) {
      p = ent.pts[Number(sel.p.slice(1))]?.slice() || null;
    }
    if (!p) return null;
    return { kind: "point", p, fixed: isRef, ref: isRef ? null : { e: sel.e, p: sel.p } };
  }
  return null;
}

/** 点到线段的距离 */
function distToSeg(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const L2 = vx * vx + vy * vy;
  if (L2 < 1e-12) return Math.hypot(p.x - a[0], p.y - a[1]);
  let t = ((p.x - a[0]) * vx + (p.y - a[1]) * vy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a[0] + t * vx), p.y - (a[1] + t * vy));
}

/**
 * 在草图 2D 坐标下找最近的**元素**。
 * 这是智能尺寸与约束功能共同的拾取入口：返回的是边级别引用，
 * 点矩形的一条边得到的是那条边本身，而不是整个矩形。
 * @param tol 容差（草图 mm）。调用方一般按屏幕像素换算过来。
 */
export function pickElementAt(sketch, p, tol = 2.5) {
  let best = null, bd = Infinity;
  sketch.entities.forEach((e, i) => {
    if (e.kind === "circle") {
      const dc = Math.hypot(p.x - e.c[0], p.y - e.c[1]);
      // 圆心优先（点在圆心附近就直接选圆）
      if (dc < Math.min(tol, e.r * 0.5) && dc < bd) { bd = dc; best = { kind: "circle", e: i }; }
      const dEdge = Math.abs(dc - e.r);
      if (dEdge < bd) { bd = dEdge; best = { kind: "circle", e: i }; }
      return;
    }
    const n = segCountOf(e);
    for (let k = 0; k < n; k++) {
      const ep = lineEndpoints(e, k);
      if (!ep) continue;
      const d = distToSeg(p, ep.a, ep.b);
      if (d < bd) { bd = d; best = { kind: "line", e: i, seg: k }; }
    }
  });
  return bd <= tol ? best : null;
}

/** 元素的可读名字（状态栏与约束列表用） */
export function elementName(sketch, sel) {
  if (!sel) return "?";
  if (sel.kind === "projPoint") return sel.label || "模型点";
  if (sel.kind === "projLine") return sel.label || "模型边";
  const e = sketch.entities[sel.e];
  if (!e) return "?";
  const kindName = e.kind === "rect" ? "矩形" : e.kind === "circle" ? "圆" : "折线";
  if (sel.kind === "circle") return `${kindName} #${sel.e + 1}`;
  if (sel.kind === "line") {
    const side = e.kind === "rect" ? ["下", "右", "上", "左"][((sel.seg % 4) + 4) % 4] : `第${sel.seg + 1}段`;
    return `${kindName} #${sel.e + 1} 的${e.kind === "rect" ? side + "边" : side}`;
  }
  if (sel.kind === "point") return `${kindName} #${sel.e + 1} 的${{ bl: "左下角", br: "右下角", tr: "右上角", tl: "左上角", center: "圆心" }[sel.p] || sel.p}`;
  return kindName;
}

/** 同一个元素吗（判断"再点一次取消选择"） */
export function sameElement(a, b) {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  // 投影元素没有实体下标，按坐标比
  if (a.kind === "projLine") {
    return !!a.a && !!b.a && Math.abs(a.a[0] - b.a[0]) < 1e-6 && Math.abs(a.a[1] - b.a[1]) < 1e-6
      && Math.abs(a.b[0] - b.b[0]) < 1e-6 && Math.abs(a.b[1] - b.b[1]) < 1e-6;
  }
  if (a.kind === "projPoint") {
    return !!a.p && !!b.p && Math.abs(a.p[0] - b.p[0]) < 1e-6 && Math.abs(a.p[1] - b.p[1]) < 1e-6;
  }
  return a.e === b.e && a.seg === b.seg && a.p === b.p;
}

/** 点到直线（无限延长）的距离 */
function pointToLineDist(P, line) {
  if (!line.dir) return Math.hypot(P[0] - line.a[0], P[1] - line.a[1]);
  const vx = P[0] - line.a[0], vy = P[1] - line.a[1];
  return Math.abs(vx * line.dir[1] - vy * line.dir[0]);   // |v × dir|
}

/** 两直线的夹角（度，0~90） */
function angleBetween(l1, l2) {
  if (!l1.dir || !l2.dir) return null;
  const c = Math.abs(l1.dir[0] * l2.dir[0] + l1.dir[1] * l2.dir[1]);
  return (Math.acos(Math.min(1, c)) * 180) / Math.PI;
}

/** 两条线平行吗（夹角 < 0.5°） */
export function isParallel(l1, l2) {
  const a = angleBetween(l1, l2);
  return a != null && a < 0.5;
}

/** 两条线的夹角（度）—— 关系面板要显示当前值，所以导出 */
export function lineAngle(l1, l2) { return angleBetween(l1, l2); }

// ---------------------------------------------------------------- 从动尺寸的测量定义
/*
 * 从动尺寸（driven / reference dimension）的要点：**它测的是几何，不是记住一个数**。
 * 所以这里存的是「测什么」的定义（可序列化），每次绘制时现算值 ——
 * 这样几何一变、值自动跟着变，而且**不进约束列表、不参与求解**。
 *
 * 定义形如：
 *   { kind:"diameter", e:1 }
 *   { kind:"dist2pt",   a:{e,p}, b:{e,p} }
 *   { kind:"dist2line", a:{e,p}, line:[[x,y],[x,y]] }        // 线是常量（模型投影来的）
 *   { kind:"dist2sketchline", a:{e,p}, l:{e,seg} }           // 线是草图图元，会动
 *   { kind:"angle2line", l:{e,seg}, ref:[[x,y],[x,y]] }
 */

/** 求一个从动标注的当前值 + 屏幕绘制所需的几何 */
export function evalMeasure(sketch, m) {
  if (!m || !sketch) return null;
  const num = (x) => (typeof x === "number" && isFinite(x) ? x : null);

  if (m.kind === "diameter") {
    const e = sketch.entities[m.e];
    if (!e || e.kind !== "circle") return null;
    return { value: e.r * 2, radius: e.r, center: [e.c[0], e.c[1]], display: { mode: "diameter", center: [e.c[0], e.c[1]], r: e.r } };
  }

  if (m.kind === "dist2pt") {
    const A = resolveAnyRef(sketch, m.a), B = resolveAnyRef(sketch, m.b);
    if (!A || !B) return null;
    return { value: Math.hypot(A[0] - B[0], A[1] - B[1]), display: { mode: "linear", a: A, b: B } };
  }

  if (m.kind === "dist2line") {
    const A = resolveAnyRef(sketch, m.a);
    if (!A || !Array.isArray(m.line) || m.line.length < 2) return null;
    const [L1, L2] = m.line;
    const dx = L2[0] - L1[0], dy = L2[1] - L1[1];
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) return null;
    const d = Math.abs((A[0] - L1[0]) * dy - (A[1] - L1[1]) * dx) / L;
    // 垂足：尺寸线垂直于被量的线
    const t = ((A[0] - L1[0]) * dx + (A[1] - L1[1]) * dy) / (L * L);
    const foot = [L1[0] + t * dx, L1[1] + t * dy];
    return { value: d, display: { mode: "pointLine", p: A, a: L1, b: L2, foot } };
  }

  if (m.kind === "dist2sketchline") {
    const A = resolveAnyRef(sketch, m.a);
    const line = geometryOf(sketch, m.l);
    if (!A || !line || line.kind !== "line") return null;
    const d = Math.abs((A[0] - line.a[0]) * line.dir[1] - (A[1] - line.a[1]) * line.dir[0]);
    return { value: d, display: { mode: "pointLine", p: A, a: line.a, b: line.b } };
  }

  if (m.kind === "angle2line") {
    const line = geometryOf(sketch, m.l);
    if (!line || line.kind !== "line" || !Array.isArray(m.ref) || m.ref.length < 2) return null;
    const d2 = [m.ref[1][0] - m.ref[0][0], m.ref[1][1] - m.ref[0][1]];
    const L2 = Math.hypot(d2[0], d2[1]);
    if (L2 < 1e-9) return null;
    const u2 = [d2[0] / L2, d2[1] / L2];
    const c = Math.abs(line.dir[0] * u2[0] + line.dir[1] * u2[1]);
    const deg = (Math.acos(Math.min(1, c)) * 180) / Math.PI;
    return { value: deg, display: { mode: "angle", v: line.a, dir1: line.dir, dir2: u2 } };
  }

  return null;
}

/**
 * 解析一个引用：既支持 {e,p} 这种草图图元的具名点，也支持 {e:null, at:[x,y]} 的常量点。
 * （和 main.js 里的 resolveRef 同语义，放在这里让求值不依赖界面层）
 */
export function resolveAnyRef(sketch, ref) {
  if (!ref || !sketch) return null;
  if (ref.e === null && Array.isArray(ref.at)) return ref.at;
  const e = sketch.entities[ref.e];
  if (!e) return null;
  const cs = candidatesOf(e, ref.e);
  const hit = cs.find((c) => c.ref && c.ref.p === ref.p);
  return hit ? hit.p : null;
}

/**
 * 根据选中的元素决定标什么 —— 这是「智能」的核心。
 * @returns { type, value, spec, label } 或 { error }
 */
export function smartRule(sketch, sels) {
  if (!sels || sels.length < 1 || sels.length > 2) return { error: "请选择一个或两个元素" };
  const geos = sels.map((s) => geometryOf(sketch, s)).filter(Boolean);
  if (geos.length !== sels.length) return { error: "有元素取不到几何" };

  // ---- 只选了一个 ----
  if (geos.length === 1) {
    const g = geos[0];
    if (g.kind === "circle") {
      return { type: "diameter", value: g.r * 2, label: `直径 ${(g.r * 2).toFixed(2)}`,
               spec: g.fixed ? null : { type: "fixed", e: sels[0].e, k: "r", value: g.r, label: `直径 ${(g.r * 2).toFixed(2)}` },
               measure: { kind: "diameter", e: sels[0].e },
               display: { mode: "diameter", center: g.center, r: g.r } };
    }
    if (g.kind === "line") {
      return { type: "length", value: g.len, label: `长度 ${g.len.toFixed(2)}`,
               spec: g.fixed ? null : { type: "distance", a: g.refA, b: g.refB, value: +g.len.toFixed(3), label: `长度 ${g.len.toFixed(2)}` },
               display: { mode: "linear", a: g.a, b: g.b } };
    }
    return { error: "单个点没法标注，再选一个元素" };
  }

  // ---- 选了两个 ----
  const [g1, g2] = geos;
  const kinds = [g1.kind, g2.kind].sort().join("+");

  // 点 + 点 → 距离
  if (kinds === "point+point") {
    const d = Math.hypot(g1.p[0] - g2.p[0], g1.p[1] - g2.p[1]);
    const moving = g1.fixed ? g2 : g1, reference = g1.fixed ? g1 : g2;
    const spec = g1.fixed && g2.fixed ? null : reference.fixed
      ? { type: "distToFixedPoint", p: moving.ref, at: reference.p, value: +d.toFixed(3), label: `距离 ${d.toFixed(2)}` }
      : { type: "distance", a: g1.ref, b: g2.ref, value: +d.toFixed(3), label: `距离 ${d.toFixed(2)}` };
    return { type: "distance", value: d, label: `距离 ${d.toFixed(2)}`,
             spec,
             /*
              * 从动尺寸要用的「测量定义」：记下**测的是哪两点**。
              * 引用来的点（fixed）存成常量 {e:null, at:[x,y]}，草图上的点存 {e,p} ——
              * 这样几何一变，从动值能跟着重算（而不是记住一个过期的数）。
              */
             measure: {
               kind: "dist2pt",
               a: g1.fixed ? { e: null, at: [g1.p[0], g1.p[1]] } : g1.ref,
               b: g2.fixed ? { e: null, at: [g2.p[0], g2.p[1]] } : g2.ref,
             },
             display: { mode: "linear", a: g1.p, b: g2.p } };
  }

  // 圆 + 圆 → 圆心距
  if (kinds === "circle+circle") {
    const d = Math.hypot(g1.center[0] - g2.center[0], g1.center[1] - g2.center[1]);
    return { type: "distance", value: d, label: `圆心距 ${d.toFixed(2)}`,
             spec: { type: "distance", a: { e: sels[geos.indexOf(g1)].e, p: "center" },
                     b: { e: sels[geos.indexOf(g2)].e, p: "center" }, value: +d.toFixed(3), label: `圆心距 ${d.toFixed(2)}` },
             display: { mode: "linear", a: g1.center, b: g2.center } };
  }

  // 线 + 线 → 平行则标线距，不平行则标角度
  if (kinds === "line+line") {
    if (!g1.dir || !g2.dir) return { error: "零长度直线不能标注夹角或线距" };
    if (isParallel(g1, g2)) {
      /*
       * 线距 = **一条线的端点到另一条线**的距离（SolidWorks 也是这么定义的）。
       *
       * ⚠ 早先的写法是 `{a: g1.refA, b: g2.refA}` —— 那是"两个点的距离"，
       * 语义完全不对：渲染时直接连这两点，于是画出两条斜着的界线、尺寸也是歪的
       * （用户实测报的"多了两条斜线、尺寸是歪的"）。
       * 而且引用来的折线是 48 点采样，`p0` 更是随便哪个端点。
       */
      const d = pointToLineDist(g1.a, g2);
      // display 用垂足：尺寸线要**垂直于**被量的那条线，不能连两个端点
      const disp = { mode: "perpendicular", from: g1.a, lineA: g2.a, lineB: g2.b };
      // 两边都是常量参考（引用来的）→ 只能给从动尺寸；给可驱动约束会拿到 null 端点，
      // 求解器到时候会抛 "Cannot read properties of null"（实测踩到）
      if (g1.fixed && g2.fixed) {
        return { type: "distance", value: d, label: `线距 ${d.toFixed(2)}（参考）`, spec: null, display: disp };
      }
      // 一边能动（草图自己的线）：量"动的那条的一个端点到不动的那条线"
      const moving = g1.fixed ? g2 : g1;
      const refLine = g1.fixed ? g1 : g2;
      if (!moving.refA || !refLine.fixed) {
        // 参考线不是 fixed（两边都在动）：没有合适的单侧约束，给从动尺寸
        return { type: "distance", value: d, label: `线距 ${d.toFixed(2)}`, spec: null, display: disp };
      }
      return { type: "distance", value: d, label: `线距 ${d.toFixed(2)}`,
               spec: { type: "pointToLine", p: moving.refA,
                       l1: { e: null, at: refLine.a }, l2: { e: null, at: refLine.b },
                       value: +d.toFixed(3), label: `线距 ${d.toFixed(2)}` },
               display: disp };
    }
    const ang = angleBetween(g1, g2);
    const moving = g1.fixed ? g2 : g1, reference = g1.fixed ? g1 : g2;
    const spec = g1.fixed && g2.fixed ? null : reference.fixed
      ? { type: "angleToFixedLine", l: sels[geos.indexOf(moving)], ref: [reference.a, reference.b], value: +ang.toFixed(3), label: `角度 ${ang.toFixed(2)}°` }
      : { type: "angle", l1: sels[0], l2: sels[1], value: +ang.toFixed(3), label: `角度 ${ang.toFixed(2)}°` };
    return { type: "angle", value: ang, label: `角度 ${ang.toFixed(2)}°`,
             spec,
             display: { mode: "angle", v: g1.a, dir1: g1.dir, dir2: g2.dir } };
  }

  // ---- 带「模型投影」参考的标注：参考是常量，只让草图那侧动 ----
  const fixedOne = geos.find((g) => g.fixed);
  if (fixedOne) {
    const other = geos.find((g) => g !== fixedOne);
    const oi = geos.indexOf(other);
    // 草图点 → 投影点的距离
    if (fixedOne.kind === "point" && other && other.kind === "point") {
      const d = Math.hypot(other.p[0] - fixedOne.p[0], other.p[1] - fixedOne.p[1]);
      return {
        type: "distance", value: d, label: `到模型点 ${d.toFixed(2)}`,
        spec: { type: "distToFixedPoint",
                p: { e: sels[oi].e, p: sels[oi].p },
                at: fixedOne.p, value: +d.toFixed(3), label: `到模型点 ${d.toFixed(2)}` },
        display: { mode: "linear", a: other.p, b: fixedOne.p },
      };
    }
    // 草图点 → 投影线 的距离
    if (fixedOne.kind === "line" && other && other.kind === "point") {
      const d = pointToLineDist(other.p, fixedOne);
      return {
        type: "distance", value: d, label: `到模型边 ${d.toFixed(2)}`,
        spec: { type: "distToFixedLine",
                p: { e: sels[oi].e, p: sels[oi].p },
                line: [fixedOne.a, fixedOne.b], value: +d.toFixed(3), label: `到模型边 ${d.toFixed(2)}` },
        display: { mode: "pointLine", p: other.p, a: fixedOne.a, b: fixedOne.b },
      };
    }
    /*
     * **圆 + 引用线**：标"圆心到那条引用线"的距离。
     *
     * 这一条之前漏了 —— 于是"选圆心 + 选引用线"掉进后面通用的 circle+line 分支，
     * 那个分支生成的是"圆心到**草图线的端点**"，而引用线没有可寻址端点（refA 是 null），
     * 约束静默地没建起来，改数值圆纹丝不动（用户实测报的就是这个）。
     */
    if (fixedOne.kind === "line" && other && other.kind === "circle") {
      const d = pointToLineDist(other.center, fixedOne);
      return {
        type: "distance", value: d, label: `圆心到模型边 ${d.toFixed(2)}`,
        spec: { type: "distToFixedLine",
                p: { e: sels[oi].e, p: "center" },
                line: [fixedOne.a, fixedOne.b], value: +d.toFixed(3), label: `圆心到模型边 ${d.toFixed(2)}` },
        measure: { kind: "dist2line", a: { e: sels[oi].e, p: "center" }, line: [fixedOne.a, fixedOne.b] },
        display: { mode: "pointLine", p: other.center, a: fixedOne.a, b: fixedOne.b },
      };
    }
    // 草图线 → 投影线 的角度
    if (fixedOne.kind === "line" && other && other.kind === "line") {
      const ang = angleBetween(fixedOne, other);
      return {
        type: "angle", value: ang, label: `与模型边 ${ang.toFixed(2)}°`,
        spec: { type: "angleToFixedLine", l: sels[oi], ref: [fixedOne.a, fixedOne.b],
                value: +ang.toFixed(3), label: `与模型边 ${ang.toFixed(2)}°` },
        display: { mode: "angle", v: fixedOne.a, dir1: fixedOne.dir, dir2: other.dir },
      };
    }
    /*
     * 两个都是引用/固定参考 → 只能给**从动尺寸**（spec: null）。
     * 数学上必须这样：两边都不动，改了这个数也没有任何东西会跟着变。
     * SolidWorks 里这种尺寸会自动标成"从动/参考尺寸"，也是这个道理。
     */
    if (geos.every((g) => g.fixed)) {
      if (geos[0].kind === "line" && geos[1].kind === "line") {
        // 平行 → 线距；不平行 → 夹角
        if (isParallel(geos[0], geos[1])) {
          const d = pointToLineDist(geos[0].a, geos[1]);
          return { type: "distance", value: d, label: `线距 ${d.toFixed(2)}（参考）`, spec: null,
                   display: { mode: "perpendicular", from: geos[0].a, lineA: geos[1].a, lineB: geos[1].b } };
        }
        const ang = angleBetween(geos[0], geos[1]);
        return { type: "angle", value: ang, label: `夹角 ${ang.toFixed(2)}°（参考）`, spec: null,
                 display: { mode: "angle", v: geos[0].a, dir1: geos[0].dir, dir2: geos[1].dir } };
      }
      if (geos[0].kind === "point" && geos[1].kind === "point") {
        const d = Math.hypot(geos[1].p[0] - geos[0].p[0], geos[1].p[1] - geos[0].p[1]);
        return { type: "distance", value: d, label: `距离 ${d.toFixed(2)}（参考）`, spec: null,
                 display: { mode: "linear", a: geos[0].p, b: geos[1].p } };
      }
      return { error: "两边都是引用参考，只能量出数值、不能用来约束别的元素" };
    }
  }

  // 圆 + 线 → 圆心到线的距离
  if (kinds === "circle+line") {
    const c = g1.kind === "circle" ? g1 : g2;
    const l = g1.kind === "line" ? g1 : g2;
    const ci = geos.indexOf(c), li = geos.indexOf(l);
    // 线是引用/固定参考、但没走到上面 fixed 分支的情况：用常量端点，别拿 null 去建约束
    if (l.fixed) {
      const d2 = pointToLineDist(c.center, l);
      return {
        type: "distance", value: d2, label: `圆心到模型边 ${d2.toFixed(2)}`,
        spec: { type: "distToFixedLine", p: { e: sels[ci].e, p: "center" },
                line: [l.a, l.b], value: +d2.toFixed(3), label: `圆心到模型边 ${d2.toFixed(2)}` },
        display: { mode: "pointLine", p: c.center, a: l.a, b: l.b },
      };
    }
    const d = pointToLineDist(c.center, l);
    return { type: "distance", value: d, label: `圆心到线 ${d.toFixed(2)}`,
             spec: { type: "pointToLine", p: { e: sels[ci].e, p: "center" }, l1: l.refA, l2: l.refB,
                     value: +d.toFixed(3), label: `圆心到线 ${d.toFixed(2)}` },
             display: { mode: "pointLine", p: c.center, a: l.a, b: l.b } };
  }

  // 点 + 线 → 点到线距离
  if (kinds === "line+point") {
    const p = g1.kind === "point" ? g1 : g2;
    const l = g1.kind === "line" ? g1 : g2;
    const d = pointToLineDist(p.p, l);
    return { type: "distance", value: d, label: `点到线 ${d.toFixed(2)}`,
             spec: { type: "pointToLine", p: p.fixed ? { e: null, at: p.p } : p.ref, l1: l.refA, l2: l.refB, value: +d.toFixed(3), label: `点到线 ${d.toFixed(2)}` },
             display: { mode: "pointLine", p: p.p, a: l.a, b: l.b } };
  }

  // 点 + 圆 → 点到圆心的距离
  if (kinds === "circle+point") {
    const p = g1.kind === "point" ? g1 : g2;
    const c = g1.kind === "circle" ? g1 : g2;
    const ci = geos.indexOf(c);
    const d = Math.hypot(p.p[0] - c.center[0], p.p[1] - c.center[1]);
    return { type: "distance", value: d, label: `距离 ${d.toFixed(2)}`,
             spec: { type: "distance", a: p.ref, b: { e: sels[ci].e, p: "center" },
                     value: +d.toFixed(3), label: `距离 ${d.toFixed(2)}` },
             display: { mode: "linear", a: p.p, b: c.center } };
  }

  return { error: `这两个元素的组合暂时标不了（${kinds}）` };
}
