// Afu3D-style workspace shell: left tool rail, right tool rail, top bar, bottom status.
// Existing controls are moved with their original listeners intact.
const installations = new WeakMap();
const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  select: "M5 3 19 12 12 14 9 21Z",
  sketch: "M4 17 15 6 18 9 7 20 3 21ZM13 8l3 3M15 6l2-2a2 2 0 0 1 3 3l-2 2",
  pushpull: "M4 14 12 10 20 14 12 18ZM4 14v5l8 4 8-4v-5M12 18v5M12 2v8M9 5l3-3 3 3",
  fillet: "M4 20V11a7 7 0 0 1 7-7h9M9 20v-8a3 3 0 0 1 3-3h8",
  chamfer: "M4 20V11l7-7h9M9 20v-7l4-4h7",
  shell: "M4 4h16v16H4ZM8 8h8v8H8Z",
  move: "M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3",
  linearPattern: "M2 8h5v8H2ZM10 8h5v8h-5ZM18 8h4v8h-4",
  circularPattern: "M10 2h4v4h-4ZM18 10h4v4h-4ZM10 18h4v4h-4ZM2 10h4v4H2ZM6 6l2-2M18 6l2 2M18 18l-2 2M6 18l-2-2",
  mirror: "M12 2v20M3 6l5 3v9H3ZM21 6l-5 3v9h5Z",
  datum: "M2 14 9 5 22 10 15 19ZM12 2v20",
  refg: "M12 12 4 18M12 12l8 6M12 12V3M12 3l-2 3M12 3l2 3M4 18l4-1M20 18l-4-1",
  link: "m9 8 3-3a4 4 0 0 1 6 6l-3 3M15 16l-3 3a4 4 0 0 1-6-6l3-3M8 16l8-8",
  smartdim: "M4 3v18M20 3v18M4 12h16M8 9l-4 3 4 3M16 9l4 3-4 3",
  snap: "M5 3v10a7 7 0 0 0 14 0V3h-4v10a3 3 0 0 1-6 0V3ZM5 8h4M15 8h4",
  fit: "M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6M8 8h8v8H8Z",
  load: "M3 7V4h6l3 3h9v3M3 7v13h16l3-10H7L3 20",
  save: "M4 3h13l4 4v14H3V3ZM7 3v6h9V3M7 21v-8h10v8",
  step: "M5 14v7h14v-7M12 3v12M8 11l4 4 4-4",
  undo: "M9 4 4 9l5 5M4 9h10a6 6 0 0 1 0 12",
  redo: "M15 4l5 5-5 5M20 9H10a6 6 0 0 0 0 12",
  rect: "M4 5h16v14H4ZM2 3h4v4H2ZM18 17h4v4h-4Z",
  circle: "M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0ZM9 12h6M12 9v6",
  line: "M5 19 19 5M2 16h6v6H2ZM16 2h6v6h-6Z",
  ref: "M4 4h10v10H4ZM10 10h10v10H10M14 4v3M4 14h3",
  offset: "M3 18h11V5M7 22h11V9M3 10h6M6 7l3 3-3 3",
  dim: "M4 3v18M20 3v18M4 12h16M8 9l-4 3 4 3M16 9l4 3-4 3",
  rel: "M4 7h16M4 17h16M8 4 5 10M19 14l-3 6",
  xform: "M7 3 3 7l4 4M3 7h10a7 7 0 0 1 7 7M8 13h9v9H8Z",
  view: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  cancel: "M6 6l12 12M18 6 6 18",
  finish: "M4 12l5 5L20 6",
  wire: "M12 2 3 7v10l9 5 9-5V7ZM3 7l9 5 9-5M12 12v10M3 17l9-5 9 5M12 2v10",
  edges: "M12 2 3 7v10l9 5 9-5V7ZM3 7l9 5 9-5M12 12v10",
  material: "M12 2 3 7v10l9 5 9-5V7ZM12 22V12M3 7l9 5 9-5",
  eraser: "M7 21h13M4 15l7-7 6 6-7 7H6l-2-2ZM14 5l3-3 6 6-3 3",
  array: "M4 4h6v6H4ZM14 4h6v6h-6ZM4 14h6v6H4ZM14 14h6v6h-6Z",
  parallel: "M4 6h16M4 12h16M4 18h16",
  feature: "M4 6h16M4 12h10M4 18h16M18 10v6M15 13h6",
  measure: "M3 15 15 3l6 6L9 21ZM7 11l2 2M11 7l2 2M15 3l2 2",
  // 本轮新接特征/草图工具的图标（名字必须等于功能，图标也要看得懂）
  hole: "M12 3a4 4 0 0 1 4 4v5a4 4 0 0 1-8 0V7a4 4 0 0 1 4-4ZM5 21h14",
  surface: "M3 8c3-4 6-4 9 0s6 4 9 0M3 16c3-4 6-4 9 0s6 4 9 0",
  polygon: "M12 3l7.5 4.5v9L12 21l-7.5-4.5v-9ZM12 3v18",
  slot: "M8 8h8a4 4 0 0 1 0 8H8a4 4 0 0 1 0-8ZM8 8v8M16 8v8",
  arc: "M3 19a9 9 0 0 1 18 0M3 19h18",
  ellipse: "M12 5c5 0 9 3.1 9 7s-4 7-9 7-9-3.1-9-7 4-7 9-7Z",
  trim: "M6 4l12 12M18 4 6 16M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  edit: "M4 20h4l10-10-4-4L4 16ZM14 6l4 4M16 4l3-3 3 3-3 3",
  solid: "M12 2 3 7v10l9 5 9-5V7Z",
  draw: "M4 17 15 6 18 9 7 20 3 21ZM13 8l3 3",
  menu: "M4 7h16M4 12h16M4 17h16",
  search: "M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14ZM20 20l-4-4",
  settings: "M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  exit: "M6 6l12 12M18 6 6 18",
};

