/**
 * v6 智能草图 · 自动推理关系（仿 SolidWorks Automatic Relations / Inferencing）回归
 *
 * 判据全部是几何解析值：吸附后 y 必须**精确相等**、平行必须**精确叉积为 0**、
 * 相切后圆心到直线的距离必须**精确等于半径**。不靠肉眼。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  inferRelations, applyInferred, snapDraftPoint, segmentsOf, INFER_SYMBOLS, INFER_PRIORITY,
} from "./src/sketch-infer.js";
import { solveSketch, buildConstraints } from "./src/solver.js";

/** 1px = 0.1mm，容差 10px = 1mm；角度容差 3° */
const OPTS = { mmPerPx: 0.1, distTolPx: 10 };
const rect = (c = [0, 0], w = 20, h = 10) => [{ kind: "rect", c: c.slice(), w, h }];
const types = (r) => r.relations.map((x) => x.type);
const find = (r, t) => r.relations.find((x) => x.type === t);
const seg = (a, b) => ({ kind: "segment", a, b });
const DEG = Math.PI / 180;

test("接近水平（1.2°）：推理出水平，终点 y 被**精确**吸到起点 y", () => {
  const r = inferRelations(rect(), seg([0, 20], [10, 20 + 10 * Math.tan(1.2 * DEG)]), OPTS);
  assert.ok(types(r).includes("horizontal"));
  assert.ok(!types(r).includes("vertical"), "水平与竖直互斥");
  assert.equal(r.snapped.b[1], r.snapped.a[1]);           // 完全相等，不是“近似”
  assert.ok(Math.abs(r.snapped.b[0] - 10) < 1e-9, "x 不该被动");
  assert.equal(r.best.type, "horizontal");
  assert.equal(find(r, "horizontal").symbol.glyph, INFER_SYMBOLS.horizontal.glyph);
});

test("接近竖直（88.5°）：推理出竖直，终点 x 被精确吸到起点 x", () => {
  const r = inferRelations(rect(), seg([0, 20], [0 + 10 * Math.tan(1.5 * DEG), 30]), OPTS);
  assert.ok(types(r).includes("vertical"));
  assert.ok(!types(r).includes("horizontal"));
  assert.equal(r.snapped.b[0], r.snapped.a[0]);
});

test("45° 斜线：既不水平也不竖直，不做方向吸附", () => {
  const r = inferRelations([], seg([40, 40], [50, 50]), OPTS);
  assert.ok(!types(r).includes("horizontal"));
  assert.ok(!types(r).includes("vertical"));
  assert.deepEqual(r.snapped.a, [40, 40]);
  assert.deepEqual(r.snapped.b, [50, 50]);
});

test("角度容差是硬门槛：3.9° 不推水平，把容差放到 5° 才推", () => {
  const draft = seg([0, 0], [10, 10 * Math.tan(3.9 * DEG)]);
  assert.ok(!types(inferRelations([], draft, OPTS)).includes("horizontal"));
  assert.ok(types(inferRelations([], draft, { ...OPTS, angleTolDeg: 5 })).includes("horizontal"));
});

test("端点落在已有角点 0.5mm 内：推重合，坐标吸到精确值，spec 指向那个角点", () => {
  const r = inferRelations(rect(), seg([10.4, 5.3], [30, 5]), OPTS);
  const c = find(r, "coincident");
  assert.ok(c, "应推出重合");
  assert.deepEqual(r.snapped.a, [10, 5]);                 // 精确落在 rect 的 tr
  assert.deepEqual(c.spec, { type: "coincident", a: { draft: 0 }, b: { e: 0, p: "tr" } });
  assert.equal(c.confidence > 0.5, true);
});

test("端点落在某段中点附近：推中点，坐标吸到中点", () => {
  const r = inferRelations(rect(), seg([0.2, -4.8], [30, -4.8]), OPTS);
  const m = find(r, "midpoint");
  assert.ok(m, "应推出中点");
  assert.deepEqual(r.snapped.a, [0, -5]);                 // rect 底边中点
  assert.deepEqual(m.spec, { type: "midpoint", p: { draft: 0 }, l: { e: 0, seg: 0 } });
});

test("端点落在某段上（不在端点/中点旁）：推「在线上」，垂足吸附 + pointToLine(0)", () => {
  const r = inferRelations(rect(), seg([3, -4.8], [3, 20]), OPTS);
  const l = find(r, "onLine");
  assert.ok(l, "应推出在线上");
  assert.deepEqual(r.snapped.a, [3, -5]);                 // 垂足
  assert.equal(l.spec.type, "pointToLine");
  assert.equal(l.spec.value, 0);
});

