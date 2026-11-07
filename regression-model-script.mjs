/**
 * 回归：建模脚本（script）与新增特征（基础形体 / 螺旋 / 几何选择器）
 *
 * 纪律：所有几何结论都**用体积/包围盒对账解析公式**，不看截图、不信「跑成功了」。
 * 来源参照 Yi3D（Apache-2.0）：它的 SKILL.md 明确要求「脚本执行成功 ≠ 几何正确」，
 * 这份测试就是把那条要求变成可执行的断言。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import opencascade from "replicad-opencascadejs";
import * as R from "replicad";
import * as P from "./src/primitives.js";
import * as S from "./src/model-script.js";
import { resolveFaceSelector, resolveEdgesSelector } from "./src/selectors.js";
import { rebuild } from "./src/replay.js";

R.setOC(await opencascade({ wasmBinary: fs.readFileSync(new URL("./public/replicad_single.wasm", import.meta.url)) }));

const vol = (s) => R.measureVolume(s);
const near = (got, want, rel = 1e-6) => assert.ok(
  Math.abs(got - want) <= Math.max(Math.abs(want) * rel, 1e-9),
  `${got} 与 ${want} 差了 ${Math.abs(got - want)}（相对 ${Math.abs((got - want) / (want || 1))}）`,
);
const bbox = (s) => { const b = s.boundingBox; return [b.width, b.height, b.depth]; };

// ------------------------------------------------------------------ 参数表达式
test("参数表达式：四则、括号、优先级、$引用、$$转义", () => {
  assert.equal(S.evalFormula("2+3*4", {}), 14);
  assert.equal(S.evalFormula("(2+3)*4", {}), 20);
  assert.equal(S.evalFormula("-$a", { a: 5 }), -5);
  assert.equal(S.evalFormula("$L*2-3", { L: 10 }), 17);
  assert.equal(S.evalFormula("$a+$b", { a: "$L/2", b: 1, L: 10 }), 6);       // 参数本身也是表达式
  assert.equal(S.resolveParams(["$L", "顶面", "$$L"], { L: 8 })[2], "$L");   // 文字里的 $ 用 $$ 转义
  assert.throws(() => S.evalFormula("$missing+1", {}), /没有定义/);
  assert.throws(() => S.evalFormula("1/0", {}), /除以了 0/);
  assert.throws(() => S.evalFormula("2+*3", {}), /看不懂/);
  assert.throws(() => S.evalFormula("1+2)", {}), /多余的字符/);
  // 常量 / 函数 / 幂（建模里天天用：$PI*$R^2*$H、$sqrt($a^2+$b^2)）
  assert.equal(S.evalFormula("$PI*2", {}), Math.PI * 2);
  assert.equal(S.evalFormula("$R^2", { R: 3 }), 9);
  assert.equal(S.evalFormula("2^3^2", {}), 512);                       // 幂右结合
  assert.equal(S.evalFormula("$sqrt($a^2+$b^2)", { a: 3, b: 4 }), 5);
  assert.equal(S.evalFormula("$max(1,7,3)", {}), 7);
  assert.throws(() => S.evalFormula("$nope(1)", {}), /没有函数/);
  assert.throws(() => S.evalFormula("$sqrt(4", {}), /少了 , 或 \)/);
  // 坐标数组里直接写算式（开头不是 $ 也算），而名字类字符串原样保留
  const p = { T: 12 };
  assert.deepEqual(S.resolveParams(["-($T+20)/2", 0, "$T"], p), [-16, 0, 12]);
  assert.deepEqual(S.resolveParams(["box", "XY", "凸台-拉伸", "12mm"], p), ["box", "XY", "凸台-拉伸", "12mm"]);
});

test("脚本校验：版本、空步骤、缺 op.type、默认 label 与参数替换", () => {
  assert.throws(() => S.normalizeScript(null), /必须是/);
  assert.throws(() => S.normalizeScript({ v: 99, steps: [] }), /版本/);
  assert.throws(() => S.normalizeScript({ steps: [] }), /没有任何步骤/);
  assert.throws(() => S.normalizeScript({ steps: [{ op: { shape: "box" } }] }), /缺少 op.type/);
  const norm = S.normalizeScript({
    params: { L: 40, H: 10 },
    steps: [{ op: { type: "primitive", shape: "box", size: ["$L", "$L/2", "$H"] } }],
  });
  assert.deepEqual(norm.steps[0].op.size, [40, 20, 10]);
  assert.equal(norm.steps[0].label, "形体");
  assert.equal(norm.strict, true);
});

// ------------------------------------------------------------------ 基础形体
test("基础形体：球/圆柱/圆锥/圆环/长方体体积都对得上解析公式", () => {
  const cases = [
    [P.sphereSolid({ r: 8 }), P.formulas.sphere(8)],
    [P.cylinderSolid({ r: 6, h: 12 }), P.formulas.cylinder(6, 12)],
    [P.torusSolid({ R: 20, r: 4 }), P.formulas.torus(20, 4)],
    [P.coneSolid({ r1: 10, r2: 3, h: 20 }), P.formulas.cone(10, 3, 20)],
    [P.coneSolid({ r1: 10, r2: 0, h: 20 }), P.formulas.cone(10, 0, 20)],
    [P.boxSolid({ size: [30, 20, 10] }), P.formulas.box(30, 20, 10)],
  ];
  for (const [shape, want] of cases) near(vol(shape), want, 1e-9);
});

test("基础形体：位置与轴向按参数走（不是只在原点朝 +Z 才对）", () => {
  const c = P.cylinderSolid({ r: 5, h: 10, at: [30, -10, 4], dir: [1, 0, 0] });
  assert.deepEqual(bbox(c).map((v) => +v.toFixed(6)), [10, 10, 10]);
  const bb = c.boundingBox;
  // 轴沿 +X：x 从 30 到 40
  assert.ok(Math.abs(bb.bounds[0][0] - 30) < 1e-6 && Math.abs(bb.bounds[1][0] - 40) < 1e-6);
  near(vol(c), P.formulas.cylinder(5, 10), 1e-9);
});

test("形体参数不合法时给的是人话，不是内核异常", () => {
  assert.throws(() => P.cylinderSolid({ r: 0, h: 5 }), /都要大于 0/);
  assert.throws(() => P.torusSolid({ R: 5, r: 5 }), /管半径必须小于环半径/);
  assert.throws(() => P.helixSolid({ R: 2, wireR: 3, pitch: 5, turns: 3 }), /钢丝半径必须小于螺旋半径/);
  assert.throws(() => P.primitiveSolid({ shape: "pyramid" }), /不认识的形体/);
});

test("螺旋（弹簧）：体积 = 截面圆面积 × 螺旋线长度", () => {
  const spec = { R: 20, wireR: 2, pitch: 8, turns: 8 };
  const spring = P.helixSolid(spec);
  near(vol(spring), P.formulas.helix(2, 20, 8, 8), 1e-5);
  // 外径 = 2(R+wireR) = 44；总高 = pitch*turns + 钢丝直径 ≈ 68
  const b = bbox(spring).map((v) => +v.toFixed(3));
  assert.ok(Math.abs(b[0] - 44) < 1e-3 && Math.abs(b[1] - 44) < 1e-3, `外径应 44，实得 ${b}`);
  assert.ok(Math.abs(b[2] - 68) < 0.05, `总高应≈68（扫掠端面与切向垂直，会差百分之一二），实得 ${b[2]}`);
});

// ------------------------------------------------------------------ 选择器
test("面选择器：法向 + 参考点找顶面；多个平行候选必须报错而不是猜", () => {
  const plate = P.boxSolid({ size: [40, 30, 10] });
  const top = resolveFaceSelector(plate, { at: [0, 0, 10], normal: [0, 0, 1] });
  const info = plate.faces.find((f) => f.hashCode === top);
  assert.ok(Math.abs(info.center.z - 10) < 1e-9);

  // 两块分开的板：顶面同高、法向相同 → 用垂距排序并列，必须报错
  const two = P.boxSolid({ size: [10, 10, 5], at: [-30, 0, 0] })
    .fuse(P.boxSolid({ size: [10, 10, 5], at: [30, 0, 0] }));
  assert.throws(
    () => resolveFaceSelector(two, { at: [0, 0, 5], normal: [0, 0, 1] }),
    /多个面同时符合/,
  );
  // 指明确位置就能唯一定位
  const right = resolveFaceSelector(two, { at: [30, 0, 5], normal: [0, 0, 1] });
  assert.ok(Math.abs(two.faces.find((f) => f.hashCode === right).center.x - 30) < 1e-9);
});

test("边选择器：竖直边、孔口圆边、方向过滤、等距并列报错", () => {
  const plate = P.boxSolid({ size: [40, 30, 10] });
  assert.equal(resolveEdgesSelector(plate, { dir: [0, 0, 1], all: true }).length, 4);
  assert.equal(resolveEdgesSelector(plate, { dir: [1, 0, 0], all: true }).length, 4);
  // 最近的一条：离 (-20,-15,5) 最近的应该就是左下那条竖边
  const one = resolveEdgesSelector(plate, { at: [-20, -15, 5], dir: [0, 0, 1] });
  assert.equal(one.length, 1);
  assert.ok(Math.abs(one[0][0] + 20) < 1e-6 && Math.abs(one[0][1] + 15) < 1e-6);

  // 孔口圆边：closed:true 且落在圆柱面上
  const holed = plate.cut(P.cylinderSolid({ r: 6, h: 30, at: [0, 0, -10] }));
  const rings = resolveEdgesSelector(holed, { closed: true, all: true });
  assert.equal(rings.length, 2, `孔口应有上下两条圆边，实得 ${rings.length}`);
  for (const mid of rings) assert.ok(Math.abs(Math.hypot(mid[0], mid[1]) - 6) < 1e-6);
  // 落在指定面上的边（用真实距离筛，不是靠 uv 猜）
  const onCyl = resolveEdgesSelector(holed, { closed: true, all: true, of: { at: [0, 0, 0], type: "CYLINDRE" } });
  assert.equal(onCyl.length, 2);

  // 板的正中：四条竖边等距 → 报错
  assert.throws(() => resolveEdgesSelector(plate, { at: [0, 0, 5], dir: [0, 0, 1] }), /两条边同样符合/);
});

// ------------------------------------------------------------------ 脚本端到端
test("脚本端到端：参数化底板 + 锥台 + 推拉 + 螺旋，逐步体积都能对上", () => {
  const base = 80 * 60 * 12;
  const cone = (Math.PI * 20 / 3) * (18 * 18 + 18 * 10 + 10 * 10);
  const ring = 5 * (80 * 60 - Math.PI * 18 * 18);      // 顶面是环形（中间被锥台占了），推拉出来的是环形柱
  const spring = P.formulas.helix(3, 30, 10, 6);
  const script = {
    v: 1,
    name: "法兰座",
    params: { L: 80, W: 60, T: 12, D: 20, SPRING_TURNS: 6 },
    steps: [
      { op: { type: "primitive", shape: "box", size: ["$L", "$W", "$T"] }, label: "底板",
        expect: { volume: "$L*$W*$T" } },
      { op: { type: "primitive", shape: "cone", r1: 18, r2: 10, h: "$D", at: [0, 0, "$T"], mode: "add" }, label: "锥台",
        expect: { volume: base + cone, tol: 1e-6 } },
      { op: { type: "pushface", selector: { at: [0, 0, "$T"], normal: [0, 0, 1], uniqueTol: 5 }, dist: 5 }, label: "顶面推拉 5",
        expect: { volume: base + cone + ring, tol: 1e-6 } },
      { op: { type: "helix", R: 30, wireR: 3, pitch: 10, turns: "$SPRING_TURNS", at: [200, 0, 0], mode: "add" }, label: "螺旋",
        expect: { volume: base + cone + ring + spring, tol: 2e-3 } },
    ],
  };
  const run = S.runModelScript(script);
  assert.ok(run.ok, `脚本应成功：${JSON.stringify(run.failed)}`);
  assert.equal(run.report.length, 4);
  for (const r of run.report) {
    assert.ok(r.check.ok, `第 ${r.index + 1} 步「${r.label}」校验没过：${JSON.stringify(r.check.items.filter((i) => !i.ok))}`);
    assert.ok(r.shape, `第 ${r.index + 1} 步缺形状快照（撤销/特征树要用）`);
  }
  near(vol(run.shape), base + cone + ring + spring, 1e-6);   // 弹簧是扫掠体，允许 1e-6 级的离散误差
  // 推拉那步要真的作用在「底板顶面」上：产物体积 = 环形柱
  near(run.report[2].volume - run.report[1].volume, ring, 1e-9);
});

test("脚本能进参数化重放：rebuild 重跑一遍，体积与逐步跑一致", () => {
  const script = {
    v: 1,
    params: { T: 8, R: 6 },
    steps: [
      { op: { type: "primitive", shape: "box", size: [60, 40, "$T"] } },
      { op: { type: "primitive", shape: "cylinder", r: "$R", h: 30, at: [0, 0, -5], mode: "cut" } },
      { op: { type: "fillet", radius: 2, selector: { dir: [0, 0, 1], all: true } } },
    ],
  };
  const run = S.runModelScript(script);
  assert.ok(run.ok, `首次运行应成功：${run.failed?.message || ""}`);
  const direct = vol(run.shape);

  const history = run.report.map((r) => ({
    label: r.label, detail: r.detail, op: r.op, shape: null, suppressed: false,
  }));
  const again = rebuild(history, history.length - 1);
  near(vol(again.shape), direct, 1e-12);   // 同一条定义链，必须一模一样
  // 独立复算：60×40×8 的盒子挖 Ø12 通孔，四条竖边倒 R2
  const want = 60 * 40 * 8 - Math.PI * 36 * 8 - 4 * (4 - Math.PI) * 8;
  near(direct, want, 1e-6);
});

test("圆角/倒角的选择器路径：一次多选四条竖边，角部体积按解析式减少", () => {
  const script = {
    v: 1,
    steps: [
      { op: { type: "primitive", shape: "box", size: [40, 30, 10] } },
      { op: { type: "fillet", radius: 2, selector: { dir: [0, 0, 1], all: true } } },
    ],
  };
  const run = S.runModelScript(script);
  assert.ok(run.ok, run.failed?.message);
  const cut = 4 * (2 * 2 - (Math.PI * 4) / 4) * 10;      // 4 个角 × (R² − πR²/4) × 高
  near(vol(run.shape), 40 * 30 * 10 - cut, 1e-6);

  const cham = S.runModelScript({
    v: 1,
    steps: [
      { op: { type: "primitive", shape: "box", size: [40, 30, 10] } },
      { op: { type: "chamfer", radius: 2, selector: { dir: [0, 0, 1], all: true } } },
    ],
  });
  assert.ok(cham.ok, cham.failed?.message);
  near(vol(cham.shape), 40 * 30 * 10 - 4 * (2 * 2 / 2) * 10, 1e-6);   // 每个角削掉直角三角柱
});

// ------------------------------------------------------------------ 校验与失败纪律
test("expect 对不上：strict 默认中止且不返回实体（当前文档不受影响）", () => {
  const bad = {
    v: 1,
    steps: [
      { op: { type: "primitive", shape: "box", size: [10, 10, 10] }, expect: { volume: 999 } },
      { op: { type: "primitive", shape: "box", size: [10, 10, 10], at: [20, 0, 0] } },
    ],
  };
  const run = S.runModelScript(bad);
  assert.equal(run.ok, false);
  assert.equal(run.shape, null, "校验失败时不能返回实体（调用方据此不动文档）");
  assert.equal(run.failed.verify, true);
  assert.match(run.failed.message, /体积/);
  assert.equal(run.report.length, 1, "第一步就中止，不该继续跑第二步");
  assert.equal(run.report[0].aborted, true);

  // strict:false 时降级为警告，继续跑完
  const soft = { ...bad, strict: false };
  const run2 = S.runModelScript(soft);
  assert.equal(run2.ok, true);
  assert.equal(run2.report.length, 2);
  assert.equal(run2.report[0].check.ok, false);
});

test("步骤失败时报的是人话，并指明是第几步", () => {
  const run = S.runModelScript({
    v: 1,
    steps: [
      { op: { type: "primitive", shape: "box", size: [10, 10, 10] } },
      { op: { type: "pushface", selector: { at: [0, 0, 0], normal: [0, 0, 1], type: "CYLINDRE" }, dist: 5 }, label: "推个不存在的面" },
    ],
  });
  assert.equal(run.ok, false);
  assert.equal(run.shape, null);
  assert.equal(run.failed.index, 1);
  assert.equal(run.failed.label, "推个不存在的面");
  assert.match(run.failed.message, /找不到符合条件的面/);
  assert.equal(run.report[1].ok, false);
});

test("报告摘要可序列化（UI 直接渲染，不含 wasm 对象）", () => {
  const run = S.runModelScript({
    v: 1,
    name: "摘要",
    steps: [{ op: { type: "primitive", shape: "box", size: [10, 10, 10] }, expect: { volume: 1000, bbox: [10, 10, 10], faces: 6 } }],
  });
  const sum = S.summarize(run);
  assert.equal(sum.ok, true);
  assert.equal(sum.stepCount, 1);
  assert.equal(sum.checked, 1);
  assert.equal(sum.checksPassed, 1);
  assert.equal(sum.volume, 1000);
  assert.equal(JSON.parse(JSON.stringify(sum)).steps[0].label, "形体");
});

test("当前模型可以导出成脚本，再跑回去体积一致", () => {
  const script = {
    v: 1,
    steps: [
      { op: { type: "primitive", shape: "box", size: [50, 20, 6] }, label: "板" },
      { op: { type: "primitive", shape: "sphere", r: 8, at: [0, 0, 6], mode: "add" }, label: "球" },
    ],
  };
  const run = S.runModelScript(script);
  const history = run.report.map((r, i) => ({ label: r.label, detail: r.detail, op: r.op, shape: r.shape, customName: i === 0 ? "底板" : null }));
  const exported = S.scriptFromHistory(history, "导出的脚本");
  assert.equal(exported.steps.length, 2);
  assert.equal(exported.steps[0].label, "底板");
  const again = S.runModelScript(exported);
  near(vol(again.shape), vol(run.shape), 1e-12);
});
