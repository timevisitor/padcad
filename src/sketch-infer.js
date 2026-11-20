/**
 * 自动推理几何关系（v6 智能草图）—— 仿 SolidWorks「Automatic Relations」/「Inferencing」
 *
 * SolidWorks 的做法（官方帮助 t_Using_Automatic_Relations.htm / c_inferencing.htm）：
 *   画图时光标附近出现**虚线推导线 + 光标提示 + 端点/中点高亮**；提示还在的时候点下去，
 *   关系就被自动加进草图。同一时刻可以显示多于一条候选关系。
 *
 * 我们拆成三件事，全部是**纯函数**（不碰 DOM、不碰 SketchSession 实例）：
 *   1. `inferRelations(entities, draft, opts)` —— 光标一动就能算：给候选关系（含置信度、符号、待写入 spec），
 *      以及“吸附后的端点坐标”（推理出水平就把终点 y 吸到起点 y）。
 *   2. `applyInferred(entities, relations, { e })` —— 落点之后把选中的关系变成**标准约束 spec**
 *      （只用 solver.js 认识的类型，含新增的 equalLength），并逐条校验。
 *   3. `snapDraftPoint(...)` —— 只是坐标吸附（不入约束），给“临时按住 Ctrl 抑制自动关系”用。
 *
 * 为什么 spec 里要留占位符：画线的时候新图元还不存在（没有下标、没有点名），
 * 所以候选关系里的 spec 用 `{ draft: i }`（草稿第 i 个点）和 `{ draftLine: true }`（草稿这条线）占位，
 * `applyInferred` 再按新图元的真实下标/点名替换。这样推理与“写入”解耦，UI 可以先显示再提交。
 */

import { candidatesOf } from "./snap.js";
import { buildConstraints } from "./solver.js";

const DEG = 180 / Math.PI;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** 候选关系的固定优先级（同分时按它排；互斥时高优先级胜出） */
export const INFER_PRIORITY = {
  coincident: 100,   // 端点落在已有端点上 —— 用户最想要的是这个
  horizontal: 92,
  vertical: 92,
  midpoint: 88,
  onLine: 72,
  tangent: 68,
  perpendicular: 64,
  parallel: 62,
  equalLength: 50,
};

/** 符号外观（UI 直接画在锚点上；glyph 是 canvas 能画的短字符，label 是中文名） */
export const INFER_SYMBOLS = {
  coincident: { glyph: "●", label: "重合" },
  /*
   * 水平/竖直**不能用 "═"/"║"**：系统字体里这两个制表符画成两条等长短横线，
   * 和等长的 "=" 长得一模一样（实测截图里就是 "="），用户分不出「水平」和「等长」。
   * 改成单笔画（─ / │），并且在覆盖层上**直接按线段画**（见 drawInferSymbols），
   * 这样即使换字体也不会被渲染成两条。
   */
  horizontal: { glyph: "─", label: "水平" },
  vertical: { glyph: "│", label: "竖直" },
  midpoint: { glyph: "▲", label: "中点" },
  onLine: { glyph: "∕", label: "在线上" },
  tangent: { glyph: "T", label: "相切" },
  perpendicular: { glyph: "⊥", label: "垂直" },
  parallel: { glyph: "∥", label: "平行" },
  equalLength: { glyph: "=", label: "等长" },
};

// ---------------------------------------------------------------- 几何小工具
const sub = (p, q) => [p[0] - q[0], p[1] - q[1]];
const len = (v) => Math.hypot(v[0], v[1]);
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const unitOf = (a, b) => {
  const v = sub(b, a);
  const L = len(v);
  return L > 1e-12 ? [v[0] / L, v[1] / L] : null;
};

/** 一条线段的两个端点"点名"（与 solver.js lineRefPts 的命名保持一致） */
function segPointNames(ent, seg) {
  if (!ent) return null;
  if (ent.kind === "rect") {
    const names = [["bl", "br"], ["br", "tr"], ["tr", "tl"], ["tl", "bl"]];
    const k = ((seg % 4) + 4) % 4;
    return names[k];
  }
  if (ent.kind === "polyline") {
    const n = ent.closed ? ent.pts.length : ent.pts.length - 1;
    if (seg < 0 || seg >= n) return null;
    return [`p${seg}`, `p${(seg + 1) % ent.pts.length}`];
  }
  return null;
}

