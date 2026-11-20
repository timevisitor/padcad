/**
 * 草图会话 —— 在某个实体面上画 2D 轮廓，再拉伸成实体
 *
 * 坐标约定（关键）：
 *   创建时以【面的中心】为原点，(xDir, yDir) 为轴；重建保持保存的面内原点。
 *   不能用 makePlaneFromFace 的 origin —— 那是面的角点，
 *   直接拿来画图会让轮廓偏到板外（实测切槽只切掉 1/4 体积）。
 *   做法：先用角点平面生成实体，再按 (面中心 - 角点) 平移回来。
 */
import * as THREE from "three";
import { drawRectangle, drawCircle, drawRoundedRectangle, makePlaneFromFace, draw, Plane } from "replicad";
import { normalOf, findFace } from "./ops.js";

const v3 = (v) => (Array.isArray(v) ? new THREE.Vector3(v[0], v[1], v[2]) : new THREE.Vector3(v.x, v.y, v.z));

export class SketchSession {
  /**
   * @param shape      当前实体（可以为 null —— 世界基准面上画草图时不依赖实体）
   * @param faceId     承载草图的面；用基准面时传 null
   * @param planeSpec  世界基准面：{origin, normal, xDir, name, occtPlane}
   */
  constructor(shape, faceId, planeSpec = null) {
    this.shape = shape;
    this.entities = [];   // {kind:'rect'|'circle'|'polyline', ...}
    this._draft = null;   // 正在画的自由折线草稿
    this.selected = [];   // 参与出实体的轮廓下标（空 = 全部）
    this.constraints = []; // 可序列化的约束描述（尺寸/水平/竖直/相等…），参与参数化重放
    this._faceRef = null;  // 承载面引用独立于草图原点，重新编辑时不能用原点覆盖它

    if (planeSpec) {
      // ---- 从基准面创建，或恢复保存的实体面草图坐标系 ----
      this.faceId = planeSpec.faceId ?? null;
      this.datumName = planeSpec.name && /^(XY|XZ|YZ)$/.test(planeSpec.name) ? planeSpec.name : null;
      this.face = shape && this.faceId != null ? findFace(shape, this.faceId) : null;
      this._faceRef = planeSpec.faceRef ? structuredClone(planeSpec.faceRef) : null;
      this.occtPlane = planeSpec.occtPlane;
      this.origin = planeSpec.origin.clone();
      this.normal = planeSpec.normal.clone().normalize();
      this.xDir = planeSpec.xDir.clone().normalize();
      this.yDir = new THREE.Vector3().crossVectors(this.normal, this.xDir).normalize();
      this.originShift = this.origin.clone().sub(v3(this.occtPlane.origin));
      this.label = `${planeSpec.name} 基准面`;
      return;
    }

    const face = findFace(shape, faceId);
    if (!face) throw new Error("面已失效");

    this.shape = shape;
    this.faceId = faceId;
    this.face = face;
    this.occtPlane = makePlaneFromFace(face);
    this.label = "实体面";

    const c = face.center;
    this.origin = new THREE.Vector3(c.x, c.y, c.z);          // 面中心 = 草图原点
    this.normal = new THREE.Vector3(...normalOf(face)).normalize();
    this._faceRef = { center: this.origin.toArray(), normal: this.normal.toArray() };

    // 平面内两轴：优先用 OCCT 给的 xDir，保证与几何一致
    let xd = v3(this.occtPlane.xDir).normalize();
    if (Math.abs(xd.dot(this.normal)) > 0.99) {
      // xDir 与法向共线（不该发生）时兜底造一个
      xd = new THREE.Vector3(1, 0, 0);
      if (Math.abs(xd.dot(this.normal)) > 0.99) xd.set(0, 1, 0);
      xd.projectOnPlane(this.normal).normalize();
    }
    this.xDir = xd;
    this.yDir = new THREE.Vector3().crossVectors(this.normal, this.xDir).normalize();

    // 生成实体后要平移的向量（OCCT 平面原点 → 面中心）
    const o = v3(this.occtPlane.origin);
    this.originShift = this.origin.clone().sub(o);
  }

  // ---------------------------------------------------------- 坐标转换
  /** 3D 点 → 以面中心为原点的平面 2D 坐标 */
  to2D(p) {
    const d = new THREE.Vector3(p.x, p.y, p.z).sub(this.origin);
    return { x: d.dot(this.xDir), y: d.dot(this.yDir) };
  }

