/**
 * 尺寸手柄 —— Shapr3D 式交互：尺寸看得见、拖得动、点得改
 *
 * 一个 3D 锚点 + 一个方向：控件位置 = anchor + dir * value。
 * 所以拖动手柄 = 直接改尺寸，松手前实时重建实体。
 *
 * 拖动的数学：把手指位移投影到「该方向在屏幕上的投影」再除以每单位像素数，
 * 得到尺寸增量。这样无论视角怎么转，拖动方向感都和看到的一致。
 */

export class DimHandle {
  constructor({ onPreview, onCommit, onStart, onCancel } = {}) {
    this.el = document.getElementById("dimHandle");
    this.dot = document.getElementById("dimDot");
    this.valEl = document.getElementById("dimValue");
    this.leaderEl = document.getElementById("dimLeader");

    this.anchor = null;     // THREE.Vector3
    this.dir = null;        // THREE.Vector3（单位向量）
    this.value = 0;
    this.prefix = "";
    this.unit = "";
    this.min = 0.1;
    this.max = 9999;
    this.onPreview = onPreview;
    this.onCommit = onCommit;
    this.onStart = onStart;
    this.onCancel = onCancel;

    this._drag = null;
    this._editing = false;
    this._axis = { x: 0, y: -1, ppu: 1 };   // 屏幕上的方向与每单位像素数
    this._scr = { x: 0, y: 0 };

    this._bind();
  }

  get visible() { return !this.el.classList.contains("hidden"); }
  get dragging() { return this._drag !== null; }

  // ---------------------------------------------------------- 显示控制
  show({ anchor, dir, value, prefix = "", unit = "", min, max }) {
    this.anchor = anchor;
    this.dir = dir;
    this.value = value;
    this.prefix = prefix;
    this.unit = unit;
    if (min != null) this.min = min;
    if (max != null) this.max = max;
    this.el.classList.remove("hidden");
    this._render();
  }

  update(value) { this.value = value; this._render(); }

  hide() {
    const drag = this._drag;
    this._drag = null;
    if (drag) {
      this.value = drag.v0;
      if (this.onCancel) this.onCancel(drag.v0);
      else this.onPreview?.(drag.v0);
    }
    this._cancelEdit?.();
    this._editing = false;
    this.el.classList.remove("dragging", "clamped");
    this.leaderEl?.classList.remove("on");
    this._leader = null;
    this.el.classList.add("hidden");
  }

  /** 相机/窗口变化后重算屏幕位置与拖动轴方向 */
  sync(camera, canvas, rect = null) {
    if (!this.visible || !this.anchor || !this.dir) return;
    // 每帧由 viewer 统一测一次矩形；自己再测一次会强制同步布局。
    const r = rect || canvas.getBoundingClientRect();
    const pos = this.anchor.clone().addScaledVector(this.dir, this.value);

    // 三点投影：锚点、沿方向 1 单位的点、手柄本身。
    const project = (v3) => {
      const p = v3.clone().project(camera);
      return {
        x: (p.x * 0.5 + 0.5) * r.width + r.left,
        y: (-p.y * 0.5 + 0.5) * r.height + r.top,
        z: p.z,
      };
    };
    const sp = project(pos);

    /*
     * 手柄跑丢的两个真实原因（都会让用户"看不到那个橙点"）：
     * 1. 点在**相机背后**时，three.js 的 project() 会给出 x/y 翻转的错误坐标，
     *    看起来就像手柄凭空消失或跳到别处；
     * 2. 点投影到**画布之外**（模型大、相机近、或者手柄方向朝背离镜头那侧）。
     * 所以这里做两件事：夹进画布范围 + 在夹住时给个"其实在更远处"的视觉提示。
     */
    const pad = 24;
    const inside = Number.isFinite(sp.z) && sp.z >= -1 && sp.z <= 1;
    const clampX = (x) => Math.min(Math.max(Number.isFinite(x) ? x : r.left + r.width / 2, r.left + pad), r.left + r.width - pad);
    const clampY = (y) => Math.min(Math.max(Number.isFinite(y) ? y : r.top + r.height / 2, r.top + pad), r.top + r.height - pad);
    const cx = clampX(sp.x);
    const cy = clampY(sp.y);
    const clamped = !inside || Math.abs(cx - sp.x) > 0.5 || Math.abs(cy - sp.y) > 0.5;

    this.el.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
    this.el.classList.toggle("clamped", clamped);
    this._scr = { x: cx, y: cy };

    // 标签翻边：手柄贴到右边时把数值标签放到左侧，否则会被挤出屏幕
    // （实测手柄在 x=1226、画布宽 1250 时，右侧 44px 起的标签直接看不见）
    const flip = cx > r.left + r.width - 150;
    this.el.classList.toggle("flip", flip);

    // 被夹住时画一条从锚点指向手柄的引线
    // 引线起点也要夹进画布：相机拉近后锚点投影同样会跑到画布外，
    // 那样整条线都画在屏幕外，等于没有
    const saRaw = project(this.anchor);
    const sa = {
      x: clampX(saRaw.x),
      y: clampY(saRaw.y),
    };
    if (clamped) {
      this._leader = { x1: sa.x, y1: sa.y, x2: cx, y2: cy };
      const ld = this.leaderEl;
      if (ld) {
        const dx = cx - sa.x, dy = cy - sa.y;
        ld.style.width = Math.hypot(dx, dy) + "px";
        ld.style.transform = `translate(${sa.x}px, ${sa.y}px) rotate(${Math.atan2(dy, dx)}rad)`;
        ld.classList.add("on");
      }
    } else {
      this._leader = null;
      this.leaderEl?.classList.remove("on");
    }

    // 拖动轴必须由真实投影求导；引线用的夹紧坐标只负责显示。
    // 用当前手柄位置求导，避免透视下远离锚点时每毫米像素数失真。
    const s0 = sp;
    const s1 = project(pos.clone().add(this.dir));
    const dx = s1.x - s0.x, dy = s1.y - s0.y;
    const ppu = Math.hypot(dx, dy);
    if (inside && Number.isFinite(ppu) && ppu > 0.5) {
      this._axis = { x: dx / ppu, y: dy / ppu, ppu };
    } else {
      // 轴正对镜头时投影没有有效方向，给出稳定的竖直调节手势。
      this._axis = { x: 0, y: -1, ppu: 4 };
    }
  }

