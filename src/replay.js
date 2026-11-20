/**
 * 参数化重放引擎
 *
 * 为什么需要它：之前的历史存的是「结果快照」（history[i].shape），
 * 所以只能回退，改不了历史参数。改成存「定义」（op）之后，
 * 重建就从起始零件开始把每一步重跑一遍 —— 改了第 2 步，后面全部自动跟着变。
 *
 * 最大的坑是「引用失效」：上游一改，后面那步“给某条棱边倒 R2”里的那条边
 * 可能已经不在原位了。这里一律用**几何特征**重新定位（面的中心+法向、边的中点坐标），
 * 而不是当时记录下来的哈希值 —— 哈希每做一次布尔就全变，坐标不会。
 * 找不到就抛 RefLost，调用方据此提示用户，绝不硬套到错误的面上去。
 */
import * as THREE from "three";
import { makePlaneFromFace, makeFace, makeVertex, DistanceQuery } from "replicad";
import * as OPS from "./ops.js";
import * as F from "./features.js";
import * as PRIM from "./primitives.js";
import { resolveFaceSelector, resolveEdgesSelector } from "./selectors.js";
import { applyPatternOp } from "./pattern.js";
import { SketchSession } from "./sketch.js";
import { lookupOp } from "./op-registry.js";
import { canReuseSnapshot } from "./history-cache.js";
import "./ops-register.js";   // 功能模块在这里登记 op（三条并行线各占一个文件）
import { solveSketch } from "./solver.js";

export class RefLost extends Error {
  constructor(msg) {
    super(msg);
    this.name = "RefLost";
  }
}

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * 按几何反查面。
 *
 * 关键：位置容差要**沿法向和垂直于法向分开算**。
 * 垂直于法向的距离（面在平面内的位置）必须严格 —— 它决定了"是不是同一个面"；
 * 沿法向的距离（面的高低）要宽松 —— 上游改尺寸时它本来就会变，
 * 卡死了就会"链接的目标面找不到了"，而那恰恰是关联最该扛住的变化。
 *
 * 实测教训：只按坐标距离统一卡 4mm 时，把关联目标的台子从 18 改到 24（差 6）
 * 就直接报失效；分开算之后高度变化不再影响匹配。
 */
export function remapFace(shape, ref, perpTol = 2.5, alongTol = 60) {
  if (!ref || !shape) return null;
  const n = ref.normal;
  let best = null, bestScore = -Infinity;
  for (const f of shape.faces) {
    try {
      const c = f.center;
      const fn = OPS.normalOf(f);
      const nd = fn[0] * n[0] + fn[1] * n[1] + fn[2] * n[2];
      if (nd < 0.98) continue;                       // 法向不一致，肯定不是同一个面
      const d = [c.x - ref.center[0], c.y - ref.center[1], c.z - ref.center[2]];
      const along = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
      const perp = Math.hypot(d[0] - along * n[0], d[1] - along * n[1], d[2] - along * n[2]);
      if (perp > perpTol) continue;                  // 平面内位置不对
      if (Math.abs(along) > alongTol) continue;      // 高度差得离谱，也不会是它
      const score = nd * 0.6 + (1 - perp / perpTol) * 0.35 + (1 / (1 + Math.abs(along))) * 0.05;
      if (score > bestScore) { bestScore = score; best = f.hashCode; }
    } catch (_) {}
  }
  return best;
}

/** 点的归一化坐标（相对包围盒中心与尺寸）—— 零件被推拉变高/变宽后仍然稳定 */
function normPoint(p, bb) {
  const w = bb.width || 1, h = bb.height || 1, d = bb.depth || 1;
  return [
    (p[0] - bb.center[0]) / w + 0.5,
    (p[1] - bb.center[1]) / h + 0.5,
    (p[2] - bb.center[2]) / d + 0.5,
  ];
}

/**
 * 记录一组边的「引用」。
 * 关键：不仅要记中点坐标，还要记**方向**和**归一化位置**。
 * 因为上游一改尺寸，中点坐标就跑了（推拉把板从 13 高变成 20 高，
 * 竖边中点从 z=6.5 跑到 z=10），但「它仍然是那条竖直的角落边」没有变。
 */
