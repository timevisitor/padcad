/**
 * D 批「曲面」回归：表面偏移 / 缝合 / 补面 / 片体加厚
 *
 * 判据一律用**解析面积/体积**，不看面数、不看肉眼：
 *   r20 h10 圆柱侧面 +2  → 体积 π×22²×10 = 15205.308
 *   r20 h10 圆柱侧面 −2  → 体积 π×18²×10 = 10178.760
 *   20×20 平面片体加厚 3 → 体积 400×3 = 1200
 *   20×20 轮廓补面       → 面积 400
 *   带 5×5 缺口轮廓补面  → 面积 375
 *   盒的 6 个面缝合      → 实体 20×20×3 = 1200
 *
 * 每个 op 都再走一遍 rebuild([{base},{op}],1)，证明它真能进 JSON、真能被重放。
 * 片体类 op（补面/缝合）在重放链里产出的是片体（不是实体），
 * 因为 base 是实体、它们的输入是轮廓而不是实体 —— 这条限制在报告里写明。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import opencascade from "replicad-opencascadejs";
import {
  setOC, makeCylinder, makeBaseBox, compoundShapes,
  measureArea, measureVolume, drawRectangle,
} from "replicad";
import * as S from "./src/surface.js";
import { registeredOps, lookupOp } from "./src/op-registry.js";
import { rebuild } from "./src/replay.js";
import * as OPS from "./src/ops.js";

setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));

const PI = Math.PI;
let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failures.push({ name, message: e?.message || String(e) });
    console.log(`FAIL ${name}\n     ${e?.message || e}`);
  }
}
/** 绝对容差 */
const close = (got, want, tol, what = "值") =>
  assert.ok(Math.abs(got - want) <= tol, `${what} ${got.toFixed(3)} 与解析值 ${want.toFixed(3)} 相差 ${Math.abs(got - want).toFixed(3)}，超出容差 ${tol}`);
/** 相对容差（返回实测偏差百分比，方便报告引用） */
function closeRel(got, want, pct, what = "值") {
  const dev = Math.abs(got - want) / Math.abs(want) * 100;
  assert.ok(dev <= pct, `${what} ${got.toFixed(3)} 与解析值 ${want.toFixed(3)} 偏差 ${dev.toFixed(3)}%，超出 ${pct}%`);
  return dev;
}

// ---------------------------------------------------------------- 素材
const cyl = makeCylinder(20, 10);                              // 底面圆心在原点
const sheet = drawRectangle(20, 20).sketchOnPlane("XY").face(); // 20×20 平面片体，z=0
const box = makeBaseBox(20, 20, 3);
const SIDE = { geomType: "CYLINDRE" };                          // 圆柱侧面（唯一的曲面）
const TOP = { geomType: "PLANE", normal: [0, 0, 1] };

const V_CYL = PI * 400 * 10;          // 12566.371
const V_OUT2 = PI * 484 * 10;         // 15205.308
const V_IN2 = PI * 324 * 10;          // 10178.760

console.log(`素材：圆柱 ${measureVolume(cyl).toFixed(3)}（解析 ${V_CYL.toFixed(3)}）、片体 ${measureArea(sheet).toFixed(3)}、盒 ${measureVolume(box).toFixed(3)}`);

// ---------------------------------------------------------------- 0. 注册
test("四个 op（+补面别名）都已在注册表里", () => {
  const reg = registeredOps();
  for (const t of ["surface_offset", "surface_thicken", "surface_stitch", "surface_fill", "surface_patch"]) {
    assert.ok(reg.includes(t), `注册表里没有 ${t}（现有：${reg.join(",")}）`);
    assert.equal(typeof lookupOp(t), "function", `${t} 没绑到函数`);
  }
});

// ---------------------------------------------------------------- 1. 表面偏移
test("surface_offset：圆柱侧面 +2 → 体积 = π×22²×10（偏差 <2%）", () => {
  const out = S.surfaceOffset(cyl, { distance: 2, face: SIDE });
  const v = measureVolume(out);
  const dev = closeRel(v, V_OUT2, 2, "体积");
  console.log(`     实测 ${v.toFixed(3)} / 解析 ${V_OUT2.toFixed(3)}，偏差 ${dev.toFixed(4)}%`);
  // 半径 20→22：XY 范围 44；高度不该变，仍是 10
  const bb = out.boundingBox;
  close(bb.width, 44, 1e-6, "包围盒 X");
  close(bb.height, 44, 1e-6, "包围盒 Y");
  close(bb.depth, 10, 1e-6, "包围盒 Z");
});

