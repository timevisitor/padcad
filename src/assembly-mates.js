/**
 * 装配配合求解（v6 装配路 · asm）
 *
 * 做法：每个浮动实例 6 个自由度（平移 3 + 旋转向量 3），每个配合贡献若干残差方程，
 * 用 Levenberg–Marquardt 解 r(x)=0。为什么不是「逐对解析定位」：
 * 解析法只扛得住链式装配（每次只有一个未知实例），遇到闭环（A-B-C-A）、
 * 一个实例同时被多个配合约束、或者拖动时保配合，就没法算。
 * LM 统一处理，并且顺手给出自由度 / 过定义 / 冲突三类诊断 —— 这三样正是
 * SolidWorks 用户在装配体里最需要看见的信息（SW 用 (-) / 标红 / MateXpert 表达）。
 *
 * 与 solver.js 的关系：那个是 2D 草图约束求解器（变量是草图点、残差是距离/角度/共线），
 * 和这里的「6DOF 刚体位姿」语义完全不同，所以独立实现，不动它一行。
 *
 * 残差清单（与 调研.md §1 的 DOF 表一一对应）：
 *   coincident    面-面：法向对齐(3,秩2) + 沿法向间距(1)      → 秩 3
 *                 点-点：位置差(3)                            → 秩 3
 *                 点-面：沿面法向间距(1)                      → 秩 1
 *   concentric    轴-轴：方向叉积(3,秩2) + 轴线径向偏移(3,秩2) → 秩 4
 *   distance      面-面：法向对齐 + 间距−value                  → 秩 3
 *                 点-点：|pB−pA|−value / 点-面：沿法向−value  → 秩 1
 *   angle         方向余弦对齐（面法向/轴线）                    → 秩 1
 *   parallel      叉积（面法向/轴线）                            → 秩 2
 *   perpendicular 点积                                          → 秩 1
 *   lock          与「b 帧」冻结一致：旋转误差(3) + 位置差(3)     → 秩 6
 *
 * 数值要点：
 *  - 旋转用**局部增量**（R = Rd(ω)·R_base，ω 为旋转向量）更新，避开万向锁；
 *  - Jacobian 中心差分（h=1e-6），n 很小（6×浮动实例数），一次求解几十次残差评估就够；
 *  - 秩用「行归一化 + Gram–Schmidt」算，平移(mm)与转角(rad)量纲不同也不会误判。
 */
import {
  instanceById, matMul, normalizeTransform, poseCompose, poseFromTransform, poseInvert,
  quatFromRotationVector, quatToMatrix, rotationError, transformFromPose, transformRef,
  vCross, vDot, vNorm, vScale, vSub,
} from "./assembly.js";

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
const maxAbs = (arr) => arr.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const norm = (arr) => Math.sqrt(dot(arr, arr));

/** 把 a 相对 b 的位姿记下来（lock 配合的冻结基准） */
export function relativePose(asm, instA, instB) {
  const a = instanceById(asm, instA), b = instanceById(asm, instB);
  if (!a || !b) throw new Error("lock 配合引用的实例不存在");
  return transformFromPose(poseCompose(poseInvert(poseFromTransform(b.transform)), poseFromTransform(a.transform)));
}

