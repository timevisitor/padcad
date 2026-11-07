import "./view-controls.css";

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
  panel.append(current, grid, hint);
  root.append(trigger, panel);
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