export function makeEdgeRefs(shape, mids) {
  const bb = shape.boundingBox;
  const out = [];
  for (const mid of mids) {
    let best = null, bd = Infinity;
    for (const e of shape.edges) {
      const m = OPS.edgeMidPoint(e);
      if (!m) continue;
      const d = dist3(m, mid);
      if (d < bd) { bd = d; best = e; }
    }
    const straight = best ? OPS.edgeIsStraight(best) : false;
    out.push({
      mid: mid.slice(),
      norm: normPoint(mid, bb),
      dir: straight ? OPS.edgeTangentAt(best, 0.5) : null,   // 直线边才有恒定方向
    });
  }
  return out;
}

/** 按「方向 + 归一化位置」反查一条边；方向是硬约束，归一化位置负责在同类边里区分 */
export function remapEdge(shape, ref) {
  if (!shape || !ref || !Array.isArray(ref.norm) || !Array.isArray(ref.mid)) return null;
  const bb = shape.boundingBox;
  let best = null, bestScore = -Infinity;
  for (const e of shape.edges) {
    const m = OPS.edgeMidPoint(e);
    if (!m) continue;
    let score = 0;
    // 1) 直线边：方向必须一致（最硬的约束，能挡掉绝大多数误配）
    if (ref.dir) {
      if (!OPS.edgeIsStraight(e)) continue;
      const t = OPS.edgeTangentAt(e, 0.5);
      if (!t) continue;
      const dot = Math.abs(t[0] * ref.dir[0] + t[1] * ref.dir[1] + t[2] * ref.dir[2]);
      if (dot < 0.99) continue;
      score += dot * 0.45;
    }
    // 2) 归一化位置（对零件的整体伸缩不敏感）
    const n = normPoint(m, bb);
    const dn = Math.hypot(n[0] - ref.norm[0], n[1] - ref.norm[1], n[2] - ref.norm[2]);
    if (dn > 0.2) continue;
    score += (1 - dn / 0.2) * 0.4;
    // 3) 绝对距离（兜底，权重最小）
    score += (1 / (1 + dist3(m, ref.mid) * 0.05)) * 0.15;
    if (score > bestScore) { bestScore = score; best = { edge: e, mid: m }; }
  }
  return best;
}

/** 按「方向 + 归一化位置」反查一组边 */
export function remapEdges(shape, refs) {
  const out = [];
  const used = new Set();
  for (const r of refs) {
    const hit = remapEdge(shape, r);
    if (hit && !used.has(hit.edge.hashCode)) {
      out.push(hit);
      used.add(hit.edge.hashCode);
    }
  }
  return out;
}

/** 所有草图特征共用同一套约束恢复，保证保存后重建与编辑时一致。 */
function restoreSketch(shape, op) {
  const pl = resolvePlane(shape, op.plane);
  const sk = new SketchSession(shape, null, { ...pl, name: op.plane.label || "草图" });
  sk.entities = structuredClone(op.entities);
  sk.selected = Array.isArray(op.selected) ? [...op.selected] : [];
  sk.constraints = structuredClone(op.constraints === undefined ? [] : op.constraints);
  // 从动标注：恢复的是「测什么」的定义，值在绘制时现算（几何变了自动跟着变）
  sk.dimNotes = structuredClone(op.dimNotes === undefined ? [] : op.dimNotes);
  const r = solveSketch(sk.entities, sk.constraints);
  if (!r.ok) {
    const error = new RefLost(r.invalidConstraints.length
      ? `草图约束定义无效：${r.conflicts.join("；")}`
      : `草图尺寸约束在上游改动后无法满足（冲突：${r.conflicts.join("、") || "约束过多"}）`);
    error.invalidConstraints = r.invalidConstraints;
    throw error;
  }
  return sk;
}

/**
 * 大范围加料/挖料可能让同一承载面的质心超出 remapFace 的面内容差。
 * 仅在通常匹配失败时，以原引用点投影到平面后的真实外轮廓作补充验证。
 * 忽略内孔：原面质心本来就可能落在孔内。多个平行承载候选必须明确失败。
 */