test("surface_offset：圆柱侧面 −2 → 体积 = π×18²×10", () => {
  const v = measureVolume(S.surfaceOffset(cyl, { distance: -2, face: SIDE }));
  closeRel(v, V_IN2, 0.5, "体积");
});

test("surface_offset：片体（20×20）偏置 +3 → 面积仍是 400，整体抬到 z=3", () => {
  const out = S.surfaceOffset(sheet, { distance: 3 });
  close(measureArea(out), 400, 0.5, "面积");
  close(out.boundingBox.bounds[0][2], 3, 1e-6, "偏置面 z");
});

test("surface_offset：whole 整体偏置 +2 → π×22²×14 的 −1.1%（端面棱边被圆弧化）", () => {
  const out = S.surfaceOffset(cyl, { distance: 2, whole: true });
  const v = measureVolume(out);
  const dev = closeRel(v, PI * 484 * 14, 2, "体积");
  console.log(`     实测 ${v.toFixed(3)} / 整体解析 ${(PI * 484 * 14).toFixed(3)}，偏差 ${dev.toFixed(3)}%`);
});

test("surface_offset：盒顶面 +3 → 20×20×6 = 2400", () => {
  const v = measureVolume(S.surfaceOffset(box, { distance: 3, face: TOP }));
  closeRel(v, 2400, 0.5, "体积");
});

// ---------------------------------------------------------------- 2. 片体加厚
test("surface_thicken：20×20 片体 +3 → 体积 1200（±1%）", () => {
  const out = S.surfaceThicken(sheet, { thickness: 3 });
  const v = measureVolume(out);
  assert.ok(v > 0, `体积为负（${v}）说明壳朝向反了`);
  closeRel(v, 1200, 1, "体积");
  close(out.boundingBox.bounds[0][2], 0, 1e-6, "加厚体底面 z");
  close(out.boundingBox.bounds[1][2], 3, 1e-6, "加厚体顶面 z");
});

test("surface_thicken：同片体 −3 → 也是 1200，但长在法向反侧（z ∈ [−3,0]）", () => {
  const out = S.surfaceThicken(sheet, { thickness: -3 });
  closeRel(measureVolume(out), 1200, 1, "体积");
  close(out.boundingBox.bounds[0][2], -3, 1e-6, "加厚体底面 z");
});

test("surface_thicken：盒顶面 +3 → 2400", () => {
  const v = measureVolume(S.surfaceThicken(box, { thickness: 3, face: TOP }));
  closeRel(v, 2400, 0.5, "体积");
});

// ---------------------------------------------------------------- 3. 补面
test("surface_fill：20×20 闭合轮廓 → 面积 400 ±0.5", () => {
  const pts = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
  const out = S.surfaceFill(null, { points: pts });
  close(measureArea(out), 400, 0.5, "面积");
});

test("surface_fill：带 5×5 缺口的轮廓 → 面积 375 ±0.5（解析 400−25）", () => {
  const pts = [[-10, -5], [-5, -5], [-5, -10], [10, -10], [10, 10], [-10, 10]];
  const out = S.surfaceFill(null, { points: pts });
  close(measureArea(out), 375, 0.5, "面积");
});

test("surface_fill：不给 points 时用片体自己的外边界 → 400 ±0.5", () => {
  const out = S.surfaceFill(sheet, {});
  close(measureArea(out), 400, 0.5, "面积");
});

test("surface_patch：同义名，同一张面 → 400 ±0.5", () => {
  const out = lookupOp("surface_patch")(null, { points: [[-10, -10], [10, -10], [10, 10], [-10, 10]] });
  close(measureArea(out), 400, 0.5, "面积");
});

// ---------------------------------------------------------------- 4. 缝合
test("surface_stitch：盒的 6 个面缝成闭合实体 → 体积 1200", () => {
  const out = S.surfaceStitch(box, {});
  assert.equal(out.constructor.name, "Solid", `缝合结果不是实体，而是 ${out.constructor.name}`);
  closeRel(measureVolume(out), 1200, 0.5, "体积");
});

test("surface_stitch：两片共边平面 → 缝成一片，面积 = 800", () => {
  const a = drawRectangle(20, 20).sketchOnPlane("XY").face();
  const b = drawRectangle(20, 20).sketchOnPlane("XY").face().translate(20, 0, 0);
  const comp = compoundShapes([a, b]);
  const out = S.surfaceStitch(comp, {});
  close(measureArea(out), 800, 1e-3, "面积");
});

test("surface_stitch：两片相距 5mm → 明确报间隙 5.00 mm", () => {
  const a = drawRectangle(20, 20).sketchOnPlane("XY").face();
  const b = drawRectangle(20, 20).sketchOnPlane("XY").face().translate(25, 0, 0);
  const comp = compoundShapes([a, b]);
  assert.throws(
    () => S.surfaceStitch(comp, {}),
    /这两片不连续，缝不上（间隙 5\.00 mm）/
  );
});

