/**
 * C 批「实体特征」：平面分割 / 布尔合并 / 移动面 / 加厚
 *
 * 为什么放在这里而不改 replay.js：
 *   replay.js 的 switch 只保留内置老特征，新特征一律走 op 注册表（registerOp）。
 *   ops-register.js 已经 import 了本文件，所以这里注册完，rebuild() 就能重放。
 *   四个 op 的参数全部是可 JSON 序列化的数组/数字，工程存档、脚本、回归通用。
 *
 * 全部实现只用 replicad 公开 API + OCCT 原生类，判据是**解析体积**（回归里逐个对账）。
 *
 * 实测确认的内核事实（探针 probe-c1..c7）：
 *   - BRepAlgoAPI_Cut/Fuse/Common、BRepAlgoAPI_Splitter、BRepOffsetAPI_MakeThickSolid
 *     在 wasm 里都**能构造**，但 BRepBuilderAPI_Copy **不存在**（`undefined`），
 *     所以复制实体只能走 replicad 的 shape.clone()。
 *   - BRepPrimAPI_MakeHalfSpace 存在但签名是 (TopoDS_Shell, gp_Pnt)，不接受 gp_Ax2 ——
 *     想用它表达无限平面得先自己造壳，代价不值，所以这里用「大盒求交」表达半空间。
 *   - BRepOffsetAPI_MakeThickSolid.MakeThickSolidByJoin 传空开口表时，
 *     **返回的是整块内缩实体，不是空腔壁**（60×40×8、t=2 → 8064，而壁应为 11136）；
 *     偏移量给 +2 时甚至返回负体积（拓扑翻转）。NCollection_List_TopoDS_Shape 虽存在，
 *     也救不了这个语义。所以加厚必须自己做「原实体 − 内缩体」。
 *   - replicad 的 shape.shell(t, finder) 在 finder 一个面都不选时，
 *     给出的正好是那层内缩实体（带孔件也一样：60×40×8 中心 Ø12 孔 → 7259.7523），
 *     于是「加厚」= 原实体减去它，体积完全对得上解析值。
 *   - 布尔会**消费**输入实体，所有运算前一律 clone()；空交集不抛错，
 *     返回一个体积 0 的 Compound —— 所以"切不到材料"必须自己按体积判并报错。
 */
import { makeBaseBox, measureVolume, getOC, cast } from "replicad";
import { primitiveSolid, alignZTo } from "./primitives.js";
import * as OPS from "./ops.js";
import { registerOp } from "./op-registry.js";

/** embind 对象要留引用，否则 JS 侧被回收后内核对象失效（同 ops.js 的做法） */
const _keep = [];
function keepAlive(...objs) {
  _keep.push(...objs);
  while (_keep.length > 900) _keep.splice(0, 300);
}

// ---------------------------------------------------------------- 参数校验
const num = (v, name) => {
  const x = Number(v);
  if (!Number.isFinite(x)) throw new Error(`${name}必须是数字（收到 ${JSON.stringify(v)}）`);
  return x;
};

const vec3 = (v, name) => {
  if (!Array.isArray(v) || v.length !== 3) throw new Error(`${name}必须是 [x, y, z] 三元数组`);
  return v.map((k, i) => num(k, `${name}的第 ${i + 1} 个分量`));
};

/** 单位化；零向量明确报错 —— 法向定不下来，后面所有几何都是瞎猜 */
const unit = (v, name) => {
  const a = vec3(v, name);
  const L = Math.hypot(a[0], a[1], a[2]);
  if (L < 1e-9) throw new Error(`${name}不能是零向量（方向定不下来）`);
  return a.map((k) => k / L);
};

const fmt = (a, d = 2) => `[${a.map((v) => (+v).toFixed(d)).join(", ")}]`;

/**
 * 量体积，并区分「空体」与「量不出来」。
 * 为什么不能直接用 OPS.volumeOf：它把失败吞成 0，空体和出错就没法区分了；
 * 这里要的是"结果为空就报错"，不能让用户看到一个不报错的空模型。
 */
