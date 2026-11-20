/**
 * three.js 视口：显示 OCCT 实体、CAD 棱边、选中高亮、拾取
 */
import * as THREE from "three";
import { MeshBVH, acceleratedRaycast } from "three-mesh-bvh";
import { OrbitCam } from "./camera.js";
import { faceIdFromTriangle, faceRangeOf } from "./kernel.js";
import { renderPixelRatio, readGpuName, gpuTier, RenderGovernor } from "./render-budget.js";
import { EdgeProjectionCache, pickNearestEdge, faceHighlightData } from "./perf-pick.js";

/** 该面高亮几何的缓存上限（超出就整体丢弃，避免长时间会话里无限增长） */
const FACE_CACHE_LIMIT = 48;

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: true, powerPreference: "high-performance",
    });
    this._touchDisplay = (navigator.maxTouchPoints || 0) > 0;
    this._previewQuality = false;
    this.renderer.setClearAlpha(0);
    // 玄戒 O1 的 Immortalis-G925 属于旗舰档，允许渲染预算超出基线；
    // 识别不到就维持基线，不去赌一块未知的 GPU。
    this.governor = new RenderGovernor({ tier: gpuTier(readGpuName(this.renderer.getContext())) });
    // 每帧只测一次画布矩形：dim.sync / drawSnapOverlay 都会写 style.transform，
    // 各自再调 getBoundingClientRect 就是 120Hz 下的强制同步布局（layout thrash）。
    this._rect = null;
    this._lastFrameAt = 0;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 20000);
    this.camera.up.set(0, 0, 1);        // CAD 惯例 Z-up（与 camera.js 的 WORLD_UP 一致）

    // 光照：一盏天光 + 相机跟随的主光，让实体在任意角度都有立体感
    const hemi = new THREE.HemisphereLight(0xffffff, 0x30343c, 2.2);
    hemi.position.set(0, 0, 1);          // Z-up 下天光来自 +Z
    this.scene.add(hemi);
    this.key = new THREE.DirectionalLight(0xffffff, 2.4);
    this.scene.add(this.key);
    this.fill = new THREE.DirectionalLight(0xbfd4ff, 0.9);
    this.fill.position.set(-1, -1, -0.6);
    this.scene.add(this.fill);

    // 材质
    this.matBody = new THREE.MeshStandardMaterial({
      color: 0xc8c0b3, metalness: 0.06, roughness: 0.68, flatShading: true,
    });
    this.matPick = new THREE.MeshStandardMaterial({
      color: 0xe2967a, metalness: 0.08, roughness: 0.55, flatShading: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.matEdge = new THREE.LineBasicMaterial({ color: 0x423e36, transparent: true, opacity: 0.6 });
    this.matPickEdge = new THREE.LineBasicMaterial({ color: 0xbf5634, transparent: true, opacity: 0.95 });
    // 草图线：depthTest 关掉，保证被实体挡住的轮廓也能看见（画图时必须看得到自己在画什么）
    this.matSketch = new THREE.LineBasicMaterial({ color: 0x2d713b, depthTest: false, transparent: true, opacity: 0.98 });
    this.matSketchPreview = new THREE.LineBasicMaterial({ color: 0x956000, depthTest: false, transparent: true, opacity: 0.95 });
    // 选中的边：橙红，压在实体上，深度测试关掉保证被挡住的也能看见
    this.matEdgeHi = new THREE.LineBasicMaterial({ color: 0xbf5634, depthTest: false, transparent: true, opacity: 1 });
    // 深琥珀预览线在浅色画布与实体上都保持清晰。
    this.matPreviewWire = new THREE.LineBasicMaterial({ color: 0x956000, depthTest: false, transparent: true, opacity: 0.95 });

    // 容器
    this.body = new THREE.Group();
    this.overlay = new THREE.Group();
    this.scene.add(this.body, this.overlay);

    this.solidMesh = null;
    this.edgeMesh = null;
    this.pickMesh = null;
    this.pickEdge = null;
    this.meshData = null;
    this.raycaster = new THREE.Raycaster();
    // 拾取只需要最近的一个交点，命中就停（BVH 的 firstHitOnly 靠它提前剪枝）
    this.raycaster.firstHitOnly = true;
    this._edgeCache = new EdgeProjectionCache();
    this._faceCache = new Map();      // faceId → {mesh, edge} 高亮几何（跟着网格失效）

    this.cam = new OrbitCam(this.camera, canvas);
    this._needRender = true;
    this.cam.onTap = (pt) => this._tap(pt);

    this.resize();
    window.addEventListener("resize", () => this.resize());
    window.addEventListener("orientationchange", () => setTimeout(() => this.resize(), 250));
    // A hidden WebView must not keep scheduling GPU work. Restore on return.
    document.addEventListener("visibilitychange", () => {
      this._suspended = document.hidden;
      if (this._suspended) {
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = 0;
      } else { this.resize(); }
    });
    const settleQuality = () => {
      clearTimeout(this._qualityTimer);
      this._qualityTimer = setTimeout(() => {
        if (!this.cam.pointers.size && !this._previewQuality) this.setInteractiveQuality(false);
      }, 140);
    };
    canvas.addEventListener("pointerdown", () => this.setInteractiveQuality(true));
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) canvas.addEventListener(event, settleQuality);
    canvas.addEventListener("wheel", () => { this.setInteractiveQuality(true); settleQuality(); }, { passive: true });

    // 相机一动就重绘
    const origUpdate = this.cam.update.bind(this.cam);
    this.cam.update = () => { origUpdate(); this.invalidate(); };
  }

  invalidate() {
    this._needRender = true;
    if (!this._suspended && !this._raf) this._raf = requestAnimationFrame(this._loop);
  }

  /** 渲染次数（调试用：静止时不应该持续增长，否则就是空转烧 CPU） */
  get renderCount() { return this._renderCount || 0; }

  _loop = () => {
    if (!this._needRender) { this._raf = 0; return; }
    // 保留当前 RAF 标记直到 update 结束，避免相机的 invalidate 再排一帧。
    // 静止时不再持续唤醒 JS，减少高刷平板上的耗电。
    this.cam.update();
    this._needRender = false;
    this._raf = 0;
    // 帧缓冲尺寸可能刚被调节器改过，矩形要在写任何 style 之前取一次。
    this._rect = this.canvas.getBoundingClientRect();
    this._sampleFrame();
    // 主光跟随相机（Z-up：抬高放在 +Z 方向），保证任何角度都有明暗对比
    const d = this.cam.dir;
    this.key.position.set(
      this.camera.position.x - d.x * 100 + 60,
      this.camera.position.y - d.y * 100 + 60,
      this.camera.position.z - d.z * 100 + 120,
    );
    this._renderCount = (this._renderCount || 0) + 1;
    this.renderer.render(this.scene, this.camera);
    // 每帧通知外部（尺寸手柄要跟着相机走），把本帧的矩形一并传下去复用。
    this.onFrame?.(this._rect);
  };

  /**
   * 用连续帧间隔估计真实吞吐，驱动渲染预算。
   * 只在连续交互期间采样：静止时是按需渲染，间隔长短不代表性能。
   */
  _sampleFrame() {
    const now = performance.now();
    const gap = this._lastFrameAt ? now - this._lastFrameAt : 0;
    this._lastFrameAt = now;
    if (!this._interactiveQuality) { this.governor?.reset(); return; }
    // 超过 120ms 说明中间停顿过，这一段不能算作连续交互。
    if (gap > 0 && gap < 120) this.governor?.sample(gap);
    if (this.governor?.consumeChanged()) { this.resize(); return; }
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const scale = this._interactiveQuality ? this.governor?.scale : this.governor?.idleScale;
    const ratio = renderPixelRatio(w, h, window.devicePixelRatio || 1, this._touchDisplay,
      this._interactiveQuality, scale ?? 1);
    if (this.renderer.getPixelRatio() !== ratio) this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  setInteractiveQuality(active) {
    if (this._interactiveQuality === active) return;
    this._interactiveQuality = active;
    this.resize();
  }

  /** 用内核给的网格数据重建显示对象 */
  /**
   * 设置要显示的实体网格。
   *
   * ⚠ 支持传 **null**（清空视图）：模型被整个删掉之后必须能把网格摘掉，
   * 否则屏幕上还留着上一个零件的形状 —— 用户实测报过"删了初始零件但零件还在"。
   * 之前这里直接读 meshData.vertices，传 null 会抛错，调用方又用 try/catch 吞掉了。
   */
  setMesh(meshData, { fit = false, preview = false } = {}) {
    this._previewQuality = preview;
    this.setInteractiveQuality(preview || !!this.cam?.pointers.size);
    this.meshData = meshData;
    this.clearHighlight();
    this.highlightEdges([]);

    if (this.solidMesh) { this.body.remove(this.solidMesh); this.solidMesh.geometry.dispose(); this.solidMesh = null; }
    if (this.edgeMesh) { this.body.remove(this.edgeMesh); this.edgeMesh.geometry.dispose(); this.edgeMesh = null; }
    // 网格一换，按面缓存的高亮几何就全部失效（faceId / 顶点都已经变了）
    this._disposeFaceCache();

    if (!meshData) {
      this.geometry = null;
      this._bbox = null;
      this.setEdgeData([]);
      this.clearPreviewWire();
      this.clearSketchLines();
      this.invalidate();
      return;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(meshData.vertices, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(meshData.normals, 3));
    g.setIndex(new THREE.BufferAttribute(meshData.triangles, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    g.userData.faceGroups = meshData.faceGroups;
    this.geometry = g;

    this.solidMesh = new THREE.Mesh(g, this.matBody);
    // 有 boundsTree 就走 BVH，没有就自动退回 three 原本的 raycast —— 
    // 预览/片体这些没有 BVH 的网格行为完全不变
    this.solidMesh.raycast = acceleratedRaycast;
    this._bvhMs = 0;
    this.body.add(this.solidMesh);

    // CAD 棱边：优先用内核的拓扑边（OCCT 直接出的真棱边，跟三角数无关）；
    // 内核没给（片体 / 老调用方）就退回 EdgesGeometry 的夹角法。
    // Edge extraction hashes every triangle: defer it until the precise commit.
    // The preview remains a real shaded solid, including visible diameter changes.
    if (!preview) {
      const eg = meshData.edges?.positions?.length
        ? this._edgeGeometryFromKernel(meshData.edges)
        : new THREE.EdgesGeometry(g, 18);
      this.edgeMesh = new THREE.LineSegments(eg, this.matEdge);
      this.body.add(this.edgeMesh);
    }

    this._bbox = g.boundingBox.clone();
    // 提交完成后趁空闲把 BVH 建好，别让用户第一次点模型时卡一下
    if (!preview) this._scheduleBVH(g);
    if (fit) {
      // Sidebar changes can resize the canvas before their scheduled resize callback.
      this.resize();
      this.cam.fit(this._bbox);
    }
    this.invalidate();
  }

  /** 高亮一个拓扑面（按 faceId） */
  highlightFace(faceId) {
    this.clearHighlight();
    if (faceId == null || !this.meshData || !this.geometry) return;
    const entry = this._highlightFor(faceId);
    if (!entry) return;
    this.pickMesh = entry.mesh;
    this.overlay.add(this.pickMesh);
    this.pickEdge = entry.edge;
    this.overlay.add(this.pickEdge);
    this.invalidate();
  }

  /**
   * 按面取（或构建）高亮几何。
   *
   * 原来是每次 highlightFace 都重新 push 三个数组 + new EdgesGeometry：
   * 拖动预览里 remapSelection 每帧都会重新高亮同一个面，等于每帧重建一遍。
   * 面的三角在索引缓冲里本来就是连续一段，按 faceId 缓存住就行；
   * 网格一换（setMesh）整张缓存丢弃，不会串到别的零件上。
   */
  _highlightFor(faceId) {
    const cache = this._faceCache || (this._faceCache = new Map());
    const cached = cache.get(faceId);
    if (cached) return cached;
    const range = faceRangeOf(this.meshData.faceGroups, faceId);
    if (!range || !range.count) return null;
    const data = faceHighlightData(this.meshData, faceId, range);
    const hg = new THREE.BufferGeometry();
    hg.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    hg.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
    hg.setIndex(new THREE.BufferAttribute(data.indices, 1));
    // 面的轮廓线：单个面的三角很少，EdgesGeometry 在这里很便宜（实测 <0.1ms）
    const pe = new THREE.EdgesGeometry(hg, 18);
    const entry = {
      mesh: new THREE.Mesh(hg, this.matPick),
      edge: new THREE.LineSegments(pe, this.matPickEdge),
      tris: data.tris,
    };
    if (this._faceCache.size >= FACE_CACHE_LIMIT) this._disposeFaceCache();
    cache.set(faceId, entry);
    return entry;
  }

  _disposeFaceCache() {
    if (!this._faceCache) return;
    for (const entry of this._faceCache.values()) {
      entry.mesh.geometry.dispose();
      entry.edge.geometry.dispose();
    }
    this._faceCache.clear();
  }

  /** 屏幕上一条边的折线 → 可直接渲染的 LineSegments 几何（点不复制，用索引跳组） */
  _edgeGeometryFromKernel(edges) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(edges.positions, 3));
    g.setIndex(new THREE.BufferAttribute(edges.index, 1));
    return g;
  }

  clearHighlight() {
    if (this.pickMesh) this.overlay.remove(this.pickMesh);
    if (this.pickEdge) this.overlay.remove(this.pickEdge);
    // 几何是缓存里的，这里不能 dispose —— 只摘掉场景节点
    this.pickMesh = this.pickEdge = null;
    this.invalidate();
  }

  /**
   * 预览线框（拉伸/圆角的实时预览）。
   *
   * 为什么单独开一条通道：以前拖动时是"重建实体 + 重新网格化"，
   * 一次要跑内核几十毫秒；改成只画几条线之后是**纯几何计算，微秒级**，
   * 而且完全不动 shape —— SolidWorks 拖动时显示黄色线框正是这个道理。
   */
  setPreviewWire(arr) {
    if (this.previewWire) {
      this.overlay.remove(this.previewWire);
      this.previewWire.geometry.dispose();
      this.previewWire = null;
    }
    if (arr && arr.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      this.previewWire = new THREE.LineSegments(g, this.matPreviewWire);
      this.overlay.add(this.previewWire);
    }
    this.invalidate();
  }

  clearPreviewWire() { this.setPreviewWire(null); }

  /** 设置草图线（已完成轮廓 + 正在画的预览） */
  setSketchLines(done, preview = null) {
    for (const k of ["sketchDone", "sketchPrev"]) {
      if (this[k]) { this.overlay.remove(this[k]); this[k].geometry.dispose(); this[k] = null; }
    }
    const build = (arr, mat, key) => {
      if (!arr || !arr.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      this[key] = new THREE.LineSegments(g, mat);
      this.overlay.add(this[key]);
    };
    build(done, this.matSketch, "sketchDone");
    build(preview, this.matSketchPreview, "sketchPrev");
    this.invalidate();
  }

  clearSketchLines() { this.setSketchLines(null, null); }

  // ------------------------------------------------------------ 边拾取（圆角/倒角用）
  /** 缓存边的离散点（由 refresh 时传入） */
  setEdgeData(list) {
    this.edgeData = list || [];
    // 同一个数组也可能被上层就地改写（补 dir/n1/n2），所以这里无条件让投影缓存失效
    this._edgeCache?.invalidate();
  }

  /**
   * 屏幕坐标 → 最近的拓扑边
   * 在屏幕空间做距离检测：模型边通常只有 1~2px 宽，用手指点不精确，
   * 所以给 28px 容差，取最近的一条。
   *
   * 投影结果按「相机指纹 + edgeData 身份」缓存：连点时相机不动，一次都不重算。
   */
  pickEdgeAt(clientX, clientY, maxPx = 28) {
    if (!this.edgeData || !this.edgeData.length) return null;
    const r = this.canvas.getBoundingClientRect();
    const projected = (this._edgeCache || (this._edgeCache = new EdgeProjectionCache()))
      .get(this.edgeData, this.camera, r.width, r.height);
    return pickNearestEdge(projected, clientX - r.left, clientY - r.top, maxPx);
  }

  /** 高亮一组边（传 edgePointSets 的条目数组） */
  highlightEdges(items) {
    if (this.edgeHi) { this.overlay.remove(this.edgeHi); this.edgeHi.geometry.dispose(); this.edgeHi = null; }
    if (items && items.length) {
      const segs = [];
      for (const e of items) {
        for (let i = 0; i < e.pts.length - 1; i++) {
          segs.push(e.pts[i][0], e.pts[i][1], e.pts[i][2],
                    e.pts[i + 1][0], e.pts[i + 1][1], e.pts[i + 1][2]);
        }
      }
      if (segs.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(segs), 3));
        this.edgeHi = new THREE.LineSegments(g, this.matEdgeHi);
        this.overlay.add(this.edgeHi);
      }
    }
    this.invalidate();
  }

  /** 屏幕坐标 → 命中的拓扑面（供拾取与手势判定共用） */
  pickAt(clientX, clientY) {
    if (!this.solidMesh || !this.meshData) return null;
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
    this._ensureBVH();
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.solidMesh, false);
    if (!hits.length) return null;
    const triIndex = hits[0].faceIndex;
    const faceId = faceIdFromTriangle(this.meshData.faceGroups, triIndex);
    return { faceId, point: hits[0].point, distance: hits[0].distance };
  }

  /**
   * 按需建 BVH（点云不必在提交时就付这笔钱）。
   *
   * 实测：10 万三角的网格上 1000 次射线拾取，线性遍历 493ms；建 BVH 一次 ~40-90ms，
   * 之后每次射线只走 O(log n)。零件越大越是数量级差距，小零件（1~3k 三角）建表
   * 只要 1~2ms，也不虧。第一次拾取才会建，所以「打开工程 / 提交重建」这两条
   * 最敏感的路径不会被它拖慢。
   */
  _ensureBVH() {
    const g = this.geometry;
    if (!g || g.boundsTree || g.__bvhFailed) return;
    const t0 = performance.now();
    try {
      /*
       * ⚠ 必须 indirect: true。
       *
       * MeshBVH 默认会把几何的索引缓冲**就地重排**（按 BVH 节点顺序），
       * 而这块索引就是 meshData.triangles —— faceGroups 的 start/count 是**原始顺序**下的
       * 三角区间，被重排之后「面 → 三角形」的映射全部错位：高亮会亮到别的面上，
       * 而且渲染用的是同一块索引（模型本身也会跟着乱）。
       * indirect 模式另外存一张间接表，几何索引一个字节都不动，
       * 交点里的 faceIndex 仍会映射回原始三角序号。
       */
      g.boundsTree = new MeshBVH(g, { targetLeafSize: 10, indirect: true });
    } catch (_) {
      g.__bvhFailed = true;      // 建不起来就退回线性 raycast，宁可慢也不能错
    }
    this._bvhMs = (this._bvhMs || 0) + (performance.now() - t0);
  }

  /**
   * 空闲时预建 BVH。
   * 只在浏览器里有 requestIdleCallback 时才做；node/测试环境没有就保持「首次拾取再建」。
   * 回调里先确认几何还是当前这块 —— 期间又 setMesh 过一次的话，别给死几何建表。
   */
  _scheduleBVH(geometry) {
    if (typeof requestIdleCallback !== "function") return;
    try {
      requestIdleCallback(() => {
        if (this.geometry !== geometry) return;
        this._ensureBVH();
      }, { timeout: 1500 });
    } catch (_) { /* 老 WebView 上个别版本会抛，忽略 */ }
  }

  /** 点击 → 通知上层选中（带上屏幕坐标，选边时需要） */
  _tap({ x, y }) {
    const hit = this.pickAt(x, y);
    this.onPick?.(hit ? hit.faceId : null, hit ? hit.point : null, { x, y });
  }

  /** 拾取点沿面法向的参考方向 */
  faceNormalAt(faceId) {
    if (!this.meshData) return new THREE.Vector3(0, 0, 1);
    const g = this.meshData.faceGroups.find((x) => x.faceId === faceId);
    if (!g || !this.geometry) return new THREE.Vector3(0, 0, 1);
    const idx = this.geometry.getIndex().array;
    const nor = this.geometry.getAttribute("normal").array;
    const v = idx[g.start * 3];
    return new THREE.Vector3(nor[v * 3], nor[v * 3 + 1], nor[v * 3 + 2]).normalize();
  }

  get bbox() { return this._bbox; }
}
