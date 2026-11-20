/**
 * 参数编辑事务 / 撤销命令栈
 *
 * 为什么需要这一层（实测取证，不是推测）：
 *   原来 main.js 的 applyEdit 把新定义**就地**写进 history[i].op，重建又把
 *   history[i].shape 覆盖成新实体；而 undo 唯一的快照就是这个 history[i].shape，
 *   它只会 gotoStep(hIndex-1)。所以「改深度 5 → 12 后按撤销」得到的是
 *   「少显示一步、几何仍是 12」（实测体积 18595.2213 → 19015.2213 后撤销仍 19015.2213），
 *   旧参数值在整条历史里已经没人持有。
 *
 * 这一层的三条约定（改任何调用点前先读）：
 *   1. **历史行是不可变值**。要改某一行就换一个新对象（replaceStep），
 *      绝不 `history[i].xxx = …`。这样「快照 = 数组引用 + 游标」就足够，
 *      不需要给每步做深拷贝，也不会出现半成品状态。
 *   2. **实体（shape）是值，只在回填时被替换、不被消费**。replay.rebuild 续算前
 *      会 clone hist[start-1].shape，所以快照里留着的实体引用仍然有效。
 *   3. **一次用户动作 = 一步撤销**。嵌套（一个动作里又调 commit）不另开步，
 *      靠 run() 里的 depth 计数，对齐 SolidCraft 的 note_inner_undoable。
 *
 * 判定「改没改」用引用比较（history 数组换了没有 / 游标变了没有），
 * 不用布尔脏标记 —— 脏标记漏置一次就会静默丢一步撤销。
 */
import { rebuild } from "./replay.js";
import { cacheRebuild } from "./project.js";

export const MAX_UNDO = 200;

/**
 * 不可变替换第 index 行。
 * 改动之前的行原样复用（增量重建要靠它们的快照标记）；
 * 改动之后的行一律浅拷贝 —— 重建回填 shape 时不能污染旧数组（旧数组可能正被快照/脚本撤销持有）。
 */
export function replaceStep(history, index, patch) {
  if (!Number.isInteger(index) || index < 0 || index >= history.length) {
    throw new Error(`要改的步骤不存在（${index}）`);
  }
  return history.map((row, i) => (i < index ? row : i === index ? { ...row, ...patch } : { ...row }));
}

/** 追加一个特征（截断 redo 分支），返回新数组与新游标 */
export function appendStep(history, hIndex, row) {
  const next = history.slice(0, hIndex + 1);
  next.push(row);
  return { history: next, hIndex: next.length - 1 };
}

/** 重放到 hIndex 并把每一步实体回填（就地写 next 的行；这些行是本次换出来的新对象） */
export function rebuildInto(history, hIndex) {
  const result = rebuild(history, hIndex);
  cacheRebuild(history, result);
  return result;
}

const definition = (op) => {
  try { return JSON.stringify(op ?? null); } catch (_) { return String(op); }
};

/**
 * 换掉第 index 步的定义并重建到 hIndex。
 *
 * 纯计算：失败直接抛（RefLost / 内核错误），**入参数组与行对象一律不动**，
 * 调用方（参数编辑事务）据此保持「失败 = 什么都没发生」。
 * 定义没变化时返回 changed:false，且历史数组引用原样返回 —— 于是无变化提交
 * 天然不占撤销步（不需要在 UI 层再判一次）。
 *
 * 在回滚位置（hIndex < 最后一步）改参数会**截断重做分支**：后面的快照是按旧定义
 * 算的，留着就会重做出过期几何（旧 acceptRebuild 也是这个口径）。截断后的分支
 * 仍在撤销快照里，撤销一次就全回来。
 *
 * @returns {{ history, shape, result, changed }}
 */
export function commitStepOp(history, hIndex, index, newOp, detailOf) {
  const row = history[index];
  if (!row) throw new Error(`要改的步骤不存在（${index}）`);
  const unchanged = definition(row.op) === definition(newOp);
  if (unchanged) {
    return { history, shape: hIndex >= 0 ? history[hIndex]?.shape ?? null : null, result: null, changed: false };
  }
  const next = replaceStep(history, index, {
    op: newOp,
    detail: typeof detailOf === "function" ? detailOf(newOp) : row.detail,
  }).slice(0, hIndex + 1);
  // 先算后写：rebuild 抛错时 next 还没被任何地方看见（只有 cacheRebuild 会写行）
  const result = rebuild(next, hIndex);
  cacheRebuild(next, result);
  return { history: next, shape: hIndex >= 0 ? next[hIndex]?.shape ?? null : null, result, changed: true };
}