// ---------------------------------------------------------------- 5. 重放通道
test("rebuild：surface_offset 走完整重放 → 体积 = 底板 + 顶面面积×2", () => {
  const base = rebuild([{ op: { type: "base" } }], 0).shape;
  const holeArea = PI * 36;                       // 底板中心 Ø12 孔
  const topArea = 60 * 40 - holeArea;             // 顶面净面积
  const want = measureVolume(base) + topArea * 2;
  const out = rebuild([
    { op: { type: "base" } },
    { op: { type: "surface_offset", distance: 2, face: { geomType: "PLANE", normal: [0, 0, 1] } } },
  ], 1).shape;
  const v = measureVolume(out);
  closeRel(v, want, 0.5, "体积");
  assert.ok(v > measureVolume(base), "重放后体积没有变大，偏移没生效");
});

test("rebuild：surface_thicken 走完整重放 → 体积 = 底板 + 顶面面积×3", () => {
  const base = rebuild([{ op: { type: "base" } }], 0).shape;
  const want = measureVolume(base) + (60 * 40 - PI * 36) * 3;
  const out = rebuild([
    { op: { type: "base" } },
    { op: { type: "surface_thicken", thickness: 3, face: { geomType: "PLANE", normal: [0, 0, 1] } } },
  ], 1).shape;
  closeRel(measureVolume(out), want, 0.5, "体积");
});

test("rebuild：surface_fill 走完整重放 → 面积 375（产出片体，见文件头限制说明）", () => {
  const out = rebuild([
    { op: { type: "base" } },
    { op: { type: "surface_fill", points: [[-10, -5], [-5, -5], [-5, -10], [10, -10], [10, 10], [-10, 10]] } },
  ], 1).shape;
  assert.equal(out.constructor.name, "Face", `补面结果应是 Face，实际 ${out.constructor.name}`);
  close(measureArea(out), 375, 0.5, "面积");
});

test("rebuild：surface_stitch 走完整重放 → 缝合不改变总面积", () => {
  const base = rebuild([{ op: { type: "base" } }], 0).shape;
  const f0 = base.faces[0], f1 = base.faces[1];
  const want = measureArea(f0) + measureArea(f1);
  const out = rebuild([
    { op: { type: "base" } },
    { op: { type: "surface_stitch", faces: [{ index: 0 }, { index: 1 }] } },
  ], 1).shape;
  closeRel(measureArea(out), want, 0.1, "面积");
});

// ---------------------------------------------------------------- 6. 参数校验（中文报错，不静默）
test("非法参数一律抛中文错误", () => {
  assert.throws(() => S.surfaceOffset(cyl, { distance: NaN, face: SIDE }), /偏移距离/);
  assert.throws(() => S.surfaceOffset(cyl, { distance: 0, face: SIDE }), /不能是 0/);
  assert.throws(() => S.surfaceOffset(null, { distance: 2 }), /需要先有一个实体或片体/);
  assert.throws(() => S.surfaceOffset(cyl, { distance: 2 }), /符合条件的面有 \d+ 张/);
  assert.throws(() => S.surfaceOffset(cyl, { distance: 2, face: { geomType: "SPHERE" } }), /找不到 geomType/);
  assert.throws(() => S.surfaceOffset(cyl, { distance: 2, face: { index: 99 } }), /面序号 99 超出范围/);

  assert.throws(() => S.surfaceThicken(sheet, { thickness: undefined }), /加厚厚度/);
  assert.throws(() => S.surfaceThicken(sheet, { thickness: 0 }), /不能是 0/);
  assert.throws(() => S.surfaceThicken(null, { thickness: 3 }), /加厚需要先有一个片体或实体/);

  assert.throws(() => S.surfaceFill(null, { points: [[0, 0], [1, 1]] }), /至少要 3 个点/);
  assert.throws(() => S.surfaceFill(null, { points: [[0, 0], [1, "a"], [2, 2]] }), /必须是 \[x,y\]/);
  assert.throws(() => S.surfaceFill(null, {}), /闭合轮廓/);
  assert.throws(() => S.surfaceFill(box, {}), /闭合轮廓/);

  assert.throws(() => S.surfaceStitch(box, { tolerance: 0 }), /容差/);
  assert.throws(() => S.surfaceStitch(null, {}), /至少要两片/);
  assert.throws(() => S.surfaceStitch(sheet, {}), /至少要两片/);
});

console.log(`\n曲面回归：${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  for (const f of failures) console.log(` - ${f.name}: ${f.message}`);
  process.exit(1);
}
