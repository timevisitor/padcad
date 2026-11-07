import { replayOp } from "./replay.js";
import { canReuseSnapshot } from "./history-cache.js";

/** A preview owns only its temporary shapes; committed history is borrowed read-only. */
export function rebuildPreview(history, target, overrides = {}) {
  if (!Number.isInteger(target) || target < 0 || target >= history.length) throw new Error("预览目标不在历史范围内");
  const changed = Object.keys(overrides).map(Number).filter(i => Number.isInteger(i) && i >= 0 && i <= target);
  let start = changed.length ? Math.min(...changed) : 0;
  const generatesTool = op => ["extrude", "revolve", "sweep", "loft", "pattern", "mirror"].includes(op?.type);
  for (let i = 0; i < start; i++) {
    const row = history[i];
    if (!canReuseSnapshot(row) || (!row.suppressed && generatesTool(row.op) && !row.toolShape)) { start = 0; break; }
  }
  const owned = new Set();
  const own = shape => { if (shape) owned.add(shape); return shape; };
  const release = keep => {
    for (const shape of owned) {
      if (shape === keep) continue;
      try { shape.delete(); } catch (_) { /* Already consumed by the kernel. */ }
      owned.delete(shape);
    }
  };
  try {
    let shape = start ? own(history[start - 1].shape?.clone()) : null;
    const tools = history.slice(0, start).map(row => row.suppressed ? null : row.toolShape || null);
    let steps = 0;
    for (let i = start; i <= target; i++) {
      if (history[i].suppressed) { tools[i] = null; continue; }
      const op = overrides[i] || history[i].op;
      if (!op) throw new Error(`第 ${i + 1} 步缺少定义`);
      const ctx = { tools, index: i, tool: null };
      try { shape = own(replayOp(shape, op, ctx)); }
      catch (error) { error.stepIndex = i; throw error; }
      finally { own(ctx.tool); }
      tools[i] = ctx.tool;
      steps++;
    }
    // Downstream operations have finished; only the displayed preview survives.
    release(shape);
    return { shape, steps, fromStep: start, dispose: () => release(null) };
  } catch (error) { release(null); throw error; }
}
