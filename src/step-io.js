/**
 * STEP 读取 —— 稳健版（2026-11-08，对标 Materializr src/io/StepIO.cpp）
 *
 * 为什么不再直接用 replicad.importSTEP：
 *  1. 它判 `if (reader.ReadFile(...))`，而这个 wasm 绑定里 ReadFile 返回的是**字符串**
 *     "IFSelect_RetFail"（实测），永远为真 → 坏文件不报"读不了"，而是在 OneShape 处
 *     抛出 "This shape has not type, it is null" 这种让人看不懂的错。
 *  2. 文件名用 uniqueId()，不带扩展名，失败后不清理；本模块统一写 /padcad-import-N.stp 并 finally 删除。
 *  3. 只返回 OneShape()：多根/装配体会被包成 Compound，面片 STEP 会给出无体积的壳，
 *     下游"体积""推拉"都会出怪数。这里按 Materializr 的分层兜底：
 *     实体 → 壳（尝试缝合成实体）→ 面 → 原样，逐层降级，并把"降级到哪一层"告诉调用方。
 *  4. UTF-8 BOM / 前导空白：部分国产软件导出的 STEP 带 BOM，OCCT 解析器会在第 1 行报语法错。
 *
 * 只依赖 replicad 的 getOC/cast/downcast，纯函数，Node 与浏览器都能跑（回归测试直接 import）。
 */
import { getOC, cast, downcast, measureVolume } from "replicad";

let seq = 0;
const alive = [];
function keep(...o) { alive.push(...o); if (alive.length > 256) alive.splice(0, alive.length - 256); }

const STATUS_TEXT = {
  IFSelect_RetVoid: "文件是空的或没有可读实体",
  IFSelect_RetError: "文件内容有语法错误（不是标准 STEP / 被截断）",
  IFSelect_RetFail: "解析失败（不是 STEP 文件，或文件已损坏）",
  IFSelect_RetStop: "读取被中止",
};

function statusName(oc, st) {
  if (typeof st === "string") return st;
  const e = oc.IFSelect_ReturnStatus || {};
  for (const k of Object.keys(e)) if (e[k] === st || e[k]?.value === st?.value) return k;
  return String(st);
}

/** 嗅探：给出"这是不是 STEP"的快速判断与人能看懂的理由（不进内核，0 成本） */
export function sniffStep(bytes) {
  const n = Math.min(bytes.length, 2048);
  let head = "";
  for (let i = 0; i < n; i++) head += String.fromCharCode(bytes[i]);
  const t = head.replace(/^\uFEFF|^\xEF\xBB\xBF/, "").trimStart();
  if (!bytes.length) return { ok: false, reason: "文件是空的（0 字节）" };
  if (t.startsWith("ISO-10303-21")) {
    const schema = (t.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i) || [])[1] || "";
    return { ok: true, schema };
  }
  if (t.startsWith("PK")) return { ok: false, reason: "这是压缩包（zip），请先解压出里面的 .step/.stp 再导入" };
  if (/^ISO-10303-28|<\?xml/i.test(t)) return { ok: false, reason: "这是 STEP-XML（ISO 10303-28），本内核只读 Part 21 文本格式；请在原软件另存为 AP214/AP242 的 .step" };
  if (/^\*\*ABAQUS|^solid\s|^\s*facet/i.test(t)) return { ok: false, reason: "看起来是 STL/网格文件，只是扩展名写成了 .step；请改回 .stl 用看图模式打开" };
  return { ok: false, reason: "文件头不是 ISO-10303-21，不是 STEP 文本文件" };
}

/** 去掉 UTF-8 BOM 与 ISO 头之前的垃圾字节（OCCT 解析器要求第一行就是 ISO-10303-21;） */
export function normalizeStepBytes(bytes) {
  let s = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) s = 3;
  while (s < bytes.length && (bytes[s] === 0x20 || bytes[s] === 0x09 || bytes[s] === 0x0d || bytes[s] === 0x0a)) s++;
  return s ? bytes.subarray(s) : bytes;
}