  // ---------------------------------------------------------- 内部
  _render() {
    if (this._editing) return;
    const n = Math.abs(this.value) < 100 ? this.value.toFixed(1) : this.value.toFixed(0);
    this.valEl.textContent = `${this.prefix}${n}${this.unit ? " " + this.unit : ""}`;
  }

  _clamp(v) { return Math.min(this.max, Math.max(this.min, v)); }

  _bind() {
    // --- 拖动手柄圆点 ---
    this.dot.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (this._drag || !this.visible) return;
      this.dot.setPointerCapture?.(e.pointerId);
      this.onStart?.();
      this._drag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, v0: this.value, moved: 0, axis: { ...this._axis } };
      this.el.classList.add("dragging");
    });
    this.dot.addEventListener("pointermove", (e) => {
      if (!this._drag || e.pointerId !== this._drag.pointerId) return;
      e.preventDefault(); e.stopPropagation();
      const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
      this._drag.moved = Math.hypot(dx, dy);
      const axis = this._drag.axis;
      const raw = this._drag.v0 + (dx * axis.x + dy * axis.y) / axis.ppu;
      // 吸附到 0.1mm：数字好看、手感也不至于发飘
      const v = this._clamp(Math.round(raw * 10) / 10);
      if (v !== this.value) {
        this.value = v;
        this._render();
        this.onPreview?.(v);
      }
    });
    const end = (e, cancelled = false) => {
      if (!this._drag || e.pointerId !== this._drag.pointerId) return;
      const { moved, v0 } = this._drag;
      this._drag = null;
      this.el.classList.remove("dragging");
      if (!cancelled && moved > 2 && this.value !== v0) {
        this.onCommit?.(this.value);
      } else {
        this.value = v0;
        this._render();
        if (this.onCancel) this.onCancel(v0);
        else this.onPreview?.(v0);
      }
    };
    this.dot.addEventListener("pointerup", end);
    this.dot.addEventListener("pointercancel", (e) => end(e, true));
    this.dot.addEventListener("lostpointercapture", (e) => end(e, true));

    // --- 点击数值 → 直接输入 ---
    this.valEl.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
    this.valEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this._startEdit();
    });
  }

  _startEdit() {
    if (this._editing) return;
    this._editing = true;
    const cur = this.value;
    this.valEl.innerHTML =
      `<input type="number" inputmode="decimal" step="0.5" value="${Math.round(cur * 100) / 100}" />`;
    const inp = this.valEl.querySelector("input");
    inp.focus();
    inp.select?.();
    let done = false;
    const finish = (apply) => {
      if (done) return;
      done = true;
      this._cancelEdit = null;
      const raw = parseFloat(inp.value);
      this._editing = false;
      if (apply && isFinite(raw)) {
        const v = this._clamp(raw);
        this.value = v;
        this._render();
        this.onCommit?.(v);
      } else {
        this._render();
      }
    };
    this._cancelEdit = () => finish(false);
    inp.addEventListener("blur", () => finish(true));
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); inp.blur(); }
      else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    });
  }
}
