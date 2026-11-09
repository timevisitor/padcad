// 平板浮动外壳（对标 Materializr 的 im-touch 布局）。
//
// 与旧版（左右两条常驻工具轨 + 顶栏 + 底栏）的区别：
//   画布铺满全屏；顶部只剩两个小浮块；左缘一个**上下文工具坞**；模型树是半透明浮层；
//   历史是底部浮动横条；长按出**径向菜单**；内核状态是底部小 toast。
// 刻意保留的东西：#toolbar / #sketchbar / #viewbar 里的**真实按钮**被搬出来复用，
//   原有监听器一个都没动（move() 只改父节点），所以功能入口不会因为重排而丢失。
import { radialLayout, placeCard, clamp } from "./float-layout.js";

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
  import: "M5 10V3h14v7M12 21V9M8 17l4 4 4-4",
  save: "M4 3h13l4 4v14H3V3ZM7 3v6h9V3M7 21v-8h10v8",
  step: "M5 14v7h14v-7M12 3v12M8 11l4 4 4-4",
  stl: "M12 2 3 7v10l9 5 9-5V7ZM3 7l9 5 9-5M12 12v10",
  obj: "M4 6h16v12H4ZM4 10h16M9 6v12",
  "3mf": "M12 2 3 7v10l9 5 9-5V7ZM7 9l5 3 5-3M12 12v7",
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
  array: "M4 4h6v6H4ZM14 4h6v6h-6ZM4 14h6v6H4ZM14 14h6v6h-6Z",
  parallel: "M4 6h16M4 12h16M4 18h16",
  feature: "M4 6h16M4 12h10M4 18h16M18 10v6M15 13h6",
  measure: "M3 15 15 3l6 6L9 21ZM7 11l2 2M11 7l2 2M15 3l2 2",
  hole: "M12 3a4 4 0 0 1 4 4v5a4 4 0 0 1-8 0V7a4 4 0 0 1 4-4ZM5 21h14",
  surface: "M3 8c3-4 6-4 9 0s6 4 9 0M3 16c3-4 6-4 9 0s6 4 9 0",
  surfaceOffset: "M3 8c3-4 6-4 9 0s6 4 9 0M3 16c3-4 6-4 9 0s6 4 9 0M12 3v4",
  surfaceThicken: "M3 8c3-4 6-4 9 0s6 4 9 0M3 16c3-4 6-4 9 0s6 4 9 0M12 18v4",
  surfaceFill: "M3 8c3-4 6-4 9 0s6 4 9 0M4 14h16M8 18h8",
  surfaceStitch: "M3 8c3-4 6-4 9 0s6 4 9 0M12 2v20M8 6l4 3 4-3M8 18l4-3 4 3",
  polygon: "M12 3l7.5 4.5v9L12 21l-7.5-4.5v-9ZM12 3v18",
  slot: "M8 8h8a4 4 0 0 1 0 8H8a4 4 0 0 1 0-8ZM8 8v8M16 8v8",
  arc: "M3 19a9 9 0 0 1 18 0M3 19h18",
  ellipse: "M12 5c5 0 9 3.1 9 7s-4 7-9 7-9-3.1-9-7 4-7 9-7Z",
  trim: "M6 4l12 12M18 4 6 16M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  edit: "M4 20h4l10-10-4-4L4 16ZM14 6l4 4M16 4l3-3 3 3-3 3",
  solid: "M12 2 3 7v10l9 5 9-5V7Z",
  menu: "M4 7h16M4 12h16M4 17h16",
  search: "M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14ZM20 20l-4-4",
  settings: "M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  exit: "M6 6l12 12M18 6 6 18",
  clock: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18ZM12 7v5l3 2",
  folder: "M3 5h6l2 2h10v12H3Z",
  focus: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  chevronRight: "M9 5l7 7-7 7",
  chevronLeft: "M15 5l-7 7 7 7",
  group: "M4 4h7v7H4ZM13 4h7v7h-7ZM4 13h7v7H4ZM13 13h7v7h-7",
  home: "M3 11 12 3l9 8v10H3Z",
  clear: "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14",
};

function makeIcon(name, size = 20) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("command-icon");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: String(size), height: String(size), fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(key, value);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name] || ICONS.edges);
  svg.append(path);
  return svg;
}

const STATUS_FADE_MS = 4200;
const HINT_KEY = "padcad.ui.hintSeen.v1";

