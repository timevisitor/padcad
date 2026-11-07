/**
 * 建模操作层 —— Shapr3D 式「直接建模」的核心操作
 *
 * 两条硬性经验（都是实测踩出来的）：
 *  1. replicad 1.1.0 的 basicFaceExtrusion 是坏的（必崩在 BRepPrimAPI_MakePrism），
 *     必须下探到 OCCT 原生类，并保持 maker/vec/shape 的 JS 引用，否则会被 embind 析构。
 *  2. 绝不跨操作复用 face 引用 —— 每次都用 faceId 重新查面，否则第二次就报
 *     "This object has been deleted"。连续 20 帧稳定性的关键就在这里。
 *
 * 精度：不做骑跨补偿（EPS=0），OCCT 的共面布尔运算处理得很好，实测误差为 0。
 */
import { getOC, cast, makeCylinder, makeBox, makeBaseBox, makePlane, importSTEP, measureVolume, DistanceQuery } from "replicad";
import { coneSolid } from "./primitives.js";

// ---------------------------------------------------------------- 导入与测量（看图模式用）
/** 读 STEP（Blob）→ 真实 B-rep 实体，不只是网格 */
export async function importStepBlob(blob) {
  return importSTEP(blob);
}

/**
 /**
  * 导入体缓存（A 批 P0-7）
  *
  * 为什么需要：STEP 读进来是 B-rep，但 op 定义要能序列化进工程文件。
  * OCCT 实体不能进 JSON，所以 op 里只存 id + 名字，实体挂在运行时缓存；
  * 工程重开时缓存为空 —— 这时明确报「需要重新导入」，绝不静默给个空实体。
  */
 const importedShapes = new Map();
 let importSeq = 0;
 export function registerImported(shape, name = "导入体") {
   if (!shape) throw new Error("没有可登记的导入实体");
   const id = `imp${++importSeq}`;
   importedShapes.set(id, shape);
   return { id, name };
 }
 export function importedShape(id) {
   const s = importedShapes.get(id);
   if (!s) throw new Error("导入体不在当前会话里，请重新导入这份 STEP");
   return s;
 }
 export function dropImported(id) { importedShapes.delete(id); }

 /** 面类型识别 —— 靠几何性质判，不用 OCCT 的类型枚举
 * （WASM 里 `GeomAbs_SurfaceType` 全是 undefined，`face.geomType()` 也不是函数）
 *
 * 从该面的三角形入手：
 *   法向处处相同            → 平面
 *   法向绕某轴旋转 + 到轴距离恒定 → 圆柱（半径可读，用来改直径）
 *   不垂直于同一轴           → 环面（内圆角）
 *   到轴距离线性变化         → 圆锥（倒角常见）
 *
 * 实测：孔壁识别为 cylinder R=6.000（精确），圆角面 torus，倒角面 cone，
 * 19 个面共 17ms（0.9ms/面）。
 */
