/**
 * 孔向导回归（P0-1）
 *
 * 判据一律用解析体积，不用肉眼、不看面数：
 *   60×40×8 板 = 19 200 mm³，中心 Ø6、法向 +Z
 *   通孔         20 800? → 见下，全部由公式算出再比对
 *
 * 每个用例都同时断言「没碰别的地方」：包围盒必须仍是 60×40×8。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import opencascade from "replicad-opencascadejs";
import { setOC, makeBaseBox, measureVolume } from "replicad";
import * as OPS from "./src/ops.js";
import { rebuild, replayOp } from "./src/replay.js";

setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
const PI = Math.PI;
/** 容差 1e-3 mm³：布尔与网格都不该动摇解析值 */
const close = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) < tol, `体积 ${a} != 期望 ${b}`);

const PLATE = 60 * 40 * 8;            // 19 200
const plate = () => makeBaseBox(60, 40, 8);   // XY 居中，底面 z=0，顶面 z=8
const TOP = { at: [0, 0, 8], normal: [0, 0, 1] };

/** 断言「只多了这个孔」，板的外形没变 */
function assertPlateBox(shape) {
  const bb = shape.boundingBox;
  assert.ok(Math.abs(bb.width - 60) < 1e-6 && Math.abs(bb.height - 40) < 1e-6 && Math.abs(bb.depth - 8) < 1e-6,
    `包围盒被改了：${bb.width}×${bb.height}×${bb.depth}`);
}

test("通孔 Ø6 从顶面贯通：体积 = 板 − π·3²·8", () => {
  const out = OPS.holeAt(plate(), { ...TOP, diameter: 6, kind: "through" });
  close(measureVolume(out), PLATE - PI * 9 * 8);
  assertPlateBox(out);
});

test("盲孔 Ø6 深 4：体积 = 板 − π·3²·4", () => {
  const out = OPS.holeAt(plate(), { ...TOP, diameter: 6, kind: "blind", depth: 4 });
  close(measureVolume(out), PLATE - PI * 9 * 4);
  assertPlateBox(out);
});

test("沉头孔 Ø6 通 + Ø12×2：体积 = 板 − π·3²·8 − π·(6²−3²)·2", () => {
  const out = OPS.holeAt(plate(), {
    ...TOP, diameter: 6, kind: "counterbore", headDiameter: 12, headDepth: 2,
  });
  close(measureVolume(out), PLATE - PI * 9 * 8 - PI * (36 - 9) * 2);
  assertPlateBox(out);
});

test("埋头孔 Ø6 通 + Ø12 @90°：体积 = 板 − π·3²·8 − 36π", () => {
  // 锥台 π·h/3·(R²+Rr+r²)，h = (6−3)/tan45° = 3 → π·63；减去同深度圆柱 π·9·3 = 27π → 36π
  const out = OPS.holeAt(plate(), {
    ...TOP, diameter: 6, kind: "countersink", headDiameter: 12, angle: 90,
  });
  close(measureVolume(out), PLATE - PI * 9 * 8 - 36 * PI);
  assertPlateBox(out);
});

test("侧面法向的孔照样成立（法向不归一化也能用）", () => {
  // +X 面法向 (2,0,0)，沿 −X 打穿 60 长：板 − π·3²·60
  const out = OPS.holeAt(plate(), { at: [30, 0, 4], normal: [2, 0, 0], diameter: 6, kind: "through" });
  close(measureVolume(out), PLATE - PI * 9 * 60);
  assertPlateBox(out);
});

test("重放通道：history 里记一条 hole 就能重建同样体积", () => {
  const op = { type: "hole", at: [15, 0, 8], normal: [0, 0, 1], diameter: 6, kind: "through" };
  const viaReplay = replayOp(plate(), op);
  close(measureVolume(viaReplay), PLATE - PI * 9 * 8);
  // 走完整 rebuild：base 自带中心 Ø12 孔，所以孔放在 x=15 处，互不干扰
  const base = OPS.starterModel();
  const rebuilt = rebuild([{ op: { type: "base" } }, { op }], 1).shape;
  close(measureVolume(rebuilt), measureVolume(base) - PI * 9 * 8);
});

test("非法参数明确报错，不静默画出半成品", () => {
  assert.throws(() => OPS.holeAt(plate(), { ...TOP, diameter: 6, kind: "square" }), /孔类型/);
  assert.throws(() => OPS.holeAt(plate(), { at: [0, 0, 8], normal: [0, 0, 0], diameter: 6 }), /零向量/);
  assert.throws(() => OPS.holeAt(plate(), { ...TOP, diameter: 0 }), /孔径/);
  assert.throws(() => OPS.holeAt(plate(), { ...TOP, diameter: 6, kind: "blind" }), /盲孔深度/);
  assert.throws(() => OPS.holeAt(plate(), { ...TOP, diameter: 6, kind: "counterbore", headDiameter: 5, headDepth: 2 }), /沉头直径/);
  assert.throws(() => OPS.holeAt(plate(), { ...TOP, diameter: 6, kind: "countersink", headDiameter: 12, angle: 180 }), /埋头角度/);
  assert.throws(() => OPS.holeAt(null, { ...TOP, diameter: 6 }), /先有实体/);
});

console.log(`\n孔向导回归：${passed} 项通过`);