export function installWorkspaceUI({ onLayout = () => {}, project = null, selectionRect = null } = {}) {
  const previous = installations.get(document);
  if (previous) return previous;
  const body = document.body;
  const byId = (id) => document.getElementById(id);
  const toolbar = byId("toolbar");
  const sketchbar = byId("sketchbar");
  const viewbar = byId("viewbar");
  const canvas = byId("view");
  const moved = new Map();
  const decorated = new Map();
  const created = [];
  const visibility = new Map();
  const locks = new Map();
  const attributeChanges = [];
  const cleanups = [];
  const originalDataset = { workspace: body.dataset.workspace, context: body.dataset.context, dock: body.dataset.dock };
  const hadClass = body.classList.contains("workspace-ui");
  let disposed = false;
  let refreshFrame = 0;
  let layoutFrame = 0;
  let lastLayout = "";
  let dockSignature = "";
  let groupOpen = null;
  let menuOpen = false;
  let focusMode = false;
  let radialOpenAt = -1e9;
  let pickerWorld = null;
  let pickerScreen = null;

  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); cleanups.push(() => target.removeEventListener(type, fn, opts)); };

  function create(tag, id, className) {
    const node = document.createElement(tag);
    if (id) node.id = id;
    if (className) node.className = className;
    created.push(node);
    return node;
  }
  function attribute(node, name, value) {
    if (!node) return;
    attributeChanges.push({ node, name, value: node.getAttribute(name) });
    node.setAttribute(name, value);
  }
  function move(node, destination) {
    if (!node || !destination) return;
    if (!moved.has(node)) {
      const marker = document.createComment("workspace-control");
      node.before(marker);
      moved.set(node, marker);
    }
    if (node.parentNode !== destination) destination.append(node);
  }
  function setHidden(node, hidden) {
    if (!node) return;
    if (!visibility.has(node)) visibility.set(node, node.hidden);
    if (node.hidden !== hidden) node.hidden = hidden;
  }
  const visible = (node) => !!node && !node.hidden && !node.classList.contains("hidden");

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

  /** 给宿主按钮套上图标 + 小字标签（原来只是纯文字）。同一按钮只装饰一次。 */
  function decorate(button, iconName, label = null, extraClass = null) {
    if (!button) return;
    let record = decorated.get(button);
    if (!record) {
      record = { children: [...button.childNodes], iconName, hadClass: button.classList.contains("command-button"), aria: button.getAttribute("aria-label"), type: button.getAttribute("type") };
      decorated.set(button, record);
    }
    // 额外的展示类（dock-btn / gp-item / sm-act）每次都要加：同一个按钮会换好几个容器
    if (extraClass) button.classList.add(extraClass);
    if (button.querySelector(".command-label")) return;
    const text = label || button.textContent.trim() || button.title;
    const caption = document.createElement("span");
    caption.className = "command-label";
    caption.textContent = text;
    button.replaceChildren(makeIcon(iconName), caption);
    button.classList.add("command-button");
    if (extraClass) button.classList.add(extraClass);
    if (!record.type) button.type = "button";
    if (record.aria == null) button.setAttribute("aria-label", text);
  }

  /*
   * 同一个宿主按钮会在「坞 / 组弹格 / ⋯菜单 / 全部功能」之间来回搬。
   * 显示类必须**互斥**（否则 dock-btn 与 cp-item 的样式会打架），所以统一走 place()。
   */
  const DISPLAY_CLASSES = ["dock-btn", "gp-item", "cp-item", "sm-act", "pill-btn"];
  function place(button, container, cls) {
    if (!button || !container) return button;
    move(button, container);
    for (const name of DISPLAY_CLASSES) if (name !== cls) button.classList.remove(name);
    if (cls) button.classList.add(cls);
    return button;
  }

  // 先把宿主按钮的原始清单抓下来：它们马上会被搬走，之后再 querySelectorAll 就抓不到了
  const toolbarButtons = toolbar ? [...toolbar.querySelectorAll("button[data-act]")] : [];
  const sketchButtons = sketchbar ? [...sketchbar.querySelectorAll("button[data-sact]")] : [];
  const viewButtons = viewbar ? [...viewbar.querySelectorAll("button[data-vact]")] : [];
  const buttonByAct = new Map(toolbarButtons.map((b) => [b.dataset.act, b]));
  const buttonBySact = new Map(sketchButtons.map((b) => [b.dataset.sact, b]));
  for (const b of toolbarButtons) decorate(b, b.dataset.act);
  for (const b of sketchButtons) decorate(b, b.dataset.sact);
  for (const b of viewButtons) decorate(b, ({ open: "load", back: "undo" })[b.dataset.vact] || b.dataset.vact);

  // ---------------------------------------------------------------- 顶部：两个小浮块
  const header = create("header", "workspaceHeader");
  const chip = create("div", "shellTopLeft", "shell-chip");
  const brandIcon = document.createElementNS(SVG_NS, "svg");
  for (const [name, value] of Object.entries({ viewBox: "0 0 24 24", width: "22", height: "22", "aria-hidden": "true", focusable: "false" })) brandIcon.setAttribute(name, value);
  const brandShape = document.createElementNS(SVG_NS, "path");
  brandShape.setAttribute("fill", "currentColor");
  brandShape.setAttribute("d", "M4 2h11l5 5v7l-5 5H9v3H4Zm5 5v7h5l2-2V9l-2-2Z");
  brandIcon.append(brandShape);
  const title = create("div", "documentTitle");
  title.textContent = "未命名设计";
  title.title = title.textContent;
  const menuBtn = create("button", "btnMenu", "chip-btn");
  menuBtn.type = "button";
  menuBtn.setAttribute("aria-label", "更多菜单");
  menuBtn.setAttribute("aria-haspopup", "menu");
  menuBtn.setAttribute("aria-expanded", "false");
  menuBtn.append(makeIcon("more", 22));
  chip.append(brandIcon, title, menuBtn);
  header.append(chip);

  const pill = create("div", "shellTopRight", "shell-pill");
  pill.setAttribute("role", "group");
  pill.setAttribute("aria-label", "快速操作");
  const history = create("div", "headerHistory");
  for (const [id, iconName, label] of [["btnUndo", "undo", "撤销"], ["btnRedo", "redo", "重做"]]) {
    const button = byId(id);
    decorate(button, iconName, label);
    place(button, history, "pill-btn");
  }
  const treeToggle = create("button", "btnTreeToggle", "pill-btn");
  treeToggle.type = "button";
  treeToggle.setAttribute("aria-label", "模型树");
  treeToggle.append(makeIcon("folder", 20));
  const focusToggle = create("button", "btnFocusToggle", "pill-btn");
  focusToggle.type = "button";
  focusToggle.setAttribute("aria-label", "全屏（隐藏界面）");
  focusToggle.setAttribute("aria-pressed", "false");
  focusToggle.append(makeIcon("focus", 20));
  pill.append(history, treeToggle, focusToggle);
  header.append(pill);
  body.prepend(header);

  const focusRestore = create("button", "focusRestore", "chip-btn");
  focusRestore.type = "button";
  focusRestore.textContent = "退出全屏";
  body.append(focusRestore);

  // ---------------------------------------------------------------- ⋯ 菜单
  const mainMenu = create("div", "mainMenu", "shell-menu hidden");
  mainMenu.setAttribute("role", "menu");
  mainMenu.innerHTML = `
    <div class="sm-head"><b>设计</b><span class="sm-doc" id="menuDocName">未命名设计</span></div>
    <div class="sm-doc sm-doc-actions" id="menuDocActions" role="group" aria-label="工程文件"></div>
    <div class="sm-list">
      <button type="button" class="sm-item" data-sm="palette"><span>全部功能</span></button>
      <button type="button" class="sm-item" data-sm="search"><span>功能搜索</span></button>
      <button type="button" class="sm-item" data-sm="display"><span>显示设置</span></button>
      <button type="button" class="sm-item" data-sm="back"><span>返回开始页</span></button>
    </div>
    <div class="sm-foot"><span id="appVersion" class="chip">版本：V5.1.7 · 平板浮层 UI</span></div>`;
  body.append(mainMenu);
  const menuDocActions = mainMenu.querySelector("#menuDocActions");
  // 点了文档动作（打开/保存/导入/导出）后收起 ⋯菜单 —— 否则系统选择器回来后菜单还盖在画布上（真机 5.1.2/5.1.3 截图）
  menuDocActions.addEventListener("click", (e) => { if (e.target.closest("button")) setTimeout(() => closeMenu(), 0); });
  for (const action of ["load", "save", "import", "step", "stl", "obj", "3mf"]) {
    const button = buttonByAct.get(action);
    decorate(button, action);
    place(button, menuDocActions, "sm-act");
  }
  for (const [key, iconName] of [["palette", "feature"], ["search", "search"], ["display", "settings"], ["back", "home"]]) {
    const item = mainMenu.querySelector(`[data-sm="${key}"]`);
    if (item) item.prepend(makeIcon(iconName, 18));
  }

  const displayPad = create("div", "displayPad", "shell-menu hidden");
  displayPad.innerHTML = `<div class="sm-head"><b>显示设置</b></div><div class="dp-list" id="displayList"></div>`;
  body.append(displayPad);
  const displayList = displayPad.querySelector("#displayList");

  // ---------------------------------------------------------------- 左缘上下文工具坞
  const dock = create("nav", "toolDock");
  dock.setAttribute("aria-label", "上下文工具");
  const dockPrimary = create("div", "dockPrimary", "dock-group");
  const dockGroups = create("div", "dockGroupButtons", "dock-group");
  const dockFoot = create("div", "dockFoot", "dock-group");
  dock.append(dockPrimary, dockGroups, dockFoot);
  // 溢出提示：内容比坞高时加 .dock-overflow（底部渐隐），滚到底时去掉渐隐
  const syncDockOverflow = () => {
    const over = dock.scrollHeight > dock.clientHeight + 2;
    dock.classList.toggle("dock-overflow", over);
    dock.classList.toggle("dock-at-end", over && dock.scrollTop + dock.clientHeight >= dock.scrollHeight - 2);
  };
  dock.addEventListener("scroll", syncDockOverflow, { passive: true });
  new ResizeObserver(syncDockOverflow).observe(dock);
  new MutationObserver(syncDockOverflow).observe(dock, { childList: true, subtree: true });
  body.append(dock);

  const dockHandle = create("button", "dockHandle", "");
  dockHandle.type = "button";
  dockHandle.setAttribute("aria-label", "展开工具栏");
  dockHandle.setAttribute("aria-expanded", "false");
  dockHandle.append(makeIcon("chevronRight", 20));
  dockHandle.append(Object.assign(document.createElement("span"), { className: "command-label", textContent: "工具" }));
  body.append(dockHandle);

  const groupPad = create("div", "dockGroupPad", "shell-menu hidden");
  groupPad.setAttribute("role", "menu");
  groupPad.innerHTML = `<div class="gp-head"><b id="gpTitle">工具组</b><button type="button" id="gpClose" aria-label="关闭">✕</button></div><div id="gpGrid" class="gp-grid"></div>`;
  body.append(groupPad);
  const gpTitle = groupPad.querySelector("#gpTitle");
  const gpGrid = groupPad.querySelector("#gpGrid");
  groupPad.querySelector("#gpClose")?.addEventListener("click", () => closeGroup());

  // ---------------------------------------------------------------- 长按径向菜单
  const radialMenu = create("div", "radialMenu", "hidden");
  radialMenu.setAttribute("role", "menu");
  radialMenu.setAttribute("aria-label", "上下文操作");
  const radialRing = create("div", "radialRing", "radial-ring");
  radialMenu.append(radialRing);
  body.append(radialMenu);

  // ---------------------------------------------------------------- 草图中：✓ / ✗
  const sketchActions = create("div", "sketchActions");
  const sketchCancel = create("button", "btnSketchCancel", "fab fab-cancel");
  sketchCancel.type = "button";
  sketchCancel.append(makeIcon("cancel", 22));
  sketchCancel.append(Object.assign(document.createElement("span"), { className: "fab-label", textContent: "取消" }));
  const sketchDone = create("button", "btnSketchFinish", "fab fab-done");
  sketchDone.type = "button";
  sketchDone.append(makeIcon("finish", 24));
  sketchDone.append(Object.assign(document.createElement("span"), { className: "fab-label", textContent: "完成" }));
  sketchActions.append(sketchCancel, sketchDone);
  body.append(sketchActions);

  const cancelConfirm = create("div", "cancelConfirm", "shell-menu hidden");
  cancelConfirm.innerHTML = `<div class="cc-text">放弃这次草图修改？</div><div class="cc-btns"><button type="button" class="ghost" data-cc="no">继续编辑</button><button type="button" class="primary" data-cc="yes">放弃</button></div>`;
  body.append(cancelConfirm);

  // ---------------------------------------------------------------- 历史开关 + 状态 toast
  const treeShow = byId("btnTreeShow");
  if (treeShow) {
    treeShow.replaceChildren(makeIcon("clock", 22), Object.assign(document.createElement("span"), { className: "command-label", textContent: "历史" }));
    treeShow.classList.add("dock-float-btn");
    attribute(treeShow, "aria-label", "展开或收起设计历史");
  }
  const featShow = byId("btnFeatShow");
  if (featShow) setHidden(featShow, true);   // 模型树开关已移到右上 pill

  const statusBar = byId("status");
  const statusWasExpanded = statusBar?.classList.contains("expanded");
  let statusTimer = 0;
  let lastStatusText = "";
  function showStatusToast() {
    if (!statusBar) return;
    statusBar.classList.add("toast-on");
    statusBar.classList.remove("toast-out");
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusTimer = 0;
      if (statusBar.classList.contains("expanded")) return;   // 展开时不淡出，用户正在看
      statusBar.classList.add("toast-out");
    }, STATUS_FADE_MS);
  }
  const toggleStatus = () => {
    const expanded = !statusBar.classList.contains("expanded");
    statusBar.classList.toggle("expanded", expanded);
    statusBar.setAttribute("aria-expanded", String(expanded));
    if (expanded) {
      statusBar.classList.remove("toast-out");
      statusBar.classList.add("toast-on");
      if (statusTimer) { clearTimeout(statusTimer); statusTimer = 0; }
    } else showStatusToast();
  };
  const statusKey = (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleStatus(); }
    if (event.key === "Escape") { statusBar.classList.remove("expanded"); statusBar.setAttribute("aria-expanded", "false"); }
  };
  if (statusBar) {
    attribute(statusBar, "role", "button");
    attribute(statusBar, "tabindex", "0");
    attribute(statusBar, "aria-expanded", "false");
    attribute(statusBar, "title", "点一下展开完整状态");
    on(statusBar, "click", toggleStatus);
    on(statusBar, "keydown", statusKey);
    // #stats / #ktext 一有变化就浮出来几秒（内容元素本身永不删，验收仍能读到文本）
    const statusObserver = new MutationObserver(() => {
      const text = `${byId("ktext")?.textContent || ""}|${byId("stats")?.textContent || ""}`;
      if (text === lastStatusText) return;
      lastStatusText = text;
      showStatusToast();
    });
    for (const id of ["stats", "ktext"]) {
      const node = byId(id);
      if (node) statusObserver.observe(node, { childList: true, characterData: true, subtree: true });
    }
    cleanups.push(() => statusObserver.disconnect());
  }

  // ---------------------------------------------------------------- 视图导航小簇
  const navigation = create("nav", "navigationBar");
  navigation.setAttribute("aria-label", "视图与导航");
  const modeToggle = byId("modeToggle");
  move(modeToggle, navigation);
  decorate(modeToggle, "view");
  const navigationButtons = new Map();
  for (const action of ["snap", "datum"]) {
    const button = buttonByAct.get(action);
    navigationButtons.set(action, button);
    decorate(button, action);
    place(button, navigation, "nav-btn");
  }
  body.append(navigation);
  function attachViewControls() {
    const views = document.querySelector(".view-controls");
    if (!views) return;
    if (views.parentNode !== navigation) move(views, navigation);
    decorate(views.querySelector(".view-controls-trigger"), "view");
  }
  attachViewControls();

  // ---------------------------------------------------------------- 退出功能 / 全部功能
  const exitBtn = create("button", "btnExitCommand", "dock-float-btn");
  exitBtn.type = "button";
  exitBtn.append(makeIcon("exit", 20));
  exitBtn.append(Object.assign(document.createElement("span"), { className: "command-label", textContent: "退出功能" }));
  body.append(exitBtn);

  const commandPalette = create("div", "commandPalette", "panel hidden");
  commandPalette.innerHTML = `<div class="cp-head"><b>全部功能</b><input id="commandSearch" type="search" placeholder="搜索功能，如 dj / 倒角" aria-label="搜索功能" /><button type="button" id="cpClose" aria-label="关闭">✕</button></div><div id="cpBody"></div>`;
  body.append(commandPalette);
  const cpBody = commandPalette.querySelector("#cpBody");
  /*
   * 停靠区：语境切换时，坞里用不到的按钮**不能**被 replaceChildren 甩出 DOM ——
   * 那样 `document.querySelector('[data-act=...]')` 会直接变成 null，功能等于凭空消失。
   * 统一挪进这个隐藏容器（它在「全部功能」面板里），随时能再搬回来。
   */
  const cpPark = create("div", "cpPark", "cp-park");
  commandPalette.append(cpPark);
  function parkAll(container) {
    if (!container) return;
    for (const child of [...container.children]) {
      if (child.tagName === "BUTTON") move(child, cpPark);
    }
  }
  const cpClose = commandPalette.querySelector("#cpClose");
  const searchInput = commandPalette.querySelector("#commandSearch");

  function rebuildPalette() {
    if (!cpBody) return;
    cpBody.replaceChildren();
    /*
     * 这里放的是**真实按钮**（不是代理）：每个 data-act/data-sact/data-vact 在界面上永远
     * 有一个真实落点（坞 / 组弹格 / ⋯菜单 / 全部功能之一），点下去走的是它自己的监听器。
     */
    const section = (titleText, buttons, actionAttr) => {
      if (!buttons.length) return;
      const group = create("div", null, "cp-group");
      const head = create("div", null, "cp-group-title");
      head.textContent = titleText;
      group.append(head);
      const grid = create("div", null, "cp-grid");
      for (const button of buttons) {
        const name = button.getAttribute(actionAttr);
        decorate(button, name);
        place(button, grid, "cp-item");
      }
      group.append(grid);
      cpBody.append(group);
    };
    section("实体", toolbarButtons, "data-act");
    section("草图", sketchButtons, "data-sact");
    section("看图", viewButtons, "data-vact");
  }
  if (cpClose) on(cpClose, "click", () => closePalette());
  on(searchInput, "input", () => {
    const q = searchInput.value.trim().toLowerCase();
    for (const item of commandPalette.querySelectorAll(".cp-item")) item.hidden = !!(q && !item.textContent.toLowerCase().includes(q));
    for (const group of commandPalette.querySelectorAll(".cp-group")) {
      group.hidden = ![...group.querySelectorAll(".cp-item")].some((i) => !i.hidden);
    }
  });
  // 调色板里的按钮是真身：点完一项要收起面板，并把左缘工具坞重建回来
  on(commandPalette, "click", (event) => {
    if (!event.target.closest(".cp-item")) return;
    setTimeout(() => closePalette(), 0);
  });

  /** 面板放到视口中央（隐藏态量不到尺寸，所以先 visibility:hidden 地显示再量） */
  function placeCenteredPanel(panel) {
    if (!panel) return;
    const wasHidden = panel.classList.contains("hidden");
    if (wasHidden) { panel.style.visibility = "hidden"; panel.classList.remove("hidden"); }
    const rect = panel.getBoundingClientRect();
    panel.style.left = `${Math.round(clamp(window.innerWidth / 2 - rect.width / 2, 8, Math.max(8, window.innerWidth - rect.width - 8)))}px`;
    panel.style.top = `${Math.round(clamp(window.innerHeight / 2 - rect.height / 2, 8, Math.max(8, window.innerHeight - rect.height - 8)))}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    if (wasHidden) panel.style.visibility = "";
  }

  /*
   * 调色板里的按钮是真实按钮 —— 打开时会从坞/组弹格搬进来，收起后必须把坞重建回去，
   * 否则「点了一次全部功能」之后左缘工具坞就空了。
   */
  function closePalette() {
    if (commandPalette.classList.contains("hidden")) return;
    commandPalette.classList.add("hidden");
    // 看图工具条的按钮必须回到 #viewbar（否则看图模式下那条浮条会变空）
    for (const b of viewButtons) place(b, viewbar, null);
    dockSignature = "";
    queueRefresh();
  }
  function openPalette(open = true) {
    if (open) rebuildPalette();
    if (!open) { closePalette(); return; }
    commandPalette.classList.remove("hidden");
    closeMenu();
    if (true) {
      placeCenteredPanel(commandPalette);
      if (searchInput) setTimeout(() => searchInput.focus({ preventScroll: true }), 30);
    }
  }

  // ---------------------------------------------------------------- ⋯ 菜单开合
  function closeMenu() {
    menuOpen = false;
    mainMenu.classList.add("hidden");
    displayPad.classList.add("hidden");
    menuBtn.setAttribute("aria-expanded", "false");
  }
  function openMenu(open = !menuOpen) {
    if (!open) { closeMenu(); return; }
    menuOpen = true;
    mainMenu.classList.remove("hidden");
    displayPad.classList.add("hidden");
    menuBtn.setAttribute("aria-expanded", "true");
    layoutMenu();
  }
  function layoutMenu() {
    if (mainMenu.classList.contains("hidden")) return;
    const chipRect = chip.getBoundingClientRect();
    mainMenu.style.left = `${Math.round(clamp(chipRect.left, 8, Math.max(8, window.innerWidth - 320 - 8)))}px`;
    mainMenu.style.top = `${Math.round(chipRect.bottom + 8)}px`;
    mainMenu.style.right = "auto";
    mainMenu.style.bottom = "auto";
  }
  on(menuBtn, "click", (e) => { e.stopPropagation(); openMenu(!menuOpen); });
  on(mainMenu, "click", (e) => {
    const item = e.target.closest("[data-sm]");
    if (!item) return;
    const what = item.dataset.sm;
    if (what === "palette" || what === "search") openPalette(true);
    else if (what === "display") {
      mainMenu.classList.add("hidden");
      renderDisplayPad();
      displayPad.classList.remove("hidden");
      const rect = chip.getBoundingClientRect();
      displayPad.style.left = `${Math.round(clamp(rect.left, 8, Math.max(8, window.innerWidth - 300 - 8)))}px`;
      displayPad.style.top = `${Math.round(rect.bottom + 8)}px`;
      displayPad.style.right = "auto";
      displayPad.style.bottom = "auto";
    } else if (what === "back") {
      closeMenu();
      viewbar?.querySelector('[data-vact="back"]')?.click();
    }
  });

  function renderDisplayPad() {
    displayList.replaceChildren();
    const displayState = () => {
      try { return window.__padcad?.viewDisplay || { wire: false, edges: true }; } catch (_) { return { wire: false, edges: true }; }
    };
    const mk = (label, iconName, active, toggle) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `dp-chip${active ? " on" : ""}`;
      b.append(makeIcon(iconName, 18), Object.assign(document.createElement("span"), { textContent: label }));
      b.addEventListener("click", () => { toggle(); renderDisplayPad(); });
      displayList.append(b);
    };
    const st = displayState();
    mk("线框", "wire", st.wire, () => {
      const next = !displayState().wire;
      if (window.__padcad?.setViewDisplay) window.__padcad.setViewDisplay({ wire: next });
      else viewbar?.querySelector('[data-vact="wire"]')?.click();
    });
    mk("棱边", "edges", st.edges, () => {
      const next = !displayState().edges;
      if (window.__padcad?.setViewDisplay) window.__padcad.setViewDisplay({ edges: next });
      else viewbar?.querySelector('[data-vact="edges"]')?.click();
    });
    mk("平面模式", "parallel", !!modeToggle?.classList.contains("planar"), () => modeToggle?.click());
    mk("捕捉", "snap", !!buttonByAct.get("snap")?.classList.contains("on"), () => buttonByAct.get("snap")?.click());
    mk("基准面", "datum", !!buttonByAct.get("datum")?.classList.contains("on"), () => buttonByAct.get("datum")?.click());
  }

  // ---------------------------------------------------------------- 工具坞内容
  const GROUPS = {
    array: { label: "阵列", icon: "array", acts: ["linearPattern", "circularPattern", "mirror"] },
    modify: { label: "修改", icon: "edit", acts: ["fillet", "chamfer", "shell", "move", "offsetFace", "thicken", "link"] },
    inspect: { label: "检查", icon: "measure", acts: ["measure", "combine", "splitPlane", "surface", "surfaceOffset", "surfaceThicken", "surfaceFill", "surfaceStitch"] },
    refs: { label: "参考", icon: "datum", acts: ["datum", "refg", "smartdim", "script"] },
    sketchShape: { label: "形状", icon: "polygon", acts: ["polygon", "slot", "arc", "ellipse"] },
    sketchEdit: { label: "编辑", icon: "trim", acts: ["trim", "ref", "offset", "xform", "rel"] },
    sketchView: { label: "视图", icon: "view", acts: ["snap", "view", "undo"] },
  };

  /** 每种语境下：坞里直接放哪些按钮、放哪些组（对标 im-touch 的 contextual tool catalogue） */
  const DOCK_LAYOUT = {
    model: { primary: ["select", "sketch", "pushpull", "hole"], groups: ["array", "modify", "inspect", "refs"] },
    face: { primary: ["pushpull", "sketch", "hole", "offsetFace", "shell"], groups: ["array", "modify", "inspect"] },
    edge: { primary: ["fillet", "chamfer"], groups: ["modify", "inspect"] },
    shell: { primary: ["shell", "fillet", "chamfer"], groups: ["modify", "inspect"] },
    sketch: { primary: ["select", "line", "rect", "circle", "dim"], groups: ["sketchShape", "sketchEdit", "sketchView"] },
  };

  const groupButtons = new Map();
  for (const [key, group] of Object.entries(GROUPS)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dock-btn dock-group-btn";
    btn.dataset.group = key;
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    const icon = makeIcon(group.icon, 20);
    icon.dataset.icon = group.icon;
    btn.append(icon);
    const label = document.createElement("span");
    label.className = "command-label";
    label.textContent = group.label;
    btn.append(label);
    btn.append(Object.assign(document.createElement("i"), { className: "dock-caret" }));
    btn.addEventListener("click", () => toggleGroup(key));
    groupButtons.set(key, btn);
  }

  const moreBtn = document.createElement("button");
  moreBtn.type = "button";
  moreBtn.id = "btnFeatureList";
  moreBtn.className = "dock-btn";
  moreBtn.append(makeIcon("feature", 20));
  moreBtn.append(Object.assign(document.createElement("span"), { className: "command-label", textContent: "更多" }));
  moreBtn.addEventListener("click", () => openPalette(true));

  const collapseBtn = document.createElement("button");
  collapseBtn.type = "button";
  collapseBtn.className = "dock-btn dock-collapse";
  collapseBtn.setAttribute("aria-label", "收起工具栏");
  collapseBtn.append(makeIcon("chevronLeft", 18));
  collapseBtn.addEventListener("click", () => setDockCollapsed(true));

  function toggleGroup(key) {
    if (groupOpen === key) { closeGroup(); return; }
    openGroup(key);
  }
  function closeGroup() {
    groupOpen = null;
    groupPad.classList.add("hidden");
    for (const btn of groupButtons.values()) btn.setAttribute("aria-expanded", "false");
  }
  function openGroup(key) {
    const group = GROUPS[key];
    if (!group) return;
    groupOpen = key;
    gpTitle.textContent = group.label;
    parkAll(gpGrid);
    gpGrid.replaceChildren();
    for (const act of group.acts) {
      const source = buttonByAct.get(act) || buttonBySact.get(act);
      if (!source) continue;
      decorate(source, act);
      place(source, gpGrid, "gp-item");
    }
    groupPad.classList.remove("hidden");
    for (const [k, btn] of groupButtons) btn.setAttribute("aria-expanded", String(k === key));
    layoutGroupPad();
  }
  function layoutGroupPad() {
    if (groupPad.classList.contains("hidden")) return;
    const anchorBtn = groupButtons.get(groupOpen);
    const padRect = groupPad.getBoundingClientRect();
    const anchor = anchorBtn ? anchorBtn.getBoundingClientRect() : dock.getBoundingClientRect();
    const placed = placeCard({
      anchor: { x: anchor.right + 6, y: anchor.top + anchor.height / 2 },
      size: { w: padRect.width || 300, h: padRect.height || 240 },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      avoid: avoidRects(),
      gap: 10,
      margin: 8,
    });
    groupPad.style.left = `${Math.round(placed.x)}px`;
    groupPad.style.top = `${Math.round(placed.y)}px`;
    groupPad.style.right = "auto";
    groupPad.style.bottom = "auto";
  }

  /** 坞内容只在语境真变了时重建（每个手势都重建会打断触摸） */
  function syncDock(dockContext) {
    const layout = DOCK_LAYOUT[dockContext] || DOCK_LAYOUT.model;
    const signature = `${dockContext}:${layout.primary.join(",")}:${layout.groups.join(",")}`;
    if (signature === dockSignature) { syncGroupHighlight(); return; }
    dockSignature = signature;
    closeGroup();
    parkAll(dockPrimary);
    parkAll(dockGroups);
    parkAll(dockFoot);
    dockPrimary.replaceChildren();
    dockGroups.replaceChildren();
    dockFoot.replaceChildren();
    for (const act of layout.primary) {
      const source = buttonByAct.get(act) || buttonBySact.get(act);
      if (!source) continue;
      decorate(source, act);
      place(source, dockPrimary, "dock-btn");
    }
    // 边缘语境多一个「清空边」（edgebar 的按钮是纯文字，这里做个代理）
    if (dockContext === "edge") {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "dock-btn";
      clear.id = "dockClearEdges";
      clear.append(makeIcon("clear", 20));
      clear.append(Object.assign(document.createElement("span"), { className: "command-label", textContent: "清空边" }));
      clear.addEventListener("click", () => byId("edgebar")?.querySelector('[data-edge="clear"]')?.click());
      dockPrimary.append(clear);
    }
    for (const key of layout.groups) {
      const btn = groupButtons.get(key);
      if (btn) dockGroups.append(btn);
    }
    dockFoot.append(moreBtn, collapseBtn);
    syncGroupHighlight();
  }

  /** 组按钮显示组内当前激活工具的图标（im-touch 的做法：组按钮=组内当前工具） */
  function syncGroupHighlight() {
    for (const [key, btn] of groupButtons) {
      const group = GROUPS[key];
      if (!group) continue;
      const active = group.acts.find((act) => (buttonByAct.get(act) || buttonBySact.get(act))?.classList.contains("on"));
      btn.classList.toggle("on", !!active);
      const wanted = active || group.icon;
      const iconSlot = btn.querySelector("svg");
      if (iconSlot && iconSlot.dataset.icon !== wanted) {
        const fresh = makeIcon(wanted, 20);
        fresh.dataset.icon = wanted;
        iconSlot.replaceWith(fresh);
      }
    }
  }

  function setDockCollapsed(collapsed) {
    body.classList.toggle("dock-collapsed", collapsed);
    dockHandle.setAttribute("aria-expanded", String(!collapsed));
    if (collapsed) closeGroup();
  }
  on(dockHandle, "click", () => setDockCollapsed(false));

  // ---------------------------------------------------------------- 长按：径向菜单
  function guessIcon(label = "") {
    const table = {
      矩形: "rect", 圆形: "circle", 直线: "line", 智能尺寸: "smartdim", 完成草图: "finish",
      圆角: "fillet", 倒角: "chamfer", 清空边: "clear", 推拉: "pushpull", 草图: "sketch",
      抽壳: "shell", 移动: "move", 阵列: "array", 绘制: "sketch", 实体: "solid",
      测量: "measure", 适应内容: "fit", 基准面: "datum",
    };
    return table[label] || "edges";
  }

  function showContextMenu(x, y, items = []) {
    if (disposed) return;
    radialMenu.replaceChildren(radialRing);
    if (!items.length) { hideContextMenu(); return; }
    const layout = radialLayout({ x, y, count: items.length, viewport: { w: window.innerWidth, h: window.innerHeight }, radius: 88, itemSize: 56, margin: 10 });
    radialMenu.style.left = `${Math.round(layout.box.x)}px`;
    radialMenu.style.top = `${Math.round(layout.box.y)}px`;
    radialMenu.style.width = `${Math.round(layout.box.w)}px`;
    radialMenu.style.height = `${Math.round(layout.box.h)}px`;
    // 环的圆心 = 容器中心；容器边长 = 2*(R+half)，所以环左上角偏移是 half，不是 R
    //（写成 R 时环整体右下偏 R-half=60px，像"菜单没围着手指"——父代理视觉复核抓到）
    radialRing.style.left = `${Math.round(layout.itemSize / 2)}px`;
    radialRing.style.top = `${Math.round(layout.itemSize / 2)}px`;
    radialRing.style.width = `${Math.round(layout.radius * 2)}px`;
    radialRing.style.height = `${Math.round(layout.radius * 2)}px`;
    const half = layout.itemSize / 2;
    items.forEach((item, i) => {
      const spot = layout.items[i];
      if (!spot) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "radial-item";
      btn.setAttribute("role", "menuitem");
      btn.style.left = `${Math.round(spot.x - layout.box.x - half)}px`;
      btn.style.top = `${Math.round(spot.y - layout.box.y - half)}px`;
      btn.style.width = `${layout.itemSize}px`;
      btn.style.height = `${layout.itemSize}px`;
      btn.append(makeIcon(item.icon || guessIcon(item.label), 20));
      btn.append(Object.assign(document.createElement("span"), { className: "radial-label", textContent: item.label }));
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        hideContextMenu();
        item.action?.();
      });
      radialMenu.append(btn);
    });
    radialMenu.classList.remove("hidden");
    body.classList.add("radial-open");
    radialOpenAt = performance.now();
  }
  function hideContextMenu() {
    radialMenu.classList.add("hidden");
    body.classList.remove("radial-open");
  }

  // 点外部关闭：开启后 150ms 内的指针事件一律忽略（否则开启它的那一次触摸会自己关掉菜单）
  const onDocPointerDown = (event) => {
    const stamp = event.timeStamp || performance.now();
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (!radialMenu.classList.contains("hidden") && stamp - radialOpenAt >= 150) {
      if (!radialMenu.contains(event.target) && !path.includes(radialMenu)) hideContextMenu();
    }
    if (menuOpen) {
      if (!mainMenu.contains(event.target) && !path.includes(mainMenu)
          && !displayPad.contains(event.target) && !path.includes(displayPad)
          && !menuBtn.contains(event.target)) closeMenu();
    }
    if (groupOpen) {
      const inPad = groupPad.contains(event.target) || path.includes(groupPad);
      const inBtn = [...groupButtons.values()].some((b) => b.contains(event.target));
      if (!inPad && !inBtn) closeGroup();
    }
    if (!commandPalette.classList.contains("hidden")) {
      const inPalette = commandPalette.contains(event.target) || path.includes(commandPalette);
      const inTrigger = moreBtn.contains(event.target) || mainMenu.contains(event.target);
      if (!inPalette && !inTrigger) closePalette();
    }
    if (!cancelConfirm.classList.contains("hidden")) {
      if (!cancelConfirm.contains(event.target) && !path.includes(cancelConfirm)
          && !sketchCancel.contains(event.target)) cancelConfirm.classList.add("hidden");
    }
  };
  on(window, "pointerdown", onDocPointerDown, true);
  on(window, "keydown", (event) => {
    if (event.key !== "Escape") return;
    hideContextMenu(); closeMenu(); closeGroup();
    closePalette();
    cancelConfirm.classList.add("hidden");
    if (focusMode) setFocusMode(false);
    if (body.classList.contains("dock-collapsed")) setDockCollapsed(false);
  });

  // ---------------------------------------------------------------- 草图 FAB
  on(sketchDone, "click", () => {
    cancelConfirm.classList.add("hidden");
    buttonBySact.get("finish")?.click();
  });
  on(sketchCancel, "click", () => {
    if (!cancelConfirm.classList.contains("hidden")) { cancelConfirm.classList.add("hidden"); return; }
    const rect = sketchCancel.getBoundingClientRect();
    cancelConfirm.classList.remove("hidden");
    cancelConfirm.style.left = `${Math.round(clamp(rect.right - 216, 8, window.innerWidth - 224))}px`;
    cancelConfirm.style.top = `${Math.round(Math.max(8, rect.top - 104))}px`;
    cancelConfirm.style.right = "auto";
    cancelConfirm.style.bottom = "auto";
  });
  cancelConfirm.addEventListener("click", (event) => {
    const act = event.target.closest("[data-cc]");
    if (!act) return;
    cancelConfirm.classList.add("hidden");
    if (act.dataset.cc === "yes") buttonBySact.get("cancel")?.click();
  });

  // ---------------------------------------------------------------- 全屏（Focus）
  function setFocusMode(flag) {
    focusMode = !!flag;
    body.classList.toggle("ui-focus", focusMode);
    focusToggle.setAttribute("aria-pressed", String(focusMode));
    if (focusMode) { closeMenu(); closeGroup(); closePalette(); hideContextMenu(); }
  }
  on(focusToggle, "click", () => setFocusMode(!focusMode));
  on(focusRestore, "click", () => setFocusMode(false));

  // 模型树：右上 pill 开关（复用现有的 #btnFeatToggle / #btnFeatShow 行为）
  on(treeToggle, "click", () => {
    const open = body.classList.contains("feat-open");
    if (open) byId("btnFeatToggle")?.click();
    else byId("btnFeatShow")?.click();
    setTimeout(queueRefresh, 80);
  });
  on(treeShow, "click", () => setTimeout(queueRefresh, 60));

  on(exitBtn, "click", () => {
    const cancel = sketchbar?.querySelector('[data-sact="cancel"]')
      || byId("edgebar")?.querySelector('[data-edge="cancel"]')
      || byId("featX");
    if (cancel && !cancel.closest("[hidden]") && !cancel.closest(".hidden")) cancel.click();
    else buttonByAct.get("select")?.click();
    closePalette();
  });

  // ---------------------------------------------------------------- 转视图时整体淡出
  let gesture = null;
  if (canvas) {
    on(canvas, "pointerdown", (event) => {
      gesture = { type: event.pointerType || "touch", x: event.clientX, y: event.clientY, faded: false };
    }, { passive: true });
    on(canvas, "pointermove", (event) => {
      if (!gesture || gesture.type !== "touch" || gesture.faded) return;
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 12) return;
      gesture.faded = true;
      body.classList.add("ui-fading");
    }, { passive: true });
    const endGesture = () => {
      if (!gesture) return;
      const faded = gesture.faded;
      gesture = null;
      if (!faded) return;
      body.classList.remove("ui-fading");
      repositionPicker(true);
      window.dispatchEvent(new CustomEvent("padcad:view-idle"));
    };
    on(canvas, "pointerup", endGesture);
    on(canvas, "pointercancel", endGesture);
  }
  // 点完一次（选中/取消选中面）坞的内容可能要换
  on(window, "pointerup", () => { if (body.dataset.workspace !== "start") setTimeout(queueRefresh, 60); });

  // ---------------------------------------------------------------- 选中面小卡定位
  function avoidRects() {
    const out = [];
    for (const id of ["shellTopLeft", "shellTopRight", "dimHandle", "status"]) {
      const el = byId(id);
      if (!el) continue;
      if (el.classList.contains("hidden") || el.hidden) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) out.push({ x: r.left - 4, y: r.top - 4, w: r.width + 8, h: r.height + 8 });
    }
    if (!body.classList.contains("dock-collapsed")) {
      const dockRect = dock.getBoundingClientRect();
      if (dockRect.width > 4 && dockRect.height > 4) out.push({ x: dockRect.left - 6, y: dockRect.top - 6, w: dockRect.width + 12, h: dockRect.height + 12 });
    }
    if (!sketchActions.hidden) {
      const fab = sketchActions.getBoundingClientRect();
      if (fab.width > 4) out.push({ x: fab.left - 6, y: fab.top - 6, w: fab.width + 12, h: fab.height + 12 });
    }
    return out;
  }

  function placePickerAt(point, world = null) {
    if (world) pickerWorld = world;
    if (!point) { pickerScreen = null; return null; }
    pickerScreen = { x: point[0], y: point[1] };
    const el = byId("picker");
    if (!el || el.classList.contains("hidden")) return null;
    const rect = el.getBoundingClientRect();
    let sel = null;
    try { const r = selectionRect?.(); if (r && r.w > 2 && r.h > 2) sel = r; } catch (_) { sel = null; }
    const placed = placeCard({
      anchor: pickerScreen,
      size: { w: rect.width || 236, h: rect.height || 132 },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      // 也要躲开「选中面本身」的屏幕包围盒：只躲手柄时卡片会正好压在刚选中的面上
      avoid: [...avoidRects(), ...(sel ? [{ x: sel.x - 6, y: sel.y - 6, w: sel.w + 12, h: sel.h + 12 }] : [])],
      // 候选位是「锚点 ± gap」：gap 小于面的半宽时 8 个候选全都压在面上，避让罚分也救不回来
      gap: sel ? Math.max(46, Math.max(sel.w, sel.h) / 2 + 14) : 46,
      margin: 8,
    });
    el.style.left = `${Math.round(placed.x)}px`;
    el.style.top = `${Math.round(placed.y)}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
    el.dataset.side = placed.side;
    return placed;
  }

  /** 相机变了 / 手势结束时，把面卡重新贴到面的投影上（转视角时它已经淡出了） */
  function repositionPicker(force = false) {
    if (!pickerWorld || !project) return;
    const el = byId("picker");
    if (!el || el.classList.contains("hidden")) return;
    if (!force && body.classList.contains("ui-fading")) return;
    let pt = null;
    try { pt = project(pickerWorld); } catch (_) { pt = null; }
    if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) return;
    placePickerAt(pt);
  }

  // ---------------------------------------------------------------- 刷新
  const commandPanels = ["extrude", "edgebar", "linkbar", "patternPanel", "featPanel", "smartPad", "movePad", "refgPad", "commandPalette", "xformPad", "relPad", "offsetPanel", "dimPanel", "measurePad", "holePad", "solidPad", "surfacePad", "skToolPad", "surfaceGroupPad"];
  // 只用来「看一眼就刷新」的节点（选中面小卡 / 尺寸手柄 / 历史 / 模型树），不参与语境判定
  const watchOnly = ["picker", "dimHandle", "tree", "featTree"];

  function dockContextOf(workspace, sketchVisible) {
    if (workspace !== "model") return "model";
    if (sketchVisible) return "sketch";
    let mode = "select";
    let edgeCount = 0;
    let faceId = null;
    try {
      mode = window.__padcad?.mode || "select";
      edgeCount = window.__padcad?.edgeSel?.length || 0;
      faceId = window.__padcad?.selectedFaceId ?? null;
    } catch (_) {}
    if (mode === "sketch") return "sketch";
    if (mode === "shell") return "shell";
    if (mode === "fillet" || mode === "chamfer" || edgeCount > 0) return "edge";
    if (faceId != null) return "face";
    return "model";
  }

  function refresh() {
    if (disposed) return;
    attachViewControls();
    decorate(modeToggle, "view");
    const workspace = visible(byId("startScreen")) ? "start" : visible(viewbar) ? "view" : "model";
    const sketchVisible = workspace === "model" && visible(sketchbar);
    const sketchPending = workspace === "model" && visible(byId("extrude"));
    const command = workspace === "model" && !sketchVisible && commandPanels.some((id) => visible(byId(id)));
    const context = sketchVisible ? "sketch" : command ? "command" : "model";
    const dockContext = dockContextOf(workspace, sketchVisible);
    if (body.dataset.workspace !== workspace) body.dataset.workspace = workspace;
    if (body.dataset.context !== context) body.dataset.context = context;
    if (body.dataset.dock !== dockContext) body.dataset.dock = dockContext;
    const docName = title.textContent;
    const menuDoc = mainMenu.querySelector("#menuDocName");
    if (menuDoc && menuDoc.textContent !== docName) menuDoc.textContent = docName;
    setHidden(header, workspace === "start");
    setHidden(dock, workspace === "start");
    setHidden(dockHandle, workspace === "start" || !body.classList.contains("dock-collapsed"));
    setHidden(navigation, workspace !== "model");
    setHidden(exitBtn, !(workspace === "model" && context === "command"));
    setHidden(sketchActions, !(workspace === "model" && sketchVisible));
    setHidden(treeShow, workspace === "start");
    if (workspace === "start") { closeMenu(); closeGroup(); hideContextMenu(); commandPalette.classList.add("hidden"); dockSignature = ""; }
    // 历史 / 模型树在草图（含待拉伸）期间锁定
    for (const node of [byId("tree"), byId("featTree"), history]) lockHistory(node, sketchVisible || sketchPending);
    try {
      const faces = window.__padcad?.shape?.faces?.length;
      if (faces != null) setFaceCount(faces);
    } catch (_) {}
    syncDock(dockContext);
    if (workspace !== "start") repositionPicker();
    queueLayout();
  }
  function queueRefresh() {
    if (disposed || refreshFrame) return;
    refreshFrame = requestAnimationFrame(() => { refreshFrame = 0; refresh(); });
  }

  function queueLayout() {
    if (disposed || layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      if (disposed) return;
      const rect = canvas?.getBoundingClientRect();
      if (!rect) return;
      const signature = [rect.left, rect.top, rect.width, rect.height, window.devicePixelRatio || 1].map((n) => Math.round(n * 100) / 100).join(":");
      if (signature === lastLayout || rect.width <= 0 || rect.height <= 0) return;
      lastLayout = signature;
      onLayout();
    });
  }

  const faceCountChip = document.createElement("span");
  faceCountChip.id = "faceCountChip";
  faceCountChip.className = "chip";
  faceCountChip.textContent = "面数：0";
  faceCountChip.setAttribute("aria-hidden", "true");
  body.append(faceCountChip);
  created.push(faceCountChip);
  function setFaceCount(n) {
    if (disposed) return;
    const text = `面数：${n ?? 0}`;
    if (faceCountChip.textContent !== text) faceCountChip.textContent = text;
  }

  const observer = new MutationObserver(queueRefresh);
  for (const id of ["startScreen", "viewbar", "sketchbar", "toolbar", ...commandPanels, ...watchOnly]) {
    const node = byId(id);
    if (!node) continue;
    observer.observe(node, { attributes: true, attributeFilter: ["class", "hidden"] });
  }
  if (modeToggle) observer.observe(modeToggle, { childList: true, attributes: true, attributeFilter: ["class"] });
  const resizeObserver = new ResizeObserver(queueLayout);
  if (canvas) resizeObserver.observe(canvas);
  on(window, "resize", () => { queueLayout(); layoutMenu(); layoutGroupPad(); repositionPicker(true); });
  on(window, "orientationchange", () => { queueLayout(); layoutMenu(); layoutGroupPad(); repositionPicker(true); });
  // 相机停下后把面卡贴回面上
  on(window, "padcad:view-idle", () => repositionPicker(true));

  body.classList.add("workspace-ui");
  body.classList.add("workspace-float");

  const controller = {
    setDocumentName(name) {
      if (disposed) return;
      const text = typeof name === "string" && name.trim() ? name.trim() : "未命名设计";
      title.textContent = text;
      title.title = text;
      const menuDoc = mainMenu.querySelector("#menuDocName");
      if (menuDoc) menuDoc.textContent = text;
    },
    setFaceCount,
    showContextMenu,
    hideContextMenu,
    placePickerAt,
    repositionPicker,
    setFocusMode,
    toggleFocus: () => setFocusMode(!focusMode),
    setDockCollapsed,
    openMenu,
    openPalette,
    closeAll() { closeMenu(); closeGroup(); hideContextMenu(); commandPalette.classList.add("hidden"); displayPad.classList.add("hidden"); dockSignature = ""; queueRefresh(); },
    get focusMode() { return focusMode; },
    get pickerSide() { return byId("picker")?.dataset.side || null; },
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (statusTimer) clearTimeout(statusTimer);
      observer.disconnect();
      resizeObserver.disconnect();
      for (const fn of cleanups) fn();
      statusBar?.classList.toggle("expanded", !!statusWasExpanded);
      for (const [node, marker] of moved) {
        if (marker.parentNode) marker.replaceWith(node);
      }
      for (const [button, record] of decorated) {
        if (button === modeToggle) button.textContent = button.querySelector(".command-label")?.textContent || button.textContent;
        else button.replaceChildren(...record.children);
        if (!record.hadClass) button.classList.remove("command-button");
        button.classList.remove("pill-btn", "sm-act", "gp-item", "dock-btn", "dock-float-btn");
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
      for (const node of created.slice().reverse()) node.remove();
      if (!hadClass) body.classList.remove("workspace-ui");
      body.classList.remove("workspace-float", "ui-focus", "ui-fading", "dock-collapsed");
      for (const name of ["workspace", "context", "dock"]) {
        if (originalDataset[name] == null) delete body.dataset[name];
        else body.dataset[name] = originalDataset[name];
      }
      installations.delete(document);
      onLayout();
    },
  };

  // 首次进入建模时的一次性手势说明（记住已看过，不再常驻底栏）
  let hintChecked = false;
  function maybeShowHint() {
    if (body.dataset.workspace !== "model") return;
    if (!hintChecked) {
      hintChecked = true;
      let seen = false;
      try { seen = localStorage.getItem(HINT_KEY) === "1"; } catch (_) {}
      if (seen) return;
      try { localStorage.setItem(HINT_KEY, "1"); } catch (_) {}
      const toast = document.createElement("div");
      toast.id = "gestureToast";
      toast.className = "gesture-toast";
      toast.textContent = "单指点选 · 单指拖动转视角 · 双指平移/缩放 · 长按出菜单";
      body.append(toast);
      created.push(toast);
      setTimeout(() => toast.classList.add("toast-out"), 6000);
    }
  }

  installations.set(document, controller);
  refresh();
  maybeShowHint();
  setTimeout(() => { queueRefresh(); maybeShowHint(); }, 500);

  return controller;
}