test("线-圆相切：推相切，吸附后圆心到直线的距离**精确**等于半径", () => {
  const circle = [{ kind: "circle", c: [0, 0], r: 10 }];
  const k = 10 / Math.SQRT2;
  const r = inferRelations(circle, seg([0, 2 * k], [2 * k, 0]), OPTS);
  const t = find(r, "tangent");
  assert.ok(t, `应推出相切（得到 ${types(r).join(",")}）`);
  assert.equal(t.spec.type, "tangent");
  const [a, b] = [r.snapped.a, r.snapped.b];
  const ux = b[0] - a[0], uy = b[1] - a[1];
  const L = Math.hypot(ux, uy);
  const d = Math.abs((0 - a[0]) * uy - (0 - a[1]) * ux) / L;   // 原点到直线距离
  assert.ok(Math.abs(d - 10) < 1e-9, `距离 ${d} 应等于 10`);
});

test("相对已有 30° 线：30.9° 推平行，吸附后方向**精确**平行（叉积 0）", () => {
  const ref = [{ kind: "polyline", pts: [[0, 0], [20 * Math.cos(30 * DEG), 20 * Math.sin(30 * DEG)]], closed: false }];
  const ang = 30.9 * DEG;
  const r = inferRelations(ref, seg([0, 20], [15 * Math.cos(ang), 20 + 15 * Math.sin(ang)]), OPTS);
  const p = find(r, "parallel");
  assert.ok(p, `应推出平行（得到 ${types(r).join(",")}）`);
  assert.equal(p.spec.type, "parallel");
  assert.deepEqual(p.spec.l2, { e: 0, seg: 0 });
  const ux = (r.snapped.b[0] - r.snapped.a[0]), uy = (r.snapped.b[1] - r.snapped.a[1]);
  const L = Math.hypot(ux, uy);
  const cross = (ux / L) * Math.sin(30 * DEG) - (uy / L) * Math.cos(30 * DEG);
  assert.ok(Math.abs(cross) < 1e-9, `叉积 ${cross} 应为 0`);
});

test("相对已有 30° 线：120.2° 推垂直，吸附后方向**精确**垂直（点积 0）", () => {
  const ref = [{ kind: "polyline", pts: [[0, 0], [20 * Math.cos(30 * DEG), 20 * Math.sin(30 * DEG)]], closed: false }];
  const ang = 120.2 * DEG;
  const r = inferRelations(ref, seg([0, 20], [15 * Math.cos(ang), 20 + 15 * Math.sin(ang)]), OPTS);
  const p = find(r, "perpendicular");
  assert.ok(p, `应推出垂直（得到 ${types(r).join(",")}）`);
  const ux = (r.snapped.b[0] - r.snapped.a[0]), uy = (r.snapped.b[1] - r.snapped.a[1]);
  const L = Math.hypot(ux, uy);
  const dot = (ux / L) * Math.cos(30 * DEG) + (uy / L) * Math.sin(30 * DEG);
  assert.ok(Math.abs(dot) < 1e-9, `点积 ${dot} 应为 0`);
});

test("等长：与已有 30° 线长度一致时推等长，吸附后长度精确相等", () => {
  const ref = [{ kind: "polyline", pts: [[0, 0], [20 * Math.cos(30 * DEG), 20 * Math.sin(30 * DEG)]], closed: false }];
  const ang = 75 * DEG;                                  // 与 30° 既不平行也不垂直
  const L0 = 20.05;
  const r = inferRelations(ref, seg([0, 30], [L0 * Math.cos(ang), 30 + L0 * Math.sin(ang)]), OPTS);
  const eq = find(r, "equalLength");
  assert.ok(eq, `应推出等长（得到 ${types(r).join(",")}）`);
  assert.equal(eq.spec.type, "equalLength");
  const len = Math.hypot(r.snapped.b[0] - r.snapped.a[0], r.snapped.b[1] - r.snapped.a[1]);
  assert.ok(Math.abs(len - 20) < 1e-9, `吸附后长度 ${len} 应等于 20`);
});

test("方向类与旋转类互斥：只保留置信度高的那条，另一条标记 suppressed", () => {
  const circle = [{ kind: "circle", c: [0, 0], r: 10 }];
  // 近似水平又近似相切：水平（0.95）胜出，相切被抑制
  const r = inferRelations(circle, seg([-20, 10.4], [20, 10.2]), OPTS);
  assert.ok(types(r).includes("horizontal"));
  assert.ok(r.suppressed.includes("tangent"));
  assert.ok(!r.applied.includes("tangent"));
  assert.ok(!r.symbols.some((s) => s.kind === "tangent"), "被抑制的关系不该画符号");
});

test("同类型候选只留最好的一条（画一条线会同时命中多条参考边）", () => {
  const d = 30 * DEG;
  const ents = [
    { kind: "polyline", pts: [[0, 0], [25 * Math.cos(d), 25 * Math.sin(d)]], closed: false },
    { kind: "polyline", pts: [[0, 3], [25 * Math.cos(d), 3 + 25 * Math.sin(d)]], closed: false },
  ];
  const a2 = 30.4 * DEG;
  const r = inferRelations(ents, seg([1, 1.4], [1 + 15 * Math.cos(a2), 1.4 + 15 * Math.sin(a2)]), OPTS);
  const active = r.relations.filter((x) => x.type === "parallel" && !x.suppressed);
  assert.equal(active.length, 1);
});

