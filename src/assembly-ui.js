/**
 * 装配模式 UI（v6 装配路 · UI 层）
 *
 * 这个文件是**独立的一层**：main.js 里只需要一行 `import "./assembly-ui.js";`。
 * 它自己做完下面这些事，不改 main.js / index.html / viewer.js 的任何一行：
 *   1. 等 window.__padcad 就绪 → registerAppMode("assembly", …)
 *   2. 开始界面动态插一个「装配」模式按钮；⋯菜单插一条「转到装配」
 *   3. 进入时藏掉零件模式的实体/棱边/浮层（只改 viewer 的公开属性），
 *      在自己的 THREE.Group 里按实例渲染（零件几何 meshOf 一次，实例共用几何、各自矩阵）
 *   4. 自己用 Raycaster 拾取实例面/边 → 参考 → 配合菜单 → addMate + solveAssembly
 *   5. 单指拖动浮动实例（不吞双指相机手势）、配合列表、干涉、爆炸、导出 STEP、BOM、存档
 *
 * 设计上的三条硬约定（改之前先读）：
 *  - **参考必须来自零件形状（局部坐标系）**：实例几何是 `BRepBuilderAPI_Transform` 出来的一次性
 *    拷贝，faceId 每次换位姿都变；而零件形状的 faceId/几何是稳定的，ref 存局部值才不会一移动就失效。
 *    所以渲染用「零件几何 + 实例矩阵」，拾取命中的 triangle → faceId 也能直接回到零件形状上。
 *  - **不自己判 DOF / 冲突**：一律读 solveAssembly 的返回值（dof / status / conflicts）。
 *  - **拖动是「投影回约束流形」**：把拖动位姿写进去，然后让被拖件保持自由、整体再解一遍；
 *    解的残差若仍然超限才算冲突并回滚。不能 pin 被拖件 —— 那样它自己的配合必然不满足。
 */
import * as THREE from "three";
import "./assembly-ui.css";
import { meshOf, faceIdFromTriangle } from "./kernel.js";
import {
  addInstance, addMate, addPart, copyShape, instanceById, instanceShape, normalizeTransform, partById,
  poseFromTransform, refFromEdge, refFromFace, removeInstance, removeMate, shapeAtTransform,
} from "./assembly.js";
import { dragInstance, setMateValue, solveAssembly, suppressMate } from "./assembly-mates.js";
import { applyExplode, autoExplode, explodePlan, interferenceReport, resetExplode } from "./assembly-inspect.js";
import {
  assemblyBOM, bomText, exportAssemblySTEP, partSourceFromProject,
  partSourceFromStepBytes, restoreAssembly, serializeAssembly,
} from "./assembly-io.js";
import { readStepBytes } from "./step-io.js";
import { placeCardScan } from "./float-layout.js";
import * as M from "./assembly-ui-model.js";
/*
 * 示例装配必须打进 bundle：dev 服务器从工程根目录直接提供 samples/，但 vite build 只拷 public/，
 * APK 里 fetch("samples/…") 恒 404（6.0.0 真机实测「插入示例失败：读取 samples/asm-叠板.json 失败（404）」）。
 */
import SAMPLE_STACK from "../samples/asm-叠板.json";
import SAMPLE_PIN from "../samples/asm-销轴座.json";
const BUNDLED_SAMPLES = { "samples/asm-叠板.json": SAMPLE_STACK, "samples/asm-销轴座.json": SAMPLE_PIN };

const ASM_LS_KEY = "padcad.asm.v1";     // 装配存档键（与零件工程的 padcad.projects.v1 分开）

/*
 * 实例行里的图标（内联 SVG，颜色跟 currentColor 走）。
 * 为什么不用字符：◉/◌ 没有可读含义，用户在平板上只能靠猜（本轮视觉复核第 7 条）。
 * 眼睛=显示/隐藏是通用语义，隐藏时加一道斜线（与 SolidWorks / 资源管理器一致）。
 */
