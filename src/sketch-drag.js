/**
 * 拖动保约束（v6 智能草图）
 *
 * 需求（对齐 SolidWorks / Shapr3D）：拖动欠定义的图元时，几何跟着手指走，**已有约束不许破**；
 * 完全定义（或拖动方向上被约束死）的图元拖不动，要明确告诉 UI（blocked），不能悄悄变形。
 *
 * 做法（planegcs 的拖动也是同一套思路）：
 *   把被拖的点/图元变成**软目标**（一个权重很小的最小二乘项），其余约束全部当**硬约束**，一起丢进 LM：
 *     min  Σ 硬约束残差²  +  Σ (w · 目标偏离)²
 *   权重取小（默认 0.02）是关键：
 *     - 有自由度的方向上，硬约束不产生任何代价 → 点会**精确**落到目标上（代价降到 0）；
 *     - 被约束死的方向上，动一点点就要付硬约束的代价 → 求解器宁可偏离目标，几何不变形。
 *   反过来若给软目标一个大权重，完全定义的图元就会被拖着走（实测过：固定矩形能整体平移，那是错的）。
 *
 * 为什么不用“临时 fixedPoint”：那是把目标当硬约束，系统一旦矛盾（拖不出这个位置），
 * LM 会把**别的**硬约束撕开去凑目标 —— 这正是“拖动把草图拖坏”的经典 bug。
 *
 * 性能：只解**被拖图元所在的约束连通分量**（planegcs 的 SubSystem 策略）。
 * 50 图元、互不相连的草图上拖一个矩形，只需要解 4 个自由度 —— 一帧内跑几十次都没问题。
 */

import {
  Constraint, buildConstraints, collectParams, buildParamDeps, pointOf, solve, specEntities,
} from "./solver.js";

/** 软目标：把若干个自由度往目标值上拉，权重小（求解时硬约束优先） */
class SoftTargets extends Constraint {
  /**
   * @param getters 取当前值的函数数组
   * @param targets 目标值数组
   * @param weight  权重（越小 = 硬约束越优先）
   */
  constructor(getters, targets, weight, label = "拖动目标") {
    super([], label);
    this.getters = getters;
    this.targets = targets;
    this.weight = weight;
  }
  error() {
    let s = 0;
    for (let i = 0; i < this.getters.length; i++) {
      const d = (this.getters[i]() - this.targets[i]) * this.weight;
      s += d * d;
    }
    return Math.sqrt(s);
  }
  equations() {
    return this.getters.map((g, i) => (g() - this.targets[i]) * this.weight);
  }
}

const clone = (v) => structuredClone(v);
const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** 图元的"锚点"（整块拖动时用来算平移量）：矩形/圆取中心，折线取第一个点 */
function anchorOf(ent) {
  if (!ent) return null;
  if (ent.kind === "rect" || ent.kind === "circle") return [ent.c[0], ent.c[1]];
  if (ent.kind === "polyline" && ent.pts.length) return [ent.pts[0][0], ent.pts[0][1]];
  return null;
}

/**
 * 与根图元**通过约束连通**的可动图元集合（并查集），可按“约束跳数”限幅。
 *
 * 为什么要限幅：一条 50 段的链条（每段端点重合 + 水平）整体平移是 100 个自由度的耦合问题，
 * 数值 Jacobian + 稠密线性代数在 node 下要几百毫秒 —— 手指拖动根本跟不住。
 * 真实 CAD 的拖动也不是“整张草图一起解”：Shapr3D/SolidWorks 拖一个点，动的是**附近**的欠定义几何。
 * 所以默认只解拖动点 4 跳以内的图元（maxHops=4），更远的保持不动；
 * 约束该满足的照样满足（跨界的约束也在解里，只是外侧参数被冻结）。
 * 需要整图求解时传 maxHops: Infinity。
 *
 * 引用图元（e.ref，模型投影）没有自由度，不参与连通性 —— 它不会因为拖动而移动。
 */
