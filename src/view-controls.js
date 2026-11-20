import "./view-controls.css";

const SVG_NS = "http://www.w3.org/2000/svg";

const VIEW_OPTIONS = [
  ["iso", "等轴测"], ["front", "前视"], ["back", "后视"],
  ["left", "左视"], ["right", "右视"], ["top", "顶视"], ["bottom", "底视"],
];
let controlSequence = 0;

/** 只操作相机；草图会话仍由主程序管理。 */
export function installViewControls({ viewer, isSketchMode = () => false, onMessage = () => {} }) {
  const root = document.createElement("div");
  root.className = "view-controls";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "view-controls-trigger";
  trigger.textContent = "视图";
  trigger.setAttribute("aria-expanded", "false");

  const panel = document.createElement("div");
  panel.id = `view-controls-panel-${++controlSequence}`;
  panel.className = "view-controls-panel";
  panel.hidden = true;
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "切换视图");
  trigger.setAttribute("aria-controls", panel.id);

  /*
   * 视图立方（Shapr3D 的 Orientation Cube / SolidWorks 的前导视图立方）。
   * 只做**看得见的那三个面**（顶 / 前 / 右）：背面三个方向在下面的按钮格里，
   * 别把立方体做成"一个点六个方向还点不准"的东西。
   * 几何按项目的 30° 等轴测规格：viewBox 132×132，立方体中心 (66,66)。
   *
   * 注意：regression-standard-views.mjs 把本模块源码抠进一个**没有 createElementNS** 的
   * 假 document 里跑；那里建不出 SVG 就跳过立方体，按钮格照旧工作（产品路径永远有 SVG）。
   */
  const canBuildCube = typeof document.createElementNS === "function";
  const CUBE_FACES = [
    { view: "top", label: "顶视", d: "M66 20 97 38 66 56 35 38Z", cls: "vc-top" },
    { view: "front", label: "前视", d: "M35 38 66 56 66 96 35 78Z", cls: "vc-front" },
    { view: "right", label: "右视", d: "M97 38 66 56 66 96 97 78Z", cls: "vc-right" },
  ];
  const cubeFaces = new Map();
  let cube = null;
  if (canBuildCube) {
    cube = document.createElementNS(SVG_NS, "svg");
    cube.setAttribute("class", "view-cube");
    cube.setAttribute("viewBox", "0 0 132 132");
    cube.setAttribute("role", "group");
    cube.setAttribute("aria-label", "点选方位：顶 / 前 / 右");
    for (const f of CUBE_FACES) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", f.d);
      path.setAttribute("class", `vc-face ${f.cls}`);
      path.setAttribute("data-view", f.view);
      path.setAttribute("role", "button");
      path.setAttribute("tabindex", "0");
      path.setAttribute("aria-label", f.label);
      cubeFaces.set(f.view, path);
      cube.append(path);
    }
    const cubeHint = document.createElementNS(SVG_NS, "text");
    cubeHint.setAttribute("x", "66");
    cubeHint.setAttribute("y", "122");
    cubeHint.setAttribute("class", "vc-hint");
    cubeHint.textContent = "点面切视图";
    cube.append(cubeHint);
  }

  const current = document.createElement("p");
  current.className = "view-controls-current";
  current.setAttribute("aria-live", "polite");
  const grid = document.createElement("div");
  grid.className = "view-controls-grid";
  const hint = document.createElement("p");
  hint.className = "view-controls-hint";
  hint.id = `${panel.id}-hint`;
  grid.setAttribute("aria-describedby", hint.id);

  const viewButtons = new Map();
  let disposed = false;
  let lastState = "";
  function close({ restoreFocus = false } = {}) {
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus();
  }
  function refresh() {
    if (disposed) return;
    const sketch = !!isSketchMode();
    const selected = viewer.cam.standardView;
    const state = `${sketch}:${selected}`;
    if (state === lastState) return;
    lastState = state;
    const label = VIEW_OPTIONS.find(([name]) => name === selected)?.[1] || "自由视角";
    current.textContent = `当前：${label}`;
    trigger.setAttribute("aria-label", `视图，当前${label}`);
    for (const [name, button] of viewButtons) {
      button.disabled = sketch;
      button.classList.toggle("on", name === selected);
      button.setAttribute("aria-pressed", String(name === selected));
      button.title = sketch ? "请先退出草图，再切换世界视图" : `切换到${button.textContent}`;
    }
    hint.textContent = sketch
      ? "请先退出草图，再切换世界视图。适配仍可使用。"
      : "切换观察方向不会修改模型。";
    for (const [name, path] of cubeFaces) {
      path.classList.toggle("on", name === selected);
      // 草图里不切断命中区：让用户点得到、并得到一句"先退出草图"的说明，
      // 比一个点了没反应的灰块好（灰块会让人以为界面坏了）
      path.setAttribute("aria-disabled", String(sketch));
      path.classList.toggle("off", sketch);
    }
  }
  function open() {
    if (disposed) return;
    refresh();
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
  }
  for (const [name, label] of VIEW_OPTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.view = name;
    button.textContent = label;
    button.addEventListener("click", () => {
      if (isSketchMode()) { refresh(); onMessage("请先退出草图，再切换世界视图"); return; }
      viewer.cam.setStandardView(name);
      refresh();
      onMessage(`已切换为${label}`);
      close({ restoreFocus: true });
    });
    viewButtons.set(name, button);
    grid.append(button);
  }
  const fit = document.createElement("button");
  fit.type = "button";
  fit.dataset.view = "fit";
  fit.className = "view-controls-fit";
  fit.textContent = "适配模型";
  fit.addEventListener("click", () => {
    if (!viewer.bbox || viewer.bbox.isEmpty()) {
      onMessage("当前没有可适配的模型");
      return;
    }
    viewer.cam.fit(viewer.bbox);
    onMessage("模型已适配到视图");
    close({ restoreFocus: true });
  });
  grid.append(fit);
  panel.append(...(cube ? [cube] : []), current, grid, hint);
  root.append(trigger, panel);

  const pickFace = (name) => {
    if (isSketchMode()) { refresh(); onMessage("请先退出草图，再切换世界视图"); return; }
    viewer.cam.setStandardView(name);
    refresh();
    onMessage(`已切换为${VIEW_OPTIONS.find(([n]) => n === name)?.[1] || name}`);
    close();
  };
  if (cube) cube.addEventListener("click", (event) => {
    const t = event.target?.closest?.("[data-view]");
    if (t) pickFace(t.getAttribute("data-view"));
  });
  if (cube) cube.addEventListener("keydown", (event) => {
    const t = event.target?.closest?.("[data-view]");
    if (t && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); pickFace(t.getAttribute("data-view")); }
  });
  document.body.append(root);

  const toggle = () => panel.hidden ? open() : close();
  const outside = (event) => { if (!root.contains(event.target)) close(); };
  const escape = (event) => {
    if (event.key !== "Escape" || panel.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    close({ restoreFocus: true });
  };
  trigger.addEventListener("click", toggle);
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", escape, true);
  const unsubscribe = viewer.cam.addChangeListener(refresh);
  refresh();

  return {
    refresh, open, close,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      root.remove();
    },
  };
}
