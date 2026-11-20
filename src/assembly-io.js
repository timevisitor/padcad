/**
 * 装配体存档 / STEP 导出 / BOM（v6 装配路 · asm）
 *
 * 存档格式（`v:1, kind:"asm"`）是纯数据 JSON，零件几何**内嵌**：
 *   - project 来源：project.js 的 v1 工程定义原样带进来，恢复时 restoreProject() 重放；
 *   - step 来源：STEP 字节 base64（别人给的一个 .step 就够用，不再依赖原文件路径）；
 *   - inline 来源：model-script.js 的脚本对象，恢复时 runModelScript() 跑一遍。
 * 这样「关闭 → 重开」不依赖任何外部文件，和主工程「存定义、打开时重建」的原则一致。
 *
 * STEP 导出：走 replicad 的 exportSTEP([{shape,name}])，它内部是 XCAF 文档 +
 * STEPCAFControl_Writer（write.step.assembly=2），所以每个实例在 STEP 里是一个
 * 独立命名实体。实测 3 实例 → readStepBytes 读回 solids=3、总体积误差 3.6e-10。
 */
import { exportSTEP } from "replicad";
import { restoreProject } from "./project.js";
import { readStepBytes } from "./step-io.js";
import { runModelScript } from "./model-script.js";
import { ASM_KIND, ASM_VERSION, addPart, createAssembly, normalizeTransform, shapeAtTransform } from "./assembly.js";

// ---------------------------------------------------------------- base64
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < arr.length; i += 3) {
    const a = arr[i], b = arr[i + 1], c = arr[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += i + 1 < arr.length ? B64[((b & 15) << 2) | ((c ?? 0) >> 6)] : "=";
    out += i + 2 < arr.length ? B64[c & 63] : "=";
  }
  return out;
}

export function base64ToBytes(text) {
  const clean = String(text || "").replace(/[^A-Za-z0-9+/=]/g, "");
  const len = clean.length;
  const bytes = new Uint8Array(Math.floor((len * 3) / 4) - (clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0));
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12)
      | ((clean[i + 2] === "=" ? 0 : B64.indexOf(clean[i + 2])) << 6)
      | (clean[i + 3] === "=" ? 0 : B64.indexOf(clean[i + 3]));
    if (p < bytes.length) bytes[p++] = (n >> 16) & 255;
    if (p < bytes.length) bytes[p++] = (n >> 8) & 255;
    if (p < bytes.length) bytes[p++] = n & 255;
  }
  return bytes;
}

// ---------------------------------------------------------------- 存档
export function partSourceFromProject(project) {
  return { kind: "project", project: JSON.parse(JSON.stringify(project)) };
}

export function partSourceFromStepBytes(bytes) {
  return { kind: "step", data: bytesToBase64(bytes) };
}

export function partSourceFromScript(script) {
  return { kind: "inline", script: JSON.parse(JSON.stringify(script)) };
}

const pickTransform = (tr) => {
  const t = normalizeTransform(tr);
  return { t: [...t.t], r: [...t.r] };
};

/** asm → 可存档的纯数据（深拷贝，不共享引用） */
export function assemblyDefinition(asm) {
  return {
    v: ASM_VERSION,
    kind: ASM_KIND,
    name: asm.name,
    unit: asm.unit || "mm",
    savedAt: new Date().toISOString(),
    parts: asm.parts.map((p) => ({ id: p.id, name: p.name, source: JSON.parse(JSON.stringify(p.source)) })),
    instances: asm.instances.map((i) => ({
      id: i.id, partId: i.partId, name: i.name,
      transform: pickTransform(i.transform),
      fixed: !!i.fixed, color: i.color || null, visible: i.visible !== false,
    })),
    mates: asm.mates.map((m) => ({
      id: m.id, type: m.type,
      a: { inst: m.a.inst, ref: m.a.ref ? JSON.parse(JSON.stringify(m.a.ref)) : null },
      b: { inst: m.b.inst, ref: m.b.ref ? JSON.parse(JSON.stringify(m.b.ref)) : null },
      value: m.value, flip: !!m.flip, suppressed: !!m.suppressed,
      ...(m.label ? { label: m.label } : {}),
      ...(m.rel ? { rel: JSON.parse(JSON.stringify(m.rel)) } : {}),
    })),
    explode: (asm.explode || []).map((s) => ({
      id: s.id, instance: s.instance, dir: [...s.dir], distance: s.distance,
      ...(s.label ? { label: s.label } : {}),
    })),
  };
}

export function serializeAssembly(asm) {
  return JSON.stringify(assemblyDefinition(asm), null, 2);
}

/**
 * 存档 → { assembly, partShapes: Map<partId, shape>, projects: Map<partId, 重放结果>, warnings }
 * 每个零件只重建一次几何，所有实例共享。
 */
