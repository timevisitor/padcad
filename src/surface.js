/**
 * D 批：曲面四件套 —— 表面偏移 / 缝合 / 补面 / 片体加厚
 *
 * 全部走 op 注册表（replay.js 一行没改；ops-register.js 已经 import 本文件）。
 *
 * ============================ 实测事实（探针 probe-surface-v1..v4）============================
 * 1) BRepOffsetAPI_MakeOffset 是**线框**偏置器，不是面偏置器。
 *    构造签名只有 (TopoDS_Face, JoinType, open)；用 Init+AddWire+Perform(2)+Shape()
 *    偏置 20×20 方框，得到 Wire 周长 92.566 —— 正好等于 4×20 + 2π×2（圆角过渡，不是尖角 96）。
 *    结论：**不能拿它偏置面**，面/体偏置改用 BRepOffsetAPI_MakeOffsetShape。
 * 2) BRepOffsetAPI_MakeOffsetShape.PerformByJoin(shape, off, tol, Mode, Inter, SelfInter, Join, thickening)
 *    可用且精确：r20 h10 圆柱侧面 +2 → 面积 1382.301（= π×44×10），−2 → 1130.973（= π×36×10），零误差。
 *    整圆柱 +2 → Solid 体积 21054.935，而解析值 π×22²×14 = 21287.432（−1.09%，端面棱边被圆弧吃掉）。
 * 3) BRepOffsetAPI_MakeThickSolid：
 *    · MakeThickSolidByJoin 用不了 —— wasm 没编 TopTools_ListOfShape（`not a constructor`）；
 *    · MakeThickSolidBySimple(face, t) 可用，但**出来的壳朝向是反的**：
 *      20×20 片体 +3 → Solid 体积 −1200.000（|v| 正确、符号错）。
 *      修正办法实测有效：把它的面重新 Sewing → ShapeFix_Solid.SolidFromShell → +1200.000。
 *      thickenFace() 就是这条路线，所以下面所有加厚/偏移环的体积都是正的。
 * 4) BRepBuilderAPI_Sewing(tol,...).NbFreeEdges() 可用，是「缝没缝上」最可靠的判据
 *    （20×20 片体加厚壳缝后自由边 0；两片分离面缝后 8）。
 * 5) BRepExtrema_DistShapeShape：默认构造 + LoadS1/LoadS2/Perform/Value 可用（顶点距离 5.000 精确）。
 *    不能传 Extrema_ExtFlag —— 这个枚举没编进 wasm（只有 Extrema_ExtAlgo）。
 * 6) BRepOffsetAPI_MakeFilling：Add(edge, GeomAbs_C0, 1) 可用（参数换序也接受），闭合轮廓面积精确
 *    （20×20 → 400.000；带 5×5 缺口的轮廓 → 375.000）。
 *    ⚠ 开口轮廓时 IsDone 仍返回 true，但面积是负的（实测 −413.249）——
 *    所以**不能只看 IsDone**，必须再验面积 > 0。
 * 7) BRepBuilderAPI_MakeFace / MakeWire / MakeSolid、ShapeFix_Solid、BRepGProp 都在且可调用；
 *    BRepOffsetAPI_MakePipeShell 能构造/Build/MakeSolid 不抛错，但本例（截面与路径同平面）体积读数 0，
 *    本批用不到，不做依赖。
 *
 * ============================ 几何路线 ============================
 *   surface_offset   实体：选一张面 → 用「厚度 = |d| 的增料体」fuse(d>0) 或 cut(d<0)；
 *                    片体：直接偏置这张面（结果仍是片体，面积可对解析值）。
 *   surface_thicken  片体：MakeThickSolidBySimple + 朝向归一化 → 实体；
 *                    实体：选面加厚后 fuse / cut。
 *   surface_stitch   Sewing 缝合；自由边 0 → 立成实体，否则量最近间隙并明确报错。
 *   surface_fill     MakeFilling 用一个平面内的闭合轮廓补面，面积对解析值。
 *
 * 参数一律校验，错就抛中文，不静默画半成品。
 */
import { getOC, cast, downcast, makePolygon, measureArea, measureVolume } from "replicad";
import { normalOf } from "./ops.js";
import { registerOp } from "./op-registry.js";

const TOL = 1e-6;                 // OCCT 偏置/缝合的几何容差
const DEFAULT_SEW_TOL = 1e-4;     // 缝合容差：0.1 µm 级，实际件远大于它
/**
 * 增料/减料体与实体之间的搭接量（mm）。见 growthPiece()：
 * 起长面先缩 0.01、再长 t+0.01，避免跟实体表面完全重合导致布尔失效。
 */