function recoverSketchSupport(shape, ref) {
  if (!shape || !ref) return null;
  const anchor = v3(ref.center);
  const savedNormal = v3(ref.normal).normalize();
  const matches = [];
  for (const face of shape.faces) {
    let outline, filled, point, query;
    try {
      if (face.geomType !== "PLANE") continue;
      const normal = v3(OPS.normalOf(face)).normalize();
      if (normal.dot(savedNormal) < 0.99999) continue;
      const c = face.center;
      const distance = new THREE.Vector3(c.x, c.y, c.z).sub(anchor).dot(normal);
      if (Math.abs(distance) > 60) continue;
      const projected = anchor.clone().addScaledVector(normal, distance);
      const bounds = face.boundingBox.bounds;
      if (projected.toArray().some((value, axis) => value < bounds[0][axis] - 1e-5 || value > bounds[1][axis] + 1e-5)) continue;
      outline = face.clone().outerWire(); // outerWire consumes its face wrapper
      filled = makeFace(outline);
      point = makeVertex(projected.toArray());
      query = new DistanceQuery(filled);
      if (query.distanceTo(point) <= 1e-5) matches.push(face.hashCode);
    } catch (_) {
      // An unverifiable face is not a valid recovery candidate.
    } finally {
      query?.delete();
      point?.delete();
      filled?.delete();
      outline?.delete();
    }
  }
  if (matches.length > 1) throw new RefLost("草图承载面存在多个平行候选，无法唯一恢复引用");
  return matches[0] ?? null;
}

/** 依据 op.plane 描述取出 OCCT 平面 + 三轴（实体面会被重新定位） */
export function resolvePlane(shape, p) {
  if (p.kind === "datum") {
    return {
      occtPlane: OPS.occtPlaneByName(p.name),
      origin: v3(p.origin),
      normal: v3(p.normal),
      xDir: v3(p.xDir),
    };
  }
  const fid = remapFace(shape, p.faceRef) ?? recoverSketchSupport(shape, p.faceRef);
  if (fid == null) throw new RefLost("找不到当初画草图的那个面（零件已经变形到别处了）");
  const face = OPS.findFace(shape, fid);
  // 面积变化会移动质心，但不能因此平移草图。保存的原点只沿法向跟随承载平面。
  // 早期定义若没有单独的 origin，faceRef.center 就是当时采用的草图原点。
  const c = face.center;
  const normal = v3(OPS.normalOf(face)).normalize();
  const origin = v3(p.origin ?? p.faceRef.center);
  origin.addScaledVector(normal, new THREE.Vector3(c.x, c.y, c.z).sub(origin).dot(normal));
  return {
    occtPlane: makePlaneFromFace(face),
    origin,
    normal,
    xDir: v3(p.xDir),
    faceId: fid,
    faceRef: structuredClone(p.faceRef),
  };
}