/** 把整张草图的线段摊平成 [{e, seg, a, b, len, dir, mid, fixed}] */
export function segmentsOf(entities) {
  const out = [];
  (entities || []).forEach((ent, e) => {
    if (!ent) return;
    const count = ent.kind === "rect" ? 4
      : ent.kind === "polyline" ? (ent.closed ? ent.pts.length : ent.pts.length - 1) : 0;
    for (let seg = 0; seg < count; seg++) {
      const names = segPointNames(ent, seg);
      if (!names) continue;
      const a = pointOfRaw(ent, names[0]);
      const b = pointOfRaw(ent, names[1]);
      if (!a || !b) continue;
      const dir = unitOf(a, b);
      if (!dir) continue;
      out.push({ e, seg, a, b, dir, len: len(sub(b, a)), mid: mid(a, b), fixed: !!ent.ref,
        refA: { e, p: names[0] }, refB: { e, p: names[1] } });
    }
  });
  return out;
}

/** 取图元上某个具名点的原始坐标（rect 角点 / 圆心 / 折线顶点） */
export function pointOfRaw(ent, which) {
  if (!ent) return null;
  if (which === "center") return ent.c ? [ent.c[0], ent.c[1]] : null;
  if (ent.kind === "rect") {
    const hw = ent.w / 2, hh = ent.h / 2;
    const map = { bl: [ent.c[0] - hw, ent.c[1] - hh], br: [ent.c[0] + hw, ent.c[1] - hh],
      tr: [ent.c[0] + hw, ent.c[1] + hh], tl: [ent.c[0] - hw, ent.c[1] + hh] };
    return map[which] ? map[which].slice() : null;
  }
  if (ent.kind === "polyline" && /^p\d+$/.test(which)) {
    const q = ent.pts[Number(which.slice(1))];
    return q ? [q[0], q[1]] : null;
  }
  return null;
}

/** 可当作推理目标的特征点（端点/圆心；引用图元的点也能当目标，但只能转成"固定点"约束） */
function featurePoints(entities, exclude) {
  const out = [];
  (entities || []).forEach((ent, e) => {
    if (exclude.has(e)) return;
    for (const c of candidatesOf(ent, e)) {
      if (!c.ref) continue;                       // 中点/象限点没有可寻址的点，不做"重合"
      out.push({ e, p: c.ref.p, kind: c.kind, at: c.p, fixed: !!ent.ref });
    }
  });
  return out;
}

/** 点到无限长直线的有符号垂距 + 垂足 */
function distToInfiniteLine(p, a, b) {
  const d = sub(b, a);
  const L = len(d);
  if (L < 1e-12) return null;
  const u = [d[0] / L, d[1] / L];
  const v = sub(p, a);
  const cross = v[0] * u[1] - v[1] * u[0];
  const t = v[0] * u[0] + v[1] * u[1];
  return { signed: cross, abs: Math.abs(cross), foot: [a[0] + u[0] * t, a[1] + u[1] * t], t, L };
}

// ---------------------------------------------------------------- 主入口
/**
 * 推理候选关系。
 *
 * @param entities 草图图元
 * @param draft    { kind:"segment", a:[x,y], b:[x,y] }（正在拉的一条线）
 *                 | { kind:"point", p:[x,y] }（只放一个点）
 * @param opts     {
 *                   mmPerPx    每像素多少毫米（必传才能按屏幕容差判定；缺省用 tolMm）
 *                   distTolPx  屏幕容差（默认 10px）
 *                   tolMm      直接给毫米容差（覆盖 distTolPx）
 *                   angleTolDeg 角度容差（默认 3°）
 *                   exclude    要忽略的图元下标集合（草稿自身）
 *                   types      只允许这些关系类型（默认全开）
 *                   enabled    false 时直接返回空结果（全局开关/Ctrl 抑制）
 *                 }
 * @returns {
 *   relations: [{ type, confidence, priority, symbol:{kind,glyph,label,at}, spec, anchor, adjust }],
 *   snapped: { a:[x,y], b:[x,y] },     // 应用最高优先级吸附后的坐标（未变的就是原值）
 *   symbols: [...], best, applied: [types], suppressed: [types]
 * }
 */
