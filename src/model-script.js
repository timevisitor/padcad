/**
 * 建模脚本（PadCAD Model Script）—— AI / 批量建模的入口
 *
 * 借鉴 Yi3D（Apache-2.0）的 AI-Assisted Modeling：
 *   自然语言 → 生成建模脚本 → 交给内核执行 → **读回结果做几何校验** → 迭代重试。
 * Yi3D 走的是 Python + TCP/IPC（它带了个 Python 绑定），PadCAD 是纯网页/WebView，
 * 所以这里把「脚本」定义成**纯数据 JSON**：不含任何 wasm 引用，能存文件、能进参数化重放。
 *
 * 它和 .padcad.json 工程文件的区别：
 *   工程文件记的是「交互操作」（点哪个面、选了哪条边，带 faceRef/edgeRef 快照）；
 *   脚本写的是**几何意图**（在 [0,0,20] 附近、法向 +Z 的那个面；法向 +Z 的所有竖直边），
 *   每次重放都重新按几何解析 —— 上游改了尺寸，脚本里的选择照样跟得上。
 *
 * 三条硬规则（都是从 Yi3D 的 SKILL.md 抄来的纪律，值得照做）：
 *   1. 参数集中写在开头，用 $名字 引用，别把魔法数字散在步骤里。
 *   2. **脚本跑成功 ≠ 几何正确** —— 每步可以写 expect（体积/包围盒/面数），
 *      对不上就报出来；默认 strict：对不上直接中止且不动当前文档。
 *   3. 选择器命中多个候选时**明确报错**，绝不猜一个给你（静默用错的面比报错危险得多）。
 */
import * as OPS from "./ops.js";
import { replayOp, RefLost } from "./replay.js";

export const SCRIPT_VERSION = 1;

