/**
 * 拾取用的纯计算工具（不碰 WebGL、不碰 DOM，node 里可以直接跑基准）
 *
 * 两件事：
 *   1) 边拾取的屏幕投影缓存 —— 原来 pickEdgeAt 每次都把所有边的所有采样点
 *      重新 project 一遍（小件 71 边 × 15 点 = 1065 次投影，复杂件上千次）。
 *      相机的投影矩阵没变时，屏幕坐标也没变，没必要重算。
 *   2) 屏幕空间最近线段 —— 与原来的 distToSeg 语义逐位一致。
 *
 * 缓存的签名取「真正参与 project 的两张矩阵」：
 *   camera.matrixWorldInverse（视图）× camera.projectionMatrix（投影）
 * Vector3.project 用的就是这两个，所以只要这两张矩阵不变，投影结果必然相同。
 * 不用「相机版本号」：相机也可能被别的模块（视图控件 / fit / 脚本）直接改，
 * 指纹法不会漏。
 */
import * as THREE from "three";

const _v = new THREE.Vector3();

/** 相机指纹：视图 × 投影矩阵 + 画布尺寸，全部量化后混成一个整数 */
export function cameraKey(camera, width, height) {
  const v = camera.matrixWorldInverse.elements;
  const p = camera.projectionMatrix.elements;
  let h = 2166136261;
  for (let i = 0; i < 16; i++) {
    h = Math.imul(h ^ Math.round((v[i] + p[i]) * 1e5), 16777619);
  }
  h = Math.imul(h ^ (Math.round(width) * 73856093), 16777619);
  h = Math.imul(h ^ (Math.round(height) * 19349663), 16777619);
  return h >>> 0;
}

/**
 * 把所有拓扑边投影到屏幕，返回每条边的屏幕折线。
 * 不可见的点（在裁剪面外 / 数值退化）写成 NaN，作为折线的断点。
 * @returns {{key:number, edge:object, screen:Float32Array}[]}
 */
export function projectEdges(edgeData, camera, width, height) {
  const out = new Array(edgeData.length);
  for (let e = 0; e < edgeData.length; e++) {
    const pts = edgeData[e].pts;
    const screen = new Float32Array(pts.length * 2);
    for (let i = 0; i < pts.length; i++) {
      _v.set(pts[i][0], pts[i][1], pts[i][2]).project(camera);
      if (!Number.isFinite(_v.z) || _v.z < -1 || _v.z > 1) {
        screen[i * 2] = NaN; screen[i * 2 + 1] = NaN;
        continue;
      }
      screen[i * 2] = (_v.x * 0.5 + 0.5) * width;
      screen[i * 2 + 1] = (-_v.y * 0.5 + 0.5) * height;
    }
    out[e] = { edge: edgeData[e], screen };
  }
  return out;
}

/** 点到线段的屏幕距离 */
export function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-9) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 在已投影的折线里找屏幕上最近的一条边 */
export function pickNearestEdge(projected, px, py, maxPx = 28) {
  let best = null, bestD = maxPx;
  for (const item of projected) {
    const s = item.screen;
    let prevOk = false, px0 = 0, py0 = 0;
    for (let i = 0; i < s.length; i += 2) {
      const x = s[i], y = s[i + 1];
      if (x !== x || y !== y) { prevOk = false; continue; }   // NaN = 断点
      if (prevOk) {
        const d = distToSeg(px, py, px0, py0, x, y);
        if (d < bestD) { bestD = d; best = item.edge; }
      }
      prevOk = true; px0 = x; py0 = y;
    }
  }
  return best;
}

/**
 * 边投影缓存的持有者（每个 Viewer 一个）。
 * dataRef 换过（重新 setEdgeData）或相机指纹变了才重算。
 */
export class EdgeProjectionCache {
  constructor() {
    this.key = -1;
    this.dataRef = null;
    this.projected = [];
    this.builds = 0;          // 调试/基准用：重算了几次
  }

  /** @returns {{edge:object, screen:Float32Array}[]} */
  get(edgeData, camera, width, height) {
    if (!edgeData || !edgeData.length) { this.projected = []; this.dataRef = edgeData; this.key = -1; return this.projected; }
    const key = cameraKey(camera, width, height);
    if (key === this.key && this.dataRef === edgeData) return this.projected;
    this.projected = projectEdges(edgeData, camera, width, height);
    this.key = key;
    this.dataRef = edgeData;
    this.builds++;
    return this.projected;
  }

  invalidate() { this.key = -1; }
}

/**
 * 面高亮的几何构建（把「面 → 三角形子集」变成可直接吃的缓冲区）。
 * 这是 viewer.highlightFace 里唯一有成本的部分：按面缓存之后，
 * 同一个面反复高亮（拖动预览每帧都做）就只剩 add/remove 两个场景操作。
 */
export function faceHighlightData(meshData, faceId, faceRange) {
  const idx = meshData.triangles;
  const pos = meshData.vertices;
  const nor = meshData.normals;
  const start = faceRange.start * 3;
  const end = start + faceRange.count * 3;
  const n = faceRange.count * 3;
  const vp = new Float32Array(n * 3);
  const vn = new Float32Array(n * 3);
  const vi = new Uint32Array(n);
  let c = 0;
  for (let i = start; i < end; i++) {
    const v = idx[i];
    vp[c * 3] = pos[v * 3]; vp[c * 3 + 1] = pos[v * 3 + 1]; vp[c * 3 + 2] = pos[v * 3 + 2];
    vn[c * 3] = nor[v * 3]; vn[c * 3 + 1] = nor[v * 3 + 1]; vn[c * 3 + 2] = nor[v * 3 + 2];
    vi[c] = c;
    c++;
  }
  return { positions: vp, normals: vn, indices: vi, tris: faceRange.count };
}