/**
 * 撤销命令栈。
 *
 * read()  → { history, hIndex }（读当前文档；实体从 history[hIndex].shape 取）
 * write(s)→ 把 { history, hIndex } 装回文档（调用方顺手刷新视图/特征树）
 *
 * 快照冻结的是**行对象的浅拷贝**：之后对当前行的就地写（例如重建时回填的 `shape`）
 * 不会污染快照；还原时再拷一份，避免还原出来的行与快照共享可变对象。
 *
 * 注意反过来的方向：**该进快照的字段必须在本事务内就落到行上**。
 * 反例（实测过）：生成型特征的 `toolShape` 原来在 `commit()` 返回之后才写 ——
 * 那时 after 快照已经拍完，撤销后重做会把「没有 toolShape」的行装回来，
 * 阵列/镜像的源列表随即变空（几何没坏，用户看到的是功能坏了）。
 */
export function createCommandStack({ read, write, limit = MAX_UNDO, onChange } = {}) {
  if (typeof read !== "function" || typeof write !== "function") {
    throw new Error("createCommandStack 需要 read/write 两个回调");
  }
  const undoStack = [];
  const redoStack = [];
  let depth = 0;

  const freeze = (state) => ({
    hist: state.history,
    hIndex: state.hIndex,
    rows: state.history.map((row) => ({ ...row })),
  });
  const thaw = (snap) => ({ history: snap.rows.map((row) => ({ ...row })), hIndex: snap.hIndex });
  const changed = (before, after) => before.hist !== after.hist || before.hIndex !== after.hIndex;
  const apply = (snap) => { write(thaw(snap)); };
  // 栈深度变化后通知调用方（按钮 disabled 之类必须跟栈同步；漏了就会出现
  // 「栈里有命令但撤销按钮是灰的」或反过来）
  const notify = () => { try { onChange?.(); } catch (_) {} };

  return {
    /** 包一个用户动作：成功且真的改了才压栈；失败无条件还原到动作前（含预览态） */
    run(label, fn) {
      if (depth > 0) {
        depth++;
        try { return fn(); } finally { depth--; }
      }
      const before = freeze(read());
      depth++;
      let out;
      try {
        out = fn();
      } catch (err) {
        depth--;
        // 无条件写回：失败动作可能已经把候选几何挂到界面上（👁 预览）却没改历史，
        // 那时引用比较看不出变化，但屏幕已经不是「已提交画面」了。
        try { apply(before); } catch (_) {}
        throw err;
      }
      depth--;
      const after = freeze(read());
      if (changed(before, after)) {
        undoStack.push({ label: String(label || "操作"), before, after });
        if (undoStack.length > limit) undoStack.shift();
        redoStack.length = 0;
        notify();
      }
      return out;
    },

    /** 撤销最近一条命令；没有命令时返回 null（调用方退回历史步进） */
    undo() {
      const tx = undoStack.pop();
      if (!tx) return null;
      // 先搬栈再装文档：write 回调会重画 UI（撤销/重做按钮的 disabled 就在里面读深度），
      // 顺序反了按钮状态会慢一拍。
      redoStack.push(tx);
      apply(tx.before);
      notify();
      return tx.label;
    },

    /** 重做最近一条被撤销的命令；没有时返回 null */
    redo() {
      const tx = redoStack.pop();
      if (!tx) return null;
      undoStack.push(tx);
      apply(tx.after);
      notify();
      return tx.label;
    },

    /** 文档边界（新建 / 打开 / 导入）调用：跨文档绝不撤销 */
    clear() { undoStack.length = 0; redoStack.length = 0; notify(); },

    get undoDepth() { return undoStack.length; },
    get redoDepth() { return redoStack.length; },
    get undoLabel() { return undoStack.at(-1)?.label ?? null; },
    get redoLabel() { return redoStack.at(-1)?.label ?? null; },
    get busy() { return depth > 0; },
  };
}