test("enabled:false（Ctrl 临时抑制）直接返回空结果", () => {
  const r = inferRelations(rect(), seg([10.4, 5.3], [30, 5]), { ...OPTS, enabled: false });
  assert.deepEqual(r.relations, []);
  assert.deepEqual(r.snapped, null);
});

test("只放一个点（kind:point）时只推点关系，不推方向关系", () => {
  const r = inferRelations(rect(), { kind: "point", p: [10.3, 5.2] }, OPTS);
  assert.ok(types(r).includes("coincident"));
  assert.ok(!types(r).includes("horizontal"));
  assert.deepEqual(r.snapped.a, [10, 5]);
  assert.equal(r.snapped.b, null);
});

test("applyInferred：占位符替换成新图元的真实引用，写出的 spec 能通过校验并求解", () => {
  const ents = rect([40, 40], 20, 10);
  const r = inferRelations(ents, seg([50.3, 45.2], [70.2, 45.4]), OPTS);
  assert.ok(r.applied.includes("coincident") || r.applied.includes("horizontal"));
  ents.push({ kind: "polyline", pts: [r.snapped.a, r.snapped.b], closed: false });
  const spec = applyInferred(ents, r.relations, { e: 1 });
  assert.equal(spec.rejected.length, 0);
  assert.ok(spec.specs.length >= 2);
  // 第一条一定是那个重合（draft:0 → p0）
  const coin = spec.specs.find((s) => s.type === "coincident");
  assert.ok(coin);
  assert.deepEqual(coin.a, { e: 1, p: "p0" });
  assert.deepEqual(coin.b, { e: 0, p: "tr" });
  // 求解之后关系必须真的成立
  const before = structuredClone(ents);
  const solved = solveSketch(ents, spec.specs);
  assert.equal(solved.ok, true);
  const p0 = ents[1].pts[0], p1 = ents[1].pts[1];
  assert.ok(Math.abs(ents[0].c[0] + ents[0].w / 2 - p0[0]) < 1e-6, "p0 应贴在 rect 右上角 x");
  assert.ok(Math.abs(ents[0].c[1] + ents[0].h / 2 - p0[1]) < 1e-6, "p0 应贴在 rect 右上角 y");
  assert.ok(Math.abs(p1[1] - p0[1]) < 1e-6, "水平关系应成立");
  assert.ok(before.length === ents.length);
});

test("applyInferred：坏引用被逐条拦下（不把坏 spec 写进工程）", () => {
  const ents = rect();
  const r = inferRelations(ents, seg([10.3, 5.1], [30, 5]), OPTS);
  const bad = applyInferred(ents, r.relations, { e: 99 });
  assert.ok(bad.rejected.length > 0 || bad.specs.length === 0);
  for (const s of bad.specs) assert.doesNotThrow(() => buildConstraints(ents, [s]));
});

test("applyInferred：被抑制的关系不写入（返回 skipped 说明原因）", () => {
  const ents = rect();
  const circle = [{ kind: "circle", c: [0, 0], r: 10 }];
  const r = inferRelations(circle, seg([-20, 10.4], [20, 10.2]), OPTS);
  ents.push({ kind: "polyline", pts: [r.snapped.a, r.snapped.b], closed: false });
  const out = applyInferred(ents, r.relations, { e: 1 });
  assert.ok(out.skipped.some((s) => s.type === "tangent"));
  assert.ok(!out.specs.some((s) => s.type === "tangent"));
});

test("snapDraftPoint：只给坐标（不写约束）", () => {
  const s = snapDraftPoint(rect(), seg([0, 20], [10, 20.2]), OPTS);
  assert.equal(s.b[1], s.a[1]);
});

test("segmentsOf：把矩形/折线摊平成带端点名的线段，引用图元带 fixed 标记", () => {
  const ents = [...rect(), { kind: "polyline", pts: [[0, 8], [10, 8]], closed: false, ref: true }];
  const segs = segmentsOf(ents);
  assert.equal(segs.filter((s) => s.e === 0).length, 4);
  assert.equal(segs.filter((s) => s.e === 1).length, 1);
  assert.equal(segs.find((s) => s.e === 1).fixed, true);
  assert.deepEqual(segs.find((s) => s.e === 1).refA, { e: 1, p: "p0" });
});

test("符号表覆盖全部推理类型，且优先级数值有序（UI 画图标用）", () => {
  for (const t of ["coincident", "horizontal", "vertical", "midpoint", "onLine", "tangent", "perpendicular", "parallel", "equalLength"]) {
    assert.ok(INFER_SYMBOLS[t], `${t} 缺符号`);
    assert.ok(Number.isFinite(INFER_PRIORITY[t]), `${t} 缺优先级`);
  }
  assert.ok(INFER_PRIORITY.coincident > INFER_PRIORITY.equalLength);
});
