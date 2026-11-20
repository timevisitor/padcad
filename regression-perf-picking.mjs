/**
 * 回归：拾取加速（BVH / 三角→面查表 / 边投影缓存 / 面高亮缓存 / 内核拓扑棱边）
 *
 * 每一条都拿「优化前的算法」当参照逐值对拍 —— 加速只能更快，不许改变结果。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import * as THREE from "three";
import opencascade from "replicad-opencascadejs";
import { setOC, measureVolume } from "replicad";
import * as OPS from "./src/ops.js";
import { meshOf, faceIdFromTriangle, faceRangeOf } from "./src/kernel.js";
import { Viewer } from "./src/viewer.js";
import { cameraKey, projectEdges, pickNearestEdge, EdgeProjectionCache } from "./src/perf-pick.js";

setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));

const shape = OPS.starterModel();   // 60×40×8 带中心孔：7 个面 / 15 条拓扑边

const mesh = meshOf(shape);

function fakeViewer(meshData, { camera } = {}) {
  const viewer = Object.create(Viewer.prototype);
  const canvas = {
    clientWidth: 1600, clientHeight: 1000,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 1000 }),
  };
  const cam = camera || new THREE.PerspectiveCamera(38, 1.6, 0.5, 20000);
  cam.up.set(0, 0, 1);
  if (!camera) { cam.position.set(140, -140, 100); cam.lookAt(0, 0, 4); cam.updateMatrixWorld(true); }
  Object.assign(viewer, {
    canvas, camera: cam, raycaster: new THREE.Raycaster(), body: new THREE.Group(), overlay: new THREE.Group(),
    matBody: new THREE.MeshStandardMaterial(), matPick: new THREE.MeshStandardMaterial(),
    matEdge: new THREE.LineBasicMaterial(), matPickEdge: new THREE.LineBasicMaterial(),
    matEdgeHi: new THREE.LineBasicMaterial(), invalidate() {}, setInteractiveQuality() {},
    solidMesh: null, edgeMesh: null, pickMesh: null, pickEdge: null, meshData: null,
  });
  viewer.setMesh(meshData);
  return viewer;
}

/** 优化前的线性扫描（参照实现） */
function faceIdLinear(faceGroups, triIndex) {
  for (const g of faceGroups) if (triIndex >= g.start && triIndex < g.start + g.count) return g.faceId;
  return null;
}
/** 优化前的边拾取（每次都重新投影的参照实现） */
function pickEdgeNaive(edgeData, camera, px, py, width, height, maxPx = 28) {
  const v = new THREE.Vector3();
  const distToSeg = (x, y, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-9) return Math.hypot(x - a[0], y - a[1]);
    let t = ((x - a[0]) * dx + (y - a[1]) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
  };
  let best = null, bestD = maxPx;
  for (const e of edgeData) {
    let prev = null;
    for (const p of e.pts) {
      v.set(p[0], p[1], p[2]).project(camera);
      if (!Number.isFinite(v.z) || v.z < -1 || v.z > 1) { prev = null; continue; }
      const s = [(v.x * 0.5 + 0.5) * width, (-v.y * 0.5 + 0.5) * height];
      if (prev) { const d = distToSeg(px, py, prev, s); if (d < bestD) { bestD = d; best = e; } }
      prev = s;
    }
  }
  return best;
}

test("BVH 拾取与线性 raycast 给出同一个面、同一个交点", () => {
  const viewer = fakeViewer(mesh);
  const linear = new THREE.Raycaster();
  let hits = 0;
  for (let i = 0; i < 240; i++) {
    const x = 800 + (i % 24) * 25 - 300, y = 500 + Math.floor(i / 24) * 35 - 175;
    const fast = viewer.pickAt(x, y);
    const ndc = new THREE.Vector2((x / 1600) * 2 - 1, -(y / 1000) * 2 + 1);
    linear.setFromCamera(ndc, viewer.camera);
    const ref = linear.intersectObject(viewer.solidMesh, false);
    if (!ref.length) { assert.equal(fast, null, `(${x},${y}) 没打中模型却返回了面`); continue; }
    hits++;
    assert.ok(fast, `(${x},${y}) 打中了模型却返回 null`);
    assert.equal(fast.faceId, faceIdLinear(mesh.faceGroups, ref[0].faceIndex));
    assert.ok(fast.point.distanceTo(ref[0].point) < 1e-6, "交点必须一致");
    assert.ok(Math.abs(fast.distance - ref[0].distance) < 1e-6);
  }
  assert.ok(hits > 40, `射线命中太少（${hits}），基准没打到模型上`);
  assert.ok(viewer._bvhMs > 0, "BVH 应该已经被按需建起来");
  assert.ok(viewer.geometry.boundsTree, "几何上应挂上 boundsTree");
});

