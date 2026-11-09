/**
 * 触控笔悬停虚拟光标（pen hover cursor）
 *
 * 为什么需要：电磁笔（Xiaomi Smart Pen 等）**悬停**在屏幕上方、笔尖还没落下时，
 * Chromium 会派发 pointerType === "pen" 且 buttons === 0 的 pointermove。
 * 那一刻屏幕上没有任何位置指示，用户不知道"落笔会画到哪儿"。
 *
 * 本模块只做一件事：笔悬停时画一个跟随笔尖的光标（圆环 + 十字 + 中心点）。
 *
 * 边界（都是刻意为之）：
 * - 只认 `pointerType === "pen"`：手指拖动绝不出现光标；鼠标保持浏览器原生指针，
 *   不重复画一个假光标。
 * - 落笔（buttons !== 0）立即隐藏，不遮挡落点、不参与绘制判断。
 * - 笔离开屏幕（pointerout 且 relatedTarget 为空）隐藏；另有 1.5s 无事件兜底
 *   （安卓上 HOVER_EXIT 不一定转成 DOM 事件）。
 * - position:fixed + translate3d + pointer-events:none：不参与命中测试、不触发重排，
 *   每帧最多写一次 transform（rAF 合并高频 move）。
 *
 * 真机自检：远程调试里执行 `window.__padcad.penCursor.stats()`
 *   - `hover` 一直为 0 ⇒ 系统没有把笔的悬停派发给 WebView（设备/笔不支持，
 *     或 WebView 拦截了 ACTION_HOVER_MOVE）；此时纯前端无解，需要原生层转发。
 *   - `hover` 在涨但屏幕没光标 ⇒ 是本模块的样式/层级问题。
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** 光标尺寸（CSS px），必须与 style.css 里 #penCursor 的尺寸一致 */
const SIZE = 34;
const HIDE_AFTER_MS = 1500;

function buildCursorEl() {
  const el = document.createElement("div");
  el.id = "penCursor";
  el.setAttribute("aria-hidden", "true");

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${SIZE} ${SIZE}`);
  svg.setAttribute("width", String(SIZE));
  svg.setAttribute("height", String(SIZE));

  const c = SIZE / 2;

  // 圆环：给一个"落点范围"的观感，接近 CAD 的捕捉圈
  const ring = document.createElementNS(SVG_NS, "circle");
  ring.setAttribute("class", "penCursorRing");
  ring.setAttribute("cx", String(c));
  ring.setAttribute("cy", String(c));
  ring.setAttribute("r", "8.5");

  // 十字：四段短线，留出中心空隙，避免遮挡细小图元
  const cross = document.createElementNS(SVG_NS, "path");
  cross.setAttribute("class", "penCursorCross");
  // 四段短线：从边缘 inner 到 gap 处停止，中心留空不遮图元
  const outer = 2.6;
  const inner = c - 4.2;
  const len = inner - outer;
  cross.setAttribute(
    "d",
    `M${c} ${outer}v${len}M${c} ${c + 4.2}v${len}` +
      `M${outer} ${c}h${len}M${c + 4.2} ${c}h${len}`
  );

  // 中心点：真正的"笔尖位置"
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("class", "penCursorDot");
  dot.setAttribute("cx", String(c));
  dot.setAttribute("cy", String(c));
  dot.setAttribute("r", "1.7");

  svg.appendChild(ring);
  svg.appendChild(cross);
  svg.appendChild(dot);
  el.appendChild(svg);
  return el;
}

/**
 * 安装悬停光标。重复调用是幂等的（返回同一个实例）。
 * @returns {{show:Function,hide:Function,stats:Function,destroy:Function,el:HTMLElement}|null}
 */
export function installPenCursor() {
  if (typeof document === "undefined" || typeof window === "undefined") return null;

  const existing = window.__penCursor;
  if (existing) return existing;
  if (document.getElementById("penCursor")) return null;

  const el = buildCursorEl();
  document.body.appendChild(el);

  const stats = { hover: 0, down: 0, up: 0, exit: 0, touchMoves: 0, lastPointerType: "" };
  let visible = false;
  let hideTimer = 0;
  let raf = 0;
  let pending = null;

  const flush = () => {
    raf = 0;
    if (!pending) return;
    const [x, y] = pending;
    pending = null;
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };

  const place = (x, y) => {
    pending = [x, y];
    if (!raf) raf = requestAnimationFrame(flush);
  };

  const show = () => {
    if (visible) return;
    visible = true;
    el.classList.add("on");
  };

  const hide = () => {
    clearTimeout(hideTimer);
    hideTimer = 0;
    if (!visible) return;
    visible = false;
    el.classList.remove("on");
  };

  const bump = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_AFTER_MS);
  };

  /**
   * 悬停判定：未落笔（buttons === 0）且不是手指、不是鼠标。
   * 不写死 pointerType === "pen" 是因为有设备的笔上报类型为空
   * （项目里 isPrecisionPointer 同样把空值当精细输入）；
   * 而手指触摸必然 buttons === 1，鼠标已有浏览器原生指针，都不该画这个光标。
   */
  const isHovering = (e) =>
    e.buttons === 0 && e.pointerType !== "touch" && e.pointerType !== "mouse";

  const onMove = (e) => {
    stats.lastPointerType = e.pointerType || "";
    if (e.pointerType === "touch") stats.touchMoves++;
    if (!isHovering(e)) {
      // 手指/鼠标：不插手；笔已落笔：把位置交给真正的绘制反馈
      if (e.pointerType === "pen") hide();
      return;
    }
    stats.hover++;
    place(e.clientX, e.clientY);
    show();
    bump();
  };

  const onDown = (e) => {
    if (e.pointerType !== "pen") return;
    stats.down++;
    hide();
  };

  const onUp = (e) => {
    if (e.pointerType !== "pen") return;
    stats.up++;
    // 抬起后不主动显示：笔可能已经离开屏幕。
    // 还在屏幕上悬停的话，紧随其后的 hover move 会立刻把光标带回。
  };

  /** 笔真正离开屏幕：pointerout 且没有进入任何新目标 */
  const onOut = (e) => {
    if (e.pointerType !== "pen") return;
    if (e.relatedTarget) return; // 只是从一个元素移到另一个，不是离开屏幕
    stats.exit++;
    hide();
  };

  const opts = { capture: true, passive: true };
  window.addEventListener("pointermove", onMove, opts);
  window.addEventListener("pointerdown", onDown, opts);
  window.addEventListener("pointerup", onUp, opts);
  window.addEventListener("pointercancel", onUp, opts);
  document.addEventListener("pointerout", onOut, opts);

  const api = {
    el,
    show,
    hide,
    stats: () => ({ ...stats, visible }),
    /** 手动清理（测试用；正常不会调） */
    destroy() {
      hide();
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove, opts);
      window.removeEventListener("pointerdown", onDown, opts);
      window.removeEventListener("pointerup", onUp, opts);
      window.removeEventListener("pointercancel", onUp, opts);
      document.removeEventListener("pointerout", onOut, opts);
      el.remove();
      delete window.__penCursor;
    },
  };

  window.__penCursor = api;
  return api;
}
