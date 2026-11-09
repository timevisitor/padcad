/**
 * STEP 导入稳健性回归（2026-11-08，用户反馈「导入不了 step」）
 *
 * 夹具全部在测试里用内核现场生成（不入库任何第三方零件）：
 *   单实体 / 多实体 / 开口面片 / 封闭壳 / 带 UTF-8 BOM / 垃圾文件 / zip / 空文件 / STL 改名
 * 每条断言"结果数值"（体积、实体数、降级层级）或"错误原因文案"，不只断言"没抛异常"。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import opencascade from "replicad-opencascadejs";
import { setOC, makeBaseBox, makeCylinder, makeCompound, drawRectangle, measureVolume, getOC } from "replicad";
import { readStepBytes, sniffStep, normalizeStepBytes, safeVolume } from "./src/step-io.js";

setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
const close = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const stepOf = async (shape) => new Uint8Array(await shape.blobSTEP().arrayBuffer());

await test("单实体：体积守恒 19200，层级 solid", async () => {
  const r = readStepBytes(await stepOf(makeBaseBox(60, 40, 8)), { name: "box.step" });
  assert.equal(r.level, "solid"); assert.equal(r.solids, 1);
  close(safeVolume(r), 19200);
});

await test("多实体（装配式 compound）：实体数 2、体积相加、给出提示", async () => {
  const a = makeBaseBox(10, 10, 10);
  const b = makeCylinder(5, 10, [30, 0, 0], [0, 0, 1]);
  const r = readStepBytes(await stepOf(makeCompound([a, b])), { name: "asm.step" });
  assert.equal(r.solids, 2); assert.equal(r.level, "solid");
  close(safeVolume(r), 1000 + Math.PI * 25 * 10, 1e-2);
  assert.ok(r.warnings.some((w) => /2 个实体/.test(w)));
});

await test("开口面片：不报错，降级为 face/shell 且体积为 null（不给假体积）", async () => {
  const face = drawRectangle(20, 10).sketchOnPlane("XY").face();
  const r = readStepBytes(await stepOf(face), { name: "face.step" });
  assert.ok(["face", "shell"].includes(r.level), r.level);
  assert.equal(safeVolume(r), null);
  assert.ok(r.faces >= 1);
});

await test("封闭壳（只导出外壳面）：自动缝合成实体，体积 = 1000", async () => {
  const oc = getOC();
  const box = makeBaseBox(10, 10, 10);
  const sh = new oc.TopExp_Explorer(box.wrapped, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  const { cast, downcast } = await import("replicad");
  const shell = cast(downcast(sh.Current()));
  const r = readStepBytes(await stepOf(shell), { name: "shell.step" });
  assert.equal(r.level, "shell-sewn");
  close(Math.abs(safeVolume(r)), 1000);
});

await test("带 UTF-8 BOM + 前导空行：能读，体积不变", async () => {
  const raw = await stepOf(makeBaseBox(60, 40, 8));
  const withBom = new Uint8Array(raw.length + 5);
  withBom.set([0xef, 0xbb, 0xbf, 0x0d, 0x0a]); withBom.set(raw, 5);
  assert.equal(normalizeStepBytes(withBom).length, raw.length);
  const r = readStepBytes(withBom, { name: "bom.step" });
  close(safeVolume(r), 19200);
});

await test("垃圾文本：明确报「不是 STEP」，不是内核乱码错误", async () => {
  assert.throws(() => readStepBytes(new TextEncoder().encode("hello world"), { name: "x.step" }), /不是 STEP/);
});

await test("zip 压缩包改名：提示先解压", async () => {
  assert.throws(() => readStepBytes(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]), { name: "x.step" }), /解压/);
});

await test("0 字节：提示文件是空的", async () => {
  assert.throws(() => readStepBytes(new Uint8Array(0), { name: "x.step" }), /空的/);
});

await test("STL 改名成 .step：提示改回看图模式", async () => {
  assert.throws(() => readStepBytes(new TextEncoder().encode("solid a\nfacet normal 0 0 1\n"), { name: "x.step" }), /STL/);
});

await test("头部合法但正文截断：报解析失败而不是 null shape", async () => {
  const raw = await stepOf(makeBaseBox(60, 40, 8));
  const cut = raw.subarray(0, Math.floor(raw.length * 0.4));
  assert.throws(() => readStepBytes(cut, { name: "cut.step" }), (e) => /cut\.step：/.test(e.message) && !/has not type/.test(e.message));
});

await test("嗅探能读出 FILE_SCHEMA", async () => {
  const s = sniffStep(await stepOf(makeBaseBox(1, 1, 1)));
  assert.equal(s.ok, true); assert.ok(s.schema.length > 0);
});

await test("连续导入 20 次不泄漏虚拟文件", async () => {
  const raw = await stepOf(makeBaseBox(5, 5, 5));
  for (let i = 0; i < 20; i++) readStepBytes(raw);
  const left = getOC().FS.readdir("/").filter((f) => f.startsWith("padcad-import-"));
  assert.equal(left.length, 0);
});

console.log(`\nSTEP 导入回归：${passed} 项通过`);