function solidVolume(shape, what) {
  let v = NaN;
  try { v = measureVolume(shape); } catch (_) { v = NaN; }
  if (!Number.isFinite(v)) throw new Error(`${what}：结果不是闭合实体，量不出体积`);
  return v;
}

function requireSolid(shape, what) {
  if (!shape) throw new Error(`${what}需要一个已有的实体（第一步不能是它）`);
  const v = solidVolume(shape, what);
  if (v <= 1e-9) throw new Error(`${what}：当前实体是空的，没有可加工的材料`);
  return v;
}

/**
 * 把 shell / compound 结果统一成 Solid。
 *
 * 为什么需要：`shape.shell()` 作用在 **Solid** 上返回 Solid，
 * 但作用在 **Compound**（比如带孔的底板，starterModel 就是 compound）上返回的是
 * TopAbs_SHELL —— 量体积照样对（GProp 对闭合壳有效），可一旦拿它去做 cut，
 * 内核直接抛 `This shape has not type, it is null`（实测 probe-c10）。
 * 所以统一用 BRepBuilderAPI_MakeSolid 包成实体再参与布尔。
 */
function asSolid(shape, what) {
  const st = shape?.wrapped?.ShapeType?.();
  if (st === "TopAbs_SOLID") return shape;
  if (st === "TopAbs_SHELL") {
    const oc = getOC();
    const mk = new oc.BRepBuilderAPI_MakeSolid(shape.wrapped);
    const built = typeof mk.Shape === "function" ? mk.Shape() : mk.Solid();
    const out = cast(built);
    keepAlive(mk, built);
    return out;
  }
  const sols = shape?.solids;
  if (Array.isArray(sols) && sols.length === 1) return sols[0];
  throw new Error(`${what}不是单个实体（${st || "未知类型"}），无法参与布尔`);
}

// ---------------------------------------------------------------- 1) 平面分割
/**
 * 用一个无限平面把实体切开，只保留一侧。
 *
 * 做法（半空间 → 求交）：把"保留侧"表达成一个足够大的盒子，与实体求 Common。
 * 相比直接调 BRepAlgoAPI_Splitter 再判朝向，这条路只需要一次布尔，
 * 结果天然就是"保留侧"，也不会出现两个片体谁正谁负的歧义。
 *
 * 盒子尺寸取包围盒最大边的 3 倍以上（题目要求），并且**以平面上那点为基准向保留侧铺**，
 * 所以平面哪怕偏到零件边缘之外，盒子也一定盖得住整个零件。
 */
registerOp("split_plane", (shape, op = {}) => {
  const NAME = "平面分割";
  requireSolid(shape, NAME);

  const origin = vec3(op.origin, "分割平面上的一点");
  const n = unit(op.normal, "分割平面的法向");
  const keep = op.keep === undefined ? "positive" : op.keep;
  if (keep !== "positive" && keep !== "negative") {
    throw new Error(`keep 只能是 "positive" 或 "negative"（收到 ${JSON.stringify(op.keep)}）`);
  }

  const bb = shape.boundingBox;
  const span = Math.max(bb.width, bb.height, bb.depth, 1);
  const S = Math.max(3 * span, 20);          // 3 倍以上，且不小于 20mm
  const sgn = keep === "positive" ? 1 : -1;
  const d = [n[0] * sgn, n[1] * sgn, n[2] * sgn];

  /*
   * 半空间盒：makeBaseBox 是「XY 居中、底面在 z=0」，
   * 先沿 z 移 -S/2 让它变成以原点为中心的立方，
   * 再把本地 +Z 转到保留侧方向 d，最后中心落到 origin + d·S/2 ——
   * 于是盒子恰好从平面出发、沿保留侧铺 S 厚。
   */
  const half = alignZTo(
    makeBaseBox(S, S, S).translate(0, 0, -S / 2),
    d,
    [origin[0] + d[0] * S / 2, origin[1] + d[1] * S / 2, origin[2] + d[2] * S / 2],
  );

  const v0 = solidVolume(shape, NAME);
  let out;
  try {
    out = shape.clone().intersect(half);
  } catch (e) {
    throw new Error(`${NAME}失败：${e?.message || e}`);
  }
  const v = solidVolume(out, `${NAME}（保留 ${keep} 侧）`);

  // 空结果必须明说 —— 布尔对"没切到"是静默返回空 Compound 的
  if (v <= 1e-6) {
    throw new Error(`这个位置切不到实体：平面过点 ${fmt(origin)}、法向 ${fmt(n)}，保留 ${keep} 侧没有材料`);
  }
  if (v > v0 + 1e-6) {
    throw new Error(`${NAME}结果（${v.toFixed(3)}）比原实体（${v0.toFixed(3)}）还大，几何异常`);
  }
  // 整块都落在保留侧（刀口其实没分开）在分割语义上仍是正确结果，不报错；
  // 调用方若要"必须被切开"，拿返回体积和 v0 比一下自己提示即可。
  return out;
});