export function restoreAssembly(def) {
  if (!def || def.v !== ASM_VERSION) throw new Error("装配体格式无效或版本不受支持");
  if (def.kind && def.kind !== ASM_KIND) throw new Error(`不是装配体文件（kind=${def.kind}）`);
  if (!Array.isArray(def.parts) || !def.parts.length) throw new Error("装配体里没有任何零件");
  if (!Array.isArray(def.instances) || !def.instances.length) throw new Error("装配体里没有任何实例");

  const asm = createAssembly(def.name || "装配体");
  const partShapes = new Map();
  const projects = new Map();
  const warnings = [];

  for (const p of def.parts) {
    const src = p.source;
    if (!src || !src.kind) throw new Error(`零件「${p.name}」缺少几何来源`);
    let shape = null;
    if (src.kind === "project") {
      const restored = restoreProject(src.project);
      shape = restored.shape;
      projects.set(p.id, restored);
    } else if (src.kind === "step") {
      const bytes = base64ToBytes(src.data);
      const r = readStepBytes(bytes, { name: p.name || "零件.step" });
      shape = r.shape;
      for (const w of r.warnings) warnings.push(`${p.name}：${w}`);
    } else if (src.kind === "inline") {
      const run = runModelScript(src.script);
      if (!run.ok || !run.shape) throw new Error(`零件「${p.name}」的脚本执行失败：${run.failed || "未知错误"}`);
      shape = run.shape;
    } else {
      throw new Error(`零件「${p.name}」的来源类型 ${src.kind} 不支持`);
    }
    if (!shape) throw new Error(`零件「${p.name}」重建后没有几何`);
    partShapes.set(p.id, shape);
    addPart(asm, { id: p.id, name: p.name, source: JSON.parse(JSON.stringify(src)) });
  }

  for (const i of def.instances) {
    if (!asm.parts.some((p) => p.id === i.partId)) throw new Error(`实例「${i.name}」引用的零件不存在`);
    asm.instances.push({
      id: i.id, partId: i.partId, name: i.name,
      transform: normalizeTransform(i.transform),
      fixed: !!i.fixed, color: i.color || null, visible: i.visible !== false,
    });
  }
  asm.mates = (def.mates || []).map((m) => JSON.parse(JSON.stringify(m)));
  asm.explode = (def.explode || []).map((s) => JSON.parse(JSON.stringify(s)));

  return { assembly: asm, partShapes, projects, warnings };
}

export function restoreAssemblyJSON(text) {
  let def;
  try { def = JSON.parse(text); } catch (e) { throw new Error(`装配体文件不是合法 JSON：${e.message}`); }
  return restoreAssembly(def);
}

// ---------------------------------------------------------------- STEP / BOM
/** 每个实例的名字在 STEP 里必须唯一（同名会让 XCAF 里两个 label 撞名字） */
export function instanceNames(asm) {
  const used = new Map();
  return asm.instances.map((inst, idx) => {
    const base = inst.name || `实例${idx + 1}`;
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}

/**
 * 装配体 → STEP Blob（每个实例一个命名实体）。
 * shapes: Map<partId, shape>（restoreAssembly 的 partShapes）或 {partId: shape}
 */
export function exportAssemblySTEP(asm, partShapes) {
  const names = instanceNames(asm);
  const items = asm.instances.map((inst, idx) => {
    const base = partShapes instanceof Map ? partShapes.get(inst.partId) : partShapes?.[inst.partId];
    if (!base) throw new Error(`零件 ${inst.partId} 的几何没加载`);
    return { shape: shapeAtTransform(base, inst.transform), name: names[idx] };
  });
  return exportSTEP(items);
}

/** BOM：零件名 / 数量 / 用到的实例名（SolidWorks 的 BOM 最小版） */
export function assemblyBOM(asm) {
  const rows = [];
  for (const part of asm.parts) {
    const insts = asm.instances.filter((i) => i.partId === part.id);
    if (!insts.length) continue;
    rows.push({
      partId: part.id,
      partName: part.name,
      qty: insts.length,
      source: part.source.kind,
      instances: insts.map((i) => i.name),
      fixed: insts.filter((i) => i.fixed).length,
    });
  }
  return rows;
}

/** BOM 的纯文本（导出 CSV/贴给采购） */
export function bomText(asm) {
  const rows = assemblyBOM(asm);
  const total = rows.reduce((s, r) => s + r.qty, 0);
  return [
    `装配体：${asm.name}`,
    "零件\t数量\t来源\t实例",
    ...rows.map((r) => `${r.partName}\t${r.qty}\t${r.source}\t${r.instances.join(" / ")}`),
    `合计\t${total}`,
  ].join("\n");
}
