/**
 * 世界坐标系：原点 + 三条轴 + 三个可点击的基准面（XY / XZ / YZ）
 * 点基准面即可在「世界坐标系」上做草图，不必依赖已有实体表面。
 */
import * as THREE from "three";

export class Datum {
  constructor(viewer) {
    this.viewer = viewer;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.picker = [];            // { mesh, plane: {origin, normal, xDir, name} }
    this.custom = [];            // 自定义参考几何体（基准面/轴/点/坐标系）
    this.hovered = null;
    viewer.scene.add(this.group);
    this._build();
  }

  _build() {
    const S = 60;                // 半边长（mm）：三张 120×120 的基准面
    const defs = [
      { name: "XY", normal: [0, 0, 1], xDir: [1, 0, 0], color: 0x3a72b5 },
      { name: "XZ", normal: [0, -1, 0], xDir: [1, 0, 0], color: 0x248454 },
      { name: "YZ", normal: [1, 0, 0], xDir: [0, 1, 0], color: 0xad6c10 },
    ];

    for (const d of defs) {
      const g = this._makePlane({ ...d, origin: [0, 0, 0], size: S, standard: true });
      this.picker.push(g);
    }

    // 三条坐标轴（带箭头），红 X / 绿 Y / 蓝 Z
    const AX = 42;
    const axes = [
      [new THREE.Vector3(1, 0, 0), 0xc83e3e],
      [new THREE.Vector3(0, 1, 0), 0x15804b],
      [new THREE.Vector3(0, 0, 1), 0x236ab3],
    ];
    for (const [dir, color] of axes) {
      const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), AX, color, 5, 3);
      // depthTest 关掉：轴线常常落在零件内部，不这样根本看不见
      arrow.line.material.transparent = true;
      arrow.line.material.opacity = 0.9;
      arrow.line.material.depthTest = false;
      arrow.cone.material.depthTest = false;
      arrow.renderOrder = 5;
      this.group.add(arrow);
    }

    // 原点小球（同样穿透显示）
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(1.8, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x475569, depthTest: false }),
    );
    dot.renderOrder = 6;
    this.custom.push({ mesh: dot, kind: "origin" });
    this.group.add(dot);
  }

  // ---------------------------------------------------------------- 参考几何体（自定义）
  /**
   * 造一张基准面并加进场景。
   * @param def { name, origin:[x,y,z], normal:[..], xDir:[..], color, size, standard }
   * @returns picker 项（可被 pick 命中）
   */
  _makePlane(def) {
    const S = def.size || 40;
    const n = new THREE.Vector3(...def.normal).normalize();
    const x = new THREE.Vector3(...def.xDir).normalize();
    // xDir 必须与法向垂直，否则叉乘出来的 y 会歪
    x.sub(n.clone().multiplyScalar(x.dot(n)));
    if (x.lengthSq() < 1e-9) x.set(1, 0, 0).sub(n.clone().multiplyScalar(n.x));
    x.normalize();
    const y = new THREE.Vector3().crossVectors(n, x).normalize();
    const origin = new THREE.Vector3(...def.origin);
    const color = def.color != null ? def.color : 0x9b6bff;

    const geo = new THREE.PlaneGeometry(S * 2, S * 2);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: def.standard ? 0.055 : 0.10,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    mesh.quaternion.copy(q);
    mesh.position.copy(origin);
    mesh.userData.datum = def.name;
    this.group.add(mesh);

    const pts = [];
    const corners = [[-S, -S], [S, -S], [S, S], [-S, S]];
    for (let i = 0; i < 4; i++) {
      const [a, b] = corners[i], [c, e] = corners[(i + 1) % 4];
      const p1 = origin.clone().addScaledVector(x, a).addScaledVector(y, b);
      const p2 = origin.clone().addScaledVector(x, c).addScaledVector(y, e);
      pts.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
    const line = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({
      color, transparent: true, opacity: def.standard ? 0.32 : 0.65,
    }));
    this.group.add(line);

    this.custom.push({ mesh, line, kind: "plane", name: def.name });
    return { mesh, plane: { origin, normal: n, xDir: x, yDir: y, name: def.name, standard: !!def.standard } };
  }

  /**
   * 造一条基准轴。用细圆柱 + 两端锥，depthTest 关掉（轴线常落在零件里）。
   * @param def { name, origin, dir, length, color }
   */
  _makeAxis(def) {
    const o = new THREE.Vector3(...def.origin);
    const d = new THREE.Vector3(...def.dir).normalize();
    const L = def.length || 60;
    const color = def.color != null ? def.color : 0x00d4ff;
    const g = new THREE.Group();
    // 线本身
    const p1 = o.clone().addScaledVector(d, -L / 2);
    const p2 = o.clone().addScaledVector(d, L / 2);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.BufferAttribute(new Float32Array([p1.x, p1.y, p1.z, p2.x, p2.y, p2.z]), 3));
    const mat = new THREE.LineDashedMaterial({ color, dashSize: 3, gapSize: 2, transparent: true, opacity: 0.95 });
    const line = new THREE.Line(lg, mat);
    line.computeLineDistances();
    line.material.depthTest = false;
    line.renderOrder = 7;
    g.add(line);
    const tip = new THREE.Mesh(
      new THREE.SphereGeometry(1.2, 12, 10),
      new THREE.MeshBasicMaterial({ color, depthTest: false }),
    );
    tip.position.copy(p1);
    tip.renderOrder = 7;
    g.add(tip);
    this.group.add(g);
    this.custom.push({ mesh: g, kind: "axis", name: def.name });
    return g;
  }

  /**
   * 造一个参考点。命中体是个小球（pick 用），外面套一圈环更好认。
   */
  _makePoint(def) {
    const p = new THREE.Vector3(...def.p);
    const color = def.color != null ? def.color : 0xffd400;
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(1.6, 14, 10),
      new THREE.MeshBasicMaterial({ color, depthTest: false }),
    );
    dot.position.copy(p);
    dot.renderOrder = 8;
    this.group.add(dot);
    this.custom.push({ mesh: dot, kind: "point", name: def.name });
    return dot;
  }

  /**
   * 造一个坐标系（三根短箭头 + 原点球），用于定位/对齐参考。
   */
  _makeCsys(def) {
    const o = new THREE.Vector3(...def.origin);
    const color = def.color != null ? def.color : 0xff8a3d;
    const g = new THREE.Group();
    const L = def.length || 18;
    const axes = [
      [new THREE.Vector3(1, 0, 0), 0xff4d4d],
      [new THREE.Vector3(0, 1, 0), 0x4dff88],
      [new THREE.Vector3(0, 0, 1), 0x4d9dff],
    ];
    for (const [dir, c] of axes) {
      const a = new THREE.ArrowHelper(dir, o, L, c, 3, 1.6);
      a.line.material.depthTest = false;
      a.cone.material.depthTest = false;
      a.renderOrder = 7;
      g.add(a);
    }
    this.group.add(g);
    this.custom.push({ mesh: g, kind: "csys", name: def.name });
    return g;
  }

  /** 按定义加一个参考几何体（plane/axis/point/csys） */
  add(def) {
    if (!def || !def.type) return null;
    if (def.type === "plane") {
      const g = this._makePlane({ ...def, standard: false });
      this.picker.push(g);
      return g;
    }
    if (def.type === "axis") return this._makeAxis(def);
    if (def.type === "point") return this._makePoint(def);
    if (def.type === "csys") return this._makeCsys(def);
    return null;
  }

  /** 清空所有自定义参考几何体（重建场景时用） */
  clearCustom() {
    for (const c of this.custom) {
      if (c.kind === "origin") continue;      // 原点小球留着
      try { this.group.remove(c.mesh); } catch (_) {}
      // 从 picker 里摘掉对应的项
      const i = this.picker.findIndex((p) => p.mesh === c.mesh);
      if (i >= 0) this.picker.splice(i, 1);
    }
    this.custom = this.custom.filter((c) => c.kind === "origin");
    this.viewer.invalidate();
  }

  setVisible(v) {
    this.group.visible = !!v;
    this.viewer.invalidate();
  }
  get visible() { return this.group.visible; }

  /** 屏幕坐标 → 命中的基准面（优先返回最靠近相机的那个） */
  pick(clientX, clientY) {
    if (!this.group.visible) return null;
    const r = this.viewer.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
    this.viewer.raycaster.setFromCamera(ndc, this.viewer.camera);
    const meshes = this.picker.map((p) => p.mesh);
    const hits = this.viewer.raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const found = this.picker.find((p) => p.mesh === hits[0].object);
    return found ? { ...found.plane, point: hits[0].point } : null;
  }

  /** 悬停高亮 */
  hover(planeName) {
    if (this.hovered === planeName) return;
    this.hovered = planeName;
    for (const p of this.picker) {
      const on = p.plane.name === planeName;
      p.mesh.material.opacity = on ? 0.22 : 0.055;
    }
    this.viewer.invalidate();
  }
}
