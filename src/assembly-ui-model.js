/**
 * 装配 UI 的纯逻辑（不碰 DOM，可在 node 里单测）
 *
 * 装配模式的界面有一堆「算」的部分：配合类型怎么过滤排序、新实例摆哪儿不重叠、
 * 一次性对齐（Shapr3D Align）的位姿怎么解、DOF 怎么措辞、配合行怎么写。
 * 这些一旦写进 DOM 模块就只能靠 headless 截图猜，所以全部抽到这里：
 *   - 每个函数都是纯函数，入参出参都是普通对象/数组；
 *   - 单测直接断言解析值（列表顺序、间距 24、法向反向、自由度文字）。
 *
 * 与 assembly.js 的分工：那边是数据模型 + 几何参考解析，这边只做「界面语义」。
 */

import {
  matMul, matVec, poseFromTransform, quatFromAxisAngle, quatNormalize, quatToMatrix,
  refsCompatible, transformFromPose, transformRef, vCross, vDot, vLen, vNorm, vScale, vSub,
} from "./assembly.js";

// ---------------------------------------------------------------- 配色（Clay 柔和色板）
/**
 * 实例配色：Clay 主题下的低饱和色，5 个循环。
 * 为什么要给每个实例上色：装配体里 60×40×8 的两块板几何完全一样，
 * 不上色根本分不清谁是谁（SolidWorks 里是靠不同零件名 + 不同零件实体体现的）。
 */
export const ASM_COLORS = ["#c8b6a0", "#a9b9a4", "#c9a982", "#9db1bf", "#c1a5a0", "#b9b294"];

export const FIXED_COLOR = "#9a9285";

export const instanceColor = (idx) => ASM_COLORS[Math.max(0, idx) % ASM_COLORS.length];

// ---------------------------------------------------------------- 配合类型
/**
 * 配合类型的中文名 / 图标 / 菜单顺序。
 * order 决定菜单里的排序（面-面时「重合」永远排第一，符合 SolidWorks 智能配合的直觉）。
 */
export const MATE_META = {
  coincident: { label: "重合", icon: "≡", order: 0, short: "贴合" },
  distance: { label: "距离", icon: "↔", order: 1, unit: "mm" },
  concentric: { label: "同轴", icon: "◎", order: 0 },
  parallel: { label: "平行", icon: "∥", order: 2 },
  perpendicular: { label: "垂直", icon: "⊥", order: 3 },
  angle: { label: "角度", icon: "∠", order: 4, unit: "°" },
  lock: { label: "锁定", icon: "🔒", order: 9 },
};

/** 需要输入数值的配合类型 */
export const VALUE_MATES = new Set(["distance", "angle"]);

/** 一次性「对齐」不是配合（Shapr3D Align 的等价物），菜单里永远排第一 */
export const ALIGN_ITEM = { type: "align", label: "对齐", icon: "⇥", order: -1, oneShot: true };

/**
 * 两种参考类型下可用的配合，按 order 排序。
 * 过滤一律走 assembly.js 的 refsCompatible —— UI 不自己维护一张规则表，
 * 否则求解器接受、菜单不给，或者反过来，是最难查的一类不一致。
 */
export function mateTypesFor(kindA, kindB) {
  const out = [];
  for (const [type, meta] of Object.entries(MATE_META)) {
    if (!refsCompatible(type, kindA, kindB)) continue;
    out.push({ type, ...meta });
  }
  return out.sort((a, b) => (a.order - b.order) || String(a.type).localeCompare(String(b.type)));
}

/** 参考类型的中文名（配合行、提示语里用） */
export function refKindWord(ref) {
  if (!ref) return "无参考";
  if (ref.kind === "plane") return "面";
  if (ref.kind === "axis") return ref.curve === "circle" ? "圆边轴" : "轴线";
  if (ref.kind === "point") return "点";
  return String(ref.kind);
}

// ---------------------------------------------------------------- 测量（配合默认值）
/**
 * 两个参考在当前位姿下的「距离 + 夹角」，给距离/角度配合做预填值。
 * 距离：面-面取沿 A 法向的间距（负值折成 0 以外不特殊处理，装配里用绝对值更符合直觉）；
 * 角度：两个方向向量之间的夹角（度）。
 */