function collect(oc, shape, kindEnum) {
  const out = [];
  const ex = new oc.TopExp_Explorer(shape, kindEnum, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  keep(ex);
  for (; ex.More(); ex.Next()) out.push(ex.Current());
  return out;
}

function compound(oc, list) {
  const b = new oc.TopoDS_Builder();   // 这个绑定里没有 BRep_Builder（实测 not a constructor）
  const c = new oc.TopoDS_Compound();
  b.MakeCompound(c);
  for (const s of list) b.Add(c, s);
  keep(b, c);
  return c;
}

function trySewToSolid(oc, shells) {
  try {
    const sw = new oc.BRepBuilderAPI_Sewing(1e-3, true, true, true, false);
    keep(sw);
    for (const s of shells) sw.Add(s);
    sw.Perform();
    if (sw.NbFreeEdges() !== 0) return null;
    const sewn = downcast(sw.SewedShape());
    const ex = collect(oc, sewn, oc.TopAbs_ShapeEnum.TopAbs_SHELL);
    if (!ex.length) return null;
    const fix = new oc.ShapeFix_Solid();
    keep(fix);
    const solids = ex.map((sh) => downcast(fix.SolidFromShell(downcast(sh))));
    return solids.length === 1 ? solids[0] : compound(oc, solids);
  } catch (_) { return null; }
}

/**
 * 读 STEP 字节 → { shape, level, solids, shells, faces, roots, schema, warnings }
 * level: "solid" | "shell-sewn" | "shell" | "face" | "raw"
 * 失败一律抛 Error，message 是给用户看的中文原因。
 */
export function readStepBytes(input, { name = "模型.step" } = {}) {
  const oc = getOC();
  let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const sn = sniffStep(bytes);
  if (!sn.ok) throw new Error(`${name}：${sn.reason}`);
  bytes = normalizeStepBytes(bytes);
  const path = `/padcad-import-${++seq}.stp`;
  const warnings = [];
  oc.FS.writeFile(path, bytes);
  try {
    const reader = new oc.STEPControl_Reader();
    keep(reader);
    const st = statusName(oc, reader.ReadFile(path.slice(1)));
    if (st !== "IFSelect_RetDone") {
      throw new Error(`${name}：${STATUS_TEXT[st] || "读取失败"}（${st}）`);
    }
    let roots = 0;
    try { roots = reader.NbRootsForTransfer(); } catch (_) {}
    let nb = 0;
    try {
      const pr = oc.Message_ProgressRange ? new oc.Message_ProgressRange() : null;
      nb = pr ? reader.TransferRoots(pr) : reader.TransferRoots();
      if (pr) keep(pr);
    } catch (e) {
      throw new Error(`${name}：几何转换失败（文件里的曲面/拓扑内核处理不了）· ${e?.message || e}`);
    }
    if (!nb) throw new Error(`${name}：文件里没有可转换的几何（可能只有装配结构/注释/2D 图）`);
    const top = reader.OneShape();
    keep(top);
    if (!top || top.IsNull()) throw new Error(`${name}：转换结果为空`);

    const E = oc.TopAbs_ShapeEnum;
    const solids = collect(oc, top, E.TopAbs_SOLID);
    const shells = solids.length ? [] : collect(oc, top, E.TopAbs_SHELL);
    const faces = solids.length || shells.length ? [] : collect(oc, top, E.TopAbs_FACE);
    let raw, level;
    if (solids.length) { raw = solids.length === 1 ? solids[0] : compound(oc, solids); level = "solid"; }
    else if (shells.length) {
      const sewn = trySewToSolid(oc, shells);
      if (sewn) { raw = sewn; level = "shell-sewn"; warnings.push("文件里是封闭壳（不是实体），已自动缝合成实体"); }
      else { raw = shells.length === 1 ? shells[0] : compound(oc, shells); level = "shell"; warnings.push("文件里只有开口曲面（壳），不是实体：可查看/测量，不能推拉/布尔"); }
    } else if (faces.length) { raw = compound(oc, faces); level = "face"; warnings.push("文件里只有零散面，不是实体：可查看，不能做实体特征"); }
    else { raw = top; level = "raw"; warnings.push("文件里没有面（可能只有线框/点）"); }
    if (solids.length > 1) warnings.push(`文件里有 ${solids.length} 个实体（多实体/装配），已合成一个组合体导入`);

    const shape = cast(downcast(raw));
    keep(shape);
    if (!shape.faces?.length && level !== "raw") throw new Error(`${name}：没有可显示的面`);
    return { shape, level, solids: solids.length, shells: shells.length, faces: shape.faces?.length || 0,
      roots, schema: sn.schema, warnings };
  } finally {
    try { oc.FS.unlink(path); } catch (_) {}
  }
}

export async function readStepBlob(blob, opts) {
  return readStepBytes(new Uint8Array(await blob.arrayBuffer()), opts);
}

/** 安全体积：片体/面集 measureVolume 给的是无意义数 → 返回 null */
export function safeVolume(res) {
  if (res.level !== "solid" && res.level !== "shell-sewn") return null;
  try { return measureVolume(res.shape); } catch (_) { return null; }
}