// ---------------------------------------------------------------- 2) 布尔合并 / 切除 / 相交
const MODE_ALIAS = { union: "fuse", add: "fuse", subtract: "cut", difference: "cut", intersect: "common" };

/**
 * 与参数化的工具体做并 / 差 / 交。
 *
 * 工具体复用 primitives.js（box / cylinder / sphere / cone / torus），
 * 参数校验也在那里，不重复发明一套 —— 否则 at/dir 语义会两边不一致
 * （makeCylinder 的 at 是底面圆心，这个坑已经踩过一次）。
 */
registerOp("combine", (shape, op = {}) => {
  const NAME = "布尔运算";
  const v0 = requireSolid(shape, NAME);

  const raw = String(op.mode ?? "").toLowerCase();
  const mode = MODE_ALIAS[raw] || raw;
  if (!["fuse", "cut", "common"].includes(mode)) {
    throw new Error(`布尔模式只能是 fuse / cut / common（收到 ${JSON.stringify(op.mode)}）`);
  }
  if (!op.tool || typeof op.tool !== "object" || Array.isArray(op.tool)) {
    throw new Error("布尔运算需要一个工具体（op.tool：{shape:'box'|'cylinder'|'sphere', ...}）");
  }

  const tool = primitiveSolid(op.tool);
  const v1 = solidVolume(tool, "布尔工具体");
  if (v1 <= 1e-9) throw new Error("布尔工具体是空的，做不了运算");

  // 公共体积：用副本单独量一次，既是判据也是"没交集"的证据
  let vInt = 0;
  try {
    vInt = solidVolume(shape.clone().intersect(tool.clone()), "工具体与实体的公共部分");
  } catch (_) {
    vInt = 0;
  }

  if (mode === "cut" && vInt <= 1e-9) {
    throw new Error("工具体与这个实体没有交集，切除不会去掉任何材料（请检查工具体的位置和尺寸）");
  }
  if (mode === "common" && vInt <= 1e-9) {
    throw new Error("工具体与这个实体没有交集，相交结果是空的");
  }

  let out;
  try {
    const base = shape.clone();
    const tl = tool.clone();
    out = mode === "fuse" ? base.fuse(tl) : mode === "cut" ? base.cut(tl) : base.intersect(tl);
  } catch (e) {
    throw new Error(`${NAME}（${mode}）失败：${e?.message || e}`);
  }

  const v = solidVolume(out, `${NAME}（${mode}）`);
  if (v <= 1e-6) {
    throw new Error(mode === "cut"
      ? "切除后没有剩余材料：工具体把实体整个吃掉了"
      : `${NAME}（${mode}）的结果是空体`);
  }
  // 松检查：并集不该变小、切除不该变大、相交不该超过任一方的体积
  if (mode === "fuse" && v < Math.max(v0, v1) - 1e-3) {
    throw new Error(`并集体积（${v.toFixed(3)}）比其中一个输入还小，几何异常`);
  }
  if (mode === "cut" && v > v0 + 1e-3) {
    throw new Error(`切除后体积（${v.toFixed(3)}）比原实体（${v0.toFixed(3)}）还大，几何异常`);
  }
  if (mode === "common" && v > Math.min(v0, v1) + 1e-3) {
    throw new Error(`相交体积（${v.toFixed(3)}）超过了任一输入的体积，几何异常`);
  }
  return out;
});

