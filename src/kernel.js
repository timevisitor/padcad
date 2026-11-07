/**
 * 几何内核封装 —— OCCT(WASM)
 * 所有建模操作都从这里走，UI 层不直接碰 replicad
 */
import opencascade from "replicad-opencascadejs";
import {
  setOC, makeBox, makeBaseBox, makeCylinder, makeSphere,
  drawRectangle, drawCircle, drawRoundedRectangle, drawPolysides,
  exportSTEP, importSTEP, measureVolume, measureArea,
} from "replicad";

let _promise = null;
export let oc = null;

/** 加载内核（幂等，只加载一次） */
export function initKernel() {
  if (_promise) return _promise;
  _promise = (async () => {
    const t0 = performance.now();
    const ocInstance = await opencascade({
      // 必须用**相对**路径。绝对路径 "/replicad_single.wasm" 在 APK 里会指向
      // capacitor://localhost/replicad_single.wasm 之外的根，直接 404 ——
      // 网页版没事，包成 APK 就白屏。
      locateFile: () => "./replicad_single.wasm",
    });
    setOC(ocInstance);
    oc = ocInstance;
    return { ms: performance.now() - t0 };
  })();
  return _promise;
}

export const api = {
  makeBox, makeBaseBox, makeCylinder, makeSphere,
  drawRectangle, drawCircle, drawRoundedRectangle, drawPolysides,
  exportSTEP, importSTEP, measureVolume, measureArea,
};

/** 取实体的网格：三角形 + 法线 + faceGroups（三角形→拓扑面 的映射表） */
export function meshOf(shape, { tolerance = 0.08, angularTolerance = 12 } = {}) {
  const m = shape.mesh({ tolerance, angularTolerance });
  return {
    vertices: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    triangles: new Uint32Array(m.triangles),
    faceGroups: m.faceGroups.map((g) => ({
      start: g.start / 3,               // 转成「三角形索引」坐标
      count: g.count / 3,
      faceId: g.faceId,
    })),
    triCount: m.triangles.length / 3,
  };
}

/** 由三角形索引反查拓扑面 id —— 这是「点一下选中面」的核心 */
export function faceIdFromTriangle(faceGroups, triIndex) {
  for (const g of faceGroups) {
    if (triIndex >= g.start && triIndex < g.start + g.count) return g.faceId;
  }
  return null;
}

/** 取某个拓扑面对应的所有三角形索引，用于高亮 */
export function trianglesOfFace(faceGroups, faceId) {
  const g = faceGroups.find((x) => x.faceId === faceId);
  if (!g) return null;
  const out = [];
  for (let i = g.start; i < g.start + g.count; i++) out.push(i);
  return out;
}