const EYE_ON = `<svg class="asm-eye" viewBox="0 0 24 24" width="20" height="20" fill="none"
  stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF = `<svg class="asm-eye" viewBox="0 0 24 24" width="20" height="20" fill="none"
  stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path d="M4 20 20 4"/></svg>`;

/* ---------------------------------------------------------------- 内置示例
 * 用第一阶段脚本生成的样例装配里**抠出来的零件**当内置示例：
 * 几何是脚本产出的，不手写；同时这两份样例也能在「打开装配」里整装加载。
 */
const BUILTIN_ASM = [
  { key: "stack", label: "叠板（2 件 3 配合）", file: "samples/asm-叠板.json" },
  { key: "pin", label: "销轴座（4 件 7 配合）", file: "samples/asm-销轴座.json" },
];
const BUILTIN_PARTS = [
  { key: "plate", label: "带孔底板 60×40×8", file: "samples/asm-叠板.json", index: 0 },
  { key: "base", label: "销轴座·底座", file: "samples/asm-销轴座.json", index: 0 },
  { key: "pin", label: "销轴座·销 Ø8", file: "samples/asm-销轴座.json", index: 1 },
  { key: "cap", label: "销轴座·上盖", file: "samples/asm-销轴座.json", index: 2 },
];

/* ---------------------------------------------------------------- 运行时状态 */
const S = {
  active: false,
  asm: null,                 // 装配体数据（assembly.js 的结构）
  partShapes: new Map(),     // partId → replicad Shape
  partGeo: new Map(),        // partId → { meshData, geometry, edgeGeometry, shape }
  views: new Map(),          // instId → { mesh, edges, material }
  group: null,               // 装配体 THREE.Group（挂在 viewer.scene 上）
  overlay: null,             // 参考标记 / 干涉体 / 选中高亮
  ray: null,
  solve: null,
  mateMode: false,           // 「配合」工具是否armed
  pickKind: "face",          // face | edge
  pickA: null,               // { inst, ref, label, point }
  pickB: null,
  menuOpen: false,
  menuAnchor: null,
  menuItems: [],
  keypad: null,              // { type, value, flip, need }
  drag: null,
  selInst: null,
  selMate: null,
  confirmDel: null,          // { id }：删除实例的二次确认（平板上 ✕ 紧挨「显隐」，误触要能撤回）
  confirmTimer: 0,
  explodeFactor: 0,
  interf: null,
  saved: null,               // 进入装配前零件模式的现场
  busy: false,
};

const $ = (id) => document.getElementById(id);
const api = () => window.__padcad || null;
const canvas = () => api()?.viewer?.canvas || api()?.viewer?.canvas;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ---------------------------------------------------------------- DOM 骨架 */
const UI = {};
function buildDom() {
  if ($("asmRoot")) return;
  const root = document.createElement("div");
  root.id = "asmRoot";
  root.className = "asm-root hidden";
  root.innerHTML = `
    <div id="asmBar" class="asm-bar">
      <span class="asm-doc" id="asmDocName">装配体</span>
      <button type="button" class="asm-btn sm" data-asm="fit">适应</button>
      <button type="button" class="asm-btn sm" data-asm="exit">退出装配</button>
    </div>
    <nav id="asmRail" class="asm-rail" aria-label="装配工具">
      <button type="button" class="asm-btn" data-asm="insert"><i>＋</i><span>插入</span></button>
      <button type="button" class="asm-btn" data-asm="mate"><i>⌗</i><span>配合</span></button>
      <button type="button" class="asm-btn" data-asm="pickkind"><i>▱</i><span>选面</span></button>
      <button type="button" class="asm-btn" data-asm="interf"><i>◍</i><span>干涉</span></button>
      <button type="button" class="asm-btn" data-asm="explode"><i>⇱</i><span>爆炸</span></button>
      <button type="button" class="asm-btn" data-asm="step"><i>↧</i><span>STEP</span></button>
      <button type="button" class="asm-btn" data-asm="bom"><i>▤</i><span>BOM</span></button>
      <button type="button" class="asm-btn" data-asm="save"><i>▣</i><span>保存</span></button>
      <button type="button" class="asm-btn" data-asm="open"><i>▢</i><span>打开</span></button>
    </nav>
    <aside id="asmPanel" class="asm-panel">
      <div class="asm-sec">
        <div class="asm-sec-head"><b>零件实例</b><span class="asm-dof" id="asmDof">未求解</span></div>
        <div id="asmInstList" class="asm-list"></div>
      </div>
      <div class="asm-sec">
        <div class="asm-sec-head"><b>配合</b><span class="asm-count" id="asmMateCount">0</span></div>
        <div id="asmMateList" class="asm-list"></div>
      </div>
      <div class="asm-sec">
        <div class="asm-sec-head"><b>检查</b><span class="asm-count" id="asmInterfCount"></span></div>
        <div class="asm-explode">
          <span>爆炸</span>
          <div class="asm-slider" data-asm="slider" role="slider" aria-label="爆炸距离" tabindex="0">
            <i id="asmSliderFill"></i><b id="asmSliderKnob"></b>
          </div>
          <em id="asmSliderVal">0%</em>
        </div>
        <div id="asmInterfList" class="asm-list"></div>
        <div id="asmBomBox" class="asm-bom hidden"></div>
      </div>
    </aside>
    <div id="asmHud" class="asm-hud"><span id="asmHint">空装配 · 点左侧「插入」加零件</span></div>
    <div id="asmMenu" class="asm-menu hidden" role="menu"></div>
    <div id="asmKey" class="asm-key hidden"></div>
    <div id="asmSheet" class="asm-sheet hidden"><div class="asm-sheet-card" id="asmSheetCard"></div></div>
    <input type="file" id="asmFileInput" accept="" style="display:none" />`;
  document.body.append(root);
  UI.root = root;
  UI.bar = $("asmBar");
  UI.rail = $("asmRail");
  UI.panel = $("asmPanel");
  UI.instList = $("asmInstList");
  UI.mateList = $("asmMateList");
  UI.dof = $("asmDof");
  UI.hint = $("asmHint");
  UI.menu = $("asmMenu");
  UI.key = $("asmKey");
  UI.sheet = $("asmSheet");
  UI.sheetCard = $("asmSheetCard");
  UI.file = $("asmFileInput");
  UI.interfList = $("asmInterfList");
  UI.bomBox = $("asmBomBox");
  UI.mateCount = $("asmMateCount");

  // 左侧工具轨 / 顶条：全部动作走同一个入口（验收脚本点的是这些真按钮）
  root.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-asm]");
    if (!btn) return;
    const act = btn.dataset.asm;
    if (act === "slider") return;
    if (btn.dataset.role === "slider") return;
    runAction(act);
  });

  // 爆炸滑杆：自己算位置（触摸拖动比 <input type=range> 更稳，也不受平台差异影响）
  const slider = root.querySelector('[data-asm="slider"]');
  let sliding = false;
  const setFromX = (clientX) => {
    const r = slider.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
    setExplodeFactor(f);
  };
  slider.addEventListener("pointerdown", (e) => {
    sliding = true;
    slider.setPointerCapture?.(e.pointerId);
    setFromX(e.clientX);
    e.preventDefault();
  });
  slider.addEventListener("pointermove", (e) => { if (sliding) setFromX(e.clientX); });
  const stopSlide = () => { sliding = false; };
  slider.addEventListener("pointerup", stopSlide);
  slider.addEventListener("pointercancel", stopSlide);

  // 列表里的行内按钮
  UI.panel.addEventListener("click", (e) => {
    const row = e.target.closest?.(".asm-row");
    if (!row) return;
    const btn = e.target.closest?.("[data-act]");
    const instId = row.dataset.inst;
    const mateId = row.dataset.mate;
    if (instId) {
      const act = btn?.dataset.act;
      if (act === "fix") toggleFixed(instId);
      else if (act === "vis") toggleVisible(instId);
      else if (act === "del") requestDeleteInstance(instId);
      else selectInstance(instId, true);
      return;
    }
    if (mateId) {
      const act = btn?.dataset.act;
      if (act === "supp") toggleSuppress(mateId);
      else if (act === "del") deleteMate(mateId);
      else if (act === "flip") flipMate(mateId);
      else highlightMate(mateId);
    }
  });

  // 数字键盘（距离 / 角度）：一次挂好，重画 innerHTML 不影响
  UI.key.addEventListener("click", (e) => onKeypadClick(e));

  // 浮块：点外面关掉（touch 一次会派发一串事件，打开后 150ms 内一律不判「点外面」）
  document.addEventListener("pointerdown", (e) => {
    if (!S.active) return;
    if (S.menuOpen && performance.now() - S.menuAnchor?.t0 > 150 && !UI.menu.contains(e.target)) closeMenu();
    if (S.keypad && performance.now() - (S.keypad.t0 || 0) > 150 && !UI.key.contains(e.target)) closeKeypad();
  }, true);
}

/* ---------------------------------------------------------------- 提示 */
function hint(text) {
  if (UI.hint) UI.hint.textContent = text;
}
function toast(text) {
  hint(text);
  if (UI.hudTimer) clearTimeout(UI.hudTimer);
  UI.hint?.classList.add("flash");
  UI.hudTimer = setTimeout(() => UI.hint?.classList.remove("flash"), 600);
}

/* ---------------------------------------------------------------- 进入 / 退出 */
async function enterAssembly({ loadDef = null } = {}) {
  const P = api();
  if (!P) return false;
  if (S.active) return true;
  if (P.sketch) { toast("先完成草图（或退出草图）再进装配模式"); return false; }
  buildDom();
  S.active = true;

  // 1) 存零件模式的现场（退出时逐项还原）
  const v = P.viewer;
  S.saved = {
    solidVisible: v.solidMesh ? v.solidMesh.visible : null,
    edgeVisible: v.edgeMesh ? v.edgeMesh.visible : null,
    overlayVisible: v.overlay ? v.overlay.visible : null,
    onPick: v.onPick,
    onTap: v.cam.onTap,
    onLongPress: v.cam.onLongPress,
    onDragStart: v.cam.onDragStart,
    docTitle: P.viewer && document.querySelector("#workspaceHeader .documentTitle")?.textContent || "",
  };

  // 2) 藏零件模式的实体与浮层（只动公开属性，不碰 viewer.js）
  if (v.solidMesh) v.solidMesh.visible = false;
  if (v.edgeMesh) v.edgeMesh.visible = false;
  if (v.overlay) v.overlay.visible = false;

  // 3) 自己的组
  S.group = new THREE.Group(); S.group.name = "assembly-group";
  S.overlay = new THREE.Group(); S.overlay.name = "assembly-overlay";
  v.scene.add(S.group, S.overlay);
  /*
   * 从下方看装配体时（配底面必须转到下面），零件的底面孔面几乎全黑 —— HemisphereLight
   * 的地面色是深灰。装配模式临时补一盏自下而上的弱平行光，退出时摘掉（零件模式一点都不受影响）。
   */
  S.light = new THREE.DirectionalLight(0xffffff, 0.8);
  S.light.position.set(20, -30, -100);
  v.scene.add(S.light);
  S.ray = new THREE.Raycaster();

  // 4) 接管画布的手势入口（viewer.cam 的公开回调，退出时原样还回去）
  v.cam.onTap = (pt) => onCanvasTap(pt.x, pt.y);
  v.cam.onLongPress = null;
  v.onPick = () => {};                 // 双保险：装配模式里零件模式的拾取一律不生效
  v.cam.onDragStart = () => false;     // 笔/鼠标也别走进推拉拖动

  // 5) 界面
  document.body.classList.add("asm-mode");
  UI.root.classList.remove("hidden");
  P.showStartScreen(false);
  setPartPanelsHidden(true);
  if (S.asm && !loadDef) { /* 保留上一次的装配体 */ } else if (loadDef) {
    adoptAssembly(loadDef);
  } else if (!S.asm) {
    S.asm = null;
  }
  layoutPanel();
  requestAnimationFrame(() => { layoutPanel(); v.resize(); });
  window.addEventListener("resize", layoutPanel);

  // 6) 先解一遍（重新进入时位姿可能被上次拖动改过）
  if (S.asm) { resolve(asm()); rebuildAll(); fitView(); }
  renderPanel();
  hint(S.asm && S.asm.instances.length
    ? "点左侧「配合」开始加配合；单指拖浮动件、双指转视角"
    : "空装配 · 点左侧「插入」加零件");
  return true;
}

function leaveAssembly({ toModel = true } = {}) {
  if (!S.active) return false;
  const P = api();
  const v = P?.viewer;
  S.active = false;
  closeMenu(); closeKeypad(); closeSheet();
  document.body.classList.remove("asm-mode");
  UI.root?.classList.add("hidden");
  setPartPanelsHidden(false);

  // 场景复原
  try {
    if (S.group) v.scene.remove(S.group);
    if (S.overlay) v.scene.remove(S.overlay);
    if (S.light) v.scene.remove(S.light);
  } catch (_) {}
  S.light = null;
  disposeScene();
  S.group = null; S.overlay = null;

  if (v && S.saved) {
    if (v.solidMesh && S.saved.solidVisible != null) v.solidMesh.visible = S.saved.solidVisible;
    if (v.edgeMesh && S.saved.edgeVisible != null) v.edgeMesh.visible = S.saved.edgeVisible;
    if (v.overlay && S.saved.overlayVisible != null) v.overlay.visible = S.saved.overlayVisible;
    v.onPick = S.saved.onPick;
    v.cam.onTap = S.saved.onTap;
    v.cam.onLongPress = S.saved.onLongPress;
    v.cam.onDragStart = S.saved.onDragStart;
    v.cam.enabled = true;
    v.invalidate();
  }
  window.removeEventListener("resize", layoutPanel);
  S.saved = null;
  S.solve = null;
  S.pickA = S.pickB = null;
  S.mateMode = false;
  if (toModel) {
    try { P.exitAppMode(); } catch (_) {}
    try { P.enterModelMode(); } catch (_) {}
  }
  return true;
}

/** 零件模式那些浮层在装配模式里必须收起来（恢复到「建模模式」时由 enterModelMode 重新放出来） */
const PART_PANELS = ["toolbar", "sketchbar", "edgebar", "picker", "dimPanel", "extrude", "linkbar",
  "smartPad", "movePad", "xformPad", "relPad", "refgPad", "offsetPanel", "patternPanel", "featPanel",
  "status", "viewbar", "measurePad", "holePad", "solidPad", "surfacePad", "skToolPad", "surfaceGroupPad"];
function setPartPanelsHidden(hide) {
  for (const id of PART_PANELS) {
    const el = $(id);
    if (!el) continue;
    if (hide) el.classList.add("hidden");
  }
}

/** 右侧面板底边要躲开右下角的导航簇（#navigationBar 在装配模式里保留，供转视角/视图立方） */
function layoutPanel() {
  if (!UI.panel) return;
  const nav = $("navigationBar");
  let bottom = 12;
  if (nav && !nav.classList.contains("hidden") && getComputedStyle(nav).display !== "none") {
    const r = nav.getBoundingClientRect();
    if (r.height > 4) bottom = Math.max(12, Math.round(window.innerHeight - r.top + 8));
  }
  UI.panel.style.bottom = `${bottom}px`;
  UI.rail.style.maxHeight = `${Math.max(240, window.innerHeight - 150)}px`;
}

/* ---------------------------------------------------------------- 装配体数据 */
const asm = () => S.asm;

function ensureAsm(name = "装配体") {
  if (!S.asm) S.asm = { v: 1, kind: "asm", name, unit: "mm", parts: [], instances: [], mates: [], explode: [] };
  return S.asm;
}

function adoptAssembly(def) {
  const r = restoreAssembly(def);
  S.asm = r.assembly;
  S.partShapes = r.partShapes;
  S.partGeo.clear();
  if (r.warnings?.length) toast(`装配体打开有告警：${r.warnings.join("；")}`);
  renderPanel();
}

function solveNow() {
  if (!S.asm || !S.asm.instances.length) { S.solve = null; return null; }
  try { S.solve = solveAssembly(S.asm); } catch (e) { S.solve = null; console.error(e); }
  return S.solve;
}

/* ---------------------------------------------------------------- 几何 / 场景 */
function partEntryOf(partId) {
  let e = S.partGeo.get(partId);
  if (e) return e;
  const shape = S.partShapes.get(partId);
  if (!shape) return null;
  const meshData = meshOf(shape);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(meshData.vertices, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(meshData.normals, 3));
  g.setIndex(new THREE.BufferAttribute(meshData.triangles, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  g.userData.faceGroups = meshData.faceGroups;
  let edgeGeo = null;
  if (meshData.edges?.positions?.length) {
    edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute("position", new THREE.BufferAttribute(meshData.edges.positions, 3));
    edgeGeo.setIndex(new THREE.BufferAttribute(meshData.edges.index, 1));
  } else {
    edgeGeo = new THREE.EdgesGeometry(g, 18);
  }
  e = { meshData, geometry: g, edgeGeometry: edgeGeo, shape, bbox: shape.boundingBox };
  // 圆边优先：圆柱面的**接缝线**（seam edge）是直线、不可见，但它和孔口圆边在屏幕上重叠；
  // 实测点在孔口上时接缝线常以 0~1px 的差距胜出，于是「同轴」把孔轴对到接缝线上，偏了整整一个半径（3mm）。
  // 圆边（孔口/轴肩）本身也是装配里最常用的轴参考，所以给它 4px 的加权。
  e.circleEdgeIds = new Set();
  try {
    for (const edge of shape.edges || []) {
      if (edge.geomType === "CIRCLE") e.circleEdgeIds.add(edge.hashCode);
    }
  } catch (_) { /* 个别边取不到类型就当非圆边 */ }
  S.partGeo.set(partId, e);
  return e;
}

const _matCache = new Map();
function materialOf(color) {
  const key = color || "#c8b6a0";
  let m = _matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: new THREE.Color(key), metalness: 0.05, roughness: 0.66, flatShading: true });
    _matCache.set(key, m);
  }
  return m;
}
const matAsmEdge = new THREE.LineBasicMaterial({ color: 0x423e36, transparent: true, opacity: 0.55 });

const matrixOfInst = (inst) => {
  const tr = normalizeTransform(inst?.transform);
  const m = new THREE.Matrix4();
  m.compose(
    new THREE.Vector3(tr.t[0], tr.t[1], tr.t[2]),
    new THREE.Quaternion(tr.r[0], tr.r[1], tr.r[2], tr.r[3]),
    new THREE.Vector3(1, 1, 1),
  );
  return m;
};

/** 全量重建：实例集合变了（插入/删除）才走这条路；拖动只改矩阵 */
function rebuildAll() {
  if (!S.group) return;
  const a = asm();
  const alive = new Set();
  if (a) {
    for (const inst of a.instances) {
      const entry = partEntryOf(inst.partId);
      if (!entry) continue;
      alive.add(inst.id);
      let view = S.views.get(inst.id);
      if (!view) {
        const mesh = new THREE.Mesh(entry.geometry, materialOf(inst.color || M.ASM_COLORS[0]));
        mesh.userData.instanceId = inst.id;
        mesh.userData.faceGroups = entry.meshData.faceGroups;
        const edges = new THREE.LineSegments(entry.edgeGeometry, matAsmEdge);
        view = { mesh, edges, entry };
        S.views.set(inst.id, view);
        S.group.add(mesh, edges);
      }
      view.entry = entry;
      view.mesh.material = materialOf(inst.color || M.ASM_COLORS[0]);
      view.mesh.material.wireframe = false;
      view.mesh.visible = inst.visible !== false;
      view.edges.visible = inst.visible !== false;
      view.mesh.matrixAutoUpdate = false;
      view.edges.matrixAutoUpdate = false;
      const m = matrixOfInst(inst);
      view.mesh.matrix.copy(m);
      view.edges.matrix.copy(m);
      view.mesh.matrixWorldNeedsUpdate = true;
      view.edges.matrixWorldNeedsUpdate = true;
    }
  }
  for (const [id, view] of [...S.views]) {
    if (alive.has(id)) continue;
    S.group.remove(view.mesh, view.edges);
    S.views.delete(id);
  }
  api()?.viewer?.invalidate();
}

/** 只同步矩阵（拖动 / 爆炸：几何不动，所以每帧只写 matrix） */
function syncMatrices() {
  const a = asm();
  if (!a) return;
  for (const inst of a.instances) {
    const view = S.views.get(inst.id);
    if (!view) continue;
    const m = matrixOfInst(inst);
    view.mesh.matrix.copy(m);
    view.edges.matrix.copy(m);
    view.mesh.matrixWorldNeedsUpdate = true;
    view.edges.matrixWorldNeedsUpdate = true;
    const vis = inst.visible !== false;
    view.mesh.visible = vis;
    view.edges.visible = vis;
  }
  api()?.viewer?.invalidate();
}

function disposeScene() {
  for (const view of S.views.values()) { S.group?.remove(view.mesh, view.edges); }
  S.views.clear();
  for (const e of S.partGeo.values()) {
    try { e.geometry.dispose(); } catch (_) {}
    try { e.edgeGeometry.dispose(); } catch (_) {}
  }
  S.partGeo.clear();
  clearOverlay();
  for (const m of _matCache.values()) { try { m.dispose(); } catch (_) {} }
  _matCache.clear();
}

function clearOverlay() {
  if (!S.overlay) return;
  for (const child of [...S.overlay.children]) {
    S.overlay.remove(child);
    child.traverse?.((o) => {
      if (o.geometry && !o.geometry.__shared) { try { o.geometry.dispose(); } catch (_) {} }
      if (o.material && !o.material.__shared) { try { o.material.dispose(); } catch (_) {} }
    });
  }
  api()?.viewer?.invalidate();
}

function fitView() {
  const a = asm();
  const v = api()?.viewer;
  if (!a || !a.instances.length || !v) return;
  const box = new THREE.Box3();
  for (const inst of a.instances) {
    const entry = partEntryOf(inst.partId);
    if (!entry?.geometry?.boundingBox) continue;
    box.union(entry.geometry.boundingBox.clone().applyMatrix4(matrixOfInst(inst)));
  }
  if (box.isEmpty()) return;
  v.resize();
  v.cam.fit(box);
  fitToVisibleArea(box);
  v.invalidate();
}

/**
 * 把模型框进「画布上真正没被挡住的那块区域」。
 *
 * cam.fit 只知道整块画布：装配模式里左侧工具轨 + 右侧面板占掉了两侧，按整画布取景
 * 零件会一半压在面板底下（实测爆炸视图里下板右上角压在面板边、换视角后又钻到工具轨底下）。
 * 做法：把盒子的 8 个角投影到屏幕，量出包围矩形；
 *   1) 宽度/高度超出可见区就按比例拉远；
 *   2) 包围矩形中心与可见区中心的偏差换算成世界毫米，平移观察点。
 * 迭代两轮足够收敛（投影是透视的，一次不一定准）。
 */
function fitToVisibleArea(box) {
  const v = api()?.viewer;
  const cv = canvas();
  if (!v || !cv) return;
  const cw = cv.clientWidth || window.innerWidth;
  const ch = cv.clientHeight || window.innerHeight;
  const r = cv.getBoundingClientRect();
  const railR = UI.rail?.getBoundingClientRect();
  const panelR = UI.panel?.getBoundingClientRect();
  const visLeft = Math.max(r.left + 8, (railR?.right || r.left) + 8);
  const visRight = Math.min(r.right - 8, (panelR?.left || r.right) - 8);
  const visW = Math.max(120, visRight - visLeft);
  const visH = Math.max(120, ch - 24);
  const visCx = (visLeft + visRight) / 2 - r.left;
  const visCy = r.top + ch / 2 - r.top;
  const mmPerPx = () => (2 * v.cam.dist * Math.tan((v.camera.fov * Math.PI) / 180 / 2)) / ch;
  const right = new THREE.Vector3();

  for (let iter = 0; iter < 2; iter++) {
    const proj = projectBox(box, v.camera, cw, ch);
    if (!proj) return;
    const w = proj.maxX - proj.minX;
    const h = proj.maxY - proj.minY;
    let scale = 1;
    if (w > visW * 0.94) scale = Math.max(scale, w / (visW * 0.94));
    if (h > visH * 0.94) scale = Math.max(scale, h / (visH * 0.94));
    if (scale > 1.0001) {
      v.cam.dist = Math.min(5000, v.cam.dist * scale);
      v.cam.update();
      continue;                       // 拉远后重新量一次
    }
    const dxPx = (proj.minX + proj.maxX) / 2 - visCx;
    const dyPx = (proj.minY + proj.maxY) / 2 - visCy;
    if (Math.abs(dxPx) < 2 && Math.abs(dyPx) < 2) return;
    const k = mmPerPx();
    right.setFromMatrixColumn(v.camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(v.camera.matrix, 1);
    v.cam.target.addScaledVector(right, dxPx * k);
    v.cam.target.addScaledVector(up, -dyPx * k);
    v.cam.update();
  }
}

/** 世界包围盒 → 屏幕包围矩形（用三个轴的极值组合近似 8 角，够用于取景） */
function projectBox(box, camera, cw, ch) {
  const p = new THREE.Vector3();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        p.set(x, y, z).project(camera);
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
        const sx = ((p.x + 1) / 2) * cw;
        const sy = ((1 - p.y) / 2) * ch;
        minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
      }
    }
  }
  return { minX, maxX, minY, maxY };
}

/* ---------------------------------------------------------------- 拾取 */
function ndcOf(x, y) {
  const cv = canvas();
  const r = cv.getBoundingClientRect();
  return {
    v: new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1),
    rect: r,
  };
}

function pickInstance(x, y) {
  const P = api();
  if (!P || !S.group) return null;
  const { v } = ndcOf(x, y);
  S.ray.setFromCamera(v, P.viewer.camera);
  const meshes = [...S.views.values()].filter((w) => w.mesh.visible).map((w) => w.mesh);
  if (!meshes.length) return null;
  const hits = S.ray.intersectObjects(meshes, false);
  if (!hits.length) return null;
  const h = hits[0];
  const inst = instanceById(asm(), h.object.userData.instanceId);
  if (!inst) return null;
  const faceId = faceIdFromTriangle(h.object.userData.faceGroups, h.faceIndex);
  return { inst, faceId, point: h.point.clone(), dist: h.distance };
}

/**
 * 屏幕坐标 → 最近的实例棱边（选边模式用：把每条拓扑边投影到屏幕，取 18px 内最近的一条）。
 * 装配体边数很少（底板 15 条），每次点按全量投影就够了，不需要缓存。
 */
function pickEdge(x, y, maxPx = 18) {
  const P = api();
  const a = asm();
  if (!P || !a) return null;
  const camera = P.viewer.camera;
  const { rect } = ndcOf(x, y);
  const v3 = new THREE.Vector3();
  const project = (px, py, pz, m) => {
    v3.set(px, py, pz).applyMatrix4(m).project(camera);
    return { x: rect.left + ((v3.x + 1) / 2) * rect.width, y: rect.top + ((1 - v3.y) / 2) * rect.height };
  };
  let best = null;
  for (const inst of a.instances) {
    if (inst.visible === false) continue;
    const entry = partEntryOf(inst.partId);
    const edges = entry?.meshData?.edges;
    if (!edges) continue;
    const m = matrixOfInst(inst);
    const pos = edges.positions;
    for (const g of edges.groups) {
      for (let i = g.start; i + 1 < g.start + g.count; i++) {
        const a1 = project(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], m);
        const b1 = project(pos[(i + 1) * 3], pos[(i + 1) * 3 + 1], pos[(i + 1) * 3 + 2], m);
        const d = pointSegDist(x, y, a1, b1);
        if (d > maxPx) continue;
        const score = d - (entry.circleEdgeIds?.has(g.edgeId) ? 4 : 0);
        if (!best || score < best.score) {
          best = { score, d, inst, edgeId: g.edgeId, point: new THREE.Vector3(
            (pos[i * 3] + pos[(i + 1) * 3]) / 2,
            (pos[i * 3 + 1] + pos[(i + 1) * 3 + 1]) / 2,
            (pos[i * 3 + 2] + pos[(i + 1) * 3 + 2]) / 2) };
        }
      }
    }
  }
  return best;
}

function pointSegDist(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  let t = L2 ? ((px - a.x) * dx + (py - a.y) * dy) / L2 : 0;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/** 拾取 → 参考（**必须回到零件形状**，ref 存的是零件局部坐标） */
function refOfPick(pick) {
  const part = partById(asm(), pick.inst.partId);
  const entry = partEntryOf(pick.inst.partId);
  if (!part || !entry) return null;
  try {
    if (pick.edgeId != null) {
      return { ref: refFromEdge(entry.shape, pick.edgeId), kindWord: "边", pick };
    }
    if (pick.faceId == null) return null;
    return { ref: refFromFace(entry.shape, pick.faceId), kindWord: "面", pick };
  } catch (e) {
    toast(`这个${pick.edgeId != null ? "边" : "面"}不能做配合参考：${e?.message || e}`);
    return null;
  }
}

/* ---------------------------------------------------------------- 点按分流 */
function onCanvasTap(x, y) {
  if (!S.active) return;
  if (S.menuOpen) { closeMenu(); return; }
  if (S.keypad) { closeKeypad(); return; }
  if (S.sheet && !UI.sheet.classList.contains("hidden")) { closeSheet(); return; }

  const pick = S.pickKind === "edge"
    ? (pickEdge(x, y) || pickInstance(x, y))
    : (pickInstance(x, y) || null);

  if (!pick) {
    S.pickA = S.pickB = null;
    S.selInst = null;
    clearOverlay();
    renderPanel();
    hint(S.mateMode ? "没点中：靠近模型的面再点一下" : "点空白 · 没有选中任何零件");
    return;
  }

  if (!S.mateMode) {
    selectInstance(pick.inst.id, true);
    hint(`已选 ${pick.inst.name}${pick.inst.fixed ? "（固定件）" : "（可拖动）"}`);
    return;
  }

  const ref = refOfPick(pick);
  if (!ref) return;

  if (!S.pickA) {
    S.pickA = { inst: pick.inst, ...ref, worldPoint: pick.point };
    showRefMarkers();
    hint(`参考 A：${pick.inst.name}·${ref.kindWord} · 再点第二个零件的面或边`);
    renderPanel();
    return;
  }
  if (pick.inst.id === S.pickA.inst.id) {
    S.pickA = { inst: pick.inst, ...ref, worldPoint: pick.point };
    showRefMarkers();
    hint(`参考 A 已换成 ${pick.inst.name}·${ref.kindWord} · 再点第二个零件`);
    return;
  }
  S.pickB = { inst: pick.inst, ...ref, worldPoint: pick.point };
  showRefMarkers();
  openMateMenu(x, y);
}

function selectInstance(id, highlight = false) {
  S.selInst = id;
  if (highlight) {
    clearOverlay();
    const inst = instanceById(asm(), id);
    if (inst) drawInstanceOutline(inst);
  }
  renderPanel();
}

/* ---------------------------------------------------------------- 参考标记 / 高亮 */
const _segMat = new THREE.LineDashedMaterial({ color: 0xbf5634, dashSize: 3, gapSize: 2, depthTest: false, transparent: true });
const _segMatB = new THREE.LineDashedMaterial({ color: 0x006a70, dashSize: 3, gapSize: 2, depthTest: false, transparent: true });

function refMarkObject(inst, ref, tone = "a") {
  const entry = partEntryOf(inst.partId);
  if (!entry) return null;
  const g = new THREE.Group();
  g.matrixAutoUpdate = false;
  g.matrix.copy(matrixOfInst(inst));
  const color = tone === "b" ? 0x006a70 : 0xbf5634;
  if (ref.kind === "plane") {
    const fg = entry.meshData.faceGroups.find((x) => isSamePlane(entry.shape, x.faceId, ref));
    if (fg) {
      const pos = entry.meshData.vertices, idx = entry.meshData.triangles;
      const arr = [];
      for (let t = fg.start; t < fg.start + fg.count; t++) {
        for (let k = 0; k < 3; k++) {
          const vi = idx[t * 3 + k];
          arr.push(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(arr), 3));
      geo.computeVertexNormals();
      const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.34, side: THREE.DoubleSide,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      });
      g.add(new THREE.Mesh(geo, mat));
    }
  }
  // 轴 / 点 / 面法向：画一条线或一个点标记（面也给一条法向线，方向一眼能看出来）
  const bb = entry.bbox || { width: 60, height: 40, depth: 8 };
  const L = Math.max(10, Math.hypot(bb.width || 60, bb.height || 40, bb.depth || 8) * 0.6);
  const o = ref.point;
  let d = ref.kind === "axis" ? ref.direction : ref.kind === "plane" ? ref.normal : null;
  if (d) {
    const geo = new THREE.BufferGeometry();
    const half = L / 2;
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
      o[0] - d[0] * half, o[1] - d[1] * half, o[2] - d[2] * half,
      o[0] + d[0] * half, o[1] + d[1] * half, o[2] + d[2] * half,
    ]), 3));
    const line = new THREE.Line(geo, tone === "b" ? _segMatB : _segMat);
    line.computeLineDistances?.();
    g.add(line);
  } else {
    const geo = new THREE.SphereGeometry(Math.max(1.6, L * 0.045), 12, 8);
    g.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 })));
  }
  return g;
}

function isSamePlane(shape, faceId, ref) {
  try {
    const f = (shape.faces || []).find((x) => x.hashCode === faceId);
    if (!f || f.geomType !== "PLANE") return false;
    const c = f.center;
    const dist = (c.x - ref.point[0]) * ref.normal[0] + (c.y - ref.point[1]) * ref.normal[1]
      + (c.z - ref.point[2]) * ref.normal[2];
    if (Math.abs(dist) > 1e-6) return false;
    const uv = f.uvCoordinates([c.x, c.y, c.z]);
    const n = f.normalAt(uv[0], uv[1]);
    // 法向也要同向：z=0 与 z=8 两个平行面不能互相当成对方
    return n.x * ref.normal[0] + n.y * ref.normal[1] + n.z * ref.normal[2] > 0.99;
  } catch (_) { return false; }
}

function showRefMarkers() {
  if (!S.overlay) return;
  clearOverlay();
  if (S.pickA) {
    const o = refMarkObject(S.pickA.inst, S.pickA.ref, "a");
    if (o) S.overlay.add(o);
  }
  if (S.pickB) {
    const o = refMarkObject(S.pickB.inst, S.pickB.ref, "b");
    if (o) S.overlay.add(o);
  }
  api()?.viewer?.invalidate();
}

function drawInstanceOutline(inst) {
  const entry = partEntryOf(inst.partId);
  if (!entry || !S.overlay) return;
  const g = new THREE.Group();
  g.matrixAutoUpdate = false;
  g.matrix.copy(matrixOfInst(inst));
  const mat = new THREE.LineBasicMaterial({ color: 0xbf5634, depthTest: false, transparent: true, opacity: 0.95 });
  g.add(new THREE.LineSegments(entry.edgeGeometry, mat));
  S.overlay.add(g);
  api()?.viewer?.invalidate();
}

/* ---------------------------------------------------------------- 配合菜单 */

/**
 * 某个「参考」在屏幕上占的矩形（实例的某个面 / 边投影包围盒）。
 *
 * 配合菜单必须躲开它 —— 菜单压在被选中的面上，用户就看不到自己刚选了什么
 * （本轮视觉复核第 5 条：菜单被夹到 y=8 之后整个盖住第二个落点）。
 * 计算方式与 screenPointOnFace 同源：零件局部 mesh + 实例矩阵投影，取包围盒。
 */
function refScreenRect(pickRef) {
  if (!pickRef) return null;
  const inst = instanceById(asm(), pickRef.inst.id);
  const entry = partEntryOf(inst?.partId);
  const P = api();
  if (!inst || !entry || !P) return null;
  const md = entry.meshData;
  const cam = P.viewer.camera;
  const cv = canvas();
  const rect = cv.getBoundingClientRect();
  const m = matrixOfInst(inst);
  const v3 = new THREE.Vector3();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const put = (x, y, z) => {
    v3.set(x, y, z).applyMatrix4(m).project(cam);
    const sx = rect.left + ((v3.x + 1) / 2) * rect.width;
    const sy = rect.top + ((1 - v3.y) / 2) * rect.height;
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;
  };
  const ref = pickRef.ref || pickRef;
  if (ref.kind === "plane") {
    const fg = md.faceGroups.find((x) => isSamePlane(entry.shape, x.faceId, ref));
    if (!fg) return null;
    const pos = md.vertices, idx = md.triangles;
    for (let t = fg.start; t < fg.start + fg.count; t++) {
      for (let k = 0; k < 3; k++) {
        const i = idx[t * 3 + k];
        put(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      }
    }
  } else if (ref.kind === "axis") {
    const edges = md.edges;
    const g = (edges?.groups || []).find((q) => (entry.shape.edges || []).some((e) => e.hashCode === q.edgeId && sameAxis(entry.shape, e, ref)));
    if (!g) return null;
    const pos = edges.positions;
    for (let i = g.start; i < g.start + g.count; i++) put(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  } else {
    return null;
  }
  if (!isFinite(minX)) return null;
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

/** 与 ref 同轴的边（refScreenRect 找圆边用） */
function sameAxis(shape, edge, ref) {
  try {
    const c = edge.center;
    const d = ref.dir || [0, 0, 1];
    return Math.abs(c.x - ref.point[0]) < 1e-3 && Math.abs(c.y - ref.point[1]) < 1e-3;
  } catch (_) { return false; }
}

function openMateMenu(x, y) {
  const a = asm();
  const kindA = S.pickA.ref.kind, kindB = S.pickB.ref.kind;
  const types = M.mateTypesFor(kindA, kindB);
  if (!types.length) {
    hint(`${M.refKindWord(S.pickA.ref)} ↔ ${M.refKindWord(S.pickB.ref)} 之间没有可用的配合`);
    return;
  }
  S.menuItems = [M.ALIGN_ITEM, ...types];
  S.menuAnchor = { x, y, t0: performance.now() };
  UI.menu.innerHTML = `
    <div class="asm-menu-head">${esc(S.pickA.inst.name)}·${M.refKindWord(S.pickA.ref)}
      <b>↔</b> ${esc(S.pickB.inst.name)}·${M.refKindWord(S.pickB.ref)}</div>
    <div class="asm-menu-grid${S.menuItems.length >= 6 ? " cols-3" : ""}">
      ${S.menuItems.map((it) => `<button type="button" class="asm-mate-btn${it.oneShot ? " on" : ""}"
        data-mtype="${it.type}"><i>${it.icon}</i><span>${it.label}</span></button>`).join("")}
    </div>
    <div class="asm-menu-foot">对齐：一次性到位，不建立配合关系</div>
    <button type="button" class="asm-menu-cancel" data-mcancel="1" aria-label="取消这次配合">取消</button>`;
  UI.menu.classList.remove("hidden");
  S.menuOpen = true;
  renderPanel();      // 配合列表的空态文案要立刻反映"两个面都选好了"
  /*
   * 位置：贴着第二个落点，但必须**同时**躲开两个被选面在屏幕上的投影。
   * 之前 avoid 里只有浮层，没有模型；而 placeCard 只按"离锚点近"打分，
   * 高度 298 的菜单被夹到 y=8 时正中落在落点上方 —— 于是把两个面全盖住。
   */
  const r = UI.menu.getBoundingClientRect();
  const avoid = avoidRects();
  for (const p of [S.pickA, S.pickB]) {
    const q = refScreenRect(p);
    if (q) avoid.push(q);
  }
  // 高度 300+ 的菜单贴着锚点的 8 个候选位常常全压在面上，所以用扫描式选位（见 float-layout 注释）
  const placed = placeCardScan({
    anchor: { x, y },
    size: { w: r.width || 250, h: r.height || 180 },
    viewport: { w: window.innerWidth, h: window.innerHeight },
    avoid,
    avoidPoints: [{ x, y }],
    margin: 8,
    step: 12,
  });
  UI.menu.style.left = `${Math.round(placed.x)}px`;
  UI.menu.style.top = `${Math.round(placed.y)}px`;
  UI.menu.dataset.side = placed.side;
  S.menuPlacement = { side: placed.side, overlap: placed.overlap, coversPoint: placed.coversPoint, scanned: placed.scanned };

  for (const btn of UI.menu.querySelectorAll("[data-mtype]")) {
    btn.addEventListener("click", () => chooseMate(btn.dataset.mtype));
  }
  // 「取消」是这次配合的退出路径：两个参考一起清掉，工具仍 armed（方便接着配下一个）
  UI.menu.querySelector("[data-mcancel]")?.addEventListener("click", () => {
    S.pickA = S.pickB = null;
    closeMenu();
    showRefMarkers();
    renderPanel();
    hint("已取消这次配合 · 重新点两个面/边");
  });
  hint("选一个配合类型");
}

function avoidRects() {
  const out = [];
  for (const el of [UI.panel, UI.rail, $("navigationBar"), UI.bar, $("workspaceHeader"), $("shellTopLeft")]) {
    if (!el) continue;
    if (el.classList.contains("hidden") || el.hidden) continue;
    if (getComputedStyle(el).display === "none") continue;
    const r = el.getBoundingClientRect();
    if (r.width > 4 && r.height > 4) out.push({ x: r.left - 6, y: r.top - 6, w: r.width + 12, h: r.height + 12 });
  }
  return out;
}

function closeMenu() {
  S.menuOpen = false;
  UI.menu?.classList.add("hidden");
}

function chooseMate(type) {
  if (type === "align") { closeMenu(); applyAlign(); return; }
  closeMenu();
  const item = S.menuItems.find((i) => i.type === type);
  if (M.VALUE_MATES.has(type)) { openKeypad(item); return; }
  applyMate(type, { value: 0, flip: null });
}

/* ---------------------------------------------------------------- 数字键盘（距离 / 角度） */
function openKeypad(item) {
  const poseA = poseFromTransform(S.pickA.inst.transform);
  const poseB = poseFromTransform(S.pickB.inst.transform);
  const meas = M.measurePair(S.pickA.ref, poseA, S.pickB.ref, poseB);
  const need = item.unit === "°" ? meas.angleDeg : meas.distance;
  const init = Number.isFinite(need) ? +need.toFixed(2) : 0;
  S.keypad = { type: item.type, value: String(init), flip: false, unit: item.unit || "", t0: performance.now(), label: item.label };
  renderKeypad();
  UI.key.classList.remove("hidden");
  UI.key.style.left = "50%";
  UI.key.style.transform = "translateX(-50%)";
  UI.key.style.bottom = "120px";
  UI.key.style.top = "auto";
}

function renderKeypad() {
  const k = S.keypad;
  if (!k) return;
  const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "±"];
  UI.key.innerHTML = `
    <div class="asm-key-head"><b>${esc(k.label)}</b><span>${k.unit}</span>
      <button type="button" class="asm-mini" data-k="close">✕</button></div>
    <div class="asm-key-val" id="asmKeyVal">${esc(k.value)}<em>${esc(k.unit)}</em></div>
    <div class="asm-key-grid">
      ${digits.map((d) => `<button type="button" data-k="${esc(d)}">${d}</button>`).join("")}
      <button type="button" data-k="back">⌫</button>
    </div>
    <div class="asm-key-foot">
      <button type="button" class="asm-flip${k.flip ? " on" : ""}" data-k="flip">⇄ 翻转</button>
      <button type="button" class="asm-btn primary" data-k="ok">确定</button>
    </div>`;
}

/** 键盘的点击统一在 buildDom 里挂一次（每次重画 innerHTML 后不需要重挂监听器） */
function onKeypadClick(e) {
  const btn = e.target.closest?.("[data-k]");
  if (!btn) return;
  const k = S.keypad;
  if (!k) return;
  const key = btn.dataset.k;
  if (key === "close") { closeKeypad(); return; }
  if (key === "back") { k.value = k.value.slice(0, -1) || "0"; renderKeypad(); return; }
  if (key === "±") { k.value = k.value.startsWith("-") ? k.value.slice(1) : `-${k.value}`; renderKeypad(); return; }
  if (key === "flip") { k.flip = !k.flip; renderKeypad(); return; }
  if (key === "ok") {
    const v = Number(k.value);
    if (!Number.isFinite(v)) { toast("请输一个数字"); return; }
    const { type, flip } = k;
    closeKeypad();
    applyMate(type, { value: v, flip });
    return;
  }
  if (/^[0-9.]$/.test(key)) {
    const next = k.value === "0" && key !== "." ? key : k.value + key;
    if (next.replace("-", "").split(".").length > 2) { renderKeypad(); return; }
    k.value = next.slice(0, 12);
    renderKeypad();
  }
}

function closeKeypad() {
  S.keypad = null;
  UI.key?.classList.add("hidden");
}

/* ---------------------------------------------------------------- 应用配合 / 对齐 */
function labelOf(pick) {
  return `${pick.inst.name}·${M.refKindWord(pick.ref)}`;
}

function applyMate(type, { value = 0, flip = null } = {}) {
  const a = asm();
  if (!a || !S.pickA || !S.pickB) return;
  const before = clone(a.instances);
  let mate = null;
  try {
    mate = addMate(a, {
      type,
      a: { inst: S.pickA.inst.id, ref: clone(S.pickA.ref) },
      b: { inst: S.pickB.inst.id, ref: clone(S.pickB.ref) },
      value,
      flip,
      label: `${labelOf(S.pickA)} ↔ ${labelOf(S.pickB)}`,
    });
    const res = solveAssembly(a);
    if (res.status !== "solved") {
      // 冲突：不应用（回滚配合 + 位姿），并点名是哪条配合
      removeMate(a, mate.id);
      a.instances.forEach((inst, i) => { inst.transform = before[i].transform; });
      S.solve = solveAssembly(a);
      syncMatrices(); renderPanel();
      const names = (res.conflicts || []).map((id) => (a.mates.find((m) => m.id === id)?.label || id)).join("、");
      toast(`配合冲突，未应用：${names || "残差超限"}（残差 ${M.formatResidual(res.maxResidual)}）`);
      return;
    }
    S.solve = res;
    // 诊断留痕：最后一条配合的两侧参考（验收脚本要能看见 ref 的实际几何值）
    S.lastMate = { id: mate.id, type, a: clone(S.pickA.ref), b: clone(S.pickB.ref), value, flip: mate.flip };
    S.pickA = S.pickB = null;
    clearOverlay();
    rebuildAll();
    renderPanel();
    const d = M.dofLabel(res);
    hint(`已加${M.MATE_META[type]?.label || type} · ${d.text}${res.overDefined ? " · 有多余配合" : ""}`);
  } catch (e) {
    if (mate) { try { removeMate(a, mate.id); } catch (_) {} }
    a.instances.forEach((inst, i) => { inst.transform = before[i].transform; });
    S.solve = solveNow();
    syncMatrices(); renderPanel();
    toast(`加配合失败：${e?.message || e}`);
  }
}

function applyAlign({ flip = false } = {}) {
  const a = asm();
  if (!a || !S.pickA || !S.pickB) return;
  const inst = S.pickB.inst;
  const before = clone(inst.transform);
  const next = M.alignTransform(
    S.pickA.ref, poseFromTransform(S.pickA.inst.transform),
    S.pickB.ref, poseFromTransform(inst.transform), { flip },
  );
  inst.transform = normalizeTransform(next);
  const res = solveAssembly(a);
  if (res.status !== "solved") {
    inst.transform = before;
    S.solve = solveAssembly(a);
    syncMatrices(); renderPanel();
    toast("对齐后会与已有配合矛盾（残差超限），已回滚");
    return;
  }
  S.solve = res;
  S.pickA = S.pickB = null;
  clearOverlay();
  rebuildAll();
  renderPanel();
  hint(`已对齐 ${inst.name} · ${M.dofLabel(res).text}（未建配合）`);
}

/* ---------------------------------------------------------------- 拖动 */
function screenDeltaToWorld(dx, dy) {
  const P = api();
  const cam = P.viewer.camera;
  const h = canvas().clientHeight || window.innerHeight;
  const scale = (2 * P.viewer.cam.dist * Math.tan((cam.fov * Math.PI) / 180 / 2)) / h;
  const right = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 1);
  const out = new THREE.Vector3().addScaledVector(right, dx * scale).addScaledVector(up, -dy * scale);
  return [out.x, out.y, out.z];
}

function beginDrag(e, inst) {
  if (inst.fixed) {
    toast(`${inst.name} 是固定件（f）：先在右侧列表点「浮动」再拖`);
    return false;
  }
  const cam = api().viewer.cam;
  S.drag = {
    id: inst.id, pointerId: e.pointerId, sx: e.clientX, sy: e.clientY,
    t0: [...normalizeTransform(inst.transform).t], r0: [...normalizeTransform(inst.transform).r],
    last: clone(inst.transform), moved: 0, raf: 0, pending: null,
  };
  // 关掉相机（单指拖动期间不能同时转视角）。camera 内部记账要一并清掉，
  // 否则它在 pointerup 时会误判成「点击」并触发零件模式的拾取。
  cam.enabled = false;
  cam._clearLongPress?.();
  if (cam.pointers?.has(e.pointerId)) cam.pointers.delete(e.pointerId);
  try { canvas().setPointerCapture?.(e.pointerId); } catch (_) {}
  return true;
}

function flushDrag() {
  const d = S.drag;
  if (!d || !d.pending) return;
  const { dx, dy } = d.pending;
  d.pending = null;
  const a = asm();
  const inst = instanceById(a, d.id);
  if (!inst) return;
  const w = screenDeltaToWorld(dx, dy);
  const t = [d.t0[0] + w[0], d.t0[1] + w[1], d.t0[2] + w[2]];
  dragInstance(a, d.id, { t, r: d.r0 }, { solve: false });
  if (a.mates.length) {
    const res = solveAssembly(a);
    if (res.status !== "solved") {
      inst.transform = clone(d.last);
      if (!d.warned) { d.warned = true; toast("拖到配合以外的位置会被拉回来（配合优先）"); }
    } else {
      d.last = clone(inst.transform);
      S.solve = res;
    }
  } else {
    d.last = clone(inst.transform);
  }
  syncMatrices();
}

function endDrag() {
  const d = S.drag;
  if (!d) return;
  if (d.raf) cancelAnimationFrame(d.raf);
  S.drag = null;
  const cam = api().viewer.cam;
  cam.enabled = true;
  try { canvas().releasePointerCapture?.(d.pointerId); } catch (_) {}
  S.solve = solveNow();
  syncMatrices();
  renderPanel();
  if (d.moved < 6) {
    // 没动 → 当成一次点击（相机被关掉期间 onTap 不会触发）
    onCanvasTap(d.sx, d.sy);
  } else {
    const inst = instanceById(asm(), d.id);
    hint(`已移动 ${inst?.name || ""} · ${M.dofLabel(S.solve).text}`);
  }
}

/* ---------------------------------------------------------------- 面板渲染 */
function renderPanel() {
  if (!UI.root) return;
  const a = asm();
  const d = M.dofLabel(S.solve);
  UI.dof.textContent = d.text;
  UI.dof.dataset.tone = d.tone;
  UI.dof.title = d.hint || "";
  UI.mateCount && (UI.mateCount.textContent = String(a?.mates?.length || 0));

  // 实例
  if (!a || !a.instances.length) {
    UI.instList.innerHTML = `<div class="asm-empty">还没有零件 · 点左侧「＋ 插入」</div>`;
  } else {
    UI.instList.innerHTML = a.instances.map((inst) => {
      const part = partById(a, inst.partId);
      const sel = S.selInst === inst.id ? " sel" : "";
      const nMate = a.mates.filter((m) => m.a.inst === inst.id || m.b.inst === inst.id).length;
      const sub = `${part?.name || inst.partId} · ${nMate} 配合`;
      const full = M.instanceSubtitle(a, inst, part?.name);
      const shown = inst.visible !== false;
      // 删除要二次确认（平板上 ✕ 紧挨着「显隐」，误触概率很高，且删除同时会掉配合）
      const armed = !!(S.confirmDel && S.confirmDel.id === inst.id);
      return `<div class="asm-row${sel}" data-inst="${esc(inst.id)}" title="${esc(full)}">
        <i class="asm-swatch" style="background:${esc(inst.color || M.ASM_COLORS[0])}" title="该实例的显示色 ${esc(inst.color || M.ASM_COLORS[0])}"></i>
        <div class="asm-row-main">
          <b>${esc(inst.name)}${inst.fixed ? ' <em class="asm-fixed">(f)</em>' : ""}</b>
          <small>${esc(sub)}</small>
        </div>
        <button type="button" class="asm-mini as-fix${inst.fixed ? " on" : ""}" data-act="fix"
          aria-pressed="${inst.fixed ? "true" : "false"}"
          title="${inst.fixed ? "固定件：不参与求解，点一下改成浮动" : "浮动件：参与求解，点一下固定"}">${inst.fixed ? "固定" : "浮动"}</button>
        <button type="button" class="asm-mini as-vis${shown ? " on" : ""}" data-act="vis"
          aria-label="${shown ? "隐藏这个零件" : "显示这个零件"}" aria-pressed="${shown ? "true" : "false"}"
          title="${shown ? "隐藏这个零件（模型与列表都变灰）" : "显示这个零件"}">${shown ? EYE_ON : EYE_OFF}</button>
        <button type="button" class="asm-mini as-del${armed ? " armed" : ""}" data-act="del" data-armed="${armed ? "1" : "0"}"
          aria-label="${armed ? `确认删除 ${inst.name}` : `删除 ${inst.name}`}"
          title="${armed ? "再点一次就删除（5 秒内有效）" : "删除这个实例（会连它的配合一起删；需要点两次确认）"}">${armed ? "确认" : "✕"}</button>
      </div>`;
    }).join("");
  }

  // 配合
  if (!a || !a.mates.length) {
    /*
     * 空态文案必须跟着"已经选了什么"走（本轮视觉复核第 6 条）：
     * 两个面都选好、配合菜单已经弹出来的时候还写"点配合后依次点两个面"，等于在骂用户没照做。
     */
    UI.mateList.innerHTML = `<div class="asm-empty">${esc(mateEmptyText())}</div>`;
  } else {
    const per = new Map((S.solve?.perMate || []).map((p) => [p.id, p]));
    UI.mateList.innerHTML = a.mates.map((mate) => {
      const sum = M.mateSummary(mate, a);
      const info = per.get(mate.id);
      const res = info ? info.residual : null;
      const bad = res != null && res > 1e-6;
      const sel = S.selMate === mate.id ? " sel" : "";
      const off = mate.suppressed ? " off" : "";
      // 残差放标题行（副标题那点宽度装不下「名字 + 残差」，实测 122px 需求只有 80px 可用）
      const full = `${sum.title} ${sum.valueText || ""} ${sum.sides} · ${sum.refs}${res != null ? ` · 残差 ${M.formatResidual(res)}` : ""}${info && info.dofRemoved === 0 ? " · 多余配合" : ""}`;
      const badge = res != null ? `<em class="asm-res ${bad ? "asm-bad" : "asm-ok"}">${M.formatResidual(res)}</em>` : "";
      return `<div class="asm-row${sel}${off}" data-mate="${esc(mate.id)}" title="${esc(full)}">
        <i class="asm-swatch asm-ico">${sum.icon}</i>
        <div class="asm-row-main">
          <b>${esc(sum.title)}${sum.valueText ? ` <em class="asm-val">${esc(sum.valueText)}</em>` : ""}${sum.flipText ? ` <em class="asm-dim">${esc(sum.flipText)}</em>` : ""}${badge}${info && info.dofRemoved === 0 ? ' <em class="asm-warn">多余</em>' : ""}</b>
          <small>${esc(sum.sidesShort)} · ${esc(sum.refsShort)}</small>
        </div>
        <button type="button" class="asm-mini" data-act="flip" aria-label="翻转">⇄</button>
        <button type="button" class="asm-mini${mate.suppressed ? " on" : ""}" data-act="supp">${mate.suppressed ? "解除" : "压制"}</button>
        <button type="button" class="asm-mini" data-act="del" aria-label="删除">✕</button>
      </div>`;
    }).join("");
  }

  // 干涉结果
  if (S.interf) {
    const rep = S.interf;
    $("asmInterfCount").textContent = rep.pairs.length ? `${rep.pairs.length} 处` : "无干涉";
    UI.interfList.innerHTML = rep.pairs.length
      ? rep.pairs.map((p) => `<div class="asm-row compact">
          <i class="asm-swatch asm-badbg"></i>
          <div class="asm-row-main"><b>${esc(p.names[0])} × ${esc(p.names[1])}</b>
          <small>重叠体积 ${(+p.volume).toFixed(3)} mm³（${M.formatVolume(p.volume)}）</small></div>
        </div>`).join("")
      : `<div class="asm-empty ok">没有干涉 · 检查了 ${rep.checked} 对（预筛跳过 ${rep.skipped} 对）</div>`;
  } else {
    // 位姿一变（拖动/爆炸/加配合）旧结果就作废：必须连 DOM 一起清，否则界面上留着假的干涉
    $("asmInterfCount").textContent = "";
    UI.interfList.innerHTML = "";
  }
  UI.rail.querySelector('[data-asm="mate"]')?.classList.toggle("on", S.mateMode);
  UI.rail.querySelector('[data-asm="pickkind"] span').textContent = S.pickKind === "edge" ? "选边" : "选面";
}

/* ---------------------------------------------------------------- 列表操作 */
/**
 * 删除实例要**点两次**（第一次进确认态，5 秒内再点才真删）。
 * 平板上一行里三个 44px 按钮紧挨着，✕ 与眼睛只隔 8px；更麻烦的是删实例会连带删配合，
 * 撤销栈里也没有它 —— 误触的代价太大，所以确认态就做在原地（不弹第二个浮层）。
 */
function requestDeleteInstance(id) {
  const a = asm();
  const inst = instanceById(a, id);
  if (!inst) return;
  if (S.confirmDel && S.confirmDel.id === id) {
    S.confirmDel = null;
    clearTimeout(S.confirmTimer);
    deleteInstance(id);
    return;
  }
  S.confirmDel = { id, t0: performance.now() };
  renderPanel();
  hint(`${inst.name}：再点一次「确认」才删除（5 秒内有效，点别处即取消）`);
  clearTimeout(S.confirmTimer);
  S.confirmTimer = setTimeout(() => {
    if (S.confirmDel && S.confirmDel.id === id) { S.confirmDel = null; renderPanel(); }
  }, 5000);
}

/** 配合列表的空态文案：跟着「已经选到第几个参考」走 */
function mateEmptyText() {
  if (!S.mateMode) return "没有配合 · 点左侧「⌗ 配合」后依次点两个面/边";
  if (S.pickA && S.pickB) return `已选 ${S.pickA.inst.name}·${M.refKindWord(S.pickA.ref)} ↔ ${S.pickB.inst.name}·${M.refKindWord(S.pickB.ref)} · 在弹出的菜单里选配合类型`;
  if (S.pickA) return `已选参考 A：${S.pickA.inst.name}·${M.refKindWord(S.pickA.ref)} · 再点第二个零件的面或边`;
  return "配合已开启 · 依次点两个面/边（不同零件之间）";
}

function toggleFixed(id) {
  const a = asm();
  const inst = instanceById(a, id);
  if (!inst) return;
  inst.fixed = !inst.fixed;
  if (inst.fixed) inst.color = inst.color || M.instanceColor(a.instances.indexOf(inst));
  S.solve = solveNow();
  syncMatrices(); renderPanel();
  hint(`${inst.name} 现在是${inst.fixed ? "固定件（不参与求解）" : "浮动件（参与求解）"}`);
}

function toggleVisible(id) {
  const a = asm();
  const inst = instanceById(a, id);
  if (!inst) return;
  inst.visible = inst.visible === false;
  syncMatrices(); renderPanel();
}

function deleteInstance(id) {
  const a = asm();
  const inst = instanceById(a, id);
  if (!inst) return;
  const n = a.mates.filter((m) => m.a.inst === id || m.b.inst === id).length;
  removeInstance(a, id);
  S.selInst = null;
  if (S.pickA?.inst.id === id) S.pickA = null;
  if (S.pickB?.inst.id === id) S.pickB = null;
  S.solve = solveNow();
  clearOverlay();
  S.confirmDel = null;
  clearTimeout(S.confirmTimer);
  rebuildAll(); renderPanel();
  hint(`已删除 ${inst.name}${n ? `（连带 ${n} 个配合）` : ""}`);
}

function deleteMate(id) {
  const a = asm();
  removeMate(a, id);
  S.selMate = null;
  S.solve = solveNow();
  rebuildAll(); renderPanel();
  hint("已删除配合");
}

function toggleSuppress(id) {
  const a = asm();
  const m = a.mates.find((x) => x.id === id);
  if (!m) return;
  suppressMate(a, id, !m.suppressed, { solve: false });
  S.solve = solveNow();
  rebuildAll(); renderPanel();
  hint(`${m.suppressed ? "已压制" : "已解除压制"} · ${M.dofLabel(S.solve).text}`);
}

function flipMate(id) {
  const a = asm();
  const m = a.mates.find((x) => x.id === id);
  if (!m) return;
  const before = clone(a.instances);
  m.flip = !m.flip;
  const res = solveAssembly(a);
  if (res.status !== "solved") {
    m.flip = !m.flip;
    a.instances.forEach((inst, i) => { inst.transform = before[i].transform; });
    S.solve = solveAssembly(a);
    toast("翻转后会冲突，已回滚（可先压制其它配合再翻）");
  } else {
    S.solve = res;
    toast(`已翻转对齐方向 · ${M.dofLabel(res).text}`);
  }
  syncMatrices(); renderPanel();
}

function highlightMate(id) {
  const a = asm();
  const m = a.mates.find((x) => x.id === id);
  if (!m) return;
  S.selMate = id;
  clearOverlay();
  const ia = instanceById(a, m.a.inst), ib = instanceById(a, m.b.inst);
  if (ia && m.a.ref) { const o = refMarkObject(ia, m.a.ref, "a"); if (o) S.overlay.add(o); }
  if (ib && m.b.ref) { const o = refMarkObject(ib, m.b.ref, "b"); if (o) S.overlay.add(o); }
  api()?.viewer?.invalidate();
  renderPanel();
  hint(`${M.mateSummary(m, a).title} · 两侧参考已在视口标出`);
}

/* ---------------------------------------------------------------- 干涉 */
function runInterference() {
  const a = asm();
  if (!a || a.instances.length < 2) { toast("至少要有两个实例才能查干涉"); return null; }
  const t0 = performance.now();
  let rep;
  try { rep = interferenceReportLocal(a); } catch (e) { toast(`干涉检查失败：${e?.message || e}`); return null; }
  rep.ms = +(performance.now() - t0).toFixed(1);
  S.interf = rep;
  clearOverlay();
  showInterferenceBodies(rep);
  renderPanel();
  hint(rep.pairs.length
    ? `查出 ${rep.pairs.length} 处干涉（红色半透明为重叠体）· 合计 ${rep.totalVolume.toFixed(2)} mm³`
    : `没有干涉 · 检查 ${rep.checked} 对，预筛跳过 ${rep.skipped} 对 · ${rep.ms} ms`);
  return rep;
}

/**
 * 干涉检查。数字一律来自 assembly-inspect 的 interferenceReport（判据只有一处：
 * 包围盒预筛 + 公共体积 > 1e-6），这里额外把命中的「重叠体」留下来渲染成红色半透明
 * ——那条 API 为了不把内核句柄泄漏给调用方，会把 common 删掉，所以只对命中的对再算一次。
 */
function interferenceReportLocal(a) {
  const rep = interferenceReport(a, S.partShapes);
  rep.pairs = rep.pairs.map((p) => {
    const A = instanceById(a, p.a), B = instanceById(a, p.b);
    let common = null;
    try {
      const ca = copyShape(instanceShape(A, S.partShapes));
      const cb = copyShape(instanceShape(B, S.partShapes));
      common = ca.intersect(cb);
    } catch (e) { console.error("干涉体求交失败", e); }
    return { ...p, shape: common };
  });
  return rep;
}

function showInterferenceBodies(rep) {
  if (!S.overlay) return;
  for (const p of rep.pairs) {
    if (!p.shape) continue;
    try {
      const md = meshOf(p.shape);
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(md.vertices, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(md.normals, 3));
      g.setIndex(new THREE.BufferAttribute(md.triangles, 1));
      const mat = new THREE.MeshBasicMaterial({
        color: 0xc71529, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide,
      });
      S.overlay.add(new THREE.Mesh(g, mat));
      if (md.edges?.positions?.length) {
        const eg = new THREE.BufferGeometry();
        eg.setAttribute("position", new THREE.BufferAttribute(md.edges.positions, 3));
        eg.setIndex(new THREE.BufferAttribute(md.edges.index, 1));
        S.overlay.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x8c0f1e })));
      }
      try { p.shape.delete?.(); } catch (_) {}
      p.shape = null;
    } catch (e) { console.error("干涉体显示失败", e); }
  }
  api()?.viewer?.invalidate();
}

/** 实例形状（世界位姿）—— 只在干涉 / 导出这类要与内核打交道的场合才建（assembly.js 有缓存） */
function shapeOfInstance(inst) {
  return instanceShape(inst, S.partShapes);
}

/* ---------------------------------------------------------------- 爆炸 */
function setExplodeFactor(f) {
  const a = asm();
  if (!a) return;
  const factor = Math.min(1, Math.max(0, f));
  if (factor > 0 && !(a.explode || []).length) {
    /*
     * 爆炸幅度按装配体自身尺寸给（固定 40mm 在 60×40 的板上会把件顶出画面：
     * 实测爆炸 100% 时上板整块跑到视口上方被裁掉）。取外接盒对角线的一半左右，
     * 第一次进入爆炸再把视图拉到能看全。
     */
    const box = new THREE.Box3();
    for (const inst of a.instances) {
      const entry = partEntryOf(inst.partId);
      if (entry?.geometry?.boundingBox) box.union(entry.geometry.boundingBox.clone().applyMatrix4(matrixOfInst(inst)));
    }
    const size = box.isEmpty() ? new THREE.Vector3(60, 40, 8) : box.getSize(new THREE.Vector3());
    const gap = Math.max(8, Math.min(50, Math.hypot(size.x, size.y, size.z) * 0.22));
    autoExplode(a, S.partShapes, { gap });
    /*
     * 取景必须按「100% 爆炸」那一帧算：滑杆是从 0 一路拖上去的，若在刚离开 0 时取景，
     * 等拖到 100% 零件已经飞出画面（实测上板被顶部裁掉）。所以先按 1.0 摆一次、取景，再摆回当前值。
     */
    applyExplode(a, 1);
    syncMatrices();
    fitView();
  }
  if (factor === 0) resetExplode(a);
  else applyExplode(a, factor);
  S.explodeFactor = factor;
  S.interf = null;
  clearOverlay();
  syncMatrices();
  const pct = Math.round(factor * 100);
  const fill = $("asmSliderFill"), knob = $("asmSliderKnob"), val = $("asmSliderVal");
  if (fill) fill.style.width = `${pct}%`;
  if (knob) knob.style.left = `${pct}%`;
  if (val) val.textContent = `${pct}%`;
  renderPanel();
}

/* ---------------------------------------------------------------- 动作入口 */
function runAction(act) {
  switch (act) {
    case "fit": fitView(); hint("已适应视图"); break;
    case "exit": leaveAssembly({ toModel: true }); break;
    case "insert": openInsertSheet(); break;
    case "mate": toggleMateMode(); break;
    case "pickkind":
      S.pickKind = S.pickKind === "edge" ? "face" : "edge";
      renderPanel();
      hint(S.pickKind === "edge" ? "选边模式：点实例的棱边（18px 内最近的一条）" : "选面模式：点实例的面");
      break;
    case "interf": runInterference(); break;
    case "explode": {
      if (S.explodeFactor > 0) { setExplodeFactor(0); hint("已收起爆炸视图"); }
      else { setExplodeFactor(1); hint("爆炸到 100% · 拖右侧滑杆调幅度"); }
      break;
    }
    case "step": exportStep(); break;
    case "bom": openBomSheet(); break;
    case "save": openSaveSheet(); break;
    case "open": openOpenSheet(); break;
    default: break;
  }
}

function toggleMateMode() {
  S.mateMode = !S.mateMode;
  S.pickA = S.pickB = null;
  clearOverlay();
  renderPanel();
  hint(S.mateMode
    ? "智能配合：点第一个零件的面/边 → 再点第二个零件的面/边"
    : "已退出配合工具（点面只会选中实例）");
}

/* ---------------------------------------------------------------- 插入 */
function openSheet(html) {
  UI.sheetCard.innerHTML = html;
  UI.sheet.classList.remove("hidden");
}
function closeSheet() { UI.sheet?.classList.add("hidden"); }

async function loadJson(file) {
  if (BUNDLED_SAMPLES[file]) return structuredClone(BUNDLED_SAMPLES[file]);
  const res = await fetch(new URL(file, document.baseURI));
  if (!res.ok) throw new Error(`读取 ${file} 失败（${res.status}）`);
  return res.json();
}

function openInsertSheet() {
  const P = api();
  const saved = listSavedParts();
  openSheet(`
    <div class="asm-sheet-head"><b>插入零件</b><button type="button" class="asm-mini" data-sheet="close">✕</button></div>
    <div class="asm-sheet-body">
      <div class="asm-sheet-sec"><h4>内置示例零件</h4>
        <div class="asm-chipgrid">
          ${BUILTIN_PARTS.map((p) => `<button type="button" class="asm-chip" data-builtin="${p.key}">${esc(p.label)}</button>`).join("")}
        </div>
      </div>
      <div class="asm-sheet-sec"><h4>当前零件（工程快照）</h4>
        <button type="button" class="asm-chip" data-sheet="current">把「${esc(P?.history?.[0]?.label || "当前零件")}」插入装配</button>
        <p class="asm-dim">快照会把当前零件的特征定义内嵌进装配体，改原零件不影响已插入的实例。</p>
      </div>
      <div class="asm-sheet-sec"><h4>已保存工程</h4>
        <div class="asm-chipgrid">${saved.projects.length
          ? saved.projects.map((n) => `<button type="button" class="asm-chip" data-proj="${esc(n)}">${esc(n)}</button>`).join("")
          : '<span class="asm-dim">没有已保存的零件工程</span>'}</div>
      </div>
      <div class="asm-sheet-sec"><h4>STEP 文件</h4>
        <button type="button" class="asm-chip" data-sheet="step">选择 .step / .stp 文件…</button>
        <p class="asm-dim">多实体 STEP 会按一个零件插入（与看图模式的读法一致）。</p>
      </div>
    </div>`);
  UI.sheetCard.querySelectorAll("[data-sheet]").forEach((b) => {
    b.addEventListener("click", () => {
      const v = b.dataset.sheet;
      if (v === "close") closeSheet();
      else if (v === "current") insertCurrentPart();
      else if (v === "step") UI.file.click();
    });
  });
  UI.sheetCard.querySelectorAll("[data-builtin]").forEach((b) => {
    b.addEventListener("click", () => insertBuiltinPart(b.dataset.builtin));
  });
  UI.sheetCard.querySelectorAll("[data-proj]").forEach((b) => {
    b.addEventListener("click", () => insertFromProject(b.dataset.proj));
  });
}

function listSavedParts() {
  const P = api();
  let projects = [];
  try { projects = Object.keys(P?.listProjects?.() || {}); } catch (_) { projects = []; }
  return { projects: projects.sort() };
}

async function insertBuiltinPart(key) {
  const spec = BUILTIN_PARTS.find((p) => p.key === key);
  if (!spec) return;
  try {
    UI.sheetCard.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    const def = await loadJson(spec.file);
    const part = def.parts?.[spec.index];
    if (!part) throw new Error("样例里没有这个零件");
    await insertPart({ name: part.name, source: clone(part.source) });
    closeSheet();
  } catch (e) {
    toast(`插入示例失败：${e?.message || e}`);
    UI.sheetCard.querySelectorAll("button").forEach((b) => { b.disabled = false; });
  }
}

function insertCurrentPart() {
  const P = api();
  try {
    if (!P?.history?.length) throw new Error("当前零件还没有任何特征");
    const def = P.serializeProject("当前零件");
    const name = P.history[0]?.customName || "当前零件";
    insertPart({ name, source: partSourceFromProject(def) }).then(() => closeSheet());
  } catch (e) {
    toast(`插入当前零件失败：${e?.message || e}`);
  }
}

async function insertFromProject(name) {
  const P = api();
  try {
    const proj = P.listProjects()[name];
    if (!proj) throw new Error("找不到这个工程");
    await insertPart({ name, source: partSourceFromProject(proj) });
    closeSheet();
  } catch (e) {
    toast(`插入工程失败：${e?.message || e}`);
  }
}

UI.fileInit = false;
function bindFileInput() {
  if (UI.fileInit) return;
  UI.fileInit = true;
  UI.file.addEventListener("change", async () => {
    const f = UI.file.files?.[0];
    UI.file.value = "";
    if (!f) return;
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      const chk = readStepBytes(buf, { name: f.name });
      await insertPart({ name: (f.name || "STEP").replace(/\.(step|stp)$/i, ""), source: partSourceFromStepBytes(buf) });
      closeSheet();
      hint(`已插入 ${f.name} · 实体 ${chk.solids} · 面 ${chk.faces}`);
    } catch (e) {
      toast(`STEP 读取失败：${e?.message || e}`);
    }
  });
}

/** 插入一个零件 + 一个实例（几何只重建一次；实例放在已有包围盒旁边，不重叠） */
async function insertPart({ name, source }) {
  const a = ensureAsm();
  const part = addPart(a, { name, source });
  const def = {
    v: 1, kind: "asm", name: "tmp", unit: "mm",
    parts: [{ id: part.id, name: part.name, source: clone(part.source) }],
    instances: [{ id: "tmp", partId: part.id, name: "tmp", transform: { t: [0, 0, 0], r: [0, 0, 0, 1] }, fixed: false }],
    mates: [], explode: [],
  };
  const restored = restoreAssembly(def);
  const shape = restored.partShapes.get(part.id);
  if (!shape) throw new Error("零件几何重建失败");
  S.partShapes.set(part.id, shape);
  S.partGeo.delete(part.id);

  const localBox = M.localBoxOf(shape.boundingBox);
  const boxes = a.instances.map((i) => {
    const e = partEntryOf(i.partId);
    const lb = e ? M.localBoxOf(e.bbox) : localBox;
    return M.worldBox(lb, normalizeTransform(i.transform).t);
  });
  const tr = M.placeNewTransform(localBox, boxes, { gap: 24 });
  const idx = a.instances.length;
  const inst = addInstance(a, {
    partId: part.id, name: `${part.name}${idx + 1}`,
    transform: tr, color: M.instanceColor(idx),
  });
  S.solve = solveNow();
  rebuildAll();
  renderPanel();
  if (a.instances.length <= 2) fitView();
  hint(`已插入 ${part.name} · 共 ${a.instances.length} 个实例${inst.fixed ? "（首个自动固定）" : ""}`);
  return inst;
}

/* ---------------------------------------------------------------- 导出 / BOM / 存档 */
async function exportStep() {
  const a = asm();
  if (!a || !a.instances.length) { toast("装配体是空的，先插零件"); return null; }
  try {
    hint("正在导出 STEP…");
    const blob = exportAssemblySTEP(a, S.partShapes);
    const buf = new Uint8Array(await blob.arrayBuffer());
    const fileName = `${(a.name || "装配体").replace(/[\\/:*?"<>|]/g, "_")}.step`;
    downloadBlob(new Blob([buf], { type: "application/step" }), fileName);
    // 页内自检：同一份字节再读一遍，实体数必须等于实例数（headless 下浏览器下载落不了盘，靠这条兜底）
    const chk = readStepBytes(buf, { name: fileName });
    const out = { bytes: buf.length, solids: chk.solids, faces: chk.faces, fileName };
    hint(`已导出 ${fileName} · ${buf.length} 字节 · 读回实体 ${chk.solids} / 实例 ${a.instances.length}`);
    S.lastStep = out;
    return out;
  } catch (e) {
    toast(`导出 STEP 失败：${e?.message || e}`);
    return null;
  }
}

function downloadBlob(blob, name) {
  try {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch (e) { console.error(e); }
}

function openBomSheet() {
  const a = asm();
  if (!a) return;
  const rows = assemblyBOM(a);
  const total = rows.reduce((s, r) => s + r.qty, 0);
  openSheet(`
    <div class="asm-sheet-head"><b>物料清单 BOM</b><button type="button" class="asm-mini" data-bom="close">✕</button></div>
    <div class="asm-sheet-body">
      <table class="asm-table">
        <thead><tr><th>序号</th><th>零件</th><th>数量</th><th>来源</th><th>实例</th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.partName)}</td><td>${r.qty}</td>
          <td>${esc({ project: "工程", step: "STEP", inline: "脚本" }[r.source] || r.source)}</td>
          <td>${esc(r.instances.join(" / "))}</td></tr>`).join("")}
        </tbody>
        <tfoot><tr><td></td><td>合计</td><td>${total}</td><td colspan="2">${esc(a.name || "")}</td></tr></tfoot>
      </table>
      <div class="asm-sheet-actions"><button type="button" class="asm-btn primary" data-bom="export">导出 BOM 文本</button></div>
    </div>`);
  UI.sheetCard.querySelectorAll("[data-bom]").forEach((b) => {
    b.addEventListener("click", () => {
      if (b.dataset.bom === "close") closeSheet();
      else {
        downloadBlob(new Blob([bomText(a)], { type: "text/tab-separated-values" }),
          `${(a.name || "装配体").replace(/[\\/:*?"<>|]/g, "_")}-BOM.tsv`);
        hint("已导出 BOM");
      }
    });
  });
}

