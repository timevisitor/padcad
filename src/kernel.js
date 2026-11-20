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

/**
 * WASM 预取（与 three / UI 初始化并行）。
 *
 * 为什么值得做：replicad_single.wasm 有 22.98MB。老写法是 initKernel 里
 * `opencascade({ locateFile })` 才开始下载 —— 前面那段时间网络/磁盘完全闲着。
 * 这里在模块求值时就发出 fetch，等 initKernel 被调用（通常是 DOM 搭完之后）时
 * 字节一般已经在内存里了，内核只剩「编译 + 实例化」。
 *
 * 为什么不用 instantiateWasm + compileStreaming（试过，结论记在这里）：
 *   Chromium 禁止在主线程「同步实例化」>8MB 的模块
 *   （WebAssembly.Instance is disallowed on the main thread, if the buffer size is larger than 8MB），
 *   必须用异步 WebAssembly.instantiate；而异步版本要和 emscripten 的钩子约定
 *   done(instance, module) 精确对齐，这份 glue 上实测会抛
 *   「Cannot read properties of undefined (reading 'exports')」，然后把整个启动挂死。
 *   所以走 emscripten 自己的 wasmBinary 路径：字节我们先下好，编译/实例化仍由它做
 *   （异步，不阻塞主线程）。实测同一份 23MB：compileStreaming 56ms，wasmBinary 实例化 90ms，
 *   两者是同一量级 —— 真正省下来的是「下载与启动并行」这段，不是编译算法。
 *
 * 不用 IndexedDB 存 WebAssembly.Module：Chromium 已不支持结构化克隆 Module，
 * 这条是无效功。跨会话的编译加速由浏览器自己的 code cache 负责。
 */
const WASM_URL = "./replicad_single.wasm";
let _wasmBinary = null;      // Promise<ArrayBuffer|null>
let _wasmError = null;       // 预取为什么没成（诊断用；正常为 null）

function preloadWasm() {
  // 只在浏览器里跑：node 回归测试自己用 fs 读 wasm，不要在这里发起网络请求。
  const browser = typeof window !== "undefined" && typeof document !== "undefined";
  if (!browser || typeof fetch !== "function") return;
  try {
    _wasmBinary = fetch(WASM_URL, { cache: "force-cache" })
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.arrayBuffer();
      })
      .catch((e) => { _wasmError = `preload: ${e?.message || e}`; return null; });
  } catch (e) {
    _wasmBinary = null;
    _wasmError = `preload: ${e?.message || e}`;
  }
}
preloadWasm();

/** 加载内核（幂等，只加载一次） */
export function initKernel() {
  if (_promise) return _promise;
  _promise = (async () => {
    const t0 = performance.now();
    const binary = _wasmBinary ? await _wasmBinary : null;
    _wasmBinary = null;            // 交出去之后不再持有这 23MB
    let ocInstance;
    try {
      ocInstance = await opencascade({
        // 必须用**相对**路径。绝对路径 "/replicad_single.wasm" 在 APK 里会指向
        // capacitor://localhost/replicad_single.wasm 之外的根，直接 404 ——
        // 网页版没事，包成 APK 就白屏。
        locateFile: () => WASM_URL,
        ...(binary ? { wasmBinary: binary } : {}),
      });
    } catch (e) {
      _wasmError = `init: ${e?.message || e}`;
      throw e;
    }
    setOC(ocInstance);
    oc = ocInstance;
    return { ms: performance.now() - t0, wasm: binary ? "preloaded" : "located", wasmError: _wasmError };
  })();
  return _promise;
}

export const api = {
  makeBox, makeBaseBox, makeCylinder, makeSphere,
  drawRectangle, drawCircle, drawRoundedRectangle, drawPolysides,
  exportSTEP, importSTEP, measureVolume, measureArea,
};

/**
 * 三角形 → 拓扑面 的查表。
 *
 * 原来 faceIdFromTriangle 是线性扫描 faceGroups，一次拾取 O(面数)；
 * 复杂件的 faceGroups 上千条，而拾取在拖动预览里每帧都可能发生。
 * 这里按 faceGroups 缓存一张 Int32Array（长度 = 三角数），查表 O(1)。
 * 用 WeakMap 挂在 faceGroups 上：网格一换就是新数组，旧表自动回收，不会串味。
 */