test("建 BVH 不许就地重排几何索引（面→三角形映射全指着它）", () => {
  // 这条是踩过的坑：MeshBVH 默认会按节点顺序重排 geometry.index，
  // 而索引就是 meshData.triangles，faceGroups 的 start/count 是原始顺序下的区间。
  // 重排之后高亮会亮到别的面上（实测：圆柱面高亮成了整块底板）。
  const viewer = fakeViewer(mesh);
  const before = Uint32Array.from(mesh.triangles);
  viewer.pickAt(800, 500);                 // 触发建 BVH
  assert.ok(viewer.geometry.boundsTree, "BVH 应该建起来了");
  assert.deepEqual(Array.from(mesh.triangles), Array.from(before), "几何索引顺序被改动了");
  assert.deepEqual(Array.from(viewer.geometry.getIndex().array), Array.from(before), "渲染用索引也必须一致");
  assert.equal(viewer.geometry.boundsTree.indirect, true, "必须用 indirect 模式");
});

test("每个面的高亮几何都必须落在该面的真实包围盒里", () => {
  const viewer = fakeViewer(mesh);
  viewer.pickAt(800, 500);
  const bbox = (arr) => {
    const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
    for (let i = 0; i < arr.length; i += 3) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], arr[i + k]); max[k] = Math.max(max[k], arr[i + k]);
    }
    return { min, max };
  };
  for (const g of mesh.faceGroups) {
    const face = shape.faces.find((f) => f.hashCode === g.faceId);
    assert.ok(face, `面 ${g.faceId} 不在实体上`);
    viewer.highlightFace(g.faceId);
    const got = bbox(viewer.pickMesh.geometry.getAttribute("position").array);
    const want = face.boundingBox.bounds;          // [[xmin,ymin,zmin],[xmax,ymax,zmax]]
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(got.min[k] - want[0][k]) < 1e-3, `面 ${g.faceId} 高亮 min[${k}] 对不上`);
      assert.ok(Math.abs(got.max[k] - want[1][k]) < 1e-3, `面 ${g.faceId} 高亮 max[${k}] 对不上`);
    }
  }
});

test("三角→面 查表与线性扫描逐个三角一致", () => {
  for (let t = -1; t <= mesh.triCount; t++) {
    assert.equal(faceIdFromTriangle(mesh.faceGroups, t), t < 0 || t >= mesh.triCount ? null : faceIdLinear(mesh.faceGroups, t));
  }
  assert.equal(faceIdFromTriangle(mesh.faceGroups, undefined), null);
  // 非整数索引不能被当成 0 号三角
  assert.equal(faceIdFromTriangle(mesh.faceGroups, 1.5), null);
});

test("面区间查询与线性扫描一致（高亮走它）", () => {
  for (const g of mesh.faceGroups) {
    const range = faceRangeOf(mesh.faceGroups, g.faceId);
    const first = mesh.faceGroups.find((x) => x.faceId === g.faceId);
    assert.equal(range.start, first.start);
    assert.equal(range.count, first.count);
  }
  assert.equal(faceRangeOf(mesh.faceGroups, -12345), null);
});

test("边拾取缓存：结果与每次重投影一致，且相机不动时不重算", () => {
  const viewer = fakeViewer(mesh);
  const edges = OPS.edgePointSets(shape);
  viewer.setEdgeData(edges);
  viewer.pickEdgeAt(1, 1);                       // 先触发一次投影，缓存对象才建立
  const buildsAfterSet = viewer._edgeCache.builds;
  const samples = [];
  for (let i = 0; i < 40; i++) samples.push([800 + (i % 10) * 40 - 200, 500 + Math.floor(i / 10) * 60 - 120]);
  for (const [x, y] of samples) {
    const fast = viewer.pickEdgeAt(x, y);
    const slow = pickEdgeNaive(edges, viewer.camera, x, y, 1600, 1000);
    assert.equal(fast, slow, `(${x},${y}) 命中的边必须一致`);
  }
  const buildsAfterPicks = viewer._edgeCache.builds;
  assert.equal(buildsAfterPicks, buildsAfterSet, "相机没动 → 投影只算一次");

  // 相机一动就必须重算，并且仍然与参照实现一致
  viewer.camera.position.set(40, -160, 60);
  viewer.camera.lookAt(0, 0, 4);
  viewer.camera.updateMatrixWorld(true);
  const rotated = viewer.pickEdgeAt(800, 500);
  assert.equal(rotated, pickEdgeNaive(edges, viewer.camera, 800, 500, 1600, 1000));
  assert.ok(viewer._edgeCache.builds > buildsAfterPicks, "换了视角必须重投影");
});

test("相机指纹对视角/画布尺寸敏感，对噪声不敏感", () => {
  const cam = new THREE.PerspectiveCamera(38, 1.6, 0.5, 20000);
  cam.position.set(100, 0, 0); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true);
  const a = cameraKey(cam, 1600, 1000);
  assert.equal(cameraKey(cam, 1600, 1000), a, "同一姿态必须给出同一个键");
  assert.notEqual(cameraKey(cam, 1600, 1001), a, "画布尺寸变了要重算");
  cam.position.set(100, 1, 0); cam.updateMatrixWorld(true);
  assert.notEqual(cameraKey(cam, 1600, 1000), a, "视角变了要重算");
  cam.position.set(100, 0, 0); cam.updateMatrixWorld(true);
  assert.equal(cameraKey(cam, 1600, 1000), a, "转回去还是同一个键");
});