export function measurePair(refA, poseA, refB, poseB) {
  if (!refA || !refB) return { distance: null, angleDeg: null };
  const ra = transformRef(refA, poseA || { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] });
  const rb = transformRef(refB, poseB || { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] });
  const dirOf = (r) => (r.kind === "plane" ? r.normal : r.kind === "axis" ? r.direction : null);
  const da = dirOf(ra), db = dirOf(rb);
  const d = vSub(rb.point, ra.point);
  let angleDeg = null;
  let distance = null;
  if (da && db) {
    const c = Math.min(1, Math.max(-1, vDot(da, db)));
    angleDeg = (Math.acos(c) * 180) / Math.PI;
    distance = Math.abs(vDot(d, da));
  } else {
    distance = vLen(d);
  }
  return { distance, angleDeg };
}

// ---------------------------------------------------------------- 一次性对齐
/** 单位向量 a → b 的旋转（四元数）；反向时挑一个垂直轴转 180°，避免除零 */
export function quatBetween(a, b) {
  const ua = vNorm(a), ub = vNorm(b);
  const d = vDot(ua, ub);
  if (d < -0.999999) {
    let axis = vCross(ua, [1, 0, 0]);
    if (vLen(axis) < 1e-6) axis = vCross(ua, [0, 1, 0]);
    return quatFromAxisAngle(vNorm(axis), Math.PI);
  }
  const c = vCross(ua, ub);
  return quatNormalize([c[0], c[1], c[2], 1 + d]);
}

/**
 * 一次性对齐（Shapr3D 的 Align）：把 B 的参考搬到 A 的参考上，**不建配合**。
 *
 * 语义与 coincident 保持一致：默认两面反向贴合（法向相对），flip 时同向。
 * 做法：先把 B 的参考方向转到目标方向（绕世界原点），再把 B 的参考点平移到 A 的参考点。
 * 输出是 B 的新位姿（`{t, r}`，与实例 transform 同构），调用方决定要不要接受。
 */
export function alignTransform(refA, poseA, refB, poseB, { flip = false } = {}) {
  const ra = transformRef(refA, poseA);
  const rb = transformRef(refB, poseB);
  const dirOf = (r) => (r.kind === "plane" ? r.normal : r.kind === "axis" ? r.direction : null);
  const da = dirOf(ra), db = dirOf(rb);
  let R = poseB.R;
  if (da && db) {
    const target = flip ? vNorm(da) : vNorm(vScale(da, -1));
    R = matMul(quatToMatrix(quatBetween(db, target)), poseB.R);
  }
  /*
   * 关键：公式里用的是 **B 的参考点在零件局部坐标系**（refB.point），不是 transformRef 出来的世界点。
   * 世界点里已经含了 B 当前的平移，再减 R·p_world 等于把平移算了两次 ——
   * 实测两块板「对齐」后会被甩到 x=−84（看着像没对齐），轴-轴更惨：径向还差 84mm。
   */
  const t = vSub(ra.point, matVec(R, refB.point));
  return transformFromPose({ R, t });
}

// ---------------------------------------------------------------- 自动摆放
/** 局部包围盒（零件 mesh 的 boundingBox 直接给中心 + 宽高深） */
export function localBoxOf(boundingBox) {
  const c = boundingBox.center;
  const hw = boundingBox.width / 2, hh = boundingBox.height / 2, hd = boundingBox.depth / 2;
  return {
    min: [c[0] - hw, c[1] - hh, c[2] - hd],
    max: [c[0] + hw, c[1] + hh, c[2] + hd],
    center: [c[0], c[1], c[2]],
    size: [boundingBox.width, boundingBox.height, boundingBox.depth],
  };
}

/** 局部包围盒 + 平移 → 世界包围盒 */
export function worldBox(localBox, t = [0, 0, 0]) {
  return {
    min: localBox.min.map((v, i) => v + t[i]),
    max: localBox.max.map((v, i) => v + t[i]),
  };
}