// ---------------------------------------------------------------- 3) 移动面
/**
 * 按「面上一点 + 法向」定位平面面。
 *
 * 为什么不用面 hashCode 当参数：op 要能进 JSON 且跨重放有效，
 * 而 hashCode 每做一次布尔就全变（replay.js 顶部的老经验）。
 * 所以跟 hole/shell 一样用几何意图定位：法向必须同向（>0.999），
 * 点必须几乎落在该面上（沿法向 0.5mm 以内），并且投影点要在这个面的外框里，
 * 免得把"同高但不相干"的另一块面认成目标。
 */
function findPlanarFaceByPoint(shape, at, normal) {
  const p = vec3(at, "面上的一点");
  const n = unit(normal, "面的法向");
  const tol = 0.5;
  const hits = [];
  for (const f of shape.faces) {
    let c, fn, bounds;
    try {
      if (f.geomType && f.geomType !== "PLANE") continue;
      c = f.center;
      bounds = f.boundingBox.bounds;
      fn = OPS.normalOf(f);
    } catch (_) { continue; }
    const dot = fn[0] * n[0] + fn[1] * n[1] + fn[2] * n[2];
    if (dot < 0.999) continue;
    const along = (c.x - p[0]) * n[0] + (c.y - p[1]) * n[1] + (c.z - p[2]) * n[2];
    if (Math.abs(along) > tol) continue;                 // 点不在这张面上
    const q = [p[0] + n[0] * along, p[1] + n[1] * along, p[2] + n[2] * along];
    const inside = q.every((v, i) => v >= bounds[0][i] - tol && v <= bounds[1][i] + tol);
    if (!inside) continue;                                // 落在面外框之外
    hits.push({ faceId: f.hashCode, along: Math.abs(along) });
  }
  if (!hits.length) return null;
  if (hits.length > 1) {
    // 共面被切成好几块时绝不猜 —— 猜错了就是"移动了错误的面"，用户根本看不出来
    throw new Error(`这个位置有 ${hits.length} 个共面候选面，无法唯一确定要移动哪个面（请换一个只在单块面内的点）`);
  }
  return hits[0].faceId;
}

/**
 * 把平面面沿其法向推/拉 d（d>0 长料，d<0 去料）。
 *
 * 实现走 ops.pushPullFace：把该面沿法向扫成棱柱再 fuse / cut，
 * 这正是"面沿法向移动 d"的精确等价（棱柱体积 = 面面积 × |d|，
 * 边界与实体共面，OCCT 共面布尔实测零误差），不需要再写一套。
 */
registerOp("offset_face", (shape, op = {}) => {
  const NAME = "移动面";
  const v0 = requireSolid(shape, NAME);

  const at = vec3(op.at, "移动面上的一点");
  const n = unit(op.normal, "移动面的法向");
  const d = num(op.distance, "移动距离");
  if (Math.abs(d) < 1e-6) throw new Error("移动距离太小（≈0），面不会移动；要删掉这一步请直接移除特征");

  let fid = null;
  try {
    fid = findPlanarFaceByPoint(shape, at, n);
  } catch (e) {
    throw new Error(`${NAME}：${e?.message || e}`);
  }
  if (fid == null) {
    throw new Error(`找不到要移动的面：${fmt(at)} 附近没有法向 ${fmt(n)} 的平面面（曲面不能整体推拉，请改用其它特征）`);
  }

  let out;
  try {
    out = OPS.pushPullFace(shape.clone(), fid, d);
  } catch (e) {
    throw new Error(`${NAME}失败：${e?.message || e}`);
  }

  const v = solidVolume(out, NAME);
  if (v <= 1e-6) throw new Error(`${NAME}失败：距离 ${d}mm 把零件整个吃掉了`);
  if (d > 0 && v < v0 - 1e-6) {
    throw new Error(`${NAME}长料后体积反而变小了（${v.toFixed(3)} < ${v0.toFixed(3)}），几何异常`);
  }
  if (d < 0 && v > v0 + 1e-6) {
    throw new Error(`${NAME}去料后体积反而变大了（${v.toFixed(3)} > ${v0.toFixed(3)}），几何异常`);
  }
  return out;
});

