/**
 * PadCAD 主程序
 * 触摸优先的直接建模器：点面 → 拖 → 实体真实重建（不是网格变形）
 */
import * as THREE from "three";
import { initKernel, meshOf, api } from "./kernel.js";
import { Viewer } from "./viewer.js";
import { SketchSession } from "./sketch.js";
import { DimHandle } from "./handle.js";
import { Datum } from "./datum.js";
import { rebuild, RefLost, makeEdgeRefs, resolvePlane, remapFace } from "./replay.js";
import { SnapEngine, candidatesOf, computeTracking, SNAP_KINDS } from "./snap.js";
import { parseMesh } from "./importers.js";
import { readStepBlob, safeVolume } from "./step-io.js";
import { solveSketch } from "./solver.js";
import * as ELEM from "./elements.js";
import * as F from "./features.js";
import * as OPS from "./ops.js";
import { projectDefinition, restoreProject, cacheRebuild, withoutFeature, escapeHTML } from "./project.js";
import { normalizePatternOp, applyPatternOp } from "./pattern.js";
import { createPatternPanel } from "./pattern-panel.js";
import { installViewControls } from "./view-controls.js";
import { installWorkspaceUI } from "./workspace-ui.js";
import { installPenCursor } from "./pen-cursor.js";
import { findSurfaceDrivers, readCylinderFace } from "./surface-drivers.js";
import { rebuildPreview } from "./preview-rebuild.js";
import { markSnapshot } from "./history-cache.js";
import { runModelScript, normalizeScript, summarize, scriptFromHistory } from "./model-script.js";
// 本轮 UI 接线用到的内核能力（都已在各自模块里实现并回归过，这里只做界面侧）
import { massProperties } from "./inspect.js";
import { stlBinary, objText, threeMF } from "./exporters.js";
import { addPolygon, addSlot, addArc, addEllipse, trimSegment } from "./sketch-tools.js";
import { lookupOp } from "./op-registry.js";
import "./workspace-ui.css";
import "./theme.css";   // Clay 主题：只改 token 与组件外观，必须在 workspace-ui.css 之后

import "./script-panel.css";

const $ = (id) => document.getElementById(id);
const canvas = $("view");
const viewer = new Viewer(canvas);
let workspaceUI = null;
// 「选中面」小卡锚在哪个世界坐标上（相机转动/手势结束后按它重新投影定位）
let pickerAnchor = null;

let shape = null;
let mode = "select";          // select | pushpull | sketch
let selectedFaceId = null;
let selSnap = null;           // {normal, center} —— 重建后追踪「同一个」面
let drag = null;              // 推拉拖动
let busy = false;

// 草图状态
let sketch = null;            // SketchSession
let sketchTool = "rect";      // rect | circle
let drawing = null;           // {start, cur} 正在画的轮廓
const viewControls = installViewControls({ viewer, isSketchMode: () => mode === "sketch", onMessage: setStats });

// 圆角/倒角/抽壳状态
let edgeSel = [];             // 已选中的边（edgePointSets 条目）
let edgeKind = "fillet";      // fillet | chamfer

// 尺寸手柄（看得见 / 拖得动 / 点得改）
let dim = null;
let dimBase = null;           // 拖动开始时的实体：所有预览都基于它重算，避免误差累积
let dimRaf = 0;
let dimTarget = null;         // 拖动中的目标值
let curvedPreviewResult = null;
let awaitingExtrude = false;  // 草图已画完，正在等拉伸尺寸
let datum = null;             // 世界坐标系 + XYZ 基准面

// ---------------------------------------------------------------- 对象捕捉
const snap = new SnapEngine();
const SNAP_COLOR = "#ad650b";
let snapGuides = [];          // 当前生效的追踪引导线

/** 平面 2D 坐标 → 屏幕 client 坐标（捕捉判定要用） */
function sketchToScreen(p2d) {
  if (!sketch || !canvas) return null;
  const v = sketch.to3D(p2d[0], p2d[1]).project(viewer.camera);
  const r = canvas.getBoundingClientRect();
  return [r.left + (v.x * 0.5 + 0.5) * r.width, r.top + (-v.y * 0.5 + 0.5) * r.height];
}

/** 世界原点在草图坐标系里的位置（供原点捕捉） */
function sketchOrigin2D() {
  if (!sketch) return null;
  try { const o = sketch.to2D(new THREE.Vector3(0, 0, 0)); return [o.x, o.y]; } catch (_) { return null; }
}

/** 追踪锚点：所有已有端点 */
function snapAnchors() {
  if (!sketch) return [];
  const out = [];
  for (const e of sketch.entities) {
    for (const c of candidatesOf(e)) if (c.kind === "endpoint") out.push(c);
  }
  if (sketch.draft) {
    for (const c of candidatesOf(sketch.draft)) if (c.kind === "endpoint") out.push(c);
  }
  return out;
}

/**
 * 把手指位置吸附到精确的特征点上。
 * 返回 {x, y, snapped}；没命中就返回原始坐标（snapped=false）。
 * 关键是：命中时返回的是**特征点的精确坐标**，不是屏幕反算值。
 */
function updateSnap(clientX, clientY) {
  if (!sketch || mode !== "sketch") { snap.clear(); snapGuides = []; drawSnapOverlay(); return null; }
  const raw = sketch.screenTo2D(clientX, clientY, viewer.camera, canvas);
  if (!raw) { snap.clear(); snapGuides = []; drawSnapOverlay(); return null; }

  const sources = [{ entities: sketch.entities, origin: sketchOrigin2D() }];
  if (sketch.draft) sources.push({ entities: [sketch.draft], origin: null });

  snap.update([clientX, clientY], sketchToScreen, sources);
  snapGuides = snap.best ? [] : computeTracking([raw.x, raw.y], snapAnchors(), sketchToScreen);
  drawSnapOverlay();

  const p = snap.apply([raw.x, raw.y]);
  return { x: p[0], y: p[1], snapped: !!snap.best, kind: snap.best?.kind };
}

/**
 * 画一条线性尺寸（尺寸线 + 延伸线 + 箭头 + 数值）。
 * 参照 SolidWorks：尺寸线画在两个点的外侧，箭头指回被测的那条边。
 */
function drawLinearDim(ctx, a, b, text, offsetPx) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L, ny = dx / L;              // 垂直方向
  const ax = a[0] + nx * offsetPx, ay = a[1] + ny * offsetPx;
  const bx = b[0] + nx * offsetPx, by = b[1] + ny * offsetPx;

  ctx.save();
  ctx.strokeStyle = "rgba(255,179,64,.95)";
  ctx.fillStyle = "rgba(255,179,64,.95)";
  ctx.lineWidth = 1.4;

  // 尺寸线
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  // 两条延伸线（从被测点伸到尺寸线外一点）
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]); ctx.lineTo(ax + nx * 5, ay + ny * 5);
  ctx.moveTo(b[0], b[1]); ctx.lineTo(bx + nx * 5, by + ny * 5);
  ctx.stroke();
  ctx.setLineDash([]);

  // 箭头（指回 a、b 两点）
  const arrow = (px, py, tx, ty) => {
    const vx = tx - px, vy = ty - py, vl = Math.hypot(vx, vy) || 1;
    const ux = vx / vl, uy = vy / vl, s = 7, w = 3;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + ux * s + nx * w, py + uy * s + ny * w);
    ctx.lineTo(px + ux * s - nx * w, py + uy * s - ny * w);
    ctx.closePath(); ctx.fill();
  };
  arrow(ax, ay, bx, by);
  arrow(bx, by, ax, ay);

  // 数值（带背景，免得压在线上看不清）
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  const label = text;
  ctx.font = "600 12px system-ui, sans-serif";
  const tw = ctx.measureText(label).width;
  const off = 11 + (dy === 0 ? 4 : -4);
  ctx.fillStyle = "rgba(12,14,18,.88)";
  ctx.fillRect(mx - tw / 2 - 4, my - off - 8, tw + 8, 15);
  ctx.fillStyle = "#ffb340";
  ctx.textAlign = "center";
  ctx.fillText(label, mx, my - off + 2);
  ctx.textAlign = "left";
  ctx.restore();
}

/** 把已标注的尺寸画到画布上（智能尺寸的可视化部分） */
function drawDimAnnotations(ctx, r) {
  if (!sketch) return;
  const toS = (p) => { const s = sketchToScreen(p); return s ? [s[0] - r.left, s[1] - r.top] : null; };

  // 两点距离的尺寸线（点两个特征点标的那些）
  for (const c of sketch.constraints) {
    if (c.type !== "distance") continue;
    const pa = resolveRef(c.a), pb = resolveRef(c.b);
    if (!pa || !pb) continue;
    const sa = toS(pa), sb = toS(pb);
    if (!sa || !sb) continue;
    drawLinearDim(ctx, sa, sb, `${(+c.value).toFixed(2)}`, 26);
  }

  /*
   * 线距（点到另一条线的距离）：尺寸线必须**垂直于被量的那条线**。
   *
   * ⚠ 之前这种情形走的是上面那个 "distance" 分支，把**两条线的起点**直接连起来，
   * 于是屏幕上出现两条斜着的界线、尺寸也是歪的（用户实测报的
   *「引用了模型上下边标线距，多了两条斜线、尺寸是歪的」）。
   * 现在按定义取垂足：从测量点向被量的线作垂线，尺寸就标在这条垂线上。
   */
  // 只读的参考尺寸（从动）——两边都是引用，加了约束也没东西会动
  for (const nd of (sketch.dimNotes || [])) {
    /*
     * 从动标注存的是"测什么"，这里**现算值** —— 几何一变，显示的值自动跟着变。
     * `nd.display` / `nd.value` 只是兼容早期存快照的旧记录。
     */
    const ev = nd.measure ? ELEM.evalMeasure(sketch, nd.measure) : null;
    const dp = (ev && ev.display) || nd.display || {};
    const val = ev ? ev.value : nd.value;
    if (!isFinite(val)) continue;
    if (dp.mode === "perpendicular" && dp.from && dp.lineA && dp.lineB) {
      const dx = dp.lineB[0] - dp.lineA[0], dy = dp.lineB[1] - dp.lineA[1];
      const L2 = dx * dx + dy * dy;
      if (L2 > 1e-12) {
        const tt = ((dp.from[0] - dp.lineA[0]) * dx + (dp.from[1] - dp.lineA[1]) * dy) / L2;
        const foot = [dp.lineA[0] + tt * dx, dp.lineA[1] + tt * dy];
        const sp = toS(dp.from), sf = toS(foot);
        if (sp && sf) {
          ctx.save();
          ctx.globalAlpha = 0.75;      // 参考尺寸画得淡一点，和可驱动的区分开
          drawLinearDim(ctx, sp, sf, `(${(+val).toFixed(2)})`, 20);   // 括号 = 从动尺寸
          ctx.restore();
        }
      }
    } else if (dp.mode === "linear" && dp.a && dp.b) {
      const sa = toS(dp.a), sb = toS(dp.b);
      if (sa && sb) {
        ctx.save();
        ctx.globalAlpha = 0.75;
        drawLinearDim(ctx, sa, sb, `(${(+val).toFixed(2)})`, 26);
        ctx.restore();
      }
    } else if (dp.mode === "angle" && dp.v && dp.dir1 && dp.dir2) {
      const sv = toS(dp.v);
      if (sv) {
        ctx.save();
        ctx.globalAlpha = 0.75;
        ctx.strokeStyle = "rgba(255,179,64,.8)";
        ctx.lineWidth = 1.2;
        const r0 = 34, a1 = Math.atan2(dp.dir1[1], dp.dir1[0]), a2 = Math.atan2(dp.dir2[1], dp.dir2[0]);
        // 屏幕 y 轴朝下，角度要取反
        ctx.beginPath();
        ctx.arc(sv[0], sv[1], r0, -a1, -a2, a2 > a1);
        ctx.stroke();
        const mid = (a1 + a2) / 2;
        ctx.fillStyle = "#ffb340";
        ctx.font = "600 12px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(`(${(+val).toFixed(2)}°)`, sv[0] + Math.cos(mid) * (r0 + 20), sv[1] - Math.sin(mid) * (r0 + 20));
        ctx.textAlign = "left";
        ctx.restore();
      }
    }
  }

  /*
   * 「到模型参考」的三种尺寸：distToFixedLine / distToFixedPoint / angleToFixedLine。
   *
   * ⚠ 这三种之前**根本没有渲染** —— 约束明明生效了（圆被限制住、拖动都对），
   * 但屏幕上一条尺寸线都没有，用户只能靠猜（实测反馈"限制住了，但是看不见尺寸标识"）。
   * 原因是它们的数据结构和 distance/pointToLine 不一样：
   * 参考几何是**常量**（存在 spec.line / spec.at / spec.ref 里），
   * 不能走 resolveRef 那条按 {e,p} 查图元的路。
   */
  const cst = sketch.constraints || [];
  for (const c of cst) {
    if (c.type === "distToFixedLine") {
      const p = resolveRef(c.p);
      const A = c.line && c.line[0], B = c.line && c.line[1];
      if (!p || !A || !B) continue;
      const dx = B[0] - A[0], dy = B[1] - A[1];
      const L2 = dx * dx + dy * dy;
      if (L2 < 1e-12) continue;
      const t = ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L2;
      const foot = [A[0] + t * dx, A[1] + t * dy];
      const sp = toS(p), sf = toS(foot);
      if (!sp || !sf) continue;
      drawLinearDim(ctx, sp, sf, `${(+c.value).toFixed(2)}`, 20);
      // 被量的那条参考线也淡淡描一下，让人看清量的是哪条
      const sa = toS(A), sb = toS(B);
      if (sa && sb) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = "rgba(255,179,64,.35)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(sa[0], sa[1]); ctx.lineTo(sb[0], sb[1]); ctx.stroke();
        ctx.restore();
      }
    } else if (c.type === "distToFixedPoint") {
      const p = resolveRef(c.p);
      const at = c.at;
      if (!p || !Array.isArray(at)) continue;
      const sa = toS(p), sb = toS(at);
      if (!sa || !sb) continue;
      drawLinearDim(ctx, sa, sb, `${(+c.value).toFixed(2)}`, 26);
    } else if (c.type === "angleToFixedLine") {
      // 草图那条线取几何（geometryOf 会给端点 + 单位方向），参考线是常量
      const g = ELEM.geometryOf(sketch, c.l);
      const R2 = c.ref;
      if (!g || g.kind !== "line" || !Array.isArray(R2)) continue;
      const sv = toS(g.a);
      if (!sv) continue;
      const d1 = g.dir;
      if (!d1) continue;
      const d2 = [R2[1][0] - R2[0][0], R2[1][1] - R2[0][1]];
      const a1 = Math.atan2(d1[1], d1[0]), a2 = Math.atan2(d2[1], d2[0]);
      ctx.save();
      ctx.strokeStyle = "rgba(255,179,64,.9)";
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(sv[0], sv[1], 30, -a1, -a2, a2 > a1);
      ctx.stroke();
      const mid = (a1 + a2) / 2;
      ctx.fillStyle = "#ffb340";
      ctx.font = "600 12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${(+c.value).toFixed(2)}°`, sv[0] + Math.cos(mid) * 48, sv[1] - Math.sin(mid) * 48);
      ctx.textAlign = "left";
      ctx.restore();
    }
  }

  for (const c of cst) {
    if (c.type !== "pointToLine") continue;
    const p = resolveRef(c.p), a = resolveRef(c.l1), b = resolveRef(c.l2);
    if (!p || !a || !b) continue;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-12) continue;
    // 把点投影到那条线上，得到垂足
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
    const foot = [a[0] + t * dx, a[1] + t * dy];
    const sp = toS(p), sf = toS(foot), sa = toS(a), sb = toS(b);
    if (!sp || !sf) continue;
    drawLinearDim(ctx, sp, sf, `${(+c.value).toFixed(2)}`, 20);
    // 顺手把被量的那条线用细虚线延伸一下，让人看出量的是哪条（像 SolidWorks 的界线）
    if (sa && sb) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(255,179,64,.45)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      // 沿线的方向延长一点，超出垂足两侧
      const ux = dx / Math.sqrt(L2), uy = dy / Math.sqrt(L2);
      const ext = 12;
      ctx.moveTo(sa[0] - ux * ext, sa[1] - uy * ext);
      ctx.lineTo(sb[0] + ux * ext, sb[1] + uy * ext);
      ctx.stroke();
      ctx.restore();
    }
  }

  if (!sketch.constraints.length) return;

  sketch.entities.forEach((e, i) => {
    const dims = sketch.constraints.filter((c) => c.type === "fixed" && c.e === i);
    if (!dims.length) return;

    if (e.kind === "rect") {
      for (const d of dims) {
        if (d.k === "w") {
          const bl = toS([e.c[0] - e.w / 2, e.c[1] - e.h / 2]);
          const br = toS([e.c[0] + e.w / 2, e.c[1] - e.h / 2]);
          if (bl && br) drawLinearDim(ctx, bl, br, `${(+d.value).toFixed(1)}`, 34);
        } else if (d.k === "h") {
          const tr = toS([e.c[0] + e.w / 2, e.c[1] + e.h / 2]);
          const br = toS([e.c[0] + e.w / 2, e.c[1] - e.h / 2]);
          if (tr && br) drawLinearDim(ctx, br, tr, `${(+d.value).toFixed(1)}`, -34);
        }
      }
    } else if (e.kind === "circle") {
      for (const d of dims) {
        if (d.k !== "r") continue;
        const c = toS([e.c[0], e.c[1]]);
        const q = toS([e.c[0] + e.r, e.c[1]]);
        if (!c || !q) continue;
        ctx.save();
        ctx.strokeStyle = "rgba(255,179,64,.95)";
        ctx.fillStyle = "rgba(255,179,64,.95)";
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
        ctx.beginPath(); ctx.arc(c[0], c[1], 2.5, 0, Math.PI * 2); ctx.fill();
        const label = `R${(+d.value).toFixed(1)}`;
        ctx.font = "600 12px system-ui, sans-serif";
        const tw = ctx.measureText(label).width;
        const mx = (c[0] + q[0]) / 2, my = (c[1] + q[1]) / 2;
        ctx.fillStyle = "rgba(12,14,18,.88)";
        ctx.fillRect(mx - tw / 2 - 4, my - 18, tw + 8, 15);
        ctx.fillStyle = "#ffb340";
        ctx.textAlign = "center";
        ctx.fillText(label, mx, my - 8);
        ctx.textAlign = "left";
        ctx.restore();
      }
    }
  });
}

/** 画捕捉标记与追踪引导线 */
/**
 * 画图元的特征点（端点/圆心/象限点）。
 * 圆点小、带描边，保证在浅色网格和深色线框上都看得见。
 */
function drawFeaturePoints(ctx, r) {
  if (!sketch) return;
  const pts = [];
  sketch.entities.forEach((e, i) => {
    if (e.ref) return;                       // 引用图元不画（点太多）
    for (const c of candidatesOf(e, i)) {
      if (!c.ref) continue;
      pts.push({ p: c.p, e: i });
    }
  });
  if (!pts.length) return;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(10,14,20,.85)";
  ctx.fillStyle = "#4da3ff";                 // SolidWorks 的蓝点
  for (const it of pts) {
    const s = sketchToScreen(it.p);
    if (!s) continue;
    const x = s[0] - r.left, y = s[1] - r.top;
    if (x < -4 || y < -4 || x > r.width + 4 || y > r.height + 4) continue;
    ctx.beginPath();
    ctx.arc(x, y, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

let _overlaySig = "";        // 上一帧的相机签名（尺寸标注只在相机变了才重画）
let _overlayRedraws = 0;     // 重画次数（调试出口，用来验证节流有效）

function drawSnapOverlay(rect = null) {
  const o = document.getElementById("snapOverlay");
  if (!o || !canvas) return;
  // 帧内复用 viewer 测好的矩形；不传时才现测（帧外调用）。
  const r = rect || canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
  if (o.width !== W || o.height !== H) { o.width = W; o.height = H; o.style.width = r.width + "px"; o.style.height = r.height + "px"; }
  o.style.left = r.left + "px";
  o.style.top = r.top + "px";
  const ctx = o.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  /*
   * 判「在不在草图里」要看 sketch 会话，不能看 mode：
   * 草图内切换工具（选择/直线/…）不会、也不该影响覆盖层是否存在；用 mode 判会漏画。
   */
  if (!sketch) return;

  // 尺寸标注独立于捕捉开关：标过就应该一直看得到
  drawDimAnnotations(ctx, r);

  /*
   * 常驻显示图元的**特征点**（端点 / 圆心 / 象限点，像 SolidWorks 的蓝色小点）。
   * 这些点可以直接点来标尺寸，也可以按住拖动整个图元。
   *
   * 引用图元（e.ref）跳过：一条 48 点采样的引用线会画出几十个点，糊成一片。
   */
  drawFeaturePoints(ctx, r);

  if (!snap.enabled) return;

  /*
   * 追踪引导线（捕捉时的对齐提示，在 3D 里延伸再投影所以跟视角一致）。
   *
   * ⚠ 两条限制很重要：
   *   ① 长度**不能固定成 4000** —— 那会横穿整个画布，屏幕上一堆长虚线，
   *      看着像"误操作产生的大量虚线"（用户实测反馈的画面就是这个）
   *   ② 不透明度别太高，否则盖住草图本身
   * 现在按当前草图内容的范围取长度，引导线只出现在草图附近。
   */
  if (snapGuides.length) {
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = "rgba(255,179,64,.45)";
    ctx.lineWidth = 1.2;
    const bb2 = sketch.bounds2D;
    const span = bb2 ? Math.max(bb2.maxX - bb2.minX, bb2.maxY - bb2.minY) : 60;
    const L = Math.max(40, span * 0.75);        // 半长，跟着草图大小走
    for (const g of snapGuides.slice(0, 3)) {   // 最多画 3 条，多了就是噪声
      const a = g.kind === "h" ? sketchToScreen([g.from[0] - L, g.from[1]]) : sketchToScreen([g.from[0], g.from[1] - L]);
      const b = g.kind === "h" ? sketchToScreen([g.from[0] + L, g.from[1]]) : sketchToScreen([g.from[0], g.from[1] + L]);
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a[0] - r.left, a[1] - r.top);
      ctx.lineTo(b[0] - r.left, b[1] - r.top);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 捕捉标记
  const best = snap.best;
  if (!best) return;
  const x = best.screen[0] - r.left, y = best.screen[1] - r.top;
  const s = 6;
  ctx.save();
  ctx.strokeStyle = SNAP_COLOR;
  ctx.lineWidth = 2;
  ctx.beginPath();
  switch (best.kind) {
    case "endpoint": ctx.rect(x - s, y - s, s * 2, s * 2); break;
    case "midpoint": ctx.moveTo(x, y - s); ctx.lineTo(x + s, y + s); ctx.lineTo(x - s, y + s); ctx.closePath(); break;
    case "center": ctx.arc(x, y, s, 0, Math.PI * 2); break;
    case "quadrant": ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath(); break;
    case "intersection":
      ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s);
      ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s); break;
    case "origin":
      ctx.rect(x - s, y - s, s * 2, s * 2);
      ctx.moveTo(x - s * 1.7, y); ctx.lineTo(x + s * 1.7, y);
      ctx.moveTo(x, y - s * 1.7); ctx.lineTo(x, y + s * 1.7);
      break;
    default: ctx.arc(x, y, s, 0, Math.PI * 2);
  }
  ctx.stroke();
  ctx.fillStyle = SNAP_COLOR;
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillText(SNAP_KINDS[best.kind]?.label || "捕捉", x + s + 5, y - s - 2);
  ctx.restore();
}

// ---------------------------------------------------------------- 尺寸标注（约束求解）
let dimEntity = null;      // 正在标注的图元下标

/** 把实体数组整体还原成快照（求解失败时回滚用） */
function restoreEntities(snapshot) {
  sketch.entities.length = 0;
  for (const e of snapshot) sketch.entities.push(e);
}

/** 尺寸工具：点中一个图元，列出它的尺寸 */
function dimPick(p2d) {
  if (!sketch) return;
  const hit = sketch.pickEntity([p2d.x, p2d.y], 6);
  if (!hit) { setStats("没点中图元，手指靠近轮廓线再点一下"); return; }
  dimEntity = hit.index;
  renderDimPanel();
  const name = hit.entity.kind === "rect" ? "矩形" : hit.entity.kind === "circle" ? "圆" : "折线";
  setStats(`已选中${name} #${hit.index + 1} · 改下面的数值，图形会自动变形`);
}

function renderDimPanel() {
  const el = $("dimPanel");
  if (!el) return;
  if (dimEntity == null || !sketch || !sketch.entities[dimEntity]) { el.classList.add("hidden"); return; }
  const e = sketch.entities[dimEntity];
  const dims = sketch.dimensionsOf(dimEntity);
  const name = e.kind === "rect" ? "矩形" : e.kind === "circle" ? "圆" : "折线";
  el.innerHTML = `<div class="dp-title">${name} #${dimEntity + 1} 的尺寸</div>` +
    (dims.length
      ? dims.map((d) => `<div class="dp-row"><span class="dp-label">${d.label}</span>` +
          `<input data-dim="${d.k}" type="number" inputmode="decimal" step="0.5" value="${(+d.value).toFixed(2)}"></div>`).join("")
      : `<div class="dp-hint">折线暂时没有可标注的尺寸</div>`) +
    `<div class="dp-hint">改完自动求解 · 当前约束 ${sketch.constraints.length} 条</div>`;
  el.classList.remove("hidden");
  for (const inp of el.querySelectorAll("[data-dim]")) {
    inp.onchange = () => applyDim(inp.dataset.dim, parseFloat(inp.value));
  }
}

/**
 * 应用一个尺寸：加约束 → 求解 → 不成功就整体回滚。
 * 回滚很关键：失败时若留下"解了一半"的图形，用户会以为改成功了，
 * 而那其实是错的几何 —— 宁可不改。
 */
function applyDim(k, v) {
  if (dimEntity == null || !sketch) return;
  if (!isFinite(v) || v <= 0) { setStats("尺寸必须是正数"); renderDimPanel(); return; }
  const dim = sketch.dimensionsOf(dimEntity).find((d) => d.k === k);
  if (!dim) return;

  const before = JSON.parse(JSON.stringify(sketch.entities));
  const beforeConstraints = sketch.constraints.slice();
  sketch.setDimension(dimEntity, k, v, dim.label);
  const t0 = performance.now();
  const res = solveSketch(sketch.entities, sketch.constraints);
  const ms = performance.now() - t0;

  if (!res.ok) {
    restoreEntities(before);
    sketch.constraints = beforeConstraints;  // 替换失败时也恢复被替换的旧尺寸
    redrawSketch();
    renderDimPanel();
    setStats(`这个尺寸和已有约束打架，已撤销 · 冲突：${res.conflicts.join("、") || "约束过多"}（模型未改动）`);
    return;
  }
  redrawSketch();
  renderDimPanel();
  setStats(`已标注 ${dim.label} = ${v}mm · 求解 ${res.iterations} 次迭代 ${ms.toFixed(1)} ms · ` +
    `约束 ${sketch.constraints.length} 条 · 估算剩余自由度 ${res.dof} · maxErr ${res.maxErr.toExponential(1)}`);
}
// ---------------------------------------------------------------- 关联 / 链接（拉伸到目标）
// 场景：两个并排不一样高的拉伸体，把其中一个的面拉到和另一个等高；
// 或者拉到一个端点/一条边上（面正好经过它）。
let linkSource = null;         // { faceId, center, normal }
let linkTarget = null;
let linkTargetKind = "face";   // face | edge | point

const LINK_KIND_NAME = { face: "面", edge: "边", point: "端点" };

function enterLinkMode() {
  mode = "link";
  linkSource = null;
  linkTarget = null;
  selectedFaceId = null;
  selSnap = null;
  dim?.hide();
  viewer.clearHighlight();
  showPicker(null);
  viewer.setEdgeData(OPS.edgePointSets(shape));
  $("toolbar").classList.add("hidden");
  $("linkbar").classList.remove("hidden");
  updateLinkHint();
}

function exitLinkMode() {
  mode = "select";
  linkSource = null;
  linkTarget = null;
  viewer.clearHighlight();
  viewer.highlightEdges([]);
  viewer.setEdgeData([]);
  $("linkbar").classList.add("hidden");
  $("toolbar").classList.remove("hidden");
  setMode("select");
}

function updateLinkHint() {
  const el = $("linkHint");
  if (!el) return;
  el.textContent = !linkSource
    ? "① 点要移动的那个面"
    : `② 点目标${LINK_KIND_NAME[linkTargetKind]}（源面会拉伸到那儿）`;
}

/** 链接模式下的拾取 */
function linkPick(faceId, pt) {
  if (!linkSource) {
    if (faceId == null) { setStats("请点一个面作为要移动的对象"); return; }
    const info = OPS.faceInfo(shape, faceId);
    if (!info) return;
    linkSource = { faceId, center: info.center.slice(), normal: info.normal.slice() };
    viewer.highlightFace(faceId);
    updateLinkHint();
    setStats(`已选源面（法向 ${info.normal.map((v) => v.toFixed(2)).join(", ")}）· 现在点目标`);
    return;
  }
  // 选目标
  if (linkTargetKind === "face") {
    if (faceId == null) { setStats("没点中面，再试一次"); return; }
    if (faceId === linkSource.faceId) { setStats("不能选自己，请点另一个面"); return; }
    const info = OPS.faceInfo(shape, faceId);
    if (!info) return;
    linkTarget = { kind: "face", center: info.center.slice(), normal: info.normal.slice() };
  } else {
    const e = pt ? viewer.pickEdgeAt(pt.x, pt.y) : null;
    if (!e) { setStats(`没点中${LINK_KIND_NAME[linkTargetKind]}，再靠近一点`); return; }
    const sets = OPS.edgePointSets(shape, 40);
    const hit = sets.find((s) => s.hash === e.hashCode);
    if (!hit) { setStats("这条边取不到点，换一条试试"); return; }
    const n = linkSource.normal;
    // 边上「离源面最近」的那个采样点：面拉到它上面就算碰到这条边了
    let best = null, bd = Infinity;
    for (const p of hit.pts) {
      const d = (p[0] - linkSource.center[0]) * n[0] + (p[1] - linkSource.center[1]) * n[1] + (p[2] - linkSource.center[2]) * n[2];
      if (d < bd) { bd = d; best = p; }
    }
    linkTarget = { kind: linkTargetKind, point: best.slice(), dist: bd };
    viewer.highlightEdges([hit]);
  }
  applyLink();
}

/**
 * 把源面沿它的法向移动，使其正好对上目标。
 * 面→面 = 等高；面→边/点 = 面正好经过那个点。
 */
function applyLink() {
  const A = linkSource, T = linkTarget;
  if (!A || !T) return;
  const n = A.normal;
  const px = T.point || T.center;
  const d = (px[0] - A.center[0]) * n[0] + (px[1] - A.center[1]) * n[1] + (px[2] - A.center[2]) * n[2];
  const what = T.kind === "face" ? "与目标面等高" : `拉伸到${LINK_KIND_NAME[T.kind]}上`;
  if (Math.abs(d) < 1e-4) {
    exitLinkMode();
    setStats(`已经和目标是同一位置了（距离 ${d.toFixed(4)}mm），没有可移动的量`);
    return;
  }
  const srcId = A.faceId;
  // 面→面：存成**持久关联**，以后改上游会自动重新对齐；
  // 边/端点目标只做一次性移动（要持久化得跟踪边的引用，暂不做）
  const extra = T.kind === "face"
    ? { alignTo: { faceRef: { center: T.center.slice(), normal: T.normal.slice() } } }
    : null;
  exitLinkMode();
  commitPushPull(shape, srcId, d, extra);
  setStats(`已链接：把选中的面沿法向移动 ${d > 0 ? "+" : ""}${d.toFixed(2)}mm → ${what}` +
    (extra ? ` · 已存成持久关联（改上游会自动重新对齐）` : ` · 一次性移动`) +
    ` · ` + $("stats").textContent);
}

// 链接模式下的工具栏按钮
document.querySelectorAll("#linkbar [data-lkind]").forEach((b) => {
  b.onclick = () => {
    linkTargetKind = b.dataset.lkind;
    for (const x of document.querySelectorAll("#linkbar [data-lkind]")) x.classList.toggle("on", x === b);
    if (linkSource) { linkSource = null; viewer.highlightFace(null); }
    updateLinkHint();
    setStats(`目标类型已设为「${LINK_KIND_NAME[linkTargetKind]}」· 先点要移动的面，再点目标`);
  };
});
document.querySelectorAll("#linkbar [data-lact]").forEach((b) => {
  b.onclick = () => { exitLinkMode(); setStats("已退出链接模式"); };
});

// ---------------------------------------------------------------- 转换实体引用 / 等距实体
let offsetEntityIdx = null;

/** 把一条 3D 边投影到当前草图。直线边只要两端点（投影后仍精确），曲线按采样近似 */
function refEdge(edge) {
  if (!sketch) return;
  try {
    const straight = OPS.edgeIsStraight(edge);
    const N = straight ? 1 : 48;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const p = edge.pointAt(i / N);
      if (p) pts.push([p.x, p.y, p.z]);
    }
    const e = sketch.addProjectedPoints(pts);
    if (!e) { setStats("这条边投影下来是空的（大概是垂直于草图平面）"); return; }
    redrawSketch();
    setStats(`已引用 1 条${straight ? "直线" : "曲线"}边 → 草图里多了一条 ${e.pts.length} 点的折线 · ` +
      `共 ${sketch.entities.length} 个轮廓`);
  } catch (err) {
    setStats("引用失败：" + (err?.message || err));
  }
}

/** 把一个面的整圈边界都投影到草图 */
function refFace(faceId) {
  if (!sketch) return;
  let n = 0;
  try {
    const face = OPS.findFace(shape, faceId);
    const edges = face?.edges || [];
    for (const e of edges) {
      const straight = OPS.edgeIsStraight(e);
      const N = straight ? 1 : 48;
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const p = e.pointAt(i / N);
        if (p) pts.push([p.x, p.y, p.z]);
      }
      if (sketch.addProjectedPoints(pts)) n++;
    }
  } catch (err) {
    setStats("引用面的边界失败：" + (err?.message || err));
    return;
  }
  redrawSketch();
  setStats(n
    ? `已引用这个面的 ${n} 条边界 → 共 ${sketch.entities.length} 个轮廓`
    : "这个面取不到边界边，改点一条具体的边试试");
}

function offsetPick(p2d) {
  if (!sketch) return;
  const hit = sketch.pickEntity([p2d.x, p2d.y], 6);
  if (!hit) { setStats("没点中图元，靠近轮廓线再点一下"); return; }
  offsetEntityIdx = hit.index;
  const e = hit.entity;
  const nm = e.kind === "circle" ? "圆" : e.kind === "rect" ? "矩形" : "折线";
  $("offsetTitle").textContent = `${nm} #${hit.index + 1} 等距`;
  $("offsetPanel").classList.remove("hidden");
  setStats(`已选中${nm} #${hit.index + 1} · 输入距离后点「生成」`);
}

function applyOffset() {
  if (offsetEntityIdx == null || !sketch) return;
  const d = parseFloat($("offsetVal").value);
  if (!isFinite(d) || Math.abs(d) < 1e-6) { setStats("请输入一个非零距离"); return; }
  const r = sketch.offsetEntity(offsetEntityIdx, d);
  if (!r.ok) { setStats("等距失败：" + r.why); return; }
  redrawSketch();
  $("offsetPanel").classList.add("hidden");
  offsetEntityIdx = null;
  setStats(`已生成等距：${r.desc} · 共 ${sketch.entities.length} 个轮廓`);
}

document.querySelectorAll("#offsetPanel [data-oact]").forEach((b) => {
  b.onclick = () => {
    if (b.dataset.oact === "apply") applyOffset();
    else { $("offsetPanel").classList.add("hidden"); offsetEntityIdx = null; setStats("已取消等距"); }
  };
});

// ---------------------------------------------------------------- 模式切换（开始界面 / 建模 / 看图）
let appMode = null;          // "model" | "view"
let viewMesh = null;         // 看图模式下当前显示的网格
let viewWireframe = false;
let viewShowEdges = true;

function showStartScreen(show) {
  $("startScreen").classList.toggle("hidden", !show);
}

/** 建模模式：把建模 UI 全套放出来（浮层 UI：画布铺满，树与历史默认收起） */
function enterModelMode() {
  appMode = "model";
  showStartScreen(false);
  $("viewbar").classList.add("hidden");
  $("toolbar").classList.remove("hidden");
  $("status").classList.remove("hidden");
  // 平板浮层 UI：模型树 / 历史都是「按需浮出」，不再一进来就挤占画布
  setFeatTreeOpen(false);
  setTreeOpen(false);
  // 进建模=干净的画布：不自动替用户选中面（要面卡的话点一下面就有了）
  selectedFaceId = null;
  selSnap = null;
  try { viewer.clearHighlight(); } catch (_) {}
  showPicker(null);
  try { dim?.hide(); } catch (_) {}
  refresh({ fit: true });
  setStats("建模模式 · 点左缘「草图」开始，或选一个面推拉 · 长按画布出快捷菜单");
}

/** 看图模式：只留看图的 UI，建模操作全部收起来 */
function enterViewMode() {
  closePatternEditor();
  dim?.hide();
  appMode = "view";
  showStartScreen(false);
  $("toolbar").classList.add("hidden");
  $("sketchbar").classList.add("hidden");
  $("edgebar").classList.add("hidden");
  $("picker").classList.add("hidden");
  $("dimPanel").classList.add("hidden");
  $("extrude").classList.add("hidden");
  $("linkbar").classList.add("hidden");
  $("smartPad").classList.add("hidden");
  $("viewbar").classList.remove("hidden");
  setTreeOpen(false);
  setFeatTreeOpen(false);    // 看图模式不需要特征树
  viewer.setSketchLines(null, null);
  viewer.clearHighlight();
  viewer.setEdgeData([]);
  drawSnapOverlay();
  setStats("看图模式 · 点「打开文件」选 STEP / STL / PLY / OBJ");
}

function backToStart() {
  dim?.hide();
  appMode = null;
  exitLinkMode();
  if (mode === "sketch") exitSketch();
  viewMesh = null;
  viewer.setMesh({ vertices: new Float32Array(0), normals: new Float32Array(0), triangles: new Uint32Array(0), faceGroups: [], triCount: 0 });
  showStartScreen(true);
  $("viewbar").classList.add("hidden");
  $("toolbar").classList.add("hidden");
  setFeatTreeOpen(false);
  setTreeOpen(false);
  viewer.clearSketchLines();
  viewer.clearHighlight();
  drawSnapOverlay();
}

/**
 * 把导入的网格变成 viewer 能吃的格式，然后显示。
 * viewer 的 setMesh 要的是 {vertices, normals, triangles(索引), faceGroups}，
 * 而解析器给的是展开的逐三角顶点，这里重建一下索引。
 * 不用去重优化 —— 顶点数一变就要重建映射，反而更慢，而 STL 本来就没索引。
 */
function displayImportedMesh(parsed, label) {
  const n = parsed.triangleCount;
  // STEP meshes share vertices and must retain the kernel's triangle indices.
  const triangles = parsed.triangles || new Uint32Array(n * 3);
  if (!parsed.triangles) for (let i = 0; i < n * 3; i++) triangles[i] = i;
  viewMesh = {
    vertices: parsed.positions,
    normals: parsed.normals,
    triangles,
    faceGroups: [],
    triCount: n,
    label,
  };
  viewer.setMesh(viewMesh, { fit: true });
  applyViewDisplay();
  viewer.invalidate();
}

function applyViewDisplay() {
  if (!viewMesh) return;
  // viewer.setMesh 里用的是 matBody / matEdge 这两个名字
  try { if (viewer.matBody) viewer.matBody.wireframe = viewWireframe; } catch (_) {}
  // setMesh 会给网格自动生成 EdgesGeometry（夹角 >18° 的边），
  // 所以"显示棱边"就是控制这个 LineSegments 的可见性
  try { if (viewer.edgeMesh) viewer.edgeMesh.visible = viewShowEdges; } catch (_) {}
  try { viewer.invalidate(); } catch (_) {}
}

/** 打开一个文件（按扩展名分派到网格解析器或几何内核） */
async function openFile(file) {
  if (!file) return;
  const name = file.name || "未命名";
  const ext = (name.split(".").pop() || "").toLowerCase();
  setStats(`正在读取 ${name} …（${(file.size / 1024).toFixed(0)} KB）`);
  const t0 = performance.now();
  try {
    if (ext === "step" || ext === "stp") {
      // STEP 走几何内核：读回来是真实 B-rep，不只是网格。
      // step-io.js：状态码真判、实体→壳(缝合)→面 分层兜底、BOM/垃圾文件给人话错误（对标 Materializr StepIO）
      const res = await readStepBlob(file, { name });
      const imported = res.shape;
      const vol = safeVolume(res);
      const volText = vol == null ? "非实体（无体积）" : `体积 ${vol.toFixed(1)} mm³`;
      const warn = res.warnings.length ? ` · ⚠ ${res.warnings.join("；")}` : "";
      const isSolid = res.level === "solid" || res.level === "shell-sewn";
      // 建模模式下：实体 STEP 作为「第一个特征」接进参数化历史，后面可以继续拉伸/开孔/改尺寸
      if (appMode === "model" && isSolid) {
        const reg = OPS.registerImported(imported, name);
        shape = imported;
        history = [];
        hIndex = -1;
        // ⚠ 这里原来有 `redo = []` —— redo 是 const 函数（重做 = gotoStep(hIndex+1)），赋值直接抛
        //   "Assignment to constant variable"，真机导入 STEP 必失败（5.1.2 真机 CDP 抓到）。
        //   commit() 自己会截断 hIndex 之后的历史，不需要另清重做栈。
        commit(name, `STEP 导入 · 面 ${res.faces} · ${volText}`,
          "import", { type: "import", id: reg.id, name });
        setMode("select");
        refresh({ fit: true });
        setStats(`${name} 已作为设计起点导入 · 实体 ${res.solids} · 面 ${res.faces} · ${volText} · ` +
          `用时 ${(performance.now() - t0).toFixed(0)} ms${warn}`);
        return;
      }
      if (appMode === "model" && !isSolid) {
        // 片体/面集不能当实体特征的起点 —— 切到看图模式显示，并说清楚原因，而不是静默失败
        enterViewMode();
      }
      const m = OPS.meshOfShape(imported);
      displayImportedMesh({ positions: m.vertices, normals: m.normals, triangles: m.triangles, triangleCount: m.triCount }, name);
      setStats(`${name} 读取成功 · 实体 ${res.solids} · 面 ${res.faces} · 三角 ${m.triCount} · ${volText} · ` +
        `用时 ${(performance.now() - t0).toFixed(0)} ms${warn}`);
    } else if (ext === "stl" || ext === "ply" || ext === "obj") {
      // 网格不是 B-rep，不能当建模起点：在建模模式里选了网格就切到看图模式显示
      if (appMode === "model") enterViewMode();
      const buf = await file.arrayBuffer();
      const parsed = parseMesh(name, ext === "obj" ? new TextDecoder().decode(buf) : new Uint8Array(buf));
      if (!parsed) throw new Error(`不认识的格式 .${ext}`);
      displayImportedMesh(parsed, name);
      setStats(`${name} 读取成功 · ${parsed.triangleCount} 三角` +
        (parsed.skipped ? `（跳过 ${parsed.skipped} 个坏面）` : "") +
        ` · 用时 ${(performance.now() - t0).toFixed(0)} ms`);
    } else if (OBJ_NAMES.includes(ext)) {
      setStats(`${name}：X_T / Parasolid 是 Siemens 私有格式，本内核（OpenCASCADE）读不了 —— ` +
        `请在原软件里另存为 STEP 再导入`);
    } else {
      setStats(`${name}：不支持的格式 .${ext}（可读 STEP / STL / PLY / OBJ）`);
    }
  } catch (e) {
    setStats(`读取 ${name} 失败：${e?.message || e}`);
  }
}

const OBJ_NAMES = ["x_t", "xmt_txt", "x_b", "xmt_bin"];

// 开始界面按钮
document.querySelectorAll("#startScreen .ss-mode").forEach((b) => {
  b.onclick = () => {
    if (b.dataset.mode === "view") enterViewMode();
    else enterModelMode();
  };
});

// 看图工具条
document.querySelectorAll("#viewbar [data-vact]").forEach((b) => {
  b.onclick = () => {
    const a = b.dataset.vact;
    if (a === "open") $("fileInput").click();
    else if (a === "script") openScriptPad();
    else if (a === "fit") viewer.cam.fit(viewer.bbox);
    else if (a === "wire") {
      viewWireframe = !viewWireframe;
      b.classList.toggle("on", viewWireframe);
      applyViewDisplay();
      setStats(viewWireframe ? "线框显示" : "实体显示");
    } else if (a === "edges") {
      viewShowEdges = !viewShowEdges;
      b.classList.toggle("on", viewShowEdges);
      applyViewDisplay();
      setStats(viewShowEdges ? "显示棱边" : "隐藏棱边");
    } else if (a === "back") {
      backToStart();
    }
  };
});

$("fileInput").onchange = (e) => {
  const f = e.target.files?.[0];
  if (f) openFile(f);
  e.target.value = "";        // 允许连续选同一个文件
};

// 拖放也能打开
window.addEventListener("dragover", (e) => { e.preventDefault(); });
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) { if (appMode !== "view") enterViewMode(); openFile(f); }
});

// ---------------------------------------------------------------- 左侧特征树（结构视角，仿 SolidWorks）
let ftOpen = true;
let ftRenaming = null;

/** 特征类型 → 中文名（仿 SolidWorks 的「凸台-拉伸」「切除-拉伸」命名法） */
function featureDisplayName(h, i) {
  // 用户改过名就用用户的 —— 自定义名优先，否则改了等于没改
  if (h.customName) return h.customName;
  const op = h.op;
  if (!op) return h.label;
  if (op.type === "base") return "起始零件";
  if (op.type === "extrude") {
    // 加料 = 凸台，挖料 = 切除，和 SolidWorks 的叫法对齐
    const cut = op.depth < 0;
    return `${cut ? "切除-拉伸" : "凸台-拉伸"}${i}`;
  }
  if (op.type === "pushpull") {
    return `${op.dist < 0 ? "切除-推拉" : "凸台-推拉"}${i}`;
  }
  if (op.type === "primitive") {
    const n = { box: "长方体", cylinder: "圆柱", sphere: "球", cone: "圆锥", torus: "圆环" }[op.shape] || "形体";
    return `${op.mode === "cut" ? "切除-" : ""}${n}${i}`;
  }
  if (op.type === "helix") return `螺旋${i}`;
  if (op.type === "pushface") return `${op.dist < 0 ? "切除-推拉" : "凸台-推拉"}${i}`;
  const n = {
    fillet: "圆角", chamfer: "倒角", shell: "抽壳", revolve: "旋转", sweep: "扫掠",
    loft: "放样", pattern: "阵列", mirror: "镜像", move3d: "移动",
  }[op.type] || h.label;
  return `${n}${i}`;
}

function renderFeatTree() {
  const el = $("ftList");
  if (!el) return;
  const rows = [];
  const node = (d, ico, name, detail, cls = "", attrs = "", acts = "") =>
    `<div class="ft-node ${cls}" style="--d:${d}" ${attrs}>` +
    `<span class="ft-ico">${ico}</span>` +
    `<span class="ft-nm">${escapeHTML(name)}</span>` +
    (detail ? `<span class="ft-dt">${escapeHTML(detail)}</span>` : "") +
    acts +
    `</div>`;

  rows.push(node(0, "▣", "PadCAD 模型", "", "grp"));
  rows.push(node(1, "▱", "基准面", "XY · XZ · YZ", "grp dim"));
  rows.push(node(1, "✛", "原点", "世界原点", "dim"));

  if (!history.length) {
    rows.push(node(1, "▪", "（还没有特征）", "", "dim"));
  }
  history.forEach((h, i) => {
    const sel = i === hIndex ? "sel" : (i > hIndex ? "dim" : "");
    /*
     * 每行的操作按钮（参考 Chili3D 的树条目：它把「眼睛」放在名字左边、可点击切换）。
     *   眼睛 = 压制/解除压制（SolidWorks 的 Suppress）：定义留着、这次不参与计算
     *   ✕    = 真删除
     * 被压制的行整行变灰，一眼能看出来。
     */
    const sup = !!h.suppressed;
    const eyeSvg = sup
      ? `<svg viewBox="0 0 20 20" width="14" height="14"><path d="M3 10s2.6-4.2 7-4.2S17 10 17 10s-2.6 4.2-7 4.2S3 10 3 10z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4 4l12 12" stroke="currentColor" stroke-width="1.4"/></svg>`
      : `<svg viewBox="0 0 20 20" width="14" height="14"><path d="M3 10s2.6-4.2 7-4.2S17 10 17 10s-2.6 4.2-7 4.2S3 10 3 10z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="10" cy="10" r="1.9" fill="currentColor"/></svg>`;
    const eyeBtn = `<button class="ft-act ft-eye${sup ? " off" : ""}" data-eye="${i}" title="${sup ? "解除压制（重新参与计算）" : "压制这个特征（暂时不参与计算）"}">${eyeSvg}</button>`;
    const delBtn = `<button class="ft-act ft-del" data-del="${i}" title="删除这个特征">✕</button>`;
    rows.push(node(1, h.icon, featureDisplayName(h, i), h.detail || "", sel + (sup ? " sup" : ""), `data-i="${i}"`, eyeBtn + delBtn));
    // 拉伸底下挂草图子节点 —— SolidWorks 就是这么组织的
    if (h.op?.type === "extrude" && h.op.entities) {
      const nc = (h.op.constraints || []).length;
      rows.push(node(2, "✎", `草图${i}`,
        `${h.op.entities.length} 图元${nc ? ` · ${nc} 约束` : ""}`, sel, `data-sketch="${i}"`));
    }
  });
  el.innerHTML = rows.join("");
  // 眼睛：切换压制状态，然后重放（定义不删，随时能解压回来）
  for (const b of el.querySelectorAll("[data-eye]")) {
    b.onclick = (ev2) => {
      ev2.stopPropagation();
      const i = parseInt(b.dataset.eye, 10);
      if (Number.isFinite(i)) toggleSuppress(i);
    };
  }
  // 删除按钮：点它删这一整步（带 stopPropagation，别把"点一行回到那一步"也触发了）
  for (const b of el.querySelectorAll("[data-del]")) {
    b.onclick = (ev2) => {
      ev2.stopPropagation();
      const i = parseInt(b.dataset.del, 10);
      if (Number.isFinite(i)) deleteStep(i);
    };
  }

  for (const n of el.querySelectorAll(".ft-node")) {
    n.ondblclick = () => {
      const i = n.dataset.i != null ? +n.dataset.i : (n.dataset.sketch != null ? +n.dataset.sketch : null);
      if (i == null) return;
      startRename(n, i);
    };
    n.onclick = (ev) => {
      if (ftRenaming) return;
      if (n.dataset.sketch != null) { editSketchOf(+n.dataset.sketch); return; }
      if (n.dataset.i != null) {
        const i = +n.dataset.i;
        if (["pattern", "mirror"].includes(history[i]?.op?.type)) { editStep(i); return; }
        gotoStep(i);
        // 可改参数的特征直接把属性面板打开（图 2 那种"编辑特征"）
        if (history[i].op && EDITABLE[history[i].op.type]) editStep(i);
        void ev;
      }
    };
  }
}

/** 双击改名 —— 特征名是用户自己的标签，改了要能存进历史并参与重放显示 */
function startRename(node, i) {
  if (!history[i]) return;
  ftRenaming = i;
  const old = history[i].label;
  const nm = node.querySelector(".ft-nm");
  nm.innerHTML = `<input id="ftRenameInput" value="${old.replace(/"/g, "&quot;")}" />`;
  const inp = node.querySelector("#ftRenameInput");
  inp.focus();
  inp.select();
  const finish = (commit) => {
    if (ftRenaming == null) return;
    ftRenaming = null;
    const v = inp.value.trim();
    if (commit && v) {
      history[i].customName = v;      // 自定义名单独存，别覆盖 label（label 是特征树右侧的参数摘要来源）
      history[i].label = v;
    }
    renderFeatTree();
    renderTree();
    if (commit && v) setStats(`特征已改名为「${v}」`);
  };
  inp.onblur = () => finish(true);
  inp.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  };
}

function setFeatTreeOpen(open) {
  ftOpen = !!open;
  document.body.classList.toggle("feat-open", ftOpen);
  $("btnFeatShow").classList.toggle("hidden", ftOpen);
  requestAnimationFrame(() => { viewer.resize(); drawSnapOverlay(); });
}

$("btnFeatToggle").onclick = () => setFeatTreeOpen(false);
$("btnFeatShow").onclick = () => setFeatTreeOpen(true);

// ---------------------------------------------------------------- 保存 / 打开工程
const SAVE_KEY = "padcad.projects.v1";

function listProjects() {
  try {
    const projects = JSON.parse(localStorage.getItem(SAVE_KEY) || "{}");
    return projects && typeof projects === "object" && !Array.isArray(projects)
      ? Object.assign(Object.create(null), projects) : Object.create(null);
  } catch (_) { return Object.create(null); }
}
function writeProjects(obj) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(obj)); return true; }
  catch (e) { setStats("保存失败（本地存储写不进去）：" + (e?.message || e)); return false; }
}

/**
 * 序列化工程：**只存特征定义，不存实体**。
 * 实体是 wasm 对象，序列化不了 —— 也不需要：打开时从头重放就能重建出
 * 一模一样的模型。这正是参数化模型的价值。
 */
function serializeProject(name) {
  return projectDefinition(name, history, hIndex, refGeoms, rgSeq);
}

let saveDialogMode = "save";     // save | load

function openSaveDialog(mode) {
  saveDialogMode = mode;
  const isSave = mode === "save";
  $("sdTitle").textContent = isSave ? "保存工程" : "打开工程";
  $("sdOk").textContent = isSave ? "保存" : "打开";
  $("saveName").style.display = isSave ? "" : "none";
  const dl = listProjects();
  const names = Object.keys(dl).sort((a, b) => (dl[b].savedAt || "").localeCompare(dl[a].savedAt || ""));
  $("saveList").innerHTML = names.length
    ? names.map((n) => `<div class="sd-item" data-name="${escapeHTML(n)}">
         <span>${escapeHTML(n)}</span>
         <span class="sd-meta">${escapeHTML(dl[n].featureCount ?? "?")} 特征 · ${escapeHTML((dl[n].savedAt || "").slice(5, 16).replace("T", " "))}</span>
         <span class="sd-del" data-del="${escapeHTML(n)}">删除</span>
       </div>`).join("")
    : `<div class="sd-meta" style="padding:6px 2px">${isSave ? "还没有存过工程" : "没有已保存的工程"}</div>`;
  if (isSave) {
    $("saveName").value = (history[0]?.customName) || `零件${new Date().toLocaleDateString("zh-CN").replace(/\//g, "-")}`;
  }
  $("saveDialog").classList.remove("hidden");
  if (isSave) $("saveName").focus();
  for (const it of $("saveList").querySelectorAll(".sd-item")) {
    it.onclick = (ev) => {
      const del = ev.target.closest?.("[data-del]");
      if (del) {
        const d = listProjects();
        delete d[del.dataset.del];
        if (!writeProjects(d)) return;
        openSaveDialog(saveDialogMode);
        setStats(`已删除工程「${del.dataset.del}」`);
        return;
      }
      if (saveDialogMode === "load") doLoad(it.dataset.name);
      else $("saveName").value = it.dataset.name;
    };
  }
}

function closeSaveDialog() { $("saveDialog").classList.add("hidden"); }

function doSave() {
  const name = ($("saveName").value || "").trim();
  if (!name) { setStats("请先给工程起个名字"); $("saveName").focus(); return; }
  if (name.length > 60) { setStats("名字太长了（60 字以内）"); return; }
  const dl = listProjects();
  const existed = !!dl[name];
  dl[name] = serializeProject(name);
  if (!writeProjects(dl)) return;
  workspaceUI?.setDocumentName(name);
  closeSaveDialog();
  setStats(`已保存工程「${name}」· ${history.length} 个特征${existed ? "（覆盖了同名工程）" : ""}`);
}

/** 打开：把存下来的特征定义装回 history，然后从头重放 */
function doLoad(name) {
  const p = listProjects()[name];
  if (!p || !p.features?.length) { setStats(`工程「${name}」是空的`); return; }
  loadProjectData(p, name);
}

function loadProjectData(p, name) {
  // Validate and build in isolation. A corrupt project must not replace current work.
  let next;
  try { next = restoreProject(p); }
  catch (e) { setStats(`打开「${name}」失败：${e?.message || e} · 当前工程已保留`); return; }
  cancelEdit(true);
  if (appMode !== "model") enterModelMode();
  if (mode === "sketch") exitSketch();
  if (mode === "link") exitLinkMode();
  if (["fillet", "chamfer", "shell"].includes(mode)) exitEdgeMode();
  closeSaveDialog();
  ({ history, hIndex, shape, refGeoms, rgSeq } = next);
  workspaceUI?.setDocumentName(name);
  try { rebuildRefGeoms(); } catch (_) {}
  selectFace(null);
  setMode("select");
  refresh({ fit: true });
  renderTree();
  setStats(`已打开工程「${name}」· ${history.length} 个特征 · ` + $("stats").textContent);
}

function exportProjectFile() {
  if (!history.length) { setStats("请先创建一个特征"); return; }
  const name = ($("saveName").value || "PadCAD工程").trim();
  const blob = new Blob([JSON.stringify(serializeProject(name), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name.replace(/[\\/:*?"<>|]/g, "_") + ".padcad.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStats("已导出工程文件，可在其他浏览器或设备中导入继续编辑");
}

$("projectFileInput").onchange = async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const project = JSON.parse(await file.text());
    loadProjectData(project, project.name || file.name);
  } catch (error) { setStats(`导入工程失败：${error.message} · 当前工程已保留`); }
};

document.querySelectorAll("#saveDialog [data-sdact]").forEach((b) => {
  b.onclick = () => {
    if (b.dataset.sdact === "ok") {
      if (saveDialogMode === "save") doSave();
      else {
        const first = $("saveList").querySelector(".sd-item")?.dataset.name;
        if (first) doLoad(first); else setStats("没有可打开的工程");
      }
    } else if (b.dataset.sdact === "export") exportProjectFile();
    else if (b.dataset.sdact === "import") $("projectFileInput").click();
    else closeSaveDialog();
  };
});
$("saveName").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); doSave(); } };

// ---------------------------------------------------------------- 建模脚本（AI / 批量化建模）
/*
 * 借鉴 Yi3D 的 AI-Assisted Modeling：脚本是纯数据（不含 wasm 引用），
 * 交给内核逐步重放，每一步都读回体积/包围盒做**几何校验** ——
 * 「脚本跑成功」和「几何是对的」是两件事，必须分开判。
 *
 * 纪律：解析失败、某步失败、或校验不通过，都**不动当前文档**
 * （runModelScript 返回 shape=null），并把失败步骤与原因写在面板上。
 */
let scriptUndo = null;          // 上一次脚本运行前的文档快照（只留最近一次）

const SCRIPT_TEMPLATE = `{
  "v": 1,
  "name": "示例：底板 + 锥台 + 推拉 + 弹簧",
  "params": { "L": 80, "W": 60, "T": 12, "D": 20, "TURNS": 6 },
  "steps": [
    { "op": { "type": "primitive", "shape": "box", "size": ["$L", "$W", "$T"] },
      "label": "底板", "expect": { "volume": "$L*$W*$T" } },
    { "op": { "type": "primitive", "shape": "cone", "r1": 18, "r2": 10, "h": "$D", "at": [0, 0, "$T"] },
      "label": "锥台" },
    { "op": { "type": "pushface", "selector": { "at": [0, 0, "$T"], "normal": [0, 0, 1] }, "dist": 5 },
      "label": "顶面推拉 5mm" },
    { "op": { "type": "fillet", "radius": 3, "selector": { "dir": [0, 0, 1], "all": true } },
      "label": "四条竖边倒 R3" },
    { "op": { "type": "helix", "R": 30, "wireR": 3, "pitch": 10, "turns": "$TURNS", "at": [200, 0, 0] },
      "label": "弹簧" }
  ]
}`;

function scriptReportHTML(run) {
  const sum = summarize(run);
  const rows = sum.steps.map((s) => {
    const check = s.check
      ? (s.check.ok ? " · 校验✓" : ` · <b>校验✗ ${s.check.items.filter((i) => !i.ok).map((i) => `${i.name} 实测 ${i.got} ≠ 期望 ${i.want}`).join("；")}</b>`)
      : "";
    return `<div class="sp-row${s.ok ? "" : " bad"}">${s.ok ? "✓" : "✗"} 第${s.index + 1}步 `
      + `「${escapeHTML(s.label)}」${s.detail ? " · " + escapeHTML(String(s.detail)) : ""} · ${s.ms}ms`
      + (s.volume != null ? ` · 体积 ${s.volume} mm³` : "") + (s.faces != null ? ` · ${s.faces} 面` : "")
      + check + (s.error ? ` · <b>${escapeHTML(s.error)}</b>` : "") + "</div>";
  }).join("");
  const head = sum.ok
    ? `完成 · ${sum.stepCount} 步 · ${sum.totalMs} ms`
      + (sum.checked ? ` · 几何校验 ${sum.checksPassed}/${sum.checked} 通过` : " · 未设 expect 校验")
    : `<b>第 ${(run.failed?.index ?? 0) + 1} 步失败</b>：${escapeHTML(run.failed?.message || "未知错误")} · 当前模型未改动`;
  return `<div class="sp-line${sum.ok ? "" : " bad"}">${head}</div>${rows}`;
}

function showScriptReport(html) {
  const el = $("spReport");
  if (el) { el.innerHTML = html; el.scrollTop = 0; }
}

/** 运行脚本。scriptMode: "replace"（从零重建） | "append"（追加到当前模型） */
function applyModelScript(script, scriptMode = "replace") {
  if (!script || typeof script !== "object" || Array.isArray(script)) {
    setStats("脚本必须是一个 JSON 对象");
    showScriptReport('<div class="sp-line bad">脚本必须是一个 JSON 对象</div>');
    return null;
  }
  cancelEdit(true);
  if (appMode !== "model") enterModelMode();
  if (mode === "sketch") exitSketch();
  else if (mode === "link") exitLinkMode();
  else if (["fillet", "chamfer", "shell"].includes(mode)) exitEdgeMode();
  else if (mode === "smartdim") cancelSmartDim();

  try { normalizeScript(script); } catch (e) {
    setStats(`脚本有问题：${e.message} · 当前模型未改动`);
    showScriptReport(`<div class="sp-line bad">脚本有问题：${escapeHTML(e.message)}</div>`);
    return null;
  }

  // 失败要能原样回退，所以先留一份快照（行对象本身不会被就地改）
  const backup = {
    history, hIndex, shape,
    refGeoms: JSON.parse(JSON.stringify(refGeoms)),
    rgSeq: { ...rgSeq },
    docName: workspaceUI?.documentName || null,
  };
  const base = scriptMode === "append" ? shape : null;
  const t0 = performance.now();
  let run;
  try {
    run = runModelScript(script, { shape: base });
  } catch (e) {
    setStats(`脚本执行失败：${e?.message || e} · 当前模型未改动`);
    showScriptReport(`<div class="sp-line bad">脚本执行失败：${escapeHTML(e?.message || String(e))} · 当前模型未改动</div>`);
    return null;
  }
  const totalMs = performance.now() - t0;
  showScriptReport(scriptReportHTML(run));
  if (!run.ok || !run.shape) {
    setStats(`脚本未通过（第 ${(run.failed?.index ?? 0) + 1} 步）· ${run.failed?.message || "执行失败"} · 当前模型未改动`);
    return null;
  }

  // 组装新历史：追加模式保留当前有效步骤（后续重放会连它们一起跑）
  const next = scriptMode === "append" ? history.slice(0, hIndex + 1).map((h) => ({ ...h })) : [];
  for (const r of run.report) {
    next.push({
      shape: r.shape, toolShape: r.tool || null,
      label: r.label, detail: r.detail, icon: FEATURE_ICON[r.op.type] || "▪", op: r.op,
    });
    markSnapshot(next[next.length - 1]);
  }
  scriptUndo = backup;
  $("spUndo").disabled = false;
  history = next;
  hIndex = history.length - 1;
  shape = run.shape;
  if (scriptMode === "replace") {
    refGeoms = [];
    rgSeq = { plane: 0, axis: 0, point: 0, csys: 0 };
    try { rebuildRefGeoms(); } catch (_) {}
  }
  selectFace(null);
  dim?.hide();
  viewer.clearHighlight();
  viewer.clearSketchLines();
  viewer.setEdgeData([]);
  refresh({ fit: true });
  renderTree();
  if (run.name) workspaceUI?.setDocumentName(run.name);
  const sum = summarize(run);
  setStats(`脚本${scriptMode === "append" ? "已追加" : "已重建"} · ${sum.stepCount} 步 · 用时 ${totalMs.toFixed(0)} ms`
    + ` · 体积 ${OPS.volumeOf(shape).toFixed(2)} mm³ · 面 ${shape.faces.length}`
    + (sum.checked ? ` · 校验 ${sum.checksPassed}/${sum.checked}` : ""));
  return sum;
}

function undoScriptRun() {
  if (!scriptUndo) { setStats("没有可撤销的脚本运行"); return false; }
  cancelEdit(true);
  if (mode === "sketch") exitSketch();
  else if (["fillet", "chamfer", "shell"].includes(mode)) exitEdgeMode();
  else if (mode === "link") exitLinkMode();
  else if (mode === "smartdim") cancelSmartDim();
  const b = scriptUndo;
  history = b.history;
  hIndex = b.hIndex;
  shape = b.shape;
  refGeoms = b.refGeoms;
  rgSeq = b.rgSeq;
  scriptUndo = null;
  $("spUndo").disabled = true;
  try { rebuildRefGeoms(); } catch (_) {}
  selectFace(null);
  refresh({ fit: true });
  renderTree();
  if (b.docName) workspaceUI?.setDocumentName(b.docName);
  setStats("已撤销上一次脚本运行 · 模型回到运行之前");
  return true;
}

function openScriptPad(force = null) {
  const pad = $("scriptPad");
  if (!pad) return;
  const wantOpen = force == null ? pad.classList.contains("hidden") : force;
  pad.classList.toggle("hidden", !wantOpen);
  if (wantOpen) {
    if (!$("spText").value.trim()) $("spText").value = SCRIPT_TEMPLATE;
    $("spUndo").disabled = !scriptUndo;
    const v = normalizeOrNull($("spText").value);
    $("spHint").textContent = v
      ? `已解析：${v.name || "未命名"} · ${v.steps.length} 步${v.checked ? "" : ""}`
      : "纯数据 JSON · 支持 $参数 · 每步可写 expect 做几何校验";
    setStats("建模脚本：粘贴 JSON → 「运行」重建模型 / 「追加」叠在当前模型上；脚本写错或校验不过都不会动当前模型");
  }
}

/** 解析文本框里的脚本（只做语法校验，不碰内核） */
function normalizeOrNull(text) {
  try { return normalizeScript(JSON.parse(text)); } catch (_) { return null; }
}

function runScriptFromPad(scriptMode) {
  let script;
  try { script = JSON.parse($("spText").value); }
  catch (e) { showScriptReport(`<div class="sp-line bad">JSON 解析失败：${escapeHTML(e.message)}</div>`); setStats("脚本 JSON 没解析通过，检查括号与逗号"); return null; }
  return applyModelScript(script, scriptMode);
}

/** 当前模型 → 脚本（可读的往返；导出的是交互操作，选择器版本要自己写） */
function exportCurrentAsScript() {
  if (!history.length) { setStats("还没有可导出的特征"); return null; }
  const name = (workspaceUI?.documentName || "PadCAD模型").trim();
  const s = scriptFromHistory(history.slice(0, hIndex + 1), name);
  $("spText").value = JSON.stringify(s, null, 2);
  $("spHint").textContent = `已把当前模型转成脚本：${s.steps.length} 步`;
  setStats(`已导出当前模型（${s.steps.length} 步）到脚本框 · 改完点「运行」即可重建`);
  return s;
}

// ---------------------------------------------------------------- 智能尺寸（点两个面 → 设定距离）
/*
 * 原理：不做复杂的 3D 约束求解器 —— "两个面的距离"本质上是**某个特征的参数**决定的
 * （凸台高度、推拉深度）。所以流程是：
 *   点两个面 → 量当前距离 → 反解出该改哪个特征的哪个参数 → 重放
 *   → **在新模型上重新测量** → 量出来不等于设定值就判为冲突，整件事作废。
 *
 * 最后那步"重新测量"就是冲突检测本身，不需要额外维护一张约束表。
 */
let spA = null;            // 第一个面 {center, normal, faceId}
let spB = null;            // 第二个面
let spPreviewShape = null;
let spPreviewing = false;

/** 沿 a 的法向，从 a 量到 b（带符号，正=b 在 a 的正面一侧） */
function faceDistance(a, b) {
  return (b.center[0] - a.center[0]) * a.normal[0]
       + (b.center[1] - a.center[1]) * a.normal[1]
       + (b.center[2] - a.center[2]) * a.normal[2];
}

/**
 * 找出哪个特征控制这个面。
 * 拉伸看"离草图平面的垂直距离"，推拉看"原始面沿法向推进后的位置"。
 * 注意不能拿三维距离去比：面在草图平面内本来就偏在矩形那儿（比如 x=20.9 而不是 0）。
 */
function findController(faceInfo) {
  const out = [];
  for (let i = hIndex; i >= 0; i--) {
    const op = history[i]?.op;
    if (!op || history[i].suppressed) continue;
    if (op.type === "extrude") {
      const n = op.plane.normal;
      const nd = n[0] * faceInfo.normal[0] + n[1] * faceInfo.normal[1] + n[2] * faceInfo.normal[2];
      if (nd < 0.9) continue;
      const along = (faceInfo.center[0] - op.plane.origin[0]) * n[0]
                  + (faceInfo.center[1] - op.plane.origin[1]) * n[1]
                  + (faceInfo.center[2] - op.plane.origin[2]) * n[2];
      if (Math.abs(along - Math.abs(op.depth)) > 0.5) continue;
      out.push({ i, kind: "extrude", key: "depth", value: op.depth, label: "拉伸深度" });
    } else if (op.type === "pushpull") {
      const n = op.faceRef.normal;
      const nd = n[0] * faceInfo.normal[0] + n[1] * faceInfo.normal[1] + n[2] * faceInfo.normal[2];
      if (nd < 0.98) continue;
      const exp = [0, 1, 2].map((k) => op.faceRef.center[k] + n[k] * op.dist);
      const d = Math.hypot(exp[0] - faceInfo.center[0], exp[1] - faceInfo.center[1], exp[2] - faceInfo.center[2]);
      if (d > 0.5) continue;
      out.push({ i, kind: "pushpull", key: "dist", value: op.dist, label: "推拉距离" });
    }
  }
  return out;
}

/**
 * 实测灵敏度：这个特征参数每变 1mm，两面距离变多少。
 *
 * 不能假设"参数变大距离就变大"——距离 = b - a，如果改的是 a 那一侧的特征，
 * 灵敏度是 **-1**（实测踩过：设 18mm 结果只到 2mm，因为方向反了）。
 * 花一次重放把 k 量出来，对任何特征、任何量取方向都成立。
 */
function distanceSensitivity(use, d0) {
  const probe = 0.5;
  const opProbe = { ...history[use.i].op, [use.key]: use.value + probe };
  try {
    const r = rebuild(history, hIndex, { [use.i]: opProbe });
    const nA = remapFace(r.shape, spA);
    const nB = remapFace(r.shape, spB);
    if (nA == null || nB == null) return null;
    const d1 = faceDistance(OPS.faceInfo(r.shape, nA), OPS.faceInfo(r.shape, nB));
    const k = (d1 - d0) / probe;
    return Math.abs(k) < 1e-6 ? null : k;
  } catch (_) {
    return null;
  }
}

function updateSmartPad() {
  $("spRef").textContent = !spA
    ? "① 点第一个面"
    : (!spB ? "② 再点第二个面" : `面↔面 · ${Math.abs(faceDistance(spA, spB)).toFixed(2)} mm`);
  $("spHint").textContent = !spB
    ? "点两个面，就能设定它们之间的距离"
    : "改数值后点 ✔ 应用；如果被其他特征限制住，会提示冲突并不生效";
}

function enterSmartDimMode() {
  mode = "smartdim";
  spA = null; spB = null;
  spPreviewing = false; spPreviewShape = null;
  selectedFaceId = null;
  selSnap = null;
  dim?.hide();
  viewer.clearHighlight();
  showPicker(null);
  $("spVal").value = "";
  $("smartPad").classList.remove("hidden");
  updateSmartPad();
  setStats("智能尺寸 · 点第一个面，再点第二个面，然后设定它们之间的距离");
}

function exitSmartDimMode() {
  mode = "select";
  spA = null; spB = null;
  spPreviewing = false; spPreviewShape = null;
  viewer.clearHighlight();
  $("smartPad").classList.add("hidden");
  setMode("select");
}

function smartDimPick(faceId) {
  if (faceId == null) { setStats("没点中面，再试一次"); return; }
  const info = OPS.faceInfo(shape, faceId);
  if (!info) return;
  const f = { center: info.center.slice(), normal: info.normal.slice(), faceId };
  if (!spA) {
    spA = f;
    viewer.highlightFace(faceId);
    updateSmartPad();
    setStats("已选第一个面 · 再点第二个面");
    return;
  }
  if (faceId === spA.faceId) { setStats("要选另一个面（不能是同一个）"); return; }
  spB = f;
  viewer.highlightFace(faceId);
  const d = faceDistance(spA, spB);
  // 显示绝对值：两面的「距离」用户关心的是多大，不关心正负号
  $("spVal").value = Math.abs(d).toFixed(2);
  updateSmartPad();
  const ca = findController(spA), cb = findController(spB);
  setStats(`两面垂直距离 ${Math.abs(d).toFixed(2)}mm · ` +
    (ca.length || cb.length
      ? `可由第 ${(ca[0] || cb[0]).i + 1} 步的「${history[(ca[0] || cb[0]).i].label}」驱动 · 改数值后点 ✔`
      : `这两个面不受任何可调特征控制，改不了它们的距离`));
}

/** 预览：按输入的数值试算一遍，不写进历史 */
function previewSmartDim() {
  if (!spA || !spB) { setStats("先点两个面"); return; }
  const target = parseFloat($("spVal").value);
  if (!isFinite(target) || target <= 0) { setStats("距离必须是正数"); return; }
  // 优先移动**后点的那个面** —— 直觉是「先点的当基准、后点的动」
  const use = findController(spB)[0] || findController(spA)[0];
  if (!use) { setStats("这两个面不受可调特征控制，预览不了"); return; }
  const d0 = faceDistance(spA, spB);
  const k = distanceSensitivity(use, d0);
  if (k == null) { setStats("预览失败：算不出这个特征的灵敏度"); return; }
  const delta = (target * (Math.sign(d0) || 1) - d0) / k;
  const newOp = { ...history[use.i].op, [use.key]: use.value + delta };
  try {
    const r = rebuild(history, hIndex, { [use.i]: newOp });
    if (!spPreviewing) spPreviewShape = shape;
    spPreviewing = true;
    shape = r.shape;
    selectedFaceId = null; selSnap = null;
    viewer.clearHighlight();
    refresh();
    $("spEye").classList.add("on");
    setStats(`👁 预览：距离 ${target}mm · 面 ${shape.faces.length} · 点 ✔ 确认，或 ✖ 放弃`);
  } catch (e) {
    setStats(`预览失败：${(e?.message || e)} · 模型未改动`);
  }
}

/**
 * 应用：反解 → 重放 → **重新测量** → 相等才提交，否则报冲突并保持原样。
 * 失败时一行都不写进 history —— 设置不成功就是彻底没发生。
 */
function applySmartDim() {
  if (!spA || !spB) { setStats("先点两个面"); return; }
  const target = parseFloat($("spVal").value);
  if (!isFinite(target) || target <= 0) { setStats("距离必须是正数"); return; }
  const dSigned = faceDistance(spA, spB);
  // 用户输入的「距离」是大小（恒正），要换算成与当前同号的有符号值再算增量 ——
  // 否则底面这种在基准面负方向的面会被往反方向推，直接穿出零件导致几何退化
  const sgn = Math.sign(dSigned) || 1;
  const d0 = dSigned;
  const targetSigned = target * sgn;
  if (Math.abs(targetSigned - d0) < 1e-6) { setStats(`距离已经是 ${target}mm，没变化`); return; }
  // 优先移动**后点的那个面** —— 直觉是「先点的当基准、后点的动」
  const use = findController(spB)[0] || findController(spA)[0];
  if (!use) {
    // 这两个面没有可调的特征参数（典型情况：**起始零件自带的面**）——
    // 这时改用推拉把后点的那个面直接移到位，而不是直接拒绝
    return applySmartDimByPushPull(targetSigned, d0);
  }
  // 先实测灵敏度，再反解 —— 改 a 侧和改 b 侧的符号是相反的
  const k = distanceSensitivity(use, d0);
  if (k == null) { setStats("尺寸冲突：算不出这个特征的灵敏度 · 设置不成功，模型未改动"); return; }
  const delta = (targetSigned - d0) / k;

  const newOp = { ...history[use.i].op, [use.key]: use.value + delta };
  const t0 = performance.now();
  try {
    const r = rebuild(history, hIndex, { [use.i]: newOp });

    // —— 冲突检测就在这几行：在新模型上重新量一次
    const nA = remapFace(r.shape, spA);
    const nB = remapFace(r.shape, spB);
    if (nA == null || nB == null) {
      setStats(`尺寸冲突：重放后找不到参照面（模型变化太大）· 设置不成功，模型未改动`);
      return;
    }
    const iA = OPS.faceInfo(r.shape, nA);
    const iB = OPS.faceInfo(r.shape, nB);
    const dNew = faceDistance(iA, iB);
    if (Math.abs(Math.abs(dNew) - Math.abs(targetSigned)) > 1e-3) {
      setStats(`尺寸冲突：设定 ${Math.abs(targetSigned)}mm，但受其他特征限制只能到 ` +
        `${Math.abs(dNew).toFixed(2)}mm · 设置不成功，模型未改动`);
      return;
    }

    // —— 校验通过才真正落笔
    history[use.i].op = newOp;
    history[use.i].detail = detailOf(newOp);
    acceptRebuild(r);
    shape = r.shape;
    spPreviewShape = null;
    spPreviewing = false;
    selectedFaceId = null; selSnap = null;
    viewer.clearHighlight();
    refresh();
    renderTree();
    const ms = performance.now() - t0;
    spA = { center: iA.center.slice(), normal: iA.normal.slice(), faceId: nA };
    spB = { center: iB.center.slice(), normal: iB.normal.slice(), faceId: nB };
    $("spEye").classList.remove("on");
    updateSmartPad();
    setStats(`✅ 已设定距离 ${target}mm · 反解到第 ${use.i + 1} 步「${history[use.i].label}」的` +
      `${use.label} ${use.value.toFixed(2)} → ${(use.value + delta).toFixed(2)} · ` +
      `重放 ${r.steps} 步 用时 ${ms.toFixed(0)} ms · 实测距离 ${dNew.toFixed(2)}mm`);
  } catch (e) {
    const msg = (e instanceof RefLost) ? e.message : (e?.message || e);
    setStats(`尺寸冲突：${msg} · 设置不成功，模型未改动`);
  }
}

/**
 * 没有可调特征时的退路：用**推拉**把后点的那个面移到目标距离。
 *
 * 典型场景就是用户说的"初始模型点两个相对的面" —— 起始零件是 base 特征，
 * 没有可调参数，但它的面完全可以推拉。
 * 推拉量用实测灵敏度反解，再验证一次距离是否精确到位。
 */
function applySmartDimByPushPull(targetSigned, d0) {
  const probe = 0.5;
  let k = null;
  try {
    const p1 = OPS.pushPullFace(shape, spB.faceId, probe);
    const a1 = remapFace(p1, spA), b1 = remapFace(p1, spB);
    if (a1 != null && b1 != null) {
      const d1 = faceDistance(OPS.faceInfo(p1, a1), OPS.faceInfo(p1, b1));
      k = (d1 - d0) / probe;
    }
  } catch (_) {}
  if (k == null || Math.abs(k) < 1e-6) {
    setStats("这两个面既没有可调特征、推拉方向也不对（可能平行于面本身），改不了距离");
    return;
  }
  const shift = (targetSigned - d0) / k;
  const t0 = performance.now();
  let next;
  try {
    next = OPS.pushPullFace(shape, spB.faceId, shift);
  } catch (e) {
    setStats("尺寸冲突：推拉这一步做不出来（" + (e?.message || e) + "）· 设置不成功，模型未改动");
    return;
  }
  // 校验：新模型上重新量这两个面
  const nA = remapFace(next, spA), nB = remapFace(next, spB);
  if (nA == null || nB == null) {
    setStats("尺寸冲突：推拉后找不到参照面 · 设置不成功，模型未改动");
    return;
  }
  const iA = OPS.faceInfo(next, nA), iB = OPS.faceInfo(next, nB);
  const dNew = faceDistance(iA, iB);
  if (Math.abs(Math.abs(dNew) - Math.abs(targetSigned)) > 1e-3) {
    setStats(`尺寸冲突：设定 ${Math.abs(targetSigned)}mm，受几何限制只能到 ${Math.abs(dNew).toFixed(2)}mm · 设置不成功，模型未改动`);
    return;
  }
  // 通过 → 记成一条推拉特征
  const faceRef = { center: spB.center.slice(), normal: spB.normal.slice() };
  shape = next;
  spPreviewShape = null; spPreviewing = false;
  refresh();
  commit("推拉", `${shift > 0 ? "+" : ""}${shift.toFixed(1)}mm（智能尺寸）`, "pushpull",
    { type: "pushpull", faceRef, dist: shift });
  spA = { center: iA.center.slice(), normal: iA.normal.slice(), faceId: nA };
  spB = { center: iB.center.slice(), normal: iB.normal.slice(), faceId: nB };
  $("spEye").classList.remove("on");
  updateSmartPad();
  setStats(`✅ 已设定距离 ${Math.abs(targetSigned)}mm（这两个面没有可调特征，改用推拉实现）· ` +
    `推拉 ${shift > 0 ? "+" : ""}${shift.toFixed(2)}mm · 用时 ${(performance.now() - t0).toFixed(0)} ms · 实测距离 ${dNew.toFixed(2)}mm`);
}

function cancelSmartDim() {
  if (spPreviewing && spPreviewShape) {
    shape = spPreviewShape;
    viewer.clearHighlight();
    refresh();
  }
  spPreviewShape = null;
  spPreviewing = false;
  spA = null; spB = null;
  $("spVal").value = "";
  $("spEye").classList.remove("on");
  viewer.clearHighlight();
  // 点 ✖ 是"关掉这个面板"，不只是放弃数值 —— 之前只清了状态没退模式，
  // 面板一直挂在那里关不掉
  exitSmartDimMode();
  setStats("已退出智能尺寸");
}

$("spOk").onclick = () => applySmartDim();
$("spEye").onclick = () => previewSmartDim();
$("spX").onclick = () => cancelSmartDim();
$("spVal").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); applySmartDim(); } };

/** 按当前面的轴线、位置和特征来源找参数，同半径不能证明是同一个圆。 */
function findCurvedDriver() {
  if (!shape || selectedFaceId == null) return [];
  return findSurfaceDrivers({ history, hIndex, shape, faceId: selectedFaceId });
}

// ---------------------------------------------------------------- 曲面尺寸（点圆柱/圆角/倒角面 → 径向手柄）
let faceClass = null;        // 当前选中面的类型（plane / cylinder / torus / cone）
let curvedDriver = null;     // 曲面尺寸由哪个特征驱动

/** 求"径向"方向：从轴指向面上这个点 */
function radialDir(cls, point) {
  if (!cls?.axis || !cls?.axisPoint) return null;
  const d = [point[0] - cls.axisPoint[0], point[1] - cls.axisPoint[1], point[2] - cls.axisPoint[2]];
  const along = d[0] * cls.axis[0] + d[1] * cls.axis[1] + d[2] * cls.axis[2];
  const perp = [d[0] - along * cls.axis[0], d[1] - along * cls.axis[1], d[2] - along * cls.axis[2]];
  const L = Math.hypot(perp[0], perp[1], perp[2]);
  return L < 1e-6 ? null : [perp[0] / L, perp[1] / L, perp[2] / L];
}

/** 曲面上该显示什么尺寸：圆柱给直径，圆角给半径，倒角给距离 */
function curvedDimSpec() {
  if (!curvedDriver || !faceClass) return null;
  const d = curvedDriver;
  const cyl = faceClass.kind === "cylinder" && ["sketchCircle", "baseHole"].includes(d.kind);
  if (["sketchCircle", "baseHole"].includes(d.kind)) {
    return { value: d.value, prefix: cyl ? "Ø" : "R", kind: cyl ? (d.kind === "baseHole" || faceClass.polarity < 0 ? "圆孔直径" : "圆柱直径") : "半径" };
  }
  if (d.kind === "fillet") return { value: d.value, prefix: "R", kind: "圆角半径" };
  if (d.kind === "chamfer") return { value: d.value, prefix: "C", kind: "倒角距离" };
  return null;
}

function showCurvedDim() {
  if (!dim || !curvedDriver || !selSnap || !faceClass) return;
  const spec = curvedDimSpec();
  if (!spec) return;
  // 圆柱面：手柄沿径向、数值按直径显示；圆角/倒角：沿径向、按半径/距离
  const rd = radialDir(faceClass, selSnap.center);
  // 圆柱面按直径显示，圆角/倒角按半径/距离。
  // 判据用驱动特征的种类，而不是面的几何类型 ——
  // 圆角面在几何上也是圆柱片段，靠 torus/cone 区分不可靠。
  const isCyl = faceClass.kind === "cylinder" && ["sketchCircle", "baseHole"].includes(curvedDriver.kind);
  dim.show({
    anchor: new THREE.Vector3(selSnap.center[0], selSnap.center[1], selSnap.center[2]),
    dir: new THREE.Vector3(...(rd || selSnap.normal)),
    value: isCyl ? spec.value * 2 : spec.value,
    prefix: isCyl ? "Ø" : spec.prefix,
    unit: "",
    min: 0.2,
    max: curvedDriver.kind === "baseHole" ? 39.8 : 400,
  });
  viewer.invalidate();
}

/** 预览与提交共用同一参数定义；只返回候选，不修改历史。 */
function curvedDimOperation(v) {
  const drv = curvedDriver;
  const spec = curvedDimSpec();
  if (!drv || !spec || !history[drv.i]?.op || drv.i > hIndex || history[drv.i].suppressed) {
    throw new Error("尺寸来源已失效，请重新选择曲面");
  }
  const isCyl = faceClass?.kind === "cylinder" && ["sketchCircle", "baseHole"].includes(drv.kind);
  const newValue = isCyl ? v / 2 : v;          // 圆柱的界面值按直径，特征里存半径
  if (!Number.isFinite(newValue) || newValue <= 0) throw new Error("尺寸必须是正数");
  // 草图圆、起始底板孔和修饰特征分别更新各自的参数。
  //   sketchCircle → 圆柱来自草图里的圆，要改 entities[sub].r（不是 op 顶层）
  //   fillet/chamfer → 改 op.radius
  let newOp;
  if (drv.kind === "sketchCircle") {
    if (history[drv.i].op.entities?.[drv.sub]?.kind !== "circle") throw new Error("驱动圆已失效，请重新选择曲面");
    const ents = (history[drv.i].op.entities || []).map((e, k) =>
      k === drv.sub ? { ...e, r: newValue } : e);
    const constraints = (history[drv.i].op.constraints || []).map((c) =>
      c.type === "fixed" && c.e === drv.sub && c.k === "r" ? { ...c, value: newValue } : c);
    newOp = { ...history[drv.i].op, entities: ents, constraints };
  } else {
    newOp = { ...history[drv.i].op, [drv.key]: newValue };
  }
  if (drv.kind === "sketchCircle") {
    const checked = JSON.parse(JSON.stringify(newOp.entities));
    const solved = solveSketch(checked, newOp.constraints || []);
    if (!solved.ok || Math.abs(checked[drv.sub].r - newValue) > 1e-5) {
      throw new Error("这个半径与草图的其他约束冲突，请先调整草图约束");
    }
  }
  return { drv, spec, isCyl, newOp };
}

/** 径向手柄预览必须改驱动特征，不能把绝对直径当成面的推拉增量。 */
function previewCurvedDim(v) {
  const previous = shape;
  let result = null;
  try {
    const { drv, spec, newOp } = curvedDimOperation(v);
    result = rebuildPreview(history, hIndex, { [drv.i]: newOp });
    const volume = result.shape ? OPS.volumeOf(result.shape) : 0;
    if (!Number.isFinite(volume) || volume <= 1e-6) throw new Error("这个尺寸无法生成有效实体");
    shape = result.shape;
    // 只替换显示，不回填历史快照；粗网格失败时再尝试正常精度。
    if (!refresh({ coarse: true }) && !refresh()) throw new Error("无法生成预览网格");
    discardCurvedPreview();
    curvedPreviewResult = result;
    setStats(`${spec.kind} ${v.toFixed(2)} mm · 预览中，松手应用`);
  } catch (e) {
    shape = previous;
    result?.dispose();
    setStats(`尺寸预览失败：${e?.message || e} · 保留上一个有效预览，松手无法应用时恢复原模型`);
  }
}

function discardCurvedPreview() {
  curvedPreviewResult?.dispose();
  curvedPreviewResult = null;
}

/** 松手或输入数值时才更新特征定义与下游快照。 */
function commitCurvedDim(v) {
  if (!curvedDriver) return;
  const original = shape;
  const originalSpec = curvedDimSpec();
  const originalValue = faceClass?.kind === "cylinder" && ["sketchCircle", "baseHole"].includes(curvedDriver.kind)
    ? originalSpec?.value * 2 : originalSpec?.value;
  const t0 = performance.now();
  try {
    const { drv, spec, isCyl, newOp } = curvedDimOperation(v);
    const r = rebuild(history, hIndex, { [drv.i]: newOp });
    history[drv.i].op = newOp;
    history[drv.i].detail = detailOf(newOp);
    acceptRebuild(r);
    shape = r.shape;
    selectedFaceId = null; selSnap = null; faceClass = null; curvedDriver = null;
    dim?.hide();
    viewer.clearHighlight();
    refresh();
    renderTree();
    setStats(`已把${spec.kind}改成 ${v.toFixed(2)}${isCyl ? "（直径）" : ""} · ` +
      `重放 ${r.steps} 步 用时 ${(performance.now() - t0).toFixed(0)} ms · 面 ${shape.faces.length}`);
  } catch (e) {
    shape = original;
    refresh();
    if (Number.isFinite(originalValue)) dim?.update(originalValue);
    const msg = (e instanceof RefLost) ? e.message : (e?.message || e);
    setStats(`改不了：${msg} · 模型未改动`);
  }
}

// ---------------------------------------------------------------- 拉伸轮廓点选
/*
 * 草图里有多个闭合轮廓时，SolidWorks 允许点选其中几个再拉伸。
 * 这里每个草图实体就是一个轮廓（矩形/圆/自由折线各算一个），
 * 点一下切换选中，选中的用黄色画出来；一个都不选 = 全部拉伸。
 */
let contourPicking = false;

function setContourPicking(on) {
  contourPicking = !!on;
  const btn = document.querySelector('#extrude [data-eact=contour]');
  if (btn) btn.classList.toggle("on", contourPicking);
  redrawSketch();
  const n = sketch ? sketch.contourCount : 0;
  const total = sketch ? sketch.entities.length : 0;
  $("extrContours").textContent = (sketch && sketch.selected.length)
    ? `已选 ${n} / ${total} 个轮廓`
    : `全部 ${total} 个轮廓`;
  setStats(contourPicking
    ? "点选轮廓：点草图上的某个轮廓切换选中（黄色 = 会参与拉伸）"
    : (sketch && sketch.selected.length ? `只拉伸选中的 ${n} 个轮廓` : "全部轮廓都会拉伸"));
}

function contourPick(p2d) {
  if (!sketch) return;
  const hit = sketch.pickEntity([p2d.x, p2d.y], 6);
  if (!hit) { sketch.toggleContour(null); setContourPicking(contourPicking); return; }
  sketch.toggleContour(hit.index);
  setContourPicking(contourPicking);
  // 顺便按当前深度刷新线框预览，让用户马上看到"只拉这个"
  const v = parseFloat($("extrDist").value);
  if (isFinite(v) && v > 0) previewExtrude(v);
}

// ---------------------------------------------------------------- 参考几何体（基准面/基准轴/点/坐标系）
/*
 * 仿 SolidWorks 的「参考几何体」。价值最大的是**偏移基准面**：
 *   - 可以在任意高度/位置画草图（放样的截面要在不同高度，靠它）
 *   - 不依赖任何已有实体表面
 * 定义存成纯数据（refGeoms），能进工程文件、能重建显示。
 */
let refGeoms = [];          // { type, name, ... }
let rgMode = "plane";       // plane | axis | point | csys
let rgSeq = { plane: 0, axis: 0, point: 0, csys: 0 };

const RG_BASE = {
  XY: { normal: [0, 0, 1], xDir: [1, 0, 0] },
  XZ: { normal: [0, -1, 0], xDir: [1, 0, 0] },
  YZ: { normal: [1, 0, 0], xDir: [0, 1, 0] },
};

function enterRefGeom() {
  datum?.setVisible(true);
  $("refgPad").classList.remove("hidden");
  $("rgClose").onclick = () => { $("refgPad").classList.add("hidden"); setStats("已关闭参考几何体面板"); };
  $("rgClear").onclick = () => {
    refGeoms = [];
    rgSeq = { plane: 0, axis: 0, point: 0, csys: 0 };
    rebuildRefGeoms();
    setStats("已清空全部参考几何体");
  };
  renderRgPad();
  setStats("参考几何体 · 创建后可以直接点它来画草图（基准面也能当草图平面）");
}

/** 按 refGeoms 重建 3D 显示 */
function rebuildRefGeoms() {
  if (!datum) return;
  datum.clearCustom();
  for (const d of refGeoms) datum.add(d);
  datum.setVisible(true);
  renderRgPad();
}

function renderRgPad() {
  const form = $("rgForm");
  if (!form) return;
  for (const b of $("refgPad").querySelectorAll("[data-rg]")) {
    b.classList.toggle("on", b.dataset.rg === rgMode);
    b.onclick = () => { rgMode = b.dataset.rg; renderRgPad(); };
  }
  $("rgInfo").textContent = `已建 ${refGeoms.length} 个`;
  if (rgMode === "plane") {
    form.innerHTML = `
      <div class="xf-row"><span>基于</span>
        <select id="rgBase"><option value="XY">XY 平面（水平）</option><option value="XZ">XZ 平面</option><option value="YZ">YZ 平面</option></select></div>
      <div class="xf-row"><span>偏移</span><input id="rgOff" type="number" step="5" value="20"><span class="muted">mm</span></div>
      <div class="xf-row"><button id="rgGo" class="primary">创建基准面</button></div>`;
  } else if (rgMode === "axis") {
    form.innerHTML = `
      <div class="xf-row"><span>方向</span>
        <select id="rgDir"><option value="X">X 向</option><option value="Y">Y 向</option><option value="Z">Z 向</option></select></div>
      <div class="xf-row"><span>过点 x/y/z</span>
        <input id="rgAx" type="number" step="5" value="0">
        <input id="rgAy" type="number" step="5" value="0">
        <input id="rgAz" type="number" step="5" value="0"></div>
      <div class="xf-row"><button id="rgGo" class="primary">创建基准轴</button></div>`;
  } else if (rgMode === "point") {
    form.innerHTML = `
      <div class="xf-row"><span>坐标 x/y/z</span>
        <input id="rgPx" type="number" step="5" value="0">
        <input id="rgPy" type="number" step="5" value="0">
        <input id="rgPz" type="number" step="5" value="0"></div>
      <div class="xf-row"><span>或取</span>
        <select id="rgPick"><option value="none">手动输入</option><option value="bboxMin">模型最小角点</option><option value="bboxMax">模型最大角点</option><option value="bboxCenter">模型中心</option></select></div>
      <div class="xf-row"><button id="rgGo" class="primary">创建点</button></div>`;
  } else {
    form.innerHTML = `
      <div class="xf-row"><span>原点 x/y/z</span>
        <input id="rgCx" type="number" step="5" value="0">
        <input id="rgCy" type="number" step="5" value="0">
        <input id="rgCz" type="number" step="5" value="0"></div>
      <div class="xf-row"><button id="rgGo" class="primary">创建坐标系</button></div>`;
  }
  const go = form.querySelector("#rgGo");
  if (go) go.onclick = addRefGeom;
  $("rgList").textContent = refGeoms.length
    ? refGeoms.map((d, i) => `${i + 1}.${d.name}`).join("  ")
    : "还没有参考几何体";
}

/** 按当前面板创建 */
function addRefGeom() {
  const num = (id, dflt = 0) => {
    const el = $(id);
    const v = el ? parseFloat(el.value) : NaN;
    return isFinite(v) ? v : dflt;
  };
  let def = null;
  if (rgMode === "plane") {
    const baseName = $("rgBase").value;
    const off = num("rgOff", 0);
    const b = RG_BASE[baseName];
    rgSeq.plane++;
    def = {
      type: "plane",
      name: `基准面${rgSeq.plane}`,
      base: baseName,
      offset: off,
      origin: b.normal.map((v) => v * off),
      normal: [...b.normal],
      xDir: [...b.xDir],
    };
  } else if (rgMode === "axis") {
    rgSeq.axis++;
    const dirName = $("rgDir").value;
    const dir = dirName === "X" ? [1, 0, 0] : dirName === "Y" ? [0, 1, 0] : [0, 0, 1];
    def = {
      type: "axis",
      name: `基准轴${rgSeq.axis}`,
      origin: [num("rgAx"), num("rgAy"), num("rgAz")],
      dir,
      length: 120,
    };
  } else if (rgMode === "point") {
    rgSeq.point++;
    let p = [num("rgPx"), num("rgPy"), num("rgPz")];
    const how = $("rgPick") ? $("rgPick").value : "none";
    if (how !== "none" && shape) {
      try {
        const bb = shape.boundingBox;
        const c = bb.center;
        if (how === "bboxCenter") p = [c[0], c[1], c[2]];
        else if (how === "bboxMin") p = [c[0] - bb.width / 2, c[1] - bb.height / 2, c[2] - bb.depth / 2];
        else p = [c[0] + bb.width / 2, c[1] + bb.height / 2, c[2] + bb.depth / 2];
      } catch (_) {}
    }
    def = { type: "point", name: `点${rgSeq.point}`, p };
  } else {
    rgSeq.csys++;
    def = {
      type: "csys",
      name: `坐标系${rgSeq.csys}`,
      origin: [num("rgCx"), num("rgCy"), num("rgCz")],
      length: 20,
    };
  }
  if (!def) return;
  refGeoms.push(def);
  rebuildRefGeoms();
  setStats(`已创建 ${def.name}` + (def.offset !== undefined ? `（${def.base} 偏移 ${def.offset}mm）` : "")
    + " · 点它就能当成草图平面用");
}

// ---------------------------------------------------------------- 实体变换（移动/旋转整个模型）
/**
 * 移动/旋转**整个模型**。和特征级的变换是两回事：
 *   - 特征级（阵列/镜像）：复制"某个特征长出来的材料"
 *   - 实体级（这里）：把整个零件挪走 / 转个方向 —— 装配、摆正、对称摆放用
 * replicad 的 rotate/translate 会消费原对象，所以先 clone。
 */
function enterMoveMode() {
  setMode("select");
  $("movePad").classList.remove("hidden");
  try {
    const bb = shape.boundingBox;
    $("mvInfo").textContent = `模型 ${bb.width.toFixed(1)}×${bb.height.toFixed(1)}×${bb.depth.toFixed(1)} mm`;
  } catch (_) { $("mvInfo").textContent = ""; }
  $("mvGo").onclick = applyMove;
  $("mvClose").onclick = () => { $("movePad").classList.add("hidden"); setStats("已关闭移动面板"); };
  setStats("移动/旋转 · 填好增量后点「应用」；旋转是以模型中心或坐标原点为支点");
}

function applyMove() {
  if (!shape) return;
  const dx = parseFloat($("mvDx").value) || 0;
  const dy = parseFloat($("mvDy").value) || 0;
  const dz = parseFloat($("mvDz").value) || 0;
  const rot = parseFloat($("mvRot").value) || 0;
  const axisName = $("mvAxis").value;
  const pivotMode = $("mvPivot").value;
  if (!dx && !dy && !dz && !rot) { setStats("什么都没改 · 填个增量再点应用"); return; }
  let pivot = [0, 0, 0];
  if (pivotMode === "center") {
    try { const c = shape.boundingBox.center; pivot = [c[0], c[1], c[2]]; } catch (_) {}
  }
  const axisDir = axisName === "X" ? [1, 0, 0] : axisName === "Y" ? [0, 1, 0] : [0, 0, 1];
  const t0 = performance.now();
  let ns = null;
  try {
    ns = shape.clone();
    if (rot) ns = ns.rotate(rot, pivot, axisDir);
    if (dx || dy || dz) ns = ns.translate(dx, dy, dz);
  } catch (e) {
    setStats("移动失败：" + (e?.message || e));
    return;
  }
  const ms = performance.now() - t0;
  const op = { type: "move3d", dx, dy, dz, rot, axis: axisName, pivot: pivotMode };
  shape = ns;
  commit("移动", `Δ(${dx.toFixed(1)},${dy.toFixed(1)},${dz.toFixed(1)})${rot ? ` 转${rot.toFixed(0)}°` : ""}`, "move3d", op);
  setStats(`已移动 Δ(${dx.toFixed(1)}, ${dy.toFixed(1)}, ${dz.toFixed(1)})${rot ? ` · 绕 ${axisName} 轴旋转 ${rot.toFixed(0)}°` : ""} · 用时 ${ms.toFixed(0)} ms`);
  $("mvDx").value = "0"; $("mvDy").value = "0"; $("mvDz").value = "0"; $("mvRot").value = "0";
}

// ---------------------------------------------------------------- 草图变换（移动/镜像/阵列）
/*
 * 草图层面比实体层面更常用：画一排孔通常是"画一个 → 阵列"，而不是"拉伸一个 → 阵列"。
 * 三个操作都作用在**点选的图元**上；一个都不点就作用在全部图元上（最省事的默认）。
 */
let xfMode = null;        // "move" | "mirror" | "array"
let xfSel = [];           // 选中的图元下标

function xfReset() { xfSel = []; }

/** 实际要作用的图元下标：点过就用点过的，没点就全部 */
function xfTargets() {
  if (xfSel.length) return [...xfSel];
  return sketch ? sketch.entities.map((_, i) => i) : [];
}

function enterXform() {
  xfMode = "move";
  xfReset();
  $("xformPad").classList.remove("hidden");
  const cl = $("xfClose");
  if (cl) cl.onclick = () => { exitXform(); setStats("已关闭变换面板"); };
  renderXformPad();
  setStats("变换 · 先点选要动的图元（不点则作用于全部），再在面板里设置");
}

function exitXform() {
  xfMode = null;
  xfReset();
  const p = $("xformPad");
  if (p) p.classList.add("hidden");
  if (sketch) highlightElements([]);
}

/** 变换模式下点一下：选/取消选图元 */
function xformPickPoint(p2d) {
  if (!sketch) return;
  const sc = sketchScale();
  // 用元素级拾取，但把"线"归到它所属的图元下标上
  const el = ELEM.pickElementAt(sketch, p2d, sc > 0.01 ? 28 / sc : 2.5);
  if (!el) { setStats("这里没有图元 · 点轮廓来选中它"); return; }
  const idx = el.e;
  const at = xfSel.indexOf(idx);
  if (at >= 0) xfSel.splice(at, 1);
  else xfSel.push(idx);
  // 高亮整个图元（不是单条边）—— 变换是整块动的
  const lines = [];
  // 同样要转世界坐标
  const push = (a, b) => lines.push(sketch.toWorld2(a), sketch.toWorld2(b));
  for (const i of xfSel) {
    const g = sketch.entities[i];
    if (!g) continue;
    const pl = sketch._toPolyline(g);
    const P = pl.pts || [];
    const n = pl.closed ? P.length : P.length - 1;
    for (let k = 0; k < n; k++) push(P[k], P[(k + 1) % P.length]);
  }
  viewer.setPreviewWire(lines.length ? new Float32Array(lines.flat()) : null);
  setStats(xfSel.length
    ? `已选 ${xfSel.length} 个图元（共 ${sketch.entities.length} 个）· 不选则作用于全部`
    : `已清空选择 · 将作用于全部 ${sketch.entities.length} 个图元`);
  renderXformPad();
}

/** 渲染面板：三个模式页签 + 对应的参数 */
function renderXformPad() {
  const box = $("xfBody");
  if (!box) return;
  const n = xfSel.length || (sketch ? sketch.entities.length : 0);
  $("xfInfo").textContent = `作用 ${n} 个图元`;
  const bb = sketch ? sketch.boundsOf(xfTargets()) : null;
  const w = bb ? bb.maxX - bb.minX : 20;
  const h = bb ? bb.maxY - bb.minY : 20;
  box.innerHTML = `
    <div class="xf-tabs">
      <button data-xf="move" class="${xfMode === "move" ? "on" : ""}">移动</button>
      <button data-xf="mirror" class="${xfMode === "mirror" ? "on" : ""}">镜像</button>
      <button data-xf="array" class="${xfMode === "array" ? "on" : ""}">阵列</button>
    </div>
    <div id="xfForm"></div>`;
  for (const b of box.querySelectorAll("[data-xf]")) {
    b.onclick = () => { xfMode = b.dataset.xf; renderXformPad(); };
  }
  const form = box.querySelector("#xfForm");
  if (xfMode === "move") {
    form.innerHTML = `
      <div class="xf-row"><span>横向 Δx</span><input id="xfDx" type="number" step="1" value="10"><span class="muted">mm</span></div>
      <div class="xf-row"><span>纵向 Δy</span><input id="xfDy" type="number" step="1" value="0"><span class="muted">mm</span></div>
      <div class="xf-row"><span>旋转</span><input id="xfRot" type="number" step="15" value="0"><span class="muted">°</span></div>
      <div class="xf-row"><button id="xfGo" class="primary">应用变换</button></div>`;
  } else if (xfMode === "mirror") {
    form.innerHTML = `
      <div class="xf-row"><span>镜像轴</span>
        <select id="xfAxis">
          <option value="v0">竖直线 x=0</option>
          <option value="h0">水平线 y=0</option>
          <option value="vEdge">草图左边</option>
          <option value="hEdge">草图下边</option>
        </select></div>
      <div class="xf-row"><span>保留原件</span><input id="xfKeep" type="checkbox" checked></div>
      <div class="xf-row"><button id="xfGo" class="primary">应用镜像</button></div>`;
  } else {
    form.innerHTML = `
      <div class="xf-row"><span>类型</span>
        <select id="xfKind"><option value="rect">矩形阵列</option><option value="polar">圆周阵列</option></select></div>
      <div class="xf-row"><span>行 / 份数</span><input id="xfRows" type="number" step="1" value="1"></div>
      <div class="xf-row"><span>列</span><input id="xfCols" type="number" step="1" value="4"></div>
      <div class="xf-row"><span>间距</span><input id="xfStep" type="number" step="1" value="${Math.max(5, +(w * 1.5).toFixed(1))}"></div>
      <div class="xf-row"><button id="xfGo" class="primary">应用阵列</button></div>`;
  }
  const go = form.querySelector("#xfGo");
  if (go) go.onclick = applyXform;
}

/** 执行当前变换 */
function applyXform() {
  if (!sketch || !xfMode) return;
  const idx = xfTargets();
  if (!idx.length) { setStats("没有可变换的图元"); return; }
  const before = JSON.parse(JSON.stringify(sketch.entities));
  let msg = "";
  try {
    if (xfMode === "move") {
      const dx = parseFloat($("xfDx").value) || 0;
      const dy = parseFloat($("xfDy").value) || 0;
      const rot = parseFloat($("xfRot").value) || 0;
      const bb = sketch.boundsOf(idx) || { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
      if (rot) sketch.rotateEntities(idx, rot, cx, cy);
      if (dx || dy) sketch.translateEntities(idx, dx, dy);
      msg = `已移动 Δ(${dx.toFixed(1)}, ${dy.toFixed(1)})${rot ? ` 并旋转 ${rot}°` : ""} · ${idx.length} 个图元`;
    } else if (xfMode === "mirror") {
      const bb = sketch.boundsOf(idx) || { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      const all = sketch.bounds2D || bb;
      const ax = $("xfAxis").value;
      let line;
      if (ax === "v0") line = [[0, -1e3], [0, 1e3]];
      else if (ax === "h0") line = [[-1e3, 0], [1e3, 0]];
      else if (ax === "vEdge") line = [[all.minX, -1e3], [all.minX, 1e3]];
      else line = [[-1e3, all.minY], [1e3, all.minY]];
      const keep = $("xfKeep").checked;
      const made = sketch.mirrorEntities(idx, line, keep);
      msg = `已镜像生成 ${made} 个图元${keep ? "（原件保留）" : "（原件已删）"}`;
    } else {
      const kind = $("xfKind").value;
      const rows = Math.max(1, Math.round(parseFloat($("xfRows").value) || 1));
      const cols = Math.max(1, Math.round(parseFloat($("xfCols").value) || 1));
      const step = parseFloat($("xfStep").value) || 10;
      if (kind === "rect") {
        const made = sketch.arrayRect(idx, rows, cols, step, step);
        msg = `矩形阵列 ${rows}×${cols} · 新增 ${made} 个图元`;
      } else {
        // 圆周：绕草图包围盒中心
        const all = sketch.bounds2D || { minX: 0, minY: 0, maxX: 0, maxY: 0 };
        const cx = (all.minX + all.maxX) / 2, cy = (all.minY + all.maxY) / 2;
        const made = sketch.arrayPolar(idx, rows, cx, cy, true);
        msg = `圆周阵列 ${rows} 份（绕草图中心）· 新增 ${made} 个图元`;
      }
    }
  } catch (e) {
    sketch.entities = before;
    setStats("变换失败：" + (e?.message || e));
    return;
  }
  setStats(msg + ` · 草图现在有 ${sketch.entities.length} 个图元`);
  redrawSketch();
  xfReset();
  renderXformPad();
}

/**
 * 从一个**约束定义**反推「从动标注的测量定义」。
 *
 * 为什么不从 smartSpec.display 反推：display 是**当时的坐标快照**，
 * 几何一变就过期 —— 而从动尺寸的整个意义就在于"值跟着几何走"。
 * spec 里存的是引用（{e,p} / 常量点 / 引用线端点），才是权威来源。
 */
function measureFromSpec(spec) {
  if (!spec) return null;
  const isConstPt = (x) => Array.isArray(x) && x.length === 2 && typeof x[0] === "number";
  switch (spec.type) {
    case "fixed":
      return spec.k === "r" ? { kind: "diameter", e: spec.e } : null;
    case "distance":
      return (spec.a && spec.b) ? { kind: "dist2pt", a: spec.a, b: spec.b } : null;
    case "distToFixedLine":
      return { kind: "dist2line", a: spec.p, line: spec.line };
    case "distToFixedPoint":
      return { kind: "dist2pt", a: spec.p, b: { e: null, at: spec.at } };
    case "pointToLine":
      return (isConstPt(spec.l1) && isConstPt(spec.l2))
        ? { kind: "dist2line", a: spec.p, line: [spec.l1, spec.l2] } : null;
    case "angleToFixedLine":
      return { kind: "angle2line", l: spec.l, ref: spec.ref };
    default:
      return null;
  }
}

/**
 * 创建一个**从动标注**（driven / reference dimension）。
 *
 * 要点：
 *   - 不进 `sketch.constraints` → **不参与求解**、不增加方程
 *   - 存的是**测量定义**（测什么），绘制时用 evalMeasure 现算 → 值随几何更新
 *   - 随特征进工程文件（commit 时把 dimNotes 一并存进 op）
 */
function addDrivenDim(measure, label) {
  if (!sketch) return false;
  if (!measure) { setStats("这个标注暂时不能设为从动尺寸（缺少可跟踪的测量对象）"); return false; }
  if (!ELEM.evalMeasure(sketch, measure)) { setStats("这个标注暂时不能设为从动尺寸（测量对象取不到）"); return false; }
  sketch.dimNotes = sketch.dimNotes || [];
  sketch.dimNotes.push({ measure, label: label || "参考尺寸" });
  setStats(`${label || "参考尺寸"} · 已设为从动尺寸（只显示测量值、随几何更新、不参与求解）`);
  smartDimReset();
  smartDimHighlight();
  redrawSketch();
  return true;
}

// ---------------------------------------------------------------- 视图浮层：坐标系指示器 / 比例尺 / 平面模式 / 网格
/*
 * 平面模式（草图模式自动进入）：
 *   单指拖动 = 平移视图，**不再旋转** —— 画图时手指落在画布上不会把视角转跑。
 *   这是平板做 2D 草图的刚需：平面 CAD 的默认手感。
 * 坐标系指示器与比例尺仿 Fusion 360 的右下角样式。
 */
let planarMode = false;
let gridGroup = null;

function setPlanarMode(on, silent = false) {
  planarMode = !!on;
  viewer?.cam?.setPlanar(planarMode);
  const btn = $("modeToggle");
  if (btn) {
    btn.classList.toggle("planar", planarMode);
    btn.textContent = planarMode ? "平面" : "3D";
  }
  drawSketchGrid();
  if (!silent) {
    setStats(planarMode
      ? "平面模式：单指平移视图、双指缩放；绘图时视角不会被转跑"
      : "3D 模式：单指环绕旋转、双指缩放平移");
  }
  updateAxisGizmo();
}

function togglePlanarMode() { setPlanarMode(!planarMode); }

/** 把世界 X/Y/Z 投影到屏幕，画右下角的小坐标系 */
function updateAxisGizmo() {
  const svg = $("axisGizmo");
  if (!svg) return;
  const cam = viewer?.camera;
  if (!cam) return;
  cam.updateMatrixWorld();
  const m = cam.matrixWorldInverse.elements;
  const W = 96, H = 96;
  const cx = W / 2, cy = H / 2, R = W * 0.30;
  const axes = [
    { v: [1, 0, 0], c: "#cb4e50", l: "X" },
    { v: [0, 1, 0], c: "#278454", l: "Y" },
    { v: [0, 0, 1], c: "#3575bd", l: "Z" },
  ];
  const items = [];
  for (const a of axes) {
    const [x, y, z] = a.v;
    const vx = m[0] * x + m[4] * y + m[8] * z;
    const vy = m[1] * x + m[5] * y + m[9] * z;
    const vz = m[2] * x + m[6] * y + m[10] * z;
    items.push({ ...a, sx: vx, sy: -vy, sz: vz });
  }
  items.sort((p, q) => p.sz - q.sz);      // 远的先画，近的盖住远的
  let out = "";
  for (const it of items) {
    const ex = cx + it.sx * R, ey = cy + it.sy * R;
    out += `<line x1="${cx}" y1="${cy}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="${it.c}" stroke-width="2.5" stroke-linecap="round"/>`;
    out += `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="9" fill="${it.c}"/>`;
    out += `<text x="${ex.toFixed(1)}" y="${(ey + 4).toFixed(1)}" text-anchor="middle" fill="#fff" stroke="none">${it.l}</text>`;
  }
  svg.innerHTML = out;
}

/** 比例尺：告诉用户屏幕上这段是多长（平面 CAD 里靠它估尺寸） */
function updateScaleBar() {
  const el = $("sbText"), bar = $("sbBar");
  if (!el || !bar || !viewer?.cam || !canvas) return;
  const H = canvas.clientHeight || 1;
  const cam = viewer.camera;
  const worldH = 2 * viewer.cam.dist * Math.tan(((cam.fov * Math.PI) / 180) / 2);
  const mmPerPx = worldH / H;
  if (!isFinite(mmPerPx) || mmPerPx <= 0) return;
  const targetPx = 80;
  const raw = mmPerPx * targetPx;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const nice = [1, 2, 5, 10].map((k) => k * mag).find((v) => v >= raw) || 10 * mag;
  const px = nice / mmPerPx;
  el.textContent = nice >= 1 ? `${nice.toFixed(0)} mm` : `${(nice * 1000).toFixed(0)} µm`;
  bar.style.width = `${Math.max(18, Math.min(150, px)).toFixed(1)}px`;
}

/**
 * 草图平面上的网格：平面模式 + 进了草图才画。
 * 网格是**草图平面上的辅助线**（10mm 主格 / 2mm 次格），不参与任何几何运算。
 */
/** 网格依赖的相机量：缩放档位 + 视野中心（量化到次格），变了才重建 */
function gridSig() {
  if (!viewer?.cam || !sketch) return "";
  const H = canvas?.clientHeight || 800;
  const mmPerPx = (2 * viewer.cam.dist * Math.tan((viewer.camera.fov * Math.PI / 180) / 2)) / H;
  const t = viewer.cam.target;
  const q = mmPerPx * 40;   // 视野中心每移动约 40px 重建一次（网格有 1.6× 余量，不会露边）
  return `${Math.round(Math.log10(mmPerPx) * 20)}|${Math.round(t.x / q)},${Math.round(t.y / q)},${Math.round(t.z / q)}|${canvas?.clientWidth}x${H}`;
}

function drawSketchGrid() {
  if (!viewer?.scene) return;
  if (!gridGroup) {
    gridGroup = new THREE.Group();
    gridGroup.renderOrder = 2;
    viewer.scene.add(gridGroup);
  }
  // 清掉旧的
  while (gridGroup.children.length) {
    const c = gridGroup.children.pop();
    try { gridGroup.remove(c); c.geometry?.dispose?.(); c.material?.dispose?.(); } catch (_) {}
  }
  // 草图平面网格（世界坐标，跟相机走）出现时，#view 的 CSS 屏幕方格（28px，固定在屏幕上）必须让位，
  // 否则两层网格叠在一起：一层随拖动/缩放动、一层死的（用户反馈 v5.1.4）。见 workspace-ui.css .sketch-grid-on
  document.body.classList.toggle("sketch-grid-on", !!(planarMode && sketch));
  if (!planarMode || !sketch) { gridGroup.visible = false; viewer.invalidate(); return; }
  gridGroup.visible = true;

  const O = sketch.origin, X = sketch.xDir, Y = sketch.yDir;
  // 格距随缩放自适应（屏幕上次格 ≈ 14–35px），范围随视野中心走、始终铺满屏幕：
  // 以前固定 ±60mm / 2mm 次格，平移出去或缩小后网格有硬边界（截图左侧 x≈204 处截断）。
  const H = canvas?.clientHeight || 800, Wd = canvas?.clientWidth || 1200;
  const mmPerPx = (2 * viewer.cam.dist * Math.tan((viewer.camera.fov * Math.PI / 180) / 2)) / H;
  const rawSmall = mmPerPx * 14;
  const mag = Math.pow(10, Math.floor(Math.log10(rawSmall)));
  const small = [1, 2, 5, 10].map((k) => k * mag).find((v) => v >= rawSmall - 1e-12) || 10 * mag;
  const step = Math.round(small / mag);              // 1 / 2 / 5 / 10
  const big = small * (step === 5 ? 2 : 5);   // 主格 = 次格×5（1→5、2→10、10→50）或 ×2（5→10），都落在 1/5/10 系列上
  const halfW = (Math.hypot(Wd, H) / 2) * mmPerPx * 1.6;   // 对角线一半 × 余量（平面视图有轻微透视）
  const tgt = viewer.cam.target || O;
  const tu = tgt.clone().sub(O).dot(X), tv = tgt.clone().sub(O).dot(Y);
  const i0 = Math.floor((tu - halfW) / small), i1 = Math.ceil((tu + halfW) / small);
  const j0 = Math.floor((tv - halfW) / small), j1 = Math.ceil((tv + halfW) / small);
  // 先记签名再判范围：否则异常相机参数下 return，签名永为旧值 → 120ms 的 tick 会反复清空重建空网格。
  gridGroup.userData.sig = gridSig();
  if ((i1 - i0) + (j1 - j0) > 1200) return;   // 保护：异常相机参数下别画几万条线
  // 一条 LineSegments 一种样式，避免每根线一个 draw call
  const buckets = { axis: [], big: [], small: [] };
  const P = (u, v) => O.clone().addScaledVector(X, u).addScaledVector(Y, v);
  const seg = (arr, a, c) => arr.push(a.x, a.y, a.z, c.x, c.y, c.z);
  const every = Math.round(big / small);             // 每几根次格出一根主格
  const kind = (k) => (k === 0 ? "axis" : k % every === 0 ? "big" : "small");
  const v0 = j0 * small, v1 = j1 * small, u0 = i0 * small, u1 = i1 * small;
  for (let i = i0; i <= i1; i++) seg(buckets[kind(i)], P(i * small, v0), P(i * small, v1));
  for (let j = j0; j <= j1; j++) seg(buckets[kind(j)], P(u0, j * small), P(u1, j * small));
  const style = { axis: [0x53677c, 0.42], big: [0x8899aa, 0.22], small: [0x9eabb9, 0.10] };
  for (const k of Object.keys(buckets)) {
    if (!buckets[k].length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(buckets[k]), 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: style[k][0], transparent: true, opacity: style[k][1], depthWrite: false }));
    l.renderOrder = 2;
    gridGroup.add(l);
  }
  viewer.invalidate();
}

// ---------------------------------------------------------------- 模型参考的投影（仿 SolidWorks 的草图引用）
/*
 * SolidWorks 在草图里标注尺寸时，可以直接点**模型的棱边/顶点** ——
 * 它会把那条边投影到草图平面上，显示成一条参考线（紫/虚线），
 * 然后尺寸就标在"草图元素 ↔ 这条参考线"之间。
 *
 * 我们这里做同样的事：
 *   投影出来的参考是**常量**，不参与求解（求解器里对应 distToFixedLine / angleToFixedLine），
 *   所以改尺寸只会让草图的元素动，不会去动模型。
 *   模型改了之后重新进草图，重新点一次即可（这一版不做"活引用"的自动跟随）。
 */
const _projV = new THREE.Vector3();

/** 3D 点 → 草图平面 2D 坐标 */
function proj3DToSketch(p3d) {
  if (!sketch) return null;
  _projV.set(p3d[0], p3d[1], p3d[2]).sub(sketch.origin);
  return [_projV.dot(sketch.xDir), _projV.dot(sketch.yDir)];
}

/** 3D 坐标 → 屏幕 client 坐标（用来判断"这个顶点离手指最近"） */
function worldToScreen(p3d) {
  const v = new THREE.Vector3(p3d[0], p3d[1], p3d[2]).project(viewer.camera);
  const r = canvas.getBoundingClientRect();
  return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
}

/**
 * 在屏幕位置找「可当作尺寸参考的模型几何」，返回投影后的元素引用。
 * 顶点优先（更精确），其次棱边。
 */
function pickModelRefForDim(screenPt, tolPx = 26) {
  if (!shape) return null;
  // ① 顶点
  const sets = OPS.edgePointSets(shape, 6);
  let best = null, bd = tolPx;
  for (const st of sets) {
    for (const p of [st.pts[0], st.pts[st.pts.length - 1]]) {
      const sc = worldToScreen(p);
      const d = Math.hypot(sc[0] - screenPt.x, sc[1] - screenPt.y);
      if (d < bd) { bd = d; best = { kind: "vert", p3: p, scr: sc }; }
    }
  }
  if (best) {
    const p2 = proj3DToSketch(best.p3);
    if (p2) return { kind: "projPoint", p: p2, p3: best.p3, label: "模型顶点" };
  }
  // ② 棱边（投影成一条参考线）
  const e = viewer.pickEdgeAt(screenPt.x, screenPt.y);
  if (!e) return null;
  const hit = sets.find((st) => st.hash === e.hashCode);
  if (!hit || hit.pts.length < 2) return null;
  const a = proj3DToSketch(hit.pts[0]);
  const b = proj3DToSketch(hit.pts[hit.pts.length - 1]);
  if (!a || !b) return null;
  // 投影后退化成一点（这条边垂直于草图平面）—— 当点用
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) {
    return { kind: "projPoint", p: a, p3: hit.pts[0], label: "模型顶点" };
  }
  return { kind: "projLine", a, b, label: "模型边" };
}

// ---------------------------------------------------------------- 智能尺寸（按 SolidWorks 规则）
/*
 * SolidWorks 的智能尺寸是"看人选了什么，自己决定标什么"：
 *   1 圆 → 直径     1 线 → 长度     2 点 → 距离
 *   2 平行线 → 线距   2 不平行线 → 角度
 *   2 圆 → 圆心距     圆+线 → 圆心到线   点+线 → 点到线
 * 规则本身在 src/elements.js 里（纯函数，可单测）；这里只负责拾取和收尾。
 *
 * 拾取分两级：先看有没有点中特征点（端点/圆心），再看有没有点中元素（边/圆）。
 * 这是必须的 —— 草图实体是"矩形/圆/折线"，而智能尺寸要的是**边**，
 * 点矩形上边标出来的是那条边的长度，不是整个矩形。
 */
let smartSel = [];        // 已选元素（元素级别引用）
let smartSpec = null;     // 待确认的约束描述

/** 1 个草图单位在屏幕上占多少像素（用于把像素容差换成草图容差） */
function sketchScale() {
  if (!sketch) return 1;
  const a = sketchToScreen([0, 0]);
  const b = sketchToScreen([1, 0]);
  if (!a || !b) return 1;
  return Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
}

/**
 * 标好之后弹出的数值编辑框（SolidWorks 里也是标完立刻能改数）。
 * 确认 → 真的当约束求解；取消 → 什么都不做。
 */
function showDimEdit(r, { allowMore = false } = {}) {
  const old = document.getElementById("dimEdit");
  if (old) old.remove();
  const d = document.createElement("div");
  d.id = "dimEdit";
  d.className = "dim-edit";
  const unit = r.type === "angle" ? "°" : "mm";
  d.innerHTML =
    `<div class="de-title">${r.label}</div>` +
    `<div class="de-row"><input id="deVal" type="number" step="0.1" value="${(+r.value).toFixed(2)}"><span class="de-unit">${unit}</span></div>` +
    `<div class="de-row de-btns"><button class="primary" data-de="ok">✔ 确定</button><button data-de="no">✖ 取消</button></div>` +
    // 单元素时给一个"再选一个"的出口：不改当前的，继续选第二个元素来做组合标注
    (allowMore ? `<div class="de-row de-btns"><button class="ghost" data-de="more">＋ 再选一个元素</button></div>` : "");
  document.body.appendChild(d);
  const inp = d.querySelector("#deVal");
  inp.readOnly = !r.spec;
  inp.focus();
  inp.select();
  d.querySelector('[data-de="ok"]').onclick = () => {
    const v = parseFloat(inp.value);
    d.remove();
    if (isFinite(v)) applySmartSpec(v);
    else setStats("数值不合法");
  };
  d.querySelector('[data-de="no"]').onclick = () => {
    d.remove();
    smartDimReset();
    smartDimHighlight();
    setStats("已取消这个尺寸 · 模型未改动");
  };
  const moreBtn = d.querySelector('[data-de="more"]');
  if (moreBtn) moreBtn.onclick = () => {
    // 关掉框、**保留已选的那个元素**，让用户接着点第二个
    d.remove();
    smartSpec = null;
    setStats(`已选 ${smartSel.length} 个 · 再点一个元素就能做组合标注（如圆心到线）`);
  };
  // 回车 = 确定
  inp.onkeydown = (ev) => { if (ev.key === "Enter") d.querySelector('[data-de="ok"]').click(); };
}

function smartDimReset() {
  smartSel = [];
  smartSpec = null;
}

/**
 * 图元变了（清空/删除/重建）就必须重置选择 ——
 * smartSel 存的是"第几个实体的第几条边"，实体一换这些下标就指向别的东西，
 * 会组合出"残留的点 + 新的线"这种用户没选过的标注。
 */
function resetSmartOnSketchChanged() {
  smartDimReset();
  smartDimHighlight();
}

/** 把一组选中的元素画成高亮（智能尺寸和关系模式共用） */
function highlightElements(arr) {
  if (!sketch) return;
  const lines = [];
  // ⚠ 必须转成世界坐标：草图是画在某张平面上的（可能是板顶面 z=8），
  // 直接写 [x, y, 0] 会把高亮画到世界 z=0 平面上，位置完全不对。
  const push2 = (a, b) => {
    const A = sketch.toWorld2(a), B = sketch.toWorld2(b);
    lines.push(A, B);
  };
  for (const sel of arr) {
    const g = ELEM.geometryOf(sketch, sel);
    if (!g) continue;
    if (g.kind === "line") push2(g.a, g.b);
    else if (g.kind === "circle") {
      for (let i = 0; i < 48; i++) {
        const t0 = (i / 48) * Math.PI * 2, t1 = ((i + 1) / 48) * Math.PI * 2;
        push2([g.center[0] + Math.cos(t0) * g.r, g.center[1] + Math.sin(t0) * g.r],
             [g.center[0] + Math.cos(t1) * g.r, g.center[1] + Math.sin(t1) * g.r]);
      }
    } else if (g.kind === "point" && g.p) {
      // 点元素画个小十字
      const [x, y] = g.p, s = 1.5;
      push2([x - s, y], [x + s, y]);
      push2([x, y - s], [x, y + s]);
    } else if (g.kind === "line" && g.fixed) {
      // 模型投影来的参考线：画成**虚线**（SolidWorks 里引用线也是虚线/紫色）
      const a = g.a, b = g.b;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
      const seg = 1.6, gap = 1.0;
      for (let t = 0; t < L; t += seg + gap) {
        const t2 = Math.min(L, t + seg);
        push2([a[0] + ux * t, a[1] + uy * t], [a[0] + ux * t2, a[1] + uy * t2]);
      }
    }
  }
  viewer.setPreviewWire(lines.length ? new Float32Array(lines.flat()) : null);
}

/** 把选中的元素画成高亮 */
function smartDimHighlight() { highlightElements(smartSel); }

// ---------------------------------------------------------------- 关系（几何约束）
/*
 * SolidWorks 的"添加关系"：先点选若干元素，再点要加的约束。
 * 可用的约束取决于选了什么 —— 两条线才有平行/垂直/角度，
 * 一个点加一条线才有中点，两个点加一条线才有对称。
 * 约束本身在 solver.js 里（单测 21/21），这里只负责拾取、过滤、落盘。
 */
let relSel = [];        // 已选元素
let relOn = false;      // 关系模式开着没

function relReset() { relSel = []; }
function relHighlight() { highlightElements(relSel); }

function enterRelMode() {
  relOn = true;
  relReset();
  relHighlight();
  $("relPad").classList.remove("hidden");
  const cl = $("relClose");
  if (cl) cl.onclick = () => { exitRelMode(); setStats("已退出关系模式"); };
  refreshRelPad();
  setStats("关系模式 · 点选元素（可以点边、圆、端点），再从面板选要加的约束");
}

function exitRelMode() {
  relOn = false;
  relReset();
  relHighlight();
  $("relPad").classList.add("hidden");
}

/** 关系模式下点一下（拾取逻辑与智能尺寸一致，都是"点优先、再元素"） */
function relPickPoint(p2d) {
  if (!sketch) return;
  const sc = sketchScale();
  const pickTol = sc > 0.01 ? 12 / sc : 2.0;
  const cp = nearestRefPoint(p2d, pickTol);
  let sel = null;
  const cpEnt = cp ? sketch.entities[cp.ref.e] : null;
  if (cp && cp.ref.p === "center" && cpEnt && cpEnt.kind === "circle") sel = { kind: "circle", e: cp.ref.e };
  else if (cp) sel = { kind: "point", e: cp.ref.e, p: cp.ref.p, p2: cp.p };
  else {
    const el = ELEM.pickElementAt(sketch, p2d, sc > 0.01 ? 28 / sc : 2.5);
    if (el) {
      sel = { ...el };
      const g = ELEM.geometryOf(sketch, el);
      if (g && g.kind === "point") sel.p2 = g.p;
    }
  }
  if (!sel) { setStats("这里没有可选元素 · 点边、圆或端点"); return; }

  const idx = relSel.findIndex((s) => ELEM.sameElement(s, sel));
  if (idx >= 0) {
    relSel.splice(idx, 1);
    setStats(`已取消选择 · 当前选了 ${relSel.length} 个`);
  } else {
    if (relSel.length >= 3) relSel.shift();   // 最多三个（对称要三个）
    relSel.push(sel);
    setStats(`已选 ${relSel.length} 个：${relSel.map((s) => ELEM.elementName(sketch, s)).join("、")}`);
  }
  relHighlight();
  refreshRelPad();
}

/** 当前选择下能加哪些约束 */
function availableRelations() {
  const n = relSel.length;
  const cnt = (k) => relSel.filter((s) => s.kind === k).length;
  const out = [];
  if (n === 1) {
    out.push({ type: "fix", label: "固定" });
    return out;
  }
  if (n === 2) {
    if (cnt("line") === 2) {
      out.push({ type: "parallel", label: "平行" });
      out.push({ type: "perpendicular", label: "垂直" });
      // 已经有了方向才算得出角度
      const g1 = ELEM.geometryOf(sketch, relSel[0]), g2 = ELEM.geometryOf(sketch, relSel[1]);
      if (g1 && g2 && g1.kind === "line" && g2.kind === "line") {
        const a = ELEM.lineAngle(g1, g2);
        out.push({ type: "angle", label: `角度${a != null ? " " + a.toFixed(1) + "°" : ""}` });
      }
    }
    if (cnt("point") === 2) out.push({ type: "coincident", label: "重合" });
    if (cnt("point") === 1 && cnt("line") === 1) out.push({ type: "midpoint", label: "中点" });
    if (cnt("circle") === 1 && cnt("line") === 1) out.push({ type: "tangent", label: "相切" });
    if (cnt("circle") === 2) out.push({ type: "equal_r", label: "相等" });
    return out;
  }
  if (n === 3) {
    if (cnt("point") === 2 && cnt("line") === 1) out.push({ type: "symmetric", label: "对称" });
    return out;
  }
  return out;
}

/** 按当前选择构造可序列化的约束描述 */
function buildRelSpec(type) {
  const order = (k) => relSel.filter((s) => s.kind === k);
  // 固定：把**此刻**的几何快照进 spec（不能每次求解现取，否则等于没固定）
  if (type === "fix") {
    const e = sketch.entities[relSel[0].e];
    if (!e) return null;
    const at = e.kind === "rect" ? [e.c[0], e.c[1], e.w, e.h]
      : e.kind === "circle" ? [e.c[0], e.c[1], e.r]
      : e.pts.flat();
    return { type: "fix", e: relSel[0].e, at, label: "固定" };
  }
  if (type === "parallel" || type === "perpendicular") {
    return { type, l1: relSel[0], l2: relSel[1] };
  }
  if (type === "angle") {
    const g1 = ELEM.geometryOf(sketch, relSel[0]), g2 = ELEM.geometryOf(sketch, relSel[1]);
    if (!g1?.dir || !g2?.dir) return null;
    const a = ELEM.lineAngle(g1, g2);
    return { type: "angle", l1: relSel[0], l2: relSel[1], value: +a.toFixed(3), label: `角度 ${a.toFixed(1)}°` };
  }
  if (type === "coincident") return { type, a: { e: relSel[0].e, p: relSel[0].p }, b: { e: relSel[1].e, p: relSel[1].p } };
  if (type === "midpoint") {
    const p = order("point")[0], l = order("line")[0];
    return { type, p: { e: p.e, p: p.p }, l, label: "中点在线上" };
  }
  if (type === "tangent") {
    const c = order("circle")[0], l = order("line")[0];
    return { type, e: c.e, l, label: "相切" };
  }
  if (type === "equal_r") {
    const cs = order("circle");
    return { type: "equal", e: cs[0].e, f: cs[1].e, k: "r", label: "等半径" };
  }
  if (type === "symmetric") {
    const ps = order("point"), l = order("line")[0];
    return { type, a: { e: ps[0].e, p: ps[0].p }, b: { e: ps[1].e, p: ps[1].p }, l, label: "对称" };
  }
  return null;
}

/** 刷新面板：可用约束按钮 + 已有约束列表 */
function refreshRelPad() {
  const box = $("relBtns");
  if (!box) return;
  box.innerHTML = "";
  const list = availableRelations();
  $("relInfo").textContent = relSel.length
    ? `已选 ${relSel.length} 个：${relSel.map((s) => ELEM.elementName(sketch, s)).join("、")}`
    : "点选元素（边/圆/端点）";
  if (relSel.length && !list.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "这个组合暂时没有可加的约束";
    box.appendChild(d);
  }
  for (const r of list) {
    const b = document.createElement("button");
    b.textContent = r.label;
    b.onclick = () => applyRelation(r.type);
    box.appendChild(b);
  }
  // 已有约束：可以逐个删掉（SolidWorks 也能在特征树里删关系）
  const cs = sketch ? sketch.constraints : [];
  $("relList").textContent = cs.length
    ? `已有 ${cs.length} 个约束：` + cs.map((c, i) => `${i + 1}.${c.label || c.type}`).join(" ")
    : "还没有约束";
}

/** 加一个约束并求解 */
function applyRelation(type) {
  if (!sketch || !relSel.length) return false;
  const spec = buildRelSpec(type);
  if (!spec) { setStats("这个约束构造不出来"); return false; }
  // 角度先编辑再提交；取消时不会遗留约束，也不会先移动草图。
  if (type === "angle") {
    smartSpec = { type: "angle", value: spec.value, label: spec.label, spec };
    relReset();
    relHighlight();
    refreshRelPad();
    showDimEdit(smartSpec);
    return true;
  }
  sketch.constraints.push(spec);
  const before = JSON.parse(JSON.stringify(sketch.entities));
  const res = solveSketch(sketch.entities, sketch.constraints);
  if (!res.ok) {
    restoreEntities(before);
    sketch.constraints.pop();
    showOverdefined(res, spec);
    refreshRelPad();
    redrawSketch();
    return false;
  }
  setStats(`已添加「${spec.label || spec.type}」 · 求解 ${res.iterations} 次迭代 · 估算剩余自由度 ${res.dof}`);
  relReset();
  relHighlight();
  refreshRelPad();
  redrawSketch();
  return true;
}

/** 删掉第 i 个约束 */
function removeRelation(i) {
  if (!sketch) return;
  if (i < 0 || i >= sketch.constraints.length) return;
  const gone = sketch.constraints.splice(i, 1)[0];
  setStats(`已删除约束「${gone.label || gone.type}」`);
  redrawSketch();
  refreshRelPad();
}

/** 智能尺寸模式下点一下 */
function smartDimPickPoint(p2d, screenPt = null) {
  if (!sketch) return;
  // ① 特征点优先（点到点距离、点到线距离都从点开始）
  const sc0 = sketchScale();
  const pickTol = sc0 > 0.01 ? 12 / sc0 : 2.0;   // 12 像素的吸附范围
  const cp = nearestRefPoint(p2d, pickTol);
  let sel = null;
  const cpEnt = cp ? sketch.entities[cp.ref.e] : null;
  // **只有真圆**的圆心才转成"选圆"。矩形也有 center 点，但那个中心不是圆心 ——
  // 之前没区分，导致点矩形附近会莫名其妙选成"圆"（实测踩到）。
  if (cp && cp.ref.p === "center" && cpEnt && cpEnt.kind === "circle") {
    sel = { kind: "circle", e: cp.ref.e };
  } else if (cp) {
    sel = { kind: "point", e: cp.ref.e, p: cp.ref.p, p2: cp.p };
  } else {
    // ② 元素（容差按屏幕像素折算成草图 mm：实测 1 草图单位在屏幕上多少像素）
    const sc = sketchScale();
    const tol = sc > 0.01 ? 28 / sc : 2.5;
    const el = ELEM.pickElementAt(sketch, p2d, tol);
    if (el) {
      const g = ELEM.geometryOf(sketch, el);
      sel = { ...el };
      if (g && g.kind === "point") sel.p2 = g.p;
    }
  }
  // ③ 草图上没有 → 试**模型上的棱边/顶点**（投影到草图平面当参考，仿 SolidWorks）
  if (!sel && screenPt) {
    const mref = pickModelRefForDim(screenPt);
    if (mref) {
      sel = mref;
      setStats(`已引用${mref.label}（投到草图平面）· 再点一个草图元素就能标尺寸`);
    }
  }
  if (!sel) { setStats("这里没有可标注的元素 · 点轮廓/端点，或点模型的棱边试试"); return; }

  // 再点一次同一个 → 取消
  const hitIdx = smartSel.findIndex((s) => ELEM.sameElement(s, sel));
  if (hitIdx >= 0) {
    smartSel.splice(hitIdx, 1);
    smartDimHighlight();
    setStats(smartSel.length ? `已选 ${smartSel.length} 个元素` : "已清空选择 · 点元素开始标注");
    return;
  }
  if (smartSel.length >= 2) smartSel.shift();   // 只保留最近两个
  smartSel.push(sel);
  smartDimHighlight();

  if (smartSel.length === 1) {
    const g = ELEM.geometryOf(sketch, smartSel[0]);
    // 单个圆/线本身就能出尺寸 → 直接给出确定框
    const r = ELEM.smartRule(sketch, smartSel);
    if (r && r.spec) {
      /*
       * 单选就能标的（圆的直径、线的长度……）以前只弹一句"或直接确认"，
       * **却没有确认的入口** —— 用户只能再点一个元素，否则这个尺寸根本标不下去
       * （实测反馈）。现在直接弹出确定框，框里还留一个"＋ 再选一个"的出口。
       */
      smartSpec = r;
      setStats(`已选 ${ELEM.elementName(sketch, sel)} · ${r.label} · 改完点确定，或按「＋ 再选一个」改成两个元素之间的标注`);
      showDimEdit(r, { allowMore: true });
    } else {
      setStats(`已选 ${ELEM.elementName(sketch, sel)} · 再点一个元素`);
    }
  } else {
    const r = ELEM.smartRule(sketch, smartSel);
    if (r.error) { setStats(`⚠ ${r.error} · 换个元素组合试试`); return; }
    smartSpec = r;
    setStats(`${ELEM.elementName(sketch, smartSel[0])} ↔ ${ELEM.elementName(sketch, smartSel[1])} → ${r.label} · 右侧可改数值`);
    showDimEdit(r);
  }
}

/** 驱动尺寸按几何引用识别；显示文字、旧值和拾取时坐标不属于约束身份。 */
function constraintTargetKey(spec) {
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort()
      .filter((key) => !["value", "label", "display", "p2", "kind"].includes(key))
      .map((key) => [key, stable(value[key])]));
  };
  const target = stable(spec);
  const pair = ["distance", "coincident"].includes(spec.type) ? ["a", "b"]
    : ["angle", "parallel", "perpendicular"].includes(spec.type) ? ["l1", "l2"]
    : spec.type === "equal" ? ["e", "f"] : null;
  if (pair && JSON.stringify(target[pair[0]]) > JSON.stringify(target[pair[1]])) {
    [target[pair[0]], target[pair[1]]] = [target[pair[1]], target[pair[0]]];
  }
  return JSON.stringify(target);
}

/** 把 smartSpec 转成约束并求解 */
function applySmartSpec(value) {
  if (!sketch || !smartSpec) return false;
  /*
   * 从动尺寸（spec === null）：两边都是引用参考，改数值没有任何东西会跟着动。
   * 与其静默丢弃，不如把它当"参考尺寸"登记下来**只显示**（SolidWorks 也是这么做的，
   * 从动尺寸是加括号的只读标注）。
   */
  if (!smartSpec.spec) {
    // 从动尺寸：**存"测什么"，不存当时的值** —— 值在绘制时现算，几何一变自动跟着变
    return addDrivenDim(smartSpec.measure || measureFromSpec(smartSpec.spec), smartSpec.label);
  }
  const spec = { ...smartSpec.spec };
  if (value != null) {
    if (!Number.isFinite(value) || value < 0 || (["diameter", "length"].includes(smartSpec.type) && value === 0)) {
      setStats("请输入有效的尺寸数值");
      return false;
    }
    // 用户改了数值（直径约束里存的是半径，要除 2）
    spec.value = smartSpec.type === "diameter" ? value / 2 : value;
    spec.label = (spec.label || smartSpec.label || "尺寸").replace(/[\d.]+/, value.toFixed(2));
  }
  const beforeConstraints = sketch.constraints.slice();
  // 同一个点对/元素对重复标 → 替换旧的，避免天然矛盾
  const key = constraintTargetKey(spec);
  sketch.constraints = sketch.constraints.filter((c) => constraintTargetKey(c) !== key);
  sketch.constraints.push(spec);

  const before = JSON.parse(JSON.stringify(sketch.entities));
  const res = solveSketch(sketch.entities, sketch.constraints);
  if (!res.ok) {
    restoreEntities(before);
    sketch.constraints = beforeConstraints;
    showOverdefined(res, spec);
    smartDimReset();
    smartDimHighlight();
    redrawSketch();
    return false;
  }
  setStats(`${spec.label || "已标注"} · 求解 ${res.iterations} 次迭代 · 估算剩余自由度 ${res.dof} · 数值可改`);
  smartDimReset();
  smartDimHighlight();
  redrawSketch();
  return true;
}
/*
 * 草图里的「智能尺寸」现在有两级：
 *   1. 点在**特征点**上（端点/圆心）→ 标两点之间的距离（新）
 *   2. 点在图元轮廓上 → 改宽/高/半径（原有）
 * 距离约束用的点引用是 {e, p}（实体下标 + 点语义名），求解器能直接吃。
 */
let dimP1 = null;        // 已选的第一个点

/** 把 {e,p} 引用还原成草图 2D 坐标 */
function resolveRef(ref) {
  /*
   * 两种引用形式都要认：
   *   {e, p}            草图图元的具名点（可动，求解器能解析）
   *   {e: null, at:[x,y]} 引用线的**常量端点**（模型投影来的，不动）
   * 之前只认第一种，于是引用了模型边的尺寸在渲染时被整个跳过 ——
   * 约束建好了、数值算对了，屏幕上一根线都没有（实测踩到）。
   */
  if (ref && ref.e === null && Array.isArray(ref.at)) return ref.at;
  if (!ref || !sketch) return null;
  const e = sketch.entities[ref.e];
  if (!e) return null;
  const c = candidatesOf(e, ref.e).find((x) => x.ref && x.ref.p === ref.p);
  return c ? c.p : null;
}

/** 找离手指最近的「可标注特征点」（中点/象限点不能作约束目标，跳过） */
function nearestRefPoint(p2d, tol = 5) {
  if (!sketch) return null;
  let best = null, bd = Infinity;
  sketch.entities.forEach((e, i) => {
    /*
     * ⚠ 引用图元（e.ref，从模型投影来的）要**整个跳过**。
     *
     * 引用一条模型的直边会得到一条 48 点采样的折线，`candidatesOf` 会把
     * 每个采样点都当候选 —— 手指点在线上任何位置都会命中某个采样点/中点，
     * 于是一条好好的引用**线**被当成一个**点**去标注：
     *   - 两条引用线之间标出来的是"两个采样点的距离"，渲染直接连这两点
     *     → 屏幕上出现两条斜线、尺寸是歪的（用户实测报的现象）
     *   - 也标不出正确的"线距"
     * 跳过它们之后，点引用线会走到元素拾取（pickElementAt）→ 返回整条线 ✓
     * 想引用模型的顶点，用 3D 拾取那条路（pickModelRefForDim）。
     */
    if (e.ref) return;
    for (const c of candidatesOf(e, i)) {
      if (!c.ref) continue;
      const d = Math.hypot(c.p[0] - p2d.x, c.p[1] - p2d.y);
      if (d < bd) { bd = d; best = { ...c, dist: d }; }
    }
  });
  return bd <= tol ? best : null;
}

/** 尺寸工具：优先按「两个特征点」标距离，退回按图元改尺寸 */
function dimPickSmart(p2d) {
  const cp = nearestRefPoint(p2d);
  if (cp) { dimensionTwoPoints(cp); return; }
  dimPick(p2d);          // 原来的：点轮廓改宽/高/半径
}

function dimensionTwoPoints(cp) {
  if (!sketch) return;
  if (!dimP1) {
    dimP1 = cp;
    setStats(`已选第一个点（${SNAP_KINDS[cp.kind]?.label || "点"}）· 再点第二个点，就能标它们之间的距离`);
    return;
  }
  const same = cp.ref.e === dimP1.ref.e && cp.ref.p === dimP1.ref.p;
  if (same) { setStats("不能选同一个点，换个点或点空白取消"); return; }

  const d = Math.hypot(cp.p[0] - dimP1.p[0], cp.p[1] - dimP1.p[1]);
  if (d < 1e-6) { setStats("两点重合，标不了距离"); dimP1 = null; return; }

  // 同一个点对只保留一条（重复标会互相矛盾）
  const key = (r) => `${r.e}:${r.p}`;
  sketch.constraints = sketch.constraints.filter((c) => {
    if (c.type !== "distance") return true;
    const k1 = key(c.a) + "|" + key(c.b), k2 = key(c.b) + "|" + key(c.a);
    return k1 !== key(dimP1.ref) + "|" + key(cp.ref) && k2 !== key(dimP1.ref) + "|" + key(cp.ref);
  });
  sketch.constraints.push({ type: "distance", a: dimP1.ref, b: cp.ref, value: +d.toFixed(3), label: `距离 ${d.toFixed(2)}` });

  const before = JSON.parse(JSON.stringify(sketch.entities));
  const res = solveSketch(sketch.entities, sketch.constraints);
  if (!res.ok) {
    restoreEntities(before);
    sketch.constraints.pop();
    // 过定义/矛盾：按图 2 的思路给"设为从动尺寸"的选择，而不是直接拒绝
    showOverdefined(res, spec);
    redrawSketch();
    dimP1 = null;
    return;
  }
  redrawSketch();
  setStats(`已标注两点距离 ${d.toFixed(2)}mm · 求解 ${res.iterations} 次迭代 · ` +
    `估算剩余自由度 ${res.dof} · maxErr ${res.maxErr.toExponential(1)} · 点数值可改，或继续标下一个`);
  dimP1 = null;
}

/** 过定义/矛盾时的提示，带"设为从动尺寸"（只测量不驱动） */
function showOverdefined(res, spec) {
  const old = document.getElementById("odAsk");
  if (old) old.remove();
  const box = document.createElement("div");
  box.id = "odAsk";
  box.className = "panel";
  box.innerHTML = `
    <div class="sd-title">增加这个尺寸会让草图过定义或无解</div>
    <div class="sd-hint">冲突：${escapeHTML((res.conflicts || []).join("、") || "约束过多")}</div>
    <div class="sd-btns">
      <button data-od="driven" class="primary">设为从动尺寸</button>
      <button data-od="cancel">取消</button>
    </div>
    <div class="sd-hint">从动尺寸只显示测量值、不驱动图形</div>`;
  document.body.appendChild(box);
  box.querySelector("[data-od=driven]").onclick = () => {
    box.remove();
    /*
     * 真的创建从动标注 —— 之前这里只弹了一句"已改为从动尺寸"，
     * 既没画东西、也没存东西（交接文档 P0-1 指出的就是这个）。
     * 从被拒绝的那个 spec 反推测量定义；几何不受它驱动、不进约束列表。
     */
    const m = measureFromSpec(spec);
    if (m) addDrivenDim(m, (spec && spec.label) || "参考尺寸");
    else setStats("设为从动尺寸失败：这个尺寸没有可跟踪的测量对象（模型未改动）");
  };
  box.querySelector("[data-od=cancel]").onclick = () => {
    box.remove();
    setStats("已取消这个尺寸 · 模型未改动");
  };
}

// ---------------------------------------------------------------- 状态栏
function setKernel(text, cls) {
  $("ktext").textContent = text;
  $("kdot").className = "dot " + (cls || "");
}
function setStats(t) { $("stats").textContent = t; $("stats").title = t; }

// ---------------------------------------------------------------- 渲染刷新
function refresh({ fit = false, coarse = false } = {}) {
  /*
   * ⚠ 没有实体（比如把"起始零件"删掉了）时必须**清空视图**，
   * 不能直接 return —— 直接返回的话屏幕上还留着上一个零件的网格，
   * 看着像"删了但没删掉"（用户实测反馈）。
   */
  if (!shape) {
    try {
      viewer.setMesh(null);
      viewer.setEdgeData([]);
      viewer.clearHighlight?.();
      viewer.highlightEdges?.([]);
      viewer.clearSketchLines?.();
      viewer.clearPreviewWire?.();
    } catch (_) {}
    try { bbox = null; } catch (_) {}
    return;
  }
  const t0 = performance.now();
  // 网格精度随模型尺寸自适应：零件很大时固定用 0.05mm 绝对公差会把三角数堆到
  // 几十万，平板扛不住；改成按最大边算相对精度，小零件照样精细
  const size = (() => {
    try { const b = shape.boundingBox; return Math.max(b.width, b.height, b.depth); }
    catch (_) { return 60; }
  })();
  const fine = Math.max(0.05, size / 1200);
  let m = null;
  try {
    /*
     * ⚠ 拖动预览的网格精度不能太粗。
     *
     * 原来用的是"容差 ×6、角度容差 30°"，圆柱会被三角化成很粗的多边形，
     * 拖动改直径时轮廓几乎不动 —— 几何明明变了（体积对得上），
     * 屏幕上却"看不出直径变大"（用户实测反馈）。
     * 改成 ×2.5 / 18°：圆柱轮廓足够圆，预览的形变一眼可见，
     * 网格耗时仍在可接受范围（粗网格本来就是几毫秒级）。
     */
    m = meshOf(shape, coarse
      ? { tolerance: Math.max(0.12, fine * 2.5), angularTolerance: 18 }
      : { tolerance: fine, angularTolerance: 10 });
  } catch (_) { m = null; }
  /*
   * ⚠ 网格化拿不到三角时**不要更新视图**。
   *
   * 拖动手柄改圆柱直径时用的是"粗网格"（容差大、角度容差 30°），
   * 在某些中间尺寸下会三角化出空结果 —— 直接 setMesh 空的，
   * 屏幕上的模型就突然消失了，松手后高精度网格又把它带回来
   * （用户实测："推拉控制圆柱直径时 3D 模型直接消失，松开鼠标后更改成功、模型回来了"）。
   * 这里保持上一帧、什么都不动，拖动看起来就是"到极限停住了"。
   */
  const triCount = m && (m.triCount || (m.triangles ? m.triangles.length / 3 : 0));
  if (!m || !triCount) {
    if (coarse) return;                       // 预览中：静默保持上一帧
    setStats("这个状态下算不出网格（几何可能已经退化）· 显示保持在上一个有效状态");
    return;
  }
  const tMesh = performance.now() - t0;

  viewer.setMesh(m, { fit, preview: coarse });
  // 手柄预览只更新几何显示，松手后的正常刷新再计算体积/边数等统计。
  if (coarse) return m;

  let vol = 0, bbTxt = "";
  try { vol = api.measureVolume(shape); } catch (_) {}
  try {
    const bb = shape.boundingBox;
    bbTxt = `${bb.width?.toFixed(1)}×${bb.height?.toFixed(1)}×${bb.depth?.toFixed(1)}`;
  } catch (_) {}

  setStats(`面 ${shape.faces.length} · 边 ${shape.edges.length} · 三角 ${m.triCount} · ` +
           `体积 ${(vol / 1000).toFixed(2)} cm³ · 包围盒 ${bbTxt} mm · 网格 ${tMesh.toFixed(0)} ms`);
  try {
    // 回归夹具会在独立 VM 里抠出 refresh，那里没有 workspaceUI。
    if (typeof workspaceUI !== "undefined" && workspaceUI) workspaceUI.setFaceCount?.(shape.faces.length);
  } catch (_) {}

  // 选边模式才维护边的离散点（pointAt 走 wasm 有开销，推拉预览时不需要）
  // 拖动预览用 coarse 网格，此时不重算（dimBase 固定，中点坐标没变）
  if ((mode === "fillet" || mode === "chamfer") && !coarse) {
    try {
      const sets = OPS.edgePointSets(shape);
      for (const s of sets) {
        if (!s.mid) continue;
        const info = OPS.edgeFilletInfo(shape, s.mid);
        if (info) { s.dir = info.dir; s.n1 = info.n1; s.n2 = info.n2; s.tel = info.t; }
      }
      viewer.setEdgeData(sets);
    } catch (_) {}
  }
  return m;
}

/** 重建后把选择迁移到「同一个」几何面（位置 + 法向匹配） */
function remapSelection(snap = selSnap) {
  if (!snap || !shape) return null;
  let best = null, bestScore = -Infinity;
  for (const f of shape.faces) {
    try {
      const c = f.center;
      const n = new THREE.Vector3(...OPS.normalOf(f));
      const nd = n.dot(snap.normal);
      const d = Math.hypot(c.x - snap.center[0], c.y - snap.center[1], c.z - snap.center[2]);
      const score = nd * 0.7 + (1 / (1 + d)) * 0.3;
      if (score > bestScore) { bestScore = score; best = f.hashCode; }
    } catch (_) {}
  }
  return best;
}

// ---------------------------------------------------------------- 选择
// 面分类结果缓存：同一个面反复点选时不必重算
// （实测 0.9ms/面，但每次选面都要跑一遍，缓存掉更跟手）
const _classCache = new Map();

function classifyCached(faceId, centerHint) {
  if (faceId == null) return null;
  if (_classCache.has(faceId)) return _classCache.get(faceId);
  let c = null;
  try { c = OPS.classifyFace(viewer.meshData, faceId, centerHint); } catch (_) { c = null; }
  _classCache.set(faceId, c);
  // 网格一换，faceId 就全变了，缓存自然失效；这里再兜个上限防止无限增长
  if (_classCache.size > 4000) _classCache.clear();
  return c;
}

function selectFace(faceId) {
  // 手柄持有拖动开始时的实体和参数，第二触点不能把驱动切到另一个面。
  if (dim?.dragging) return;
  selectedFaceId = faceId;
  faceClass = null;
  curvedDriver = null;
  if (faceId == null) { selSnap = null; viewer.clearHighlight(); showPicker(null); dim?.hide(); return; }
  const info = OPS.faceInfo(shape, faceId);
  if (!info) { selectedFaceId = null; viewer.clearHighlight(); showPicker(null); dim?.hide(); return; }
  selSnap = { normal: new THREE.Vector3(...info.normal), center: info.center.slice() };
  viewer.highlightFace(faceId);
  showPicker(info);
  // 抽壳模式下没有面信息面板（见 showPicker 的说明），改用状态栏告诉用户选中的是哪个面
  if (mode === "shell") {
    setStats(`已选定开口面 #${String(faceId % 100000).padStart(5, "0")}`
      + `（中心 ${info.center.map((v) => v.toFixed(1)).join(", ")}）· 输入壁厚后点「应用」`);
  }

  // 先判面类型：曲面给"改尺寸"手柄（圆柱改直径、圆角改半径、倒角改距离），
  // 只有平面才给推拉手柄 —— 对圆柱面做"沿法向平移"是没有意义的
  const face = OPS.findFace(shape, faceId);
  faceClass = readCylinderFace(face) || classifyCached(faceId, info.center);
  if (faceClass && faceClass.kind !== "plane" && faceClass.kind !== "unknown") {
    const drv = findCurvedDriver(faceClass);
    if (drv.length) {
      curvedDriver = drv[0];
      showCurvedDim();
      setStats(`选中${faceClass.kind === "cylinder" ? "圆柱面" : faceClass.kind === "torus" ? "圆角面" : "倒角面"} · ` +
        `拖动橙色手柄改${curvedDimSpec()?.kind || "尺寸"}（${drv[0].label}）`);
      return;
    }
  }
  if (face?.geomType !== "PLANE") {
    dim?.hide();
    setStats("这个曲面暂时无法唯一确认尺寸来源，请在历史中编辑原始特征");
    return;
  }
  // 只有确认的平面才使用普通面推拉。
  if (mode === "select" || mode === "pushpull") showPushPullDim(0);
}

/** 普通面推拉只接受内核确认的平面；曲面必须通过其特征尺寸编辑。 */
function isPlanarPushPullFace(base, faceId) {
  if (!base || faceId == null) return false;
  try { return OPS.findFace(base, faceId)?.geomType === "PLANE"; }
  catch (_) { return false; }
}

function showPicker(info) {
  const el = $("picker");
  /*
   * 圆角/倒角/抽壳 这些命令是「在右上角那个命令位」显示自己的参数条的，
   * 而 #picker 占的是同一个位置、DOM 里又排在后边 —— 两个一起显示时，
   * 抽壳的「壁厚 / 应用 / 清空 / 取消」会被「选中面」面板整个盖住，
   * 用户看到的就是「一点面，抽壳工具就不见了」（平板实测反馈）。
   * 这些命令模式下不再弹面信息面板：面已经被高亮，选中的是哪个面走状态栏文字。
   */
  const commandMode = ["fillet", "chamfer", "shell"].includes(mode);
  if (!info || commandMode) { el.classList.add("hidden"); pickerAnchor = null; return; }
  el.classList.remove("hidden");
  const n = info.normal.map((v) => v.toFixed(2)).join(", ");
  const c = info.center.map((v) => v.toFixed(1)).join(", ");
  const planar = isPlanarPushPullFace(shape, info.faceId);
  const tag = `#${(info.faceId % 100000).toString().padStart(5, "0")}`;
  /*
   * 选中面 = 贴着这个面浮出的小卡（推拉数值 + 应用 + 两个快捷动作）。
   * 法向/中心这类调试信息折到最后一行小字里 —— 用户要的是「就地改这个面」，
   * 不是读一串坐标。卡片位置由 workspace-ui 按面的屏幕投影 + 避让算（不盖尺寸手柄）。
   */
  el.innerHTML = planar
    ? `<div class="pk-head"><span>面 <b>${tag}</b></span><span class="pk-sub">平面</span></div>
    <div class="pk-row">
      <input id="dist" type="number" inputmode="decimal" step="0.5" value="5" />
      <button data-act="apply" type="button">推拉</button>
    </div>
    <div class="pk-quick">
      <button type="button" data-pick="sketch">草图</button>
      <button type="button" data-pick="hole">孔</button>
    </div>
    <div class="pk-debug">法向 (${n}) · 中心 (${c})</div>`
    : `<div class="pk-head"><span>面 <b>${tag}</b></span><span class="pk-sub">曲面</span></div>
    <div class="muted" style="margin-top:6px">曲面尺寸请用橙色手柄；未显示手柄时，请在历史中编辑原始特征。</div>
    <div class="pk-debug">法向 (${n}) · 中心 (${c})</div>`;
  if (planar) {
    // 注意顺序：apply 必须最后绑定（旧回归在假 DOM 里把三个按钮当成同一个对象）
    el.querySelector('[data-pick="sketch"]').onclick = () => document.querySelector('[data-act="sketch"]')?.click();
    el.querySelector('[data-pick="hole"]').onclick = () => document.querySelector('[data-act="hole"]')?.click();
    el.querySelector("[data-act=apply]").onclick = () => {
      const v = parseFloat(el.querySelector("#dist").value);
      if (isFinite(v)) applyPushPull(v);
    };
  }
  // 面卡跟着「这个面的屏幕投影」走；相机转动/手势结束后 UI 层会重新贴回来
  pickerAnchor = [info.center[0], info.center[1], info.center[2]];
  let pt = null;
  try { if (typeof worldToScreen === "function") pt = worldToScreen(info.center); } catch (_) { pt = null; }
  if (typeof workspaceUI !== "undefined" && workspaceUI && workspaceUI.placePickerAt) workspaceUI.placePickerAt(pt, pickerAnchor);
}

/**
 * 选中面在屏幕上的包围盒（面卡要躲开它，否则卡片正好盖住刚选中的面 —— 父代理视觉复核抓到）。
 * 用该面的网格顶点投影；顶点太多时抽样，最多 600 个点。
 */
function selectedFaceScreenRect() {
  try {
    const md = viewer.meshData;
    if (selectedFaceId == null || !md?.faceGroups) return null;
    const g = md.faceGroups.find((x) => x.faceId === selectedFaceId);
    if (!g) return null;
    const tri = md.triangles, ver = md.vertices;
    const n = g.count * 3, stepN = Math.max(1, Math.floor(n / 600));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < n; k += stepN) {
      const vi = tri[g.start * 3 + k] * 3;
      const p = worldToScreen([ver[vi], ver[vi + 1], ver[vi + 2]]);
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    if (!Number.isFinite(x0)) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  } catch (_) { return null; }
}

// ---------------------------------------------------------------- 推拉
/**
 * 提交一次推拉。
 * 关键：永远基于传入的 base 实体重算，绝不在「预览结果」上叠加 ——
 * 否则一次拖动会被应用两次（实测会多算一倍）。
 */
/**
 * 判断这次推拉是不是落在「上一步推拉的那个面」上。
 *
 * 注意不能直接比中心：上一步已经把面推进了 dist，现在这个面的中心
 * 是 p.center + p.normal * prev.dist。把这个预期位置和当前面比，才是同一次操作。
 */
function sameFaceAsPrevPushPull(prev, before) {
  if (prev?.op?.type !== "pushpull" || !before) return false;
  const p = prev.op.faceRef;
  const n = before.normal;
  const nd = p.normal[0] * n[0] + p.normal[1] * n[1] + p.normal[2] * n[2];
  if (nd < 0.99) return false;
  const exp = [0, 1, 2].map((k) => p.center[k] + p.normal[k] * prev.op.dist);
  const d = Math.hypot(exp[0] - before.center[0], exp[1] - before.center[1], exp[2] - before.center[2]);
  return d <= 0.5;
}

function commitPushPull(base, faceId, dist, extra = null) {
  const t0 = performance.now();
  const before = OPS.faceInfo(base, faceId);
  let next;
  try {
    next = OPS.pushPullFace(base, faceId, dist);
  } catch (e) {
    setStats("推拉失败：" + (e?.message || e));
    shape = base;
    refresh();
    return;
  }
  const ms = performance.now() - t0;
  shape = next;

  if (before) {
    selSnap = {
      normal: new THREE.Vector3(...before.normal),
      center: before.center.map((v, i) => v + before.normal[i] * dist),
    };
  }
  const nf = remapSelection();
  refresh();
  if (nf != null) selectFace(nf); else selectFace(null);
  const label = `${dist > 0 ? "+" : ""}${dist.toFixed(1)}mm`;

  // ★ 同一个面上连续推拉 = 同一个特征被改到新深度，不该多出一个特征。
  //   拉 10 再拉 -5，用户想要的是「一个 5mm 的特征」，不是「拉10 + 拉-5」两步。
  const prev = history[hIndex];
  if (sameFaceAsPrevPushPull(prev, before)) {
    const oldDist = prev.op.dist;
    const merged = { ...prev.op, dist: oldDist + dist };
    prev.op = merged;
    prev.detail = detailOf(merged);
    prev.shape = shape;                // 当前实体就是这个特征的新结果
    renderTree();
    setStats(`同一个面继续推拉 → 与上一步合并成同一个特征：${oldDist.toFixed(1)} + ${dist.toFixed(1)} = ` +
      `${merged.dist.toFixed(1)}mm（没有新增特征）· 用时 ${ms.toFixed(0)} ms · ` + $("stats").textContent);
    return;
  }

  commit("推拉", label, "pushpull", before
    ? { type: "pushpull", faceRef: { center: before.center.slice(), normal: before.normal.slice() }, dist, ...(extra || {}) }
    : null);
  setStats($("stats").textContent + ` · 推拉 ${label} 用时 ${ms.toFixed(0)} ms`);
}

function applyPushPull(dist) {
  if (selectedFaceId == null || busy) return;
  if (mode !== "select" && mode !== "pushpull") { setStats("请先完成或取消当前工具，再推拉平面"); return; }
  if (!isPlanarPushPullFace(shape, selectedFaceId)) {
    setStats("曲面不能直接推拉，请使用橙色尺寸手柄或在历史中编辑原始特征");
    return;
  }
  if (!Number.isFinite(dist)) return;
  commitPushPull(shape, selectedFaceId, dist);
}

function previewDrag() {
  if (!drag || busy) return;
  if (mode !== "pushpull" || !isPlanarPushPullFace(drag.baseShape, drag.faceId)) {
    if (drag.raf) cancelAnimationFrame(drag.raf);
    shape = drag.baseShape;
    drag = null;
    refresh();
    setStats("已取消直接推拉；曲面请使用橙色尺寸手柄或编辑原始特征");
    return;
  }
  const t0 = performance.now();
  try {
    shape = OPS.pushPullFace(drag.baseShape, drag.faceId, drag.dist);
    refresh({ coarse: true });
    const snap = selSnap ? {
      normal: selSnap.normal,
      center: selSnap.center.map((v, i) => v + selSnap.normal[i] * drag.dist),
    } : null;
    const nf = remapSelection(snap);
    if (nf != null) viewer.highlightFace(nf);
    setStats(`推拉 ${drag.dist > 0 ? "+" : ""}${drag.dist.toFixed(2)} mm · 预览重建 ${(performance.now() - t0).toFixed(0)} ms`);
  } catch (_) {}
}

// ---------------------------------------------------------------- 草图
function setSketchUI(on, extrudeOn = false) {
  viewControls.refresh();
  $("sketchbar").classList.toggle("hidden", !on);
  $("toolbar").classList.toggle("hidden", on || extrudeOn);
  if (!extrudeOn) $("extrude").classList.add("hidden");
  if (on && !extrudeOn) $("extrude").classList.add("hidden");
}

/** 进入草图模式（实体面 / 世界基准面 共用这一套） */
function beginSketch(session) {
  closePatternEditor();
  sketch = session;
  mode = "sketch";
  drawing = null;
  sketchTool = "select";
  snap.clear(); snapGuides = [];       // 新草图从干净的捕捉状态开始
  syncSketchToolUI();
  setSketchUI(true);
  dim?.hide();                  // 必须收起尺寸手柄，否则它会挡住画布的触摸
  viewer.clearHighlight();
  viewer.clearSketchLines();
  showPicker(null);
  viewer.setSketchLines(sketch.toLines(), null);
  faceSketchPlane();
  setStats(`草图模式（${sketch.label}）· 拖动绘制矩形/圆，点「完成」拉伸`);
}

function enterSketch() {
  if (mode === "sketch") return;
  if (selectedFaceId == null) {
    setStats("请先点选一个实体面；或打开「基准面」后点 XYZ 平面，在世界坐标系上画草图");
    return;
  }
  try { beginSketch(new SketchSession(shape, selectedFaceId)); }
  catch (e) { setStats("无法在此面建立草图：" + (e?.message || e)); }
}

/** 在世界基准面上建草图 */
function enterSketchOnPlane(plane) {
  if (mode === "sketch") return;
  try {
    beginSketch(new SketchSession(shape, null, {
      origin: plane.origin.clone(),
      normal: plane.normal.clone(),
      xDir: plane.xDir.clone(),
      name: plane.name,
      occtPlane: OPS.occtPlaneByName(plane.name),
    }));
  } catch (e) { setStats("无法在基准面建立草图：" + (e?.message || e)); }
}

function exitSketch() {
  setPlanarMode(false, true);
  mode = "select";
  sketch = null;
  drawing = null;
  awaitingExtrude = false;
  viewer.clearPreviewWire();                          // 清掉黄色预览线框
  snap.clear(); snapGuides = []; drawSnapOverlay();   // 清掉捕捉标记，别留在屏幕上
  dimEntity = null;
  $("dimPanel")?.classList.add("hidden");
  dim?.hide();
  setSketchUI(false);
  viewer.clearSketchLines();
  viewer.cam.resetUp();
  // 恢复到等轴测斜视，让用户立刻看到 3D 结果（否则会停在俯视，像一张平面图）
  viewer.cam.az = 42 * Math.PI / 180;
  viewer.cam.el = 26 * Math.PI / 180;
  setMode("select");
  refresh({ fit: true });
}

/** 把相机重新摆回正对草图平面 */
function faceSketchPlane() {
  if (!sketch) return;
  // 进草图就切平面模式：视角锁正、单指平移不旋转 —— 画图时手指不会把视角转跑
  setPlanarMode(true, true);
  viewer.cam.frameNormal(sketch.normal, sketch.xDir);
  const bb = viewer.bbox;
  if (bb) {
    const size = bb.getSize(new THREE.Vector3());
    // 竖屏画布的水平视场更窄，按宽高比增加距离，保留原草图中心。
    viewer.cam.dist = (Math.max(size.x, size.y, size.z) * 1.9 + 10) / Math.min(1, viewer.camera.aspect);
    viewer.cam.target.copy(sketch.origin);
    viewer.cam.update();
  }
  viewer.invalidate();
  setStats("已正视草图平面");
}

function syncSketchToolUI() {
  for (const b of document.querySelectorAll("#sketchbar button")) {
    if (["rect", "circle", "line", "dim", "ref", "offset"].includes(b.dataset.sact)) {
      b.classList.toggle("on", b.dataset.sact === sketchTool);
    }
    if (b.dataset.sact === "snap") b.classList.toggle("on", snap.enabled);
  }
}

// 直线工具的橡皮筋：手指在画布上移动（但没在拖动旋转）时更新光标点
// 节流到 ~30fps：每次移动都要投影一遍所有捕捉候选点，平板上太密会拖慢渲染
let _snapMoveTs = 0;
canvas.addEventListener("pointermove", (e) => {
  if (mode !== "sketch" || sketchTool !== "line" || !sketch?.draft) return;
  if (viewer.cam.pointers.size > 0) return;      // 正在旋转相机时不画
  const now = performance.now();
  if (now - _snapMoveTs < 33) return;
  _snapMoveTs = now;
  const p = updateSnap(e.clientX, e.clientY);
  if (p) { sketch._cursor = p; redrawSketch(); }
});

function redrawSketch(preview = null) {
  if (!sketch) return;
  // 被选中的轮廓用黄色单独画出来（SolidWorks 里选中的轮廓也是变色高亮）
  const hl = sketch.linesOf(sketch.selected);
  if (sketchTool === "line") {
    viewer.setSketchLines(sketch.toLinesWithDraft(sketch._cursor || null), hl);
  } else {
    viewer.setSketchLines(sketch.toLines(), hl && hl.length ? hl : (preview ? sketch.lineOf(preview) : null));
  }
  // 尺寸标注画在覆盖层上，几何一变就得跟着重画（否则标注会停在旧位置）
  drawSnapOverlay();
}

/** 直线工具：点一下落一个点 */
/**
 * 直线工具点一下。
 *
 * 行为要点（用户实测反馈后改的）：
 *   **一条直线画两个点就收尾**。再点别处是**新的一条独立直线**，
 *   而不是以上一个端点为起点无限连下去 —— 之前那种"永远在续画"的手感，
 *   想画两条分开的线时非常别扭。
 *   想连续画折线/多边形：**点在上一条线的端点附近**（2mm 内）就会接着续；
 *   点回起点附近仍可闭合成多边形。
 */
const LINE_CHAIN_TOL = 2.0;

/** 找离 p 最近的「已有端点」（直线工具起笔时判断是否为连锁） */
function lineEndpointNear(p, tol = LINE_CHAIN_TOL) {
  let best = null, bd = tol;
  sketch.entities.forEach((e, i) => {
    const pts = e.kind === "polyline" ? e.pts
      : e.kind === "rect" ? [[e.c[0] - e.w / 2, e.c[1] - e.h / 2], [e.c[0] + e.w / 2, e.c[1] - e.h / 2],
                             [e.c[0] + e.w / 2, e.c[1] + e.h / 2], [e.c[0] - e.w / 2, e.c[1] + e.h / 2]] : null;
    if (!pts || pts.length < 2 || e.ref) return;
    const cands = e.kind === "polyline"
      ? [[pts[0], false], [pts[pts.length - 1], true]]
      : [[pts[0], false], [pts[2], true]];       // 矩形取相邻两角
    for (const [q, fromEnd] of cands) {
      const d = Math.hypot(p.x - q[0], p.y - q[1]);
      if (d < bd) { bd = d; best = { e: i, fromEnd }; }
    }
  });
  return best;
}

function lineTap(p) {
  if (!sketch) return;
  if (!sketch.draft) {
    // 起笔前先看有没有贴着某个已有端点：贴着就把那条线**接过来**继续画，
    // 不然多边形永远闭不上（两点一条线的新规则会把连续折线砍掉）
    const near = lineEndpointNear(p);
    if (near) {
      sketch.chainFromEndpoint(near.e, near.fromEnd);
      setStats("从这条线的端点接着画 · 点回起点可闭合成多边形");
    } else {
      sketch.beginPolyline(p);
      setStats("直线：再点一下确定这条线的终点（贴着端点起笔可以接着画）");
    }
    redrawSketch();
    return;
  }
  const d0 = sketch.draft;
  const last = d0.pts[d0.pts.length - 1];
  const nearLast = Math.hypot(p.x - last[0], p.y - last[1]) < LINE_CHAIN_TOL;
  const r = sketch.addPolylinePoint(p);
  if (r === "closed") {
    const n = sketch.entities[sketch.entities.length - 1].pts.length;
    setStats(`已闭合多边形（${n} 个顶点）· 可继续画别的，或点「完成」拉伸`);
    redrawSketch();
    return;
  }
  if (r === "tooClose") {
    setStats("点得太近已忽略（重复点会让几何退化，实测体积会偏 0.013mm³）");
    return;
  }
  // 已经有两个点：够一条直线了。除非这次点是贴着上一个端点点的（想续画），否则收尾。
  const d = sketch.draft;
  if (d && d.pts.length >= 2 && !nearLast) {
    sketch.finishPolyline();
    setStats("已画好一条直线 · 再点一下开始新的一条（贴着它的端点点击就能接着画）");
    redrawSketch();
    return;
  }
  setStats(`折线：已 ${sketch.draft ? sketch.draft.pts.length : 0} 个点 · 点回起点闭合，或贴着端点继续`);
  redrawSketch();
}

/** 由当前拖动生成预览图形 */
function currentPreview() {
  if (!drawing) return null;
  const { start, cur } = drawing;
  if (sketchTool === "rect") {
    return {
      kind: "rect",
      c: [(start.x + cur.x) / 2, (start.y + cur.y) / 2],
      w: Math.abs(cur.x - start.x), h: Math.abs(cur.y - start.y),
    };
  }
  return { kind: "circle", c: [start.x, start.y], r: Math.hypot(cur.x - start.x, cur.y - start.y) };
}

function finishSketch() {
  if (!sketch) return;
  // 直线还没收尾的话先收尾（未闭合时内核会自动补一条回到起点的直线）
  if (sketch.draft) {
    const d = sketch.finishPolyline();
    redrawSketch();
    if (d) setStats(`未闭合的折线已收尾（${d.pts.length} 个顶点，内核自动补闭合）`);
  }
  // ★ 如果是从特征树点进来改草图的，就直接写回那个特征并重建，
  //    不进入"拉伸"流程 —— 否则会变成多加一个特征出来
  if (sketch._editTarget != null) {
    const t = sketch._editTarget;
    if (sketch.isEmpty) {
      setStats("草图不能是空的 —— 要么画点东西，要么点「取消」放弃这次修改");
      return;
    }
    commitSketchEdit(t);
    return;
  }
  if (!sketch || sketch.isEmpty) { setStats("还没有画任何轮廓，先在面上拖一个矩形或圆"); return; }
  awaitingExtrude = true;
  setContourPicking(false);       // 默认全选，并刷新"全部 N 个轮廓"提示
  $("sketchbar").classList.add("hidden");
  $("extrude").classList.remove("hidden");
  const n = sketch.contourCount;      // 实际参与拉伸的轮廓数（点选过就不是全部）
  $("extrInfo").textContent = `${n} 个轮廓`;
  // 在拉伸方向挂上尺寸标注：拖动即改深度，点数值可直接填
  showExtrudeDim();
  setStats("拉伸：拖动橙色手柄或点数值输入，然后选「加料」或「挖料」");
}

/** 拉伸方向的尺寸手柄（沿草图平面法向） */
function showExtrudeDim() {
  if (!sketch) return;
  const v = parseFloat($("extrDist").value) || 5;
  dim.show({
    anchor: sketch.origin.clone(),
    dir: sketch.normal.clone().normalize(),
    value: v,
    prefix: "",
    unit: "mm",
    min: 0.1,
    max: 500,
  });
  viewer.invalidate();
}

function cancelExtrude() {
  awaitingExtrude = false;
  viewer.clearPreviewWire();
  dim?.hide();
  $("extrude").classList.add("hidden");
  $("sketchbar").classList.remove("hidden");
}

/** 拖动拉伸手柄时的实时预览 */
/**
 * 拉伸预览线框：把草图轮廓沿法向平移 depth，再补上竖直棱线。
 *
 * **不碰几何内核** —— 以前拖动时每次都要重建实体 + 重新网格化（几十毫秒），
 * 现在只是把已有的一堆线段复制平移一遍，微秒级。
 * 这也是 SolidWorks 拖动时只显示黄色线框的原因。
 */
function extrudeWireframe(sk, depth, sign) {
  // 只画**会参与拉伸的那些轮廓**（点选模式下选中的），这样预览和结果一致
  const contours = sk.activeEntities || [];
  if (!contours.length) return null;
  const contoursArr = (_) => sk._lines(contours);
  const base = contoursArr();
  if (!base || !base.length) return null;
  const off = sk.normal.clone().normalize().multiplyScalar(depth * (sign || 1));
  const segs = [];
  const V = (i) => new THREE.Vector3(base[i], base[i + 1], base[i + 2]);
  for (let i = 0; i < base.length; i += 6) {
    const a = V(i), b = V(i + 3);
    const a2 = a.clone().add(off), b2 = b.clone().add(off);
    segs.push(a.x, a.y, a.z, b.x, b.y, b.z);          // 底面
    segs.push(a2.x, a2.y, a2.z, b2.x, b2.y, b2.z);    // 顶面
    segs.push(a.x, a.y, a.z, a2.x, a2.y, a2.z);       // 竖直棱线
    segs.push(b.x, b.y, b.z, b2.x, b2.y, b2.z);
  }
  return new Float32Array(segs);
}

function previewExtrude(v) {
  if (!sketch) return;
  // 只画线框，不重建实体 —— 拖动时不再跑内核
  viewer.setPreviewWire(extrudeWireframe(sketch, Math.abs(v), Math.sign(v) || 1));
  setStats(`拉伸 ${v.toFixed(1)} mm · 黄色线框是预览（选「加料」或「挖料」确认）`);
}

/**
 * 旋转凸台：草图轮廓绕一条竖直轴转出实体。
 *
 * 轴的位置：输入框填了就按填的（草图 2D 坐标的 x 值），没填就用轮廓最左边 ——
 * "从轴长出来"是最常见的回转体，所以这个默认值最省事。
 * 轮廓跨过轴时内核算不出来，这里翻成人话提示。
 */
function applyRevolve() {
  if (!sketch) return;
  const rawAng = parseFloat($("revAngle").value);
  const angle = (isFinite(rawAng) && rawAng !== 0) ? Math.abs(rawAng) : 360;
  const bb = sketch.bounds2D;
  if (!bb) { setStats("草图是空的，先画个轮廓"); return; }
  const rawAx = parseFloat($("revAxis").value);
  const axisX = isFinite(rawAx) ? rawAx : bb.minX;
  // 轴在轮廓中间 → 一定跨轴，提前给出人话提示（免得内核抛个看不懂的异常）
  const spans = axisX > bb.minX + 1e-6 && axisX < bb.maxX - 1e-6;
  const mayCross = bb.minX < axisX - 1e-9;

  const t0 = performance.now();
  let tool = null;
  try {
    tool = sketch.revolveSolid(angle, axisX);
  } catch (e) {
    setStats("⚠ " + (e?.message || e));
    return;
  }
  const ms = performance.now() - t0;
  const n = sketch.contourCount;
  // 第一个特征就是它本身；否则作为"凸台"融合进本体
  const first = !shape;
  try {
    shape = first ? tool : shape.fuse(tool);
  } catch (e) {
    setStats("旋转体合并失败：" + (e?.message || e));
    return;
  }
  const op = {
    type: "revolve",
    plane: sketch.planeDesc,
    entities: JSON.parse(JSON.stringify(sketch.entities)),
    selected: [...sketch.selected],
    constraints: JSON.parse(JSON.stringify(sketch.constraints)),
    dimNotes: JSON.parse(JSON.stringify(sketch.dimNotes || [])),   // 从动标注：存定义，重开时现算值
    angle,
    axisX,
  };
  awaitingExtrude = false;
  viewer.clearPreviewWire();
  exitSketch();
  commit("旋转", `${angle.toFixed(0)}° × ${n}轮廓`, "revolve", op);
  history[history.length - 1].toolShape = tool;
  setStats(`旋转凸台 ${angle.toFixed(0)}°（轴 x=${axisX.toFixed(2)}，${n} 个轮廓）· 用时 ${ms.toFixed(0)} ms`
    + (spans ? " · 提示：轴落在轮廓内部，可能会失败" : "")
    + (mayCross ? " · 提示：轮廓有部分在轴左侧，跨轴会失败" : ""));
}

/**
 * 扫掠：第一个轮廓当截面，**沿草图法向**扫出去，距离取第二个轮廓的尺寸。
 *
 * 几何原因：扫掠要求路径垂直于截面平面，而草图里所有轮廓都在同一平面 ——
 * 同草图里画不出垂直的路径。所以这里用"第二个轮廓"只取它的**长度**当扫掠距离，
 * 方向由草图法向决定（这也是平板上一画就成的最省事做法）。
 */
function applySweep() {
  if (!sketch) return;
  const ds = sketch.toDrawings();
  if (ds.length < 2) {
    setStats("扫掠需要两个轮廓：第一个当截面，第二个用它的长度当扫掠距离。请再画一个轮廓");
    return;
  }
  // 第二个轮廓的长度：取它在草图里的包围盒最大边
  const ent2 = sketch.activeEntities[1];
  let L = 20;
  if (ent2) {
    if (ent2.kind === "rect") L = Math.max(ent2.w, ent2.h);
    else if (ent2.kind === "circle") L = ent2.r * 2;
    else if (ent2.kind === "polyline" && ent2.pts.length >= 2) {
      const a = ent2.pts[0], b = ent2.pts[ent2.pts.length - 1];
      L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
  }
  const o = sketch.origin, nrm = sketch.normal;
  const t0 = performance.now();
  let solid = null;
  try {
    solid = F.sweepNormal(ds[0], L, [o.x, o.y, o.z], [nrm.x, nrm.y, nrm.z]);
  } catch (e) {
    setStats("⚠ " + (e?.message || e));
    return;
  }
  const ms = performance.now() - t0;
  let newShape;
  try { newShape = shape ? shape.fuse(solid) : solid; }
  catch (e) { setStats("扫掠体合并失败：" + (e?.message || e)); return; }
  const op = {
    type: "sweep",
    plane: sketch.planeDesc,
    entities: JSON.parse(JSON.stringify(sketch.entities)),
    selected: [...sketch.selected],
    constraints: JSON.parse(JSON.stringify(sketch.constraints)),
    dimNotes: JSON.parse(JSON.stringify(sketch.dimNotes || [])),   // 从动标注：存定义，重开时现算值
    length: L,
  };
  awaitingExtrude = false;
  viewer.clearPreviewWire();
  shape = newShape;
  exitSketch();
  commit("扫掠", `距离 ${L.toFixed(1)}mm`, "sweep", op);
  history[history.length - 1].toolShape = solid;
  setStats(`扫掠完成 · 沿法向 ${L.toFixed(1)} mm · 用时 ${ms.toFixed(0)} ms`);
}

/** 放样：所有选中的轮廓按顺序过渡 */
function applyLoft() {
  if (!sketch) return;
  const drawings = sketch.toDrawings();
  if (drawings.length < 2) {
    setStats("放样至少要两个截面（比如两个大小不同的矩形，放在不同的高度）");
    return;
  }
  const wires = drawings.map((d) => d.wire).filter(Boolean);
  if (wires.length < 2) { setStats("放样：有截面取不到轮廓线"); return; }
  const t0 = performance.now();
  let solid = null;
  try {
    solid = F.loftWires(wires);
  } catch (e) {
    setStats("⚠ " + (e?.message || e));
    return;
  }
  const ms = performance.now() - t0;
  let newShape;
  try { newShape = shape ? shape.fuse(solid) : solid; }
  catch (e) { setStats("放样体合并失败：" + (e?.message || e)); return; }
  const op = {
    type: "loft",
    plane: sketch.planeDesc,
    entities: JSON.parse(JSON.stringify(sketch.entities)),
    selected: [...sketch.selected],
    constraints: JSON.parse(JSON.stringify(sketch.constraints)),
    dimNotes: JSON.parse(JSON.stringify(sketch.dimNotes || [])),   // 从动标注：存定义，重开时现算值
  };
  awaitingExtrude = false;
  viewer.clearPreviewWire();
  shape = newShape;
  exitSketch();
  commit("放样", `${wires.length} 个截面`, "loft", op);
  history[history.length - 1].toolShape = solid;
  setStats(`放样完成 · ${wires.length} 个截面 · 用时 ${ms.toFixed(0)} ms`);
}

// ---------------------------------------------------------------- 阵列 / 镜像
/**
 * 找出"最近一个能阵列的特征体"。
 *
 * 为什么要单独存：阵列要复制的是**某个特征长出来的那块材料**，不是整个零件。
 * 累计实体（history[i].shape）做不到这件事 —— 复制它等于把整个零件堆一遍。
 * 所以生成型特征（拉伸/旋转/扫掠/放样）在 commit 时会把自己产出的实体挂在
 * `toolShape` 上，阵列/镜像直接用它。
 */
function lastToolShape() {
  for (let i = hIndex; i >= 0; i--) {
    const h = history[i];
    if (h.toolShape && !h.suppressed) return {
      idx: i, tool: h.toolShape, label: h.label,
      operation: h.op?.operation === "cut" || (h.op?.type === "extrude" && h.op.depth < 0) ? "cut" : "fuse",
    };
  }
  return null;
}

function applyPattern(kind) { openPatternEditor(kind); }
function applyMirror() { openPatternEditor("mirror"); }

let patternSession = null;
const patternPanel = createPatternPanel({
  onPreview: () => evaluatePatternEditor(false), onApply: () => evaluatePatternEditor(true),
  onCancel: () => { closePatternEditor(); setStats("已取消阵列/镜像编辑，模型保持原样"); },
  onChange: () => {
    if (patternSession?.previewing) { shape = patternSession.shape; refresh(); patternSession.previewing = false; }
    patternPanel.status("参数已改变，请重新预览或应用。");
  },
});

function closePatternEditor(restore = true) {
  if (!patternSession) return;
  if (restore && patternSession.previewing && history === patternSession.history && hIndex === patternSession.index) { shape = patternSession.shape; refresh(); }
  patternSession = null;
  patternPanel.close();
}

function openPatternEditor(kind, editIndex = null) {
  if (editIndex != null && (!Number.isInteger(editIndex) || !["pattern", "mirror"].includes(history[editIndex]?.op?.type))) {
    setStats("阵列或镜像特征不存在，请重新选择"); return;
  }
  if (mode === "sketch") { setStats("请先完成草图并生成实体，再使用工具栏的阵列或镜像"); return; }
  if (!shape || appMode !== "model") { setStats("请先创建一个实体特征"); return; }
  cancelEdit(true);
  if (["fillet", "chamfer", "shell"].includes(mode)) exitEdgeMode();
  if (mode === "link") exitLinkMode();
  if (mode === "smartdim") cancelSmartDim();
  if (editIndex != null && editIndex > hIndex) gotoStep(editIndex);
  if (editIndex != null && history[editIndex]?.suppressed) { setStats("请先解除这个特征的压制，再编辑参数"); return; }
  setMode("select");
  const beforeIndex = editIndex ?? (hIndex + 1);
  const sources = history.slice(0, beforeIndex).flatMap((h, index) => h.toolShape && !h.suppressed
    ? [{ index, name: featureDisplayName(h, index) }] : []);
  if (!sources.length) { setStats("先创建草图拉伸、旋转等特征，再选择要阵列/镜像的源特征"); return; }
  const source = sources.at(-1).index;
  const baseShape = editIndex == null ? shape : history[editIndex - 1]?.shape;
  const draft = editIndex == null
    ? (kind === "mirror" ? { type: "mirror", plane: "YZ", at: "world", source }
      : { type: "pattern", kind, source, count: 4, spacing: 15, angle: 360 })
    : history[editIndex].op;
  try {
    const op = normalizePatternOp(draft, baseShape);
    patternSession = { history, index: hIndex, shape, baseShape, editIndex, previewing: false };
    selectFace(null);
    patternPanel.open({ op, sources, editing: editIndex != null });
    setStats("选择源特征并设置参数；预览不写入历史，应用后可从特征树继续编辑");
  } catch (error) { patternPanel.status(error.message, true); setStats(error.message); }
}

function evaluatePatternEditor(apply) {
  const session = patternSession;
  if (!session) return;
  if (history !== session.history || hIndex !== session.index) { closePatternEditor(false); setStats("历史位置已变化，请重新打开阵列或镜像"); return; }
  if (session.previewing) { shape = session.shape; refresh(); session.previewing = false; }
  const t0 = performance.now();
  try {
    const draft = patternPanel.read();
    const source = history[draft.source];
    const limit = session.editIndex ?? (hIndex + 1);
    if (!source?.toolShape || source.suppressed || draft.source >= limit) throw new Error("源特征已失效，请重新选择");
    draft.operation = source.op?.operation === "cut" || (source.op?.type === "extrude" && source.op.depth < 0) ? "cut" : "fuse";
    const op = normalizePatternOp(draft, session.baseShape);
    const result = session.editIndex == null ? applyPatternOp(session.baseShape, source.toolShape, op)
      : rebuild(history, hIndex, { [session.editIndex]: op });
    if (!apply) {
      shape = result.shape; session.previewing = true; refresh();
      patternPanel.status(`预览完成 · ${draft.operation === "cut" ? "挖料" : "加料"} · ${(performance.now() - t0).toFixed(0)} ms，尚未写入历史。`);
      return;
    }
    shape = result.shape;
    if (session.editIndex == null) {
      commit(op.type === "mirror" ? "镜像" : op.kind === "linear" ? "线性阵列" : "圆周阵列", detailOf(op), op.type, op);
      history[hIndex].toolShape = result.tool;
    } else {
      history[session.editIndex].op = op;
      history[session.editIndex].detail = detailOf(op);
      acceptRebuild(result);
    }
    closePatternEditor(false);
    selectFace(null); refresh(); renderTree();
    setStats(`${session.editIndex == null ? "已创建" : "已更新"}${op.type === "mirror" ? "镜像" : "阵列"} · ${detailOf(op)} · 参数可从特征树再次编辑`);
  } catch (error) {
    shape = session.shape; refresh();
    patternPanel.status(`${error.message} · 模型未改动`, true);
  }
}

function applyExtrude(sign) {
  if (!sketch) return;
  // 以输入框为准（拖动手柄时会实时同步到输入框），两者始终一致
  const raw = parseFloat($("extrDist").value);
  const v = (isFinite(raw) && raw > 0) ? raw : (dim?.value ?? 5);
  if (!isFinite(v) || v <= 0) { setStats("请输入正的拉伸深度"); return; }
  const depth = v * sign;
  const t0 = performance.now();
  try {
    // 加料时给 0.002 的重叠，避免与本体共面退化；挖料给 0 保持尺寸精确
    shape = sketch.apply(depth, sign > 0 ? 0.002 : 0);
  } catch (e) {
    setStats("拉伸失败：" + (e?.message || e));
    return;
  }
  const ms = performance.now() - t0;
  const n = sketch.contourCount;      // 实际参与拉伸的轮廓数（点选过就不是全部）
  // 重放要用的定义，必须在 exitSketch() 把草图清掉之前抓下来
  const op = {
    type: "extrude",
    plane: sketch.planeDesc,
    entities: JSON.parse(JSON.stringify(sketch.entities)),
    // 记住点选了哪几个轮廓 —— 不存的话重放（改上游参数 / 重新打开工程）
    // 会退化成"全部轮廓"，结果和当初不一样
    selected: [...sketch.selected],
    constraints: JSON.parse(JSON.stringify(sketch.constraints)),
    dimNotes: JSON.parse(JSON.stringify(sketch.dimNotes || [])),   // 从动标注：存定义，重开时现算值   // 尺寸约束也参与重放
    depth,
    grow: sign > 0 ? 0.002 : 0,
  };
  awaitingExtrude = false;
  viewer.clearPreviewWire();
  const tool = sketch._lastTool;
  $("extrDist").value = String(+v.toFixed(2));    // 把手柄调出来的值同步回输入框
  exitSketch();
  commit("拉伸", `${depth > 0 ? "+" : ""}${depth.toFixed(1)}mm × ${n}轮廓`, "extrude", op);
  if (tool) history[history.length - 1].toolShape = tool;   // 供阵列/镜像复用
  setStats(`草图拉伸 ${depth > 0 ? "+" : ""}${depth.toFixed(1)} mm（${n} 个轮廓）· 用时 ${ms.toFixed(0)} ms · ` + $("stats").textContent);
}

// ---------------------------------------------------------------- 拾取
viewer.onPick = (faceId, point, pt) => {
  if (patternSession) { setStats("请先应用或取消阵列/镜像，再选择模型上的面"); return; }
  if (mode === "sketch") {
    // 拉伸阶段的轮廓点选：点草图上的轮廓切换选中
    if (awaitingExtrude && contourPicking && sketch && pt) {
      const p = sketch.screenTo2D(pt.x, pt.y, viewer.camera, canvas);
      if (p) contourPick(p);
      return;
    }
    // 直线工具用「点击落点」；尺寸/引用/等距都用「点击选图元」
    if (sketchTool === "line" && sketch && pt) {
      const p = updateSnap(pt.x, pt.y);
      if (p) lineTap(p);
    } else if (sketchTool === "select") {
      // 选择工具：只拾取，不新建。点一下给出提示（拖动走特征点那套）
      const hit = pt ? featurePointAt(pt.x, pt.y) : null;
      if (hit) {
        setStats(`选中了${hit.kind === "center" ? "圆心" : "端点"}所在的图元 · 按住拖动可移动，标尺寸时直接点它`);
      }
    } else if (sketchTool === "dim" && sketch && pt) {
      const p = sketch.screenTo2D(pt.x, pt.y, viewer.camera, canvas);
      if (p) smartDimPickPoint(p, pt);
    } else if (relOn && sketch && pt) {
      const p = sketch.screenTo2D(pt.x, pt.y, viewer.camera, canvas);
      if (p) relPickPoint(p);
    } else if (xfMode && sketch && pt) {
      const p = sketch.screenTo2D(pt.x, pt.y, viewer.camera, canvas);
      if (p) xformPickPoint(p);
    } else if (sketchTool === "ref" && sketch && pt) {
      // 先看有没有点中边，再退回面
      const e = viewer.pickEdgeAt(pt.x, pt.y);
      if (e) { refEdge(e); return; }
      const h = viewer.pickAt(pt.x, pt.y);
      if (h) { refFace(h.faceId); return; }
      setStats("没点中边或面 —— 靠近模型的棱边走");
    } else if (sketchTool === "offset" && sketch && pt) {
      const p = sketch.screenTo2D(pt.x, pt.y, viewer.camera, canvas);
      if (p) offsetPick(p);
    }
    return;
  }
  if (mode === "smartdim") { smartDimPick(faceId); return; }
  if (mode === "link") { linkPick(faceId, pt); return; }
  // ---- 本轮新接的面拾取：孔向导 / 移动面 / 曲面选面共用同一套「点一个面」流程 ----
  if (mode === "pickface") { handleFacePick(faceId, point); return; }
  if (mode === "hole") {
    // 孔向导面板开着时点面 = 换孔位（连续打孔），不改变已填的孔型与尺寸
    if (faceId == null) { setStats("没点中实体：孔要落在模型的一个平面面上"); return; }
    if (!faceIsPlanar(faceId)) { setStats("孔向导只接受平面：这个面是曲面/圆柱面，请换一个平面面"); return; }
    if (!point) { setStats("拾取点丢失，请重新点一次面"); return; }
    const hi = OPS.faceInfo(shape, faceId);
    if (!hi) { setStats("这个面读不出几何信息，请重新点一次"); return; }
    // 孔心取手指点中的位置（面中心可能正好落在已有的孔里）
    holeSel = { at: [point.x, point.y, point.z], normal: hi.normal.slice() };
    viewer.highlightFace(faceId);
    updateHoleHint();
    setStats(`孔位已更新 · 孔心 (${holeSel.at.map((v) => v.toFixed(1)).join(", ")}) · 点「应用」打孔`);
    return;
  }
  // 圆角/倒角点的是「边」不是面
  if (mode === "fillet" || mode === "chamfer") {
    const e = pt ? viewer.pickEdgeAt(pt.x, pt.y) : null;
    if (e) toggleEdge(e);
    else setStats("没点到棱边，手指靠近棱线再点一次");
    return;
  }
  // 没点中实体时，看有没有点中世界基准面 —— 点了就直接在它上面开草图
  if (faceId == null && datum?.visible && pt) {
    const pl = datum.pick(pt.x, pt.y);
    if (pl) { enterSketchOnPlane(pl); return; }
  }
  // 面板型特征命令（布尔/分割/加厚/曲面）里点模型不算选面：
  // 给一句解释，别让人以为「点了没反应」是触摸坏了
  if (FEATURE_MODE_LABEL[mode]) {
    setStats(`正在「${FEATURE_MODE_LABEL[mode]}」命令里 · 先在右上浮层点「应用」或「取消」，再选面`);
    return;
  }
  if (mode === "select" || mode === "pushpull" || mode === "shell") selectFace(faceId);
};

// ---------------------------------------------------------------- 圆角 / 倒角 / 抽壳
function enterEdgeMode(kind) {
  dim?.hide();
  faceClass = null;
  curvedDriver = null;
  edgeKind = kind;
  mode = kind;
  edgeSel = [];
  $("picker")?.classList.add("hidden");   // 命令位让给圆角/倒角参数条
  $("edgeTag").textContent = kind === "fillet" ? "圆角" : "倒角";
  $("edgeVal").value = kind === "fillet" ? "2" : "1";
  $("toolbar").classList.add("hidden");
  $("edgebar").classList.remove("hidden");
  showPicker(null);
  viewer.clearHighlight();
  viewer.highlightEdges([]);
  // 给每条边预计算圆角信息：圆心方向挂手柄、两相邻面法向用来画"切边"预览
  try {
    const sets = OPS.edgePointSets(shape);
    for (const s of sets) {
      if (!s.mid) continue;
      const info = OPS.edgeFilletInfo(shape, s.mid);
      if (info) { s.dir = info.dir; s.n1 = info.n1; s.n2 = info.n2; s.tel = info.t; }
    }
    viewer.setEdgeData(sets);
  } catch (_) {}
  setStats(`${kind === "fillet" ? "圆角" : "倒角"}模式 · 在模型上点选棱边（可多选，再点一次取消），然后拖动橙色的圆心手柄调大小`);
}

function enterShellMode() {
  dim?.hide();
  faceClass = null;
  curvedDriver = null;
  mode = "shell";
  selectedFaceId = null;
  selSnap = null;
  $("picker")?.classList.add("hidden");   // 命令位让给抽壳参数条，别被面信息面板盖住
  $("edgeTag").textContent = "抽壳";
  $("edgeVal").value = "2";
  $("toolbar").classList.add("hidden");
  $("edgebar").classList.remove("hidden");
  setStats("抽壳模式 · 先点选要「去掉」的那个面（它会变成开口），再输入壁厚点「应用」");
}

function exitEdgeMode() {
  dim?.hide();
  faceClass = null;
  curvedDriver = null;
  mode = "select";
  edgeSel = [];
  viewer.clearPreviewWire();     // 清掉黄色预览线，别留在屏幕上
  $("edgebar").classList.add("hidden");
  $("toolbar").classList.remove("hidden");
  viewer.highlightEdges([]);
  setMode("select");
}

function toggleEdge(e) {
  const eq = (a, b) => a.mid && b.mid && a.mid.every((v, i) => Math.abs(v - b.mid[i]) < 0.02);
  const i = edgeSel.findIndex((x) => eq(x, e));
  if (i >= 0) edgeSel.splice(i, 1);
  else edgeSel.push(e);
  viewer.highlightEdges(edgeSel);
  if (edgeSel.length) {
    showEdgeDim();
    setStats(`已选 ${edgeSel.length} 条边 · 拖动橙色圆心调大小，或点数值直接输入`);
  } else {
    dim?.hide();
    setStats("已清空边的选择");
  }
}

function readEdgeValue() {
  const v = parseFloat($("edgeVal").value);
  if (!isFinite(v) || v <= 0) { setStats("请输入一个正数"); return null; }
  return v;
}

function applyEdgeTool() {
  const v = readEdgeValue();
  if (v == null) return;
  if (!edgeSel.length) { setStats("请先在模型上点选棱边"); return; }
  const label = edgeKind === "fillet" ? "圆角" : "倒角";
  const t0 = performance.now();
  try {
    const mids = edgeSel.map((e) => e.mid);
    // 引用要在动手之前记：操作一做完拓扑就全变了
    const edgeRefs = makeEdgeRefs(shape, mids);
    const r = edgeKind === "fillet"
      ? OPS.filletEdges(shape, mids, v)
      : OPS.chamferEdges(shape, mids, v);
    if (r.ok !== mids.length) throw new Error("部分棱边无法完成，模型未改动；请缩小尺寸或减少选边");
    shape = r.shape;
    const ms = performance.now() - t0;
    exitEdgeMode();
    refresh();
    commit(label, `${edgeKind === "fillet" ? "R" : "C"}${v} × ${r.ok}边`, edgeKind,
      { type: edgeKind, edgeRefs, radius: v });
    setStats(`${label} ${v}mm 作用于 ${r.ok} 条边` +
      (r.failed ? `（${r.failed} 条失败已跳过）` : "") +
      ` · 用时 ${ms.toFixed(0)} ms · ` + $("stats").textContent);
  } catch (e) {
    setStats(`${label}失败：` + (e?.message || e));
  }
}

function applyShell() {
  const v = readEdgeValue();
  if (v == null) return;
  if (selectedFaceId == null) { setStats("请先点选要开口的那个面"); return; }
  const t0 = performance.now();
  // 开口面的引用要在抽壳之前记
  const fi = OPS.faceInfo(shape, selectedFaceId);
  const faceRef = fi ? { center: fi.center.slice(), normal: fi.normal.slice() } : null;
  try {
    shape = OPS.shellByFace(shape, selectedFaceId, v);
    const ms = performance.now() - t0;
    exitEdgeMode();
    refresh();
    commit("抽壳", `壁厚 ${v}mm`, "shell",
      faceRef ? { type: "shell", faceRef, thickness: v } : null);
    setStats(`抽壳 壁厚 ${v}mm · 用时 ${ms.toFixed(0)} ms · ` + $("stats").textContent);
  } catch (e) {
    setStats(e?.message || String(e));   // ops 抛的消息里已含场景前缀，不再叠加
  }
}

// ---------------------------------------------------------------- 历史 / 特征树
// 撤销、重做、特征树三者共用同一条历史：history[i].shape 就是第 i 步的实体。
// 点特征树的任意一项 = 跳到那一步（等价于连按若干次撤销/重做）。
let history = [];
let hIndex = -1;
// Feature definitions form a dependency graph: truncating its first 60 nodes loses the base.

const FEATURE_ICON = {
  base: "▣", sketch: "✎", extrude: "⬒", pushpull: "⇕",
  fillet: "◜", chamfer: "◺", shell: "▢",
  // 脚本/新特征（基础形体、螺旋、扫掠旋转放样、阵列镜像、推拉的选择器版）
  primitive: "◆", helix: "➰", revolve: "↻", sweep: "∼", loft: "⌒",
  pattern: "⁘", mirror: "⇋", move3d: "✥", pushface: "⇕",
  // 本轮接上 UI 的 8 个特征（C 批 solid-features / D 批 surface）
  hole: "◎", combine: "⊕", split_plane: "⊟", offset_face: "⇥", thicken: "▤",
  surface_offset: "≋", surface_thicken: "▥", surface_fill: "◗", surface_stitch: "⧉",
};

/**
 * 哪些步骤的参数可以改（改完重放）。
 * 只有这些类型记了「可重放的定义」，其余的老历史只能回退不能改。
 */
const EDITABLE = {
  pushpull: { key: "dist", label: "推拉距离", unit: "mm", step: 0.5 },
  extrude: { key: "depth", label: "拉伸深度", unit: "mm", step: 0.5 },
  fillet: { key: "radius", label: "圆角半径", unit: "mm", step: 0.5 },
  chamfer: { key: "radius", label: "倒角距离", unit: "mm", step: 0.5 },
  shell: { key: "thickness", label: "壁厚", unit: "mm", step: 0.5 },
};

/** 按 op 重新生成特征树上的参数文字 */
function detailOf(op) {
  switch (op?.type) {
    case "base": return `60 × 40 × 8 mm · 中心孔 Ø${((op.holeRadius ?? 6) * 2).toFixed(2)}`;
    case "pattern": return `${op.count}份 · ${op.kind === "linear" ? `${op.spacing ?? "自动"}mm 间距` : `${op.angle ?? 360}°分布`}`;
    case "mirror": return `${op.plane} · ${op.at === "offset" ? `偏移 ${op.offset}mm` : op.at === "bboxMin" ? "最小边关联" : op.at === "bboxMax" ? "最大边关联" : "世界原点"}`;
    case "pushpull": return `${op.dist > 0 ? "+" : ""}${op.dist.toFixed(1)}mm`;
    case "extrude": {
      const cnt = (op.selected && op.selected.length) ? op.selected.length : (op.entities?.length ?? "?");
      return `${op.depth > 0 ? "+" : ""}${op.depth.toFixed(1)}mm × ${cnt}轮廓` +
             ((op.selected && op.selected.length) ? "（点选）" : "");
    }
    case "fillet":
    case "chamfer": return `${op.type === "fillet" ? "R" : "C"}${op.radius} × ${op.edgeRefs?.length ?? 0}边`;
    case "shell": return `壁厚 ${op.thickness}mm`;
    default: return "";
  }
}

let editingStep = null;
let featPreviewShape = null;      // 预览时暂存原始实体，取消时恢复
let featPreviewing = false;

/** 各特征类型的属性面板分组名（对齐 SolidWorks 的叫法） */
const FEAT_GROUP = {
  extrude: "方向 1",
  pushpull: "方向 1",
  fillet: "圆角参数",
  chamfer: "倒角参数",
  shell: "厚度",
};

function editStep(i) {
  const op = history[i]?.op;
  if (["pattern", "mirror"].includes(op?.type)) { openPatternEditor(op.kind || "mirror", i); return; }
  closePatternEditor();
  const meta = op && EDITABLE[op.type];
  if (!meta) { setStats("这一步没有可改的参数（只有记下了定义的那几步能改）"); return; }
  // 先恢复到目标特征，避免把尚未计算的目标当作 redo 分支丢掉。
  if (i > hIndex) gotoStep(i);
  // 换目标先把上一次的预览收干净，否则会把旧预览的实体留在屏幕上
  if (featPreviewing) cancelEdit(true);
  editingStep = i;
  $("featIco").textContent = history[i].icon || "⬒";
  $("featTitle").textContent = featureDisplayName(history[i], i);
  $("featGroupName").textContent = FEAT_GROUP[op.type] || "参数";
  $("featLabel").textContent = `${meta.label}（${meta.unit}）`;
  $("featVal").value = String(op[meta.key]);
  $("featVal").step = String(meta.step);
  $("featEye").classList.remove("on");
  $("featHint").textContent = "改完点 👁 先预览，✔ 确认写入；✖ 放弃";
  $("featPanel").classList.remove("hidden");
}

function closeEdit() {
  editingStep = null;
  featPreviewing = false;
  $("featPanel")?.classList.add("hidden");
  $("featEye")?.classList.remove("on");
}

/**
 * 预览：按输入框的新值重放一遍看效果，但**不写进历史**。
 * 这样用户可以先看看"改成 22mm 是什么样"再决定要不要确认 ——
 * SolidWorks 的属性管理器就是这个交互。
 */
function previewEdit() {
  if (editingStep == null) return;
  const op = history[editingStep].op;
  const meta = EDITABLE[op.type];
  if (!meta) return;
  const v = parseFloat($("featVal").value);
  if (!isFinite(v)) { setStats("请输入一个数字"); return; }
  if ((op.type === "fillet" || op.type === "chamfer" || op.type === "shell") && v <= 0) {
    setStats(`${meta.label}必须是正数`); return;
  }
  const newOp = { ...op, [meta.key]: v };
  try {
    const r = rebuild(history, hIndex, { [editingStep]: newOp });
    if (!featPreviewing) featPreviewShape = shape;   // 只在第一次预览时备份
    featPreviewing = true;
    shape = r.shape;
    selectedFaceId = null; selSnap = null;
    viewer.clearHighlight();
    refresh();
    $("featEye").classList.add("on");
    setStats(`👁 预览：${meta.label} ${v}${meta.unit} · 面 ${shape.faces.length} · 点 ✔ 确认，或 ✖ 放弃`);
  } catch (e) {
    const msg = (e instanceof RefLost) ? e.message : (e?.message || e);
    setStats(`预览失败：${msg} · 模型未改动`);
  }
}

/** 取消：把预览的实体换回去，什么都不写 */
function cancelEdit(silent = false) {
  closePatternEditor();
  if (featPreviewing && featPreviewShape) {
    shape = featPreviewShape;
    viewer.clearHighlight();
    refresh();
  }
  featPreviewShape = null;
  featPreviewing = false;
  closeEdit();
  if (!silent) setStats("已放弃这次修改（模型回到原样）");
}

/**
 * 确定：写进 op 并从起始零件重放整条链。
 * 重放的每一步结果都要回填历史，否则撤销回去会拿到过期实体。
 */
function applyEdit() {
  const i = editingStep;
  if (i == null) return;
  const op = history[i]?.op;
  const meta = op && EDITABLE[op.type];
  if (!meta) return;
  const v = parseFloat($("featVal").value);
  if (!isFinite(v)) { setStats("请输入一个数字"); return; }
  if ((op.type === "fillet" || op.type === "chamfer" || op.type === "shell") && v <= 0) {
    setStats(`${meta.label}必须是正数`);
    return;
  }
  const newOp = { ...op, [meta.key]: v };
  const t0 = performance.now();
  try {
    const r = rebuild(history, hIndex, { [i]: newOp });
    history[i].op = newOp;
    history[i].detail = detailOf(newOp);
    acceptRebuild(r);
    shape = r.shape;
    selectedFaceId = null;
    selSnap = null;
    dim?.hide();
    viewer.clearHighlight();
    viewer.clearSketchLines();
    viewer.setEdgeData([]);
    refresh();
    renderTree();
    const ms = performance.now() - t0;
    featPreviewShape = null;
    featPreviewing = false;
    closeEdit();
    setStats(`已将「${featureDisplayName(history[i], i)}」的${meta.label}改为 ${v}${meta.unit} · ` +
      `重放 ${r.steps} 步 用时 ${ms.toFixed(0)} ms · 面 ${shape.faces.length} · ` +
      $("stats").textContent.replace(/^面 \d+ · /, ""));
  } catch (e) {
    // 关键：失败时模型保持原样，绝不半途改掉
    if (e instanceof RefLost) {
      setStats(`改不了：${e.message}。出问题的是第 ${e.stepIndex + 1} 步「${e.stepLabel}」· 模型未改动`);
    } else {
      setStats("重放失败：" + (e?.message || e) + " · 模型未改动");
    }
    return;                     // 不关面板，让用户改回一个能用的值
  }
}

/**
 * 每次改完实体都调它：把当前状态记进一步。
 * op 是这一步的「参数化定义」—— 有了它才能改历史参数后重放；
 * 只有快照的话就只能回退，改不了任何历史尺寸。
 */
function commit(label, detail = "", type = "base", op = null) {
  history = history.slice(0, hIndex + 1);
  history.push({ shape, label, detail, icon: FEATURE_ICON[type] || "▪", op });
  markSnapshot(history[history.length - 1]);
  hIndex = history.length - 1;
  renderTree();
}

/** 跳到历史中的某一步 */
/**
 * 删除历史里的第 i 步，然后把剩下的重放一遍。
 *
 * 注意"删除起始零件"要特判：后面的拉伸/旋转都是拿它当毛坯的，
 * 删了它重放必然失败 —— 这种情况直接清空整个模型更符合直觉。
 */
/**
 * 压制 / 解除压制某一步（SolidWorks 的 Suppress）。
 * 和删除的区别：**定义留着**，只是这次重放时跳过它，随时能解压回来。
 * 草图子节点上的眼睛则是控制"草图线显不显示"，不动几何。
 */
function toggleSuppress(i) {
  if (!history.length || i < 0 || i >= history.length) return;
  if (i === 0) { setStats("首个特征是建模基础，不能压制"); return; }
  if (mode === "sketch") { setStats("请先完成或取消草图，再压制特征"); return; }
  cancelEdit(true);
  if (["fillet", "chamfer", "shell"].includes(mode)) exitEdgeMode();
  else if (mode === "link") exitLinkMode();
  else if (mode === "smartdim") cancelSmartDim();
  const h = history[i];
  const want = !h.suppressed;
  const backupShape = shape;
  h.suppressed = want;
  try {
    const r = rebuild(history, history.length - 1);
    shape = r.shape;
    hIndex = history.length - 1;
    cacheRebuild(history, r);
    selectFace(null);
    refresh({});
    renderTree();
    setStats(want
      ? `已压制「${featureDisplayName(h, i)}」· 这一步暂时不参与计算（再点眼睛可解压）`
      : `已解压「${featureDisplayName(h, i)}」· 重新参与计算`);
  } catch (e) {
    h.suppressed = !want;      // 回滚
    shape = backupShape;
    refresh({});
    renderFeatTree();
    setStats(`${want ? "压制" : "解压"}失败：后面的特征依赖它 · ${e?.message || e}`);
  }
}

function deleteStep(i) {
  if (!history.length || i < 0 || i >= history.length) return;
  if (mode === "sketch") { setStats("请先完成或取消草图，再删除特征"); return; }
  cancelEdit(true);
  if (["fillet", "chamfer", "shell"].includes(mode)) exitEdgeMode();
  else if (mode === "link") exitLinkMode();
  else if (mode === "smartdim") cancelSmartDim();
  const backupHistory = history;
  const backupShape = shape;
  const backupIndex = hIndex;
  const removedLabel = featureDisplayName(history[i], i);

  try { history = withoutFeature(history, i); }
  catch (e) { setStats(`删不掉「${removedLabel}」：${e.message} · 当前工程已保留`); return; }
  if (!history.length) {
    shape = null;
    hIndex = -1;
    refresh({});      // refresh 在 shape 为空时会清空整个视图（含网格/边/高亮）
    selectFace(null);
    renderTree();
    setStats(`已删除「${removedLabel}」· 模型现在是空的（可以重新建一个）`);
    return;
  }
  try {
    const r = rebuild(history, history.length - 1);
    shape = r.shape;
    hIndex = history.length - 1;
    cacheRebuild(history, r);
    selectFace(null);
    refresh({});
    renderTree();
    setStats(`已删除「${removedLabel}」· 重放 ${r.steps} 步 · 用时 ${r.logs.reduce((a, b) => a + b.ms, 0).toFixed(0)} ms`);
  } catch (e) {
    // 后面的步骤依赖被删的那个 → 整段回滚，绝不留下半成品
    history = backupHistory;
    shape = backupShape;
    hIndex = backupIndex;
    refresh({});
    renderFeatTree();
    setStats(`删不掉「${removedLabel}」：后面的特征依赖它 · ${e?.message || e}`);
  }
}

function gotoStep(i) {
  if (i < 0 || i >= history.length || i === hIndex) return;
  // 活动手柄取消会恢复拖动基准，必须先取消，再切到目标历史快照。
  dim?.hide();
  cancelEdit(true);
  // 先清干净临时状态，否则会拿着已经失效的 faceId / 边继续操作
  if (mode === "fillet" || mode === "chamfer" || mode === "shell") exitEdgeMode();
  else if (mode === "sketch") exitSketch();
  else if (mode === "link") exitLinkMode();
  else if (mode === "smartdim") cancelSmartDim();
  hIndex = i;
  shape = history[i].shape;
  selectFace(null);
  dim?.hide();
  viewer.clearHighlight();
  viewer.clearSketchLines();
  viewer.setEdgeData([]);
  refresh();
  renderTree();
  setStats(`已回到第 ${i + 1} 步：${history[i].label}` +
    (history[i].detail ? ` · ${history[i].detail}` : "") +
    ` · 此时 面 ${shape?.faces.length || 0} · ` + $("stats").textContent.replace(/^面 \d+ · /, ""));
}

const undo = () => gotoStep(hIndex - 1);
const redo = () => gotoStep(hIndex + 1);

/** 从历史里重放一遍并把每一步的实体回填（改完定义后统一走这里） */
function acceptRebuild(result) {
  cacheRebuild(history, result);
  // Editing at a rollback position creates a new branch; stale redo snapshots are invalid.
  history = history.slice(0, hIndex + 1);
}

function rebuildAndApply(msg) {
  const t0 = performance.now();
  try {
    const r = rebuild(history, hIndex);
    acceptRebuild(r);
    shape = r.shape;
    selectedFaceId = null;
    selSnap = null;
    dim?.hide();
    viewer.clearHighlight();
    viewer.clearSketchLines();
    viewer.setEdgeData([]);
    refresh();
    renderTree();
    const ms = performance.now() - t0;
    setStats(`${msg} · 重放 ${r.steps} 步 用时 ${ms.toFixed(0)} ms · 面 ${shape.faces.length}` +
      ` · ` + $("stats").textContent.replace(/^面 \d+ · /, ""));
    return true;
  } catch (e) {
    if (e instanceof RefLost) {
      setStats(`重建失败：${e.message}（出问题的是第 ${e.stepIndex + 1} 步「${e.stepLabel}」）· 模型未改动`);
    } else {
      setStats("重建失败：" + (e?.message || e) + " · 模型未改动");
    }
    return false;
  }
}

/**
 * 回去编辑某个特征底下的草图。
 * 这是「特征和草图绑定」的关键：草图不是画完就冻住的，
 * 改它 → 整个下游跟着重建。
 */
function editSketchOf(i) {
  if (mode === "sketch") { setStats("已经在草图里了，先点「完成」或「取消」"); return; }
  const f = history[i];
  if (!f?.op || f.op.type !== "extrude" || !f.op.entities) {
    setStats("这一步没有可编辑的草图");
    return;
  }
  if (i > hIndex) gotoStep(i);
  else cancelEdit(true);
  const base = i > 0 ? history[i - 1].shape : shape;
  try {
    const pl = resolvePlane(base, f.op.plane);
    const s = new SketchSession(base, null, { ...pl, name: f.op.plane.label || "草图" });
    s.entities = JSON.parse(JSON.stringify(f.op.entities));
    s.constraints = JSON.parse(JSON.stringify(f.op.constraints || []));
    s.selected = Array.isArray(f.op.selected) ? [...f.op.selected] : [];
    s._editTarget = i;                 // 标记：完成时要更新这个特征，而不是新建
    beginSketch(s);
    setStats(`正在编辑第 ${i + 1} 步「${f.label}」的草图 · 改完点「完成」会重建下游特征 · ` +
      `${s.entities.length} 个图元${s.constraints.length ? ` · ${s.constraints.length} 条约束` : ""}`);
  } catch (e) {
    setStats("没法回去编辑这张草图：" + (e?.message || e));
  }
}

/** 编辑完草图：把图元和约束写回那个特征，然后重建下游 */
function commitSketchEdit(i) {
  const f = history[i];
  if (!f?.op) { exitSketch(); return; }
  const entities = JSON.parse(JSON.stringify(sketch.entities));
  const constraints = JSON.parse(JSON.stringify(sketch.constraints));
  const selected = [...sketch.selected];
  const originalOp = f.op;
  const originalDetail = f.detail;
  f.op = { ...f.op, entities, constraints, selected };
  f.detail = detailOf(f.op);
  if (rebuildAndApply(`已更新第 ${i + 1} 步的草图（${entities.length} 图元${constraints.length ? ` · ${constraints.length} 约束` : ""}）`)) {
    exitSketch();
  } else {
    f.op = originalOp;
    f.detail = originalDetail;
    redrawSketch();
  }
}

function renderTree() {
  const el = $("treeList");
  if (!el) return;
  const rows = [];
  history.forEach((h, i) => {
    const cls = i === hIndex ? "cur" : (i > hIndex ? "future" : "");
    const canEdit = h.op && (EDITABLE[h.op.type] || ["pattern", "mirror"].includes(h.op.type));
    rows.push(`<div class="tree-item ${cls}" data-i="${i}">` +
      `<button class="timeline-step" title="${escapeHTML(`${i + 1}. ${h.label} · ${h.detail || ""}`)}" aria-label="${escapeHTML(`回到第 ${i + 1} 步：${h.label}`)}"${i === hIndex ? ' aria-current="step"' : ""}>` +
      `<span class="ico" aria-hidden="true">${h.icon}</span>` +
      `<span class="nm">${escapeHTML(h.label)}</span>` +
      `<span class="dt">${escapeHTML(h.detail || "")}</span>` +
      `</button>` +
      (canEdit ? `<button class="ed" data-ed="${i}" title="编辑${escapeHTML(h.label)}" aria-label="编辑第 ${i + 1} 步：${escapeHTML(h.label)}">✎</button>` : "") +
      `</div>`);
    // 画在某个平面上的特征，下面挂一个可点回去编辑的草图子节点
    // （SolidWorks 的树就是这样：草图包含在拉伸特征底下）
    const op = h.op;
    if (op && op.type === "extrude" && op.entities) {
      const n = op.entities.length;
      const nc = (op.constraints || []).length;
      rows.push(`<div class="tree-item sub ${cls}" data-sketch="${i}" title="点这里回去改草图">` +
        `<span class="ico">✎</span>` +
        `<span class="nm">草图</span>` +
        `<span class="dt">${n} 图元${nc ? ` · ${nc} 约束` : ""}</span>` +
        `<span class="ed" data-edit-sketch="${i}" title="编辑草图">✏</span>` +
        `</div>`);
    }
  });
  el.innerHTML = rows.join("");
  for (const it of el.querySelectorAll(".tree-item")) {
    it.onclick = (ev) => {
      const es = ev.target.closest?.("[data-edit-sketch]");
      if (es) { editSketchOf(+es.dataset.editSketch); return; }
      const ed = ev.target.closest?.("[data-ed]");
      if (ed) { editStep(+ed.dataset.ed); return; }
      if (it.dataset.sketch != null) { editSketchOf(+it.dataset.sketch); return; }
      gotoStep(+it.dataset.i);
    };
  }
  $("btnUndo").disabled = hIndex <= 0;
  $("btnRedo").disabled = hIndex >= history.length - 1;
  el.scrollTop = el.scrollHeight;
  el.querySelector(`.tree-item[data-i="${hIndex}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  renderFeatTree();     // 左侧的结构树跟着一起刷新
}

function setTreeOpen(open) {
  document.body.classList.toggle("tree-open", open);
  // 历史是左下角一个开关，展开/收起时开关**留在原位**（im-touch 的做法）
  $("btnTreeShow").classList.remove("hidden");
  $("btnTreeShow").classList.toggle("on", !!open);
  $("btnTreeShow").setAttribute("aria-expanded", String(!!open));
  // 画布是全屏的，树浮在上面；这里只是让 UI 层重算一次浮层位置
  requestAnimationFrame(() => { viewer.resize(); drawSnapOverlay(); });
}

// 窗口尺寸变化时，捕捉覆盖层要跟着主画布重算
window.addEventListener("resize", () => requestAnimationFrame(drawSnapOverlay));

// 视图指示器只避让底部时间线与状态栏；顶部功能区不再占用底部空间。
const toolbars = ["tree", "status"].map($).filter(Boolean);
const toolLayoutObserver = new ResizeObserver(() => {
  const height = toolbars.reduce((sum, bar) => sum + (bar.id === "tree" && !document.body.classList.contains("tree-open") ? 0 : bar.getBoundingClientRect().height), 0);
  document.documentElement.style.setProperty("--tool-inset", `${height + 30}px`);
  syncWorkspaceBottom();
});
toolbars.forEach((bar) => toolLayoutObserver.observe(bar));

/**
 * 底栏的真实高度按**实测**写回 --workspace-bottom。
 *
 * 为什么不用常数：CSS 里按「--bottombar-height + --status-height」算出来是 92px，
 * 而底栏实际渲染 95px —— 差的这 3px 就是底部时间线与底栏互相压边的来源，
 * 而且字号/系统缩放一变这个差还会变。
 *
 * 时序提醒（踩过）：底栏是 installWorkspaceUI 创建的外壳元素，比这段代码执行得晚，
 * 这里直接 $("bottomBar") 会拿到 null —— 而 ResizeObserver.observe(null) 抛
 * TypeError，**整个 main.js 初始化就此中断**，页面永远停在「内核加载中…」。
 * 所以只先注册一个惰性函数，等外壳装好（onLayout）或布局变化时再量、再开始观察。
 */
let bottomBarObserved = false;
function syncWorkspaceBottom() {
  const bar = $("bottomBar");
  if (!bar || !bar.isConnected) return;
  if (!bottomBarObserved) { bottomBarObserved = true; toolLayoutObserver.observe(bar); }
  const measured = Math.ceil(bar.getBoundingClientRect().height);
  /*
   * 一定写在 **body** 上：CSS 里 body.workspace-ui 自己声明了
   * --workspace-bottom（算出来 92px），写在 html 上会被 body 的那条盖住，
   * 时间线照旧差 3px（实测就是踩了这个）。内联样式优先级更高。
   */
  if (measured > 0) document.body.style.setProperty("--workspace-bottom", `${measured}px`);
}

// ---------------------------------------------------------------- 尺寸手柄
function setupDim() {
  dim = new DimHandle({
    onStart: () => { dimBase = shape; dimTarget = null; },   // 锁定基准，预览全从它重算
    onPreview: (v) => {
      dimTarget = v;
      // 拉伸阶段：把手柄值同步回输入框，两边永远一致
      if (awaitingExtrude) $("extrDist").value = String(v);
      viewer.invalidate();      // 保证手柄本身也每帧跟着走
      scheduleDimPreview();
    },
    onCommit: (v) => commitDimValue(v),
    onCancel: (v) => {
      if (dimRaf) cancelAnimationFrame(dimRaf);
      dimRaf = 0;
      dimTarget = null;
      if (dimBase) { shape = dimBase; refresh(); }
      discardCurvedPreview();
      dimBase = null;
      viewer.clearPreviewWire();
      if (awaitingExtrude) { $("extrDist").value = String(v); previewExtrude(v); }
      setStats("已取消拖动，尺寸保持原值");
    },
  });
  viewer.onFrame = (rect) => {
    dim.sync(viewer.camera, canvas, rect);
    /*
     * 尺寸标注是画在覆盖层 canvas 上的，坐标全靠"当前相机"现算。
     * 相机一动（平移/旋转/缩放视角）这些屏幕坐标就全变了 ——
     * 不在每帧重画的话，标注会**停在旧位置**，直到下一次点击/重绘才跳过去（用户实测发现）。
     *
     * 但不能无脑每帧画：drawSnapOverlay 里有 getBoundingClientRect()，
     * 每帧调用会反复触发 layout。所以比一个相机签名，变了才重画。
     */
    if (sketch && planarMode) {
      const c = viewer.camera;
      const sig = `${c.position.x.toFixed(2)},${c.position.y.toFixed(2)},${c.position.z.toFixed(2)}`
        + `,${viewer.cam.dist.toFixed(2)}`;
      if (sig !== _overlaySig) {
        _overlaySig = sig;
        _overlayRedraws++;
        drawSnapOverlay(rect);
      }
    }
  };
}

/** 按帧节流：拖动中产生的新值若有未处理帧就直接丢弃，保证手柄本身跟手 */
function scheduleDimPreview() {
  if (dimRaf) return;
  dimRaf = requestAnimationFrame(() => {
    dimRaf = 0;
    if (dimTarget != null) applyDimPreview(dimTarget);
  });
}

/**
 * 圆角/倒角预览线框 —— 画的是**圆角做完之后的切边**，不是圆心轨迹。
 *
 * 之前画错了：沿"圆心方向"（两面法向的角平分）偏移 R，得到的是圆心走过的轨迹，
 * 看起来是一条朝零件外伸出去的线，不符合逻辑。
 * 正确的是：圆角面与两个相邻面各有一条**切线**，它们分别在各自的那个面上、
 * 离原边 R —— SolidWorks 的黄色预览就是这个形状。
 *
 * 做法：对每个相邻面，取"面内垂直于边"的方向，朝圆心那侧偏移 R 画一条线。
 * 依然不碰内核，只是对已有的采样点做偏移。
 */
function filletWireframe(radius) {
  const R = Math.abs(radius);
  if (!edgeSel.length || R < 1e-6) return null;
  const segs = [];
  const pushP = (p, q) => segs.push(p.x, p.y, p.z, q.x, q.y, q.z);
  for (const s of edgeSel) {
    if (!s.pts || s.pts.length < 2) continue;
    const dirv = s.dir ? new THREE.Vector3(s.dir[0], s.dir[1], s.dir[2]).normalize() : null;
    const tanv = s.tel ? new THREE.Vector3(s.tel[0], s.tel[1], s.tel[2]).normalize() : null;
    const normals = [s.n1, s.n2].filter(Boolean);
    if (!dirv || !tanv || !normals.length) continue;

    for (const n of normals) {
      const nv = new THREE.Vector3(n[0], n[1], n[2]).normalize();
      // 面内垂直于边的方向；取"朝圆心"的那一侧（圆角就是往圆心那边削出来的）
      const sl = new THREE.Vector3().crossVectors(nv, tanv).normalize();
      if (sl.dot(dirv) < 0) sl.negate();
      const off = sl.multiplyScalar(R);
      for (let i = 0; i < s.pts.length - 1; i++) {
        const p0 = new THREE.Vector3(...s.pts[i]).add(off);
        const p1 = new THREE.Vector3(...s.pts[i + 1]).add(off);
        pushP(p0, p1);
      }
    }
  }
  return segs.length ? new Float32Array(segs) : null;
}

/** 拖动中：低精度网格 + 基于 dimBase 重算（圆角/倒角改走黄色线框预览） */
function applyDimPreview(v) {
  // 草图拉伸阶段：基准是 sketch 内部的原始实体，不走 dimBase
  if (awaitingExtrude) { previewExtrude(v); return; }
  if (curvedDriver && (mode === "select" || mode === "pushpull")) {
    if (dimBase) previewCurvedDim(v);
    return;
  }
  if (mode === "fillet" || mode === "chamfer") {
    // 线框预览：不动实体、不跑内核（原实现要 filletEdges + 网格化）
    if (!edgeSel.length) return;
    viewer.setPreviewWire(filletWireframe(v));
    setStats(`${edgeKind === "fillet" ? "圆角" : "倒角"} ${edgeKind === "fillet" ? "R" : "C"}${v.toFixed(1)} · 黄色线是预览（松手或点✔应用）`);
    return;
  }
  if (!dimBase) return;
  try {
    if (mode === "pushpull" || mode === "select") {
      if (selectedFaceId == null) return;
      if (!isPlanarPushPullFace(dimBase, selectedFaceId)) {
        setStats("这个曲面没有可用的尺寸来源，请在历史中编辑原始特征");
        return;
      }
      const next = OPS.pushPullFace(dimBase, selectedFaceId, v);
      /*
       * ⚠ 退化结果必须自己检查：拉过头（比如把圆柱拉到负半径）时
       * `pushPullFace` **不抛错、而是返回一个空/零体积实体** ——
       * 直接把它赋给 shape 再 refresh，整个视图就被清空了，
       * 看起来像"3D 模型凭空消失"（用户实测反馈），松手后又回来。
       * 这种情况保持上一帧、什么都不动（拖动被"顶住"在极限值）。
       */
      const vol = next ? OPS.volumeOf(next) : 0;
      if (!next || !isFinite(vol) || vol < 1e-6) {
        setStats(`推拉 ${v > 0 ? "+" : ""}${v.toFixed(1)} mm · 这个值会把实体拉没，已停在上一个可用状态`);
        return;
      }
      shape = next;
      refresh({ coarse: true });
      setStats(`推拉 ${v > 0 ? "+" : ""}${v.toFixed(1)} mm · 预览中`);
    }
  } catch (_) { /* 这个值几何上做不到（比如半径超过板厚），保持上一帧 */ }
}

/** 松手 / 输入回车：用最终值重算一次，出高精度网格 */
function commitDimValue(v) {
  if (dimRaf) cancelAnimationFrame(dimRaf);
  dimRaf = 0;
  dimTarget = null;
  if (awaitingExtrude) {
    $("extrDist").value = String(v);
    dimBase = null;
    previewExtrude(v);
    return;
  }
  // 曲面尺寸（点圆柱/圆角/倒角面拖径向手柄）：改的是特征参数，不走推拉
  if (curvedDriver && (mode === "select" || mode === "pushpull")) {
    // 提交失败时必须恢复拖动前实体，而不是留下最后一次临时预览。
    shape = dimBase || shape;
    dimBase = null;
    discardCurvedPreview();
    commitCurvedDim(v);
    return;
  }
  const base = dimBase || shape;
  const t0 = performance.now();
  try {
    if (mode === "fillet" || mode === "chamfer") {
      const mids = edgeSel.map((e) => e.mid);
      const edgeRefs = makeEdgeRefs(base, mids);
      const r = edgeKind === "fillet"
        ? OPS.filletEdges(base, mids, v)
        : OPS.chamferEdges(base, mids, v);
      if (!mids.length || r.ok !== mids.length) throw new Error("部分棱边无法完成，模型未改动；请缩小尺寸或减少选边");
      shape = r.shape;
      const ms = performance.now() - t0;
      dimBase = null;
      exitEdgeMode();               // 里面会清预览线框
      refresh();
      const nm = edgeKind === "fillet" ? "圆角" : "倒角";
      const dt = `${edgeKind === "fillet" ? "R" : "C"}${v.toFixed(1)} × ${r.ok}边`;
      commit(nm, dt, edgeKind, { type: edgeKind, edgeRefs, radius: v });
      setStats(`${nm} ${dt} ` + (r.failed ? `（${r.failed} 条失败已跳过）` : "") + ` · ${ms.toFixed(0)} ms`);
    } else if (mode === "pushpull" || mode === "select") {
      const fId = selectedFaceId;
      if (!isPlanarPushPullFace(base, fId)) throw new Error("这个曲面没有可用的尺寸来源，请在历史中编辑原始特征");
      dimBase = null;
      commitPushPull(base, fId, v);
      showPushPullDim(0);          // 归零，可以接着推
    }
  } catch (e) {
    dimBase = null;
    shape = base;
    refresh();
    setStats(e?.message || String(e));
  }
}

/** 圆角/倒角：手柄挂在第一条选中边的「圆心」上，拖动 = 改半径 */
function showEdgeDim(value) {
  if (!dim) return;
  if (!edgeSel.length || !edgeSel[0].dir) { dim.hide(); return; }
  const s = edgeSel[0];
  dim.show({
    anchor: new THREE.Vector3(s.mid[0], s.mid[1], s.mid[2]),
    dir: new THREE.Vector3(s.dir[0], s.dir[1], s.dir[2]).normalize(),
    value: value ?? (parseFloat($("edgeVal").value) || 2),
    prefix: edgeKind === "fillet" ? "R" : "C",
    unit: "",
    min: 0.1,
    max: 60,
  });
  viewer.invalidate();
}

/** 推拉：手柄挂在面中心沿法向 */
function showPushPullDim(value = 0) {
  if (!dim) return;
  if (selectedFaceId == null || !selSnap) { dim.hide(); return; }
  dim.show({
    anchor: new THREE.Vector3(selSnap.center[0], selSnap.center[1], selSnap.center[2]),
    dir: selSnap.normal.clone().normalize(),
    value,
    prefix: "",
    unit: "mm",
    min: -500,
    max: 500,
  });
  viewer.invalidate();
}

// ---------------------------------------------------------------- 手势（统一入口：草图 / 推拉 / 相机）
/*
 * 拖特征点移动图元（鼠标按住端点/圆心直接拖）。
 * 触摸上就是"按住片刻再拖"：手指先落在点上，浏览器自然走这条拖动路径，
 * 而单纯的轻点仍然走 onTap（拾取/标注），两者不冲突。
 */
let grabState = null;        // { e, from:[x,y], kind }

/** 屏幕位置有没有落在某个特征点上（容差按像素） */
function featurePointAt(clientX, clientY, tolPx = 16) {
  if (!sketch) return null;
  let best = null, bd = tolPx;
  sketch.entities.forEach((e, i) => {
    if (e.ref) return;
    for (const c of candidatesOf(e, i)) {
      if (!c.ref) continue;
      const s = sketchToScreen(c.p);
      if (!s) continue;
      const d = Math.hypot(s[0] - clientX, s[1] - clientY);
      if (d < bd) { bd = d; best = { e: i, p: c.p, scr: s, kind: c.kind }; }
    }
  });
  return best;
}

viewer.cam.onDragStart = (e) => {
  // 手柄持有的手势不能被另一指转成第二次几何编辑。
  if (dim?._drag || dim?._editing) return false;
  // 草图模式：矩形/圆用拖动绘制；直线用点击落点，拖动留给旋转相机
  if (mode === "sketch" && sketch) {
    // 优先：按住特征点 → 拖动整个图元
    const hit = featurePointAt(e.clientX, e.clientY);
    if (hit && !sketch.draft) {
      /*
       * 先记下来，但**不马上报"拖动"** —— 得等松手时看看到底动没动。
       * 之前一命中就接管并提示"拖动圆心可以移动图元"，结果用户只是**轻点圆心想标尺寸**，
       * 松手后也显示"已移动图元"，标注根本做不了（用户实测反馈）。
       * 现在松手时按位移分流：没动 → 当成点击（走 viewer._tap，也就是拾取/标注）；
       * 动了 → 才是真的移动。
       */
      grabState = {
        e: hit.e, from: [hit.p[0], hit.p[1]], kind: hit.kind,
        startClient: [e.clientX, e.clientY],
        before: JSON.parse(JSON.stringify(sketch.entities)),
      };
      setStats(`按住${hit.kind === "center" ? "圆心" : "端点"}可拖动图元 · 轻点则是选中它（之后能标尺寸）`);
      return true;
    }
    grabState = null;
    // 这些工具是"点一下做一件事"，拖动留给相机或特征点；
    // select 是纯选择/移动：绝不新建元素（之前选了矩形工具后想移动元素，
    // 一点就误建一个新矩形，用户实测反馈）
    if (sketchTool === "line" || sketchTool === "dim" || sketchTool === "ref"
        || sketchTool === "offset" || sketchTool === "select") {
      updateSnap(e.clientX, e.clientY); return false;
    }
    // 起点也吸附：不然"从一个已有角点开始画"会对不齐
    const p = updateSnap(e.clientX, e.clientY);
    if (!p) return false;
    drawing = { start: p, cur: p };
    return true;
  }
  // 推拉模式：只有按在选中的那个面上才推拉，按别处照常旋转
  if (mode !== "pushpull" || selectedFaceId == null || !selSnap) return false;
  const hit = viewer.pickAt(e.clientX, e.clientY);
  if (!hit || hit.faceId !== selectedFaceId) return false;
  if (!isPlanarPushPullFace(shape, selectedFaceId)) {
    setStats("曲面请拖动橙色尺寸手柄，或在历史中编辑原始特征");
    return false;
  }

  const c = selSnap.center;
  const centerW = new THREE.Vector3(c[0], c[1], c[2]);
  const n = selSnap.normal.clone();
  const toScreen = (v3) => {
    const p = v3.clone().project(viewer.camera);
    const r = canvas.getBoundingClientRect();
    return new THREE.Vector2((p.x * 0.5 + 0.5) * r.width, (-p.y * 0.5 + 0.5) * r.height);
  };
  const sd = toScreen(centerW.clone().add(n)).sub(toScreen(centerW));
  const pxPerUnit = sd.length();
  if (!isFinite(pxPerUnit) || pxPerUnit < 0.5) return false;
  sd.normalize();
  drag = {
    screenDir: sd, pxPerUnit,
    baseShape: shape, faceId: selectedFaceId,
    start: { x: e.clientX, y: e.clientY },
    dist: 0, raf: 0,
  };
  return true;
};

/**
 * 把拖动事件合并到垂直同步。
 *
 * Pad 7 Ultra 的触摸采样率是 240Hz，而屏幕刷新只有 120Hz ——
 * 每个 pointermove 都跑一遍求解器 + 重画草图 + 强制同步布局，
 * 一半的工作量画的根本不会被显示出来。这里只保留本帧的最后一个事件，
 * 松手/取消前再补跑一次，保证最终位置不丢。
 */
let _dragFrame = 0, _dragEvent = null;
function flushDragFrame() {
  if (_dragFrame) { cancelAnimationFrame(_dragFrame); _dragFrame = 0; }
  const pending = _dragEvent;
  _dragEvent = null;
  if (pending) applyDrag(pending);
}

function applyDrag(e) {
  // 拖特征点：把整个图元按位移挪走
  if (grabState && sketch) {
    if (Math.hypot(e.clientX - grabState.startClient[0], e.clientY - grabState.startClient[1]) < 6) return;
    const p = sketch.screenTo2D(e.clientX, e.clientY, viewer.camera, canvas);
    if (p) {
      const ddx = p.x - grabState.from[0], ddy = p.y - grabState.from[1];
      const snap = JSON.parse(JSON.stringify(sketch.entities));
      sketch.translateEntities([grabState.e], ddx, ddy);
      /*
       * ★ 约束优先：拖完之后立刻把约束重新解一遍。
       *
       * 不加这一步的话，拖动是**直接改坐标**的，会把已有尺寸顶掉
       * （比如标了"圆心到线 20"，一拖圆心距离就变成别的值，
       * 用户实测反馈"移动就把距离关系顶掉了"）。
       * SolidWorks 的行为是：已标尺寸锁住，拖动只在**剩余自由度**里生效 ——
       * 求解器正好能给出这个效果：它会让几何回到"满足全部约束且离拖动目标最近"的位置。
       *
       * 解不开（拖动把约束逼到无解）就整段回滚，宁可拖不动也不能悄悄破坏约束。
       */
      if (sketch.constraints.length) {
        const r = solveSketch(sketch.entities, sketch.constraints);
        if (!r.ok) {
          restoreEntities(snap);
          setStats("这个方向被约束卡住了（再拖就无解）· 先删掉或改掉相关尺寸/关系");
        }
      }
      grabState.from = [p.x, p.y];
      redrawSketch();
    }
    return;
  }
  if (mode === "sketch" && drawing && sketch) {
    const p = updateSnap(e.clientX, e.clientY);      // 终点同样吸附
    if (p) {
      drawing.cur = p;
      const prev = currentPreview();
      redrawSketch(prev);
      if (prev) {
        const tag = p.snapped ? ` · 已捕捉${SNAP_KINDS[p.kind]?.label || ""}` : "";
        setStats((prev.kind === "rect"
          ? `矩形 ${prev.w.toFixed(1)} × ${prev.h.toFixed(1)} mm`
          : `圆 Ø${(prev.r * 2).toFixed(1)} mm`) + tag);
      }
    }
    return;
  }
  if (!drag) return;
  const v = new THREE.Vector2(e.clientX - drag.start.x, e.clientY - drag.start.y);
  drag.dist = v.dot(drag.screenDir) / drag.pxPerUnit;
  if (!drag.raf) drag.raf = requestAnimationFrame(() => { drag.raf = 0; previewDrag(); });
}

viewer.cam.onDrag = (e) => {
  _dragEvent = e;
  if (_dragFrame) return;
  _dragFrame = requestAnimationFrame(() => { _dragFrame = 0; flushDragFrame(); });
};

viewer.cam.onDragCancel = () => {
  flushDragFrame();
  if (grabState?.before && sketch) restoreEntities(grabState.before);
  grabState = null;
  drawing = null;
  if (drag) {
    if (drag.raf) cancelAnimationFrame(drag.raf);
    shape = drag.baseShape;
    const faceId = drag.faceId;
    drag = null;
    refresh();
    selectFace(faceId);
  }
  snap.clear(); snapGuides = [];
  if (sketch) redrawSketch();
};

viewer.cam.onDragEnd = (e) => {
  flushDragFrame();
  if (grabState) {
    const g = grabState;
    grabState = null;
    // 位移判定：手指/鼠标基本没动 → 这是一次**点击**，不是拖动。
    // 转发给 viewer._tap（拾取 → onPick → 尺寸/引用/关系等各模式的落点逻辑），
    // 否则"点圆心标尺寸"这类操作永远做不了。
    const dist = (e && g.startClient)
      ? Math.hypot(e.clientX - g.startClient[0], e.clientY - g.startClient[1])
      : 0;
    if (dist < 6) {
      if (sketch && g.before) restoreEntities(g.before);
      viewer._tap({ x: e ? e.clientX : g.startClient[0], y: e ? e.clientY : g.startClient[1] });
      return;
    }
    setStats("已移动图元 · 位置不会自动加约束（需要的话用尺寸/关系固定它）");
    redrawSketch();
    return;
  }
  if (mode === "sketch" && drawing && sketch) {
    const { start, cur } = drawing;
    drawing = null;
    let e = null;
    if (sketchTool === "rect") e = sketch.addRect(start, cur);
    else e = sketch.addCircle(start, cur);
    redrawSketch(null);
    if (!e) setStats("图形太小，已忽略；请拖出更大范围");
    else setStats(sketchTool === "rect"
      ? `已加矩形 ${e.w.toFixed(1)} × ${e.h.toFixed(1)} mm（共 ${sketch.entities.length} 个轮廓）`
      : `已加圆 Ø${(e.r * 2).toFixed(1)} mm（共 ${sketch.entities.length} 个轮廓）`);
    return;
  }
  const d = drag;
  drag = null;
  if (!d) return;
  if (d.raf) cancelAnimationFrame(d.raf);
  if (mode !== "pushpull" || !isPlanarPushPullFace(d.baseShape, d.faceId)) {
    shape = d.baseShape;
    refresh();
    setStats("已取消直接推拉；曲面请使用橙色尺寸手柄或编辑原始特征");
    return;
  }
  if (Math.abs(d.dist) > 0.05) commitPushPull(d.baseShape, d.faceId, d.dist);
  else { shape = d.baseShape; refresh(); selectFace(d.faceId); }
};

// ---------------------------------------------------------------- 工具栏
function setMode(m) {
  mode = m;
  viewControls.refresh();
  for (const b of document.querySelectorAll("[data-act]")) {
    if (["snap", "datum", "script"].includes(b.dataset.act)) continue;
    b.classList.toggle("on", b.dataset.act === m);
  }
}

// 特征参数编辑面板：✔ 确定 / ✖ 取消 / 👁 预览（仿 SolidWorks 属性管理器）
$("featOk").onclick = () => applyEdit();
$("featX").onclick = () => cancelEdit();
$("featEye").onclick = () => previewEdit();
// 输入框里回车上也能直接确认
$("featVal").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); applyEdit(); } };

// 平面 / 3D 模式开关（平板上单指是要画图还是要转视角，全靠它）
(() => {
  const b = $("modeToggle");
  if (b) b.onclick = () => togglePlanarMode();
})();

// 坐标系指示器 + 比例尺：相机变了才重画（SVG 重排有开销，别每帧刷）
(() => {
  let last = "";
  const tick = () => {
    const cam = viewer?.camera;
    if (!cam) return;
    const sig = `${cam.position.x.toFixed(2)},${cam.position.y.toFixed(2)},${cam.position.z.toFixed(2)},${viewer.cam.dist.toFixed(1)}`;
    if (sig === last) return;
    last = sig;
    updateAxisGizmo();
    updateScaleBar();
    if (planarMode && sketch && gridGroup && gridGroup.userData.sig !== gridSig()) drawSketchGrid();
  };
  setInterval(tick, 120);
  tick();
})();

document.querySelectorAll("[data-act]").forEach((b) => {
  b.onclick = () => {
    const a = b.dataset.act;
    // 导航与显示开关可在预览中使用；切换建模命令时先收回旧预览和参数面板。
    if (!["fit", "snap", "datum"].includes(a)) closePatternEditor();
    if (!["fit", "snap", "datum", "save", "load", "step"].includes(a)) {
      cancelEdit(true);
      if (mode === "smartdim") cancelSmartDim();
      $("movePad").classList.add("hidden");
      $("refgPad").classList.add("hidden");
    }
    // 切到别的命令时先收起本轮新增的浮层（它们没有嵌在任何现有面板里）
    if (!NEW_FEATURE_ACTIONS.includes(a)) {
      closeFeaturePads();
      faceRequest = null;
      if (mode === "pickface" || mode === "hole") mode = "select";
    }
    /*
     * ⚠ 草图里点「选择」**不能**走 setMode("select")：
     *   mode 一旦从 "sketch" 变成 "select"，所有 `mode === "sketch"` 的判断全部失效 ——
     *   覆盖层的特征点/尺寸标注不再跟随相机（表现为「画完点平移视图，点和线错位」），
     *   草图里的拖动绘制、特征点拖动也一起失灵。用户实测反馈的就是这个。
     * 草图内只需要切换 sketchTool，mode 必须保持 "sketch"。
     */
    if (a === "select" && sketch) {
      sketchTool = "select";
      for (const btn of document.querySelectorAll("[data-act]")) {
        if (["snap", "datum", "script"].includes(btn.dataset.act)) continue;
        btn.classList.toggle("on", btn.dataset.act === "select");
      }
      viewControls.refresh();
      redrawSketch();
      setStats("选择工具：点一下拾取图元；在空白处拖动可平移视图");
    }
    else if (a === "select" || a === "pushpull") { setMode(a); if (a === "select") viewer.highlightEdges([]); }
    else if (a === "sketch") { setMode("select"); enterSketch(); }
    // 进入命令模式时高亮「这个命令」本身，而不是把高亮留在「选择」上 ——
    // 否则用户在抽壳/圆角模式下看到的仍是「选择」被点亮，会以为工具已经退出了。
    else if (a === "fillet") { setMode("fillet"); enterEdgeMode("fillet"); }
    else if (a === "chamfer") { setMode("chamfer"); enterEdgeMode("chamfer"); }
    else if (a === "shell") { setMode("shell"); enterShellMode(); }
    else if (a === "move") enterMoveMode();
    else if (a === "linearPattern") openPatternEditor("linear");
    else if (a === "circularPattern") openPatternEditor("circular");
    else if (a === "mirror") openPatternEditor("mirror");
    else if (a === "refg") enterRefGeom();
    else if (a === "link") { setMode("select"); enterLinkMode(); }
    else if (a === "smartdim") { setMode("select"); enterSmartDimMode(); }
    else if (a === "datum") {
      if (!datum) return;
      datum.setVisible(!datum.visible);
      b.classList.toggle("on", datum.visible);
      setStats(datum.visible
        ? "基准面已显示 · 直接点 XYZ 平面即可在上面画草图（不用先有实体）"
        : "基准面已隐藏");
    }
    else if (a === "snap") {
      snap.setEnabled(!snap.enabled);
      b.classList.toggle("on", snap.enabled);
      if (!snap.enabled) { snapGuides = []; drawSnapOverlay(); }
      setStats(snap.enabled
        ? "捕捉已开：画图时会自动吸附到端点/中点/圆心/交点，并显示对齐引导线"
        : "捕捉已关：图形会精确落在你手指的位置");
    }
    else if (a === "script") openScriptPad();
    // ---- 本轮接上的入口：网格导出 / 测量 / 8 个特征 / 曲面组 ----
    else if (a === "stl" || a === "obj" || a === "3mf") exportMesh(a);
    else if (a === "measure") openMeasurePad();
    else if (a === "hole") enterHoleWizard();
    else if (a === "combine" || a === "splitPlane" || a === "offsetFace" || a === "thicken") enterSolidPad(a);
    else if (a === "surface") toggleSurfaceGroup();
    else if (a === "surfaceOffset" || a === "surfaceThicken" || a === "surfaceFill" || a === "surfaceStitch") enterSurfacePad(a);
    else if (a === "fit") viewer.cam.fit(viewer.bbox);
    else if (a === "save") openSaveDialog("save");
    else if (a === "load") openSaveDialog("load");
    else if (a === "import") $("fileInput").click();
    else if (a === "step") exportStep();
  };
});

// 建模脚本面板：运行 / 追加 / 撤销 / 示例 / 导入 / 导出
(() => {
  const pad = $("scriptPad");
  if (!pad) return;
  $("spRun").onclick = () => runScriptFromPad("replace");
  $("spAppend").onclick = () => {
    if (!shape) { setStats("当前没有实体，追加模式需要先有一个模型（用「运行」从零建）"); return; }
    runScriptFromPad("append");
  };
  $("spUndo").onclick = () => undoScriptRun();
  $("spTemplate").onclick = () => {
    $("spText").value = SCRIPT_TEMPLATE;
    showScriptReport('<div class="sp-line">已载入示例脚本 · 点「运行」会在新文档里建出来（底板 + 锥台 + 推拉 + 圆角 + 弹簧）</div>');
  };
  $("spImport").onclick = () => $("scriptFileInput").click();
  $("spExport").onclick = () => exportCurrentAsScript();
  $("spClose").onclick = () => openScriptPad(false);
  $("scriptFileInput").onchange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      $("spText").value = await file.text();
      openScriptPad(true);
      setStats(`已载入脚本文件「${file.name}」· 点「运行」执行`);
    } catch (e) { setStats(`读脚本文件失败：${e?.message || e}`); }
  };
})();

document.querySelectorAll("#edgebar button").forEach((b) => {
  b.onclick = () => {
    const a = b.dataset.edge;
    if (a === "apply") { mode === "shell" ? applyShell() : applyEdgeTool(); }
    else if (a === "clear") { edgeSel = []; viewer.highlightEdges([]); setStats("已清空边的选择"); }
    else if (a === "cancel") { exitEdgeMode(); setStats("已取消"); }
  };
});

document.querySelectorAll("#sketchbar button").forEach((b) => {
  b.onclick = () => {
    const a = b.dataset.sact;
    if (a === "select") {
      // 纯选择：停掉所有绘制/标注模式，松手才能顺利移动元素
      if (sketch?.draft) sketch.finishPolyline();
      sketchTool = "select";
      sketch._cursor = null;
      dimEntity = null; $("dimPanel").classList.add("hidden");
      offsetEntityIdx = null; $("offsetPanel").classList.add("hidden");
      exitRelMode(); exitXform();
      syncSketchToolUI();
      redrawSketch();
      setStats("选择：按住图元上的蓝点可以拖动它；点蓝点可以直接标尺寸");
    }
    else if (a === "rect" || a === "circle" || a === "line" || a === "dim" || a === "ref" || a === "offset") {
      // 切工具时把没画完的折线收尾，免得留在半截状态
      if (sketch?.draft && a !== "line") sketch.finishPolyline();
      sketchTool = a;
      sketch._cursor = null;
      if (a !== "dim") { dimEntity = null; $("dimPanel").classList.add("hidden"); }
      if (a !== "offset") { offsetEntityIdx = null; $("offsetPanel").classList.add("hidden"); }
      exitRelMode();
      exitXform();
      syncSketchToolUI();
      redrawSketch();
      setStats(a === "line" ? "直线：点第一个点开始，点回起点即闭合"
        : a === "dim" ? "尺寸：点一下图元，就能改它的宽/高/半径；图形会自动变形"
        : a === "ref" ? "引用：点模型的棱边（或一个面）把它投影到当前草图里"
        : a === "offset" ? "等距：点一个草图图元，输入距离生成平行/同心副本"
        : `绘制${a === "rect" ? "矩形" : "圆"}：在面上拖动`);
    }
    // 草图几何工具（B 批 sketch-tools）：一律走数值浮层，手指点两下就出一个图元
    else if (a === "polygon" || a === "slot" || a === "arc" || a === "ellipse" || a === "trim") {
      enterSketchToolPad(a);
    }
    else if (a === "rel") {
      if (relOn) { exitRelMode(); setStats("已退出关系模式"); }
      else { enterRelMode(); }
      syncSketchToolUI();
    }
    else if (a === "xform") {
      if (xfMode) { exitXform(); setStats("已退出变换模式"); }
      else { enterXform(); }
      syncSketchToolUI();
    }
    else if (a === "snap") {
      snap.setEnabled(!snap.enabled);
      syncSketchToolUI();
      const btn = document.querySelector('[data-act=snap]');
      if (btn) btn.classList.toggle("on", snap.enabled);
      if (!snap.enabled) { snapGuides = []; drawSnapOverlay(); }
      setStats(snap.enabled
        ? "捕捉已开：画图时自动吸附到端点/中点/圆心/交点，并显示对齐引导线"
        : "捕捉已关：图形会精确落在你手指的位置");
    }
    else if (a === "view") faceSketchPlane();
    else if (a === "undo") {
      const e = sketch?.undo();
      redrawSketch(null);
      setStats(e ? `已撤销一个轮廓（剩 ${sketch.entities.length} 个）` : "没有可撤销的轮廓");
    }
    else if (a === "cancel") exitSketch();
    else if (a === "finish") finishSketch();
  };
});

document.querySelectorAll("#extrude button").forEach((b) => {
  b.onclick = () => {
    const a = b.dataset.eact;
    if (a === "out") applyExtrude(1);
    else if (a === "in") applyExtrude(-1);
    else if (a === "revolve") applyRevolve();
    else if (a === "sweep") applySweep();
    else if (a === "loft") applyLoft();
    else if (a === "cpattern") applyPattern("circular");
    else if (a === "lpattern") applyPattern("linear");
    else if (a === "mirror") applyMirror();
    else if (a === "contour") setContourPicking(!contourPicking);
    else if (a === "back") cancelExtrude();
  };
});

// 拉伸深度：输入框与手柄双向同步。
// 单一真值源是手柄的 value —— 否则「手输一个值 + 手柄还留着旧值」会互相覆盖。
$("extrDist").addEventListener("input", () => {
  if (!awaitingExtrude || !dim?.visible) return;
  const v = parseFloat($("extrDist").value);
  if (isFinite(v) && v > 0) {
    dim.update(v);
    viewer.invalidate();
  }
});

// ---------------------------------------------------------------- 撤销 / 重做 / 特征树
$("btnUndo").onclick = undo;
$("btnRedo").onclick = redo;
$("btnTreeHide").onclick = () => setTreeOpen(false);
$("btnTreeShow").onclick = () => setTreeOpen(!document.body.classList.contains("tree-open"));   // 左下开关：同一位置开/合
window.addEventListener("keydown", (e) => {
  if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable=true]")) return;
  if (mode === "sketch") return;
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = (e.key || "").toLowerCase();
  if (k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (k === "y") { e.preventDefault(); redo(); }
});

/** 弹个对话框问文件名，默认给个带时间戳的名字 */
function askFileName(defaultName, ext) {
  return new Promise((resolve) => {
    const old = document.getElementById("nameAsk");
    if (old) old.remove();
    const box = document.createElement("div");
    box.id = "nameAsk";
    box.className = "panel";
    box.innerHTML = `
      <div class="sd-title">文件命名</div>
      <div class="sd-row">
        <input id="nameAskInput" type="text" value="${defaultName}" />
        <span class="name-ask-ext">.${ext}</span>
      </div>
      <div class="sd-btns">
        <button class="primary" data-na="ok">确定</button>
        <button data-na="cancel">取消</button>
      </div>`;
    document.body.appendChild(box);
    const inp = box.querySelector("#nameAskInput");
    inp.focus(); inp.select();
    const done = (ok) => {
      const v = ok ? (inp.value || "").trim().replace(/[\\/:*?"<>|]/g, "_") : null;
      box.remove();
      resolve(v ? v : null);
    };
    box.querySelector("[data-na=ok]").onclick = () => done(true);
    box.querySelector("[data-na=cancel]").onclick = () => done(false);
    inp.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); done(true); }
      else if (e.key === "Escape") { e.preventDefault(); done(false); }
    };
  });
}

async function exportStep() {
  if (!shape) return;
  // 先问名字再导出 —— 原来直接写死 padcad_part.step，用户没法区分导出的零件
  const stamp = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "").replace(/^(\d{4})/, "$1-");
  const def = `零件${stamp}`;
  const name = await askFileName(def, "step");
  if (!name) { setStats("已取消导出"); return; }
  setStats("正在导出 STEP…");
  try {
    const t0 = performance.now();
    const blob = await api.exportSTEP([{ shape, name }]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${name}.step`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setStats(`STEP 已导出「${name}.step」(${(blob.size / 1024).toFixed(1)} KB, ${(performance.now() - t0).toFixed(0)} ms) → 下载目录`);
  } catch (e) {
    setStats("导出失败：" + (e?.message || e));
  }
}

// ============================================================================
// 本轮 UI 接线：8 个只有 op 的特征 + 4 个草图工具 + 导出 / 测量入口
//
// 三条硬规矩（都是踩过的坑）：
//   1) op 里只存几何意图（at / normal / 尺寸），**绝不存 faceId** —— 每次布尔 faceId 都会
//      重排，存了下次重放就认不回来（replay.js 顶部那条老经验）。
//   2) 每个入口都要有失败反馈：参数不全 / 选不到面一律 setStats 说中文原因，不许静默 return
//      —— 平板上「点了没反应」跟坏了没区别。
//   3) 提交只有一条路：先算 next 实体，成功才写 global shape 并 commit()。
//      抛错时 shape 和 history 一个字节都不动，不会留下半截特征。
// ============================================================================

const HOLE_KIND_LABEL = { through: "通孔", blind: "盲孔", counterbore: "沉头孔", countersink: "埋头孔" };
// mode 值 → 中文名：失败提示与「你在哪个命令里」都要用
const FEATURE_MODE_LABEL = {
  hole: "孔向导", combine: "布尔", splitPlane: "平面分割", offsetFace: "移动面", thicken: "加厚",
  surfaceOffset: "曲面偏移", surfaceThicken: "曲面加厚", surfaceFill: "补面", surfaceStitch: "缝合",
};
// 这些 data-act 是「开自己的浮层」，切到它们时不要把浮层关掉
const NEW_FEATURE_ACTIONS = [
  "measure", "hole", "combine", "splitPlane", "offsetFace", "thicken",
  "surface", "surfaceOffset", "surfaceThicken", "surfaceFill", "surfaceStitch",
];

const FEATURE_PAD_IDS = ["measurePad", "holePad", "solidPad", "surfacePad", "surfaceGroupPad", "skToolPad"];
function closeFeaturePads() {
  for (const id of FEATURE_PAD_IDS) $(id)?.classList.add("hidden");
}

let holeSel = null;        // 孔向导记住的落点/朝向 {at, normal}
let faceRequest = null;    // 正在等用户点面 {prompt, onDone, afterMode}
let solidTool = null;      // combine | splitPlane | offsetFace | thicken
let solidFaceSel = null;   // 移动面选中的面 {at, normal}
let solidFields = null;    // 当前表单的控件引用
let surfaceTool = null;    // surfaceOffset | surfaceThicken | surfaceFill | surfaceStitch
let surfaceFaceSel = null;
let surfaceFields = null;
let skTool = null;         // polygon | slot | arc | ellipse | trim
let skFields = null;

function fileStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 面是不是平面：曲面不能整体推拉/移动，判断口径和 selectFace 一致（geomType === "PLANE"） */
function faceIsPlanar(faceId) {
  try { return OPS.findFace(shape, faceId)?.geomType === "PLANE"; } catch (_) { return false; }
}

// ---------------------------------------------------------------- 导出 STL / OBJ / 3MF
/**
 * 导出一份网格。
 * 空场景必须明确拒绝 —— 导出一个 0 字节的 STL，用户会以为已经导成了。
 */
function exportMesh(kind) {
  if (!shape) {
    setStats("当前没有实体可导出：先在草图里画轮廓并拉伸，或用「脚本」建一个零件");
    return { ok: false, error: "没有实体" };
  }
  const name = `PadCAD-${fileStamp()}`;
  const t0 = performance.now();
  try {
    let bytes, ext, mime;
    if (kind === "stl") { bytes = stlBinary(shape, name); ext = "stl"; mime = "model/stl"; }
    else if (kind === "obj") { bytes = objText(shape, name); ext = "obj"; mime = "text/plain;charset=utf-8"; }
    else if (kind === "3mf") { bytes = threeMF(shape, name); ext = "3mf"; mime = "model/3mf"; }
    else throw new Error(`不认识的导出格式「${kind}」（只有 stl / obj / 3mf）`);
    const blob = new Blob([bytes], { type: mime });
    const file = `${name}.${ext}`;
    downloadBlob(blob, file);
    const ms = performance.now() - t0;
    setStats(`已导出 ${ext.toUpperCase()}「${file}」· ${(blob.size / 1024).toFixed(1)} KB · ${ms.toFixed(0)} ms → 下载目录`);
    return { ok: true, file, bytes: blob.size, ms: +ms.toFixed(1) };
  } catch (e) {
    setStats(`导出 ${String(kind).toUpperCase()} 失败：${e?.message || e}`);
    return { ok: false, error: String(e?.message || e) };
  }
}

// ---------------------------------------------------------------- 检查（质量属性）
function openMeasurePad() {
  const pad = $("measurePad"), body = $("mPadBody");
  if (!pad || !body) return null;
  if (!shape) {
    pad.classList.add("hidden");
    setStats("当前没有实体可测量：先建一个零件再点「测量」");
    return null;
  }
  let m = null;
  try { m = massProperties(shape); } catch (e) {
    pad.classList.add("hidden");
    setStats("测量失败：" + (e?.message || e));
    return null;
  }
  const f = (v, d = 2) => (Number.isFinite(v) ? Number(v).toFixed(d) : "—");
  const v3 = (a) => (Array.isArray(a) && a.every((x) => Number.isFinite(x)) ? a.map((x) => f(x, 2)).join(" , ") : "—（片体没有质心）");
  const rows = [
    ["体积", `${f(m.volume, 2)} mm³`],
    ["", `${(m.volume / 1000).toFixed(3)} cm³`],
    ["表面积", `${f(m.area, 2)} mm²`],
    ["质心", `(${v3(m.centroid)})`],
    ["包围盒", `${v3(m.bbox.size)} mm`],
    ["最小点", `(${v3(m.bbox.min)})`],
    ["最大点", `(${v3(m.bbox.max)})`],
    ["拓扑", `面 ${shape.faces?.length ?? 0} · 边 ${shape.edges?.length ?? 0}`],
  ];
  body.replaceChildren(...rows.map(([k, v]) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:10px;justify-content:space-between;padding:3px 0;border-bottom:1px dashed #e6edf5";
    const a = document.createElement("span");
    a.textContent = k;
    a.style.cssText = "color:#5a6d82;flex:0 0 auto";
    const b = document.createElement("span");
    b.textContent = v;
    b.style.cssText = "font-variant-numeric:tabular-nums;text-align:right;color:#1a2736";
    row.append(a, b);
    return row;
  }));
  pad.classList.remove("hidden");
  setStats(`测量：体积 ${f(m.volume, 2)} mm³ · 表面积 ${f(m.area, 2)} mm² · 质心 (${v3(m.centroid)})`);
  return m;
}

// ---------------------------------------------------------------- 面拾取（孔 / 移动面 / 曲面共用）
/**
 * 进入「点一个面」状态。
 * 为什么不用 setMode()：setMode 会把 [data-act] 里的「选择」点亮，用户当前的命令高亮就丢了；
 * 这里只改 mode，等真的点到面后再由 afterMode 决定哪个按钮亮着。
 */
function requestFacePick(prompt, onDone, afterMode = "select") {
  if (!shape) { setStats("当前没有实体：先在草图里画轮廓并拉伸，或用「脚本」建一个零件"); return; }
  faceRequest = { prompt, onDone, afterMode };
  mode = "pickface";
  viewer.clearHighlight();
  showPicker(null);
  dim?.hide();
  setStats(`${prompt} —— 手指点一下模型的表面`);
}

function handleFacePick(faceId, point) {
  const req = faceRequest;
  if (faceId == null) {
    // 空白处不改变当前命令：把等待留住，只说清楚为什么没生效
    setStats("没点中实体表面：请点在模型的面上（同一位置连点两次可确认是否命中）");
    return;
  }
  const info = OPS.faceInfo(shape, faceId);
  if (!info) {
    setStats("这个面读不出几何信息（可能刚被布尔改过）· 请重新点一次，或点「适应内容」后再点");
    return;
  }
  faceRequest = null;
  const after = req?.afterMode || "select";
  mode = after;
  for (const b of document.querySelectorAll("[data-act]")) b.classList.toggle("on", b.dataset.act === after);
  viewer.highlightFace(faceId);
  // 落点用**手指点中的那个点**，不用面中心：底板顶面的中心正好在 Ø12 中心孔里，
  // 用它当孔心等于往已有的孔里再打一次，一点材料都去不掉（实测就是这么翻车的）。
  const tap = point && Number.isFinite(point.x) ? [point.x, point.y, point.z] : info.center.slice();
  const sel = {
    at: tap,
    normal: info.normal.slice(),
    planar: faceIsPlanar(faceId),
    faceId,
  };
  req?.onDone?.(sel);
}

// ---------------------------------------------------------------- 孔向导
function updateHoleHint() {
  const el = $("holeHint");
  if (!el) return;
  el.textContent = holeSel
    ? `孔心 (${holeSel.at.map((v) => v.toFixed(1)).join(", ")})`
    : "先在模型上点一个平面";
}

function enterHoleWizard() {
  closeFeaturePads();
  holeSel = null;
  $("holePad").classList.remove("hidden");
  updateHoleHint();
  requestFacePick("孔向导：点一个平面决定孔心与朝向", (sel) => {
    if (!sel.planar) {
      holeSel = null;
      updateHoleHint();
      setStats("孔向导只接受平面：这个面是曲面/圆柱面，请换一个平面面（或先用「分割」切出一个平面）");
      return;
    }
    holeSel = { at: sel.at, normal: sel.normal };
    updateHoleHint();
    setStats(`已选孔位 · 孔心 (${sel.at.map((v) => v.toFixed(1)).join(", ")}) 法向 (${sel.normal.map((v) => v.toFixed(2)).join(", ")})`
      + " · 选孔型、填尺寸后点「应用」");
  }, "hole");
}

function applyHole() {
  if (!shape) { setStats("当前没有实体，打不了孔"); return false; }
  if (!holeSel) { setStats("还没选面：先在模型上点一个平面，再点「应用」"); return false; }
  const need = (id, label) => {
    const v = parseFloat($(id).value);
    if (!Number.isFinite(v)) throw new Error(`${label}要填数字`);
    return v;
  };
  let op;
  try {
    const kind = $("holeKind").value;
    const dia = need("holeDia", "孔径");
    if (!(dia > 0)) throw new Error("孔径必须大于 0");
    op = { type: "hole", at: holeSel.at.slice(), normal: holeSel.normal.slice(), diameter: dia, kind };
    if (kind === "blind") {
      op.depth = need("holeDepth", "盲孔深度");
      if (!(op.depth > 0)) throw new Error("盲孔深度必须大于 0");
    } else if (kind === "counterbore") {
      op.headDiameter = need("holeHeadDia", "沉头径");
      op.headDepth = need("holeHeadDepth", "沉头深");
      if (!(op.headDiameter > dia)) throw new Error("沉头径必须大于孔径");
      if (!(op.headDepth > 0)) throw new Error("沉头深必须大于 0");
    } else if (kind === "countersink") {
      op.headDiameter = need("holeHeadDia", "埋头径");
      op.angle = need("holeAngle", "埋头角");
      if (!(op.headDiameter > dia)) throw new Error("埋头径必须大于孔径");
      if (!(op.angle > 1 && op.angle < 179)) throw new Error("埋头角必须在 1°~179° 之间");
    }
  } catch (e) {
    setStats("孔参数不完整：" + (e?.message || e));
    return false;
  }
  const detail = op.kind === "blind" ? `Ø${op.diameter} 深${op.depth}`
    : op.kind === "counterbore" ? `Ø${op.diameter}/Ø${op.headDiameter}×${op.headDepth}`
    : op.kind === "countersink" ? `Ø${op.diameter}/Ø${op.headDiameter} ${op.angle}°`
    : `Ø${op.diameter}`;
  const ok = runFeatureOp(op, `孔 ${HOLE_KIND_LABEL[op.kind]}`, detail, "hole");
  if (ok) {
    // 连续打孔：保留落点，再点一次面就是换个位置
    setStats($("stats").textContent + " · 点模型换孔位，或点「取消」退出孔向导");
  }
  return ok;
}

// ---------------------------------------------------------------- 统一的特征提交
/**
 * 把一次特征 op 落到模型上（唯一写入点）。
 * 传克隆进内核：布尔会消费入参，而 history 里的上一步还指着同一个实体 ——
 * 不克隆的话「回退一步再前进」会拿到一个已经被吃掉的死对象。
 */
function runFeatureOp(op, label, detail = "", type = op.type) {
  if (!shape) { setStats(`${label}需要先有实体：先建一个零件`); return false; }
  /*
   * hole 是 A 批做进 replay.js 的 switch 的内置特征，没有走 registerOp 注册表；
   * 其余 8 个都注册在表里。这里给它补一个本地执行器，保证「UI 提交」与「重放」
   * 用的是同一份几何语义（同一个 holeAt / 同一份 op 参数）。
   */
  const fn = op.type === "hole" ? (s, o) => OPS.holeAt(s, o) : lookupOp(op.type);
  if (!fn) { setStats(`内核里没有注册「${op.type}」这个特征，不能假装成功`); return false; }
  const t0 = performance.now();
  let next;
  try {
    next = fn(shape.clone(), op);
  } catch (e) {
    setStats(`${label}失败：${e?.message || e}`);
    return false;
  }
  if (!next) { setStats(`${label}没有返回实体（几何可能退化）· 模型保持原样`); return false; }
  const ms = performance.now() - t0;
  let vol = 0, area = 0;
  try { const m = massProperties(next); vol = m.volume; area = m.area; } catch (_) {}
  shape = next;
  selSnap = null;
  commit(label, detail, type, op);
  selectFace(null);
  /*
   * 补面 / 缝合的结果通常就是一张薄片体。不重新取景的话，相机还停在上一版实体的距离上，
   * 片体在斜视角下几乎是一条线、整个画面看不到东西（用户实测反馈）。
   * 这里走项目原有的取景通道：refresh({fit:true}) → viewer.setMesh → OrbitCam.fit(新包围盒)，
   * 不另写一份相机数学。其它特征保持原行为（不打扰用户的视角）。
   */
  const autoFit = type === "surface_fill" || type === "surface_stitch";
  refresh({ fit: autoFit });
  setStats(`${label}${detail ? `（${detail}）` : ""}完成 · 体积 ${vol.toFixed(2)} mm³ · 表面积 ${area.toFixed(2)} mm² · 用时 ${ms.toFixed(0)} ms${autoFit ? " · 已自动适应内容" : ""}`);
  return true;
}

// ---------------------------------------------------------------- 表单构件（内联样式，平板手指可点）
function padRow(labelText, ...nodes) {
  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:13px";
  const lb = document.createElement("span");
  lb.textContent = labelText;
  lb.style.cssText = "min-width:66px;color:#5a6d82;flex:0 0 auto";
  row.append(lb, ...nodes);
  return row;
}
function padInput(value, step = 1) {
  const inp = document.createElement("input");
  inp.type = "number"; inp.inputMode = "decimal"; inp.step = String(step); inp.value = String(value);
  inp.style.cssText = "flex:1;min-width:52px;min-height:44px;padding:6px 10px;border:1px solid #cfd8e3;"
    + "border-radius:8px;font-size:15px;text-align:right;background:#fff;color:#1a2736";
  return inp;
}
function padSelect(options, value) {
  const sel = document.createElement("select");
  sel.style.cssText = "flex:1;min-height:44px;padding:6px 10px;border:1px solid #cfd8e3;border-radius:8px;"
    + "font-size:15px;background:#fff;color:#1a2736";
  for (const [v, t] of options) {
    const o = document.createElement("option");
    o.value = v; o.textContent = t;
    sel.append(o);
  }
  sel.value = value;
  return sel;
}
function padUnit(text) {
  const s = document.createElement("span");
  s.className = "muted";
  s.textContent = text;
  s.style.fontSize = "12px";
  return s;
}
function padButton(text, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.style.cssText = "min-height:44px;padding:6px 12px";
  b.addEventListener("click", onClick);
  return b;
}

// ---------------------------------------------------------------- 布尔 / 分割 / 移动面 / 加厚
function enterSolidPad(tool) {
  if (!shape) { setStats("当前没有实体：先在草图里画轮廓并拉伸，或用「脚本」建一个零件"); return; }
  closeFeaturePads();
  solidTool = tool;
  solidFields = null;
  if (tool === "offsetFace") solidFaceSel = null;
  $("solidPad").classList.remove("hidden");
  renderSolidPad();
  if (tool === "offsetFace") {
    requestFacePick("移动面：点一个要移动的平面", (sel) => {
      if (!sel.planar) {
        setStats("移动面只能整体移动平面；这个面是曲面，请用「曲面」里的偏移，或改原始特征");
        return;
      }
      solidFaceSel = { at: sel.at, normal: sel.normal };
      renderSolidPad();
      setStats(`已选要移动的面 · 中心 (${sel.at.map((v) => v.toFixed(1)).join(", ")}) 法向 (${sel.normal.map((v) => v.toFixed(2)).join(", ")})`
        + " · 填距离后点「应用」（正数长料、负数去料）");
    }, "offsetFace");
  } else {
    setMode(tool);
    setStats({
      combine: "布尔：选并/差/交 + 工具体（圆柱/盒/球）的尺寸与位置，再点「应用」",
      splitPlane: "平面分割：选基准面方向、过点位置和保留侧，再点「应用」",
      thicken: "加厚：填壁厚后点「应用」（闭合空腔，与「抽壳」的开口语义不同）",
    }[tool] || "填参数后点「应用」");
  }
}

function renderSolidPad() {
  const body = $("solidPadBody");
  if (!body) return;
  body.replaceChildren();
  solidFields = {};
  const f = solidFields;
  const foot = $("solidPadFoot");
  if (solidTool === "combine") {
    $("solidPadTitle").textContent = "布尔（合并 / 切除 / 相交）";
    $("solidPadHint").textContent = "工具体按参数建";
    foot.textContent = "位置是世界坐标（mm）：圆柱的 at 是底面圆心、盒的 at 是底面中心、球的 at 是球心";
    f.mode = padSelect([["fuse", "合并（并集）"], ["cut", "切除（差集）"], ["common", "相交（交集）"]], "cut");
    f.type = padSelect([["cylinder", "圆柱"], ["box", "盒"], ["sphere", "球"]], "cylinder");
    body.append(padRow("运算", f.mode), padRow("工具体", f.type));
    const dims = document.createElement("div");
    const pos = document.createElement("div");
    f.dims = dims; f.pos = pos;
    body.append(dims, pos);
    f.keepPos = [15, -10, -6];        // 默认对准底板右前方，切一刀就是通孔效果
    f.type.addEventListener("change", () => rebuildCombineFields());
    rebuildCombineFields();
  } else if (solidTool === "splitPlane") {
    $("solidPadTitle").textContent = "平面分割";
    $("solidPadHint").textContent = "保留一侧";
    foot.textContent = "基准面过原点、沿所选法向平移「过点位置」；保留侧 = 法向那一侧为正";
    f.dir = padSelect([["Z", "法向 +Z（水平面）"], ["X", "法向 +X（YZ 面）"], ["Y", "法向 +Y（XZ 面）"]], "Z");
    f.pos = padInput(4, 0.5);
    f.keep = padSelect([["positive", "保留正侧"], ["negative", "保留负侧"]], "positive");
    body.append(padRow("基准面", f.dir), padRow("过点位置", f.pos, padUnit("mm")), padRow("保留", f.keep));
  } else if (solidTool === "offsetFace") {
    $("solidPadTitle").textContent = "移动面";
    $("solidPadHint").textContent = solidFaceSel
      ? `中心 (${solidFaceSel.at.map((v) => v.toFixed(1)).join(", ")})`
      : "还没选面";
    foot.textContent = "实现走「面沿法向扫成棱柱再并/差」，所以体积严格等于 面积 × 距离";
    f.dist = padInput(3, 0.5);
    body.append(padRow("距离", f.dist, padUnit("mm")));
    body.append(padRow("目标面", padButton("重新点面", () => {
      requestFacePick("移动面：点一个要移动的平面", (sel) => {
        if (!sel.planar) { setStats("移动面只能整体移动平面：这个面是曲面"); return; }
        solidFaceSel = { at: sel.at, normal: sel.normal };
        renderSolidPad();
        setStats("已重新选面 · 填距离后点「应用」");
      }, "offsetFace");
    })));
  } else if (solidTool === "thicken") {
    $("solidPadTitle").textContent = "加厚（闭合空腔）";
    $("solidPadHint").textContent = "整体向内挖";
    foot.textContent = "加厚 = 原实体 − 内缩体：结果是闭合的空腔壳，要开口请用「抽壳」";
    f.t = padInput(2, 0.5);
    body.append(padRow("壁厚", f.t, padUnit("mm")));
  }
}

function rebuildCombineFields() {
  const f = solidFields;
  if (!f?.dims || !f?.type) return;
  // 换工具体类型时把当前位置读出来，别让用户填的坐标被重置
  if (f.fields?.px) {
    const g = (k) => { const v = parseFloat(f.fields[k].value); return Number.isFinite(v) ? v : 0; };
    f.keepPos = [g("px"), g("py"), g("pz")];
  }
  const type = f.type.value;
  f.dims.replaceChildren();
  f.pos.replaceChildren();
  f.fields = {};
  const mk = (key, label, val) => {
    const i = padInput(val, 0.5);
    f.fields[key] = i;
    f.dims.append(padRow(label, i, padUnit("mm")));
  };
  if (type === "cylinder") { mk("r", "半径", 5); mk("h", "高度", 20); }
  else if (type === "box") { mk("w", "宽 X", 12); mk("d", "深 Y", 12); mk("h", "高 Z", 12); }
  else { mk("r", "球半径", 6); }
  const p = f.keepPos || [0, 0, 8];
  f.fields.px = padInput(p[0], 1);
  f.fields.py = padInput(p[1], 1);
  f.fields.pz = padInput(p[2], 1);
  f.pos.append(
    padRow("位置 X", f.fields.px, padUnit("mm")),
    padRow("位置 Y", f.fields.py, padUnit("mm")),
    padRow("位置 Z", f.fields.pz, padUnit("mm")),
  );
}

function numField(container, key, label) {
  const el = container?.[key];
  if (!el) throw new Error(`表单缺少「${label}」输入框`);
  const v = parseFloat(el.value);
  if (!Number.isFinite(v)) throw new Error(`${label}要填数字`);
  return v;
}

function applySolid() {
  const f = solidFields;
  if (!f) { setStats("面板没准备好：重新点一次左侧的按钮"); return false; }
  if (solidTool === "combine") {
    let op;
    try {
      const mode = f.mode.value;
      const type = f.type.value;
      const at = [numField(f.fields, "px", "位置 X"), numField(f.fields, "py", "位置 Y"), numField(f.fields, "pz", "位置 Z")];
      let tool;
      if (type === "cylinder") tool = { shape: "cylinder", r: numField(f.fields, "r", "半径"), h: numField(f.fields, "h", "高度"), at, dir: [0, 0, 1] };
      else if (type === "box") tool = { shape: "box", size: [numField(f.fields, "w", "宽 X"), numField(f.fields, "d", "深 Y"), numField(f.fields, "h", "高 Z")], at };
      else tool = { shape: "sphere", r: numField(f.fields, "r", "球半径"), at };
      op = { type: "combine", mode, tool };
    } catch (e) {
      setStats("布尔参数不完整：" + (e?.message || e));
      return false;
    }
    const MODE_TXT = { fuse: "合并", cut: "切除", common: "相交" };
    const size = op.tool.shape === "cylinder" ? `Ø${(op.tool.r * 2).toFixed(1)}×${op.tool.h}`
      : op.tool.shape === "box" ? op.tool.size.map((v) => +v.toFixed(1)).join("×")
      : `R${op.tool.r}`;
    return runFeatureOp(op, "布尔", `${MODE_TXT[op.mode]} ${size}`, "combine");
  }
  if (solidTool === "splitPlane") {
    let op;
    try {
      const dir = f.dir.value;
      const normal = dir === "X" ? [1, 0, 0] : dir === "Y" ? [0, 1, 0] : [0, 0, 1];
      const d = numField(f, "pos", "过点位置");
      op = { type: "split_plane", origin: [normal[0] * d, normal[1] * d, normal[2] * d], normal, keep: f.keep.value };
    } catch (e) {
      setStats("分割参数不完整：" + (e?.message || e));
      return false;
    }
    const d = op.origin.find((v) => v !== 0) || 0;
    return runFeatureOp(op, "分割", `${op.normal.find((v) => v !== 0) > 0 ? "+" : "-"}${["X", "Y", "Z"][op.normal.findIndex((v) => v !== 0)]}`
      + ` 过 ${d} · 保留${op.keep === "positive" ? "正" : "负"}侧`, "split_plane");
  }
  if (solidTool === "offsetFace") {
    if (!solidFaceSel) { setStats("移动面还没选面：先点「重新点面」在模型上点一个平面"); return false; }
    let op;
    try {
      op = { type: "offset_face", at: solidFaceSel.at.slice(), normal: solidFaceSel.normal.slice(), distance: numField(f, "dist", "距离") };
    } catch (e) {
      setStats("移动面参数不完整：" + (e?.message || e));
      return false;
    }
    return runFeatureOp(op, "移动面", `${op.distance > 0 ? "+" : ""}${op.distance}mm`, "offset_face");
  }
  if (solidTool === "thicken") {
    let op;
    try {
      op = { type: "thicken", thickness: numField(f, "t", "壁厚") };
    } catch (e) {
      setStats("加厚参数不完整：" + (e?.message || e));
      return false;
    }
    return runFeatureOp(op, "加厚", `壁厚 ${op.thickness}mm`, "thicken");
  }
  setStats("这个特征面板还没有实现应用逻辑");
  return false;
}

// ---------------------------------------------------------------- 曲面四件套
// 四个入口放在「曲面」按钮旁边的子菜单（flyout）里：轨道上只有一个主按钮，
// 子菜单每项都能直接打开它自己的参数浮层。
const SURFACE_ENTRIES = [
  ["surfaceOffset", "曲面偏移", "面 / 整体"],
  ["surfaceThicken", "曲面加厚", "面 / 片体"],
  ["surfaceFill", "补面", "四点轮廓"],
  ["surfaceStitch", "缝合", "按容差合片"],
];

function surfaceGroupVisible() {
  return !!$("surfaceGroupPad") && !$("surfaceGroupPad").classList.contains("hidden");
}

// 「曲面」主按钮会被 workspace-ui 搬到右轨，所以全文档找它：不能只从 #toolbar 里查（搬走后查不到）
function surfaceEntryButton() {
  return document.querySelector('#rightToolRail [data-act="surface"]') || document.querySelector('[data-act="surface"]');
}

function closeSurfaceGroup(msg = "") {
  $("surfaceGroupPad")?.classList.add("hidden");
  $("surfaceGroupPad")?.setAttribute("aria-hidden", "true");
  surfaceEntryButton()?.setAttribute("aria-expanded", "false");
  if (msg) setStats(msg);
}

function toggleSurfaceGroup() {
  if (surfaceGroupVisible()) { closeSurfaceGroup("已收起曲面菜单"); return; }
  openSurfaceGroup();
}

function openSurfaceGroup() {
  closeFeaturePads();
  const pad = $("surfaceGroupPad");
  const body = $("sgPadBody");
  if (!pad || !body) { setStats("曲面菜单容器不见了：检查 index.html 里的 #surfaceGroupPad"); return; }
  body.replaceChildren();
  for (const [act, label, sub] of SURFACE_ENTRIES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "flyout-item";
    b.dataset.sact = act;
    b.setAttribute("role", "menuitem");
    b.setAttribute("aria-label", label);
    const name = document.createElement("span");
    name.className = "flyout-name";
    name.textContent = label;
    const hint = document.createElement("span");
    hint.className = "flyout-sub";
    hint.textContent = sub;
    b.append(name, hint);
    // 点一项：收起子菜单 → 打开这一项自己的参数浮层（不是只改样式）
    b.addEventListener("click", () => { closeSurfaceGroup(); enterSurfacePad(act); });
    body.append(b);
  }
  pad.classList.remove("hidden");
  pad.setAttribute("aria-hidden", "false");
  surfaceEntryButton()?.setAttribute("aria-expanded", "true");
  setMode("surface");
  setStats("曲面：偏移 / 加厚 / 补面 / 缝合，点一项打开它的参数");
}

function enterSurfacePad(tool) {
  if (!shape) { setStats("当前没有实体或片体：先建一个零件，或先用「补面」造一张片体"); return; }
  closeFeaturePads();
  surfaceTool = tool;
  surfaceFields = null;
  if (tool !== "surfaceStitch") surfaceFaceSel = null;
  $("surfacePad").classList.remove("hidden");
  renderSurfacePad();
  setMode(tool);
  setStats({
    surfaceOffset: "曲面偏移：选一张面（或整体）填距离，点「应用」",
    surfaceThicken: "曲面加厚：选一张面填厚度，点「应用」",
    surfaceFill: "补面：四点围成闭合轮廓（默认在零件顶面铺 20×20 的片体）",
    surfaceStitch: "缝合：把当前对象的面按容差缝成一体，点「应用」",
  }[tool] || "填参数后点「应用」");
}

function renderSurfacePad() {
  const body = $("surfacePadBody");
  if (!body) return;
  body.replaceChildren();
  surfaceFields = {};
  const f = surfaceFields;
  const foot = $("surfacePadFoot");
  const faceRow = () => padRow("目标面", padButton(surfaceFaceSel ? "重新点面" : "点一个面", () => {
    requestFacePick("点一个面（这张面会被偏移/加厚）", (sel) => {
      surfaceFaceSel = { at: sel.at, normal: sel.normal, planar: sel.planar };
      renderSurfacePad();
      setStats(`已选面 · 中心 (${sel.at.map((v) => v.toFixed(1)).join(", ")}) 法向 (${sel.normal.map((v) => v.toFixed(2)).join(", ")})`);
    }, surfaceTool);
  }));
  if (surfaceTool === "surfaceOffset") {
    $("surfacePadTitle").textContent = "曲面偏移";
    $("surfacePadHint").textContent = surfaceFaceSel ? "已选面" : "未选面";
    foot.textContent = "距离为正长料、为负去料；体积变化严格等于 面积 × 距离";
    f.scope = padSelect([["face", "指定一张面"], ["whole", "整体（所有面一起，会有棱边近似）"]], "face");
    f.dist = padInput(2, 0.5);
    body.append(padRow("范围", f.scope), padRow("距离", f.dist, padUnit("mm")), faceRow());
  } else if (surfaceTool === "surfaceThicken") {
    $("surfacePadTitle").textContent = "曲面加厚";
    $("surfacePadHint").textContent = surfaceFaceSel ? "已选面" : "未选面";
    foot.textContent = "实体上按面加厚；片体上整张加厚成实体";
    f.t = padInput(3, 0.5);
    body.append(padRow("厚度", f.t, padUnit("mm")), faceRow());
  } else if (surfaceTool === "surfaceFill") {
    $("surfacePadTitle").textContent = "补面（四点轮廓）";
    $("surfacePadHint").textContent = "闭合轮廓";
    foot.textContent = "至少三点；这里固定给四点，面积应是 20×20=400 mm²";
    const bb = (() => { try { return shape.boundingBox; } catch (_) { return null; } })();
    const z = bb ? +(bb.center[2] + bb.depth / 2).toFixed(2) : 0;
    const half = 10;
    f.pts = [[-half, -half, z], [half, -half, z], [half, half, z], [-half, half, z]];
    for (let i = 0; i < 4; i++) {
      const cx = padInput(f.pts[i][0], 0.5);
      const cy = padInput(f.pts[i][1], 0.5);
      const cz = padInput(f.pts[i][2], 0.5);
      f.fields = f.fields || {};
      f.fields[`p${i}x`] = cx; f.fields[`p${i}y`] = cy; f.fields[`p${i}z`] = cz;
      body.append(padRow(`点 ${i + 1}`, cx, cy, cz));
    }
  } else if (surfaceTool === "surfaceStitch") {
    $("surfacePadTitle").textContent = "缝合";
    $("surfacePadHint").textContent = "按容差合片";
    foot.textContent = "容差太小缝不上（会报实测间隙），太大可能把不相干的面粘在一起";
    f.tol = padInput(0.01, 0.01);
    body.append(padRow("容差", f.tol, padUnit("mm")));
  }
}

function applySurface() {
  const f = surfaceFields;
  if (!f) { setStats("面板没准备好：重新点一次「曲面」"); return false; }
  if (surfaceTool === "surfaceOffset" || surfaceTool === "surfaceThicken") {
    const whole = surfaceTool === "surfaceOffset" && f.scope.value === "whole";
    if (!whole && !surfaceFaceSel) { setStats("还没选面：点「点一个面」在模型上选一张，或把范围改成「整体」"); return false; }
    let op;
    try {
      if (surfaceTool === "surfaceOffset") {
        op = { type: "surface_offset", distance: numField(f, "dist", "距离") };
        if (whole) op.whole = true;
        else op.face = { at: surfaceFaceSel.at.slice(), normal: surfaceFaceSel.normal.slice() };
      } else {
        op = { type: "surface_thicken", thickness: numField(f, "t", "厚度"), face: { at: surfaceFaceSel.at.slice(), normal: surfaceFaceSel.normal.slice() } };
      }
    } catch (e) {
      setStats("曲面参数不完整：" + (e?.message || e));
      return false;
    }
    return runFeatureOp(op, surfaceTool === "surfaceOffset" ? "曲面偏移" : "曲面加厚",
      `${whole ? "整体" : "单面"} ${op.distance ?? op.thickness}mm`, surfaceTool);
  }
  if (surfaceTool === "surfaceFill") {
    let op;
    try {
      const pts = [0, 1, 2, 3].map((i) => [
        numField(f.fields, `p${i}x`, `点${i + 1} X`),
        numField(f.fields, `p${i}y`, `点${i + 1} Y`),
        numField(f.fields, `p${i}z`, `点${i + 1} Z`),
      ]);
      op = { type: "surface_fill", points: pts };
    } catch (e) {
      setStats("补面参数不完整：" + (e?.message || e));
      return false;
    }
    return runFeatureOp(op, "补面", "4 点轮廓", "surface_fill");
  }
  if (surfaceTool === "surfaceStitch") {
    let op;
    try { op = { type: "surface_stitch", tolerance: numField(f, "tol", "容差") }; }
    catch (e) { setStats("缝合参数不完整：" + (e?.message || e)); return false; }
    return runFeatureOp(op, "缝合", `容差 ${op.tolerance}mm`, "surface_stitch");
  }
  setStats("这个曲面工具还没有实现应用逻辑");
  return false;
}

// ---------------------------------------------------------------- 草图数值工具
const SK_TOOL_TITLE = { polygon: "多边形", slot: "槽口", arc: "三点圆弧", ellipse: "椭圆", trim: "裁剪（按段剪断）" };

function enterSketchToolPad(kind) {
  if (mode !== "sketch" || !sketch) {
    setStats("草图工具要在草图里用：先点左栏「草图」，再在面上点一下开始画");
    return;
  }
  closeFeaturePads();
  skTool = kind;
  // 半截折线先收尾，否则新图元会跟它连在一起
  if (sketch?.draft) sketch.finishPolyline();
  // 浮层开着时画布上的点击只做选择：避免手指一碰就多出一个图元
  sketchTool = "select";
  syncSketchToolUI();
  const title = $("skToolTitle");
  if (title) title.textContent = SK_TOOL_TITLE[kind] || "草图工具";
  renderSkToolPad();
  $("skToolPad").classList.remove("hidden");
  setStats(`${SK_TOOL_TITLE[kind] || "草图工具"}：在浮层里填数值，点「生成」（草图内 2D 坐标，mm）`);
}

function renderSkToolPad() {
  const body = $("skToolBody");
  if (!body) return;
  body.replaceChildren();
  skFields = {};
  const mk = (key, label, val, step = 1) => {
    const i = padInput(val, step);
    skFields[key] = i;
    body.append(padRow(label, i, padUnit("mm")));
  };
  if (skTool === "polygon") {
    mk("cx", "中心 X", 15); mk("cy", "中心 Y", 0); mk("r", "外接半径", 8); mk("n", "边数", 6);
  } else if (skTool === "slot") {
    mk("ax", "起点 X", -20); mk("ay", "起点 Y", 12);
    mk("bx", "终点 X", -6); mk("by", "终点 Y", 12);
    mk("r", "半径", 3, 0.5);
  } else if (skTool === "arc") {
    mk("p1x", "起点 X", -20); mk("p1y", "起点 Y", -12);
    mk("p2x", "中点 X", -14); mk("p2y", "中点 Y", -4);
    mk("p3x", "终点 X", -8); mk("p3y", "终点 Y", -12);
  } else if (skTool === "ellipse") {
    mk("cx", "中心 X", 0); mk("cy", "中心 Y", 14);
    mk("rx", "长半轴", 12, 0.5); mk("ry", "短半轴", 7, 0.5);
  } else if (skTool === "trim") {
    const list = (sketch?.entities || []).map((e, i) => `${i}:${e.kind}`).join("  ") || "（草图里还没有图元）";
    const tip = document.createElement("div");
    tip.className = "dp-hint";
    tip.style.marginBottom = "8px";
    tip.textContent = `现有图元 ${list}`;
    body.append(tip);
    mk("e", "图元序号", (sketch?.entities?.length || 1) - 1);
    mk("seg", "段号", 0);
    mk("qx", "剪断点 X", 0, 0.5);
    mk("qy", "剪断点 Y", 0, 0.5);
  }
}

function applySketchTool() {
  if (!sketch) { setStats("当前没有打开草图：先点「草图」"); return false; }
  const f = skFields;
  try {
    if (skTool === "polygon") {
      const e = addPolygon(sketch, {
        center: [numField(f, "cx", "中心 X"), numField(f, "cy", "中心 Y")],
        r: numField(f, "r", "外接半径"),
        sides: Math.round(numField(f, "n", "边数")),
      });
      redrawSketch(null);
      setStats(`已加正 ${Math.round(numField(f, "n", "边数"))} 边形（外接半径 ${numField(f, "r", "外接半径")}mm，${e.pts.length} 个顶点）· 共 ${sketch.entities.length} 个图元`);
    } else if (skTool === "slot") {
      const e = addSlot(sketch, {
        a: [numField(f, "ax", "起点 X"), numField(f, "ay", "起点 Y")],
        b: [numField(f, "bx", "终点 X"), numField(f, "by", "终点 Y")],
        r: numField(f, "r", "半径"),
      });
      redrawSketch(null);
      setStats(`已加槽口（${e.pts.length} 个采样点）· 共 ${sketch.entities.length} 个图元`);
    } else if (skTool === "arc") {
      const e = addArc(sketch, {
        p1: [numField(f, "p1x", "起点 X"), numField(f, "p1y", "起点 Y")],
        p2: [numField(f, "p2x", "中点 X"), numField(f, "p2y", "中点 Y")],
        p3: [numField(f, "p3x", "终点 X"), numField(f, "p3y", "终点 Y")],
      });
      redrawSketch(null);
      setStats(`已加三点圆弧（开口折线，${e.pts.length} 点；要拉伸请自行补弦闭合成轮廓）· 共 ${sketch.entities.length} 个图元`);
    } else if (skTool === "ellipse") {
      const e = addEllipse(sketch, {
        center: [numField(f, "cx", "中心 X"), numField(f, "cy", "中心 Y")],
        rx: numField(f, "rx", "长半轴"),
        ry: numField(f, "ry", "短半轴"),
      });
      redrawSketch(null);
      setStats(`已加椭圆（${e.pts.length} 个采样点）· 共 ${sketch.entities.length} 个图元`);
    } else if (skTool === "trim") {
      const idx = Math.round(numField(f, "e", "图元序号"));
      const seg = Math.round(numField(f, "seg", "段号"));
      const cut = [numField(f, "qx", "剪断点 X"), numField(f, "qy", "剪断点 Y")];
      const before = sketch.entities.length;
      sketch.entities = trimSegment(sketch.entities, { e: idx, seg }, cut);
      redrawSketch(null);
      setStats(`已剪断图元 ${idx} 的第 ${seg} 段 · 图元数 ${before} → ${sketch.entities.length}`);
    } else {
      setStats("这个草图工具还没有实现「生成」逻辑");
      return false;
    }
  } catch (e) {
    setStats("生成失败：" + (e?.message || e));
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- 取消 / 复位
function cancelFeatureCommand(name) {
  closeFeaturePads();
  faceRequest = null;
  holeSel = null;
  solidFaceSel = null;
  surfaceFaceSel = null;
  solidTool = null;
  surfaceTool = null;
  viewer.clearHighlight();
  setMode("select");
  setStats(`已取消${name}：模型没有变化`);
}

// 新浮层的按钮绑定（都在 index.html 里，逻辑只在这里一处）
$("mPadX").onclick = () => { $("measurePad").classList.add("hidden"); setStats("测量面板已关闭"); };
$("holeGo").onclick = () => applyHole();
$("holeRePick").onclick = () => requestFacePick("孔向导：重新点一个平面", (sel) => {
  if (!sel.planar) { setStats("孔向导只接受平面：这个面是曲面"); return; }
  holeSel = { at: sel.at, normal: sel.normal };
  updateHoleHint();
  setStats("孔位已更新 · 填尺寸后点「应用」");
}, "hole");
$("holeClose").onclick = () => cancelFeatureCommand("孔向导");
$("solidGo").onclick = () => applySolid();
$("solidClose").onclick = () => cancelFeatureCommand(FEATURE_MODE_LABEL[solidTool] || "特征");
$("surfaceGo").onclick = () => applySurface();
$("surfaceClose").onclick = () => cancelFeatureCommand(FEATURE_MODE_LABEL[surfaceTool] || "曲面");
// 曲面子菜单不再有「关闭」按钮：再点一次「曲面」或点菜单外面即收起（workspace-ui.js 处理点外面）
$("skToolGo").onclick = () => applySketchTool();
$("skToolClose").onclick = () => { $("skToolPad").classList.add("hidden"); setStats("已关闭草图工具面板（图元不动）"); };

// 布局移动真实按钮，放在事件绑定之后；画布尺寸变化时同步拾取与捕捉坐标。
workspaceUI = installWorkspaceUI({
  onLayout: () => {
    viewer.resize(); drawSnapOverlay(); updateAxisGizmo(); updateScaleBar();
    syncWorkspaceBottom();          // 外壳刚装好时也要量一次底栏高度
  },
  // 浮层要「贴着选中面的投影」摆：把世界坐标 → 屏幕 client 坐标的能力交给外壳
  project: (p3) => worldToScreen(p3),
  selectionRect: () => selectedFaceScreenRect(),
});

// 长按打开上下文菜单（Afu3D：单指长按 → 移动/删除/圆角/倒角等）
viewer.cam.onLongPress = ({ x, y }) => {
  if (!workspaceUI?.showContextMenu) return;
  const items = [];
  const hasFace = selectedFaceId != null;
  const hasEdges = Array.isArray(edgeSel) && edgeSel.length > 0;
  const inSketch = mode === "sketch" && sketch;

  if (inSketch) {
    items.push({ label: "矩形", action: () => document.querySelector('[data-sact="rect"]')?.click() });
    items.push({ label: "圆形", action: () => document.querySelector('[data-sact="circle"]')?.click() });
    items.push({ label: "直线", action: () => document.querySelector('[data-sact="line"]')?.click() });
    items.push({ label: "智能尺寸", action: () => document.querySelector('[data-sact="dim"]')?.click() });
    items.push({ label: "完成草图", action: () => document.querySelector('[data-sact="finish"]')?.click() });
  } else if (hasEdges || mode === "fillet" || mode === "chamfer") {
    items.push({ label: `圆角`, action: () => document.querySelector('[data-act="fillet"]')?.click() });
    items.push({ label: `倒角`, action: () => document.querySelector('[data-act="chamfer"]')?.click() });
    items.push({ label: "清空边", action: () => { edgeSel = []; viewer.highlightEdges([]); setStats("已清空边的选择"); } });
  } else if (hasFace) {
    items.push({ label: "推拉", action: () => document.querySelector('[data-act="pushpull"]')?.click() });
    items.push({ label: "草图", action: () => document.querySelector('[data-act="sketch"]')?.click() });
    items.push({ label: "圆角", action: () => document.querySelector('[data-act="fillet"]')?.click() });
    items.push({ label: "倒角", action: () => document.querySelector('[data-act="chamfer"]')?.click() });
    items.push({ label: "抽壳", action: () => document.querySelector('[data-act="shell"]')?.click() });
    items.push({ label: "移动", action: () => document.querySelector('[data-act="move"]')?.click() });
    items.push({ label: "阵列", action: () => document.querySelector('[data-act="linearPattern"]')?.click() });
  } else {
    items.push({ label: "绘制", action: () => document.querySelector('[data-act="sketch"]')?.click() });
    items.push({ label: "实体", action: () => document.querySelector('[data-act="pushpull"]')?.click() });
    items.push({ label: "测量", action: () => document.querySelector('[data-act="smartdim"]')?.click() });
    items.push({ label: "适应内容", action: () => viewer.cam.fit(viewer.bbox) });
    items.push({ label: "基准面", action: () => document.querySelector('[data-act="datum"]')?.click() });
  }
  workspaceUI.showContextMenu(x, y, items);
  setStats("长按菜单 · 点选一项，或点空白处关闭");
};

// ---------------------------------------------------------------- 启动
(async function boot() {
  setKernel("加载几何内核 (OCCT · 22MB WASM)…", "");
  try {
    const { ms } = await initKernel();
    setKernel(`内核就绪 · 加载 ${ms.toFixed(0)} ms`, "ok");
  } catch (e) {
    setKernel("内核加载失败：" + (e?.message || e), "err");
    return;
  }
  const t0 = performance.now();
  shape = OPS.starterModel();
  const tGen = performance.now() - t0;
  setupDim();                       // 尺寸手柄（要在自动选中面之前就绪）
  datum = new Datum(viewer);        // 世界坐标系 + XYZ 基准面
  refresh({ fit: true });
  commit("起始零件", "60×40×8 带孔板", "base", { type: "base" });
  setStats(`起始零件生成 ${tGen.toFixed(0)} ms · ` + $("stats").textContent);

  try {
    const top = shape.faces.find((f) => {
      try { const n = OPS.normalOf(f); return n[2] > 0.9 && Math.abs(f.center.z - 8) < 0.5; } catch { return false; }
    });
    if (top) selectFace(top.hashCode);
  } catch (_) {}

  // 默认停在开始界面：起始零件已经在内存里了（切到建模模式会重新画出来），
  // 先把画布清空、建模 UI 收起来，让用户先选模式
  setTreeOpen(false);
  setFeatTreeOpen(false);
  $("toolbar").classList.add("hidden");
  viewer.setMesh({
    vertices: new Float32Array(0), normals: new Float32Array(0),
    triangles: new Uint32Array(0), faceGroups: [], triCount: 0,
  });
  showStartScreen(true);

  // 触控笔悬停虚拟光标：笔尖离屏（未落笔）时指示当前位置；只认 pointerType=pen
  const penCursor = installPenCursor();

  window.__padcad = {
    // 建模脚本入口（AI/外部工具可以直接驱动：runScript(script) / runScript(script,"append")）
    runScript: (script, scriptMode = "replace") => applyModelScript(script, scriptMode),
    runScriptJSON: (text, scriptMode = "replace") => {
      try { return applyModelScript(JSON.parse(text), scriptMode); }
      catch (e) { setStats(`脚本 JSON 解析失败：${e?.message || e}`); return null; }
    },
    normalizeScript,
    exportCurrentAsScript,
    openScriptPad,
    undoScriptRun,
    get scriptUndoAvailable() { return !!scriptUndo; },
    get history() { return history.map((h) => ({ label: h.label, detail: h.detail, op: h.op, suppressed: !!h.suppressed })); },
    get hIndex() { return hIndex; },
    get shape() { return shape; },
    get mode() { return mode; },
    get sketch() { return sketch; },
    get edgeSel() { return edgeSel; },
    viewer, refresh, applyPushPull, setMode, selectFace, enterSketch, exitSketch,
    finishSketch, applyExtrude, setSketchTool: (t) => { sketchTool = t; syncSketchToolUI(); },
    enterEdgeMode, enterShellMode, exitEdgeMode, applyEdgeTool, applyShell,
    pickEdgeAt: (x, y) => viewer.pickEdgeAt(x, y),
    toggleEdge,
    get dim() { return dim; },
    get dimVisible() { return !!dim && dim.visible; },
    forcePreview: (v) => applyDimPreview(v),
    contourPick, setContourPicking,
    get contourPicking() { return contourPicking; },
    get selectedContours() { return sketch ? [...sketch.selected] : []; },
    get contourCount() { return sketch ? sketch.contourCount : 0; },
    previewWireInfo: () => ({
      has: !!viewer.previewWire,
      verts: viewer.previewWire ? viewer.previewWire.geometry.attributes.position.count : 0,
    }),
    faceInfo: (faceId) => OPS.faceInfo(shape, faceId),
    classify: (faceId) => { try { const i = OPS.faceInfo(shape, faceId); return OPS.classifyFace(viewer.meshData, faceId, i ? i.center : null); } catch (_) { return null; } },
    classifyRaw: (faceId) => { const i = OPS.faceInfo(shape, faceId); return OPS.classifyFace(viewer.meshData, faceId, i ? i.center : null); },
    meshInfo: () => ({
      hasMesh: !!viewer.meshData,
      groups: viewer.meshData?.faceGroups?.length ?? 0,
      tris: viewer.meshData?.triCount ?? 0,
      verts: viewer.meshData ? viewer.meshData.vertices.length / 3 : 0,
    }),
    classifySelected: () => faceClass,
    curvedDriver: () => curvedDriver,
    commitDimValue,
    undo, redo, gotoStep, setTreeOpen,
    // 模式切换 / 看图（供测试与外部调用）
    get appMode() { return appMode; },
    enterModelMode, enterViewMode, backToStart, openFile, showStartScreen,
    get viewMesh() { return viewMesh; },
    setFeatTreeOpen, renderFeatTree,
    get featTreeOpen() { return ftOpen; },
    get featNames() { return history.map((h, i) => featureDisplayName(h, i)); },
    renameFeature: (i, nm) => {
      if (history[i] && nm) {
        history[i].customName = nm;
        history[i].label = nm;
        renderFeatTree(); renderTree();
      }
    },
    setViewDisplay: (o) => { if (o.wire != null) viewWireframe = o.wire; if (o.edges != null) viewShowEdges = o.edges; applyViewDisplay(); },
    get viewDisplay() { return { wire: viewWireframe, edges: viewShowEdges }; },
    openSaveDialog, doSave, doLoad, closeSaveDialog,
    listProjects, serializeProject,
    exportStep, askFileName,
    // ---- 本轮 UI 接线：手点与外部驱动走同一批函数（CDP 验收也靠它读状态）----
    exportMesh,
    openMeasurePad,
    enterHoleWizard, applyHole,
    get holeSel() { return holeSel ? { at: [...holeSel.at], normal: [...holeSel.normal] } : null; },
    enterSolidPad, applySolid,
    get solidTool() { return solidTool; },
    get solidFaceSel() { return solidFaceSel ? { at: [...solidFaceSel.at], normal: [...solidFaceSel.normal] } : null; },
    enterSurfacePad, applySurface,
    get surfaceTool() { return surfaceTool; },
    openSurfaceGroup,
    enterSketchToolPad, applySketchTool,
    get skTool() { return skTool; },
    requestFacePick, handleFacePick, cancelFeatureCommand,
    get padsOpen() { return FEATURE_PAD_IDS.filter((id) => $(id) && !$(id).classList.contains("hidden")); },
    enterSmartDimMode, exitSmartDimMode, smartDimPick, applySmartDim, previewSmartDim, cancelSmartDim,
    get smartDimState() {
      return {
        a: spA ? spA.center.map((v) => +v.toFixed(3)) : null,
        b: spB ? spB.center.map((v) => +v.toFixed(3)) : null,
        dist: (spA && spB) ? +faceDistance(spA, spB).toFixed(4) : null,
        previewing: spPreviewing,
        panelVisible: !$("smartPad").classList.contains("hidden"),
      };
    },
    setSmartDimValue: (v) => { $("spVal").value = String(v); },
    findController: (faceId) => {
      const i = OPS.faceInfo(shape, faceId);
      return i ? findController(i).map((c) => ({ ...c, label: c.label })) : null;
    },
    get dimLeader() { return dim._leader; },
    get dimClamped() { return dim.el.classList.contains("clamped"); },
    get dimScr() { return dim._scr; },
    setSaveName: (v) => { $("saveName").value = v; },
    get saveDialogMode() { return saveDialogMode; },
    get saveDialogVisible() { return !$("saveDialog").classList.contains("hidden"); },
    get datum() { return datum; },
    enterSketchOnPlane,
    get historyLen() { return history.length; },
    get hIndex() { return hIndex; },
    get historyLabels() { return history.map((h) => h.label + (h.detail ? " " + h.detail : "")); },
    get historyOps() { return history.map((h) => h.op); },
    get snapBest() { return snap.best; },
    get snapGuides() { return snapGuides; },
    setSnapEnabled: (v) => { snap.setEnabled(v); if (!v) { snapGuides = []; drawSnapOverlay(); } },
    get snapEnabled() { return snap.enabled; },
    updateSnapAt: (x, y) => updateSnap(x, y),
    setSnapTol: (px) => { snap.tolPx = px; },
    dimPick, applyDim, dimPickSmart, dimensionTwoPoints,
    get dimP1() { return dimP1; },
    resolveRef, nearestRefPoint,
    smartDimPickPoint, applySmartSpec, smartDimReset,
    enterRelMode, exitRelMode, relPickPoint, applyRelation, removeRelation,
    enterXform, exitXform, xformPickPoint, applyXform, renderXformPad,
    enterMoveMode, applyMove,
    enterRefGeom, addRefGeom, rebuildRefGeoms,
    setPlanarMode, togglePlanarMode, drawSketchGrid, updateAxisGizmo, updateScaleBar,
    proj3DToSketch, pickModelRefForDim,
    featurePointAt, drawFeaturePoints, lineTap,
    deleteStep, renderFeatTree, gotoStep, toggleSuppress,
    __dbgPreview: (v) => applyDimPreview(v),
    // 测试用：模拟手柄拖动的开始（锁定基准 + 选面），之后就能走完整预览路径
    __dbgStartDrag: (faceId) => {
      dimBase = shape; dimTarget = null;
      if (faceId != null) { setMode('pushpull'); selectFace(faceId); }
      return !!(dimBase && selectedFaceId != null);
    },
    get __dbgDimBase() { return !!dimBase; },
    // 测试用：直接走内核推拉 + 我加的那道退化保护，返回结果
    __dbgPushPull: (faceId, v) => {
      try {
        const next = OPS.pushPullFace(shape, faceId, v);
        const vol = next ? OPS.volumeOf(next) : 0;
        return { 拿到实体: !!next, 体积: +vol.toFixed(3),
                 会被判定为退化: (!next || !isFinite(vol) || vol < 1e-6) };
      } catch (e) { return { 抛错: String(e).slice(0, 90) }; }
    },
    get viewerState() {
      return {
        solidMesh: !!viewer.solidMesh,
        geometry: !!viewer.geometry,
        边数据: (viewer.edgeData || []).length,
        草图线: !!viewer.sketchDone,
        预览线: !!viewer.previewWire,
      };
    },
    get suppressedSteps() { return history.map((h, i) => h.suppressed ? i : -1).filter(x => x >= 0); },
    get renderCount() { return viewer.renderCount; },
    get sketchTool() { return sketchTool; },
    sketchToScreen, redrawSketch, drawSnapOverlay,
    get grabState() { return grabState ? { ...grabState } : null; },
    get camera() { return viewer.camera; },
    get overlayRedraws() { return _overlayRedraws; },
    /** 笔悬停光标：stats() 查 hover/down/exit 计数（hover 恒 0 = 系统没派发笔悬停） */
    get penCursor() { return penCursor; },
    panCamera: (dx, dy) => {
      // 模拟手指拖动平移视角（平面模式下的单指行为）
      const scale = viewer.cam.dist * 0.0022;
      const right = new THREE.Vector3().setFromMatrixColumn(viewer.camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(viewer.camera.matrix, 1);
      viewer.cam.target.addScaledVector(right, -dx * scale);
      viewer.cam.target.addScaledVector(up, dy * scale);
      viewer.cam.update();
      viewer.invalidate();
    },
    zoomCamera: (f) => {
      viewer.cam.dist = THREE.MathUtils.clamp(viewer.cam.dist * f, 5, 5000);
      viewer.cam.update();
      viewer.invalidate();
    },
    get planarMode() { return planarMode; },
    get gizmoSvg() { return $("axisGizmo") ? $("axisGizmo").innerHTML : ""; },
    get scaleText() { return $("sbText") ? $("sbText").textContent : ""; },
    get refGeoms() { return refGeoms.map((d) => ({ ...d })); },
    setRgMode: (m) => { rgMode = m; renderRgPad(); },
    get rgMode() { return rgMode; },
    get xfMode() { return xfMode; },
    get xfSel() { return [...xfSel]; },
    setXfMode: (m) => { xfMode = m; renderXformPad(); },
    get relOn() { return relOn; },
    get relSel() { return relSel.map((s) => ({ ...s })); },
    get relOptions() { return availableRelations(); },
    get constraintCount() { return sketch ? sketch.constraints.length : 0; },
    get smartSel() { return smartSel.map((s) => ({ ...s })); },
    get smartSpec() { return smartSpec; },
    get smartLabel() { return smartSpec ? smartSpec.label : null; },
    showOverdefined,
    solveCurrent: () => {
      if (!sketch) return null;
      const before = JSON.parse(JSON.stringify(sketch.entities));
      const r = solveSketch(sketch.entities, sketch.constraints);
      if (!r.ok) restoreEntities(before);
      redrawSketch();
      return { ok: r.ok, iterations: r.iterations, maxErr: r.maxErr, dof: r.dof, conflicts: r.conflicts };
    },
    get constraintSummary() {
      return sketch ? sketch.constraints.map((c) => c.type + (c.label ? `(${c.label})` : "")) : [];
    },
    refEdge, refFace, offsetPick, applyOffset,
    get offsetEntityIdx() { return offsetEntityIdx; },
    enterLinkMode, exitLinkMode, linkPick,
    setLinkKind: (k) => { linkTargetKind = k; if (linkSource) { linkSource = null; viewer.clearHighlight(); } updateLinkHint(); },
    get linkState() { return { src: linkSource, tgt: linkTarget, kind: linkTargetKind }; },
    faceCenterAt: (x, y) => { const h = viewer.pickAt(x, y); if (!h) return null; const i = OPS.faceInfo(shape, h.faceId); return i ? i.center : null; },
    faceIdAt: (x, y) => { const h = viewer.pickAt(x, y); return h ? h.faceId : null; },
    get dimEntity() { return dimEntity; },
    get constraints() { return sketch ? JSON.parse(JSON.stringify(sketch.constraints)) : []; },
    setEntityScalar: (i, k, v) => {
      const e = sketch?.entities[i];
      if (!e) return null;
      if (k === "w" || k === "h" || k === "r") e[k] = v;
      else if (k === "cx") e.c[0] = v;
      else if (k === "cy") e.c[1] = v;
      return e;
    },
    editStep, applyEdit, closeEdit, previewEdit, cancelEdit,
    get featPreviewing() { return featPreviewing; },
    get editingStep() { return editingStep; },
    setFeatValue: (v) => { $("featVal").value = String(v); },
    rebuildAt: (i, v) => { editStep(i); $("featVal").value = String(v); applyEdit(); },
    exportStepBlob: () => api.exportSTEP([{ shape, name: "part" }]),
    volume: () => { try { return api.measureVolume(shape); } catch (_) { return null; } },
    kernelVolume: (s) => { try { return api.measureVolume(s); } catch (_) { return null; } },
    bbox: () => { try { const b = shape.boundingBox; return [b.width, b.height, b.depth]; } catch (_) { return null; } },
    get selectedFaceId() { return selectedFaceId; },
  };
})();