/**
 * 新实例摆哪儿：放在已有包围盒的 +X 一侧，留 gap 间隙，Y 对齐已有件的最小 Y、Z 落在 z=0 平面上。
 * ——「不重叠」是硬要求（第一版把新件放在原点，两个件完全重合，干涉检查直接报了一整块假干涉）。
 */
export function placeNewTransform(localBox, worldBoxes = [], { gap = 24 } = {}) {
  const r = [0, 0, 0, 1];
  if (!worldBoxes.length) return { t: [0, 0, 0], r };
  const maxX = Math.max(...worldBoxes.map((b) => b.max[0]));
  const minY = Math.min(...worldBoxes.map((b) => b.min[1]));
  const t = [maxX + gap - localBox.min[0], minY - localBox.min[1], -localBox.min[2]];
  return { t: t.map((v) => (Math.abs(v) < 1e-12 ? 0 : v)), r };
}

// ---------------------------------------------------------------- 文案
export function formatResidual(v) {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  return v < 1e-3 ? v.toExponential(2) : v.toFixed(4);
}

export function formatLength(mm) {
  if (!Number.isFinite(mm)) return "—";
  return `${Math.abs(mm) < 1e-9 ? 0 : +mm.toFixed(3)} mm`;
}

export function formatVolume(mm3) {
  if (!Number.isFinite(mm3)) return "—";
  return `${(mm3 / 1000).toFixed(2)} cm³`;
}

/**
 * DOF 状态 → { text, tone, hint }
 * status 只有 solved / conflict 两种；dof 是求解器算的 6×浮动件 − rank。
 * tone: ok（完全定位）| warn（还有自由度）| bad（冲突）| muted（未求解）
 */
export function dofLabel(solve) {
  if (!solve) return { text: "未求解", tone: "muted", hint: "还没有配合" };
  if (solve.status === "conflict") {
    const n = (solve.conflicts || []).length;
    return {
      text: "配合冲突", tone: "bad",
      hint: `${n || 1} 条配合解不出（最大残差 ${formatResidual(solve.maxResidual)}）`,
    };
  }
  const extra = solve.overDefined ? ` · 多余配合 ${(solve.redundantMates || []).length} 条` : "";
  if (solve.dof === 0) return { text: "完全定位", tone: "ok", hint: `rank ${solve.rank}/${solve.variables}${extra}` };
  return { text: `剩 ${solve.dof} 自由度`, tone: "warn", hint: `rank ${solve.rank}/${solve.variables}${extra}` };
}

/** 配合列表的一行文案 */
export function mateSummary(mate, asm) {
  const meta = MATE_META[mate?.type] || { label: mate?.type || "配合", icon: "?" };
  const nameOf = (id) => asm?.instances?.find((i) => i.id === id)?.name || id || "?";
  let valueText = "";
  if (mate?.type === "distance") valueText = formatLength(mate.value);
  else if (mate?.type === "angle") valueText = `${+(Number(mate.value) || 0).toFixed(2)}°`;
  const refA = refKindWord(mate?.a?.ref), refB = refKindWord(mate?.b?.ref);
  return {
    icon: meta.icon,
    title: meta.label,
    valueText,
    sides: `${nameOf(mate?.a?.inst)} ↔ ${nameOf(mate?.b?.inst)}`,
    refs: `${refA} ↔ ${refB}`,
    // 列表行只有 ~114px：两侧参考同类型时压成一个词（「面↔面」→「面」），否则短写
    refsShort: refA === refB ? refA : `${refA}↔${refB}`,
    sidesShort: `${nameOf(mate?.a?.inst)}↔${nameOf(mate?.b?.inst)}`,
    flipText: mate?.type === "coincident" || mate?.type === "distance"
      ? (mate.flip ? "同向" : "反向") : "",
  };
}

/** 实例列表一行的副标题 */
export function instanceSubtitle(asm, inst, partName) {
  const mates = (asm?.mates || []).filter((m) => !m.suppressed && (m.a.inst === inst.id || m.b.inst === inst.id)).length;
  return `${partName || inst.partId} · ${inst.fixed ? "固定" : "浮动"} · ${mates} 个配合`;
}
