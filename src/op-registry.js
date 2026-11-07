/**
 * op 注册表（并行开发用）
 *
 * 为什么要它：参数化重放原来是一个 240 行的大 switch，新增任何特征都得改 replay.js，
 * 三条线并行做功能时必然冲突。改成「注册」后，每个功能模块在自己的文件里 registerOp，
 * replay.js 只在 switch 落不到时查表 —— 三条线动的是不同文件。
 *
 * 约定：注册的 fn 签名 (shape, op, ctx) => shape，必须是纯几何、可由 op 完全确定；
 * 抛错要让调用方知道哪一步失败（replay 会补 stepIndex）。
 */
const registry = new Map();

export function registerOp(type, fn) {
  if (typeof type !== "string" || !type) throw new Error("op 类型名必须是非空字符串");
  if (typeof fn !== "function") throw new Error(`op ${type} 的处理函数必须是函数`);
  if (registry.has(type)) throw new Error(`op 类型 ${type} 已经注册过，不要重复注册`);
  registry.set(type, fn);
  return fn;
}

export function lookupOp(type) { return registry.get(type) || null; }
export function registeredOps() { return [...registry.keys()].sort(); }
