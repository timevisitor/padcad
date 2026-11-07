/**
 * 草图几何 + 草图编辑（B 批 P0-2）
 *
 * 这一层刻意做成**纯函数**：输入草图数据/实体数组，返回新实体或新数组，
 * 不读 DOM、不引用 SketchSession 实例。理由：
 *   1) 回归脚本能直接 node 跑，不用起浏览器，判据可以写成面积/体积断言；
 *   2) 接 UI 时只是把返回值塞回 sketch.entities，工具层（点按、预览）随便换实现；
 *   3) 变换类操作必须「原件不动」——纯函数天然满足，调用方要保留原件就别删。
 *
 * 图元表示沿用现有 3 种 kind（rect / circle / polyline），新几何一律是闭合 polyline，
 * 因为约束、捕捉、偏移、拉伸、工程保存都只认这几种。
 */
import {
  polygonPoints, slotPoints, arcThroughPoints, ellipsePoints, toPolylineEntity,
} from "./shapes2d.js";

const TAU = Math.PI * 2;
/** 剪断点允许偏离被剪线段的距离（mm）。UI 传来的点经过捕捉，通常差不到 1µm；留 10µm 给浮点与手绘误差 */
const TRIM_TOL = 1e-2;
/** 变换矩阵判定「轴对齐」的阈值：低于它才允许矩形继续用 rect 表示 */
const AXIS_TOL = 1e-9;

// ------------------------------------------------------------------ 入参校验
/* 报错文案一律中文并且说清是哪个参数 —— 草图工具的参数来自面板输入，用户看不懂英文键名。 */

function assertSketch(sketch) {
  if (!sketch || !Array.isArray(sketch.entities)) throw new Error("草图数据无效：缺少 entities 数组");
  return sketch;
}

