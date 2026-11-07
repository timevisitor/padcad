/**
 * 触摸优先的轨道相机（Afu3D / Shapr3D 手势约定）
 *   单指点击   → 选中（不旋转）
 *   单指拖动   → 环绕旋转视图（平面模式下改为平移）
 *   双指拖动   → 平移视图
 *   双指捏合   → 缩放
 *   长按       → 打开上下文菜单
 *   手写笔     → 绘制 / 编辑（优先交给 onDragStart，不转视角）
 * 用 Pointer Events 统一处理触屏 / 手写笔 / 鼠标。
 */
import * as THREE from "three";

const DEG = Math.PI / 180;
// 世界坐标系用 CAD 惯例的 Z-up（模型躺在 XY 平面、Z 是高度/厚度）。
// 不能用 three.js 默认的 Y-up：那样 60×40×8 的板会"立起来"，
// 屏幕上的"上方"变成模型的宽度方向，推拉/拖动方向全会歪。
const WORLD_UP = new THREE.Vector3(0, 0, 1);
// 法向指向观察者；X 方向是该视图中朝屏幕右侧的世界坐标轴。
const STANDARD_VIEWS = {
  iso: { normal: [1, 1, 1] },
  front: { normal: [0, -1, 0], x: [1, 0, 0] },
  back: { normal: [0, 1, 0], x: [-1, 0, 0] },
  left: { normal: [-1, 0, 0], x: [0, -1, 0] },
  right: { normal: [1, 0, 0], x: [0, 1, 0] },
  top: { normal: [0, 0, 1], x: [1, 0, 0] },
  bottom: { normal: [0, 0, -1], x: [1, 0, 0] },
};

const LONG_PRESS_MS = 480;
const LONG_PRESS_SLOP = 12;
const TAP_SLOP = 9;

/** 手写笔 / 鼠标视为精细输入：优先绘制与编辑，不拿来转视角。 */
function isPrecisionPointer(pointerType) {
  return pointerType === "pen" || pointerType === "mouse" || !pointerType;
}

export class OrbitCam {
  constructor(camera, dom) {
    /**
     * 平面模式（草图模式默认开）：
     *   单指拖动 = 平移视图（像 AutoCAD 那类平面 CAD），**不再环绕旋转**
     *   双指 = 缩放 + 平移（不变）
     * 这样在草图里画图时，手指落在画布上不会把视角转跑。
     */
    this.planar = false;
    this.camera = camera;
    this.dom = dom;
    this.target = new THREE.Vector3(0, 0, 0);
    this.dist = 220;
    this.az = 42 * DEG;      // 方位角
    this.el = 26 * DEG;      // 俯仰角
    this.pointers = new Map();
    this.moved = 0;          // 累计移动量，用来区分「点击」和「拖动」
    this.enabled = true;
    this.onTap = null;
    /** 长按（单指按住不动）→ 打开菜单。参数 {x, y, pointerType} */
    this.onLongPress = null;
    /** 任意手势被系统打断 / 第二指介入时通知上层 */
    this.onGestureCancel = null;
    this._changeListeners = new Set();
    this._longPressTimer = 0;

    this._bind();
    this.update();
  }