test("投影结果跳过被裁剪的点（折线断开，不跨屏连线）", () => {
  const cam = new THREE.PerspectiveCamera(38, 1.6, 0.5, 20000);
  cam.position.set(0, 0, 50); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true);
  // 相机在 z=50、近裁面 0.5：z=50.1 的点在相机背后（ndc.z=11），必须被跳过
  const edgeData = [{ pts: [[-5, 0, 0], [0, 0, 50.1], [5, 0, 0]], mid: [0, 0, 0] }];
  const projected = projectEdges(edgeData, cam, 100, 100);
  assert.ok(Number.isNaN(projected[0].screen[2]), "相机背后的点应为 NaN");
  assert.ok(!Number.isNaN(projected[0].screen[0]) && !Number.isNaN(projected[0].screen[4]), "可见的点必须有屏幕坐标");
  // 两个可见点之间隔着断点 → 不能连成一条线（参照实现对同样输入也返回 null）
  assert.equal(pickNearestEdge(projected, 50, 50, 2), null);
  assert.equal(pickEdgeNaive(edgeData, cam, 50, 50, 100, 100, 2), null);
});

test("面高亮按面缓存：同一个面复用几何，换网格就整体释放", () => {
  const viewer = fakeViewer(mesh);
  const faceId = mesh.faceGroups[0].faceId;
  viewer.highlightFace(faceId);
  const first = viewer.pickMesh.geometry;
  viewer.highlightFace(faceId);
  assert.equal(viewer.pickMesh.geometry, first, "同一个面应复用缓存几何");
  assert.equal(viewer.overlay.children.length, 2, "高亮只挂一个面片 + 一条轮廓");

  const other = mesh.faceGroups[1].faceId;
  viewer.highlightFace(other);
  assert.notEqual(viewer.pickMesh.geometry, first);
  assert.equal(viewer._faceCache.size, 2);

  let disposed = 0;
  for (const entry of viewer._faceCache.values()) {
    entry.mesh.geometry.addEventListener("dispose", () => disposed++);
  }
  viewer.setMesh(mesh);
  assert.equal(viewer._faceCache.size, 0, "换网格必须清空面缓存");
  assert.equal(disposed, 2, "清空时要 dispose 掉缓存几何");
  assert.equal(viewer.overlay.children.length, 0);
});

test("内核直接出拓扑棱边：边数、索引范围、真棱边都成立", () => {
  assert.ok(mesh.edges, "meshOf 应该带回棱边数据");
  const { positions, index, groups } = mesh.edges;
  const pts = positions.length / 3;
  assert.ok(pts > 0 && index.length > 0);
  assert.equal(groups.length, shape.edges.length, "每条拓扑边一组");
  let maxIdx = 0;
  for (let i = 0; i < index.length; i++) {
    assert.ok(Number.isInteger(index[i]) && index[i] >= 0 && index[i] < pts, "索引必须落在点表内");
    maxIdx = Math.max(maxIdx, index[i]);
  }
  assert.equal(maxIdx, pts - 1, "点表应被完全用上（不多不少）");
  // 每组自己连成折线：段数 = 点数 - 1
  const segs = groups.reduce((sum, g) => sum + Math.max(0, g.count - 1), 0);
  assert.equal(index.length / 2, segs);
});

test("viewer 用内核棱边出线框，不再跑 EdgesGeometry", () => {
  const viewer = fakeViewer(mesh);
  assert.ok(viewer.edgeMesh, "提交态必须有棱边");
  assert.ok(viewer.edgeMesh.geometry.index, "内核棱边是索引化的（不复制点）");
  assert.equal(viewer.edgeMesh.geometry.index.count, mesh.edges.index.length);
  // 预览仍然不带棱边（沿用既有取舍：拖动帧不付边线成本）
  const preview = fakeViewer(mesh);
  preview.setMesh(mesh, { preview: true });
  assert.equal(preview.edgeMesh, null);
});

test("没有内核棱边的网格（老调用方 / 片体）仍退回 EdgesGeometry", () => {
  const viewer = fakeViewer(mesh);
  const legacy = { ...mesh };
  delete legacy.edges;
  viewer.setMesh(legacy);
  assert.ok(viewer.edgeMesh, "退回路径也要有线框");
  assert.equal(viewer.edgeMesh.geometry.index, null, "EdgesGeometry 是非索引的");
  assert.ok(viewer.edgeMesh.geometry.attributes.position.count > 0);
});

test("几何体积没被网格/边的提取动过", () => {
  assert.ok(measureVolume(shape) > 0);
});