const OVERLAP = 0.01;

// OCCT 对象要被 JS 侧持有，否则 embind 会提前析构（项目里既有约定）
const _keep = [];
function keepAlive(...objs) {
  _keep.push(...objs);
  while (_keep.length > 600) _keep.splice(0, 200);
}

const KIND = ["COMPOUND", "COMPSOLID", "SOLID", "SHELL", "FACE", "WIRE", "EDGE", "VERTEX"];
/**
 * 拓扑类型名。
 * ⚠ 实测：embind 的 TopoDS_Shape.ShapeType() 返回的是**字符串** "TopAbs_SOLID"
 *   （不是 TopAbs_ShapeEnum 的序号），所以这里按字符串归一，两种形式都认。
 */
function kindOf(shape) {
  try {
    const t = shape.wrapped.ShapeType();
    if (typeof t === "string") {
      const name = t.replace(/^TopAbs_/, "");
      return KIND.includes(name) ? name : "未知";
    }
    return KIND[t] || "未知";
  } catch (_) { return "未知"; }
}

// ---------------------------------------------------------------- 参数校验
function numParam(v, name) {
  if (!Number.isFinite(v)) throw new Error(`${name}必须是数字（单位 mm）`);
  if (Math.abs(v) < 1e-9) throw new Error(`${name}不能是 0`);
  return v;
}

function unitVec(v, name = "向量") {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => Number.isFinite(x))) {
    throw new Error(`${name}必须是三个数字`);
  }
  const L = Math.hypot(v[0], v[1], v[2]);
  if (L < 1e-9) throw new Error(`${name}长度为零，方向没有意义`);
  return [v[0] / L, v[1] / L, v[2] / L];
}

function pt3(p, i) {
  if (!Array.isArray(p)) throw new Error(`轮廓第 ${i + 1} 个点不是数组`);
  if (p.length === 2 && p.every(Number.isFinite)) return [p[0], p[1], 0];
  if (p.length === 3 && p.every(Number.isFinite)) return [p[0], p[1], p[2]];
  throw new Error(`轮廓第 ${i + 1} 个点必须是 [x,y] 或 [x,y,z] 的数字`);
}

function faceCenter(f) {
  try { const c = f.center; return [c.x, c.y, c.z]; } catch (_) { return null; }
}

/**
 * 选面。
 * 为什么不用 hashCode：一次布尔之后 hashCode 全变；这里用**几何意图**
 * （geomType / 法向 / 位置）去挑，跟 replay.js 里 remapFace 的思路一致。
 * 规格：{ geomType, normal, at, index }，放在 op.face（或 op.faceRef）里。
 */
function pickFace(shape, op = {}) {
  if (!shape) throw new Error("先有实体或片体，才能选面");
  const spec = op.face || op.faceRef || null;
  const faces = shape.faces || [];
  if (!faces.length) throw new Error("这个对象上没有可用的面");

  if (spec && spec.index !== undefined) {
    const i = spec.index;
    if (!Number.isInteger(i) || i < 0 || i >= faces.length) {
      throw new Error(`面序号 ${i} 超出范围（这个对象共 ${faces.length} 个面）`);
    }
    return faces[i];
  }

  const wantType = spec?.geomType ? String(spec.geomType).toUpperCase() : null;
  let cands = faces.filter((f) => {
    if (!wantType) return true;
    try { return String(f.geomType).toUpperCase() === wantType; } catch (_) { return false; }
  });
  if (!cands.length) throw new Error(`找不到 geomType 为 ${wantType} 的面`);

  if (spec?.normal) {
    const n = unitVec(spec.normal, "face.normal");
    cands = cands.filter((f) => {
      const fn = normalOf(f);
      return fn[0] * n[0] + fn[1] * n[1] + fn[2] * n[2] > 0.95;
    });
    if (!cands.length) throw new Error("找不到法向符合 face.normal 的面");
  }

  if (cands.length === 1) return cands[0];

  if (spec?.at) {
    const at = spec.at;
    if (!Array.isArray(at) || at.length !== 3 || !at.every(Number.isFinite)) {
      throw new Error("face.at 必须是三个数字（面上一点）");
    }
    let best = null, bd = Infinity;
    for (const f of cands) {
      const c = faceCenter(f);
      if (!c) continue;
      const d = Math.hypot(c[0] - at[0], c[1] - at[1], c[2] - at[2]);
      if (d < bd) { bd = d; best = f; }
    }
    if (best) return best;
  }

  throw new Error(
    `符合条件的面有 ${cands.length} 张，请用 face.at / face.normal / face.index 收窄到一个` +
    (wantType ? `（已按 geomType=${wantType} 过滤）` : "（这个对象有多个面）")
  );
}

