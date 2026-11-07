/**
 * 网格文件解析器（看图模式用）
 *
 * 为什么自己写而不是走 OCCT：
 * 1. replicad/OCCT 只能导 STL，而且实测 `importSTL` 直接抛 WebAssembly.Exception，
 *    `importSTLAsMesh` 又要求额外的 manifold WASM（"manifold has not been loaded"）
 * 2. 看图只需要**三角网格**，不需要 B-rep —— 绕开内核反而更快更稳
 * 3. 自己写才可能支持 PLY（OCCT 压根没有 PLY 导入）
 *
 * 统一输出格式：{ positions: Float32Array, normals: Float32Array, triangleCount }
 * 顶点是**展开**的（每 3 个顶点一个三角形），因为 STL 本来就是这么存的，
 * 而且法线逐面写死，展开后不用再算平滑法线。
 */

/** 读 ASCII 偏移处的 12 字节小端浮点 */
function readVec3(dv, offset) {
  return [dv.getFloat32(offset, true), dv.getFloat32(offset + 4, true), dv.getFloat32(offset + 8, true)];
}

/** 由三个顶点算法向（右手法则），退化三角形返回 [0,0,1] */
function faceNormal(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const L = Math.hypot(nx, ny, nz);
  return L < 1e-12 ? [0, 0, 1] : [nx / L, ny / L, nz / L];
}

function finiteVec(v) { return v.every((x) => Number.isFinite(x) && Number.isFinite(Math.fround(x))); }

// ---------------------------------------------------------------- STL
/**
 * STL：二进制和 ASCII 都要支持。
 * 判别方式：二进制 STL 的长度必须正好是 84 + 50×三角形数，
 * 这是它自带的一致性校验，比"看开头是不是 solid"可靠得多
 * （不少二进制 STL 的 header 也以 "solid" 开头）。
 */
export function parseSTL(buffer) {
  const dv = new DataView(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength ?? buffer.length);
  const byteLen = dv.byteLength;

  let out = null;
  if (byteLen >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === byteLen) out = parseSTLBinary(dv, n);
  }
  if (!out) {
    // 退回 ASCII
    const text = new TextDecoder().decode(new Uint8Array(dv.buffer, dv.byteOffset, byteLen));
    out = parseSTLAscii(text);
  }
  // 解析出 0 个三角面必须报错，不能静默返回空网格 ——
  // 否则用户会以为"文件读进去了"，实际场景里啥也没有
  if (!out.triangleCount) {
    throw new Error(`STL 里没有三角面（文件可能为空或已损坏，读取到 ${byteLen} 字节）`);
  }
  return out;
}

function parseSTLBinary(dv, n) {
  const positions = new Float32Array(n * 9);
  const normals = new Float32Array(n * 9);
  let p = 0;
  for (let i = 0; i < n; i++) {
    const off = 84 + i * 50;
    const nrm = readVec3(dv, off);
    const a = readVec3(dv, off + 12);
    const b = readVec3(dv, off + 24);
    const c = readVec3(dv, off + 36);
    if (![a, b, c].every(finiteVec)) throw new Error(`STL 第 ${i + 1} 个三角面包含无效坐标`);
    // 有些导出器的法线是零向量，这里补算一遍，免得渲染全黑
    const L = Math.hypot(...nrm);
    const nn = !Number.isFinite(L) || L < 1e-12 ? faceNormal(a, b, c) : nrm.map((x) => x / L);
    for (const v of [a, b, c]) {
      positions[p] = v[0]; positions[p + 1] = v[1]; positions[p + 2] = v[2];
      normals[p] = nn[0]; normals[p + 1] = nn[1]; normals[p + 2] = nn[2];
      p += 3;
    }
  }
  return { positions, normals, triangleCount: n };
}

function parseSTLAscii(text) {
  const pts = [];
  const re = /\bvertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const pt = [+m[1], +m[2], +m[3]];
    if (!finiteVec(pt)) throw new Error("STL 包含无效顶点坐标");
    pts.push(pt);
  }
  if (pts.length % 3) throw new Error("STL 三角面的顶点不完整");
  const n = Math.floor(pts.length / 3);
  const positions = new Float32Array(n * 9);
  const normals = new Float32Array(n * 9);
  let p = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i * 3], b = pts[i * 3 + 1], c = pts[i * 3 + 2];
    const nn = faceNormal(a, b, c);
    for (const v of [a, b, c]) {
      positions[p] = v[0]; positions[p + 1] = v[1]; positions[p + 2] = v[2];
      normals[p] = nn[0]; normals[p + 1] = nn[1]; normals[p + 2] = nn[2];
      p += 3;
    }
  }
  return { positions, normals, triangleCount: n };
}

