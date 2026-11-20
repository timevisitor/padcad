/**
 * 草图自由度 / 冲突分析（v6 智能草图）
 *
 * 为什么要有这一层：v5 的 `solve()` 用 `dof = n − m`（参数数 − 约束条数）估算剩余自由度，
 * 两个地方必然算错：
 *   ① 约束之间可能**线性相关**（重复的尺寸、从宽度推得的角点距离…），实际方程数少于约束条数；
 *   ② 有的约束一条残差其实代表**两个方程**（重合、固定点、中点、对称、固定整个图元）。
 * 结果就是“明明全标完了，状态栏还说剩 1 个自由度”（用户实测反馈），
 * 以及“加了一个多余尺寸，就红着脸说过定义”——但那个尺寸其实完全能同时满足。
 *
 * 正确判据（JSketcher `diagnose()` 与 FreeCAD planegcs 的 `System::diagnose()` 都是这个）：
 *   DOF = 参数数 − rank(J)，J 是**分量化后**的约束 Jacobian；rank 用全主元 QR 求。
 *   多余的行（rank 之外的列）通过 R 的非零分布分组 → 每组要么**冗余**（都满足），要么**冲突**（满足不了）。
 *
 * 本文件的角色：把 solver.js 的数值层（qrRank / dependentRowGroups / nullSpace / mobilityOf）
 * 翻译成“用户看得懂”的东西 —— 每个约束是冗余还是冲突、冲突的是哪两条、每个图元该涂什么颜色。
 */

import {
  buildConstraints, collectParams, buildParamDeps, constraintEquationRows, equationJacobian,
  qrRank, dependentRowGroups, nullSpace, mobilityOf, solve, specEntities, InvalidConstraintError,
} from "./solver.js";

/** 图元状态（颜色语义照 SolidWorks「Sketch Geometry Status」：全定义黑 / 欠定义蓝 / 过定义红） */
export const SKETCH_STATES = {
  defined: { label: "完全定义", color: "#1f2328" },
  underdefined: { label: "欠定义", color: "#2f6fed" },
  conflict: { label: "过定义/冲突", color: "#e0362c" },
  reference: { label: "参考", color: "#9aa4b2" },
};

const STATE_LABEL = { defined: "完全定义", underdefined: "欠定义", conflict: "过定义（冲突）", reference: "参考" };

/** 残差判定阈值：与 solve 的 okTol 一致 */
const RES_TOL = 1e-6;

/** 同一条约束出现在多个冲突组里时按 index 合并，避免 UI 重复显示 */
function mergeGroups(groups) {
  const out = [];
  for (const g of groups) {
    const prev = out.find((x) => x.group.some((i) => g.includes(i)));
    if (prev) {
      for (const i of g) if (!prev.group.includes(i)) prev.group.push(i);
      prev.group.sort((a, b) => a - b);
    } else out.push({ group: g.slice().sort((a, b) => a - b) });
  }
  return out.map((g) => g.group);
}

/**
 * 分组 → 冗余/冲突清单。
 * @param groups        每组是**约束下标**（方程行已按 ci 去重）
 * @param residuals     每条约束求解后的残差（绝对值）
 * @returns {{redundant:Array, conflicts:Array}}
 */
function classifyGroups(groups, residuals) {
  const redundant = [], conflicts = [];
  const covered = new Set();
  for (const group of mergeGroups(groups)) {
    group.forEach((i) => covered.add(i));
    const bad = group.filter((i) => Math.abs(residuals[i] ?? 0) > RES_TOL);
    if (bad.length) {
      // 冲突：残差最大的那条是“元凶”，其余是它撞上的对象（同样报成冲突组，UI 一起标红）
      let culprit = bad[0];
      for (const i of bad) if (Math.abs(residuals[i]) >= Math.abs(residuals[culprit])) culprit = i;
      const others = group.filter((i) => i !== culprit);
      conflicts.push({ index: culprit, with: others, group: [...group], residual: residuals[culprit] });
      // 组内其它约束也是冲突的一部分（它们同样过不了），但只报一条 `conflicts` 记录以免刷屏
    } else {
      // 冗余：全部满足，但多了一条 —— 保留最早的一条，把后加的报成冗余（与 planegcs 的“后加的优先删”一致）
      redundant.push({ index: group[group.length - 1], with: group.slice(0, -1), group: [...group] });
    }
  }
  return { redundant, conflicts, covered };
}

/**
 * 冲突对象定位：把组里每条候选拆掉重解一次，看剩余约束能不能同时满足。
 * 这是 planegcs `identifyConflictingRedundantConstraints` 的启发式（谁删掉就能解通，谁就是多余的那个），
 * 只在一个组真冲突时做，且每组最多试 opts.maxProbe 次（默认 6）—— 分析在面板打开/约束变化时跑，
 * 不能让它变成 O(m) 次重解。
 */