// ---------------------------------------------------------------- 底层几何
/** 缝合一组面；返回缝合结果 + 自由边数（自由边 0 才是闭合壳） */
function sewFaces(faces, tol = TOL) {
  const oc = getOC();
  const sw = new oc.BRepBuilderAPI_Sewing(tol, true, true, true, false);
  keepAlive(sw);
  for (const f of faces) sw.Add(f.wrapped);
  sw.Perform();
  const free = sw.NbFreeEdges();
  const sewn = cast(downcast(sw.SewedShape()));
  keepAlive(sewn);
  return { shape: sewn, free };
}

/** 闭合壳 → 实体（ShapeFix_Solid 顺便把朝外法向修正过来） */
function solidFromShell(shell) {
  const oc = getOC();
  const fix = new oc.ShapeFix_Solid();
  keepAlive(fix);
  const out = cast(downcast(fix.SolidFromShell(downcast(shell.wrapped))));
  keepAlive(out);
  if (kindOf(out) !== "SOLID") throw new Error("片体没有围成封闭空间，转不成实体（还有自由边）");
  return out;
}

function volumeOr0(shape) {
  try { return measureVolume(shape); } catch (_) { return 0; }
}

/**
 * 「当作实体来操作」的判定。
 * ⚠ 不能只看 ShapeType：布尔运算之后 OCCT 常把结果包成 Compound
 *   （实测 starterModel() 是 TopAbs_COMPOUND，体积 18295.221），
 *   这样的 Compound 里确实有实体，必须按实体走"选面"那条路。
 *   也不能只靠体积：片体的 measureVolume 会给出无意义的数（实测 Shell 10136.872），
 *   所以这里数真的 Solid 子形状。
 */
function isSolidLike(shape) {
  if (kindOf(shape) === "SOLID") return true;
  try { return (shape.solids || []).length > 0; } catch (_) { return false; }
}

/**
 * 把一个面「加厚」成实体（沿它自己的法向，厚度 t 可正可负）。
 *
 * ⚠ 必须重新缝合：MakeThickSolidBySimple 对开口片体出来的壳**朝向是反的**
 *   （实测 20×20 片体 +3 → 体积 −1200.000）。缝合 + ShapeFix_Solid 之后 → +1200.000。
 *   不修的话，后面拿它 fuse 会被当成空体（实测环 −2638.938 fuse 圆柱 → 体积一点没变）。
 */
function thickenFace(face, t) {
  const oc = getOC();
  const mk = new oc.BRepOffsetAPI_MakeThickSolid();
  mk.MakeThickSolidBySimple(face.wrapped, t);
  keepAlive(mk);
  const raw = cast(downcast(mk.Shape()));
  keepAlive(raw);

  const { shape: sewn, free } = sewFaces(raw.faces);
  if (free > 0) {
    throw new Error(
      `加厚 ${t} mm 之后没能围成封闭空间（还有 ${free} 条自由边）：厚度太大或这个面弯得太厉害，换小一点再试`
    );
  }
  let out = solidFromShell(sewn);
  if (volumeOr0(out) < 0) {
    // 兜底：极少数情况下 ShapeFix 没把朝向掰正，把面全翻一遍再立
    const flipped = out.faces.map((f) => f.flipOrientation());
    out = solidFromShell(sewFaces(flipped).shape);
  }
  return out;
}

/**
 * 「贴着现有表面长出来」的增料/减料体。
 *
 * 为什么不直接 thickenFace(face, t)：那样新体的内侧跟实体表面**完全重合**，
 * 布尔运算要处理重合面 —— 实测（圆柱侧面 +2）fuse 返回体积 0 的 Compound，
 * 等于白做（cut 反而没事，但不敢赌别的形状）。
 * 办法：让起长面先沿反方向缩 OVERLAP，再长 t+OVERLAP —— 新体跟实体实打实搭接 0.01mm，
 * 而外侧尺寸仍然是精确的 t（环 r20..22 → 外半径 22.00，不是 22.01）。
 */
function growthPiece(face, t) {
  const s = Math.sign(t);
  const start = offsetShape(face, -s * OVERLAP);
  return thickenFace(start, t + s * OVERLAP);
}