// ---------------------------------------------------------------- 残差
function residualOfMate(mate, ra, rb, poseA, poseB) {
  const type = mate.type;
  const value = Number(mate.value) || 0;
  const s = mate.flip ? 1 : -1;          // 默认反向贴合（法向相对），flip=true 才是同向
  if (type === "lock") {
    const rel = mate.rel || { t: [0, 0, 0], r: [0, 0, 0, 1] };
    const target = poseCompose(poseB, poseFromTransform(normalizeTransform(rel)));
    return [...rotationError(poseA.R, target.R), ...vSub(poseA.t, target.t)];
  }
  const ka = mate.a.ref.kind, kb = mate.b.ref.kind;

  if (type === "coincident") {
    if (ka === "plane" && kb === "plane") {
      const d = vSub(rb.point, ra.point);
      // 默认 s=-1：B 的法向与 A 相对（反向贴合）；flip 时同向
      return [...vSub(rb.normal, vScale(ra.normal, s)), vDot(d, ra.normal)];
    }
    if (ka === "point" && kb === "point") return vSub(rb.point, ra.point);
    if (ka === "point" && kb === "plane") return [vDot(vSub(ra.point, rb.point), rb.normal)];
    return [vDot(vSub(rb.point, ra.point), ra.normal)];          // plane - point
  }

  if (type === "concentric") {
    const d = vSub(rb.point, ra.point);
    const perp = vSub(d, vScale(ra.direction, vDot(d, ra.direction)));
    return [...vCross(ra.direction, rb.direction), ...perp];
  }

  if (type === "distance") {
    if (ka === "plane" && kb === "plane") {
      const d = vSub(rb.point, ra.point);
      return [...vSub(rb.normal, vScale(ra.normal, s)), vDot(d, ra.normal) - value];
    }
    if (ka === "point" && kb === "point") return [norm(vSub(rb.point, ra.point)) - Math.abs(value)];
    if (ka === "point" && kb === "plane") return [vDot(vSub(ra.point, rb.point), rb.normal) - value];
    return [vDot(vSub(rb.point, ra.point), ra.normal) - value];
  }

  if (type === "angle") {
    const target = Math.cos((value * Math.PI) / 180);
    if (ka === "plane" && kb === "plane") return [vDot(ra.normal, rb.normal) - target];
    return [vDot(ra.direction, rb.direction) - target];
  }

  if (type === "parallel") {
    if (ka === "plane" && kb === "plane") return vCross(ra.normal, rb.normal);
    if (ka === "axis" && kb === "axis") return vCross(ra.direction, rb.direction);
    const a = ka === "plane" ? ra.normal : ra.direction;
    const b = kb === "plane" ? rb.normal : rb.direction;
    return vCross(a, b);
  }

  if (type === "perpendicular") {
    if (ka === "plane" && kb === "plane") return [vDot(ra.normal, rb.normal)];
    if (ka === "axis" && kb === "axis") return [vDot(ra.direction, rb.direction)];
    const a = ka === "plane" ? ra.normal : ra.direction;
    const b = kb === "plane" ? rb.normal : rb.direction;
    return [vDot(a, b)];
  }
  throw new Error(`未知配合类型 ${type}`);
}

// ---------------------------------------------------------------- 状态 / 评估
function buildState(asm, pinned) {
  const free = [];
  const base = new Map();
  for (const inst of asm.instances) {
    base.set(inst.id, poseFromTransform(inst.transform));
    if (!inst.fixed && !pinned.has(inst.id)) free.push(inst.id);
  }
  return { free, base };
}

function posesAt(state, x) {
  const poses = new Map(state.base);
  state.free.forEach((id, k) => {
    const b = state.base.get(id);
    const o = k * 6;
    const dt = [x[o], x[o + 1], x[o + 2]];
    const rv = [x[o + 3], x[o + 4], x[o + 5]];
    const Rd = quatToMatrix(quatFromRotationVector(rv));
    poses.set(id, { t: [b.t[0] + dt[0], b.t[1] + dt[1], b.t[2] + dt[2]], R: matMul(Rd, b.R) });
  });
  return poses;
}

function evaluate(mates, state, x) {
  const poses = posesAt(state, x);
  const r = [];
  const perMate = [];
  for (const m of mates) {
    const pa = poses.get(m.a.inst), pb = poses.get(m.b.inst);
    if (!pa || !pb) continue;
    let res;
    try {
      const ra = m.a.ref ? transformRef(m.a.ref, pa) : null;
      const rb = m.b.ref ? transformRef(m.b.ref, pb) : null;
      res = residualOfMate(m, ra, rb, pa, pb);
    } catch (e) {
      perMate.push({ id: m.id, start: r.length, n: 0, residual: 0, error: e.message });
      continue;
    }
    perMate.push({ id: m.id, start: r.length, n: res.length, residual: norm(res) });
    for (const v of res) r.push(v);
  }
  return { r, perMate, poses };
}

function jacobian(mates, state, x, m0, n) {
  const J = Array.from({ length: m0 }, () => new Array(n).fill(0));
  const h = 1e-6;
  for (let j = 0; j < n; j++) {
    const xp = x.slice(), xm = x.slice();
    xp[j] += h; xm[j] -= h;
    const rp = evaluate(mates, state, xp).r;
    const rm = evaluate(mates, state, xm).r;
    for (let i = 0; i < m0; i++) J[i][j] = ((rp[i] ?? 0) - (rm[i] ?? 0)) / (2 * h);
  }
  return J;
}

/** 带主元高斯消元：A x = b（A 就地改写；奇异返回 null） */
function solveLinear(A, b) {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-14) return null;
    if (piv !== col) { [A[piv], A[col]] = [A[col], A[piv]]; [b[piv], b[col]] = [b[col], b[piv]]; }
    const d = A[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / d;
      if (!f) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c];
    x[r] = s / A[r][r];
  }
  return x;
}