/** 重放单步。shape 传 null 时可从基准面创建首个实体。 */
export function replayOp(shape, op, ctx = {}) {
  switch (op.type) {
    case "base":
      return OPS.starterModel(op);

    case "pushpull":
    case "pushface": {
      /*
       * 两种定位方式：
       *   faceRef —— 交互点选时记下的面快照（点选路径）
       *   selector —— 脚本里的「几何意图」（{at, normal, type}），每次重放按几何重解
       */
      const fid = op.selector ? resolveFaceSelector(shape, op.selector) : remapFace(shape, op.faceRef);
      if (fid == null) {
        throw new RefLost(
          `找不到要推拉的那个面（原地位置 ${(op.faceRef?.center || []).map((v) => v.toFixed(1)).join(", ")} 附近没有法向一致的面）`
        );
      }
      let dist = op.dist;
      // 持久关联：这一步的深度不是常数，而是「对齐到某个面」。
      // 上游一改，目标面位置变了，这里重新求值 —— 这才叫关联，
      // 否则只是一次性的位移。
      if (op.alignTo) {
        const tid = remapFace(shape, op.alignTo.faceRef);
        if (tid == null) {
          throw new RefLost(
            `链接的目标面找不到了（原来在 ${op.alignTo.faceRef.center.map((v) => v.toFixed(1)).join(", ")} 附近）`
          );
        }
        const A = OPS.faceInfo(shape, fid);
        const T = OPS.faceInfo(shape, tid);
        const n = A.normal;
        dist = (T.center[0] - A.center[0]) * n[0]
             + (T.center[1] - A.center[1]) * n[1]
             + (T.center[2] - A.center[2]) * n[2];
        if (typeof globalThis !== "undefined" && globalThis.__alignLog) {
          globalThis.__alignLog.push({
            want: op.alignTo.faceRef.center.map((v) => +v.toFixed(2)),
            got: T.center.map((v) => +v.toFixed(2)),
            src: A.center.map((v) => +v.toFixed(2)),
            dist: +dist.toFixed(3),
          });
        }
      }
      return OPS.pushPullFace(shape, fid, dist);
    }

    case "extrude": {
      const sk = restoreSketch(shape, op);
      if (!shape && op.depth <= 0) throw new RefLost("挖料需要一个已有的实体");
      const solid = sk.buildSolid(op.depth, op.grow ?? 0.002);
      ctx.tool = solid;                       // 供阵列/镜像复用
      return !shape ? solid : op.depth > 0 ? shape.fuse(solid) : shape.cut(solid);
    }

    case "revolve": {
      const sk = restoreSketch(shape, op);
      let tool = null;
      try {
        tool = sk.revolveSolid(op.angle, op.axisX);
      } catch (e) {
        throw new RefLost("旋转体在上游改动后重放失败：" + (e?.message || e));
      }
      ctx.tool = tool;
      return shape ? shape.fuse(tool) : tool;
    }

    case "sweep": {
      const sk = restoreSketch(shape, op);
      const ds = sk.toDrawings();
      if (ds.length < 2) throw new RefLost("扫掠需要两个轮廓（截面 + 路径）");
      // 与 applySweep 一致：第二轮廓描述长度，路径沿草图法向。
      const ent = sk.activeEntities[1];
      let length = op.length;
      if (length == null) {
        length = ent?.kind === "rect" ? Math.max(ent.w, ent.h)
          : ent?.kind === "circle" ? ent.r * 2
          : ent?.kind === "polyline" && ent.pts.length >= 2
            ? Math.hypot(ent.pts.at(-1)[0] - ent.pts[0][0], ent.pts.at(-1)[1] - ent.pts[0][1]) : 20;
      }
      let tool = null;
      try { tool = F.sweepNormal(ds[0], length, sk.origin.toArray(), sk.normal.toArray()); }
      catch (e) { throw new RefLost("扫掠在上游改动后重放失败：" + (e?.message || e)); }
      ctx.tool = tool;
      return shape ? shape.fuse(tool) : tool;
    }

    case "loft": {
      const sk = restoreSketch(shape, op);
      const wires = sk.toDrawings().map((d) => d.wire).filter(Boolean);
      if (wires.length < 2) throw new RefLost("放样至少要两个截面");
      let tool = null;
      try { tool = F.loftWires(wires); }
      catch (e) { throw new RefLost("放样在上游改动后重放失败：" + (e?.message || e)); }
      ctx.tool = tool;
      return shape ? shape.fuse(tool) : tool;
    }

    case "primitive": {
      /*
       * 基础形体（box / cylinder / sphere / cone / torus）。
       * 来源：对照 Yi3D 的 Primitives 清单补齐 —— 这边原来只能推拉 + 草图，
       * 球/锥/环/螺旋在脚本里必须能一句话造出来。
       * mode: "cut" 做差集（默认 "add" 做并集）。
       */
      const tool = PRIM.primitiveSolid(op);
      ctx.tool = tool;
      if (!shape) return tool;
      const base = shape.clone ? shape.clone() : shape;
      return op.mode === "cut" ? base.cut(tool) : base.fuse(tool);
    }

    case "helix": {
      /* 螺旋（弹簧）：圆截面沿螺旋线扫掠。R/wireR/pitch/turns → 实体 */
      const tool = PRIM.helixSolid(op);
      ctx.tool = tool;
      if (!shape) return tool;
      const base = shape.clone ? shape.clone() : shape;
      return op.mode === "cut" ? base.cut(tool) : base.fuse(tool);
    }

    case "pattern":
    case "mirror": {
      const src = ctx.tools ? ctx.tools[op.source] : null;
      if (!src) throw new RefLost("阵列或镜像找不到它的源特征（特征可能已被压制或删除）");
      try {
        const result = applyPatternOp(shape, src, op);
        ctx.tool = result.tool;
        return result.shape;
      } catch (e) { throw new RefLost("阵列或镜像重放失败：" + (e?.message || e)); }
    }

    case "move3d": {
      // 整体移动/旋转 —— 不改几何形状，只改位置
      if (!shape) throw new RefLost("移动需要一个已有的实体（第一步不能是移动）");
      const rot = Number(op.rot) || 0;
      const dx = Number(op.dx) || 0, dy = Number(op.dy) || 0, dz = Number(op.dz) || 0;
      let s2 = shape.clone();
      if (rot) {
        let pivot = [0, 0, 0];
        if (op.pivot === "center") {
          try { const c = s2.boundingBox.center; pivot = [c[0], c[1], c[2]]; } catch (_) {}
        }
        const ax = op.axis === "X" ? [1, 0, 0] : op.axis === "Y" ? [0, 1, 0] : [0, 0, 1];
        s2 = s2.rotate(rot, pivot, ax);
      }
      if (dx || dy || dz) s2 = s2.translate(dx, dy, dz);
      return s2;
    }

    case "fillet":
    case "chamfer": {
      // selector（脚本）与 edgeRefs（点选）二选一；脚本走几何重解，选边同样只认唯一命中
      if (op.selector && !(op.edgeRefs || []).length) {
        const mids = resolveEdgesSelector(shape, op.selector);
        const r = op.type === "fillet"
          ? OPS.filletEdges(shape, mids, op.radius)
          : OPS.chamferEdges(shape, mids, op.radius);
        if (r.failed || r.ok !== mids.length) {
          throw new RefLost(`${op.type === "fillet" ? "圆角" : "倒角"}未能完整重建（成功 ${r.ok}/${mids.length} 条），请减小尺寸或改变选择条件`);
        }
        return r.shape;
      }
      const refs = op.edgeRefs || [];
      const found = remapEdges(shape, refs);
      if (!refs.length || found.length !== refs.length) {
        throw new RefLost(`找不到全部要倒角的棱边（仅定位到 ${found.length}/${refs.length} 条），请重新选择`);
      }
      const mids = found.map((f) => f.mid);
      const r = op.type === "fillet"
        ? OPS.filletEdges(shape, mids, op.radius)
        : OPS.chamferEdges(shape, mids, op.radius);
      if (r.failed || r.ok !== refs.length) {
        throw new RefLost(`倒角未能完整重建（成功 ${r.ok}/${refs.length} 条），请减小尺寸或重新选边`);
      }
      return r.shape;
    }

    case "import": {
      // 导入体：实体挂在运行时缓存（STEP 不能进 JSON），重开工程需重新导入
      return OPS.importedShape(op.id).clone();
    }

    case "hole": {
      // 孔向导：存的是「面上一点 + 朝外法向」，不存面引用，上游改动只要坐标还在就能重建
      return OPS.holeAt(shape, op);
    }

    case "shell": {
      const fid = op.selector ? resolveFaceSelector(shape, op.selector) : remapFace(shape, op.faceRef);
      if (fid == null) throw new RefLost("找不到要开口的那个面");
      return OPS.shellByFace(shape, fid, op.thickness);
    }

    default: {
      // 未在 switch 里内置的类型，交给注册表（C/D 批的特征模块）
      const extra = lookupOp(op.type);
      if (extra) return extra(shape, op, ctx);
      throw new Error("未知的操作类型：" + op.type);
    }
  }
}