export function classifyFace(mesh, faceId, centerHint = null) {
  const g = mesh?.faceGroups?.find((x) => x.faceId === faceId);
  if (!g || g.count < 1) return { kind: "unknown", why: "没有对应的三角形" };

  const verts = [], nrms = [];
  for (let i = g.start; i < g.start + g.count; i++) {
    for (let k = 0; k < 3; k++) {
      const vi = mesh.triangles[i * 3 + k];
      verts.push([mesh.vertices[vi * 3], mesh.vertices[vi * 3 + 1], mesh.vertices[vi * 3 + 2]]);
      nrms.push(V.unit([mesh.normals[vi * 3], mesh.normals[vi * 3 + 1], mesh.normals[vi * 3 + 2]]));
    }
  }
  if (verts.length < 3) return { kind: "unknown", why: "顶点太少" };

  // 法向全同 → 平面
  const n0 = nrms[0];
  let same = 0;
  for (const n of nrms) if (Math.abs(V.dot(n, n0)) > 0.999) same++;
  if (same === nrms.length) return { kind: "plane", normal: n0, tris: g.count };

  // 找轴：夹角最大的一对法向的叉积
  let axis = null, best = 0;
  const step = Math.max(1, Math.floor(nrms.length / 24));
  for (let i = 0; i < nrms.length; i += step) {
    for (let j = i + step; j < nrms.length; j += step) {
      const c = V.cross(nrms[i], nrms[j]);
      const L = Math.hypot(c[0], c[1], c[2]);
      if (L > best) { best = L; axis = [c[0] / L, c[1] / L, c[2] / L]; }
    }
  }
  if (!axis || best < 0.1) return { kind: "unknown", why: "轴算不出", tris: g.count };

  let perp = 0;
  for (const n of nrms) if (Math.abs(V.dot(n, axis)) < 0.02) perp++;
  const allPerp = perp >= nrms.length * 0.9;   // 法向是否都垂直于这个轴

  // 到**轴线**的距离。
  // 陷阱一：不能拿"两点相对位移的垂直分量"当距离 —— 同一个圆柱面上 x=+6 和 x=-6
  // 的两点会算出 12，孔壁会被误判成 r=0~12 的圆锥。
  // 陷阱二：轴心不能只靠 face.center 或顶点质心：
  //   - face.center 对**完整圆柱**正好在轴上（孔壁 center=(0,0,4) ✓），
  //     但对 90° 的圆角片段它落在**曲面上**，不是轴心（实测圆角面几何半径算出 1.76，
  //     真实是 3.0，差 70% —— 直接导致圆柱/圆锥/环面互相误判）
  //   - 顶点质心会被顶点分布拽偏
  // 所以用**最小二乘圆拟合**（Kasa 法）把轴心和半径一起解出来。
  let a0;
  if (centerHint && centerHint.every((v) => isFinite(v))) {
    const hAlong = V.dot(centerHint, axis);
    a0 = [centerHint[0] - axis[0] * hAlong, centerHint[1] - axis[1] * hAlong, centerHint[2] - axis[2] * hAlong];
  } else {
    const seen = new Set();
    const uniq = [];
    for (const p of verts) {
      const key = `${p[0].toFixed(5)},${p[1].toFixed(5)},${p[2].toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(p);
    }
    const centroid = uniq
      .reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0])
      .map((v) => v / uniq.length);
    const cAlong = V.dot(centroid, axis);
    a0 = [centroid[0] - axis[0] * cAlong, centroid[1] - axis[1] * cAlong, centroid[2] - axis[2] * cAlong];
  }

  // 用 Kasa 法在垂直于轴的平面上拟合圆，把轴心修正到真正的位置
  const fit = fitCircleKasa(verts, axis, a0);
  if (fit) a0 = fit.center;

  const dists = verts.map((p) => {
    const c = V.cross([p[0] - a0[0], p[1] - a0[1], p[2] - a0[2]], axis);
    return Math.hypot(c[0], c[1], c[2]);
  });
  // 注意别用 Math.min(...dists)：圆柱面三角形多的时候数组很长，
  // 展开运算符会爆栈（"Maximum call stack size exceeded"），
  // 而异常一旦被上层 catch 吞掉就表现为"一个圆柱面都认不出来"（实测踩过）。
  let dmin = Infinity, dmax = -Infinity, dsum = 0;
  for (const d of dists) {
    if (d < dmin) dmin = d;
    if (d > dmax) dmax = d;
    dsum += d;
  }
  const mean = dsum / dists.length;

  if (dmax - dmin < Math.max(0.02, mean * 0.02)) {
    return { kind: "cylinder", axis, axisPoint: a0, radius: mean, tris: g.count };
  }
  // 到轴距离在变化：圆锥（倒角）或环面（内圆角）。
  // 两者的"可改尺寸"都能从这段分布里读出来：
  //   环面：截面是个半径 r 的小圆，到轴距离在 [R-r, R+r] → r = 跨度/2
  //   45° 倒角圆锥：半径从 R 变到 R+d → 倒角距离 = 跨度
  const span = dmax - dmin;
  if (!allPerp) {
    return { kind: "torus", axis, axisPoint: a0, radius: span / 2, rMin: dmin, rMax: dmax, tris: g.count };
  }
  return { kind: "cone", axis, axisPoint: a0, radius: span, rMin: dmin, rMax: dmax, tris: g.count };
}

// 小向量工具（避免再拉一份 three.js 进来）
const V = {
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  unit: (a) => { const L = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / L, a[1] / L, a[2] / L]; },
};

/** 解 3×3 线性方程组（克拉默法则），奇异时返回 null */
function solve3(A, b) {
  const det = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-12) return null;
  const swap = (m, col, v) => m.map((row, i) => row.map((x, j) => (j === col ? v[i] : x)));
  const out = [];
  for (let c = 0; c < 3; c++) out.push(det(swap(A, c, b)) / D);
  return out.every((x) => isFinite(x)) ? out : null;
}

/**
 * Kasa 法最小二乘圆拟合：把面上的点拟合成一个圆，解出真正的轴心。
 *
 * 为什么需要它：`face.center` 对**完整圆柱**正好在轴上，但对 90° 的圆角片段
 * 它落在曲面上 —— 实测圆角面按它算出的半径是 1.76 而真实值 3.0（差 70%），
 * 结果圆柱/圆锥/环面互相误判、倒角面还会错配到圆角特征上。
 * 拟合把轴心修正到真位置，半径自然就准了。
 */
function fitCircleKasa(pts, axis, origin) {
  if (!pts || pts.length < 8) return null;
  // 垂直于轴的 2D 基
  const u = Math.abs(axis[0]) < 0.9
    ? V.unit(V.cross(axis, [1, 0, 0]))
    : V.unit(V.cross(axis, [0, 1, 0]));
  const v = V.cross(axis, u);

  let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxz = 0, Syz = 0, Sz = 0;
  const n = pts.length;
  for (const p of pts) {
    const d = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
    const x = V.dot(d, u), y = V.dot(d, v);
    const z = x * x + y * y;
    Sx += x; Sy += y; Sxz += x * z; Syz += y * z; Sz += z;
    Sxx += x * x; Syy += y * y; Sxy += x * y;
  }
  // 拟合 x² + y² + Dx + Ey + F = 0 → 正规方程
  const sol = solve3([[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]], [-Sxz, -Syz, -Sz]);
  if (!sol) return null;
  const [D, E] = sol;
  const cx = -D / 2, cy = -E / 2;
  const r = Math.hypot(cx, cy);
  if (!isFinite(r) || r <= 0) return null;
  const centerWorld = [
    origin[0] + u[0] * cx + v[0] * cy,
    origin[1] + u[1] * cx + v[1] * cy,
    origin[2] + u[2] * cx + v[2] * cy,
  ];
  // 轴向位置无所谓，但保持和 origin 同一高度，免得影响后续点积
  const dAlong = V.dot(centerWorld, axis) - V.dot(origin, axis);
  return {
    center: [
      centerWorld[0] - axis[0] * dAlong,
      centerWorld[1] - axis[1] * dAlong,
      centerWorld[2] - axis[2] * dAlong,
    ],
    radius: r,
  };
}

/** 取实体的三角网格（结构与 kernel.js 的 meshOf 保持一致，viewer 能直接吃） */
export function meshOfShape(shape, { tolerance = 0.08, angularTolerance = 12 } = {}) {
  const m = shape.mesh({ tolerance, angularTolerance });
  return {
    vertices: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    triangles: new Uint32Array(m.triangles),
    faceGroups: m.faceGroups.map((g) => ({
      start: g.start / 3,
      count: g.count / 3,
      faceId: g.faceId,
    })),
    triCount: m.triangles.length / 3,
  };
}

/** 体积；实体不闭合（比如只读进来的片体）时返回 0 而不是抛错 */
export function volumeOf(shape) {
  try { return measureVolume(shape); } catch (_) { return 0; }
}
// ---------------------------------------------------------------- 原生面拉伸
const _keep = [];
function keepAlive(...objs) {
  _keep.push(...objs);
  // 滚动窗口，避免无限增长（结果实体独立于这些中间对象）
  while (_keep.length > 900) _keep.splice(0, 300);
}

/** 把一个拓扑面沿 vec 拉伸成实体（底层走 OCCT BRepPrimAPI_MakePrism） */
function prismOf(face, vec) {
  const oc = getOC();
  const v = new oc.gp_Vec(vec[0], vec[1], vec[2]);
  const mk = new oc.BRepPrimAPI_MakePrism(face.wrapped, v);
  mk.Build();
  const shp = mk.Shape();
  const out = cast(shp);
  keepAlive(v, mk, shp);
  return out;
}

// ---------------------------------------------------------------- 面查询
/** 按 hashCode 找回拓扑面 */
export function findFace(shape, faceId) {
  return shape.faces.find((f) => f.hashCode === faceId) || null;
}

/** 取面在参数中心处的法向（单位向量，指向实体外侧） */
export function normalOf(face) {
  try {
    const c = face.center;
    const uv = face.uvCoordinates([c.x, c.y, c.z]);
    const n = face.normalAt(uv[0], uv[1]);
    const L = Math.hypot(n.x, n.y, n.z) || 1;
    return [n.x / L, n.y / L, n.z / L];
  } catch (_) {}
  try {
    const n = face.normalAt();
    const L = Math.hypot(n.x, n.y, n.z) || 1;
    return [n.x / L, n.y / L, n.z / L];
  } catch (_) {}
  return [0, 0, 1];
}

/** 面的几何信息（供 UI 显示） */
export function faceInfo(shape, faceId) {
  const f = findFace(shape, faceId);
  if (!f) return null;
  let center = [0, 0, 0], type = "未知";
  try { const c = f.center; center = [c.x, c.y, c.z]; } catch (_) {}
  try { type = f.geomType?.() || f.surface?.constructor?.name || "未知"; } catch (_) {}
  return { faceId, center, type, normal: normalOf(f) };
}

// ---------------------------------------------------------------- 推拉面
/**
 * 推拉面 —— Shapr3D 的招牌操作
 * distance > 0 → 沿外法向长出材料（fuse）
 * distance < 0 → 沿外法向反向切除材料（cut）
 */
export function pushPullFace(shape, faceId, distance) {
  if (!isFinite(distance) || Math.abs(distance) < 1e-6) return shape;
  const face = findFace(shape, faceId);
  if (!face) throw new Error("选中的面已经不存在了，请重新选择");
  /*
   * ⚠ 先克隆：replicad 的 fuse/cut **会消费掉传入的实体**（跟 translate/rotate 一个毛病）。
   * 调用方并不都传一次性基准 —— 智能尺寸的探测那步就直接传模块级的 shape
   * （`OPS.pushPullFace(shape, ...)` 只为量个灵敏度），不克隆的话那个 shape 当场就废。
   * 克隆后 fuse/cut 消费的是副本，传入的实体保持有效。
   */
  const base = shape.clone ? shape.clone() : shape;

  /*
   * 这里只处理**平面**：取一个法向、把面沿它扫成棱柱再 fuse/cut。
   * 曲面（圆柱侧面）不适用 —— 它的法向是径向的（每点不同），取到的那一个方向
   * 扫出来的棱柱整个落在实体内部，融合后体积一点不变。
   * 曲面的尺寸改动走「改特征参数 → 重放」，入口是 surface-drivers.js；
   * 调用方一律先过 isPlanarPushPullFace 守卫，不会把曲面送进来。
   */
  const n = normalOf(face);
  const d = Math.abs(distance);
  const vec = distance > 0
    ? [n[0] * d, n[1] * d, n[2] * d]        // 从面往外扫出
    : [-n[0] * d, -n[1] * d, -n[2] * d];    // 从面往里扫入

  const tool = prismOf(face, vec);
  return distance > 0 ? base.fuse(tool) : base.cut(tool);
}

// ---------------------------------------------------------------- 其他建模
/** 在面上沿法向钻一个通孔 */
export function drillHole(shape, faceId, point, radius, throughDepth = null) {
  const face = findFace(shape, faceId);
  if (!face) throw new Error("面已失效");
  const n = normalOf(face);
  const bb = shape.boundingBox;
  const span = Math.max(bb.width, bb.height, bb.depth) * 3 + 20;
  const start = [
    point.x - n[0] * span / 2,
    point.y - n[1] * span / 2,
    point.z - n[2] * span / 2,
  ];
  const h = throughDepth ?? span;
  return shape.cut(makeCylinder(radius, h, start, n));
}

// ---------------------------------------------------------------- 孔向导（P0-1）
/**
 * 孔向导：通孔 / 盲孔 / 沉头孔（counterbore）/ 埋头孔（countersink）。
 *
 * 为什么是「面上一点 + 朝外法向」而不是 faceId：
 * 参数化重放时要能在上游改动后重建，存坐标比存面哈希稳（与其余 op 的存法一致）。
 *
 * 体积验收（60×40×8 板、中心 Ø6、法向 +Z）：
 *   通孔            = 19200 − π·3²·8
 *   盲孔 d=4        = 19200 − π·3²·4
 *   沉头 Ø12×2      = 19200 − π·3²·8 − π·(6²−3²)·2
 *   埋头 90° Ø12    = 19200 − π·3²·8 − 36π
 * 最后一项：锥台体积 π·h/3·(R²+Rr+r²) 减去同深度圆柱 π·r²·h，h=(R−r)/tan(45°)=3。
 */
const HOLE_KINDS = ["through", "blind", "counterbore", "countersink"];
export function holeAt(shape, spec = {}) {
  if (!shape) throw new Error("孔向导需要先有实体");
  const kind = spec.kind || "through";
  if (!HOLE_KINDS.includes(kind)) {
    throw new Error("孔类型只能是 through / blind / counterbore / countersink");
  }
  const at = spec.at;
  if (!Array.isArray(at) || at.length !== 3 || !at.every((v) => Number.isFinite(v))) {
    throw new Error("孔中心点必须是三个有限数");
  }
  const raw = spec.normal;
  if (!Array.isArray(raw) || raw.length !== 3 || !raw.every((v) => Number.isFinite(v))) {
    throw new Error("孔轴向必须是三个有限数");
  }
  const len = Math.hypot(raw[0], raw[1], raw[2]);
  if (!(len > 1e-9)) throw new Error("孔轴向不能是零向量");
  const n = [raw[0] / len, raw[1] / len, raw[2] / len];   // 朝外

  const d = Number(spec.diameter);
  if (!Number.isFinite(d) || d <= 0) throw new Error("孔径必须大于 0");
  const r = d / 2;
  const bb = shape.boundingBox;
  const span = Math.max(bb.width, bb.height, bb.depth) * 3 + 20;
  /** 从面外 span/2 处起算的点（越出材料，保证布尔不骑跨） */
  const outside = (k) => [at[0] - n[0] * k, at[1] - n[1] * k, at[2] - n[2] * k];

  // 工具体一律从「面外 span/2」朝材料里走；浅孔则从面本身朝里走（深度即孔深）
  const into = [-n[0], -n[1], -n[2]];
  const tools = [];
  if (kind === "blind") {
    const depth = Number(spec.depth);
    if (!Number.isFinite(depth) || depth <= 0) throw new Error("盲孔深度必须大于 0");
    tools.push(makeCylinder(r, depth, at, into));
  } else {
    tools.push(makeCylinder(r, span, outside(span / 2), n));
  }

  if (kind === "counterbore") {
    const hd = Number(spec.headDiameter), hdep = Number(spec.headDepth);
    if (!Number.isFinite(hd) || hd <= d) throw new Error("沉头直径必须大于孔径");
    if (!Number.isFinite(hdep) || hdep <= 0) throw new Error("沉头深度必须大于 0");
    tools.push(makeCylinder(hd / 2, hdep, at, into));
  } else if (kind === "countersink") {
    const hd = Number(spec.headDiameter), ang = Number(spec.angle ?? 90);
    if (!Number.isFinite(hd) || hd <= d) throw new Error("埋头直径必须大于孔径");
    if (!Number.isFinite(ang) || ang <= 1 || ang >= 179) throw new Error("埋头角度必须在 1°~179° 之间");
    const h = (hd / 2 - r) / Math.tan((ang * Math.PI) / 180 / 2);
    if (!(h > 0)) throw new Error("埋头孔深度算出来不是正数，检查直径与角度");
    tools.push(coneSolid({ r1: hd / 2, r2: r, h, at, dir: into }));
  }

  let out = shape;
  for (const tool of tools) out = out.cut(tool);
  return out;
}

/** 从面 + 面上的点起孔（界面入口用；重放用 holeAt，不存面引用） */
export function holeByFace(shape, faceId, point, spec = {}) {
  const face = findFace(shape, faceId);
  if (!face) throw new Error("面已失效");
  return holeAt(shape, { ...spec, at: [point.x, point.y, point.z], normal: normalOf(face) });
}

/** 起始模型：60×40×8 带中心孔底板
 *  注意 makeBaseBox(w,h,d) 以原点为 XY 中心、底面在 z=0，不要再 translate */
export function starterModel({ holeRadius = 6 } = {}) {
  if (!Number.isFinite(holeRadius) || holeRadius <= 0 || holeRadius >= 20) {
    throw new Error("起始底板的孔直径必须大于 0 且小于 40 mm");
  }
  const plate = makeBaseBox(60, 40, 8);
  const hole = makeCylinder(holeRadius, 20, [0, 0, -6], [0, 0, 1]);
  return plate.cut(hole);
}

// ---------------------------------------------------------------- 边与圆角 / 倒角 / 抽壳
/** 取标准基准面的 OCCT 平面对象（XY / XZ / YZ，原点在世界原点） */
export function occtPlaneByName(name) {
  return makePlane(name);
}
/**
 * 把每条拓扑边离散成点序列（屏幕拾取用）
 * 注意：边用「中点坐标」标识比 hashCode 稳 —— 一次布尔/倒角后 hashCode 会变，坐标不会。
 */
export function edgePointSets(shape, samples = 14) {
  const out = [];
  for (const e of shape.edges) {
    const pts = [];
    try {
      for (let i = 0; i <= samples; i++) {
        const p = e.pointAt(i / samples);
        if (p) pts.push([p.x, p.y, p.z]);
      }
    } catch (_) { /* 退化边跳过 */ }
    if (pts.length >= 2) out.push({ hash: e.hashCode, pts, length: e.length, mid: edgeMidPoint(e) });
  }
  return out;
}

/** 取边的代表点（优先弧长中点，退化时退回端点均值） */
export function edgeMidPoint(edge) {
  try {
    const p = edge.pointAt(0.5);
    if (p) return [p.x, p.y, p.z];
  } catch (_) {}
  try {
    const s = edge.startPoint, t = edge.endPoint;
    return [(s.x + t.x) / 2, (s.y + t.y) / 2, (s.z + t.z) / 2];
  } catch (_) {}
  return null;
}

/** 按坐标找回最近的边（容差 tol mm） */
function findEdgeNear(shape, mid, tol = 0.6) {
  let best = null, bd = Infinity;
  for (const e of shape.edges) {
    const m = edgeMidPoint(e);
    if (!m) continue;
    const d = Math.hypot(m[0] - mid[0], m[1] - mid[1], m[2] - mid[2]);
    if (d < bd) { bd = d; best = e; }
  }
  return bd <= tol ? best : null;
}

/** 边的单位切向（t∈[0,1] 归一化弧长） */
export function edgeTangentAt(edge, t = 0.5) {
  try {
    const tan = edge.tangentAt(t);
    const L = Math.hypot(tan.x, tan.y, tan.z);
    if (L < 1e-9) return null;
    return [tan.x / L, tan.y / L, tan.z / L];
  } catch (_) {
    return null;
  }
}

/**
 * 是不是直线边。
 * 直线的切向处处相同 —— 这是参数化重放里最可靠的「拓扑不变量」：
 * 上游一改尺寸，边的中点坐标会跑，但「这条竖边仍然是竖边」永远成立。
 */
export function edgeIsStraight(edge, samples = 5) {
  const first = edgeTangentAt(edge, 0.5);
  if (!first) return false;
  for (let i = 0; i <= samples; i++) {
    const t = edgeTangentAt(edge, i / samples);
    if (!t) return false;
    const dot = Math.abs(t[0] * first[0] + t[1] * first[1] + t[2] * first[2]);
    if (dot < 0.999) return false;
  }
  return true;
}

/**
 * 求一条边的圆角相关信息。
 * @returns { dir, n1, n2, t, touching }
 *   dir = 圆心方向（两面外法向的角平分，指向材料外侧）—— 拖动手柄用它
 *   n1/n2 = 两个相邻面的外法向
 *   t = 边在中点处的单位切向
 *
 * 为什么要把 n1/n2 也带出来：**预览线框画的不是圆心轨迹，而是圆角做完后的切边** ——
 * 切边在各自的那个面上、离原边 R。只用角平分方向画出来的是"朝外延伸的线"，
 * 那是圆心轨迹，看着完全不对（用户实测指出的问题）。
 */
export function edgeFilletInfo(shape, edgeOrMid) {
  let edge = null, mid = null;
  if (Array.isArray(edgeOrMid)) {
    mid = edgeOrMid;
  } else if (edgeOrMid && typeof edgeOrMid.tangentAt === "function") {
    edge = edgeOrMid;
    mid = edgeMidPoint(edge);
  } else if (edgeOrMid && typeof edgeOrMid === "object" && "x" in edgeOrMid) {
    mid = [edgeOrMid.x, edgeOrMid.y, edgeOrMid.z];
  }
  if (!mid) return null;
  if (!edge) edge = findEdgeNear(shape, mid);
  if (!edge) return null;
  const t = edgeTangentAt(edge, 0.5);
  if (!t) return null;

  const touching = [];
  for (const f of shape.faces) {
    try {
      const n = normalOf(f);
      // 一级筛选（便宜）：面法向必须垂直于边的切向，也就是边躺在这个面上
      if (Math.abs(n[0] * t[0] + n[1] * t[1] + n[2] * t[2]) > 0.05) continue;
      // 二级筛选（精确）：边必须真的贴着这个面
      let d = 0;
      try {
        d = new DistanceQuery(edge).distanceTo(f);
      } catch (_) {
        d = Infinity;
      }
      if (!(d < 1e-6)) continue;
      touching.push({ n, d });
    } catch (_) {}
  }
  if (touching.length < 2) return null;
  touching.sort((a, b) => a.d - b.d);
  const a = touching[0], b = touching[1];
  const s = [a.n[0] + b.n[0], a.n[1] + b.n[1], a.n[2] + b.n[2]];
  const L = Math.hypot(s[0], s[1], s[2]);
  if (L < 1e-6) return null;
  return { dir: [s[0] / L, s[1] / L, s[2] / L], n1: a.n, n2: b.n, t, mid };
}

/** 只要圆心方向的旧接口 */
export function edgeFilletDir(shape, edgeOrMid) {
  const info = edgeFilletInfo(shape, edgeOrMid);
  return info ? info.dir : null;
}

/**
 * 圆角 / 倒角 —— 必须「一次多选」
 *
 * 两条硬经验（都是实测出来的）：
 *  1. 相邻边必须一次交给内核，角部才会平滑过渡（CAD 惯例）。
 *     若改成逐条累加：相邻边各自独立倒角、角部交叠，实测【过切 36.7mm³】
 *     （盒子顶面两条相邻边 R3：一次 74.67 vs 逐条 111.37）。
 *  2. replicad 的 `EdgeFinder.parallelTo("Z")` 在立方体上实测返回【全部 12 条边】，
 *     语义不可靠 —— 别拿它当选择器，选边只用坐标匹配。
 */
const _keepEdge = [];
function keepEdgeAlive(...o) {
  _keepEdge.push(...o);
  while (_keepEdge.length > 800) _keepEdge.splice(0, 260);
}

function filletOnce(shape, edges, radius) {
  const oc = getOC();
  const mk = new oc.BRepFilletAPI_MakeFillet(shape.wrapped);
  for (const e of edges) mk.Add(radius, e.wrapped);
  mk.Build();
  const shp = mk.Shape();
  const out = cast(shp);
  keepEdgeAlive(mk, shp);
  return out;
}

function chamferOnce(shape, edges, d) {
  const oc = getOC();
  const mk = new oc.BRepFilletAPI_MakeChamfer(shape.wrapped);
  for (const e of edges) mk.Add(d, e.wrapped);
  mk.Build();
  const shp = mk.Shape();
  const out = cast(shp);
  keepEdgeAlive(mk, shp);
  return out;
}

/**
 * @param mids   边的中点坐标数组（UI 层记录的是坐标，不是 hashCode —— 一次操作后 hashCode 会变）
 */
function applyEdgeOp(shape, mids, value, kind) {
  const norms = mids.map((m) => (Array.isArray(m) ? m : [m.x, m.y, m.z]));
  const edges = [];
  let missed = 0;
  for (const m of norms) {
    const e = findEdgeNear(shape, m);
    if (e) edges.push(e); else missed++;
  }
  if (!edges.length) throw new Error("没有找到可用的边（可能已被上一次操作改掉了）");

  const run = (es) => (kind === "fillet" ? filletOnce(shape, es, value) : chamferOnce(shape, es, value));

  try {
    return { shape: run(edges), ok: edges.length, failed: missed };
  } catch (_) {
    // 整体失败（退化边或半径过大）→ 退回逐条，至少保住能做的
    let s = shape, ok = 0, failed = missed;
    for (const e of edges) {
      try {
        s = kind === "fillet" ? filletOnce(s, [e], value) : chamferOnce(s, [e], value);
        ok++;
      } catch (_e) { failed++; }
    }
    if (!ok) throw new Error(`没有一条边能应用（${failed} 条失败：可能半径过大或与相邻边冲突）`);
    return { shape: s, ok, failed };
  }
}

export function filletEdges(shape, mids, radius) { return applyEdgeOp(shape, mids, radius, "fillet"); }
export function chamferEdges(shape, mids, radius) { return applyEdgeOp(shape, mids, radius, "chamfer"); }

/**
 * 抽壳：把选中的面去掉，其余面按厚度偏置
 *
 * 选择器踩坑记录：FaceFinder 虽然从父类继承了 `containsPoint`，
 * 但实测对它调用会抛 "This shape has not type, it is null"。
 * 可用的是 shouldKeep（按 hashCode 精确匹配，实测 20³ 顶面开口 t=2 → 3392 ✓）。
 * `parallelTo(plane)` 也不可靠（实测给出 2880，选中了不同平面的面）。
 */
export function shellByFace(shape, faceId, thickness) {
  const f = findFace(shape, faceId);
  if (!f) throw new Error("面已失效");
  try {
    return shape.shell(thickness, (finder) => {
      finder.shouldKeep = (cand) => cand.hashCode === faceId;
      return finder;
    });
  } catch (_) {
    // 真实几何约束（实测）：壁厚 ≥ 已有圆角半径时，内偏置面在圆角处半径归零必然退化。
    // 例：R2 圆角的 8mm 板上，t=2 失败、t=1.5 与 t=1 成功。
    // 不给具体半径数字 —— 从拓扑面反推圆柱半径不可靠，宁可不说也不给错值。
    throw new Error(
      `抽壳失败：壁厚 ${thickness}mm 太大，或与已有的圆角/倒角冲突。` +
      `壁厚必须小于零件上最小的圆角半径，换小一点的值再试。`
    );
  }
}

export { makeBox, makeBaseBox, makeCylinder };