function makeIcon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("command-icon");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: "24", height: "24", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(key, value);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name] || ICONS.edges);
  svg.append(path);
  return svg;
}

export function installWorkspaceUI({ onLayout = () => {} } = {}) {
  const previous = installations.get(document);
  if (previous) return previous;
  const body = document.body;
  const byId = (id) => document.getElementById(id);
  const toolbar = byId("toolbar");
  const sketchbar = byId("sketchbar");
  const moved = new Map();
  const decorated = new Map();
  const created = [];
  const visibility = new Map();
  const locks = new Map();
  const attributeChanges = [];
  const originalDataset = { workspace: body.dataset.workspace, context: body.dataset.context };
  const hadClass = body.classList.contains("workspace-ui");
  let disposed = false;
  let refreshFrame = 0;
  let layoutFrame = 0;
  let lastLayout = "";

  function create(tag, id, className) {
    const node = document.createElement(tag);
    if (id) node.id = id;
    if (className) node.className = className;
    created.push(node);
    return node;
  }
  function attribute(node, name, value) {
    attributeChanges.push({ node, name, value: node.getAttribute(name) });
    node.setAttribute(name, value);
  }
  function move(node, destination) {
    if (!node) return;
    if (!moved.has(node)) {
      const marker = document.createComment("workspace-control");
      node.before(marker);
      moved.set(node, marker);
    }
    destination.append(node);
  }
  function setHidden(node, hidden) {
    if (!node) return;
    if (!visibility.has(node)) visibility.set(node, node.hidden);
    if (node.hidden !== hidden) node.hidden = hidden;
  }
  function lockHistory(node, locked) {
    if (!node) return;
    if (!locks.has(node)) locks.set(node, { inert: node.inert, title: node.getAttribute("title"), label: node.getAttribute("aria-label") });
    if (node.inert !== locked) node.inert = locked;
    const original = locks.get(node);
    for (const [name, value] of [["title", original.title], ["aria-label", original.label]]) {
      const next = locked ? "完成草图后可浏览历史" : value;
      if (next == null) node.removeAttribute(name);
      else if (node.getAttribute(name) !== next) node.setAttribute(name, next);
    }
  }
  function decorate(button, iconName, label = null, onRail = false) {
    if (!button) return;
    let record = decorated.get(button);
    if (!record) {
      record = { children: [...button.childNodes], iconName, hadClass: button.classList.contains("command-button"), aria: button.getAttribute("aria-label"), type: button.getAttribute("type") };
      decorated.set(button, record);
    }
    if (button.querySelector(".command-label")) return;
    const text = label || button.textContent.trim() || button.title;
    const caption = document.createElement("span");
    caption.className = "command-label";
    caption.textContent = text;
    button.replaceChildren(makeIcon(iconName), caption);
    button.classList.add("command-button");
    if (onRail) button.classList.add("rail-button");
    if (!record.type) button.type = "button";
    if (record.aria == null) button.setAttribute("aria-label", text);
  }

  // ---------- top bar ----------
  const header = create("header", "workspaceHeader");
  const brand = create("div", null, "workspace-brand");
  const brandIcon = document.createElementNS(SVG_NS, "svg");
  for (const [name, value] of Object.entries({ viewBox: "0 0 24 24", width: "26", height: "26", "aria-hidden": "true", focusable: "false" })) brandIcon.setAttribute(name, value);
  const brandShape = document.createElementNS(SVG_NS, "path");
  brandShape.setAttribute("fill", "#2b7fff");
  brandShape.setAttribute("d", "M4 2h11l5 5v7l-5 5H9v3H4Zm5 5v7h5l2-2V9l-2-2Z");
  brandIcon.append(brandShape);
  const brandName = create("span", null, "workspace-brand-name");
  brandName.textContent = "PadCAD";
  brand.append(brandIcon, brandName);

  const title = create("div", "documentTitle");
  title.textContent = "未命名设计";
  title.title = title.textContent;

  const headerStatus = create("span", "workspaceStatus");
  headerStatus.setAttribute("role", "status");

  const history = create("div", "headerHistory");
  history.setAttribute("role", "group");
  history.setAttribute("aria-label", "历史操作");
  for (const [id, iconName, label] of [["btnUndo", "undo", "撤销"], ["btnRedo", "redo", "重做"]]) {
    const button = byId(id);
    move(button, history);
    decorate(button, iconName, label);
  }

  const documentActions = create("div", "documentActions");
  documentActions.setAttribute("role", "group");
  documentActions.setAttribute("aria-label", "工程文件");
  // stl/obj/3mf 与 step 同级放在顶栏：用户找导出时一定先看右上角，藏进功能列表等于没做
  for (const action of ["load", "save", "step", "stl", "obj", "3mf"]) {
    const button = toolbar?.querySelector(`[data-act="${action}"]`);
    move(button, documentActions);
    decorate(button, action);
  }

  header.append(brand, title, headerStatus, history, documentActions);
  body.prepend(header);

  // ---------- left tool rail (Afu3D: 绘制 / 编辑 / 实体 / 测量 / 绘图工具) ----------
  const leftRail = create("nav", "leftToolRail");
  leftRail.setAttribute("aria-label", "左侧工具");
  const leftGroups = create("div", null, "rail-groups");

  function railButton(actionAttr, action, iconName, label, extraClass = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute(actionAttr, action);
    button.className = `rail-button ${extraClass}`.trim();
    button.append(makeIcon(iconName));
    const caption = document.createElement("span");
    caption.className = "command-label";
    caption.textContent = label;
    button.append(caption);
    return button;
  }

  // Host buttons we move from toolbars keep their listeners; new wrappers only present.
  function addRailItem(container, sourceButton, iconName, label) {
    if (sourceButton) {
      move(sourceButton, container);
      decorate(sourceButton, iconName, label, true);
      return sourceButton;
    }
    return null;
  }

  // Left primary groups map to existing commands
  const leftPrimary = create("div", null, "rail-primary");
  const leftSketchTools = create("div", null, "rail-sketch-tools");
  leftGroups.append(leftPrimary, leftSketchTools);

  // Mode-style buttons (Afu3D 左栏：绘制 / 编辑 / 实体 / 测量)
  // 名字必须等于功能：这里以前套用 Afu3D 的皮肤名（绘制/编辑/实体/测量），
  // 结果「编辑」实际是圆角、「实体」实际是推拉 —— 用户在平板上找不到「圆角」。
  addRailItem(leftPrimary, toolbar?.querySelector('[data-act="sketch"]'), "sketch", "草图");
  addRailItem(leftPrimary, toolbar?.querySelector('[data-act="pushpull"]'), "pushpull", "推拉");
  addRailItem(leftPrimary, toolbar?.querySelector('[data-act="smartdim"]'), "smartdim", "智能尺寸");
  // 测量放在左栏主命令里：它是「看一眼就要用」的命令，藏进顶栏或功能列表都太深
  addRailItem(leftPrimary, toolbar?.querySelector('[data-act="measure"]'), "measure", "测量");

  /*
   * 特征组（孔 / 布尔 / 分割 / 移动面 / 加厚）。
   * 为什么要压到 44px：工具轨可用高度只有 629px，主命令 3 个 60px + 功能列表 56px 已经占掉 264px；
   * 5 个 60px 的按钮会顶到工具轨外、盖住底栏。44px 是触摸目标下限，平板上仍点得准。
   */
  const leftFeatures = create("div", null, "rail-features");
  leftFeatures.style.cssText = "display:flex;flex-direction:column;gap:8px;width:100%";
  for (const [act, icon, label] of [
    ["hole", "hole", "孔"],
    ["combine", "solid", "布尔"],
    ["splitPlane", "feature", "分割"],
    ["offsetFace", "edit", "移动面"],
    ["thicken", "shell", "加厚"],
  ]) {
    const btn = addRailItem(leftFeatures, toolbar?.querySelector(`[data-act="${act}"]`), icon, label);
    if (btn) btn.style.cssText = "height:44px;min-height:44px";
  }
  // 排在主命令之后、草图工具之前（草图工具那一段平时 display:none）
  leftGroups.insertBefore(leftFeatures, leftSketchTools);

  // Drawing primitives — when in sketch mode these become the active tools
  const sketchHost = create("div", "leftSketchHost", "rail-sketch-host");
  leftSketchTools.append(sketchHost);

  const featureListBtn = create("button", "btnFeatureList", "rail-button rail-feature-list");
  featureListBtn.type = "button";
  featureListBtn.append(makeIcon("feature"));
  const featureListLabel = document.createElement("span");
  featureListLabel.className = "command-label";
  featureListLabel.textContent = "功能列表";
  featureListBtn.append(featureListLabel);

  leftRail.append(leftGroups, featureListBtn);
  body.append(leftRail);

  // ---------- right tool rail (Afu3D: 选择 / 材质 / 橡皮擦 / 移动 / 阵列 / 视图) ----------
  const rightRail = create("nav", "rightToolRail");
  rightRail.setAttribute("aria-label", "右侧工具");
  const rightPrimary = create("div", null, "rail-primary rail-primary-right");

  addRailItem(rightPrimary, toolbar?.querySelector('[data-act="select"]'), "select", "选择");
  // 圆角 / 倒角 / 抽壳 就用它们自己的名字和图标。
  // 以前这里把 抽壳 标成「材质」、倒角 标成「橡皮擦」（PadCAD 没有材质库、也没有"擦掉"语义），
  // 用户点下去才发现是别的工具 —— 名实不符比少个按钮更糟。
  addRailItem(rightPrimary, toolbar?.querySelector('[data-act="fillet"]'), "fillet", "圆角");
  addRailItem(rightPrimary, toolbar?.querySelector('[data-act="chamfer"]'), "chamfer", "倒角");
  addRailItem(rightPrimary, toolbar?.querySelector('[data-act="shell"]'), "shell", "抽壳");
  addRailItem(rightPrimary, toolbar?.querySelector('[data-act="move"]'), "move", "移动");
  addRailItem(rightPrimary, toolbar?.querySelector('[data-act="linearPattern"]'), "array", "线性阵列");
  addRailItem(rightPrimary, toolbar?.querySelector('[data-act="fit"]'), "fit", "适应内容");
  // 曲面组：右栏还剩 ~69px，只放得下一个入口；点开是四选一子菜单（偏移/加厚/补面/缝合）。
  // 四个功能本身仍各自有参数浮层，功能列表里也能单独点到。
  const surfaceEntry = addRailItem(rightPrimary, toolbar?.querySelector('[data-act="surface"]'), "surface", "曲面");
  if (surfaceEntry) {
    surfaceEntry.style.cssText = "height:44px;min-height:44px";
    surfaceEntry.setAttribute("aria-haspopup", "menu");
    surfaceEntry.setAttribute("aria-controls", "surfaceGroupPad");
    surfaceEntry.setAttribute("aria-expanded", "false");
  }

  /*
   * 曲面子菜单（flyout）：定位 + 触摸开合。
   *
   * 定位为什么不能「打开时读一次尺寸」：
   *   1) 元素还带 .hidden（display:none）时 offsetWidth/offsetHeight 都是 0，
   *      量出来的是 0×0，left/top 会被夹到视口左上角 —— 这就是「菜单渲染在 (8,8)」的来源；
   *   2) 「曲面」按钮的矩形也可能是 0：看图模式下整条右轨 display:none，或者窄高屏里
   *      轨道内容溢出到弹底栏底下被压住。0 矩形一样会把菜单算到 (8,8)。
   * 所以：先确认可见 → 量自身尺寸 → 量锚点（按钮 → 轨道 → 视口右缘三级兜底）
   *      → 贴按钮左侧（左边放不下翻到右侧）→ 夹进视口；下一帧再校准一次（轨道可能刚回流）。
   */
  const surfaceFlyout = byId("surfaceGroupPad");
  const surfaceRail = byId("rightToolRail");
  let detachFlyout = () => {};
  let flyoutOpenAt = -1e9;      // 打开菜单的时刻（performance.now 域），用于忽略开启它那一次手势
  let flyoutFrame = 0;

  // 锚点三级兜底：按钮本身 → 轨道右缘 → 视口右缘。任何一级都不能返回 0 尺寸。
  function flyoutAnchor() {
    const btn = surfaceEntry && surfaceEntry.getBoundingClientRect();
    if (btn && btn.width > 0 && btn.height > 0) {
      return { left: btn.left, top: btn.top, height: btn.height };
    }
    const rail = surfaceRail && surfaceRail.getBoundingClientRect();
    if (rail && rail.width > 0) {
      return { left: rail.left, top: rail.top + Math.max(0, (rail.height - 44) / 2), height: 44 };
    }
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 640;
    return { left: vw - 84, top: Math.round(vh * 0.42), height: 44 };
  }

  function layoutSurfaceFlyout() {
    if (!surfaceFlyout || !surfaceEntry) return;
    if (surfaceFlyout.classList.contains("hidden")) return;
    // 被上层隐藏（display:none）时量不到尺寸，别拿 0 去算位置
    if (getComputedStyle(surfaceFlyout).display === "none") return;
    const a = flyoutAnchor();
    const w = surfaceFlyout.offsetWidth || 214;
    const h = surfaceFlyout.offsetHeight || 260;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 12;
    const edge = 8;
    // 默认贴按钮左侧；左边放不下就翻到按钮右侧；最后夹进视口
    let left = a.left - w - gap;
    if (left < edge) left = a.left + 60 + gap;
    left = Math.max(edge, Math.min(left, vw - w - edge));
    let top = Math.round(a.top + a.height / 2 - h / 2);
    top = Math.max(edge, Math.min(top, vh - h - edge));
    surfaceFlyout.style.left = `${Math.round(left)}px`;
    surfaceFlyout.style.top = `${top}px`;
    surfaceFlyout.style.right = "auto";
    surfaceFlyout.style.bottom = "auto";
    // 小尖角对着按钮中心（翻到右侧时尖角改到菜单左边，见 CSS .flip-right）
    const arrow = Math.max(10, Math.min(Math.round(a.top + a.height / 2 - top - 6), h - 22));
    surfaceFlyout.style.setProperty("--flyout-arrow", `${arrow}px`);
    surfaceFlyout.classList.toggle("flip-right", left > a.left);
  }

  // 同步定位一次（赶在本帧绘制前），再排两帧校准：轨道/底栏可能同时还在回流。
  function scheduleFlyoutLayout() {
    if (!surfaceFlyout || surfaceFlyout.classList.contains("hidden")) return;
    layoutSurfaceFlyout();
    if (flyoutFrame) cancelAnimationFrame(flyoutFrame);
    let n = 0;
    const step = () => {
      flyoutFrame = 0;
      layoutSurfaceFlyout();
      if (++n < 2) flyoutFrame = requestAnimationFrame(step);
    };
    flyoutFrame = requestAnimationFrame(step);
  }

  function closeSurfaceFlyout() {
    if (!surfaceFlyout || surfaceFlyout.classList.contains("hidden")) return;
    surfaceFlyout.classList.add("hidden");
    surfaceFlyout.setAttribute("aria-hidden", "true");
    surfaceEntry?.setAttribute("aria-expanded", "false");
  }
  if (surfaceFlyout && surfaceEntry) {
    const flyoutObserver = new MutationObserver(() => {
      if (surfaceFlyout.classList.contains("hidden")) {
        surfaceEntry.setAttribute("aria-expanded", "false");
        return;
      }
      flyoutOpenAt = performance.now();     // 记下开启时刻
      surfaceEntry.setAttribute("aria-expanded", "true");
      scheduleFlyoutLayout();
    });
    flyoutObserver.observe(surfaceFlyout, { attributes: true, attributeFilter: ["class"] });
    const onFlyoutPointerDown = (event) => {
      if (surfaceFlyout.classList.contains("hidden")) return;
      /*
       * 平板踩坑：一次触摸会派发 pointerdown → touchstart → touchend → mousedown → click 一串事件，
       * 而「点外面关闭」在 pointerdown 阶段就跑了。只要开启菜单的同一次手势里还有一个指针事件
       * 落在菜单/按钮之外（按钮被别的浮层压住时就是这样），菜单会被自己这根手指关掉 ——
       * 表现是「点曲面完全没反应」。所以开启后极短窗口内的指针事件一律不当作「点外面」。
       */
      if (event.timeStamp - flyoutOpenAt < 150) return;
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      if (surfaceFlyout.contains(event.target) || path.includes(surfaceFlyout)) return;
      if (surfaceEntry.contains(event.target) || path.includes(surfaceEntry)) return;   // 点按钮交给按钮自己的 toggle
      closeSurfaceFlyout();
    };
    const onFlyoutKey = (event) => { if (event.key === "Escape") closeSurfaceFlyout(); };
    window.addEventListener("pointerdown", onFlyoutPointerDown, true);
    window.addEventListener("keydown", onFlyoutKey);
    window.addEventListener("resize", scheduleFlyoutLayout);
    window.addEventListener("orientationchange", scheduleFlyoutLayout);
    detachFlyout = () => {
      flyoutObserver.disconnect();
      window.removeEventListener("pointerdown", onFlyoutPointerDown, true);
      window.removeEventListener("keydown", onFlyoutKey);
      window.removeEventListener("resize", scheduleFlyoutLayout);
      window.removeEventListener("orientationchange", scheduleFlyoutLayout);
      if (flyoutFrame) cancelAnimationFrame(flyoutFrame);
    };
  }

  const viewModeBtn = create("button", "btnProjectionMode", "rail-button");
  viewModeBtn.type = "button";
  viewModeBtn.append(makeIcon("parallel"));
  const viewModeLabel = document.createElement("span");
  viewModeLabel.className = "command-label";
  viewModeLabel.textContent = "透视/平行";
  viewModeBtn.append(viewModeLabel);

  rightRail.append(rightPrimary, viewModeBtn);
  body.append(rightRail);

  // Remaining toolbar / sketchbar commands stay reachable via 功能列表 panel
  const commandPalette = create("div", "commandPalette", "panel hidden");
  commandPalette.innerHTML = `<div class="cp-head"><b>功能列表</b><button type="button" id="cpClose" aria-label="关闭">✕</button></div><div id="cpBody"></div>`;
  body.append(commandPalette);
  const cpBody = commandPalette.querySelector("#cpBody");
  const cpClose = commandPalette.querySelector("#cpClose");
  cpClose?.addEventListener("click", () => commandPalette.classList.add("hidden"));

  function rebuildPalette() {
    if (!cpBody) return;
    cpBody.replaceChildren();
    const section = (titleText, container, actionAttr) => {
      if (!container) return;
      const buttons = [...container.querySelectorAll(`button[${actionAttr}]`)];
      if (!buttons.length) return;
      const group = create("div", null, "cp-group");
      const head = create("div", null, "cp-group-title");
      head.textContent = titleText;
      group.append(head);
      const grid = create("div", null, "cp-grid");
      for (const button of buttons) {
        const name = button.getAttribute(actionAttr);
        if (["load", "save", "step", "select", "sketch", "smartdim", "pushpull", "fillet", "chamfer", "shell", "move", "linearPattern", "fit", "snap", "datum"].includes(name)
            && actionAttr === "data-act") {
          // already on rails / header; still list circular/mirror/refg/link
        }
        if (actionAttr === "data-act" && ["load", "save", "step"].includes(name)) continue;
        const item = document.createElement("button");
        item.type = "button";
        item.className = "cp-item";
        item.dataset.ref = name;
        item.dataset.attr = actionAttr;
        const label = button.querySelector(".command-label")?.textContent || button.textContent.trim() || name;
        item.append(makeIcon(name), Object.assign(document.createElement("span"), { textContent: label }));
        item.addEventListener("click", () => {
          button.click();
          commandPalette.classList.add("hidden");
        });
        grid.append(item);
      }
      group.append(grid);
      cpBody.append(group);
    };
    section("实体", toolbar, "data-act");
    section("草图", sketchbar, "data-sact");
    section("看图", byId("viewbar"), "data-vact");
  }

  featureListBtn.addEventListener("click", () => {
    rebuildPalette();
    commandPalette.classList.toggle("hidden");
  });

  // ---------- top-left chips: 浅色 / 面数 ----------
  const infoChips = create("div", "infoChips");
  const shadeChip = create("span", "shadeChip", "chip");
  shadeChip.textContent = "浅色";
  const faceChip = create("span", "faceCountChip", "chip");
  faceChip.textContent = "面数：0";
  infoChips.append(shadeChip, faceChip);
  body.append(infoChips);

  // ---------- bottom bar: status + search + exit + settings ----------
  const bottomBar = create("div", "bottomBar");
  const gestureHint = create("div", "gestureHint");
  gestureHint.textContent = "单指点击选择，单指拖动旋转视图，双指拖动平移视图，双指捏合缩放，长按打开菜单，手写笔绘制或编辑";

  const searchWrap = create("div", "commandSearchWrap");
  const searchInput = create("input", "commandSearch");
  searchInput.type = "search";
  searchInput.placeholder = "搜索功能，如 dj / 倒角";
  searchInput.setAttribute("aria-label", "搜索功能");
  searchWrap.append(searchInput);

  const bottomActions = create("div", "bottomActions");
  const exitBtn = create("button", "btnExitCommand", "rail-button");
  exitBtn.type = "button";
  exitBtn.append(makeIcon("exit"));
  exitBtn.append(Object.assign(document.createElement("span"), { className: "command-label", textContent: "退出功能" }));
  const settingsBtn = create("button", "btnSettings", "rail-button");
  settingsBtn.type = "button";
  settingsBtn.append(makeIcon("settings"));
  settingsBtn.append(Object.assign(document.createElement("span"), { className: "command-label", textContent: "设置选项" }));
  bottomActions.append(exitBtn, settingsBtn);

  const versionTag = create("span", "appVersion", "chip");
  versionTag.textContent = "版本：V1.0.123";

  bottomBar.append(gestureHint, searchWrap, bottomActions, versionTag);
  body.append(bottomBar);

  // Search filters the command palette
  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) {
      commandPalette.classList.add("hidden");
      return;
    }
    rebuildPalette();
    commandPalette.classList.remove("hidden");
    for (const item of commandPalette.querySelectorAll(".cp-item")) {
      const text = item.textContent.toLowerCase();
      item.hidden = q && !text.includes(q);
    }
    for (const group of commandPalette.querySelectorAll(".cp-group")) {
      const any = [...group.querySelectorAll(".cp-item")].some((i) => !i.hidden);
      group.hidden = !any;
    }
  });

  exitBtn.addEventListener("click", () => {
    // Prefer an existing cancel/finish path if visible
    const cancel = sketchbar?.querySelector('[data-sact="cancel"]')
      || byId("edgebar")?.querySelector('[data-edge="cancel"]')
      || byId("featX");
    if (cancel && !cancel.closest("[hidden]") && !cancel.closest(".hidden")) cancel.click();
    else setModeSafe("select");
    searchInput.value = "";
    commandPalette.classList.add("hidden");
  });

  function setModeSafe(m) {
    const selectBtn = toolbar?.querySelector('[data-act="select"]');
    if (selectBtn) selectBtn.click();
    else body.dispatchEvent(new CustomEvent("padcad:exit-command", { detail: { mode: m } }));
  }

  settingsBtn.addEventListener("click", () => {
    const panel = byId("viewbar") || byId("status");
    if (panel) panel.classList.toggle("hidden");
  });

  // ---------- long-press context menu (Afu3D floating chips) ----------
  const contextMenu = create("div", "contextMenu", "hidden");
  contextMenu.setAttribute("role", "menu");
  contextMenu.setAttribute("aria-label", "上下文菜单");
  body.append(contextMenu);

  const controller = {
    setDocumentName(name) {
      if (disposed) return;
      const text = typeof name === "string" && name.trim() ? name.trim() : "未命名设计";
      title.textContent = text;
      title.title = text;
    },
    setFaceCount(n) {
      if (disposed) return;
      const text = `面数：${n ?? 0}`;
      if (faceChip.textContent !== text) faceChip.textContent = text;
    },
    showContextMenu(x, y, items = []) {
      if (disposed) return;
      contextMenu.replaceChildren();
      if (!items.length) {
        contextMenu.classList.add("hidden");
        return;
      }
      for (const item of items) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ctx-item";
        btn.setAttribute("role", "menuitem");
        btn.textContent = item.label;
        btn.addEventListener("click", () => {
          contextMenu.classList.add("hidden");
          item.action?.();
        });
        contextMenu.append(btn);
      }
      contextMenu.classList.remove("hidden");
      // Position near press, keep inside viewport
      const rect = contextMenu.getBoundingClientRect();
      const maxX = window.innerWidth - rect.width - 12;
      const maxY = window.innerHeight - rect.height - 12;
      contextMenu.style.left = `${Math.max(12, Math.min(x, maxX))}px`;
      contextMenu.style.top = `${Math.max(12, Math.min(y, maxY))}px`;
    },
    hideContextMenu() {
      contextMenu.classList.add("hidden");
    },
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      detachFlyout();
      observer.disconnect();
      statusBar?.removeEventListener("click", toggleStatus);
      statusBar?.removeEventListener("keydown", statusKey);
      statusBar?.classList.toggle("expanded", !!statusWasExpanded);
      resizeObserver.disconnect();
      window.removeEventListener("resize", queueLayout);
      window.removeEventListener("pointerdown", onDocPointerDown, true);
      if (refreshFrame) cancelAnimationFrame(refreshFrame);
      if (layoutFrame) cancelAnimationFrame(layoutFrame);
      for (const [node, marker] of moved) {
        if (marker.parentNode) marker.replaceWith(node);
      }
      for (const [button, record] of decorated) {
        if (button === modeToggle) button.textContent = button.querySelector(".command-label")?.textContent || button.textContent;
        else button.replaceChildren(...record.children);
        if (!record.hadClass) button.classList.remove("command-button");
        button.classList.remove("rail-button");
        if (record.aria == null) button.removeAttribute("aria-label");
        else button.setAttribute("aria-label", record.aria);
        if (record.type == null) button.removeAttribute("type");
      }
      for (const [node, hidden] of visibility) node.hidden = hidden;
      for (const [node, original] of locks) {
        node.inert = original.inert;
        for (const [name, value] of [["title", original.title], ["aria-label", original.label]]) {
          if (value == null) node.removeAttribute(name); else node.setAttribute(name, value);
        }
      }
      for (const { node, name, value } of attributeChanges) {
        if (value == null) node.removeAttribute(name); else node.setAttribute(name, value);
      }
      for (const node of created.reverse()) node.remove();
      if (!hadClass) body.classList.remove("workspace-ui");
      for (const name of ["workspace", "context"]) {
        if (originalDataset[name] == null) delete body.dataset[name];
        else body.dataset[name] = originalDataset[name];
      }
      installations.delete(document);
      onLayout();
    },
  };

  // Hide context menu when tapping elsewhere
  const onDocPointerDown = (event) => {
    if (contextMenu.classList.contains("hidden")) return;
    if (contextMenu.contains(event.target)) return;
    contextMenu.classList.add("hidden");
  };
  window.addEventListener("pointerdown", onDocPointerDown, true);

  // ---------- status bar ----------
  const statusBar = byId("status");
  const statusWasExpanded = statusBar?.classList.contains("expanded");
  const toggleStatus = () => {
    const expanded = !statusBar.classList.contains("expanded");
    statusBar.classList.toggle("expanded", expanded);
    statusBar.setAttribute("aria-expanded", String(expanded));
  };
  const statusKey = (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleStatus(); }
    if (event.key === "Escape") { statusBar.classList.remove("expanded"); statusBar.setAttribute("aria-expanded", "false"); }
  };
  if (statusBar) {
    attribute(statusBar, "role", "button");
    attribute(statusBar, "tabindex", "0");
    attribute(statusBar, "aria-expanded", "false");
    attribute(statusBar, "title", "点击展开或收起完整状态信息");
    statusBar.addEventListener("click", toggleStatus);
    statusBar.addEventListener("keydown", statusKey);
    move(statusBar, bottomBar);
  }

  // Keep existing navigation controls available (view cube / planar)
  const navigation = create("nav", "navigationBar");
  navigation.setAttribute("aria-label", "视图与导航");
  const modeToggle = byId("modeToggle");
  move(modeToggle, navigation);
  decorate(modeToggle, "view");
  const navigationButtons = new Map();
  for (const action of ["snap", "datum"]) {
    const button = toolbar?.querySelector(`[data-act="${action}"]`);
    navigationButtons.set(action, button);
    move(button, navigation);
    decorate(button, action);
  }
  body.append(navigation);
  function attachViewControls() {
    const views = document.querySelector(".view-controls");
    if (!views) return;
    if (views.parentNode !== navigation) move(views, navigation);
    decorate(views.querySelector(".view-controls-trigger"), "view");
  }
  attachViewControls();

  // Remaining ribbon buttons keep labels for the palette (not rail styling).
  for (const button of toolbar?.querySelectorAll("button[data-act]") || []) {
    if (!decorated.has(button)) decorate(button, button.getAttribute("data-act"));
  }
  for (const button of sketchbar?.querySelectorAll("button[data-sact]") || []) {
    if (!decorated.has(button)) decorate(button, button.getAttribute("data-sact"));
  }
  for (const button of byId("viewbar")?.querySelectorAll("button") || []) {
    const name = button.dataset.vact;
    decorate(button, ({ open: "load", back: "undo" })[name] || name);
  }

  // The old ribbon host stays in the DOM (app logic toggles its .hidden class)
  // but CSS keeps it invisible — its buttons now live on the side rails.
  if (toolbar) toolbar.setAttribute("aria-hidden", "true");
  // sketchbar stays in DOM (many handlers query it) but is presented compactly
  if (sketchbar) {
    sketchbar.classList.add("workspace-sketchbar-compact");
  }

  // Afu3D 左栏绘图工具：直线 / 多段线 / 矩形 / 圆形
  const sketchToolProxies = [];
  for (const [name, icon, label] of [
    ["line", "line", "直线"],
    ["line", "ref", "多段线"],
    ["rect", "rect", "矩形"],
    ["circle", "circle", "圆形"],
  ]) {
    const source = sketchbar?.querySelector(`[data-sact="${name}"]`);
    const item = railButton("data-sact", name, icon, label);
    item.addEventListener("click", () => source?.click());
    leftSketchHost.append(item);
    sketchToolProxies.push({ item, source, name });
  }
  function syncSketchTools() {
    for (const { item, source, name } of sketchToolProxies) {
      const on = source?.classList.contains("on");
      item.classList.toggle("on", !!on);
    }
  }

  // 透视/平行：切换线框，贴近 Afu3D 的投影切换位
  viewModeBtn.addEventListener("click", () => {
    const wire = byId("viewbar")?.querySelector('[data-vact="wire"]');
    if (wire) wire.click();
    else body.dispatchEvent(new CustomEvent("padcad:toggle-projection"));
    viewModeBtn.classList.toggle("on");
  });

  const visible = (node) => !!node && !node.hidden && !node.classList.contains("hidden");
  const commandPanels = ["extrude", "edgebar", "linkbar", "patternPanel", "featPanel", "smartPad", "movePad", "refgPad", "commandPalette", "xformPad", "relPad", "offsetPanel", "dimPanel"];
  function queueLayout() {
    if (disposed || layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      if (disposed) return;
      const canvas = byId("view");
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const signature = [rect.left, rect.top, rect.width, rect.height, window.devicePixelRatio || 1].map((n) => Math.round(n * 100) / 100).join(":");
      if (signature === lastLayout || rect.width <= 0 || rect.height <= 0) return;
      lastLayout = signature;
      onLayout();
    });
  }
  function refresh() {
    if (disposed) return;
    attachViewControls();
    decorate(modeToggle, "view");
    // toolbar is CSS-hidden (its buttons live on rails); detect workspace from start/view hosts.
    const workspace = visible(byId("startScreen")) ? "start" : visible(byId("viewbar")) ? "view" : "model";
    const sketch = workspace === "model" && visible(sketchbar) && !sketchbar.classList.contains("hidden");
    const sketchPending = workspace === "model" && visible(byId("extrude"));
    const command = workspace === "model" && !sketch && commandPanels.some((id) => visible(byId(id)));
    const context = sketch ? "sketch" : command ? "command" : "model";
    if (body.dataset.workspace !== workspace) body.dataset.workspace = workspace;
    if (body.dataset.context !== context) body.dataset.context = context;
    const status = workspace === "start" ? "开始" : workspace === "view" ? "看图模式" : sketch ? "草图编辑" : command ? "命令进行中" : "实体建模";
    if (headerStatus.textContent !== status) headerStatus.textContent = status;
    setHidden(header, workspace === "start");
    setHidden(leftRail, workspace === "start");
    setHidden(rightRail, workspace === "start");
    setHidden(bottomBar, workspace === "start");
    setHidden(infoChips, workspace === "start");
    setHidden(navigation, workspace === "start");
    setHidden(documentActions, workspace !== "model" || context !== "model");
    setHidden(history, workspace !== "model" || context !== "model");
    setHidden(modeToggle, workspace !== "model" || context !== "model");
    setHidden(navigationButtons.get("snap"), workspace !== "model" || context !== "model");
    for (const node of [byId("tree"), byId("featTree"), history]) lockHistory(node, sketch || sketchPending);
    // Face count chip
    try {
      const faces = window.__padcad?.shape?.faces?.length;
      if (faces != null) controller.setFaceCount(faces);
    } catch (_) {}
    syncSketchTools();
    queueLayout();
  }
  function queueRefresh() {
    if (disposed || refreshFrame) return;
    refreshFrame = requestAnimationFrame(() => { refreshFrame = 0; refresh(); });
  }
  const observer = new MutationObserver(queueRefresh);
  for (const id of ["startScreen", "viewbar", "sketchbar", "toolbar", ...commandPanels]) {
    const node = byId(id);
    if (node) observer.observe(node, { attributes: true, attributeFilter: ["class", "hidden"] });
  }
  if (modeToggle) observer.observe(modeToggle, { childList: true });
  const resizeObserver = new ResizeObserver(queueLayout);
  const canvas = byId("view");
  if (canvas) resizeObserver.observe(canvas);
  window.addEventListener("resize", queueLayout);
  body.classList.add("workspace-ui");
  body.classList.add("workspace-afu3d");

  installations.set(document, controller);
  refresh();
  return controller;
}
