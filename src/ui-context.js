/**
 * 语境动作表 + 关联工具栏渲染（对标 SolidWorks 的「关联工具栏」/ Shapr3D 的「选中即命令」）。
 *
 * 为什么单独一层：
 *  1. `contextActions()` 是**纯函数** —— 只按「选中对象的类型」返回按钮清单，
 *     不碰 DOM、不碰全局，所以能在 node 里对每一种选择断言按钮文案集合（regression-ui-context.mjs）。
 *  2. 渲染层 `renderContextToolbar()` 只负责把清单填进**已有的** `#picker` 卡片。
 *     不复用 #picker 而另起一个浮层，会立刻踩到 skill 里记过的坑：
 *     「命令面板与选中面面板抢同一个位置」——两个浮层同时出现在右上命令位、上面的那个把下面的盖掉。
 *
 * 按钮文案 = 功能名（项目铁律：轨上每个按钮的可见文字就是它的功能名）。
 * 清单里出现的每个 key 都必须在 main.js 的 `runContextAction()` 里有真实实现，
 * 不允许出现「点了没反应」的装饰按钮 —— 验收脚本会逐个点并断言 history / 体积真的变了。
 */

/** 每种选择的标题（卡片左上角） */
export const KIND_TITLE = {
  "face-plane": "平面",
  "face-cylinder": "圆柱面",
  "face-curved": "曲面",
  edge: "棱边",
  profile: "草图轮廓",
  pair: "两个面",
};

/**
 * 按对象类型给出可用动作。
 * @param {string} kind face-plane | face-cylinder | face-curved | edge | profile | pair
 * @param {{multi?:boolean, editable?:boolean, curved?:string, count?:number}} ctx
 * @returns {{key:string,label:string,hint:string}[]}
 */
export function contextActions(kind, ctx = {}) {
  const multi = !!ctx.multi;
  switch (kind) {
    case "face-plane":
      return [
        // 推拉是本项目的主交互：保留数值框 + 按钮（SolidWorks 里对应「拉伸/切除」）
        { key: "pushpull", label: "推拉", hint: "按输入的距离沿法向推/拉这个面", value: true },
        { key: "sketch", label: "草图", hint: "在这个面上新建草图" },
        { key: "hole", label: "孔", hint: "在这个面上打孔（孔心取手指点中的位置）" },
        { key: "offsetFace", label: "移动面", hint: "沿法向偏移这个面（移动面特征）" },
        { key: "filletEdges", label: "圆角", hint: "先选中这个面的棱边，再进圆角命令" },
        { key: "multi", label: multi ? "退出加选" : "加选面", hint: "再加选一个面，测两者距离" },
      ];
    case "face-cylinder":
      return [
        { key: "diameter", label: "改直径", hint: "按直径改这个圆柱面（改驱动特征，走参数化重放）", value: true },
        { key: "coaxHole", label: "同轴孔", hint: "沿这个圆柱的轴线在端面打一个孔" },
        { key: "multi", label: multi ? "退出加选" : "加选面", hint: "再加选一个面，测两者距离" },
      ];
    case "face-curved":
      return [
        { key: "multi", label: multi ? "退出加选" : "加选面", hint: "再加选一个面，测两者距离" },
      ];
    case "edge":
      return [
        { key: "fillet", label: "圆角", hint: "对这条棱边做圆角" },
        { key: "chamfer", label: "倒角", hint: "对这条棱边做倒角" },
      ];
    case "profile":
      return [
        { key: "extrude", label: "拉伸", hint: "把选中的草图轮廓拉成实体" },
        { key: "revolve", label: "旋转", hint: "把选中的草图轮廓绕轴旋转成实体" },
        { key: "sweep", label: "扫掠", hint: "把选中的草图轮廓沿法向扫掠成实体" },
        { key: "finishSketch", label: "完成草图", hint: "结束草图，进入拉伸参数" },
      ];
    case "pair":
      return [
        { key: "distance", label: "距离", hint: "读这两个面的垂直距离" },
        { key: "smartdim", label: "智能尺寸", hint: "用智能尺寸把这两个面的距离改成数值" },
      ];
    default:
      return [];
  }
}

/** 卡片那一行的标签文字（面号 / 边号 / 轮廓数…） */
export function contextTag(kind, ctx = {}) {
  const pad = (v) => `#${String(v % 100000).padStart(5, "0")}`;
  if (kind === "edge") return ctx.tag || "棱边";
  if (kind === "profile") return `${ctx.count ?? 0} 个轮廓`;
  if (kind === "pair") return `${ctx.count ?? 2} 个面`;
  if (ctx.faceId != null) return pad(ctx.faceId);
  return KIND_TITLE[kind] || "";
}

/**
 * 把动作清单渲染进 #picker（或任何同构容器）。
 * @param {HTMLElement} el 目标容器（本项目就是 #picker）
 * @param {{kind:string, tag:string, sub:string, actions:object[], value?:number,
 *          valueLabel?:string, note?:string, debug?:string}} o
 * @returns {{kind:string, labels:string[]}}
 */
export function renderContextToolbar(el, o) {
  if (!el) return { kind: o?.kind || null, labels: [] };
  const kind = o.kind;
  const actions = o.actions || [];
  const hasValue = o.value != null;
  const quick = actions.filter((a) => !a.value);
  const push = actions.find((a) => a.value);
  const head = `<div class="pk-head"><span>${o.headline || KIND_TITLE[kind] || "选择"} <b>${o.tag || ""}</b></span>`
    + `<span class="pk-sub">${o.sub || ""}</span></div>`;
  const row = (push || hasValue)
    ? `<div class="pk-row"><input id="dist" type="number" inputmode="decimal" step="0.5" value="${o.value}" />`
      + `<button data-act="apply" data-ctx="${push ? push.key : "apply"}" type="button">${push ? push.label : (o.valueLabel || "应用")}</button></div>`
    : "";
  /*
   * 列数跟着动作数走：5 个及以上排 3 列（2 行），4 个排 2 列（2×2）——
   * 4 个塞 3 列会剩一个孤零零的按钮独占第二行（实测视觉复核抓到的）。
   */
  const cols = quick.length === 4 ? 2 : 3;
  const quickHtml = quick.length
    ? `<div class="pk-quick pk-grid pk-cols-${cols}">${quick.map((a) => `<button type="button" data-ctx="${a.key}" title="${a.hint || ""}">${a.label}</button>`).join("")}</div>`
    : "";
  el.innerHTML = head + row + quickHtml
    + (o.note ? `<div class="pk-note">${o.note}</div>` : "")
    + (o.debug ? `<div class="pk-debug">${o.debug}</div>` : "");
  return { kind, labels: actions.map((a) => a.label) };
}