function listSaved() {
  try {
    const raw = JSON.parse(localStorage.getItem(ASM_LS_KEY) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch (_) { return {}; }
}

function writeSaved(obj) {
  try { localStorage.setItem(ASM_LS_KEY, JSON.stringify(obj)); return true; }
  catch (e) { toast(`保存失败（本地存储写不进去）：${e?.message || e}`); return false; }
}

function saveAssembly(name) {
  const a = asm();
  if (!a || !a.instances.length) { toast("空装配体不用保存"); return false; }
  const nm = String(name || a.name || "装配体").trim().slice(0, 60);
  const all = listSaved();
  a.name = nm;
  all[nm] = { savedAt: new Date().toISOString(), def: JSON.parse(serializeAssembly(a)) };
  if (!writeSaved(all)) return false;
  if (UI.root) $("asmDocName").textContent = `装配：${nm}`;
  return true;
}

function openSaved(name) {
  const all = listSaved();
  const rec = all[name];
  if (!rec) throw new Error(`没有已保存的装配体「${name}」`);
  adoptAssembly(rec.def);
  solveNow();
  rebuildAll();
  fitView();
  renderPanel();
  setExplodeFactor(0);
  $("asmDocName").textContent = `装配：${S.asm.name || name}`;
  hint(`已打开装配体「${name}」· ${S.asm.instances.length} 个实例 / ${S.asm.mates.length} 个配合`);
  return S.asm;
}

async function openBuiltinAsm(key) {
  const spec = BUILTIN_ASM.find((x) => x.key === key);
  if (!spec) return;
  const def = await loadJson(spec.file);
  adoptAssembly(def);
  solveNow();
  rebuildAll();
  fitView();
  renderPanel();
  $("asmDocName").textContent = `装配：${S.asm.name || spec.label}`;
  hint(`已加载「${spec.label}」· ${S.asm.instances.length} 实例 / ${S.asm.mates.length} 配合 · ${M.dofLabel(S.solve).text}`);
}

function openSaveSheet() {
  const a = asm();
  const saved = listSaved();
  const names = Object.keys(saved).sort((x, y) => String(saved[y].savedAt).localeCompare(String(saved[x].savedAt)));
  openSheet(`
    <div class="asm-sheet-head"><b>保存装配体</b><button type="button" class="asm-mini" data-sv="close">✕</button></div>
    <div class="asm-sheet-body">
      <label class="asm-field"><span>名称</span>
        <input id="asmSaveName" class="asm-input" type="text" value="${esc(a?.name || "装配体")}" maxlength="60" /></label>
      <div class="asm-sheet-actions"><button type="button" class="asm-btn primary" data-sv="ok">保存</button></div>
      <div class="asm-sheet-sec"><h4>已保存（${names.length}）</h4>
        ${names.length ? names.map((n) => `<div class="asm-row compact" data-open="${esc(n)}">
          <div class="asm-row-main"><b>${esc(n)}</b><small>${esc(String(saved[n].savedAt || "").slice(0, 16).replace("T", " "))} · ${saved[n].def?.instances?.length || 0} 实例</small></div>
          <button type="button" class="asm-mini" data-del="${esc(n)}">删除</button></div>`).join("")
          : '<span class="asm-dim">还没有保存过装配体</span>'}
      </div>
    </div>`);
  UI.sheetCard.querySelectorAll("[data-sv]").forEach((b) => {
    b.addEventListener("click", () => {
      if (b.dataset.sv === "close") { closeSheet(); return; }
      const nm = $("asmSaveName")?.value || "";
      if (!nm.trim()) { toast("请先给装配体起个名字"); return; }
      if (saveAssembly(nm)) { closeSheet(); hint(`已保存装配体「${nm.trim()}」`); renderPanel(); }
    });
  });
  UI.sheetCard.querySelectorAll("[data-open]").forEach((row) => {
    row.addEventListener("click", (e) => {
      const del = e.target.closest?.("[data-del]");
      if (del) {
        const all = listSaved();
        delete all[del.dataset.del];
        writeSaved(all);
        closeSheet();
        hint(`已删除装配体「${del.dataset.del}」`);
        return;
      }
      closeSheet();
      try { openSaved(row.dataset.open); } catch (err) { toast(String(err?.message || err)); }
    });
  });
}

function openOpenSheet() {
  const saved = listSaved();
  const names = Object.keys(saved).sort();
  openSheet(`
    <div class="asm-sheet-head"><b>打开装配体</b><button type="button" class="asm-mini" data-op="close">✕</button></div>
    <div class="asm-sheet-body">
      <div class="asm-sheet-sec"><h4>内置示例</h4>
        <div class="asm-chipgrid">${BUILTIN_ASM.map((b) => `<button type="button" class="asm-chip" data-builtin-asm="${b.key}">${esc(b.label)}</button>`).join("")}</div>
      </div>
      <div class="asm-sheet-sec"><h4>已保存（${names.length}）</h4>
        ${names.length ? names.map((n) => `<div class="asm-row compact" data-opensaved="${esc(n)}">
          <div class="asm-row-main"><b>${esc(n)}</b><small>${esc(String(saved[n].savedAt || "").slice(0, 16).replace("T", " "))} · ${saved[n].def?.instances?.length || 0} 实例 / ${saved[n].def?.mates?.length || 0} 配合</small></div></div>`).join("")
          : '<span class="asm-dim">还没有保存过装配体</span>'}
      </div>
    </div>`);
  UI.sheetCard.querySelectorAll("[data-op]").forEach((b) => b.addEventListener("click", closeSheet));
  UI.sheetCard.querySelectorAll("[data-builtin-asm]").forEach((b) => {
    b.addEventListener("click", async () => {
      try { await openBuiltinAsm(b.dataset.builtinAsm); closeSheet(); }
      catch (e) { toast(`打开失败：${e?.message || e}`); }
    });
  });
  UI.sheetCard.querySelectorAll("[data-opensaved]").forEach((row) => {
    row.addEventListener("click", () => {
      closeSheet();
      try { openSaved(row.dataset.opensaved); } catch (e) { toast(String(e?.message || e)); }
    });
  });
}

/* ---------------------------------------------------------------- 画布手势接管 */
function bindCanvas() {
  const cv = canvas();
  if (!cv || cv.__asmBound) return;
  cv.__asmBound = true;

  cv.addEventListener("pointerdown", (e) => {
    if (!S.active) return;
    if (S.menuOpen) { closeMenu(); }
    if (S.keypad) { closeKeypad(); }
    if (S.drag) return;
    const pick = S.pickKind === "edge" ? (pickEdge(e.clientX, e.clientY) || pickInstance(e.clientX, e.clientY)) : pickInstance(e.clientX, e.clientY);
    if (!pick) return;
    // 配合工具 armed 时也允许拖动：拖动 ≥6px 才是移动，松手时位移小就当成一次点击去选参考
    if (beginDrag(e, pick.inst)) {
      S.drag.moved = 0;
    }
  }, true);

  cv.addEventListener("pointermove", (e) => {
    const d = S.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    d.moved = Math.hypot(e.clientX - d.sx, e.clientY - d.sy);
    d.pending = { dx: e.clientX - d.sx, dy: e.clientY - d.sy };
    if (!d.raf) d.raf = requestAnimationFrame(() => { if (S.drag) S.drag.raf = 0; flushDrag(); });
  }, true);

  const up = (e) => {
    if (!S.drag || e.pointerId !== S.drag.pointerId) return;
    endDrag();
  };
  cv.addEventListener("pointerup", up, true);
  cv.addEventListener("pointercancel", up, true);
  cv.addEventListener("lostpointercapture", (e) => { if (S.drag && e.pointerId === S.drag.pointerId) endDrag(); }, true);
}

/* ---------------------------------------------------------------- 启动：注册模式 + 挂入口 */
function installEntries() {
  const P = api();
  if (!P || P.__asmInstalled) return;
  P.__asmInstalled = true;
  buildDom();
  bindFileInput();
  bindCanvas();

  // 1) 应用模式
  P.registerAppMode("assembly", {
    label: "装配",
    enter: () => { if (!S.active) enterAssembly(); },
    exit: () => { if (S.active) leaveAssembly({ toModel: false }); },
  });

  // 2) 开始界面第三个模式按钮
  const modes = document.querySelector("#startScreen .ss-modes");
  if (modes && !modes.querySelector('[data-mode="assembly"]')) {
    const btn = document.createElement("button");
    btn.className = "ss-mode";
    btn.dataset.mode = "assembly";
    btn.innerHTML = `<span class="ss-ico">⌗</span><span class="ss-name">装配</span>
      <span class="ss-desc">插零件 · 智能配合 · 干涉 · 爆炸 · 导出 STEP</span>`;
    btn.addEventListener("click", () => { P.enterAppMode("assembly"); });
    modes.append(btn);
  }

  // 3) ⋯菜单里加一条「转到装配」（找不到菜单容器就退到左上 chip 旁边加按钮）
  const menuList = document.querySelector("#mainMenu .sm-list");
  const goAssembly = () => {
    document.getElementById("mainMenu")?.classList.add("hidden");
    P.enterAppMode("assembly");
  };
  if (menuList && !menuList.querySelector('[data-sm="assembly"]')) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "sm-item";
    item.dataset.sm = "assembly";
    item.innerHTML = `<span>转到装配</span>`;
    const before = menuList.querySelector('[data-sm="back"]');
    if (before) menuList.insertBefore(item, before); else menuList.append(item);
    item.addEventListener("click", goAssembly);
  } else if (!menuList) {
    const chip = document.getElementById("shellTopLeft");
    if (chip && !chip.querySelector("[data-asmgo]")) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "asm-inline-btn";
      b.dataset.asmgo = "1";
      b.textContent = "装配";
      b.addEventListener("click", goAssembly);
      chip.append(b);
    }
  }

  // 4) 验收 / 外部驱动的出口（与手点走同一批函数）
  P.assembly = {
    get active() { return S.active; },
    enter: (opt) => enterAssembly(opt || {}),
    exit: (opt) => leaveAssembly(opt || {}),
    state: () => snapshot(),
    insert: (opts) => insertPart(opts),
    insertBuiltin: (key) => insertBuiltinPart(key),
    openBuiltinAsm: (key) => openBuiltinAsm(key),
    runAction,
    setMateMode: (on) => { S.mateMode = !!on; S.pickA = S.pickB = null; clearOverlay(); renderPanel(); },
    setPickKind: (k) => { S.pickKind = k === "edge" ? "edge" : "face"; renderPanel(); },
    screenPointOnFace,
    screenPointOnAxis,
    pickAt: (x, y) => {
      const p = S.pickKind === "edge" ? (pickEdge(x, y) || pickInstance(x, y)) : pickInstance(x, y);
      return p ? { inst: p.inst.id, faceId: p.faceId ?? null, edgeId: p.edgeId ?? null } : null;
    },
    setPose: (id, t, r) => {
      const inst = instanceById(asm(), id);
      if (!inst) return null;
      inst.transform = normalizeTransform(r ? { t, r } : { t, r: inst.transform.r });
      syncMatrices(); renderPanel();
      return inst.transform;
    },
    setExplode: (f) => setExplodeFactor(f),
    solve: () => { S.solve = solveNow(); renderPanel(); return S.solve; },
    interference: () => runInterference(),
    exportSTEPBytes: () => exportStep(),
    save: (name) => saveAssembly(name),
    open: (name) => openSaved(name),
    list: () => Object.keys(listSaved()),
    resetInterference: () => { S.interf = null; clearOverlay(); renderPanel(); },
    closeFloating: () => { closeMenu(); closeKeypad(); closeSheet(); },
    mateMenuRect: () => {
      if (!S.menuOpen) return null;
      const r = UI.menu.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height,
        placement: S.menuPlacement || null,
        hasCancel: !!UI.menu.querySelector("[data-mcancel]"),
        footer: UI.menu.querySelector(".asm-menu-foot")?.textContent?.trim() || "",
        items: [...UI.menu.querySelectorAll("[data-mtype]")].map((b) => ({ type: b.dataset.mtype, label: b.textContent.trim() })) };
    },
    /** 两个被选参考在屏幕上的投影矩形（验收断言"菜单不压面"用） */
    refRects: () => ({ a: S.pickA ? refScreenRect(S.pickA) : null, b: S.pickB ? refScreenRect(S.pickB) : null }),
    /** 配合列表空态 / 实例行的可读性信息（验收断言"文案随状态变、图标有名字"用） */
    rowInfo: () => {
      const a = asm();
      const rows = [...document.querySelectorAll("#asmInstList .asm-row[data-inst]")].map((r) => {
        const inst = instanceById(a, r.dataset.inst);
        const sw = r.querySelector(".asm-swatch");
        const vis = r.querySelector('[data-act="vis"]');
        const del = r.querySelector('[data-act="del"]');
        const fix = r.querySelector('[data-act="fix"]');
        const mat = S.views.get(r.dataset.inst)?.mesh?.material;
        return {
          id: r.dataset.inst,
          swatch: sw ? getComputedStyle(sw).backgroundColor : null,
          swatchHex: inst?.color || null,
          materialHex: mat ? "#" + mat.color.getHexString() : null,
          fixed: !!inst?.fixed,
          fixText: fix?.textContent?.trim() || "",
          fixBg: fix ? getComputedStyle(fix).backgroundColor : null,
          fixColor: fix ? getComputedStyle(fix).color : null,
          visAria: vis?.getAttribute("aria-label") || "",
          visTitle: vis?.title || "",
          visSvgPaths: vis ? [...vis.querySelectorAll("path")].length : 0,
          visSvgShapes: vis ? [...vis.querySelectorAll("path, circle, line")].length : 0,
          visText: vis?.textContent?.trim() || "",
          delAria: del?.getAttribute("aria-label") || "",
          delText: del?.textContent?.trim() || "",
          delArmed: del?.dataset.armed === "1",
        };
      });
      return { rows, mateEmpty: UI.mateList.querySelector(".asm-empty")?.textContent?.trim() || "" };
    },
    /** 删除实例走真实按钮的同一条路径（验收用；真实点击是触摸两次） */
    requestDeleteInstance: (id) => requestDeleteInstance(id),
    keypadState: () => (S.keypad ? { type: S.keypad.type, value: S.keypad.value, flip: S.keypad.flip } : null),
    panelRects: () => rectsOf(["asmPanel", "asmRail", "asmHud", "asmBar", "asmMenu", "asmKey", "navigationBar"]),
    /** 装配体包围盒投影到屏幕的矩形（取景验收用：必须落在工具轨与面板之间） */
    modelScreenRect: () => {
      const a = asm();
      const v = api()?.viewer;
      if (!a || !v) return null;
      const box = new THREE.Box3();
      for (const inst of a.instances) {
        const entry = partEntryOf(inst.partId);
        if (entry?.geometry?.boundingBox) box.union(entry.geometry.boundingBox.clone().applyMatrix4(matrixOfInst(inst)));
      }
      if (box.isEmpty()) return null;
      const cv = canvas();
      const rect = projectBox(box, v.camera, cv.clientWidth || window.innerWidth, cv.clientHeight || window.innerHeight);
      const railR = UI.rail?.getBoundingClientRect(), panelR = UI.panel?.getBoundingClientRect();
      return { ...rect, railRight: railR ? railR.right : null, panelLeft: panelR ? panelR.left : null };
    },
  };

  // 内核句柄：干涉 / 实例镜像都走 assembly.js，这里不需要再取 OCCT
  hint("装配模式就绪");
}