const DEG = Math.PI / 180;
/** 表达式里可用的常量与函数（都要带 $ 前缀调用：$PI、$sqrt($a*$b)） */
const CONSTS = { PI: Math.PI, E: Math.E };
const FUNCS = {
  sqrt: (a) => Math.sqrt(a),
  abs: (a) => Math.abs(a),
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
};
const num = (v, name) => {
  const x = Number(v);
  if (!Number.isFinite(x)) throw new Error(`${name} 必须是数字（收到 ${JSON.stringify(v)}）`);
  return x;
};
const vec3 = (v, name) => {
  if (!Array.isArray(v) || v.length !== 3) throw new Error(`${name} 必须是 [x,y,z]`);
  return v.map((k) => num(k, name));
};
const unit = (v, name) => {
  const a = vec3(v, name);
  const L = Math.hypot(a[0], a[1], a[2]);
  if (L < 1e-9) throw new Error(`${name} 不能是零向量`);
  return a.map((k) => k / L);
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const fmt = (p) => `[${p.map((v) => (+v).toFixed(2)).join(", ")}]`;

// ------------------------------------------------------------------ 参数表达式
/**
 * 参数表达式求值。
 * 支持：+ - * / ^ ( )、一元正负、$参数名（参数值本身也可以再是表达式）、
 *       常量 $PI / $E、函数 $sqrt / $abs / $min / $max。
 * 规则：**字符串以 $ 开头就当表达式**（"$L*2-3"、"$sqrt($a^2+$b^2)"、"$PI*$R^2*$H"）；
 * 写纯数字就原样用；想在文字里写一个字面量的 $，写成 "$$"。
 */
export function evalFormula(text, params = {}, stack = []) {
  const s = String(text);
  let i = 0;
  const skip = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const fail = (msg) => { throw new Error(`表达式「${s}」${msg}`); };
  function expr() {
    let v = term();
    for (;;) {
      skip();
      const c = s[i];
      if (c === "+" || c === "-") { i++; const r = term(); v = c === "+" ? v + r : v - r; } else return v;
    }
  }
  function term() {
    let v = power();
    for (;;) {
      skip();
      const c = s[i];
      if (c === "*" || c === "/") {
        i++;
        const r = power();
        if (c === "/") {
          if (Math.abs(r) < 1e-12) fail("里除以了 0");
          v /= r;
        } else v *= r;
      } else return v;
    }
  }
  /** 幂：右结合，优先级高于 * /（$R^2 这种写法建模时天天用） */
  function power() {
    const base = factor();
    skip();
    if (s[i] === "^") {
      i++;
      const e = power();
      const v = base ** e;
      if (!Number.isFinite(v)) fail("幂运算结果不是有限数");
      return v;
    }
    return base;
  }
  function factor() {
    skip();
    const c = s[i];
    if (c === "-") { i++; return -factor(); }
    if (c === "+") { i++; return factor(); }
    if (c === "(") { i++; const v = expr(); skip(); if (s[i] !== ")") fail(`第 ${i + 1} 个字符处少了右括号`); i++; return v; }
    if (c === "$") {
      i++;
      const m = /^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*/.exec(s.slice(i));
      if (!m) fail("$ 后面要跟参数名或函数名");
      i += m[0].length;
      const name = m[0];
      skip();
      if (s[i] === "(") {                       // $sqrt(...) / $min(...) 这类函数调用
        const fn = FUNCS[name];
        if (!fn) fail(`没有函数 $${name}（可用：${Object.keys(FUNCS).map((k) => "$" + k).join(" / ")}）`);
        i++;
        const args = [];
        skip();
        if (s[i] === ")") i++;
        else {
          for (;;) {
            args.push(expr());
            skip();
            if (s[i] === ",") { i++; continue; }
            if (s[i] === ")") { i++; break; }
            fail(`$${name}(...) 的参数里少了 , 或 )`);
          }
        }
        return num(fn(...args), `$${name}(...)`);
      }
      if (name in params) {
        if (stack.includes(name)) throw new Error(`参数「${name}」自己引用了自己：${[...stack, name].join(" → ")}`);
        const raw = params[name];
        return (typeof raw === "string" && raw.trim().startsWith("$")) ? evalFormula(raw, params, [...stack, name]) : num(raw, `参数「${name}」`);
      }
      if (name in CONSTS) return CONSTS[name];
      throw new Error(`参数「${name}」没有定义（params 里只有：${Object.keys(params).join("、") || "空"}；另有常量 $PI、$E）`);
    }
    const m = /^\d+(\.\d+)?([eE][-+]?\d+)?/.exec(s.slice(i));
    if (!m) fail(`第 ${i + 1} 个字符处看不懂（只能是数字、$参数、( ) + - * /）`);
    i += m[0].length;
    return parseFloat(m[0]);
  }
  const v = expr();
  skip();
  if (i !== s.length) fail(`有多余的字符：${s.slice(i)}`);
  if (!Number.isFinite(v)) fail("算出来不是有限数");
  return v;
}

/** 递归把对象/数组里以 $ 开头的字符串当表达式求值 */
export function resolveParams(value, params = {}, stack = []) {
  if (typeof value === "string") {
    if (value.startsWith("$$")) return value.slice(1);          // "$$L" → 字面量 "$L"
    if (value.startsWith("$")) return evalFormula(value, params, stack);   // 明确是表达式，写错就报错
    /*
     * 其它字符串：长成算式的（以数字/符号开头且含数字或 $）就当算式求值，
     * 求不出来就原样保留 —— 这样 "box"、"XY"、"凸台-拉伸" 这类名字不受影响，
     * 而 [ "-($T+20)/2", 0, 0 ] 这种直接写在坐标里的算式也能算。
     */
    if (/^[-+(\s\d]/.test(value) && /[\d$]/.test(value)) {
      try { return evalFormula(value, params, stack); } catch (_) { return value; }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveParams(v, params, stack));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveParams(v, params, stack);
    return out;
  }
  return value;
}

// ------------------------------------------------------------------ 几何选择器
// 实现放在 selectors.js（重放引擎也要用，放这里会循环 import）。
// 面：{at:[x,y,z], normal:[0,0,1], type:"PLANE"} → faceId
// 边：{at:[x,y,z], dir:[0,0,1], of:{...}, closed:true, all:false} → [边中点]
export { resolveFaceSelector, resolveEdgesSelector, describeFace } from "./selectors.js";

// ------------------------------------------------------------------ 脚本 → 步骤
const NAME = {
  base: "起始零件", primitive: "形体", helix: "螺旋", extrude: "拉伸", revolve: "旋转",
  sweep: "扫掠", loft: "放样", pushpull: "推拉", pushface: "推拉", fillet: "圆角",
  chamfer: "倒角", shell: "抽壳", pattern: "阵列", mirror: "镜像", move3d: "移动",
};

/** 步骤的默认描述（特征树/报告里显示） */
export function opDetail(op = {}) {
  switch (op.type) {
    case "primitive": {
      switch (op.shape) {
        case "box": return `${(op.size || []).join("×")} @ ${fmt(op.at || [0, 0, 0])}`;
        case "cylinder": return `Ø${(+op.r * 2).toFixed(2)}×${op.h} @ ${fmt(op.at || [0, 0, 0])}`;
        case "sphere": return `R${op.r} @ ${fmt(op.at || [0, 0, 0])}`;
        case "cone": return `R${op.r1}→${op.r2 ?? 0} 高${op.h}`;
        case "torus": return `R${op.R}/r${op.r}`;
        default: return op.shape || "";
      }
    }
    case "helix": return `R${op.R} 钢丝Ø${(op.wireR * 2).toFixed(2)} 螺距${op.pitch} ${op.turns}圈`;
    case "extrude": return `${op.depth > 0 ? "+" : ""}${op.depth}mm`;
    case "revolve": return `${op.angle ?? 360}°`;
    case "fillet":
    case "chamfer": return `R${op.radius}`;
    case "shell": return `壁厚 ${op.thickness}`;
    case "pushpull":
    case "pushface": return `${op.dist > 0 ? "+" : ""}${op.dist}mm`;
    default: return op.label || op.type;
  }
}

/**
 * 校验脚本（不改模型、不碰内核）：语法、版本、每步的 op.type。
 * @returns {name, strict, params, steps:[{index,label,detail,op,expect}]}
 */
export function normalizeScript(script) {
  if (!script || typeof script !== "object" || Array.isArray(script)) throw new Error("脚本必须是一个 JSON 对象");
  const v = Number(script.v ?? SCRIPT_VERSION);
  if (v !== SCRIPT_VERSION) throw new Error(`脚本版本 ${v} 不受支持（当前 PadCAD 支持 v${SCRIPT_VERSION}）`);
  const params = script.params && typeof script.params === "object" ? { ...script.params } : {};
  const raw = script.steps;
  if (!Array.isArray(raw) || !raw.length) throw new Error("脚本里没有任何步骤（steps 不能是空数组）");
  const steps = raw.map((s, i) => {
    const src = s && typeof s === "object" && s.op ? s : { op: s };
    const op = resolveParams(src.op, params, []);
    if (!op || typeof op !== "object" || !op.type) throw new Error(`第 ${i + 1} 步缺少 op.type`);
    return {
      index: i,
      label: src.label ? String(resolveParams(src.label, params, [])) : (NAME[op.type] || op.type),
      detail: src.detail ? String(resolveParams(src.detail, params, [])) : opDetail(op),
      op,
      expect: src.expect ? resolveParams(src.expect, params, []) : null,
    };
  });
  return { name: String(script.name || ""), strict: script.strict !== false, params, steps };
}

function bboxOf(shape) {
  if (!shape) return null;
  try { const b = shape.boundingBox; return [+b.width.toFixed(6), +b.height.toFixed(6), +b.depth.toFixed(6)]; }
  catch (_) { return null; }
}

/** 一步的几何校验：体积（相对容差，默认 0.1%）、包围盒（每轴默认 0.1mm）、面数（精确） */
export function checkGeometry(expect = {}, actual = {}) {
  const items = [];
  if (expect.volume != null) {
    const want = num(expect.volume, "expect.volume");
    const tol = expect.tol != null ? num(expect.tol, "expect.tol") : 1e-3;
    const got = actual.volume;
    const ok = Number.isFinite(got) && Math.abs(got - want) <= Math.max(Math.abs(want) * tol, 1e-6);
    items.push({ name: "体积", ok, got: +got?.toFixed(4), want, tol: `±${(tol * 100).toFixed(3)}%` });
  }
  if (expect.bbox != null) {
    const want = vec3(expect.bbox, "expect.bbox");
    const tol = expect.bboxTol != null ? num(expect.bboxTol, "expect.bboxTol") : 0.1;
    const got = actual.bbox || [];
    want.forEach((w, i) => items.push({
      name: `包围盒${["宽", "高", "深"][i]}`, ok: Math.abs((got[i] ?? NaN) - w) <= tol, got: got[i], want: w, tol: `±${tol}`,
    }));
  }
  if (expect.faces != null) {
    const want = num(expect.faces, "expect.faces");
    items.push({ name: "面数", ok: actual.faces === want, got: actual.faces, want });
  }
  return { ok: items.every((i) => i.ok), items };
}

/**
 * 跑一份脚本。**在调用方给出的实体上逐步重放**，任何失败都不改动调用方的东西
 * （返回 shape=null 表示「不要替换当前模型」）。
 *
 * @param script  脚本对象（可用工程里的 features 也行，见 scriptFromHistory）
 * @param shape   起始实体（null = 从零开始；追加模式传当前实体）
 * @returns {ok, report, shape, failed, name, strict}
 */
export function runModelScript(script, { shape = null, now = () => performance.now() } = {}) {
  const norm = normalizeScript(script);
  const tools = [];
  const report = [];
  let cur = shape;
  let failed = null;

  for (const st of norm.steps) {
    const t0 = now();
    const ctx = { tools, index: st.index, tool: null };
    let next;
    try {
      next = replayOp(cur, st.op, ctx);
    } catch (e) {
      failed = { index: st.index, label: st.label, message: e?.message || String(e), refLost: e instanceof RefLost, step: e?.stepIndex };
      report.push({
        index: st.index, label: st.label, detail: st.detail, op: st.op,
        ok: false, ms: +(now() - t0).toFixed(2), error: failed.message, refLost: failed.refLost,
      });
      break;
    }
    cur = next;
    tools[st.index] = ctx.tool || null;
    const volume = OPS.volumeOf(cur);
    const bbox = bboxOf(cur);
    const faces = cur?.faces?.length ?? 0;
    const check = st.expect ? checkGeometry(st.expect, { volume, bbox, faces }) : null;
    const entry = {
      index: st.index, label: st.label, detail: st.detail, op: st.op, ok: true,
      ms: +(now() - t0).toFixed(2), volume: +volume.toFixed(6), bbox, faces,
      shape: cur, tool: ctx.tool || null, check,
    };
    report.push(entry);
    if (check && !check.ok && norm.strict) {
      failed = {
        index: st.index, label: st.label, verify: true,
        message: check.items.filter((i) => !i.ok)
          .map((i) => `${i.name} 实测 ${i.got}，期望 ${i.want}${i.tol ? `（${i.tol}）` : ""}`).join("；"),
      };
      entry.aborted = true;
      break;
    }
  }

  return {
    ok: !failed, failed, report, name: norm.name, strict: norm.strict,
    shape: failed ? null : cur,
  };
}

/**
 * 把当前工程导出成脚本（**不保证**所有交互操作都能优雅表达 ——
 * faceRef/edgeRef 是当时点选的快照，脚本里会原样保留，重放依然是按几何找回，
 * 所以它能原样重建；只是可读性不如手写的选择器版本）。
 */
export function scriptFromHistory(history, name = "导出脚本") {
  const steps = (history || [])
    .filter((h) => h?.op && !h.suppressed)
    .map((h) => ({ label: h.customName || h.label || h.op.type, detail: h.detail || opDetail(h.op), op: h.op }));
  return { v: SCRIPT_VERSION, name, steps };
}

/** 报告摘要（给 UI / 测试用，去掉 wasm 对象） */
export function summarize(run) {
  if (!run) return null;
  const steps = run.report.map((r) => ({
    index: r.index, label: r.label, detail: r.detail, ok: r.ok,
    ms: r.ms, volume: r.volume, faces: r.faces, error: r.error || null,
    check: r.check ? { ok: r.check.ok, items: r.check.items } : null,
  }));
  const checked = steps.filter((s) => s.check).length;
  return {
    ok: !!run.ok, name: run.name, stepCount: steps.length,
    labeled: steps.map((s) => s.label),
    totalMs: +steps.reduce((a, s) => a + (s.ms || 0), 0).toFixed(2),
    volume: steps.length ? steps[steps.length - 1].volume : null,
    checked, checksPassed: steps.filter((s) => s.check?.ok).length,
    failed: run.failed || null,
    steps,
  };
}