/** 秩：行归一化后 Gram–Schmidt（与量纲无关） */
function rankOfRows(rows, tol = 1e-6) {
  const basis = [];
  for (const row of rows) {
    const nrm = norm(row);
    if (!(nrm > 1e-12)) continue;
    let v = row.map((x) => x / nrm);
    for (const b of basis) {
      const d = dot(v, b);
      if (d) v = v.map((x, i) => x - d * b[i]);
    }
    const nv = norm(v);
    if (nv > tol) basis.push(v.map((x) => x / nv));
  }
  return basis.length;
}

/**
 * 退化逃逸：当残差不为零但梯度恰好为零（例如「从完全平行开始要求垂直」——
 * nA·nB 在 nA∥nB 处是极值点，一阶导数为 0），LM 会原地不动。
 * 这里给某个浮动实例一个确定的 ~11.5° 微转，把它踢离驻点；方向由参考方向叉乘最不平行的基准轴决定
 * （确定性，不用随机数，回归可复现）。
 */
function kickDegenerate(mates, state, x, ev) {
  const bad = ev.perMate.find((p) => p.residual > 1e-9);
  if (!bad) return false;
  const mate = mates.find((m) => m.id === bad.id);
  if (!mate) return false;
  const side = state.free.includes(mate.b.inst) ? "b" : state.free.includes(mate.a.inst) ? "a" : null;
  if (!side) return false;
  const k = state.free.indexOf(mate[side].inst);
  const ref = mate[side].ref;
  if (!ref) return false;
  const dir = ref.kind === "plane" ? ref.normal : ref.kind === "axis" ? ref.direction : [0, 0, 1];
  const basis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].find((b) => Math.abs(vDot(b, dir)) < 0.9) || [1, 0, 0];
  const axis = vNorm(vCross(dir, basis));
  const o = k * 6 + 3;
  const kick = 0.2;
  x[o] += axis[0] * kick; x[o + 1] += axis[1] * kick; x[o + 2] += axis[2] * kick;
  return true;
}

// ---------------------------------------------------------------- 求解入口
/**
 * 求解整个装配体。
 * opts: { tol, maxIter, pin:[instId], reportTol, lambdaInit }
 * 返回：{ ok, status:"solved"|"conflict", iterations, maxResidual, dof, rank, freeInstances,
 *         conflicts, redundantMates, perMate:[{id,residual,dofRemoved}], transforms }
 * 解出的位姿写回 asm.instances[i].transform（固定件不动）。
 */