function rectsOf(ids) {
  const out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    const hidden = el.classList.contains("hidden") || getComputedStyle(el).display === "none";
    const r = el.getBoundingClientRect();
    out[id] = { hidden, left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
  }
  return out;
}

/** 状态快照（验收脚本读这个；不含任何内核句柄） */
function snapshot() {
  const a = asm();
  const inst = (i) => ({
    id: i.id, name: i.name, partId: i.partId, fixed: !!i.fixed, visible: i.visible !== false,
    t: [...normalizeTransform(i.transform).t], r: [...normalizeTransform(i.transform).r], color: i.color || null,
  });
  return {
    active: S.active,
    name: a?.name || null,
    mateMode: S.mateMode,
    pickKind: S.pickKind,
    pickA: S.pickA ? { inst: S.pickA.inst.id, kind: S.pickA.ref.kind } : null,
    pickB: S.pickB ? { inst: S.pickB.inst.id, kind: S.pickB.ref.kind } : null,
    instances: (a?.instances || []).map(inst),
    mates: (a?.mates || []).map((m) => ({
      id: m.id, type: m.type, a: m.a.inst, b: m.b.inst, value: m.value, flip: !!m.flip,
      suppressed: !!m.suppressed, label: m.label || null,
      residual: (S.solve?.perMate || []).find((p) => p.id === m.id)?.residual ?? null,
    })),
    solve: S.solve ? {
      status: S.solve.status, dof: S.solve.dof, rank: S.solve.rank, variables: S.solve.variables,
      maxResidual: S.solve.maxResidual, conflicts: [...(S.solve.conflicts || [])],
      redundantMates: [...(S.solve.redundantMates || [])], iterations: S.solve.iterations,
    } : null,
    dofText: M.dofLabel(S.solve).text,
    explode: { factor: S.explodeFactor, steps: explodePlan(a || { explode: [] }).length },
    menu: S.menuOpen ? { items: [...UI.menu.querySelectorAll("[data-mtype]")].map((b) => b.dataset.mtype) } : null,
    keypad: S.keypad ? { type: S.keypad.type, value: S.keypad.value } : null,
    interference: S.interf ? {
      pairs: S.interf.pairs.map((p) => ({ a: p.a, b: p.b, names: p.names, volume: p.volume })),
      checked: S.interf.checked, skipped: S.interf.skipped, totalVolume: S.interf.totalVolume, ms: S.interf.ms,
    } : null,
    lastStep: S.lastStep || null,
    lastMate: S.lastMate ? clone(S.lastMate) : null,
    counts: { parts: a?.parts?.length || 0, instances: a?.instances?.length || 0, mates: a?.mates?.length || 0 },
  };
}