/** 整体偏置一个面/片体/实体（所有面一起动） */
function offsetShape(shape, d) {
  const oc = getOC();
  const mk = new oc.BRepOffsetAPI_MakeOffsetShape();
  mk.PerformByJoin(
    shape.wrapped, d, TOL,
    oc.BRepOffset_Mode.BRepOffset_Skin, false, false,
    oc.GeomAbs_JoinType.GeomAbs_Arc, false
  );
  keepAlive(mk);
  const out = cast(downcast(mk.Shape()));
  keepAlive(out);
  if (!out || kindOf(out) === "未知") throw new Error(`偏置 ${d} mm 失败：这个形状偏不出来`);
  return out;
}

/** 两个形状之间的最近距离（mm）；量不出来给 Infinity */
function gapBetween(a, b) {
  const oc = getOC();
  const d = new oc.BRepExtrema_DistShapeShape();
  keepAlive(d);
  try {
    d.LoadS1(a.wrapped);
    d.LoadS2(b.wrapped);
    d.Perform();
    return d.IsDone() ? d.Value() : Infinity;
  } catch (_) {
    return Infinity;
  }
}

function areaOr0(shape) {
  try { return measureArea(shape); } catch (_) { return 0; }
}

// ---------------------------------------------------------------- op 1：表面偏移
/**
 * op: { type:"surface_offset", distance, face?{geomType,normal,at,index}, whole? }
 *   实体 + face → 只动这张面：体积按解析值核对（圆柱侧面 +2 → π×22²×10）
 *   片体       → 直接把面偏置过去（返回片体，面积按解析值核对）
 *   whole:true → 所有面一起偏置（近似：端面棱边会被圆弧化，实测整圆柱 −1.1%）
 */
export function surfaceOffset(shape, op = {}) {
  if (!shape) throw new Error("曲面偏移需要先有一个实体或片体（第一步不能是它）");
  const d = numParam(op.distance, "偏移距离 distance");

  if (isSolidLike(shape)) {
    if (op.whole) return offsetShape(shape, d);          // 所有面一起动
    const face = pickFace(shape, op);
    const piece = growthPiece(face, d);                  // 厚度 |d| 的增料/减料体（带 0.01 搭接）
    const base = shape.clone ? shape.clone() : shape;    // 布尔会吃掉入参，先克隆
    return d > 0 ? base.fuse(piece) : base.cut(piece);
  }

  const kind = kindOf(shape);
  if (kind === "SHELL" || kind === "COMPOUND") return offsetShape(shape, d);
  if (kind === "FACE") {
    const out = offsetShape(pickFace(shape, op), d);
    const faces = out.faces;
    if (faces.length === 1) {        // 单面偏置出来的是一张面，包在 Shell 里
      keepAlive(faces[0]);
      return faces[0];
    }
    return out;
  }
  throw new Error("这个对象不能偏置（只有实体、片体和面可以）");
}

// ---------------------------------------------------------------- op 2：缝合
/**
 * op: { type:"surface_stitch", faces?:[{geomType,normal,at,index}...], tolerance? }
 *   faces 给了 → 从 shape 上选这几张面；没给 → 缝 shape 的全部面
 *   缝出闭合壳 → 返回实体；没闭合但片体确实挨着 → 返回缝合片；
 *   片体之间有真间隙 → 抛「这两片不连续，缝不上（间隙 X mm）」，X 用 Extrema 实测。
 */
export function surfaceStitch(shape, op = {}) {
  const tol = op.tolerance === undefined ? DEFAULT_SEW_TOL : op.tolerance;
  if (!Number.isFinite(tol) || tol <= 0) throw new Error("缝合容差 tolerance 必须是正数（mm）");

  const pieces = [];
  if (Array.isArray(op.faces) && op.faces.length) {
    if (!shape) throw new Error("按 faces 选面缝合时，要先把片体/实体传给上一步");
    for (const spec of op.faces) pieces.push(pickFace(shape, { face: spec }));
  } else if (shape) {
    pieces.push(...(shape.faces || []));
  }
  if (pieces.length < 2) throw new Error(`缝合至少要两片，现在只有 ${pieces.length} 片`);

  const { shape: sewn, free } = sewFaces(pieces, tol);
  if (free === 0) {
    try { return solidFromShell(sewn); } catch (_) { return sewn; }   // 闭合 → 实体
  }

  // 没缝严：量一下到底差多少，报出去让人知道该补多少
  let gap = Infinity;
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      gap = Math.min(gap, gapBetween(pieces[i], pieces[j]));
    }
  }
  if (Number.isFinite(gap) && gap > tol * 10) {
    throw new Error(`这两片不连续，缝不上（间隙 ${gap.toFixed(2)} mm）；间隙要小于 ${tol} mm 才缝得上`);
  }
  return sewn;   // 挨着但没围成封闭空间：给出缝合后的片体
}