// ---------------------------------------------------------------- PLY
/**
 * PLY：支持 ascii 和 binary_little_endian 两种。
 * 只处理最常见的 x/y/z + 面索引，跳过颜色等属性 ——
 * 看图只需要几何，多读属性只会让解析器变复杂。
 */
export function parsePLY(buffer) {
  const u8 = new Uint8Array(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength ?? buffer.length);
  const headText = new TextDecoder("latin1").decode(u8.subarray(0, Math.min(u8.length, 65536)));
  // CRLF 的两个字节必须一起跳过；且不能把 comment 中的 end_header 当成终止行。
  const end = /^end_header[ \t]*\r?\n/m.exec(headText);
  if (!end || !/^ply\r?\n/.test(headText)) throw new Error("不是有效的 PLY：找不到文件头或 end_header");
  const headerLen = end.index + end[0].length;
  const lines = headText.slice(0, end.index).split(/\r?\n/);
  const formats = ["ascii", "binary_little_endian", "binary_big_endian"];
  const format = lines.find((s) => /^format\s/.test(s))?.trim().split(/\s+/)[1];
  if (!formats.includes(format)) throw new Error("PLY 格式不受支持");
  const types = {
    char: ["getInt8", 1], int8: ["getInt8", 1], uchar: ["getUint8", 1], uint8: ["getUint8", 1],
    short: ["getInt16", 2], int16: ["getInt16", 2], ushort: ["getUint16", 2], uint16: ["getUint16", 2],
    int: ["getInt32", 4], int32: ["getInt32", 4], uint: ["getUint32", 4], uint32: ["getUint32", 4],
    float: ["getFloat32", 4], float32: ["getFloat32", 4], double: ["getFloat64", 8], float64: ["getFloat64", 8],
  };
  const elements = [];
  let current;
  for (const line of lines) {
    const t = line.trim().split(/\s+/);
    if (t[0] === "element") {
      const count = Number(t[2]);
      if (!Number.isSafeInteger(count) || count < 0 || count > u8.length) throw new Error("PLY 元素数量无效或文件已截断");
      current = { name: t[1], count, props: [] };
      elements.push(current);
    } else if (t[0] === "property") {
      if (!current) throw new Error("PLY 属性缺少所属元素");
      const p = t[1] === "list" ? { countType: t[2], type: t[3], name: t[4] } : { type: t[1], name: t[2] };
      if (!types[p.type] || (p.countType && !types[p.countType])) throw new Error("PLY 属性类型不受支持");
      current.props.push(p);
    }
  }
  const vertex = elements.find((e) => e.name === "vertex");
  if (!vertex || !["x", "y", "z"].every((k) => vertex.props.some((p) => p.name === k && !p.countType))) {
    throw new Error("PLY 缺少顶点 x/y/z 坐标属性");
  }
  const verts = new Float32Array(vertex.count * 3);
  const faces = [];
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const ascii = format === "ascii";
  const tokens = ascii ? new TextDecoder().decode(u8.subarray(headerLen)).trim().split(/\s+/) : null;
  let off = headerLen, token = 0;
  const read = (type) => {
    if (ascii) {
      if (token >= tokens.length || tokens[token] === "") throw new Error("PLY 数据不完整");
      const value = Number(tokens[token++]);
      if (!Number.isFinite(value)) throw new Error("PLY 包含无效数值");
      return value;
    }
    const [method, size] = types[type];
    if (off + size > dv.byteLength) throw new Error("PLY 二进制数据不完整");
    const value = dv[method](off, format !== "binary_big_endian");
    off += size;
    return value;
  };
  for (const e of elements) {
    for (let i = 0; i < e.count; i++) {
      let indices = null;
      for (const p of e.props) {
        if (p.countType) {
          const count = read(p.countType);
          const available = ascii ? tokens.length - token : Math.floor((dv.byteLength - off) / types[p.type][1]);
          if (!Number.isSafeInteger(count) || count < 0 || count > available) throw new Error("PLY 列表长度无效或数据不完整");
          const isIndices = e.name === "face" && ["vertex_indices", "vertex_index"].includes(p.name);
          const list = isIndices ? [] : null;
          for (let k = 0; k < count; k++) {
            const value = read(p.type);
            if (list) list.push(value);
          }
          if (isIndices) indices = list;
        } else {
          const value = read(p.type);
          const axis = ["x", "y", "z"].indexOf(p.name);
          if (e.name === "vertex" && axis >= 0) {
            if (!Number.isFinite(Math.fround(value))) throw new Error("PLY 包含无效顶点坐标");
            verts[i * 3 + axis] = value;
          }
        }
      }
      // 四边形/多边形的每一部分都需保留，而不是静默丢掉第 4 个以后的顶点。
      if (indices) for (let k = 1; k + 1 < indices.length; k++) faces.push([indices[0], indices[k], indices[k + 1]]);
    }
  }
  return expandIndexed(verts, faces, "PLY");
}