/**
 * 某个实例某个面上的屏幕点（验收脚本用：手指要落在**面**上，还不能落在孔里）。
 * 取该面里面积最大的那个三角形，用它重心的投影；投影点再用实际拾取回验一次。
 */
function screenPointOnFace(instId, { normal = [0, 0, 1], center = null, skip = 0, geom = null } = {}) {
  const a = asm();
  const inst = instanceById(a, instId);
  const entry = partEntryOf(inst?.partId);
  const P = api();
  if (!inst || !entry || !P) return null;
  const md = entry.meshData;
  const faces = entry.shape.faces || [];
  const cands = [];
  for (const fg of md.faceGroups) {
    const f = faces.find((x) => x.hashCode === fg.faceId);
    if (!f) continue;
    // geom: "cylinder" → 只要圆柱面（孔壁）；"any" → 任何面（找个可见点就行）；否则按平面 + 法向/中心匹配
    if (geom === "any") { cands.push(fg); continue; }
    if (geom === "cylinder") {
      let t = "";
      try { t = f.geomType; } catch (_) { t = ""; }
      if (t !== "CYLINDRE") continue;
      cands.push(fg);
      continue;
    }
    if (f.geomType !== "PLANE") continue;
    let n;
    try {
      const c = f.center;
      const uv = f.uvCoordinates([c.x, c.y, c.z]);
      const nn = f.normalAt(uv[0], uv[1]);
      n = [nn.x, nn.y, nn.z];
    } catch (_) { continue; }
    const dot = Math.abs(n[0] * normal[0] + n[1] * normal[1] + n[2] * normal[2]);
    if (dot < 0.99) continue;
    if (center) {
      const c = f.center;
      const d = Math.hypot(c.x - center[0], c.y - center[1], c.z - center[2]);
      if (d > 1e-3) continue;
    }
    cands.push(fg);
  }
  if (!cands.length) return null;
  const cam = P.viewer.camera;
  const cv = canvas();
  const rect = cv.getBoundingClientRect();
  const m = matrixOfInst(inst);
  const v3 = new THREE.Vector3();
  const pos = md.vertices, idx = md.triangles;
  const tris = [];
  for (const fg of cands) {
    for (let t = fg.start; t < fg.start + fg.count; t++) {
      const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];
      const ax = pos[i0 * 3], ay = pos[i0 * 3 + 1], az = pos[i0 * 3 + 2];
      const bx = pos[i1 * 3] - ax, by = pos[i1 * 3 + 1] - ay, bz = pos[i1 * 3 + 2] - az;
      const cx = pos[i2 * 3] - ax, cy = pos[i2 * 3 + 1] - ay, cz = pos[i2 * 3 + 2] - az;
      const ar = Math.hypot(by * cz - bz * cy, bz * cx - bx * cz, bx * cy - by * cx) / 2;
      tris.push({ t, ar, fg, p: [ax, ay, az, i1, i2] });
    }
  }
  tris.sort((x, y) => y.ar - x.ar);
  const tried = [];
  for (const tr of tris) {
    const i0 = idx[tr.t * 3], i1 = idx[tr.t * 3 + 1], i2 = idx[tr.t * 3 + 2];
    const centroid = new THREE.Vector3(
      (pos[i0 * 3] + pos[i1 * 3] + pos[i2 * 3]) / 3,
      (pos[i0 * 3 + 1] + pos[i1 * 3 + 1] + pos[i2 * 3 + 1]) / 3,
      (pos[i0 * 3 + 2] + pos[i1 * 3 + 2] + pos[i2 * 3 + 2]) / 3,
    );
    v3.copy(centroid).applyMatrix4(m).project(cam);
    const x = rect.left + ((v3.x + 1) / 2) * rect.width;
    const y = rect.top + ((1 - v3.y) / 2) * rect.height;
    if (!(x > rect.left + 4 && x < rect.right - 4 && y > rect.top + 4 && y < rect.bottom - 4)) continue;
    // 落在自己的浮层底下（工具轨/面板/提示条）的点不能用来验手指落点：真实触摸会先打到浮层
    if (cutByUi(x, y)) continue;
    const hit = pickInstance(x, y);
    if (hit && hit.inst.id === inst.id && hit.faceId === tr.fg.faceId) {
      tried.push({ x: Math.round(x), y: Math.round(y), faceId: tr.fg.faceId });
      if (tried.length > skip) return tried[skip];
    }
  }
  return tried[skip] || tried[0] || null;
}

