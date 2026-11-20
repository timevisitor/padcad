/**
 * 装配检查：干涉 / 爆炸视图（v6 装配路 · asm）
 *
 * 干涉：先按世界包围盒预筛（n 很小，但包围盒能把绝大多数对直接跳过，
 * 真正进内核做布尔求交的只有可疑对），再用 OCCT 的 common 体积判定。
 * 阈值 1e-6 mm³ —— 面贴面（体积 0、间隙 0）不算干涉，这是工程上必须区分的
 * （与 inspect.js 的 overlaps / touches 两分法一致）。
 *
 * 爆炸：纯粹是**显示变换**。步骤存在 asm.explode 里（方向 + 距离），
 * 播放时按 factor∈[0,1] 叠加到实例位姿上；配合数据一个字节都不动，
 * resetExplode() 能把位姿逐位复原（回归里断言 deepEqual）。
 */
import { measureVolume } from "replicad";
import { interference, massProperties } from "./inspect.js";
import { assemblyShapes, copyShape, instanceById, vAdd, vNorm, vScale, vSub } from "./assembly.js";

// ---------------------------------------------------------------- 包围盒
export function shapeBounds(shape) {
  const bb = shape.boundingBox;
  const min = [bb.center[0] - bb.width / 2, bb.center[1] - bb.height / 2, bb.center[2] - bb.depth / 2];
  const max = [bb.center[0] + bb.width / 2, bb.center[1] + bb.height / 2, bb.center[2] + bb.depth / 2];
  return { min, max, center: [...bb.center], size: [bb.width, bb.height, bb.depth] };
}

export function boundsOverlap(a, b, tol = 1e-9) {
  for (let i = 0; i < 3; i++) {
    if (a.min[i] > b.max[i] + tol || b.min[i] > a.max[i] + tol) return false;
  }
  return true;
}

/**
 * 两两干涉检查。
 * opts: { tolerance=1e-6, includeHidden=false, maxPairs }
 * 返回 { pairs:[{a,b,names,volume,bounds:[min,max]}], checked, skipped, totalVolume, candidates }
 *  - checked：真正进内核的对数（预筛之后）
 *  - skipped：被包围盒排除的对数
 */
export function interferenceReport(asm, partShapes, opts = {}) {
  const { tolerance = 1e-6, includeHidden = false } = opts;
  const instances = asm.instances.filter((i) => includeHidden || i.visible !== false);
  const shaped = instances.map((instance) => {
    const shape = assemblyShapes({ instances: [instance] }, partShapes)[0].shape;
    return { instance, shape, box: shapeBounds(shape) };
  });
  const pairs = [];
  let checked = 0, skipped = 0;
  for (let i = 0; i < shaped.length; i++) {
    for (let j = i + 1; j < shaped.length; j++) {
      const A = shaped[i], B = shaped[j];
      if (!boundsOverlap(A.box, B.box)) { skipped++; continue; }
      checked++;
      // 必需：布尔运算会吃掉传进去的实体，而实例形状是缓存里共享的
      // （replicad 的 clone() 只是重包装同一句柄），所以先做真正的独立副本。
      const hit = interference(copyShape(A.shape), copyShape(B.shape));
      if (hit.volume > tolerance) {
        pairs.push({
          a: A.instance.id, b: B.instance.id,
          names: [A.instance.name, B.instance.name],
          volume: hit.volume,
        });
      }
    }
  }
  const totalVolume = pairs.reduce((s, p) => s + p.volume, 0);
  return { pairs, checked, skipped, totalVolume, instances: shaped.length };
}

/** 装配体总质量属性（体积 = 各实例体积之和；包围盒为整体包围盒） */
export function assemblyMassProperties(asm, partShapes) {
  let volume = 0, area = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const { shape } of assemblyShapes(asm, partShapes)) {
    const p = massProperties(shape);
    volume += p.volume;
    area += p.area;
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p.bbox.min[i]);
      max[i] = Math.max(max[i], p.bbox.max[i]);
    }
  }
  return { volume, area, bbox: { min, max, size: vSub(max, min) }, instances: asm.instances.length };
}

// ---------------------------------------------------------------- 爆炸视图
const EXPLODE_KEY = "__explodeBase";

export function explodePlan(asm) {
  return (asm.explode || []).map((s) => ({ ...s, dir: vNorm(s.dir || [0, 0, 1]), distance: Number(s.distance) || 0 }));
}