function probeRemovable(entities, specs, group, opts) {
  const maxProbe = Math.min(opts.maxProbe ?? 6, group.length);
  for (let k = 0; k < maxProbe; k++) {
    const victim = group[k];
    const sub = specs.filter((_, i) => i !== victim);
    const clone = structuredClone(entities);
    let res;
    try {
      const cs = buildConstraints(clone, sub);
      const ps = collectParams(clone);
      res = solve(ps, cs, { paramDeps: buildParamDeps(ps, clone, sub), maxIter: opts.maxIter ?? 200 });
    } catch (_) { continue; }
    if (res.ok) return { removable: victim, feasibleWithout: true };
  }
  return { removable: null, feasibleWithout: false };
}

/**
 * 分析一张草图：真实自由度、每图元的定义状态、冗余与冲突约束。
 *
 * @param entities  草图图元数组（**不会被修改** —— 内部先克隆再求解）
 * @param specs     约束 spec 数组（可序列化纯数据）
 * @param opts      { solve?:boolean 默认 true（需要残差判断冲突）, maxProbe, rankTol, maxIter }
 * @returns 见文件头注释里的结构说明
 */
export function analyzeSketch(entities, specs = [], opts = {}) {
  const base = {
    ok: false, status: "invalid", dof: 0, rank: 0, params: 0, equations: 0,
    redundant: [], conflicts: [], entities: [], paramsList: [], messages: [],
  };
  const working = structuredClone(entities);
  let constraints, params, paramDeps;
  try {
    constraints = buildConstraints(working, specs);
    params = collectParams(working);
    paramDeps = buildParamDeps(params, working, specs);
  } catch (error) {
    if (!(error instanceof InvalidConstraintError)) throw error;
    return {
      ...base,
      invalidConstraints: error.invalidConstraints,
      messages: error.invalidConstraints.map((i) => i.message),
      entities: (entities || []).map((e, index) => ({
        index, kind: e.kind, state: e.ref ? "reference" : "underdefined", mobility: 1, movableParams: [],
      })),
    };
  }

  // ---- ① 秩：真实自由度 + 相关的约束分组
  const rows = constraintEquationRows(constraints);
  const J = equationJacobian(params, constraints, rows, paramDeps);
  const relTol = opts.rankTol ?? 1e-8;
  const { rank } = qrRank(J, rows.length, params.length, relTol);
  const { groups: rowGroups } = dependentRowGroups(J, rows.length, params.length, relTol);
  const { basis } = nullSpace(J, rows.length, params.length, relTol);
  const mobility = mobilityOf(basis, params.length);
  const dof = Math.max(0, params.length - rank);

  // ---- ② 求解（只为拿残差判冗余/冲突；几何改动只发生在克隆体上）
  // 调用方刚刚 solveSketch 过的话，把残差数组直接传进来（opts.residuals）就能省掉这一次重解。
  let residuals = new Array(constraints.length).fill(0);
  let solveResult = null;
  const reuse = Array.isArray(opts.residuals) && opts.residuals.length === constraints.length;
  if (reuse) {
    residuals = opts.residuals.map((v) => Math.abs(v));
  } else if (opts.solve !== false && constraints.length) {
    const cs = buildConstraints(working, specs);
    const ps = collectParams(working);
    solveResult = solve(ps, cs, {
      paramDeps, maxIter: opts.maxIter ?? 200,
    });
    residuals = cs.map((c) => Math.abs(c.error()));
  }

  // ---- ③ 方程行分组 → 约束分组（去重）
  const constraintGroups = [];
  for (const g of rowGroups) {
    const cis = [];
    for (const r of g) {
      const ci = rows[r]?.ci;
      if (ci != null && !cis.includes(ci)) cis.push(ci);
    }
    if (cis.length > 1) constraintGroups.push(cis);
  }
  const { redundant, conflicts, covered } = classifyGroups(constraintGroups, residuals);

  // 没有分到组的“过不去的约束”（比如常量参考本身就给不出目标值）也要报出来
  constraints.forEach((c, i) => {
    if (!covered.has(i) && Math.abs(residuals[i] ?? 0) > RES_TOL) {
      conflicts.push({ index: i, with: [], group: [i], residual: residuals[i] });
      covered.add(i);
    }
  });

  // ---- ④ 冲突对象定位（只在真冲突时，代价受 maxProbe 约束）
  // 先试“元凶”，再试同组其它成员：谁删掉就能解通，就是该删的那条（planegcs 的启发式）。
  // opts.probe === false 时跳过（状态栏/每帧刷新不需要“该删哪条”）。
  if (conflicts.length && opts.solve !== false && opts.probe !== false) {
    for (const c of conflicts) {
      if (c.group.length < 2) continue;
      const order = [c.index, ...c.group.filter((i) => i !== c.index)];
      const probe = probeRemovable(working, specs, order, opts);
      c.removable = probe.removable;
      c.feasibleWithoutRemoval = probe.feasibleWithout;
      if (probe.removable != null) {
        const other = c.group.find((i) => i !== probe.removable);
        c.pair = [probe.removable, other];
      }
    }
  }

  // ---- ⑤ 每个图元的状态
  const refEntities = new Set();
  (entities || []).forEach((e, i) => { if (e.ref) refEntities.add(i); });
  const conflictEntities = new Set();
  for (const c of conflicts) {
    for (const ci of c.group) {
      const spec = specs[ci];
      if (!spec) continue;
      for (const e of specEntities(spec)) conflictEntities.add(e);
    }
  }
  const entParams = new Map();
  params.forEach((p, j) => {
    if (p.entity == null) return;
    if (!entParams.has(p.entity)) entParams.set(p.entity, []);
    entParams.get(p.entity).push({ index: j, name: p.name, mobility: mobility[j] });
  });
  const entityStates = (entities || []).map((e, index) => {
    if (refEntities.has(index)) {
      return { index, kind: e.kind, state: "reference", mobility: 0, movableParams: [],
        color: SKETCH_STATES.reference.color };
    }
    const list = entParams.get(index) || [];
    const mov = list.length ? Math.max(...list.map((q) => q.mobility)) : 0;
    const state = conflictEntities.has(index) ? "conflict" : mov > 1e-6 ? "underdefined" : "defined";
    return {
      index, kind: e.kind, state, mobility: mov,
      color: SKETCH_STATES[state].color,
      movableParams: list.filter((q) => q.mobility > 1e-6).map((q) => q.name),
      params: list.map((q) => q.name),
    };
  });

  // ---- ⑥ 结论与文案
  const hasConflict = conflicts.length > 0 || (solveResult && !solveResult.ok);
  const anyUnder = entityStates.some((s) => s.state === "underdefined");
  const status = hasConflict ? "overdefined" : anyUnder ? "underdefined" : "defined";
  const messages = [];
  messages.push(
    status === "defined" ? "完全定义（没有剩余自由度）"
      : status === "underdefined" ? `欠定义：还剩 ${dof} 个自由度`
        : `过定义：${conflicts.length} 处约束冲突`,
  );
  for (const r of redundant) {
    messages.push(`约束 #${r.index + 1}（${specs[r.index]?.label || specs[r.index]?.type || "?"}）是冗余的 —— 与 ${r.with.map((i) => `#${i + 1}`).join("、")} 重复，删掉它不影响几何`);
  }
  for (const c of conflicts) {
    const a = `#${c.index + 1}（${specs[c.index]?.label || specs[c.index]?.type || "?"}）`;
    const b = c.with.map((i) => `#${i + 1}（${specs[i]?.label || specs[i]?.type || "?"}）`).join("、");
    messages.push(b ? `约束 ${a} 与 ${b} 冲突，无法同时满足` : `约束 ${a} 无法满足`);
    if (c.removable != null) messages.push(`建议删除 #${c.removable + 1}（删掉后其余约束可以同时满足）`);
  }

  return {
    ok: !hasConflict,
    status,
    dof,
    rank,
    params: params.length,
    equations: rows.length,
    dofApproximate: false,
    redundant,
    conflicts,
    entities: entityStates,
    paramsList: params.map((p, j) => ({ name: p.name, entity: p.entity, mobility: mobility[j], free: mobility[j] > 1e-6 })),
    nullSpaceDim: Math.max(0, params.length - rank),
    solve: solveResult ? { ok: solveResult.ok, iterations: solveResult.iterations, maxErr: solveResult.maxErr } : null,
    messages,
    statusLabel: STATE_LABEL[status],
  };
}

/**
 * 给 UI 用的一行摘要（状态栏）：`完全定义` / `欠定义 · 2 自由度` / `过定义 · 1 处冲突（#3 与 #5）`
 */
export function summarizeAnalysis(analysis) {
  if (!analysis) return "";
  if (analysis.status === "invalid") return `约束定义有误：${(analysis.messages[0] || "").slice(0, 40)}`;
  if (analysis.status === "defined") return "完全定义";
  if (analysis.status === "underdefined") {
    const free = analysis.entities.filter((e) => e.state === "underdefined").length;
    return `欠定义 · ${analysis.dof} 自由度${free ? ` · ${free} 个图元可动` : ""}`;
  }
  const c = analysis.conflicts[0];
  const pair = c && c.group.length > 1 ? `（#${c.index + 1} 与 ${c.with.map((i) => "#" + (i + 1)).join("、")}）` : "";
  return `过定义 · ${analysis.conflicts.length} 处冲突${pair}`;
}

/** 每个图元的颜色表：{ [entityIndex]: "#rrggbb" }，供 canvas 逐图元上色 */
export function entityColors(analysis) {
  const out = {};
  for (const e of analysis?.entities || []) out[e.index] = e.color || SKETCH_STATES[e.state]?.color || "#2f6fed";
  return out;
}

/** 单个图元状态（点某条线时查它属于什么状态） */
export function stateOfEntity(analysis, index) {
  return analysis?.entities?.find((e) => e.index === index) || null;
}