/** 这个屏幕点是否被装配模式的浮层盖住（验收取点用） */
function cutByUi(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return true;
  const cv = canvas();
  if (el === cv) return false;
  return !UI.root.contains(el) || el.closest("#asmRail, #asmPanel, #asmHud, #asmBar, #asmMenu, #asmKey, #asmSheet");
}

/** 圆边/轴线上的屏幕点（选边模式验收用） */
function screenPointOnAxis(instId, { circle = true } = {}) {
  const a = asm();
  const inst = instanceById(a, instId);
  const entry = partEntryOf(inst?.partId);
  const P = api();
  if (!inst || !entry || !P) return null;
  const edges = entry.meshData.edges;
  const circleEdges = (edges?.groups || []).filter((g) => {
    const e = (entry.shape.edges || []).find((x) => x.hashCode === g.edgeId);
    return e && (!circle || e.geomType === "CIRCLE");
  });
  if (!circleEdges.length) return null;
  const cam = P.viewer.camera;
  const cv = canvas();
  const rect = cv.getBoundingClientRect();
  const m = matrixOfInst(inst);
  const v3 = new THREE.Vector3();
  const pos = edges.positions;
  for (const g of circleEdges) {
    const i = g.start;
    v3.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(m).project(cam);
    const x = rect.left + ((v3.x + 1) / 2) * rect.width;
    const y = rect.top + ((1 - v3.y) / 2) * rect.height;
    if (x > rect.left + 8 && x < rect.right - 8 && y > rect.top + 8 && y < rect.bottom - 8 && !cutByUi(x, y)) {
      const hit = pickEdge(x, y);
      if (hit && hit.inst.id === inst.id && hit.edgeId === g.edgeId) return { x: Math.round(x), y: Math.round(y), edgeId: g.edgeId };
    }
  }
  return null;
}

/* ---------------------------------------------------------------- 等 __padcad 就绪 */
(function boot() {
  let tries = 0;
  const tick = () => {
    const P = api();
    if (P && P.registerAppMode) {
      try { installEntries(); } catch (e) { console.error("assembly-ui 安装失败", e); }
      return;
    }
    if (++tries > 600) return;          // ~60s 后放弃（内核加载失败时不该无限轮询）
    setTimeout(tick, 100);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tick);
  else tick();
})();