const _triFace = new WeakMap();
const _faceRange = new WeakMap();

function buildTriFaceIndex(faceGroups, triCount) {
  const table = new Int32Array(triCount).fill(-1);
  for (const g of faceGroups) {
    const end = Math.min(triCount, g.start + g.count);
    for (let t = Math.max(0, g.start); t < end; t++) table[t] = g.faceId;
  }
  return table;
}

function faceRanges(faceGroups) {
  let map = _faceRange.get(faceGroups);
  if (!map) {
    map = new Map();
    for (const g of faceGroups) if (!map.has(g.faceId)) map.set(g.faceId, g);
    _faceRange.set(faceGroups, map);
  }
  return map;
}

/** 取实体的网格：三角形 + 法线 + faceGroups（三角形→拓扑面 的映射表） */
export function meshOf(shape, { tolerance = 0.08, angularTolerance = 12, edges = true } = {}) {
  const m = shape.mesh({ tolerance, angularTolerance });
  const faceGroups = m.faceGroups.map((g) => ({
    start: g.start / 3,               // 转成「三角形索引」坐标
    count: g.count / 3,
    faceId: g.faceId,
  }));
  const triCount = m.triangles.length / 3;
  const out = {
    vertices: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    triangles: new Uint32Array(m.triangles),
    faceGroups,
    triCount,
  };
  /*
   * CAD 棱边直接用 OCCT 的拓扑边（ReplicadEdgeMeshExtractor），不再让 three 的
   * EdgesGeometry 去哈希所有三角形：
   *   实测 1212 三角的零件 EdgesGeometry 2.2ms、10 万三角 260ms（随三角数暴涨）；
   *   而 OCCT 出边只跟拓扑有关（32 面 71 边 0.35ms，90 面 224 边 0.33ms），
   *   而且出的就是真棱边，圆角/圆柱面不会冒出假的折线。
   */
  if (edges) {
    try {
      const e = shape.meshEdges({ tolerance, angularTolerance });
      const positions = new Float32Array(e.lines);
      // edgeGroups 的 start/count 以「点」为单位（每点 3 个 float），转成线段索引对
      const pairs = [];
      for (const g of e.edgeGroups) {
        for (let i = g.start; i + 1 < g.start + g.count; i++) pairs.push(i, i + 1);
      }
      out.edges = {
        positions,
        index: new Uint32Array(pairs),
        groups: e.edgeGroups.map((g) => ({ start: g.start, count: g.count, edgeId: g.edgeId })),
      };
    } catch (_) {
      out.edges = null;               // 片体/退化实体取不到边，viewer 退回 EdgesGeometry
    }
  }
  return out;
}

/** 由三角形索引反查拓扑面 id —— 这是「点一下选中面」的核心（查表 O(1)） */
export function faceIdFromTriangle(faceGroups, triIndex) {
  if (!faceGroups || !faceGroups.length) return null;
  let table = _triFace.get(faceGroups);
  if (!table) {
    // 三角数由 faceGroups 自己推：比扫一遍数组便宜，也免得多传参
    let last = 0;
    for (const g of faceGroups) last = Math.max(last, g.start + g.count);
    table = buildTriFaceIndex(faceGroups, last);
    _triFace.set(faceGroups, table);
  }
  if (!Number.isInteger(triIndex) || triIndex < 0 || triIndex >= table.length) return null;
  const faceId = table[triIndex];
  return faceId === -1 ? null : faceId;
}

/** 取某个拓扑面对应的所有三角形索引，用于高亮 */
export function trianglesOfFace(faceGroups, faceId) {
  const g = faceRanges(faceGroups).get(faceId);
  if (!g) return null;
  const out = new Array(g.count);
  for (let i = 0; i < g.count; i++) out[i] = g.start + i;
  return out;
}

/** 某个拓扑面在索引缓冲里的三角区间（高亮走它，免去复制一份三角形列表） */
export function faceRangeOf(faceGroups, faceId) {
  return faceRanges(faceGroups).get(faceId) || null;
}
