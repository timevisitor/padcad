import assert from "node:assert/strict";
import { parsePLY, parseOBJ, parseSTL } from "./src/importers.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
const xyz = "property float x\nproperty float y\nproperty float z\n";
const quad = "0 0 0\n1 0 0\n1 1 0\n0 1 0\n";
const header = (format = "ascii", props = xyz, extra = "") =>
  `ply\nformat ${format} 1.0\ncomment end_header is only a comment\nelement vertex 4\n${props}${extra}element face 1\nproperty list ushort uint16 vertex_indices\nend_header\n`;
const area = (m) => {
  let sum = 0;
  for (let i = 0; i < m.positions.length; i += 9) {
    const p = m.positions;
    sum += Math.abs((p[i+3]-p[i])*(p[i+7]-p[i+1])-(p[i+4]-p[i+1])*(p[i+6]-p[i])) / 2;
  }
  return sum;
};
test("PLY quad preserves both triangles and full surface area", () => {
  const mesh = parsePLY(Buffer.from(header() + quad + "4 0 1 2 3\n"));
  assert.equal(mesh.triangleCount, 2);
  assert.equal(area(mesh), 1);
});
function binaryQuad(bigEndian = false) {
  const head = Buffer.from(header(bigEndian ? "binary_big_endian" : "binary_little_endian").replaceAll("\n", "\r\n"));
  const data = Buffer.alloc(48 + 10);
  const points = [0,0,0, 1,0,0, 1,1,0, 0,1,0];
  points.forEach((v, i) => data[bigEndian ? "writeFloatBE" : "writeFloatLE"](v, i * 4));
  [4,0,1,2,3].forEach((v, i) => data[bigEndian ? "writeUInt16BE" : "writeUInt16LE"](v, 48 + i * 2));
  return Buffer.concat([head, data]);
}
for (const be of [false, true]) test(`PLY binary ${be ? "big" : "little"} endian, CRLF, ushort list`, () => {
  const mesh = parsePLY(binaryQuad(be));
  assert.equal(mesh.triangleCount, 2);
  assert.equal(area(mesh), 1);
  assert.ok([...mesh.positions, ...mesh.normals].every(Number.isFinite));
});
test("PLY respects reordered coordinates, colors, and intervening elements", () => {
  const props = "property uchar red\nproperty float z\nproperty float x\nproperty float y\n";
  const text = header("ascii", props, "element edge 1\nproperty list uchar int endpoints\n") +
    "255 0 0 0\n255 0 1 0\n255 0 1 1\n255 0 0 1\n2 0 1\n4 0 1 2 3\n";
  assert.equal(area(parsePLY(Buffer.from(text))), 1);
});
test("PLY respects non-index face properties and vertex_index alias", () => {
  const text = header().replace("property list ushort uint16 vertex_indices", "property uchar red\nproperty list uchar int vertex_index\nproperty float quality") +
    quad + "255 4 0 1 2 3 0.5\n";
  assert.equal(area(parsePLY(Buffer.from(text))), 1);
});
test("PLY honors typed-array byte boundaries", () => {
  const buf = binaryQuad();
  const storage = Buffer.concat([Buffer.alloc(9), buf, Buffer.alloc(9)]);
  assert.equal(area(parsePLY(storage.subarray(9, 9 + buf.length))), 1);
  assert.throws(() => parsePLY(storage.subarray(9, 9 + buf.length - 2)), /不完整/);
});
test("PLY rejects missing coordinates, truncated data, and unknown types", () => {
  assert.throws(() => parsePLY(Buffer.from(header().replace("property float z\n", "") + quad + "4 0 1 2 3\n")), /坐标/);
  assert.throws(() => parsePLY(Buffer.from(header() + quad + "4 0 1\n")), /不完整/);
  assert.throws(() => parsePLY(Buffer.from(header().replace("float x", "invented x") + quad + "4 0 1 2 3\n")), /类型/);
});
const triangleOBJ = "v 0 0 0\nv 1 0 0\nv 0 1 0\n";
test("OBJ accepts tabs, negative indices, and inline comments", () => {
  const mesh = parseOBJ("v\t0 0 0\nv\t1 0 0\nv\t0 1 0\nf\t-3 -2 -1 # triangle\n");
  assert.equal(mesh.triangleCount, 1);
  assert.equal(area(mesh), .5);
});
test("OBJ does not repair invalid index tokens into different faces", () => {
  for (const index of ["2bad", "2.5", "0", "-9", "NaN"]) {
    assert.throws(() => parseOBJ(triangleOBJ + `f 1 ${index} 2 3\n`), /无效/);
  }
  const mesh = parseOBJ(triangleOBJ + "f 1 2 3\nf 1 garbage 2 3\n");
  assert.equal(mesh.triangleCount, 1);
  assert.equal(mesh.skipped, 1);
});
test("OBJ refuses NaN and overflow coordinates", () => {
  for (const invalid of ["NaN", "1e100", "bad"]) {
    assert.throws(() => parseOBJ(`v ${invalid} 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n`), /无效/);
  }
});
function stl(normal = [0,0,4]) {
  const buf = Buffer.alloc(134);
  buf.writeUInt32LE(1,80);
  [...normal, 0,0,0, 1,0,0, 0,1,0].forEach((v,i) => buf.writeFloatLE(v,84+i*4));
  return buf;
}
test("STL normalizes normals and repairs non-finite normal metadata", () => {
  assert.deepEqual(Array.from(parseSTL(stl()).normals.slice(0,3)), [0,0,1]);
  assert.deepEqual(Array.from(parseSTL(stl([NaN,0,0])).normals.slice(0,3)), [0,0,1]);
});
test("STL rejects incomplete and non-finite vertices", () => {
  const buf = stl(); buf.writeFloatLE(NaN,96);
  assert.throws(() => parseSTL(buf), /无效坐标/);
  assert.throws(() => parseSTL(Buffer.from("solid test\nvertex 0 0 0\nvertex 1 0 0\nendsolid")), /不完整/);
  assert.throws(() => parseSTL(Buffer.from("solid test\nvertex NaN 0 0\nvertex 1 0 0\nvertex 0 1 0\nendsolid")), /无效/);
});
console.log(`Importer regressions: ${passed} passed`);
