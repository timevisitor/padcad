/**
 * 网格导出（A 批 P0-9）：STL(binary) / OBJ / 3MF
 *
 * 之前只有 STEP 一条出口。加工沟通要 STL，3D 打印要 3MF，切片软件认 OBJ。
 * 全部直接从 OCCT 的网格（shape.mesh）写，不经过 three.js —— 这样导出的单位、
 * 精度和屏幕上看到的是同一套容差。
 *
 * 3MF 是 zip(store) 包三个文件，这里手写最小实现（不引第三方库、不动 node_modules）。
 */

/** 取网格并校正索引（replicad 给的是 number[]，可能是 Uint32Array） */
export function meshData(shape, { tolerance = 0.05, angularTolerance = 10 } = {}) {
  if (!shape) throw new Error("没有实体可导出");
  const m = shape.mesh({ tolerance, angularTolerance });
  return {
    vertices: Array.from(m.vertices),      // [x,y,z, x,y,z, ...]
    triangles: Array.from(m.triangles),    // [i,j,k, ...]
  };
}

const triCount = (t) => Math.floor(t.length / 3);
const vtx = (v, i) => [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]];

function normalOf(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const L = Math.hypot(...n) || 1;
  return [n[0] / L, n[1] / L, n[2] / L];
}

/** 二进制 STL：80 字节头 + uint32 三角形数 + 每面 50 字节 */
export function stlBinary(shape, title = "PadCAD") {
  const { vertices: v, triangles: t } = meshData(shape);
  const n = triCount(t);
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const enc = new TextEncoder().encode(String(title).slice(0, 79));
  for (let i = 0; i < enc.length; i++) dv.setUint8(i, enc[i]);
  dv.setUint32(80, n, true);
  let off = 84;
  for (let i = 0; i < n; i++) {
    const a = vtx(v, t[i * 3]), b = vtx(v, t[i * 3 + 1]), c = vtx(v, t[i * 3 + 2]);
    const nrm = normalOf(a, b, c);
    for (const p of [nrm, a, b, c]) {
      dv.setFloat32(off, p[0], true); dv.setFloat32(off + 4, p[1], true); dv.setFloat32(off + 8, p[2], true);
      off += 12;
    }
    dv.setUint16(off, 0, true); off += 2;
  }
  return new Uint8Array(buf);
}

/** ASCII OBJ：v / (三角形用 f，1 基索引) */
export function objText(shape, title = "PadCAD") {
  const { vertices: v, triangles: t } = meshData(shape);
  const n = triCount(t);
  const out = [`# ${title} · PadCAD 网格导出 (mm)`, `# vertices ${v.length / 3} · triangles ${n}`];
  for (let i = 0; i < v.length; i += 3) out.push(`v ${fmt(v[i])} ${fmt(v[i + 1])} ${fmt(v[i + 2])}`);
  for (let i = 0; i < n; i++) {
    out.push(`f ${t[i * 3] + 1} ${t[i * 3 + 1] + 1} ${t[i * 3 + 2] + 1}`);
  }
  return out.join("\n") + "\n";
}

/** 3MF：zip(store) 内的 3D/3dmodel.model（单位 mm、单件） */
export function threeMF(shape, title = "PadCAD") {
  const { vertices: v, triangles: t } = meshData(shape);
  const n = triCount(t);
  const V = [];
  for (let i = 0; i < v.length; i += 3) {
    V.push(`<vertex x="${fmt(v[i])}" y="${fmt(v[i + 1])}" z="${fmt(v[i + 2])}"/>`);
  }
  const T = [];
  for (let i = 0; i < n; i++) T.push(`<triangle v1="${t[i * 3]}" v2="${t[i * 3 + 1]}" v3="${t[i * 3 + 2]}"/>`);

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <metadata name="Title">${esc(title)}</metadata>
 <resources><object id="1" type="model"><mesh>
  <vertices>${V.join("")}</vertices>
  <triangles>${T.join("")}</triangles>
 </mesh></object></resources>
 <build><item objectid="1"/></build>
</model>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

  return zipStore([
    { name: "[Content_Types].xml", data: str(contentTypes) },
    { name: "_rels/.rels", data: str(rels) },
    { name: "3D/3dmodel.model", data: str(model) },
  ]);
}

// ---------------------------------------------------------------- zip(store)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const str = (s) => new TextEncoder().encode(s);
const fmt = (x) => {
  const r = Math.round(x * 1e6) / 1e6;
  return Object.is(r, -0) ? "0" : String(r);
};
const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

/** 最小 zip 写入（store，不压缩）：返回 Uint8Array */
export function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = str(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);        // version needed
    local.setUint16(6, 0, true);         // flags
    local.setUint16(8, 0, true);         // method: store
    local.setUint16(10, 0, true); local.setUint16(12, 0, true);  // time/date
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    locals.push(new Uint8Array(local.buffer), nameBytes, f.data);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true); cen.setUint16(6, 20, true);
    cen.setUint16(8, 0, true); cen.setUint16(10, 0, true);
    cen.setUint16(12, 0, true); cen.setUint16(14, 0, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, f.data.length, true);
    cen.setUint32(24, f.data.length, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint16(30, 0, true); cen.setUint16(32, 0, true);
    cen.setUint16(34, 0, true); cen.setUint16(36, 0, true);
    cen.setUint32(38, 0, true);
    cen.setUint32(42, offset, true);
    centrals.push(new Uint8Array(cen.buffer), nameBytes);
    offset += 30 + nameBytes.length + f.data.length;
  }
  const centralSize = centrals.reduce((n, a) => n + a.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true); end.setUint16(6, 0, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, 0, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const total = parts.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of parts) { out.set(a, p); p += a.length; }
  return out;
}