function num(v, label) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${label}必须是有限数字`);
  return v;
}

function point(v, label) {
  if (!Array.isArray(v) || v.length < 2) throw new Error(`${label}必须是 [x, y] 形式的点`);
  return [num(v[0], `${label}的 x`), num(v[1], `${label}的 y`)];
}

const cloneEntity = (e) => structuredClone(e);

// ------------------------------------------------------------------ 新增图元
/*
 * 四个 add* 都**就地追加**到 sketch.entities 并返回新图元。
 * 为什么允许就地改：绘制工具是「一次操作 = 一个图元」，撤消栈由调用方整条记录快照，
 * 再返回一份新数组反而让调用方多一次赋值（且容易漏）。
 */

/** 正多边形（rotation 用弧度，与 shapes2d 一致）；inscribed=true 顶点在半径上，false 则边心距 = r */
export function addPolygon(sketch, { center = [0, 0], r, sides = 6, rotation = 0, inscribed = true } = {}) {
  assertSketch(sketch);
  const c = point(center, "多边形中心");
  const R = num(r, "多边形半径");
  if (!(R > 0)) throw new Error("多边形半径必须大于 0");
  const n = num(sides, "多边形边数");
  if (!Number.isInteger(n) || n < 3) throw new Error("多边形边数必须是 ≥3 的整数");
  const rot = num(rotation, "多边形转角（弧度）");
  const e = toPolylineEntity(
    polygonPoints({ center: c, r: R, sides: n, rotation: rot, inscribed: !!inscribed }),
  );
  sketch.entities.push(e);
  return e;
}

/** 槽口（腰形孔）：a、b 是两个圆心，r 是半径 */
export function addSlot(sketch, { a, b, r, segments } = {}) {
  assertSketch(sketch);
  const pa = point(a, "槽口起点圆心");
  const pb = point(b, "槽口终点圆心");
  const R = num(r, "槽口半径");
  if (!(R > 0)) throw new Error("槽口半径必须大于 0");
  const e = toPolylineEntity(
    slotPoints({ a: pa, b: pb, r: R, ...(segments ? { segments: num(segments, "槽口采样段数") } : {}) }),
  );
  sketch.entities.push(e);
  return e;
}

/**
 * 三点圆弧。
 *
 * 实体是**开口**折线（closed:false）：圆弧不是闭合轮廓，标成闭合会让拉伸把弦也当成边，
 * 多出一块面积。要拿去拉伸得自己先补弦闭合。
 */
export function addArc(sketch, { p1, p2, p3, segments } = {}) {
  assertSketch(sketch);
  const a = point(p1, "圆弧起点");
  const m = point(p2, "圆弧中间点");
  const b = point(p3, "圆弧终点");
  const { points } = arcThroughPoints(a, m, b, segments ? { segments: num(segments, "圆弧采样段数") } : {});
  const e = toPolylineEntity(points, { closed: false });
  sketch.entities.push(e);
  return e;
}

/** 椭圆（rotation 用弧度，绕中心转） */
export function addEllipse(sketch, { center = [0, 0], rx, ry, rotation = 0, segments } = {}) {
  assertSketch(sketch);
  const c = point(center, "椭圆中心");
  const RX = num(rx, "椭圆长半轴");
  const RY = num(ry, "椭圆短半轴");
  if (!(RX > 0) || !(RY > 0)) throw new Error("椭圆两个半轴都要大于 0");
  const rot = num(rotation, "椭圆转角（弧度）");
  const e = toPolylineEntity(
    ellipsePoints({ center: c, rx: RX, ry: RY, rotation: rot, ...(segments ? { segments: num(segments, "椭圆采样段数") } : {}) }),
  );
  sketch.entities.push(e);
  return e;
}

// ------------------------------------------------------------------ 剪断
/** 折线的段数：闭合折线含「末点回到首点」那一段 */
const segCountOf = (e) => (e.closed ? e.pts.length : e.pts.length - 1);

/**
 * 把一条折线的第 seg 段在 cutPoint 处剪断。
 *
 * 两种结果：
 *   - 开口折线 → 剪成两段（各保留一个切点，长度之和 = 原长）；
 *   - 闭合折线 → 一刀剪开成一个开口一笔（首尾都是切点，周长不变）。
 * 切点正好落在已有顶点上时**原样返回**：那里本来就是端点，再剪只会得到零长度碎片。
 *
 * 其它实体一律结构化克隆，绝不共享引用 —— 不然上层改一处会连带改到别处。
 */
export function trimSegment(entities, { e, seg } = {}, cutPoint) {
  if (!Array.isArray(entities)) throw new Error("图元列表无效");
  const idx = num(e, "要剪的图元下标");
  if (!Number.isInteger(idx) || idx < 0 || idx >= entities.length) {
    throw new Error(`图元下标 ${idx} 超出范围（0…${entities.length - 1}）`);
  }
  const src = entities[idx];
  if (!src || src.kind !== "polyline") throw new Error("只能按段剪断折线（矩形/圆请先转成折线）");
  if (!Array.isArray(src.pts) || src.pts.length < 2) throw new Error("这条折线至少要有两个点");

  const nSeg = segCountOf(src);
  const s = num(seg, "要剪的段号");
  if (!Number.isInteger(s) || s < 0 || s >= nSeg) throw new Error(`段号 ${s} 超出范围（0…${nSeg - 1}）`);

  const q = point(cutPoint, "剪断点");
  const a = src.pts[s];
  const b = src.closed ? src.pts[(s + 1) % src.pts.length] : src.pts[s + 1];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) throw new Error("这一段长度为 0（相邻两点重合），剪不断");

  // 投影并夹紧：面板点选的位置总带零点几微米的抖动，不能因此拒绝
  const t = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (len * len);
  const tc = Math.min(1, Math.max(0, t));
  const cut = [a[0] + tc * dx, a[1] + tc * dy];
  const off = Math.hypot(q[0] - cut[0], q[1] - cut[1]);
  if (off > TRIM_TOL) throw new Error(`剪断点偏离该段 ${off.toFixed(3)}mm，超过 ${TRIM_TOL}mm 容差`);

  const out = entities.map(cloneEntity);
  // 切点就是端点（含夹紧到端点的情况）：那里本来就是顶点，再剪只会得到零长度碎片
  if (tc < 1e-12 || tc > 1 - 1e-12) return out;

  const piece = (pts) => {
    const c = cloneEntity(src);
    c.pts = pts;
    c.closed = false;
    return c;
  };

  let pieces;
  if (src.closed) {
    // 从切点绕一圈回到切点：切点→下一点…→本段起点→切点，长度正好等于原周长
    const ring = [cut];
    for (let k = 1; k <= src.pts.length; k++) ring.push([...src.pts[(s + k) % src.pts.length]]);
    ring.push(cut);
    pieces = [piece(ring)];
  } else {
    pieces = [
      piece([...src.pts.slice(0, s + 1).map((p) => [...p]), cut]),
      piece([cut, ...src.pts.slice(s + 1).map((p) => [...p])]),
    ];
  }
  out.splice(idx, 1, ...pieces);
  return out;
}

// ------------------------------------------------------------------ 变换底座
/**
 * 仿射变换：M 是 2×2 线性部分，t 是平移。
 * 单独抽出来是因为镜像/线性阵列/圆周阵列本质都是它，只有矩阵不同 ——
 * 三份各写一遍顶点循环，出过一个「只改了 x 忘了 y」的 bug 就很难看出来。
 */
function makeXform(M, t = [0, 0]) {
  const det = M[0][0] * M[1][1] - M[0][1] * M[1][0];
  const axisAligned = Math.abs(M[0][1]) < AXIS_TOL && Math.abs(M[1][0]) < AXIS_TOL;
  return {
    map: ([x, y]) => [M[0][0] * x + M[0][1] * y + t[0], M[1][0] * x + M[1][1] * y + t[1]],
    /** 镜像/翻转会改顶点绕向，闭合轮廓要反过来，否则下游判方向会反 */
    flip: det < 0,
    axisAligned,
    M,
  };
}

const rotXform = (deg, center = [0, 0]) => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const cx = center[0], cy = center[1];
  return makeXform([[c, -s], [s, c]], [cx - c * cx + s * cy, cy - s * cx - c * cy]);
};

/** 把 2×2 矩阵作用到单个实体上（返回新实体，不改入参） */
function transformEntity(e, xf) {
  const out = cloneEntity(e);
  if (out.kind === "polyline") {
    out.pts = out.pts.map(xf.map);
    if (xf.flip && out.closed) out.pts.reverse();
    return out;
  }
  if (out.kind === "circle") {
    // 圆各向同性：镜像/旋转后还是圆，只动圆心，半径不变（转成折线会让孔不再是孔）
    out.c = xf.map(out.c);
    return out;
  }
  if (out.kind === "rect") {
    const [cx, cy] = xf.map(out.c);
    if (xf.axisAligned) {
      // 轴对齐变换下矩形仍是轴对齐矩形，宽高按矩阵元素缩放（90° 旋转时互换）
      const M = xf.M;
      const w = Math.abs(M[0][0]) * out.w + Math.abs(M[0][1]) * out.h;
      const h = Math.abs(M[1][0]) * out.w + Math.abs(M[1][1]) * out.h;
      out.c = [cx, cy];
      out.w = w;
      out.h = h;
      return out;
    }
    // 斜轴镜像/任意角度旋转：轴对齐表示撑不住，转成自由折线
    const hw = out.w / 2, hh = out.h / 2;
    return {
      kind: "polyline",
      pts: [
        [out.c[0] - hw, out.c[1] - hh], [out.c[0] + hw, out.c[1] - hh],
        [out.c[0] + hw, out.c[1] + hh], [out.c[0] - hw, out.c[1] + hh],
      ].map(xf.map),
      closed: true,
    };
  }
  throw new Error("未知的草图图元：" + out.kind);
}

/** 镜像轴解析：'x' / 'y' / [[x1,y1],[x2,y2]] */
function mirrorXform(axis) {
  if (axis === "x" || axis === "y") {
    // axis:'x' = 关于 x 轴镜像（y 取反）；'y' = 关于 y 轴镜像（x 取反）
    return axis === "x" ? makeXform([[1, 0], [0, -1]]) : makeXform([[-1, 0], [0, 1]]);
  }
  if (!Array.isArray(axis) || axis.length !== 2) {
    throw new Error("镜像轴只能是 'x'、'y' 或两个点 [[x1,y1],[x2,y2]]");
  }
  const p1 = point(axis[0], "镜像轴第一点");
  const p2 = point(axis[1], "镜像轴第二点");
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) throw new Error("镜像轴的两个点重合了");
  const ux = dx / L, uy = dy / L;
  // P' = 2·(v·u)u − v + p1，矩阵形式 I − 2·n·nᵀ（n 为法向）
  const M = [
    [1 - 2 * uy * uy, 2 * ux * uy],
    [2 * ux * uy, 1 - 2 * ux * ux],
  ];
  const t = [p1[0] - (M[0][0] * p1[0] + M[0][1] * p1[1]), p1[1] - (M[1][0] * p1[0] + M[1][1] * p1[1])];
  return makeXform(M, t);
}

// ------------------------------------------------------------------ 镜像 / 阵列
/**
 * 镜像：原件保留，镜像件追加在后面。
 * 返回**整份新数组**（原件也是克隆），这样调用方拿到的东西和原数组没有任何共享引用。
 */
export function mirrorEntities(entities, { axis = "x" } = {}) {
  if (!Array.isArray(entities)) throw new Error("图元列表无效");
  const xf = mirrorXform(axis);
  const out = entities.map(cloneEntity);
  out.push(...entities.map((e) => transformEntity(e, xf)));
  return out;
}

/**
 * 阵列：count **含原件**（与草图面板的「数量」语义一致，填 3 就是 3 个）。
 *   - linear：沿 (dx, dy) 等距排 count 份；
 *   - circular：绕 center 转，angle=360 时整除一圈（首尾不重叠），否则按 (count−1) 等分角度区间。
 */
export function patternEntities(entities, { mode = "linear", count, dx = 0, dy = 0, center = [0, 0], angle = 360 } = {}) {
  if (!Array.isArray(entities)) throw new Error("图元列表无效");
  const n = num(count, "阵列数量");
  if (!Number.isInteger(n) || n < 2) throw new Error("阵列数量必须是 ≥2 的整数（含原件）");
  const out = entities.map(cloneEntity);

  if (mode === "linear") {
    const sx = num(dx, "线性阵列 X 间距");
    const sy = num(dy, "线性阵列 Y 间距");
    if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) throw new Error("线阵间距不能都为 0（那样会重叠成一堆）");
    for (let k = 1; k < n; k++) {
      const xf = makeXform([[1, 0], [0, 1]], [k * sx, k * sy]);
      out.push(...entities.map((e) => transformEntity(e, xf)));
    }
    return out;
  }

  if (mode === "circular") {
    const c = point(center, "圆周阵列中心");
    const total = num(angle, "圆周阵列角度（度）");
    if (Math.abs(total) < 1e-9) throw new Error("圆周阵列角度不能为 0");
    // 整圈时用 360/count（末件与原件不重合）；只铺一段圆弧时用 angle/(count−1) 把两端占满
    const full = Math.abs(total) >= 360 - 1e-9;
    const step = full ? total / n : total / (n - 1);
    for (let k = 1; k < n; k++) {
      out.push(...entities.map((e) => transformEntity(e, rotXform(step * k, c))));
    }
    return out;
  }

  throw new Error("阵列模式只能是 linear 或 circular");
}

/** 供上层（面板预览）复用：折线周长，剪断测试也用它做长度守恒判据 */
export function pathLength(pts, closed = false) {
  if (!Array.isArray(pts) || pts.length < 2) return 0;
  let L = 0;
  for (let i = 0; i < pts.length - 1; i++) L += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  if (closed) {
    const a = pts[pts.length - 1], b = pts[0];
    L += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return L;
}

export { TAU };