// ---------------------------------------------------------------- OBJ
/**
 * OBJ：只读 v / f 两类行。索引支持负值（相对当前顶点数），
 * 这是 OBJ 规范里合法且常见的写法。
 */
export function parseOBJ(text) {
  const verts = [];
  const faces = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#", 1)[0].trim();
    if (!line || line[0] === "#") continue;
    if (/^v\s/.test(line)) {
      const t = line.split(/\s+/);
      verts.push(+t[1], +t[2], +t[3]);
    } else if (/^f\s/.test(line)) {
      const t = line.split(/\s+/).slice(1);
      const idx = t.map((tok) => {
        const s = tok.split("/")[0];
        let i = /^[-+]?\d+$/.test(s) ? Number(s) : NaN;
        if (!Number.isSafeInteger(i) || i === 0) return -1;
        if (i < 0) i = verts.length / 3 + i;      // OBJ 的负索引从 -1 开始表示最后一个
        else i = i - 1;
        return i;
      });
      // 无效索引必须保留为坏面，不能删除索引后把原来的其他顶点拼成新面。
      if (idx.some((i) => i < 0)) { faces.push([-1, -1, -1]); continue; }
      // 多边形按扇形三角化
      for (let k = 1; k + 1 < idx.length; k++) faces.push([idx[0], idx[k], idx[k + 1]]);
    }
  }
  return expandIndexed(new Float32Array(verts), faces, "OBJ");
}

/** 把「顶点表 + 索引面」展开成 STL 那样的逐三角顶点数组，并逐面算法线 */
function expandIndexed(verts, faces, label) {
  if (!faces || !faces.length) throw new Error(`${label} 里没有可用的三角面`);
  const maxIdx = verts.length / 3;
  const positions = new Float32Array(faces.length * 9);
  const normals = new Float32Array(faces.length * 9);
  let p = 0, bad = 0;
  for (const f of faces) {
    if (f.some((i) => !Number.isInteger(i) || i < 0 || i >= maxIdx)) { bad++; continue; }
    const a = [verts[f[0] * 3], verts[f[0] * 3 + 1], verts[f[0] * 3 + 2]];
    const b = [verts[f[1] * 3], verts[f[1] * 3 + 1], verts[f[1] * 3 + 2]];
    const c = [verts[f[2] * 3], verts[f[2] * 3 + 1], verts[f[2] * 3 + 2]];
    if (![a, b, c].every(finiteVec)) { bad++; continue; }
    const nn = faceNormal(a, b, c);
    for (const v of [a, b, c]) {
      positions[p] = v[0]; positions[p + 1] = v[1]; positions[p + 2] = v[2];
      normals[p] = nn[0]; normals[p + 1] = nn[1]; normals[p + 2] = nn[2];
      p += 3;
    }
  }
  const used = faces.length - bad;
  // 全被判坏了也要报错，不能返回一个 0 三角的空网格
  if (!used) {
    throw new Error(`${label} 里的 ${faces.length} 个面全部无效（顶点索引或坐标损坏），没有可显示的几何`);
  }
  return {
    positions: positions.subarray(0, used * 9),
    normals: normals.subarray(0, used * 9),
    triangleCount: used,
    skipped: bad,
  };
}

// ---------------------------------------------------------------- 统一入口
export const MESH_FORMATS = { stl: "STL", ply: "PLY", obj: "OBJ" };
/** 走几何内核的不是网格格式，单独列 */
export const BREP_FORMATS = { step: "STEP", stp: "STEP" };
export const UNSUPPORTED = {
  x_t: "Parasolid（Siemens 私有格式，OCCT 不支持）",
  xmt_txt: "Parasolid 文本格式",
  iges: "IGES（replicad 没有这个导入函数）",
  igs: "IGES",
};

/** 按扩展名挑解析器；不认识的返回 null */
export function parseMesh(name, data) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "stl") return parseSTL(data);
  if (ext === "ply") return parsePLY(data);
  if (ext === "obj") return parseOBJ(typeof data === "string" ? data : new TextDecoder().decode(data));
  return null;
}