/** 加/更新一条爆炸步骤（同一实例只保留一条，方向距离可反复改） */
export function setExplodeStep(asm, { instance, dir = [0, 0, 1], distance = 20, label = null }) {
  if (!instanceById(asm, instance)) throw new Error(`实例 ${instance} 不存在`);
  asm.explode = asm.explode || [];
  const exist = asm.explode.find((s) => s.instance === instance);
  const step = {
    id: exist?.id || `e${asm.explode.length + 1}`,
    instance, dir: vNorm(dir), distance: Number(distance) || 0,
    label: label || null,
  };
  if (exist) Object.assign(exist, step); else asm.explode.push(step);
  return step;
}

/**
 * 自动排爆炸步骤（一键爆炸）：沿「装配中心 → 实例中心」方向散开，
 * 距离按序号递增；中心重合时退化为 +Z（叠放板件的常见情形）。
 */
export function autoExplode(asm, partShapes, { gap = 40 } = {}) {
  const shaped = assemblyShapes(asm, partShapes).map(({ instance, shape }) => ({
    instance, center: shapeBounds(shape).center,
  }));
  if (!shaped.length) return [];
  const center = shaped.reduce((acc, s) => vAdd(acc, s.center), [0, 0, 0]).map((v) => v / shaped.length);
  const steps = [];
  shaped.forEach((s, i) => {
    let dir = vSub(s.center, center);
    if (Math.hypot(...dir) < 1e-6) dir = [0, 0, 1];
    steps.push(setExplodeStep(asm, { instance: s.instance.id, dir, distance: gap * (i + 1) }));
  });
  return steps;
}

/** 按 factor 算爆炸后的位姿（纯函数，不改 asm）：{ instId: transform }
 *  base 取「爆炸前记下的原始位姿」（有的话），所以 factor 可以来回拖而不会累积。 */
export function explodePoses(asm, factor = 1) {
  const out = {};
  const plan = explodePlan(asm);
  for (const inst of asm.instances) {
    const base = asm[EXPLODE_KEY]?.[inst.id] || inst.transform;
    const step = plan.find((s) => s.instance === inst.id);
    if (!step || !factor) { out[inst.id] = { t: [...base.t], r: [...base.r] }; continue; }
    out[inst.id] = {
      t: vAdd(base.t, vScale(step.dir, step.distance * factor)),
      r: [...base.r],
    };
  }
  return out;
}

/**
 * 应用爆炸（改实例位姿，供渲染层直接吃）。
 * 首次调用会把原位置记进 asm[EXPLODE_KEY]，之后每次都从这份原位置重算，
 * 所以滑杆来回拖不会累积误差；resetExplode() 逐位还原。
 */
export function applyExplode(asm, factor = 1) {
  if (!asm[EXPLODE_KEY]) {
    asm[EXPLODE_KEY] = Object.fromEntries(asm.instances.map((i) => [i.id, JSON.parse(JSON.stringify(i.transform))]));
  }
  const poses = explodePoses(asm, factor);
  for (const inst of asm.instances) {
    if (poses[inst.id]) inst.transform = poses[inst.id];
  }
  asm.explodeFactor = factor;
  return asm;
}

/** 复原：位姿回到爆炸前，配合数据从未改动 */
export function resetExplode(asm) {
  const base = asm[EXPLODE_KEY];
  if (base) {
    for (const inst of asm.instances) if (base[inst.id]) inst.transform = JSON.parse(JSON.stringify(base[inst.id]));
    delete asm[EXPLODE_KEY];
  }
  delete asm.explodeFactor;
  return asm;
}

export const isExploded = (asm) => !!asm[EXPLODE_KEY];

/** 爆炸后的实例形状（不落盘、不改 asm，直接给渲染用） */
export function explodedShapes(asm, partShapes, factor = 1) {
  const poses = explodePoses(asm, factor);
  return asm.instances.map((inst) => {
    const view = { ...inst, transform: poses[inst.id] };
    const { instance, shape } = assemblyShapes({ instances: [view] }, partShapes)[0];
    return { instance, shape, factor };
  });
}

/** 单实例体积（BOM/校核常用） */
export function instanceVolume(shape) {
  try { return measureVolume(shape); } catch (_) { return 0; }
}