/** 会产出「增量体」（toolShape）的特征类型 —— 阵列/镜像要拿它当源 */
const TOOL_GENERATORS = new Set(["extrude", "revolve", "sweep", "loft", "pattern", "mirror"]);
export const generatesTool = (op) => TOOL_GENERATORS.has(op?.type);

/**
 * 实体还活着吗？
 * replicad 的 delete() 把 _wrapped 置空，之后任何访问都会抛 "This object has been deleted"。
 * 这里只读一次 wrapped（getter，无 wasm 调用）：被删过的历史快照不能拿来当复用起点，
 * 否则续算出来的东西是坏的。命中就退回更早的起点/全量重放 —— 宁可慢，不能错。
 */
function aliveShape(shape) {
  if (!shape) return false;
  try { return !!shape.wrapped; } catch (_) { return false; }
}

/**
 * 这次重放至少要从第几步开始（复用点之前的实体）。
 *
 * 判定与 preview-rebuild 完全一致：
 *   ① 该步被 overrides 覆盖了 → 从它开始；
 *   ② 该步的快照跟当前定义对不上（op/suppressed 改过、shape 换过、从没记过）→ 从它开始；
 *   ③ 生成型特征没有 toolShape（下游阵列会拿不到源）→ 从它开始；
 *   ④ 该步的实体已经不可用 → 从它开始。
 * 全都命中「可复用」时只需重算最后一步（改最后一步参数是最常见的操作）。
 */