export function inferRelations(entities, draft, opts = {}) {
  const res = { relations: [], snapped: null, symbols: [], best: null, applied: [], suppressed: [] };
  if (!draft || opts.enabled === false) return res;
  const exclude = new Set(opts.exclude || []);
  const tolMm = Number.isFinite(opts.tolMm)
    ? opts.tolMm
    : Math.max(1e-3, (opts.distTolPx ?? 10) * (opts.mmPerPx ?? 0.25));
  const angleTol = opts.angleTolDeg ?? 3;
  const types = opts.types ? new Set(opts.types) : null;
  const allow = (t) => !types || types.has(t);

  const isSegment = draft.kind === "segment" && Array.isArray(draft.a) && Array.isArray(draft.b);
  const state = {
    a: isSegment ? [draft.a[0], draft.a[1]] : [draft.p[0], draft.p[1]],
    b: isSegment ? [draft.b[0], draft.b[1]] : null,
  };
  res.snapped = { a: state.a.slice(), b: state.b ? state.b.slice() : null };

  const segs = segmentsOf(entities);
  const feats = featurePoints(entities, exclude);
  const cands = [];
  const push = (type, confidence, at, spec, adjust, extra = {}) => {
    if (!allow(type)) return;
    const sym = INFER_SYMBOLS[type] || { glyph: "?", label: type };
    cands.push({
      type,
      confidence: clamp01(confidence),
      priority: INFER_PRIORITY[type] ?? 10,
      symbol: { kind: type, glyph: sym.glyph, label: sym.label, at },
      spec,
      anchor: at,
      adjust,
      ...extra,
    });
  };

  // ---- ① 端点落到已有特征点上（重合）—— 最高优先级
  const endpoints = isSegment ? [0, 1] : [0];
  const coins = [];
  for (const i of endpoints) {
    const p = i === 0 ? state.a : state.b;
    let best = null, bd = Infinity;
    for (const f of feats) {
      // 圆心的容差更紧一点：手指在圆心附近往往是想选圆，不是想粘上去
      const d = len(sub(p, f.at));
      if (d > tolMm) continue;
      const w = d - (f.kind === "center" ? tolMm * 0.15 : 0);
      if (w < bd) { bd = w; best = f; }
    }
    if (!best) continue;
    const d = len(sub(p, best.at));
    const spec = best.fixed
      // 目标在图元引用（模型投影）上：只能把草稿点钉到那个常量坐标
      ? { type: "fixedPoint", p: { draft: i }, x: best.at[0], y: best.at[1], label: "重合到模型点" }
      : { type: "coincident", a: { draft: i }, b: { e: best.e, p: best.p } };
    push("coincident", 1 - (d / tolMm) * 0.6, best.at, spec,
      { point: i, to: best.at.slice() }, { target: { e: best.e, p: best.p }, which: i });
    coins.push({ i, at: best.at, d });
  }

  // ---- ② 端点落在已有线段上（在线上 / 中点）
  for (const i of endpoints) {
    const p = i === 0 ? state.a : state.b;
    if (coins.some((c) => c.i === i && c.d < tolMm * 0.35)) continue;   // 已经粘到端点，别再叠"在线上"
    for (const s of segs) {
      const dm = len(sub(p, s.mid));
      if (dm <= tolMm && !s.fixed) {
        push("midpoint", 1 - (dm / tolMm) * 0.6, s.mid,
          { type: "midpoint", p: { draft: i }, l: { e: s.e, seg: s.seg } },
          { point: i, to: s.mid.slice() }, { which: i });
      }
      const dl = distToInfiniteLine(p, s.a, s.b);
      if (!dl || dl.abs > tolMm) continue;
      // 垂足必须落在这一段上（不是它的延长线）—— 否则在远离图元的延长线附近画点也会被吸过去
      // 注意 dl.t 是**沿单位方向的长度**（mm），不是 0~1 的参数，所以拿 s.len 比
      if (dl.t < -1e-6 || dl.t > s.len + 1e-6) continue;
      // 端点/中点附近不重复报"在线上"（那里已经有更具体的关系）
      if (len(sub(p, s.a)) <= tolMm || len(sub(p, s.b)) <= tolMm) continue;
      if (len(sub(p, s.mid)) <= tolMm) continue;
      const spec = s.fixed
        ? { type: "distToFixedLine", p: { draft: i }, line: [s.a.slice(), s.b.slice()], value: 0, label: "在线上" }
        : { type: "pointToLine", p: { draft: i }, l1: s.refA, l2: s.refB, value: 0, label: "在线上" };
      push("onLine", 1 - (dl.abs / tolMm) * 0.7, dl.foot, spec, { point: i, to: dl.foot.slice() }, { which: i });
    }
  }

  if (!isSegment) {
    cands.sort(byPriority);
    return finish(cands, res, state);
  }

  // ---- ③ 线段方向：水平 / 竖直（互斥）
  const u = unitOf(state.a, state.b);
  if (u) {
    const ang = Math.atan2(u[1], u[0]) * DEG;
    const norm = ((ang % 180) + 180) % 180;             // 无向角 [0,180)
    const devH = Math.min(norm, 180 - norm);
    const devV = Math.abs(norm - 90);
    if (devH <= angleTol && devH <= devV) {
      push("horizontal", 1 - (devH / angleTol) * 0.55, mid(state.a, state.b),
        { type: "horizontal", a: { draft: 0 }, b: { draft: 1 } },
        { orient: "h" });
    } else if (devV <= angleTol) {
      push("vertical", 1 - (devV / angleTol) * 0.55, mid(state.a, state.b),
        { type: "vertical", a: { draft: 0 }, b: { draft: 1 } },
        { orient: "v" });
    }
  }

  // ---- ④ 与已有线段的角度关系：平行 / 垂直 / 等长 / 相切
  const draftLen = len(sub(state.b, state.a));
  for (const s of segs) {
    if (!u || draftLen < 1e-9) break;
    const cos = Math.abs(u[0] * s.dir[0] + u[1] * s.dir[1]);
    const between = Math.acos(Math.min(1, cos)) * DEG;   // 无向角 [0,90]
    const devPar = between;
    const devPerp = Math.abs(90 - between);
    // 水平/竖直已经能表达时，对**轴对齐**的参考线不再报平行/垂直（那是同一条约束）
    const axisAligned = Math.min(Math.abs(s.dir[0]), Math.abs(s.dir[1])) < Math.sin(angleTol / DEG);
    const hasAxis = cands.some((c) => c.type === "horizontal" || c.type === "vertical");
    if (devPar <= angleTol && !(axisAligned && hasAxis)) {
      const spec = s.fixed
        ? { type: "angleToFixedLine", l: { draftLine: true }, ref: [s.a.slice(), s.b.slice()], value: 0, label: "平行于模型边" }
        : { type: "parallel", l1: { draftLine: true }, l2: { e: s.e, seg: s.seg } };
      push("parallel", 1 - (devPar / angleTol) * 0.55, mid(s.mid, mid(state.a, state.b)),
        spec, { rotate: { from: s.dir, sign: 1 } }, { ref: { e: s.e, seg: s.seg } });
    }
    if (devPerp <= angleTol && !(axisAligned && hasAxis)) {
      const perpDir = [-s.dir[1], s.dir[0]];
      const sign = u[0] * perpDir[0] + u[1] * perpDir[1] >= 0 ? 1 : -1;
      const spec = s.fixed
        ? { type: "angleToFixedLine", l: { draftLine: true }, ref: [s.a.slice(), s.b.slice()], value: 90, label: "垂直于模型边" }
        : { type: "perpendicular", l1: { draftLine: true }, l2: { e: s.e, seg: s.seg } };
      push("perpendicular", 1 - (devPerp / angleTol) * 0.55, mid(s.mid, mid(state.a, state.b)),
        spec, { rotate: { from: [perpDir[0] * sign, perpDir[1] * sign], sign: 1 } }, { ref: { e: s.e, seg: s.seg } });
    }
    // 等长：只在“差得很少”时给，且不跟平行/垂直抢（等长不影响方向）
    if (!s.fixed) {
      const devEq = Math.abs(draftLen - s.len);
      if (devEq <= tolMm && !cands.some((c) => c.type === "parallel" || c.type === "perpendicular")) {
        push("equalLength", 1 - (devEq / tolMm) * 0.5, mid(state.a, state.b),
          { type: "equalLength", l1: { draftLine: true }, l2: { e: s.e, seg: s.seg } },
          { length: s.len }, { ref: { e: s.e, seg: s.seg } });
      }
    }
  }

  // ---- ⑤ 线-圆相切
  (entities || []).forEach((ent, e) => {
    if (exclude.has(e) || !ent || ent.kind !== "circle") return;
    if (!u || draftLen < 1e-9) return;
    const c = [ent.c[0], ent.c[1]];
    const d = distToInfiniteLine(c, state.a, state.b);
    if (!d) return;
    const dev = Math.abs(d.abs - ent.r);
    if (dev > tolMm) return;
    const D = len(sub(c, state.a));
    if (D < ent.r) return;                                  // 起点在圆内，切不出来
    push("tangent", 1 - (dev / tolMm) * 0.6, d.foot,
      { type: "tangent", e, l: { draftLine: true } }, { tangent: { center: c, r: ent.r } }, { circle: e });
  });

  cands.sort(byPriority);
  return finish(cands, res, state);
}