  _bind() {
    const d = this.dom;
    d.addEventListener("pointerdown", (e) => this._down(e), { passive: false });
    d.addEventListener("pointermove", (e) => this._move(e), { passive: false });
    d.addEventListener("pointerup", (e) => this._up(e));
    d.addEventListener("pointercancel", (e) => this._up(e, true));
    d.addEventListener("lostpointercapture", (e) => this._up(e, true));
    // 阻止平板浏览器的双指缩放/双击缩放抢手势
    d.addEventListener("gesturestart", (e) => e.preventDefault());
    d.addEventListener("contextmenu", (e) => e.preventDefault());
    d.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (!this.enabled || !e.deltaY) return;
      this.dist = THREE.MathUtils.clamp(this.dist * (1 + Math.sign(e.deltaY) * 0.12), 5, 5000);
      this.update();
    }, { passive: false });
  }

  _clearLongPress() {
    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = 0;
    }
  }

  _armLongPress(e) {
    this._clearLongPress();
    // 手写笔/鼠标不触发长按菜单（它们直接绘制或点击）
    if (!this.onLongPress) return;
    const type = e.pointerType || "touch";
    if (type === "pen" || type === "mouse") return;
    this._longPressTimer = setTimeout(() => {
      this._longPressTimer = 0;
      if (this.pointers.size !== 1 || this.moved >= LONG_PRESS_SLOP) return;
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      this._longPressed = true;
      // 长按后本次手势不再当作点击/旋转
      this._cancelDrag(e);
      this.onLongPress({ x: p.x, y: p.y, pointerType: type });
    }, LONG_PRESS_MS);
  }

  _down(e) {
    if (!this.enabled) return;
    if (this.pointers.has(e.pointerId)) return;
    this.dom.setPointerCapture?.(e.pointerId);
    // 缺省按精细输入（鼠标/桌面回归）；显式 touch 才是手指。
    const type = e.pointerType || "mouse";
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), type });
    if (this.pointers.size === 1) {
      this.moved = 0;
      this._multiTouch = false;
      this._dragMode = false;
      this._longPressed = false;
      this._armLongPress(e);
    } else {
      // 第二指接管为视图手势，必须取消尚未提交的草图/推拉。
      // 直到所有手指离开，都不能再把这一组手势解释为单击。
      this._multiTouch = true;
      this._clearLongPress();
      this._cancelDrag(e);
      this.onGestureCancel?.(e);
    }
    this._prevCentroid = this._centroid();
    this._prevSpan = this._span();
    // 手指只做视图手势；手写笔/鼠标优先绘制编辑（onDragStart 拦截）。
    const isFinger = type === "touch";
    if (this.pointers.size === 1 && this.onDragStart && !isFinger) {
      this._dragMode = this.onDragStart(e) === true;
    }
  }

  _cancelDrag(e) {
    if (!this._dragMode) return;
    this._dragMode = false;
    this.onDragCancel?.(e);
  }

  /** 屏幕像素换算到目标平面，横竖屏和不同画布尺寸下都跟手。 */
  _pan(dx, dy) {
    const height = this.dom.clientHeight || this.dom.getBoundingClientRect?.().height || 1;
    const scale = 2 * this.dist * Math.tan(this.camera.fov * DEG / 2) / height;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    this.target.addScaledVector(right, -dx * scale);
    this.target.addScaledVector(up, dy * scale);
  }

  _centroid() {
    let x = 0, y = 0, n = 0;
    for (const p of this.pointers.values()) { x += p.x; y += p.y; n++; }
    return { x: x / n, y: y / n, n };
  }

  _span() {
    const ps = [...this.pointers.values()];
    if (ps.length < 2) return 0;
    return Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
  }

  _move(e) {
    if (!this.enabled || !this.pointers.has(e.pointerId)) return;
    const p = this.pointers.get(e.pointerId);
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    this.moved += Math.hypot(dx, dy);

    if (this.moved >= LONG_PRESS_SLOP) this._clearLongPress();
    if (this._longPressed && this.pointers.size === 1 && !this._dragMode) return;

    // 被拦截的单指拖动：整段交给外部（推拉/绘制），不动相机
    if (this._dragMode && this.pointers.size === 1) {
      this.onDrag?.(e, dx, dy);
      return;
    }
    if (this.pointers.size > 1) this._dragMode = false;

    const c = this._centroid();
    if (c.n === 1) {
      // 手写笔在无编辑工具时也不转视角，避免画线时视角被带偏；
      // 鼠标与手指仍可旋转，保证桌面调试与无笔平板可用。
      const type = p.type || e.pointerType || "touch";
      const penOnly = type === "pen";
      if (penOnly && !this._dragMode) {
        // 笔尖悬停拖动且没有编辑工具：忽略，留给上层做预览
      } else if (this.planar) {
        // 平面模式：单指平移（与双指平移用同一套换算，手感一致）
        this._pan(dx, dy);
      } else {
        // 单指：环绕旋转
        this.az -= dx * 0.006;
        this.el = THREE.MathUtils.clamp(this.el + dy * 0.006, -85 * DEG, 85 * DEG);
      }
    } else if (c.n === 2) {
      // 双指：捏合缩放 + 质心平移
      const span = this._span();
      if (this._prevSpan) {
        const ratio = span / this._prevSpan;
        if (isFinite(ratio) && ratio > 0.01) {
          this.dist = THREE.MathUtils.clamp(this.dist / ratio, 5, 5000);
        }
      }
      this._prevSpan = span;

      if (this._prevCentroid) {
        const ddx = c.x - this._prevCentroid.x;
        const ddy = c.y - this._prevCentroid.y;
        this._pan(ddx, ddy);
      }
    }
    this._prevCentroid = c;
    this.update();
  }

  _up(e, cancelled = false) {
    const wasTracked = this.pointers.delete(e.pointerId);
    if (!wasTracked) return;
    this._clearLongPress();
    this._prevSpan = this._span();
    this._prevCentroid = this.pointers.size ? this._centroid() : null;
    if (cancelled) {
      this._multiTouch = true;
      this._cancelDrag(e);
      return;
    }
    if (this._dragMode) {
      this._dragMode = false;
      this.onDragEnd?.(e);
      return;
    }
    // 位移很小 → 判定为「点击」，交回上层做拾取；长按后不当作点击
    if (this.pointers.size === 0 && !this._multiTouch && !this._longPressed
        && this.moved < TAP_SLOP && this.onTap) {
      this.onTap({ x: e.clientX, y: e.clientY });
    }
    if (this.pointers.size === 0) this._longPressed = false;
  }

  update() {
    const ce = Math.cos(this.el), se = Math.sin(this.el);
    // 视线与默认 up 共线时（正对顶面/底面）换一个 up，否则 lookAt 会翻滚
    this.camera.up.copy(this.customUp || WORLD_UP);
    // Z-up 参数化：az 是绕 Z 轴的方位角，el 是相对 XY 平面的仰角
    this.camera.position.set(
      this.target.x + this.dist * ce * Math.cos(this.az),
      this.target.y + this.dist * ce * Math.sin(this.az),
      this.target.z + this.dist * se,
    );
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
    for (const listener of this._changeListeners) listener(this);
  }

  /** 订阅已完成的视图变化；返回取消订阅函数，不启动额外渲染循环。 */
  addChangeListener(listener) {
    this._changeListeners.add(listener);
    return () => this._changeListeners.delete(listener);
  }

  /** 标准观察方向，保留透视投影、观察中心和缩放距离。 */
  setStandardView(name) {
    if (!Object.hasOwn(STANDARD_VIEWS, name)) return false;
    const view = STANDARD_VIEWS[name];
    this.frameNormal(new THREE.Vector3(...view.normal), view.x ? new THREE.Vector3(...view.x) : null);
    return true;
  }

  /** 由真实相机姿态识别当前视图，手动旋转后不会保留过期的高亮。 */
  get standardView() {
    const direction = this.dir;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    for (const [name, view] of Object.entries(STANDARD_VIEWS)) {
      const normal = new THREE.Vector3(...view.normal).normalize();
      if (direction.distanceToSquared(normal) > 1e-10) continue;
      const expectedRight = view.x ? new THREE.Vector3(...view.x)
        : new THREE.Vector3().crossVectors(WORLD_UP, normal).normalize();
      if (right.distanceToSquared(expectedRight) < 1e-10) return name;
    }
    return null;
  }

  /**
   * 让相机正对给定法向（草图模式用）
   * @param normal 面外法向（相机将位于 target + normal*dist）
   * @param xDir   希望出现在屏幕水平方向的平面内轴
   */
  frameNormal(normal, xDir = null) {
    const n = normal.clone().normalize();
    const nz = THREE.MathUtils.clamp(n.z, -1, 1);
    this.el = Math.asin(nz);
    this.az = Math.atan2(n.y, n.x);
    // 正对顶面/底面时视线与 Z 轴共线，换 up 免得翻滚
    this.customUp = Math.abs(nz) > 0.98 ? new THREE.Vector3(0, 1, 0) : null;
    // 用草图的 Y 轴作相机 up，让 X 轴朝屏幕右侧。
    // 改 az 会改变观察法向（某些侧面甚至会转到背面），不能用它修正屏幕滚转。
    if (xDir) {
      const xd = xDir.clone().projectOnPlane(n);
      if (xd.lengthSq() > 1e-9) this.customUp = new THREE.Vector3().crossVectors(n, xd).normalize();
    }
    this.update();
  }

  /** 退出特殊视角，恢复正常轨道相机 */
  resetUp() { this.customUp = null; this.update(); }

  /** 切平面/3D 模式 */
  setPlanar(on) {
    this.planar = !!on;
    return this.planar;
  }

  /** 按当前视角投影包围盒的八个角，横竖屏都留出 15% 余量。 */
  fit(box) {
    if (!box || box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    this.target.copy(c);
    this.update();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    const dir = this.dir;
    const tanV = Math.tan(this.camera.fov * DEG / 2);
    const tanH = tanV * Math.max(this.camera.aspect, 0.01);
    let distance = 5;
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const p = new THREE.Vector3(x, y, z).sub(c);
          const depth = p.dot(dir);
          distance = Math.max(distance,
            depth + Math.abs(p.dot(right)) * 1.15 / tanH,
            depth + Math.abs(p.dot(up)) * 1.15 / tanV,
            depth + this.camera.near * 2);
        }
      }
    }
    this.dist = distance;
    this.update();
  }

  /** 相机朝向（用于推拉手柄的方向参考） */
  get dir() {
    return new THREE.Vector3().subVectors(this.camera.position, this.target).normalize();
  }
}
