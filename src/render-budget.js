/**
 * 高分辨率平板上的 3D 帧缓冲预算。CSS UI 仍然按原生清晰度渲染，只压缩 3D 画布。
 *
 * 小米 Pad 7 Ultra（玄戒 O1 / Immortalis-G925 MP16）这类设备有两个矛盾：
 *   - 3.2K 屏 + 120Hz：满分辨率满帧率跑 PBR 着色，带宽和热量都撑不住；
 *   - GPU 本身很强（约 5.7 TFLOPS），一刀切压到很低又白白浪费画质。
 * 所以预算分两层：GPU 分级决定上限，实测帧间隔决定当前值（热降频后自动回退）。
 */

/**
 * @param budgetScale 由 RenderGovernor 给出的缩放系数，1 表示沿用基线预算。
 */
export function renderPixelRatio(width, height, deviceRatio = 1, touch = false, interacting = false, budgetScale = 1) {
  const ratio = Math.max(.5, Math.min(Number.isFinite(deviceRatio) ? deviceRatio : 1, 2));
  const pixels = Math.max(1, width) * Math.max(1, height);
  const base = touch ? (interacting ? 2_000_000 : 3_500_000) : 5_000_000;
  const budget = base * Math.max(.25, Math.min(Number.isFinite(budgetScale) ? budgetScale : 1, 4));
  return Math.min(ratio, Math.sqrt(budget / pixels));
}

/** 平板旗舰 GPU：玄戒 O1 的 Immortalis-G925 会命中 immortalis / mali-g9。 */
const HIGH_TIER = /(immortalis|mali-g(9|8)|adreno[^0-9]*(7[3-9]|8\d|9\d)|apple m\d)/i;
const MID_TIER = /(mali-g(5[7-9]|[67]\d)|adreno[^0-9]*6[2-9]|powervr)/i;

export function gpuTier(rendererName = "") {
  const name = String(rendererName || "");
  if (!name) return "unknown";
  if (HIGH_TIER.test(name)) return "high";
  if (MID_TIER.test(name)) return "mid";
  return "unknown";
}

/** WEBGL_debug_renderer_info 在部分 WebView 里被屏蔽，拿不到就返回空串走保守档。 */
export function readGpuName(gl) {
  try {
    const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
    if (!ext) return "";
    return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "");
  } catch (_) {
    return "";
  }
}

/**
 * 帧间隔驱动的渲染预算调节器。
 *
 * 只在"连续交互"期间采样：静止时是按需渲染，帧间隔本身没有意义。
 * 采用 EMA + 冷却期 + 上下不对称的步长，避免在阈值附近来回抖动
 * —— 每次改 pixelRatio 都会重新分配整块帧缓冲，在 3.2K 屏上代价很高。
 */
export class RenderGovernor {
  constructor({ tier = "unknown", targetMs = 11, panicMs = 19 } = {}) {
    // 上限按 GPU 分级：玄戒 O1 这类旗舰 GPU 允许超过基线，未知设备保守维持基线。
    this.ceiling = tier === "high" ? 2.2 : tier === "mid" ? 1.5 : 1;
    this.floor = 0.55;
    this.targetMs = targetMs;
    this.panicMs = panicMs;
    // 高端 GPU 起步乐观，省掉爬升过程；其余从基线开始，先保证跟手。
    this.scale = tier === "high" ? 1.75 : tier === "mid" ? 1.2 : 1;
    this.tier = tier;
    this._ema = 0;
    this._sinceAdjust = 0;
    this._changed = false;
  }

  /** 静止时用的预算：不低于基线，最多到分级上限（静止只渲染一帧，不怕掉帧）。 */
  get idleScale() {
    return Math.min(this.ceiling, Math.max(1, this.scale));
  }

  /** 传入两次连续渲染之间的间隔（毫秒）。非连续交互期间不要调用。 */
  sample(intervalMs) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    this._ema = this._ema ? this._ema * 0.7 + intervalMs * 0.3 : intervalMs;
    if (++this._sinceAdjust < RenderGovernor.COOLDOWN) return;
    const before = this.scale;
    if (this._ema > this.panicMs) this.scale *= 0.82;
    else if (this._ema > this.targetMs) this.scale *= 0.93;
    else if (this._ema < this.targetMs * 0.62) this.scale *= 1.07;
    if (this.scale === before) return;
    this.scale = Math.max(this.floor, Math.min(this.ceiling, this.scale));
    this._sinceAdjust = 0;
    this._changed = this._changed || this.scale !== before;
  }

  /** 交互结束后重置采样，避免把"静止时的长间隔"误判成掉帧。 */
  reset() { this._ema = 0; this._sinceAdjust = 0; }

  /** 取走一次"预算已变、需要重新 setPixelRatio"的信号。 */
  consumeChanged() {
    const changed = this._changed;
    this._changed = false;
    return changed;
  }
}

RenderGovernor.COOLDOWN = 24;