export function connectedComponent(entities, specs, roots, opts = {}) {
  const n = (entities || []).length;
  // 默认不限跳数（整分量求解，语义最干净）；需要压低最坏延迟时可传 maxHops: 4 之类
  const maxHops = opts.maxHops ?? Infinity;
  const movable = (i) => i >= 0 && i < n && entities[i] && !entities[i].ref;
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  };
  for (const spec of specs || []) {
    const refs = [...specEntities(spec)].filter(movable);
    for (let i = 0; i < refs.length; i++) {
      for (let k = i + 1; k < refs.length; k++) link(refs[i], refs[k]);
    }
  }
  const out = new Set();
  if (maxHops === Infinity) {
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (const [a, list] of adj) for (const b of list) {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    }
    for (const r of roots) {
      if (!movable(r)) continue;
      const root = find(r);
      for (let i = 0; i < n; i++) if (movable(i) && find(i) === root) out.add(i);
    }
    return out;
  }
  // 受限 BFS：跳数从拖动图元算起
  let frontier = new Set();
  for (const r of roots) if (movable(r)) { out.add(r); frontier.add(r); }
  for (let hop = 0; hop < maxHops && frontier.size; hop++) {
    const next = new Set();
    for (const a of frontier) {
      for (const b of adj.get(a) || []) {
        if (out.has(b)) continue;
        out.add(b);
        next.add(b);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * 拖一个点或整个图元，保持所有约束。
 *
 * @param entities 草图图元（**不会**被修改；结果在返回值里）
 * @param specs    约束 spec 数组
 * @param drag     { kind:"point", ref:{e,p}, to:[x,y] }  拖动某个具名点
 *                 | { kind:"entity", e, to:[x,y] }       拖动整个图元（按锚点平移）
 *                 | { kind:"entity", e, delta:[dx,dy] }  同上，但给位移
 * @param opts     { weight 软目标权重(默认 0.02), blockTol 判定拖不动的距离(默认 0.1mm),
 *                   maxIter, isolated 只解连通分量(默认 true) }
 * @returns {
 *   entities, ok, blocked, moved, iterations, ms, maxErr, dof, target, achieved, reason,
 *   component: 参与求解的图元个数
 * }
 */
export function dragSolve(entities, specs = [], drag, opts = {}) {
  const t0 = nowMs();
  const base = clone(entities);
  const fail = (reason) => ({ entities: clone(entities), ok: false, blocked: true, moved: 0, iterations: 0,
    ms: nowMs() - t0, maxErr: Infinity, target: null, achieved: null, reason, component: 0 });

  if (!drag || !drag.kind) return fail("拖动参数无效");
  const weight = opts.weight ?? 0.02;
  const blockTol = opts.blockTol ?? 0.1;
  // 默认不限跳数（整分量求解，语义最干净）；需要压低最坏延迟时可传 maxHops: 4 之类
  const maxHops = opts.maxHops ?? Infinity;
  const leastNorm = opts.leastNorm !== false;   // 拖动天然是“尽量少动”，最小范数步最贴合

  const dragEntity = drag.kind === "point" ? (drag.ref?.e ?? drag.e) : drag.e;
  if (!Number.isInteger(dragEntity) || !base[dragEntity]) return fail("要拖的图元不存在");
  if (base[dragEntity].ref) return fail("引用图元是模型投影，不能拖");

  /** 在给定的图元子集上解一次；返回 {work, res, moved, target, achieved, blocked} */
  const attempt = (comp, hopsLabel) => {
    const work = clone(base);
    comp.add(dragEntity);
    const subSpecs = [];
    (specs || []).forEach((s) => {
      if ([...specEntities(s)].some((e) => comp.has(e))) subSpecs.push(s);
    });
    let constraints;
    try { constraints = buildConstraints(work, subSpecs); }
    catch (error) { return { error: `约束定义有误：${error.message || error}` }; }
    const nHard = constraints.length;
    const params = collectParams(work).filter((p) => comp.has(p.entity));

    let target = null, achievedOf = null;
    if (drag.kind === "point") {
      const ref = drag.ref || { e: drag.e, p: drag.p };
      const pr = pointOf(work, ref?.e, ref?.p);
      if (!pr) return { error: "要拖的点不存在（引用图元的点不能拖）" };
      const to = drag.to;
      if (!Array.isArray(to) || !Number.isFinite(to[0]) || !Number.isFinite(to[1])) return { error: "拖动目标坐标无效" };
      target = [to[0], to[1]];
      achievedOf = () => [pr.vx, pr.vy];
      constraints.push(new SoftTargets([() => pr.vx, () => pr.vy], [to[0], to[1]], weight));
    } else if (drag.kind === "entity") {
      const ent = work[drag.e];
      const anchor = anchorOf(ent);
      if (!anchor) return { error: "这个图元没有可拖的锚点" };
      let delta;
      if (Array.isArray(drag.delta)) delta = [drag.delta[0], drag.delta[1]];
      else if (Array.isArray(drag.to)) delta = [drag.to[0] - anchor[0], drag.to[1] - anchor[1]];
      else return { error: "拖动目标坐标无效" };
      if (!Number.isFinite(delta[0]) || !Number.isFinite(delta[1])) return { error: "拖动位移无效" };
      target = [anchor[0] + delta[0], anchor[1] + delta[1]];
      achievedOf = () => anchorOf(ent);
      // 图元的每个可动参数都跟着平移（矩形 c 平移、w/h 不变；圆 r 不变；折线所有点平移）
      const getters = [], targets = [];
      if (ent.kind === "rect" || ent.kind === "circle") {
        getters.push(() => ent.c[0]); targets.push(ent.c[0] + delta[0]);
        getters.push(() => ent.c[1]); targets.push(ent.c[1] + delta[1]);
      } else if (ent.kind === "polyline") {
        ent.pts.forEach((q, k) => {
          getters.push(() => ent.pts[k][0]); targets.push(q[0] + delta[0]);
          getters.push(() => ent.pts[k][1]); targets.push(q[1] + delta[1]);
        });
      }
      constraints.push(new SoftTargets(getters, targets, weight));
    } else {
      return { error: `未知拖动类型 ${drag.kind}` };
    }

    const deps = buildParamDeps(params, work, subSpecs);
    params.forEach((p, j) => {
      if (p.entity === dragEntity && !deps[j].includes(nHard)) deps[j].push(nHard);
    });
    const maxIter = opts.maxIter ?? 120;
    const res = solve(params, constraints, { paramDeps: deps, maxIter, leastNorm, algorithm: opts.algorithm });
    const achieved = achievedOf();
    const moved = Math.hypot(achieved[0] - target[0], achieved[1] - target[1]);
    return { work, res, moved, target, achieved, blocked: moved > blockTol || res.maxErr > 1e-3, comp: comp.size, hopsLabel };
  };

  /*
   * 先按“约束跳数”限幅解（快），解出来是被约束挡住时才用**整分量**再解一次。
   * 为什么要有这一层回退：限幅把链条剪断了，跨界那条约束会让局部问题无解 ——
   * 直接报 blocked 就是“明明能拖却说拖不动”。慢一点也要给正确答案。
   */
  const near = connectedComponent(base, specs, [dragEntity], { maxHops });
  let out = attempt(near);
  if (out.error) return fail(out.error);
  if (out.blocked && Number.isFinite(maxHops)) {
    const full = connectedComponent(base, specs, [dragEntity], { maxHops: Infinity });
    if (full.size > near.size) {
      const wide = attempt(full);
      if (!wide.error && (!wide.blocked || wide.moved < out.moved)) out = wide;
    }
  }

  const ms = nowMs() - t0;
  if (out.blocked) {
    // 回滚：不返回半拉子几何（否则用户以为拖成功了，其实是错的形）
    return { entities: clone(entities), ok: false, blocked: true, moved: out.moved,
      iterations: out.res.iterations, ms, maxErr: out.res.maxErr, target: out.target,
      achieved: out.achieved, reason: "这个方向上被约束住了，拖不动", component: out.comp };
  }
  return { entities: out.work, ok: true, blocked: false, moved: out.moved,
    iterations: out.res.iterations, ms, maxErr: out.res.maxErr, target: out.target,
    achieved: out.achieved, reason: "", component: out.comp };
}

/** 拖动预览：UI 每次 pointermove 调一次，blocked 时拿到的就是原几何 */
export function dragPreview(entities, specs, drag, opts = {}) {
  const r = dragSolve(entities, specs, drag, opts);
  return { entities: r.entities, blocked: r.blocked, achieved: r.achieved, ms: r.ms };
}