// ---------------------------------------------------------------- op 3：补面
/**
 * op: { type:"surface_fill" | "surface_patch", points?:[[x,y]|[x,y,z]...], boundary?:"outer"|"inner" }
 *   points → 用这串点围成的闭合轮廓补面（至少 3 个点）
 *   否则   → 用传入片体自己的边界（boundary:"inner" 补它的洞）
 *   验收：面积对解析值（20×20 → 400；带缺口轮廓 → 375）
 */
export function surfaceFill(shape, op = {}) {
  const edges = [];
  let source = "";

  if (Array.isArray(op.points)) {
    if (op.points.length < 3) throw new Error("补面轮廓至少要 3 个点");
    const pts = op.points.map((p, i) => pt3(p, i));
    const poly = makePolygon(pts);       // 注意：makePolygon 返回的已经是 Face
    keepAlive(poly);
    edges.push(...poly.edges);
    source = `${pts.length} 点轮廓`;
  } else if (shape) {
    const kind = kindOf(shape);
    if (!["FACE", "SHELL", "COMPOUND"].includes(kind)) {
      throw new Error("补面要一个闭合轮廓：给 points，或者给一个片体（用它自己的边界）");
    }
    const face = kind === "FACE" ? shape : (shape.faces || [])[0];
    if (!face) throw new Error("这个对象上没有面可以用来取边界");
    const wantInner = op.boundary === "inner";
    const clone = face.clone ? face.clone() : face;
    keepAlive(clone);
    let wire = null;
    if (wantInner) {
      const inners = typeof clone.innerWires === "function" ? clone.innerWires() : [];
      wire = inners && inners.length ? inners[0] : null;
      if (!wire) throw new Error("这个面上没有内环（没有洞要补）");
    } else {
      wire = clone.outerWire();
    }
    keepAlive(wire);
    edges.push(...wire.edges);
    source = wantInner ? "片体内环" : "片体外边界";
  } else {
    throw new Error("补面需要一个闭合轮廓：给 points，或者给一个片体");
  }

  if (edges.length < 3) throw new Error(`补面轮廓至少要 3 条边，现在只有 ${edges.length} 条`);

  const oc = getOC();
  const mk = new oc.BRepOffsetAPI_MakeFilling();
  keepAlive(mk);
  for (const e of edges) mk.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, 1);
  mk.Build();
  const out = cast(downcast(mk.Shape()));
  keepAlive(out);
  const area = areaOr0(out);
  // ⚠ 开口轮廓时 IsDone 照样是 true，只有面积会变成负数（实测 −413.249）
  if (!mk.IsDone() || !(area > 0)) {
    throw new Error(`补面失败（${source}）：轮廓没有闭合，MakeFilling 拼不出一张面`);
  }
  return out;
}

// ---------------------------------------------------------------- op 4：片体加厚
/**
 * op: { type:"surface_thicken", thickness, face?{...} }
 *   片体 → 加厚成实体（20×20 片体 +3 → 1200）
 *   实体 → 选一张面加厚，t>0 并上去、t<0 挖下去（与表面偏移共用同一条路径）
 */
export function surfaceThicken(shape, op = {}) {
  if (!shape) throw new Error("加厚需要先有一个片体或实体（第一步不能是它）");
  const t = numParam(op.thickness, "加厚厚度 thickness");

  if (isSolidLike(shape)) {
    const face = pickFace(shape, op);
    const slab = growthPiece(face, t);
    const base = shape.clone ? shape.clone() : shape;
    return t > 0 ? base.fuse(slab) : base.cut(slab);
  }
  const kind = kindOf(shape);
  if (kind === "FACE") return thickenFace(pickFace(shape, op), t);
  if (kind === "SHELL" || kind === "COMPOUND") {
    const faces = shape.faces || [];
    if (faces.length === 1) return thickenFace(faces[0], t);
    throw new Error(
      `这片片体有 ${faces.length} 个面，请用 face 指定要加厚的那一面` +
      `（多面片体逐面加厚，侧面上的「壁」会互相穿透）`
    );
  }
  throw new Error("这个对象不能加厚（只有片体和实体可以）");
}

// ---------------------------------------------------------------- 注册
registerOp("surface_offset", surfaceOffset);
registerOp("surface_thicken", surfaceThicken);
registerOp("surface_stitch", surfaceStitch);
registerOp("surface_fill", surfaceFill);
registerOp("surface_patch", surfaceFill);   // 同义名：补面

