/**
 * 检查/测量 + 网格导出回归（A 批 P0-8 / P0-9）
 *
 * 判据：60×40×8 板
 *   体积 19 200、表面积 6 400、质心 (0,0,4)、包围盒 60×40×8
 *   两块错开 5mm 的板：最小距离 5
 *   同尺寸重叠一半：公共体积 30×40×8 = 9 600
 * STL：文件长度必须恰为 84 + 50×面数；头部三角数一致
 * OBJ：v / f 行数与网格一致
 * 3MF：PK 头 + 中央目录里能查到 3D/3dmodel.model
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import opencascade from "replicad-opencascadejs";
import { setOC, makeBaseBox, measureVolume } from "replicad";
import { massProperties, distanceBetween, interference, sectionAt } from "./src/inspect.js";
import { stlBinary, objText, threeMF } from "./src/exporters.js";

setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const plate = (dx = 0) => {
  const s = makeBaseBox(60, 40, 8);
  return dx ? s.translate(dx, 0, 0) : s;
};

test("质量属性：体积/表面积/质心/包围盒都对得上解析值", () => {
  const p = massProperties(plate());
  close(p.volume, 60 * 40 * 8, 1e-3);
  close(p.area, 2 * (60 * 40 + 60 * 8 + 40 * 8), 1e-2);   // 6 400
  close(p.centroid[0], 0, 1e-6);
  close(p.centroid[1], 0, 1e-6);
  close(p.centroid[2], 4, 1e-6);
  assert.deepEqual(p.bbox.size.map((v) => Math.round(v * 1e6) / 1e6), [60, 40, 8]);
});

test("最小距离：错开 5mm 的两块板 = 5", () => {
  close(distanceBetween(plate(0), plate(65)), 5, 1e-6);
});

test("干涉：重叠 30mm 的两块板公共体积 = 30×40×8", () => {
  const r = interference(plate(0), plate(30));
  assert.equal(r.overlaps, true);
  close(r.volume, 30 * 40 * 8, 0.5);
  // 干涉检查不能把调用方的实体吃掉：原实体仍可测
  close(measureVolume(plate(0)), 19200, 1e-3);
});

test("不干涉时 overlaps=false（错开 5mm 只算接近）", () => {
  const r = interference(plate(0), plate(65));
  assert.equal(r.overlaps, false);
  close(r.volume, 0, 1e-6);
});

test("剖切：z=4 的截面周长 = 2×(60+40)", () => {
  const s = sectionAt(plate(), { origin: [0, 0, 4], normal: [0, 0, 1] });
  assert.ok(s.segments >= 2, `截面线段 ${s.segments}`);
  close(s.perimeter, 200, 0.5);
});

test("STL 二进制：长度 = 84 + 50×面数，头部面数一致", () => {
  const p = plate();
  const m = p.mesh({ tolerance: 0.05, angularTolerance: 10 });
  const tris = m.triangles.length / 3;
  const bytes = stlBinary(p, "板");
  assert.equal(bytes.length, 84 + 50 * tris);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(dv.getUint32(80, true), tris);
  // 12 个三角形（长方体最少网格）起
  assert.ok(tris >= 12);
});

test("OBJ：v / f 行数与网格一致，索引从 1 开始", () => {
  const p = plate();
  const text = objText(p, "板");
  const lines = text.trim().split("\n");
  const v = lines.filter((l) => l.startsWith("v ")).length;
  const f = lines.filter((l) => l.startsWith("f ")).length;
  const m = p.mesh({ tolerance: 0.05, angularTolerance: 10 });
  assert.equal(v, m.vertices.length / 3);
  assert.equal(f, m.triangles.length / 3);
  const firstF = lines.find((l) => l.startsWith("f ")).split(" ").slice(1).map(Number);
  assert.ok(firstF.every((i) => i >= 1 && i <= v));
});

test("3MF：zip 结构完整且含 3D/3dmodel.model", () => {
  const bytes = threeMF(plate(), "板");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(dv.getUint32(0, true), 0x04034b50, "不是 zip 头");
  const tail = Buffer.from(bytes.slice(bytes.length - 22)).toString("latin1");
  assert.equal(tail.slice(0, 2), "PK");
  const text = Buffer.from(bytes).toString("latin1");
  assert.ok(text.includes("3D/3dmodel.model"), "中央目录/本地头里找不到模型路径");
  assert.ok(text.includes("[Content_Types].xml"));
});
