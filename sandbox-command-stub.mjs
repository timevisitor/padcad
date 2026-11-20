/**
 * 沙箱里的撤销栈替身（只给把 main.js 函数抠进 vm 的老回归夹具用）
 *
 * 那些夹具是把 main.js 的函数源码抠出来、在没有 import 的沙箱里跑，
 * 所以引用了模块级 `docCommands` 的函数会 ReferenceError。
 * 这里只补**事务语义**（失败整体回滚），不补撤销/重做本身 ——
 * 撤销语义由 regression-param-edit.mjs 在真实模块上覆盖，两边不重复也不互相冒充。
 *
 * 用法：先建好 vm 上下文，再 `ctx.docCommands = sandboxCommands(ctx)`。
 */
export function sandboxCommands(ctx) {
  return {
    run(_label, fn) {
      const before = { history: ctx.history, hIndex: ctx.hIndex, shape: ctx.shape };
      try {
        return fn();
      } catch (err) {
        ctx.history = before.history;
        ctx.hIndex = before.hIndex;
        ctx.shape = before.shape;
        throw err;
      }
    },
    undo() { return null; },
    redo() { return null; },
    clear() {},
    undoDepth: 0,
    redoDepth: 0,
    undoLabel: null,
    redoLabel: null,
  };
}
