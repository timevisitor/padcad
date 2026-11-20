/**
 * 全局状态容器（main.js 解耦第 1 步，见 docs/MAINJS_DECOUPLE_PLAN_2026-11-04.md §3）
 *
 * 现状（5.1.7 基线）：main.js 有 86 个模块级可变变量，几乎所有函数直接读写它们，
 * 于是 main.js 是一个「单一共享状态闭包」—— 别的模块想拿 shape / history / mode
 * 只能走 window.__padcad（调试出口），既没有写入能力，也没法被依赖。
 *
 * 本步只做**过渡期门面**，不改任何行为：
 *   · state.doc / state.ui / state.view 是三个对象，键由 bindSlot() 注册；
 *   · 每个槽位是一对 getter/setter，默认**委托**给 main.js 的模块级变量
 *     （`bindSlot("doc.shape", { get: () => shape, set: (v) => { shape = v; } })`），
 *     所以此刻「真源」仍在 main.js，任何读写都等价于直接读写那个变量 —— 行为零变化；
 *   · 后续每迁移一族（草图会话 / 存档 / 特征提交…），把该槽位的委托换成它自己的存储即可，
 *     外部调用方（新模块）一行都不用改。
 *
 * 迁移规则（写进报告，也写在这里防以后忘）：
 *   1. 只有真正跨模块共享的东西才配进 state；纯局部的临时量（drag / dimRaf …）不要加；
 *   2. 一个槽位只能有一个真源。不要一边委托给 main.js 的变量、一边另有存储；
 *   3. 读写一律走 state.<block>.<key>，不要绕过 setter（否则 subscribe 收不到变更）。
 */

/** 槽位表：path -> { get, set }，用于 subscribe / snapshot / 诊断。 */
const slots = new Map();

export const state = {
  /** 文档级：几何与历史（可保存、可重建的那部分） */
  doc: { shape: null, history: [], hIndex: -1, sketch: null, refGeoms: [], datum: null },
  /** 交互级：模式、选择、会话（不进工程文件的那部分） */
  ui: {
    mode: "select",
    appMode: null,
    selectedFaceId: null,
    edgeSel: [],
    sketchTool: "rect",
    /** 语境工具栏当前展示的对象类型（face-plane / face-cylinder / edge / profile / pair） */
    contextKind: null,
  },
  /** 视图级：只看不写的运行时对象（相机、画布、网格组…） */
  view: { viewer: null, camera: null, canvas: null, gridGroup: null },
  /** 应用模式注册表（装配模式等后续挂点用；见 main.js 的 registerAppMode） */
  modes: new Map(),
  /** 槽位元信息：给报告/诊断脚本读，说明每个槽位此刻的真源在哪 */
  meta: {},
};

const listeners = new Map();   // path -> Set<fn>

/**
 * 注册（或重新指向）一个状态槽位。
 * @param {string} path  "doc.shape" / "ui.mode" …
 * @param {{get:()=>any, set?:(v:any)=>void, owner?:string, writable?:boolean, note?:string}} spec
 */
export function bindSlot(path, spec) {
  const [block, key] = String(path).split(".");
  if (!state[block] || block === "modes" || block === "meta") {
    throw new Error(`state: 未知的块 "${block}"（可用 doc / ui / view）`);
  }
  if (!key) throw new Error(`state: 槽位路径必须写成 block.key，收到 ${path}`);
  if (typeof spec?.get !== "function") throw new Error(`state: ${path} 缺少 get`);
  const writable = typeof spec.set === "function";
  slots.set(path, { get: spec.get, set: spec.set });
  Object.defineProperty(state[block], key, {
    enumerable: true,
    configurable: true,
    get: () => spec.get(),
    set: (value) => {
      if (!writable) throw new Error(`state: ${path} 是只读槽位`);
      spec.set(value);
      notify(path, value);
    },
  });
  state.meta[path] = {
    block,
    key,
    writable,
    owner: spec.owner || "main.js",
    note: spec.note || "",
  };
  return path;
}

/** 批量注册：bindSlots({ "doc.shape": {...}, ... }) */
export function bindSlots(map) {
  for (const [path, spec] of Object.entries(map)) bindSlot(path, spec);
  return Object.keys(map);
}

/** 订阅某个槽位的写入（setter 触发；直接改 main.js 变量不会触发，迁移完成后才一致）。 */
export function subscribe(path, fn) {
  if (!listeners.has(path)) listeners.set(path, new Set());
  listeners.get(path).add(fn);
  return () => listeners.get(path)?.delete(fn);
}

function notify(path, value) {
  const set = listeners.get(path);
  if (!set) return;
  for (const fn of set) {
    try { fn(value, path); } catch (err) { console.error(`state: 订阅 ${path} 的回调抛错`, err); }
  }
}

/** 当前所有已注册槽位的值快照（诊断用；history 只取长度，避免把大对象复制出去）。 */
export function snapshot() {
  const out = {};
  for (const path of slots.keys()) {
    const [block, key] = path.split(".");
    let v = state[block][key];
    if (Array.isArray(v)) v = { length: v.length };
    else if (v && typeof v === "object") v = `[${v.constructor?.name || "object"}]`;
    out[path] = v;
  }
  return out;
}

/** 已注册槽位列表（回归测试断言用）。 */
export function slotPaths() {
  return [...slots.keys()];
}

/** 清空注册（仅测试用；运行期没有任何调用点）。 */
export function _resetForTest() {
  for (const path of slots.keys()) {
    const [block, key] = path.split(".");
    try { delete state[block][key]; } catch (_) { /* ignore */ }
  }
  slots.clear();
  listeners.clear();
  state.meta = {};
}
