/**
 * 平板手势层（Shapr3D 习惯）：两者都**不碰相机**，只在「快速、几乎没动」的触摸上生效。
 *
 *   · 两指轻点 = 撤销
 *   · 三指轻点 = 重做
 *   · 双击（单指，两次落点很近）= onDoubleTap（草图里用来收尾折线）
 *
 * 为什么不改 camera.js：
 *   camera.js 是触摸相机的唯一实现（单指旋转 / 双指缩放平移 / 三个拦截钩子），
 *   在里面加手势会同时影响推拉拖动与草图拖动 —— 那是几何正确性的路径。
 *   所以手势层只旁听 touchstart/move/end，**不 preventDefault、不 stopPropagation**，
 *   相机该收到的照样收到。
 *
 * 判据（防误伤两指缩放/平移）：从落指到全部离手的时长 < maxMs(250)，
 * 且每个触点的位移都 < maxMove(10 CSS px)。两指捏合/拖动一开始动就超过 10px → 不撤销。
 *
 * 笔优先：笔落下时手指触点一律不当手势（手掌压在屏上的常见情形）。
 * 这里用的是 pointerType==='pen' 的按下标记，而不是 touchType —— 后者在安卓 WebView 不可靠
 * （pen-cursor.js 里同样记录了「pointerType 可能是空字符串」这个坑，那边把空值当精细输入）。
 */

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function installTapGestures({
  target = typeof document !== "undefined" ? document.getElementById("view") : null,
  onTwoFingerTap = () => {},
  onThreeFingerTap = () => {},
  onDoubleTap = () => {},
  maxMove = 10,
  maxMs = 250,
  doubleTapMs = 320,
  doubleTapPx = 24,
  enabled = () => true,
} = {}) {
  if (!target) return { dispose() {}, stats: () => ({}) };
  const stats = { twoFinger: 0, threeFinger: 0, doubleTap: 0, rejected: 0, penBlocked: 0, palms: 0 };
  let gesture = null;          // { n, maxN, t0, ids:Map<id,{x0,y0}>, maxD, invalid }
  let single = null;           // { t0, x0, y0, moved }
  let lastTap = null;          // { t, x, y }
  let penDown = false;
  let disposed = false;

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function onPointerDown(e) {
    if (e.pointerType === "pen") penDown = true;
  }
  function onPointerUp(e) {
    if (e.pointerType === "pen") penDown = false;
  }
  function onPointerCancel() { penDown = false; }

  function startGesture(e) {
    const ids = new Map();
    let maxD = 0;
    let palms = false;
    for (const t of e.touches) {
      ids.set(t.identifier, { x0: t.clientX, y0: t.clientY });
      // 手掌：触点半径特别大的那种（安卓会给 radiusX），出手势判定
      if (t.radiusX > 60 || t.radiusY > 60) palms = true;
    }
    gesture = {
      maxN: e.touches.length,
      t0: now(),
      ids,
      maxD,
      invalid: palms || e.touches.length > 3,
    };
    if (palms) stats.palms++;
    // 多指落下时，单指双击的候选作废（避免"两指点完又当成双击"）
    single = null;
  }

  function touchStart(e) {
    if (disposed || !enabled()) return;
    if (penDown) { stats.penBlocked++; gesture = null; return; }
    if (!gesture && e.touches.length >= 2) { startGesture(e); return; }
    if (gesture) {
      // 手势进行中又落下新手指：记下最大指数；新 id 视为"新来的一条"，位移从它的落点算
      for (const t of e.touches) if (!gesture.ids.has(t.identifier)) gesture.ids.set(t.identifier, { x0: t.clientX, y0: t.clientY });
      gesture.maxN = Math.max(gesture.maxN, e.touches.length);
      if (e.touches.length > 3) gesture.invalid = true;
      return;
    }
    if (e.touches.length === 1) {
      const t = e.touches[0];
      single = { t0: now(), x0: t.clientX, y0: t.clientY, moved: 0 };
    }
  }

  function touchMove(e) {
    if (disposed) return;
    if (gesture) {
      for (const t of e.touches) {
        const s = gesture.ids.get(t.identifier);
        if (!s) { gesture.ids.set(t.identifier, { x0: t.clientX, y0: t.clientY }); continue; }
        gesture.maxD = Math.max(gesture.maxD, dist({ x: t.clientX, y: t.clientY }, { x: s.x0, y: s.y0 }));
      }
      return;
    }
    if (single && e.touches.length === 1) {
      const t = e.touches[0];
      single.moved = Math.max(single.moved, dist({ x: t.clientX, y: t.clientY }, { x: single.x0, y: single.y0 }));
    }
  }

  function touchEnd(e) {
    if (disposed) return;
    if (gesture) {
      // 还在按着的触点也要把最后一次位移算进去
      for (const t of e.touches) {
        const s = gesture.ids.get(t.identifier);
        if (s) gesture.maxD = Math.max(gesture.maxD, dist({ x: t.clientX, y: t.clientY }, { x: s.x0, y: s.y0 }));
      }
      if (e.touches.length > 0) return;              // 还有手指在屏上
      const g = gesture;
      gesture = null;
      const ms = now() - g.t0;
      if (g.invalid || ms > maxMs || g.maxD > maxMove) { stats.rejected++; return; }
      if (g.maxN === 2) { stats.twoFinger++; onTwoFingerTap({ ms, maxD: g.maxD }); }
      else if (g.maxN === 3) { stats.threeFinger++; onThreeFingerTap({ ms, maxD: g.maxD }); }
      return;
    }
    if (single && e.touches.length === 0) {
      const s = single;
      single = null;
      const ms = now() - s.t0;
      if (s.moved > maxMove || ms > maxMs) { lastTap = null; return; }
      const t = now();
      if (lastTap && t - lastTap.t <= doubleTapMs && dist({ x: s.x0, y: s.y0 }, lastTap) <= doubleTapPx) {
        stats.doubleTap++;
        lastTap = null;
        onDoubleTap({ x: s.x0, y: s.y0 });
        return;
      }
      lastTap = { t, x: s.x0, y: s.y0 };
    }
  }

  // 只旁听：capture 阶段读事件，不阻止默认行为（相机/视图照常处理）
  const opts = { capture: true, passive: true };
  target.addEventListener("touchstart", touchStart, opts);
  target.addEventListener("touchmove", touchMove, opts);
  target.addEventListener("touchend", touchEnd, opts);
  target.addEventListener("touchcancel", () => { gesture = null; single = null; }, opts);
  window.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  window.addEventListener("pointerup", onPointerUp, { capture: true, passive: true });
  window.addEventListener("pointercancel", onPointerCancel, { capture: true, passive: true });

  return {
    stats: () => ({ ...stats }),
    dispose() {
      if (disposed) return;
      disposed = true;
      target.removeEventListener("touchstart", touchStart, opts);
      target.removeEventListener("touchmove", touchMove, opts);
      target.removeEventListener("touchend", touchEnd, opts);
      window.removeEventListener("pointerdown", onPointerDown, { capture: true });
      window.removeEventListener("pointerup", onPointerUp, { capture: true });
      window.removeEventListener("pointercancel", onPointerCancel, { capture: true });
    },
  };
}