export function solveAssembly(asm, opts = {}) {
  const { tol = 1e-9, maxIter = 80, pin = [], reportTol = 1e-6, lambdaInit = 1e-3, debug = false } = opts;
  const trace = debug ? [] : null;
  const pinned = new Set(pin);
  const mates = asm.mates.filter((m) => !m.suppressed);
  for (const m of mates) {
    if (m.type === "lock" && !m.rel) m.rel = relativePose(asm, m.a.inst, m.b.inst);
  }
  const state = buildState(asm, pinned);
  const n = state.free.length * 6;
  let x = new Array(n).fill(0);
  let ev = evaluate(mates, state, x);
  let cost = dot(ev.r, ev.r);
  let lambda = lambdaInit;
  let iter = 0;
  let kicks = 0;
  let maxRes = maxAbs(ev.r);

  while (maxRes > tol && iter < maxIter && n > 0 && ev.r.length > 0) {
    iter++;
    const J = jacobian(mates, state, x, ev.r.length, n);
    const g = new Array(n).fill(0);
    for (let i = 0; i < ev.r.length; i++) {
      for (let j = 0; j < n; j++) g[j] += J[i][j] * ev.r[i];
    }
    if (norm(g) < 1e-14 && maxRes > tol) {
      // 驻点但不满足：踢一下再试；踢不动就认输（真冲突）
      if (kicks < 3 && kickDegenerate(mates, state, x, ev)) {
        kicks++;
        ev = evaluate(mates, state, x);
        cost = dot(ev.r, ev.r);
        maxRes = maxAbs(ev.r);
        continue;
      }
      break;
    }
    let accepted = false;
    for (let attempt = 0; attempt < 10 && !accepted; attempt++) {
      const A = Array.from({ length: n }, () => new Array(n).fill(0));
      for (let a = 0; a < n; a++) {
        for (let b = a; b < n; b++) {
          let s = 0;
          for (let i = 0; i < ev.r.length; i++) s += J[i][a] * J[i][b];
          A[a][b] = s; A[b][a] = s;
        }
      }
      // 统一阻尼（Levenberg 原式）：A = JᵀJ + λI 的特征空间与 J 的行空间一致，
      // 所以 GN 步不会往**零空间**泄漏 —— 这是「解好的装配体再解一次不漂」的关键。
      // （Marquardt 的 diag(A) 阻尼会把步长混进零空间，实测会让锁定件相对姿态漂 2°。）
      for (let a = 0; a < n; a++) A[a][a] += lambda;
      const dx = solveLinear(A, g.map((v) => -v));
      if (!dx || !dx.every(Number.isFinite)) { lambda *= 8; continue; }
      const xt = x.map((v, i) => v + dx[i]);
      const et = evaluate(mates, state, xt);
      const ct = dot(et.r, et.r);
      if (trace) trace.push({ iter, attempt, cost, ct, lambda, gn: norm(g), dx: norm(dx) });
      if (ct < cost) {
        x = xt; ev = et; cost = ct;
        maxRes = maxAbs(ev.r);
        lambda = Math.max(lambda / 4, 1e-12);
        accepted = true;
      } else {
        lambda *= 8;
      }
    }
    if (!accepted) break;      // 卡住：残差降不下去（典型是配合矛盾）
  }

  // ---- 写回（只动真正被解过的实例，避免把固定件/已解好的件在 bit 级别扰动）
  const transforms = {};
  state.free.forEach((id, k) => {
    const o = k * 6;
    const moved = x.slice(o, o + 6).some((v) => Math.abs(v) > 1e-12);
    const inst = instanceById(asm, id);
    if (moved) inst.transform = transformFromPose(ev.poses.get(id));
    transforms[id] = { ...inst.transform };
  });

  // ---- 诊断
  const J = ev.r.length ? jacobian(mates, state, x, ev.r.length, n) : [];
  const rank = rankOfRows(J);
  const dof = Math.max(0, n - rank);
  const perMate = [];
  let acc = [];
  for (const info of ev.perMate) {
    const rows = info.n ? J.slice(info.start, info.start + info.n) : [];
    const before = rankOfRows(acc);
    const after = rankOfRows([...acc, ...rows]);
    acc = [...acc, ...rows];
    const mate = mates.find((m) => m.id === info.id);
    perMate.push({
      id: info.id, type: mate?.type,
      residual: info.residual,
      dofRemoved: after - before,
      ...(info.error ? { error: info.error } : {}),
    });
  }
  const conflicts = perMate.filter((m) => m.residual > reportTol).map((m) => m.id);
  const redundantMates = perMate.filter((m) => m.residual <= reportTol && m.dofRemoved === 0).map((m) => m.id);
  const status = maxRes <= reportTol ? "solved" : "conflict";

  return {
    ok: status === "solved",
    status,
    iterations: iter,
    maxResidual: maxRes,
    dof, rank, variables: n,
    freeInstances: [...state.free],
    fixedInstances: asm.instances.filter((i) => i.fixed || pinned.has(i.id)).map((i) => i.id),
    equations: ev.r.length,
    conflicts,
    redundantMates,
    overDefined: redundantMates.length > 0,
    perMate,
    ...(trace ? { trace } : {}),
    transforms,
  };
}

/** 内部诊断出口：秩/雅可比（回归与探针用，不属于对外 API 的稳定承诺） */
export const __internals = { buildState, posesAt, evaluate, jacobian, rankOfRows, residualOfMate };

/** 单个配合在当前位姿下的残差（UI 诊断用，不求解） */
export function mateResidual(asm, mate) {
  const state = buildState(asm, new Set());
  const ev = evaluate([mate], state, new Array(state.free.length * 6).fill(0));
  const info = ev.perMate[0];
  return info ? { id: mate.id, residual: info.residual, components: ev.r } : null;
}

/**
 * 拖动一个实例到新位姿，让其余实例重新求解以保住配合
 * （等价 FreeCAD 的 preDrag / doDragStep：被拖的件在这轮里临时当固定件）。
 */
export function dragInstance(asm, instId, transform, opts = {}) {
  const inst = instanceById(asm, instId);
  if (!inst) throw new Error(`实例 ${instId} 不存在`);
  inst.transform = normalizeTransform(transform);
  if (opts.solve === false) return null;
  return solveAssembly(asm, { ...opts, pin: [instId, ...(opts.pin || [])] });
}

/** 改配合值（距离/角度），可选重新求解 */
export function setMateValue(asm, mateId, value, opts = {}) {
  const mate = asm.mates.find((m) => m.id === mateId);
  if (!mate) throw new Error(`配合 ${mateId} 不存在`);
  mate.value = Number(value);
  return opts.solve === false ? null : solveAssembly(asm, opts);
}

/** 压制 / 解除压制一条配合 */
export function suppressMate(asm, mateId, suppressed = true, opts = {}) {
  const mate = asm.mates.find((m) => m.id === mateId);
  if (!mate) throw new Error(`配合 ${mateId} 不存在`);
  mate.suppressed = !!suppressed;
  return opts.solve === false ? null : solveAssembly(asm, opts);
}
