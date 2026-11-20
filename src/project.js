// Project definitions are plain data; geometry is rebuilt before replacing a document.
import { rebuild } from "./replay.js";
import { markSnapshot } from "./history-cache.js";

export const cloneData = (value) => JSON.parse(JSON.stringify(value));

export function projectDefinition(name, history, hIndex, refGeoms = [], rgSeq = {}) {
  return cloneData({
    v: 1, name, savedAt: new Date().toISOString(), featureCount: history.length,
    hIndex, refGeoms, rgSeq,
    features: history.map((h) => ({
      label: h.label, detail: h.detail, icon: h.icon,
      customName: h.customName || null, suppressed: !!h.suppressed, op: h.op || null,
    })),
  });
}

export function cacheRebuild(history, result) {
  // fromStep 之前的快照是「复用」来的：定义没变、标记照旧有效，不必重算 JSON 指纹。
  const from = result.fromStep || 0;
  for (const snapshot of result.snapshots) {
    const row = history[snapshot.index];
    row.shape = snapshot.shape;
    row.toolShape = result.tools[snapshot.index] || null;
    if (snapshot.index >= from) markSnapshot(row);
  }
}

export function restoreProject(project) {
  if (!project || project.v !== 1 || !Array.isArray(project.features) || !project.features.length) {
    throw new Error("工程格式无效或版本不受支持");
  }
  const p = cloneData(project);
  const history = p.features.map((f) => ({
    label: f.label || "特征", detail: f.detail || "", icon: f.icon || "▪",
    customName: f.customName || null, suppressed: !!f.suppressed,
    op: f.op || null, shape: null,
  }));
  // Rebuild the redo branch too, so opening a saved rollback position preserves redo.
  const result = rebuild(history, history.length - 1);
  cacheRebuild(history, result);
  const hIndex = Number.isInteger(p.hIndex) && p.hIndex >= 0 && p.hIndex < history.length
    ? p.hIndex : history.length - 1;
  return {
    history, hIndex, shape: history[hIndex].shape,
    refGeoms: Array.isArray(p.refGeoms) ? p.refGeoms : [],
    rgSeq: { plane: 0, axis: 0, point: 0, csys: 0, ...p.rgSeq },
  };
}

export function withoutFeature(history, index) {
  if (index === 0 && history.length > 1) throw new Error("后续特征依赖起始零件");
  return history.filter((_, i) => i !== index).map((h) => {
    if (h.op?.type !== "pattern" && h.op?.type !== "mirror") return { ...h };
    if (h.op.source === index) throw new Error("阵列或镜像仍引用这个特征");
    return { ...h, op: { ...h.op, source: h.op.source > index ? h.op.source - 1 : h.op.source } };
  });
}

export function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