  /** 平面 2D 坐标 → 3D 点 */
  to3D(u, v) {
    return this.origin.clone()
      .addScaledVector(this.xDir, u)
      .addScaledVector(this.yDir, v);
  }

  /** 射线与草图平面求交（返回 3D 交点，无交返回 null） */
  intersectRay(ray) {
    const denom = ray.direction.dot(this.normal);
    if (Math.abs(denom) < 1e-9) return null;
    const t = this.origin.clone().sub(ray.origin).dot(this.normal) / denom;
    if (!isFinite(t) || t < 0) return null;
    return ray.origin.clone().addScaledVector(ray.direction, t);
  }

  /** 屏幕坐标 → 平面 2D 坐标（供手势使用） */
  screenTo2D(clientX, clientY, camera, canvas) {
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, camera);
    const hit = this.intersectRay(rc.ray);
    return hit ? this.to2D(hit) : null;
  }

  // ---------------------------------------------------------- 图形操作
  addRect(p1, p2) {
    const w = Math.abs(p2.x - p1.x), h = Math.abs(p2.y - p1.y);
    if (w < 0.05 || h < 0.05) return null;
    const e = { kind: "rect", c: [(p1.x + p2.x) / 2, (p1.y + p2.y) / 2], w, h };
    this.entities.push(e);
    return e;
  }

  addRectWH(cx, cy, w, h) {
    if (w < 0.05 || h < 0.05) return null;
    const e = { kind: "rect", c: [cx, cy], w, h };
    this.entities.push(e);
    return e;
  }

  addCircle(p1, p2) {
    const r = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (r < 0.05) return null;
    const e = { kind: "circle", c: [p1.x, p1.y], r };
    this.entities.push(e);
    return e;
  }

  addCircleR(cx, cy, r) {
    if (r < 0.05) return null;
    const e = { kind: "circle", c: [cx, cy], r };
    this.entities.push(e);
    return e;
  }

  /** 点到线段的距离 */
  static _segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }

  /**
   * 命中测试：找离给定草图坐标最近的图元。
   * 判据是「到图元轮廓的距离」，不是到中心的距离 ——
   * 否则点一个大矩形的边框附近会选不中它。
   */
  pickEntity(p2d, tol = 4) {
    let best = null, bd = Infinity;
    this.entities.forEach((e, i) => {
      let d = Infinity;
      if (e.kind === "rect") {
        const hw = e.w / 2, hh = e.h / 2;
        // 转到矩形局部坐标后，到边框的距离
        const dx = Math.abs(p2d[0] - e.c[0]) - hw;
        const dy = Math.abs(p2d[1] - e.c[1]) - hh;
        d = Math.abs(dx < 0 && dy < 0 ? Math.max(dx, dy) : Math.hypot(Math.max(dx, 0), Math.max(dy, 0)));
        if (dx < 0 && dy < 0) d = Math.min(-dx, -dy);      // 在内部：到最近边的距离
      } else if (e.kind === "circle") {
        d = Math.abs(Math.hypot(p2d[0] - e.c[0], p2d[1] - e.c[1]) - e.r);
      } else if (e.kind === "polyline") {
        const P = e.pts;
        for (let k = 0; k < P.length - 1; k++) d = Math.min(d, SketchSession._segDist(p2d, P[k], P[k + 1]));
        if (e.closed && P.length > 2) d = Math.min(d, SketchSession._segDist(p2d, P[P.length - 1], P[0]));
      }
      if (d < bd) { bd = d; best = i; }
    });
    return bd <= tol ? { index: best, dist: bd, entity: this.entities[best] } : null;
  }

  /** 该图元可标注的尺寸（key 对应 solver 里的参数名） */
  dimensionsOf(i) {
    const e = this.entities[i];
    if (!e) return [];
    if (e.kind === "rect") {
      return [
        { k: "w", label: "宽", value: e.w },
        { k: "h", label: "高", value: e.h },
      ];
    }
    if (e.kind === "circle") {
      return [{ k: "r", label: "半径", value: e.r }];
    }
    return [];
  }

  /** 设置/更新一条尺寸约束（同 target 覆盖旧的，避免越标越矛盾） */
  setDimension(i, k, value, label) {
    this.constraints = this.constraints.filter((c) => !(c.type === "fixed" && c.e === i && c.k === k));
    this.constraints.push({ type: "fixed", e: i, k, value, label: `${label} ${value}` });
    return this.constraints.length;
  }

  /**
   * 转换实体引用：把 3D 点列投影到草图平面，作为折线加进来。
   * 直线边只要两个端点（投影后仍然精确），曲线边按采样点近似。
   */
  addProjectedPoints(pts3d) {
    const out = [];
    for (const p of pts3d) {
      const d = new THREE.Vector3(p[0], p[1], p[2]).sub(this.origin);
      out.push([d.dot(this.xDir), d.dot(this.yDir)]);
    }
    // 投影后可能出现重合点，去掉，否则会让后续布尔退化
    const clean = [];
    for (const q of out) {
      const last = clean[clean.length - 1];
      if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 1e-4) clean.push(q);
    }
    if (clean.length < 2) return null;
    const e = { kind: "polyline", pts: clean, closed: false, ref: true };
    this.entities.push(e);
    return e;
  }

  /**
   * 等距实体：把选中的图元按距离偏移。
   * 圆和矩形是精确的（同心圆 / 外扩矩形）；自由折线的轮廓偏移需要
   * 求交和自交处理，这里不糊弄 —— 直接告诉用户暂不支持。
   */
  offsetEntity(i, dist) {
    const e = this.entities[i];
    if (!e) return { ok: false, why: "图元不存在" };
    if (e.kind === "circle") {
      const r = e.r + dist;
      if (r <= 0.01) return { ok: false, why: "偏移后半径会变成负数或零" };
      const n = { kind: "circle", c: e.c.slice(), r };
      this.entities.push(n);
      return { ok: true, entity: n, desc: `同心圆 R${r.toFixed(2)}` };
    }
    if (e.kind === "rect") {
      const w = e.w + dist * 2, h = e.h + dist * 2;
      if (w <= 0.01 || h <= 0.01) return { ok: false, why: "偏移量太大，矩形会退化成负尺寸" };
      const n = { kind: "rect", c: e.c.slice(), w, h };
      this.entities.push(n);
      return { ok: true, entity: n, desc: `矩形 ${w.toFixed(2)} × ${h.toFixed(2)}` };
    }
    return { ok: false, why: "自由折线的等距偏移需要轮廓求交，暂未实现（圆和矩形可以）" };
  }

  /**
   * 参与出实体的轮廓。
   * 空数组 = 全部轮廓（默认行为）；非空 = 只拉伸这些 ——
   * 对应 SolidWorks 里"草图有多个闭合轮廓，点选其中几个拉伸"。
   */
  get activeEntities() {
    if (!this.selected || !this.selected.length) return this.entities;
    return this.entities.filter((_, i) => this.selected.includes(i));
  }

  /** 只画指定下标的轮廓线（用于把选中的轮廓单独高亮出来） */
  linesOf(indices) {
    const list = (indices && indices.length)
      ? this.entities.filter((_, i) => indices.includes(i))
      : [];
    return this._lines(list);
  }

  /** 切换某个轮廓的选中状态；点空白处（传 null）恢复全选 */
  toggleContour(i) {
    if (i == null) { this.selected = []; return; }
    if (!this.selected.length) {
      // 从"全选"切到"单选"：其余的都取消
      this.selected = [i];
    } else if (this.selected.includes(i)) {
      this.selected = this.selected.filter((x) => x !== i);
      // 全取消等于回到全选
      if (!this.selected.length) this.selected = [];
    } else {
      this.selected = [...this.selected, i].sort((a, b) => a - b);
    }
    return this.selected;
  }

  clear() { this.entities.length = 0; this._draft = null; this.constraints.length = 0; this.selected = []; }
  undo() {
    if (this._draft) { this._draft = null; return { kind: "polyline-draft" }; }
    return this.entities.pop();
  }

  get isEmpty() { return this.entities.length === 0 && !this._draft; }
  get draft() { return this._draft; }

  /**
   * 把「草图画在哪儿」描述成可重放的数据。
   * 基准面记名字（XY/XZ/YZ 永远不变）；实体面记几何引用（中心+法向），
   * 重放时按几何重新找到那个面 —— 因为上游一改，面的哈希就全变了。
   */
  get planeDesc() {
    const o = [this.origin.x, this.origin.y, this.origin.z];
    const n = [this.normal.x, this.normal.y, this.normal.z];
    const x = [this.xDir.x, this.xDir.y, this.xDir.z];
    if (this.datumName) {
      return { kind: "datum", name: this.datumName, origin: o, normal: n, xDir: x, label: this.label };
    }
    return {
      kind: "face",
      faceRef: this._faceRef ? structuredClone(this._faceRef) : { center: o, normal: n },
      origin: o, normal: n, xDir: x, label: this.label,
    };
  }

  // ---------------------------------------------------------- 自由折线（直线工具）
  /** 起一条新折线 */
  beginPolyline(p) {
    this._draft = { kind: "polyline", pts: [[p.x, p.y]], closed: false };
    return this._draft;
  }

  /**
   * 追加一点。返回 'added' | 'closed' | 'tooClose'
   * 去重是必须的：手抖在原地留下重复点会让布尔运算退化（实测体积误差 0.013）
   */
  addPolylinePoint(p, closeTol = 1.5, dupTol = 0.4) {
    const d = this._draft;
    if (!d) return "none";
    const pts = d.pts;
    const last = pts[pts.length - 1];
    if (Math.hypot(p.x - last[0], p.y - last[1]) < dupTol) return "tooClose";
    if (pts.length >= 3) {
      const f = pts[0];
      if (Math.hypot(p.x - f[0], p.y - f[1]) < closeTol) {
        d.closed = true;
        this.entities.push(d);
        this._draft = null;
        return "closed";
      }
    }
    pts.push([p.x, p.y]);
    return "added";
  }

  /**
   * 结束当前折线。
   *
   * ⚠ 门槛是 **2 个点**，不是 3 个 —— 两个点就是一条**直线**，这是最基本的图元。
   * 之前写的是 `< 3`，导致"画一条直线然后收尾"这条路径直接把线丢掉了
   * （用户实测反馈：画完一条线再点别处，线不见了）。
   * 2 点的开放折线是**构造线性质**的草图线，能标注/能当参考，但不参与拉伸
   * （拉伸时会跳过，见 buildSolid）。
   */
  finishPolyline() {
    const d = this._draft;
    this._draft = null;
    if (!d || d.pts.length < 2) return null;
    d.closed = false;
    this.entities.push(d);
    return d;
  }

  // ---------------------------------------------------------- 生成实体
  _blueprint(e) {
    if (e.kind === "rect") {
      return drawRectangle(e.w, e.h).translate(e.c[0], e.c[1]);
    }
    if (e.kind === "circle") {
      return drawCircle(Math.max(0.05, e.r)).translate(e.c[0], e.c[1]);
    }
    if (e.kind === "polyline") {
      // 自由折线：点已是平面内绝对坐标，不需要再平移
      const pen = draw(e.pts[0]);
      for (let i = 1; i < e.pts.length; i++) pen.lineTo(e.pts[i]);
      return pen.close();   // close() = 从末点自动补一条直线回到起点
    }
    throw new Error("未知的草图图元：" + e.kind);
  }

  /**
   * 把草图拉伸成实体
   * @param depth  拉伸深度（正 = 沿面外法向长出，负 = 往里切）
   * @param grow   加料时的两端凸出量（骑跨），避开与本体共面退化
   */
  /** 把选中的轮廓转成 Drawing（旋转、放样这类需要 Drawing 的操作） */
  toDrawings() {
    const out = [];
    const worldPlane = new Plane(this.origin.toArray(), this.xDir.toArray(), this.normal.toArray());
    for (const e of this.activeEntities) {
      try { out.push(this._blueprint(e).sketchOnPlane(worldPlane)); } catch (_) {}
    }
    return out;
  }

  /** 草图在自身平面 2D 坐标里的包围盒 */
  get bounds2D() {
    const xs = [], ys = [];
    for (const e of this.entities) {
      if (e.kind === "rect") {
        const hw = e.w / 2, hh = e.h / 2;
        xs.push(e.c[0] - hw, e.c[0] + hw);
        ys.push(e.c[1] - hh, e.c[1] + hh);
      } else if (e.kind === "circle") {
        xs.push(e.c[0] - e.r, e.c[0] + e.r);
        ys.push(e.c[1] - e.r, e.c[1] + e.r);
      } else if (e.kind === "polyline") {
        for (const p of e.pts) { xs.push(p[0]); ys.push(p[1]); }
      }
    }
    if (!xs.length) return null;
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }

  /**
   * 旋转凸台：把选中轮廓绕一条**草图平面内的竖直轴**旋转。
   * @param angle 角度（度）
   * @param axisX 旋转轴在草图 2D 坐标里的 x（轴平行于草图 Y 方向）
   *
   * ⚠ 坑一：replicad 的 `sketch.revolve(dir, {origin})` 里 **dir 和 origin 都是 3D 世界坐标**
   * （内部直接 BRepPrimAPI_MakeRevol(face, Ax1(origin, dir))），不是草图平面的 2D 表示 ——
   * 传 2D 会得到 z=undefined 的轴，结果体积大得离谱**而且不报错**。
   *
   * toDrawings() 已把轮廓放在预览使用的世界坐标系，旋转轴也必须使用同一原点。
   */
  revolveSolid(angle = 360, axisX = null) {
    const bb = this.bounds2D;
    if (!bb) throw new Error("草图是空的");
    const ax = axisX == null ? bb.minX : axisX;
    const u = this.xDir, vv = this.yDir;
    const base = this.origin.toArray();
    const center = [
      base[0] + u.x * ax,
      base[1] + u.y * ax,
      base[2] + u.z * ax,
    ];
    const dir = [vv.x, vv.y, vv.z];
    let acc = null;
    for (const d of this.toDrawings()) {
      let solid;
      try {
        solid = d.revolve(dir, { origin: center, angle: Math.abs(angle) || 360 });
      } catch (_) {
        throw new Error("旋转失败：轮廓不能跨过旋转轴（要完全在轴的一侧，可以贴轴）");
      }
      acc = acc ? acc.fuse(solid) : solid;
    }
    if (!acc) throw new Error("没有可旋转的轮廓");
    return acc;
  }

  /**
   * 拉伸：把草图轮廓沿法向拉出实体。
   * @param depth  拉伸深度（正 = 沿面外法向长出，负 = 往里切）
   * @param grow   加料时的两端凸出量（骑跨），避开与本体共面退化
   */
  buildSolid(depth, grow = 0) {
    if (this.isEmpty) throw new Error("草图是空的");
    // 只拉伸「选中的轮廓」；没选过就全部拉伸
    const contours = this.activeEntities;
    if (!contours.length) throw new Error("没有可拉伸的轮廓（选中的轮廓是空的）");
    const s = Math.sign(depth) || 1;
    const d = Math.abs(depth);
    const n = this.normal;
    const eps = Math.abs(grow);
    let acc = null;
    for (const e of contours) {
      // 两个点的开放折线是**构造线**（一条直线而已），不是闭合轮廓 —— 跳过，
      // 否则内核会"自动补一条回到起点的线"，退化成零面积、拉伸报错
      if (e.kind === "polyline" && !e.closed && e.pts.length < 3) continue;
      // 统一用「柱体两端各凸出 eps」来避开共面退化 —— 对自由折线也能用
      // （轮廓外扩只适用于矩形/圆，折线没法简单外扩）
      let solid = this._blueprint(e)
        .sketchOnPlane(this.occtPlane)
        .extrude((d + eps) * s);
      if (eps > 0) {
        solid = solid.translate([-n.x * eps * s, -n.y * eps * s, -n.z * eps * s]);
      }
      solid = solid.translate([this.originShift.x, this.originShift.y, this.originShift.z]);
      acc = acc ? acc.fuse(solid) : solid;
    }
    return acc;
  }

  // ---------------------------------------------------------------- 草图图元变换
  /*
   * 移动 / 镜像 / 阵列 —— 草图层面比实体层面更常用（比如画一排孔，先画一个再阵列）。
   *
   * 关键约束：**矩形实体是轴对齐的**（用 中心 + 宽高 表示），
   * 所以任意角度旋转/镜像之后它不再是轴对齐矩形 —— 这时要转成自由折线，
   * 否则图形会"跳"。90° 的整数倍才能继续用矩形表示。
   */

  /** 把某个图元转成自由折线（任意角度变换后用它，保住形状不变形） */
  _toPolyline(e) {
    if (e.kind === "polyline") return e;
    if (e.kind === "rect") {
      const hw = e.w / 2, hh = e.h / 2;
      return {
        kind: "polyline",
        pts: [
          [e.c[0] - hw, e.c[1] - hh],
          [e.c[0] + hw, e.c[1] - hh],
          [e.c[0] + hw, e.c[1] + hh],
          [e.c[0] - hw, e.c[1] + hh],
        ],
        closed: true,
      };
    }
    if (e.kind === "circle") {
      // 圆没法用折线精确表示，给 64 边的多边形（阵列/镜像用，精度足够）
      const pts = [];
      for (let i = 0; i < 64; i++) {
        const t = (i / 64) * Math.PI * 2;
        pts.push([e.c[0] + Math.cos(t) * e.r, e.c[1] + Math.sin(t) * e.r]);
      }
      return { kind: "polyline", pts, closed: true };
    }
    return e;
  }

  /** 平移若干图元（原地改，返回改了几个） */
  translateEntities(indices, dx, dy) {
    let n = 0;
    for (const i of indices) {
      const e = this.entities[i];
      if (!e) continue;
      if (e.kind === "circle" || e.kind === "rect") { e.c[0] += dx; e.c[1] += dy; }
      else if (e.kind === "polyline") for (const p of e.pts) { p[0] += dx; p[1] += dy; }
      n++;
    }
    return n;
  }

  /** 绕 2D 点 (cx,cy) 旋转若干图元（角度制）。非 90° 倍数会把矩形转成折线 */
  rotateEntities(indices, deg, cx = 0, cy = 0) {
    const rad = (deg * Math.PI) / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    const q = Math.round(deg / 90) * 90;          // 是否是 90° 的整数倍
    const keepRect = Math.abs(deg - q) < 1e-9;
    let n = 0;
    for (const i of indices) {
      const orig = this.entities[i];
      if (!orig) continue;
      const e = keepRect || orig.kind === "circle" ? orig : this._toPolyline(orig);
      const rot = (x, y) => {
        const vx = x - cx, vy = y - cy;
        return [cx + vx * c - vy * s, cy + vx * s + vy * c];
      };
      if (e.kind === "circle") {
        const [nx, ny] = rot(e.c[0], e.c[1]);
        e.c = [nx, ny];
      } else if (e.kind === "rect") {
        // 只能处理 90° 倍数（此时宽高互换）
        const [nx, ny] = rot(e.c[0], e.c[1]);
        e.c = [nx, ny];
        if (Math.abs(Math.abs(deg % 180) - 90) < 1e-9) { const t = e.w; e.w = e.h; e.h = t; }
      } else if (e.kind === "polyline") {
        e.pts = e.pts.map(([x, y]) => rot(x, y));
      }
      this.entities[i] = e;
      n++;
    }
    return n;
  }

  /**
   * 关于一条 2D 直线镜像，生成**新图元**（原件按 keepOriginal 决定去留）。
   * @param line [[x1,y1],[x2,y2]]
   */
  mirrorEntities(indices, line, keepOriginal = true) {
    const [p1, p2] = line;
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) throw new Error("镜像轴的两个点重合了");
    const ux = dx / L, uy = dy / L;
    // 点 P 关于直线的镜像：v=P-p1；P' = p1 + (v·u)u − (v − (v·u)u)
    const mir = ([x, y]) => {
      const vx = x - p1[0], vy = y - p1[1];
      const dot = vx * ux + vy * uy;
      const px = dot * ux, py = dot * uy;         // 沿轴分量
      const ox = vx - px, oy = vy - py;           // 垂直分量
      return [p1[0] + px - ox, p1[1] + py - oy];
    };
    const made = [];
    const srcs = indices.map((i) => this.entities[i]).filter(Boolean);
    for (const e of srcs) {
      // ⚠ 圆必须保持为圆：转成 64 边多边形之后，拉伸出来的孔就不再是圆孔了
      // （面积也会偏小 —— 实测 4×πR² 对不上）。圆镜像后仍是圆，只动圆心。
      if (e.kind === "circle") {
        const c = mir([e.c[0], e.c[1]]);
        made.push({ kind: "circle", c, r: e.r });
        continue;
      }
      const pl = this._toPolyline(e);
      if (pl.kind === "polyline") {
        // 镜像后顶点顺序会反转，闭合图形要反过来才不会自交
        const pts = pl.pts.map(mir);
        if (pl.closed) pts.reverse();
        made.push({ kind: "polyline", pts, closed: !!pl.closed });
      }
    }
    if (!keepOriginal) {
      // 删掉原件（从大到小删，避免下标错位）
      [...indices].sort((a, b) => b - a).forEach((i) => this.entities.splice(i, 1));
    }
    this.entities.push(...made);
    return made.length;
  }

  /** 矩形阵列：以选中的图元为模板，排 rows×cols（含原件本身那格） */
  arrayRect(indices, rows, cols, dx, dy) {
    const R = Math.max(1, Math.round(rows)), C = Math.max(1, Math.round(cols));
    if (R * C <= 1) return 0;
    // 圆不转多边形（否则阵列出来的孔不是圆孔）
    const srcs = indices.map((i) => this.entities[i]).filter(Boolean)
      .map((e) => (e.kind === "circle" ? JSON.parse(JSON.stringify(e)) : this._toPolyline(e)));
    const made = [];
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        if (r === 0 && c === 0) continue;        // 原件占 (0,0)
        for (const e of srcs) {
          const copy = JSON.parse(JSON.stringify(e));
          if (copy.kind === "polyline") for (const p of copy.pts) { p[0] += c * dx; p[1] += r * dy; }
          else { copy.c[0] += c * dx; copy.c[1] += r * dy; }
          made.push(copy);
        }
      }
    }
    this.entities.push(...made);
    return made.length;
  }

  /** 圆周阵列：以选中的图元为模板，绕 (cx,cy) 均匀排 count 份（含原件） */
  arrayPolar(indices, count, cx, cy, full = true) {
    const n = Math.max(2, Math.round(count));
    const step = full ? 360 / n : 360 / (n - 1 || 1);
    const srcs = indices.map((i) => this.entities[i]).filter(Boolean)
      .map((e) => (e.kind === "circle" ? JSON.parse(JSON.stringify(e)) : this._toPolyline(e)));
    const made = [];
    for (let k = 1; k < n; k++) {
      const rad = ((step * k) * Math.PI) / 180;
      const c = Math.cos(rad), s = Math.sin(rad);
      const rot = ([x, y]) => {
        const vx = x - cx, vy = y - cy;
        return [cx + vx * c - vy * s, cy + vx * s + vy * c];
      };
      for (const e of srcs) {
        const copy = e.kind === "circle" ? { kind: "circle", c: [...e.c], r: e.r } : JSON.parse(JSON.stringify(e));
        if (copy.kind === "polyline") copy.pts = copy.pts.map(rot);
        else { const [nx, ny] = rot(copy.c); copy.c = [nx, ny]; }
        made.push(copy);
      }
    }
    this.entities.push(...made);
    return made.length;
  }

  /** 选中图元的 2D 包围盒（阵列/镜像要拿它当默认参数） */
  boundsOf(indices) {
    const xs = [], ys = [];
    for (const i of indices) {
      const e = this.entities[i];
      if (!e) continue;
      if (e.kind === "rect") {
        xs.push(e.c[0] - e.w / 2, e.c[0] + e.w / 2);
        ys.push(e.c[1] - e.h / 2, e.c[1] + e.h / 2);
      } else if (e.kind === "circle") {
        xs.push(e.c[0] - e.r, e.c[0] + e.r);
        ys.push(e.c[1] - e.r, e.c[1] + e.r);
      } else if (e.kind === "polyline") {
        for (const p of e.pts) { xs.push(p[0]); ys.push(p[1]); }
      }
    }
    if (!xs.length) return null;
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }

  /** 生成并直接作用到实体上（正 = 加料，负 = 挖料） */
  /**
   * 从某条已存在的线（矩形/折线的某一段）的端点接着画：
   * 把那条线的点**整个接进草稿**，并把原图元删掉（它被并入了新折线）。
   * @param fromEnd true = 从末点往起点方向接
   *
   * 为什么需要它：直线工具改成"两点一条线、自动收尾"之后，想画多边形就得
   * 连续从端点起笔 —— 不把原有线段并进来的话，第二次起笔只能得到一条 2 点短线，
   * 永远闭不成多边形（实测把多边形能力砍掉了）。
   */
  chainFromEndpoint(eIdx, fromEnd) {
    const src = this.entities[eIdx];
    if (!src) return null;
    let pts = null;
    if (src.kind === "polyline") pts = src.pts.map((q) => [q[0], q[1]]);
    else if (src.kind === "rect") {
      const hw = src.w / 2, hh = src.h / 2;
      pts = [[src.c[0] - hw, src.c[1] - hh], [src.c[0] + hw, src.c[1] - hh],
             [src.c[0] + hw, src.c[1] + hh], [src.c[0] - hw, src.c[1] + hh]];
    }
    if (!pts || pts.length < 2) return null;
    if (fromEnd) pts = pts.slice().reverse();
    this.entities.splice(eIdx, 1);
    this._draft = { kind: "polyline", pts, closed: false };
    return this._draft;
  }

  apply(depth, grow = 0) {
    if (!this.shape && depth <= 0) throw new Error("请先拉伸生成实体，再进行切除");
    const tool = this.buildSolid(depth, grow);
    if (!tool) throw new Error("没有可拉伸的闭合轮廓");
    // 记下本次长出来的那块材料 —— 阵列/镜像要复用它，而不是复制整个零件
    this._lastTool = tool;
    if (!this.shape) return tool;
    return depth > 0 ? this.shape.fuse(tool) : this.shape.cut(tool);
  }

  /** 当前会参与出实体的轮廓数量（界面提示用） */
  get contourCount() {
    return this.activeEntities.length;
  }

  // ---------------------------------------------------------- 预览线
  _lines(list, cursor = null) {
    const segs = [];
    const push = (a, b) => { segs.push(a.x, a.y, a.z, b.x, b.y, b.z); };
    const addRectSeg = (e) => {
      const [cx, cy] = e.c, hw = e.w / 2, hh = e.h / 2;
      const pts = [
        this.to3D(cx - hw, cy - hh), this.to3D(cx + hw, cy - hh),
        this.to3D(cx + hw, cy + hh), this.to3D(cx - hw, cy + hh),
      ];
      for (let i = 0; i < 4; i++) push(pts[i], pts[(i + 1) % 4]);
    };
    const addCircleSeg = (e) => {
      const N = 64, [cx, cy] = e.c;
      let prev = this.to3D(cx + e.r, cy);
      for (let i = 1; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        const p = this.to3D(cx + Math.cos(a) * e.r, cy + Math.sin(a) * e.r);
        push(prev, p);
        prev = p;
      }
    };
    const addPolySeg = (e, cur) => {
      const P = e.pts;
      for (let i = 0; i < P.length - 1; i++) {
        push(this.to3D(P[i][0], P[i][1]), this.to3D(P[i + 1][0], P[i + 1][1]));
      }
      if (e.closed && P.length > 2) {
        push(this.to3D(P[P.length - 1][0], P[P.length - 1][1]), this.to3D(P[0][0], P[0][1]));
      }
      // 橡皮筋：从最后一点连到手指当前位置
      if (cur && P.length) {
        push(this.to3D(P[P.length - 1][0], P[P.length - 1][1]), this.to3D(cur.x, cur.y));
      }
    };
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const isLast = i === list.length - 1;
      if (e.kind === "rect") addRectSeg(e);
      else if (e.kind === "circle") addCircleSeg(e);
      else addPolySeg(e, isLast ? cursor : null);
    }
    return new Float32Array(segs);
  }

  /**
   * 草图 2D 坐标 → **世界坐标**。
   *
   * ⚠ 高亮、预览线这类"直接塞给 three.js 的顶点数组"必须走这里。
   * 之前 highlightElements 图省事写了 `[x, y, 0]`，结果选中高亮全画在
   * 世界 z=0 平面上（草图平面在板顶面 z=8），黄线跑到模型外面去了 —— 实测踩到。
   */
  toWorld2(p2, z = 0) {
    const o = this.origin, X = this.xDir, Y = this.yDir, N = this.normal;
    return [
      o.x + X.x * p2[0] + Y.x * p2[1] + N.x * z,
      o.y + X.y * p2[0] + Y.y * p2[1] + N.y * z,
      o.z + X.z * p2[0] + Y.z * p2[1] + N.z * z,
    ];
  }

  /** 已完成轮廓的线段 */
  toLines() { return this._lines(this.entities); }

  /** 含正在画的折线草稿（cursor 是手指当前位置，用来画橡皮筋） */
  toLinesWithDraft(cursor = null) {
    const list = this._draft ? [...this.entities, this._draft] : this.entities;
    return this._lines(list, this._draft ? cursor : null);
  }

  /**
   * **只要**正在画的那条草稿（含橡皮筋）。
   *
   * 用它把草稿单独送进 viewer 的「预览」槽（matSketchPreview，实线琥珀色）；
   * 之前草稿混在 toLinesWithDraft 里跟已完成轮廓一个材质（绿色实线），
   * 用户分不出"这条还没提交"—— 也正是预览线与推理虚线糊成一条的根因。
   */
  draftLines(cursor = null) {
    return this._draft ? this._lines([this._draft], cursor) : null;
  }

  /** 单个图形的线段（实时预览用） */
  lineOf(e) { return e ? this._lines([e]) : null; }
}