export function replayStart(hist, target, overrides = {}) {
  for (let i = 0; i <= target; i++) {
    const row = hist[i];
    if (overrides[i] !== undefined) return i;
    if (!row || !canReuseSnapshot(row) || !aliveShape(row.shape)) return i;
    if (!row.suppressed && generatesTool(row.op) && !row.toolShape) return i;
  }
  return target;      // 全量可用：只重算目标这一步
}

/**
 * 从头重放到第 target 步（含）。
 * @param hist      历史数组，每项需有 op 字段
 * @param target    目标步索引
 * @param overrides { stepIndex: newOp } 覆盖某一步的定义
 * @param opts      { full: true } 强制全量重放（对拍/调试用）
 * @returns {shape, steps, totalSteps, fromStep, logs, snapshots, tools}
 */
export function rebuild(hist, target, overrides = {}, opts = {}) {
  if (!hist.length) throw new Error("历史是空的");
  if (!Number.isInteger(target) || target < 0 || target >= hist.length) {
    throw new Error("重放目标不在历史范围内");
  }
  const start = opts.full ? 0 : replayStart(hist, target, overrides);
  const logs = [];             // 只记这次真正算过的步（复用段不再重复记账）
  const snapshots = [];        // 每一步的中间结果，调用方要拿它回填历史
  const tools = [];            // 每一步产出的「增量体」（生成型特征才有），阵列/镜像要用
  let shape = null;

  /*
   * 复用段：找到「最早被改动的那一步」，把它之前的实体当作起点续算。
   *
   * 为什么必须 clone：replicad 的 fuse/cut 会消费掉操作数（实体的 wrapped 被 delete），
   * 直接拿 history[start-1].shape 去 fuse，历史里那一步的实体当场就废了，
   * 于是「撤销回到第 N 步」会拿到一个已删除的 shape。clone 一份给这次重放用。
   *
   * 快照/工具对于复用段**返回原对象**（不是新建的空壳），因为 project.cacheRebuild
   * 要拿它回填 history —— 语义必须与全量重放完全一致。
   */
  if (start > 0) {
    let resumed = null;
    try { resumed = hist[start - 1].shape?.clone?.() || null; } catch (_) { resumed = null; }
    if (!resumed) {
      // 前缀的实体不知为何不可用（被别的路径删过 / 只存了定义）→ 老实从第一步全量重放
      return rebuild(hist, target, overrides, { ...opts, full: true });
    }
    shape = resumed;
    for (let i = 0; i < start; i++) {
      tools[i] = hist[i]?.suppressed ? null : (hist[i]?.toolShape || null);
      snapshots.push({ index: i, shape: hist[i]?.shape ?? null });
    }
  }

  for (let i = start; i <= target; i++) {
    /*
     * 被「压制」的步骤直接跳过（SolidWorks 的 Suppress）。
     * 它跟「删除」的区别：定义还留着、随时能解压回来，只是这次不参与计算。
     * tools[i] 留成 null，依赖它的阵列/镜像会照常报错，不会静默画错。
     */
    if (hist[i]?.suppressed) {
      tools[i] = null;
      snapshots.push({ index: i, shape });
      logs.push({ step: i, label: hist[i]?.label, ms: 0 });
      continue;
    }
    const op = overrides[i] || hist[i]?.op;
    if (!op) {
      throw new Error(`第 ${i + 1} 步没有可重放的定义（这条历史是在支持重放之前记下的，改不了）`);
    }
    const t0 = performance.now();
    const ctx = { tools, index: i, tool: null };
    try {
      shape = replayOp(shape, op, ctx);
    } catch (e) {
      e.stepIndex = i;
      e.stepLabel = hist[i]?.label || `第 ${i + 1} 步`;
      throw e;
    }
    tools[i] = ctx.tool || null;
    const ms = performance.now() - t0;
    logs.push({ step: i, label: hist[i]?.label, ms });
    snapshots.push({ index: i, shape });
  }
  return {
    shape,
    steps: target + 1 - start,   // 这次真正重放的步数（全量重放时等于 target+1，与旧行为一致）
    totalSteps: target + 1,
    fromStep: start,
    logs,
    snapshots,
    tools,
  };
}

/** 把当前实体状态导出成一步的「定义」（给 commit 用） */
export function makeOp(type, params) {
  return { type, ...params };
}