// ---------------------------------------------------------------- 4) 加厚（闭合空腔）
/**
 * 加厚：把实体做成"围一圈壁厚 t 的闭合空腔"。
 *
 * 为什么不用 BRepOffsetAPI_MakeThickSolid 直接出壁：
 * 实测（probe-c6）开口面列表传空时它返回的是**整块内缩实体**（60×40×8、t=2 → 8064），
 * 偏移量给正数甚至返回负体积（拓扑翻转）；库里又没有 BRepBuilderAPI_Copy，
 * 这条原生路在这里不可靠。于是走等价且可对账的定义：
 *
 *     壁厚实体 = 原实体 − 内缩 t 的实体
 *
 * 内缩实体由 replicad 的 shape.shell(t, 一个面都不选) 给出 ——
 * 实测它给出的正是那层内缩体：60×40×8 → 56×36×4 = 8064，
 * 带 Ø12 中心孔的板 → 7259.7523（= 8064 − π·8²·4，孔也跟着向内长，符合解析）。
 * 所以「原实体 − 内缩体」不是近似，而是闭合空腔壁的精确体积。
 *
 * ⚠ 已知限制：这里只做**闭合**空腔（不开口）。开口抽壳走 replay.js 内置的 shell 特征
 * （按面开口），两者用途不同，别混用。
 */
registerOp("thicken", (shape, op = {}) => {
  const NAME = "加厚";
  const v0 = requireSolid(shape, NAME);

  const t = num(op.thickness ?? op.t, "壁厚");
  if (t <= 0) throw new Error(`壁厚必须大于 0（收到 ${t}）`);

  const bb = shape.boundingBox;
  const thin = Math.min(bb.width, bb.height, bb.depth);
  if (t * 2 >= thin) {
    // 提前拦：两面内缩会在中间相遇，内腔必然退化（OCCT 会给破面而不是报错）
    throw new Error(`壁厚 ${t}mm 太大：零件最薄方向只有 ${thin.toFixed(2)}mm，两面内缩就会撞在一起`);
  }

  // 远端空框 → 一个面都选不中 → shell 给出整块内缩体
  const far = 1e6;
  let inner;
  try {
    const raw = shape.clone().shell(t, (finder) => finder.inBox([far, far, far], [far + 1, far + 1, far + 1]));
    // compound 上的 shell 返回的是 TopAbs_SHELL，必须先包成实体才做得了布尔
    inner = asSolid(raw, `${NAME}的内缩体`);
  } catch (e) {
    if (/不是单个实体/.test(String(e?.message))) throw e;
    throw new Error(`${NAME}失败：壁厚 ${t}mm 太大或与已有的圆角/倒角冲突（${e?.message || e}）`);
  }
  const vi = solidVolume(inner, `${NAME}的内缩体`);
  if (vi <= 1e-6) throw new Error(`壁厚 ${t}mm 太大：内腔被完全吃掉，没有留下任何空间`);
  if (vi >= v0 - 1e-6) throw new Error(`壁厚 ${t}mm 没有产生内腔（内缩体不比原实体小），加厚无效`);

  let out;
  try {
    out = shape.clone().cut(inner.clone());
  } catch (e) {
    throw new Error(`${NAME}失败：${e?.message || e}`);
  }
  const v = solidVolume(out, NAME);
  // 空腔壁的体积必须等于「外形 − 内腔」，对不上说明布尔出了问题
  const expect = v0 - vi;
  if (Math.abs(v - expect) > Math.max(1e-3, expect * 1e-3)) {
    throw new Error(`${NAME}结果不一致：壁体积 ${v.toFixed(3)}，按「实体 − 内腔」应为 ${expect.toFixed(3)}`);
  }
  return out;
});

export { findPlanarFaceByPoint };