function byPriority(x, y) {
  if (y.priority !== x.priority) return y.priority - x.priority;
  return y.confidence - x.confidence;
}

/**
 * 按互斥规则挑出“实际生效”的调整，并把坐标算出来。
 * 互斥：水平↔竖直；每个端点只保留一条点关系（重合 > 中点 > 在线上，由 priority 保证）；
 *      旋转类（平行/垂直/相切）每段只用一个。
 */
function finish(cands, res, state) {
  // ① 同类型的候选只留置信度最高的那条（画一条线时会同时命中多条参考边，
  //    全报出来会让符号糊成一片、也会写出重复约束）
  const firstOfType = new Map();
  for (const c of cands) {
    if (!firstOfType.has(c.type)) firstOfType.set(c.type, c);
    else { c.suppressed = true; c.supersededBy = firstOfType.get(c.type).type; }
  }
  res.relations = cands;
  res.best = cands.find((c) => !c.suppressed) || null;

  const used = { orient: null, rotate: null, tangent: null, points: {} };
  for (const c of cands) {
    if (c.suppressed) continue;
    if (c.type === "horizontal" || c.type === "vertical") {
      if (used.orient) { c.suppressed = true; res.suppressed.push(c.type); continue; }
      used.orient = c;
    } else if (c.adjust?.point != null) {
      if (used.points[c.adjust.point]) { c.suppressed = true; res.suppressed.push(c.type); continue; }
      used.points[c.adjust.point] = c;
    } else if (c.type === "parallel" || c.type === "perpendicular") {
      if (used.rotate) { c.suppressed = true; res.suppressed.push(c.type); continue; }
      used.rotate = c;
    } else if (c.type === "tangent") {
      if (used.tangent) { c.suppressed = true; res.suppressed.push(c.type); continue; }
      used.tangent = c;
    }
  }

  /*
   * ② 「方向类」与「旋转类」只能生效一条：两者都在改这条线的方向，
   *    同时写进去等于给同一条线加了两条互斥的方向约束（求解器会判过定义）。
   *    取置信度高的那条，另一条标 suppressed —— UI 不画它的符号、提交时也不写它。
   */
  let dirRel = null;
  for (const c of [used.orient, used.rotate, used.tangent]) {
    if (!c) continue;
    if (!dirRel || c.confidence > dirRel.confidence) dirRel = c;
  }
  for (const c of [used.orient, used.rotate, used.tangent]) {
    if (c && c !== dirRel) {
      c.suppressed = true;
      res.suppressed.push(c.type);
      if (used.orient === c) used.orient = null;
      if (used.rotate === c) used.rotate = null;
      if (used.tangent === c) used.tangent = null;
    }
  }

  // ---- 依次应用：点 → 方向 → 旋转 → 长度。后一步基于前一步的结果算，保证坐标自洽
  for (const [i, c] of Object.entries(used.points)) {
    const idx = Number(i);
    if (idx === 0) state.a = c.adjust.to.slice();
    else if (state.b) state.b = c.adjust.to.slice();
    c.adjust = { point: idx, to: (idx === 0 ? state.a : state.b).slice() };
    res.applied.push(c.type);
  }
  if (used.orient) {
    const o = used.orient;
    if (state.b) {
      // 谁没被端点重合钉住就动谁；两个都钉住就不动（约束照样写入，交给求解器）
      const lockedA = !!used.points[0], lockedB = !!used.points[1];
      if (!lockedB) {
        state.b = o.adjust.orient === "h" ? [state.b[0], state.a[1]] : [state.a[0], state.b[1]];
      } else if (!lockedA) {
        state.a = o.adjust.orient === "h" ? [state.a[0], state.b[1]] : [state.b[0], state.a[1]];
      }
      o.adjust = { orient: o.adjust.orient, a: state.a.slice(), b: state.b.slice() };
      res.applied.push(o.type);
    }
  }
  const rot = used.rotate || used.tangent;
  if (rot && state.b) {
    const L = len(sub(state.b, state.a));
    let dir = null;
    if (rot.type === "tangent") {
      // 绕起点转，让圆心到直线的距离正好等于半径
      const { center: c, r } = rot.adjust.tangent;
      const v = sub(c, state.a);
      const D = len(v);
      const phi = Math.atan2(v[1], v[0]);
      const cur = Math.atan2(state.b[1] - state.a[1], state.b[0] - state.a[0]);
      const options = [phi + Math.asin(Math.min(1, r / D)), phi - Math.asin(Math.min(1, r / D))];
      let bestAngle = options[0], bestDev = Infinity;
      for (const th of options) {
        let dv = Math.abs(((th - cur + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
        if (dv < bestDev) { bestDev = dv; bestAngle = th; }
      }
      dir = [Math.cos(bestAngle), Math.sin(bestAngle)];
    } else {
      dir = rot.adjust.rotate.from;
    }
    // 保持“用户拉的方向”符号：旋转后的方向与当前方向同侧才用
    const cur = sub(state.b, state.a);
    if (dir && (cur[0] * dir[0] + cur[1] * dir[1]) < 0) dir = [-dir[0], -dir[1]];
    if (dir) {
      state.b = [state.a[0] + dir[0] * L, state.a[1] + dir[1] * L];
      rot.adjust = { ...rot.adjust, a: state.a.slice(), b: state.b.slice() };
      res.applied.push(rot.type);
    }
  }
  const eq = cands.find((c) => c.type === "equalLength" && c.adjust?.length > 0);
  if (eq && state.b) {
    const L = eq.adjust.length;
    const u = unitOf(state.a, state.b);
    if (u) {
      state.b = [state.a[0] + u[0] * L, state.a[1] + u[1] * L];
      eq.adjust = { length: L, a: state.a.slice(), b: state.b.slice() };
      res.applied.push("equalLength");
    }
  }

  // 符号锚点跟着最终坐标走（不然符号会浮在吸附前的位置上）
  for (const c of cands) {
    if (c.type === "horizontal" || c.type === "vertical" || c.type === "parallel" ||
        c.type === "perpendicular" || c.type === "equalLength") {
      c.symbol.at = state.b ? mid(state.a, state.b) : c.symbol.at;
      c.anchor = c.symbol.at;
    }
  }
  res.snapped = { a: state.a.slice(), b: state.b ? state.b.slice() : null };
  // 只给 UI 画“会生效的那几条”，避免一堆符号糊在一起
  res.symbols = cands
    .filter((c) => !c.suppressed && !res.suppressed.includes(c.type))
    .map((c) => ({ ...c.symbol, confidence: c.confidence }));
  return res;
}

/**
 * 把选中的推理写成**标准约束 spec**（纯数据，可直接 push 进 sketch.constraints）。
 *
 * @param entities  已包含新图元的草图图元（用于校验）
 * @param relations 选中的关系（inferRelations 返回的数组元素），或类型字符串数组（默认取 best）
 * @param opts      { e: 新图元下标, seg: 0, pointRefs: [{e,p}...], lineRef: {e,seg} }
 * @returns { specs, accepted, rejected: [{type, reason}] }
 */
export function applyInferred(entities, relations, opts = {}) {
  const list = Array.isArray(relations) ? relations : relations ? [relations] : [];
  const e = Number.isInteger(opts.e) ? opts.e : null;
  if (e == null) return { specs: [], accepted: [], rejected: [{ type: "?", reason: "没有给出新图元下标" }] };
  const seg = Number.isInteger(opts.seg) ? opts.seg : 0;
  const pointRefs = opts.pointRefs || null;
  const lineRef = opts.lineRef || { e, seg };
  const resolvePoint = (ref) => {
    if (!ref || ref.draft == null) return ref;
    const i = ref.draft;
    if (pointRefs && pointRefs[i]) return { ...pointRefs[i] };
    return { e, p: `p${i}` };
  };
  const resolveLine = (ref) => (ref && ref.draftLine ? { ...lineRef } : ref);
  const substitute = (spec) => {
    if (Array.isArray(spec)) return spec.map(substitute);
    if (!spec || typeof spec !== "object") return spec;
    const out = {};
    for (const [k, v] of Object.entries(spec)) {
      if (k === "p" || k === "a" || k === "b" || k === "l1" || k === "l2" || k === "l") out[k] = substitute(v);
      else out[k] = v;
    }
    // 顶层点引用 {draft:i} / 线引用 {draftLine:true}
    if (spec.draft != null) return resolvePoint(spec);
    if (spec.draftLine) return resolveLine(spec);
    return out;
  };

  const specs = [], accepted = [], rejected = [], skipped = [];
  const seen = new Set();
  for (const rel of list) {
    if (!rel || !rel.spec) { rejected.push({ type: rel?.type || "?", reason: "没有可写入的 spec" }); continue; }
    // 被更高优先级推理取代的候选（比如同时推出水平与相切）不写 —— 写进去就是过定义
    if (rel.suppressed) { skipped.push({ type: rel.type, reason: "已被更高优先级的推理取代" }); continue; }
    const spec = substitute(rel.spec);
    const key = JSON.stringify(spec);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      buildConstraints(entities, [spec]);              // 逐条校验：坏 spec 直接拦下，不写进工程
      specs.push(spec);
      accepted.push({ type: rel.type, spec });
    } catch (error) {
      rejected.push({ type: rel.type, reason: error.message || String(error) });
    }
  }
  return { specs, accepted, rejected, skipped };
}

/**
 * 只做坐标吸附、不写约束（Ctrl 临时抑制自动关系时用）。
 * 返回 { a, b }：把推理出的方向/重合应用到草稿点上。
 */
export function snapDraftPoint(entities, draft, opts = {}) {
  const r = inferRelations(entities, draft, opts);
  return r.snapped || { a: draft.a || draft.p, b: draft.b || null };
}

/** 当前光标位置是否会被推理影响（UI 用它决定要不要亮符号） */
export function hasInference(result) {
  return !!(result && result.relations && result.relations.length);
}
