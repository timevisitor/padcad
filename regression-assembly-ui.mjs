/**
 * 装配 UI 回归（v6 装配路 · UI 层）
 *
 * 这里只测「不碰 DOM 的那一半」：菜单过滤与排序、一次性对齐的位姿、自动摆放、
 * DOF 措辞、列表文案。理由：这些一旦写进 DOM 模块就只能靠 headless 截图猜，
 * 而它们恰好是「配合菜单少了某项」「对齐后差 180°」「新零件压在旧零件上」这类
 * 真机的来源。DOM/触摸那一半在 tools/accept-asm-ui.mjs（真实触摸 + CDP）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import * as A from "./src/assembly.js";
import * as M from "./src/assembly-ui-model.js";

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b} (tol ${tol})`);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(...a);

/* 两块 60×40×8 板：顶面 z=8（法向 +Z）、底面 z=0（法向 −Z），中心 Ø6 孔 */
const plateRefs = {
  top: { kind: "plane", point: [0, 0, 8], normal: [0, 0, 1] },
  bottom: { kind: "plane", point: [0, 0, 0], normal: [0, 0, -1] },
  holeA: { kind: "axis", point: [0, 0, 0], direction: [0, 0, 1], radius: 3, curve: "circle" },
  holeB: { kind: "axis", point: [0, 0, 8], direction: [0, 0, 1], radius: 3, curve: "circle" },
  corner: { kind: "plane", point: [30, 20, 0], normal: [1, 0, 0] },
  pt: { kind: "point", point: [10, 10, 0] },
};
// ⚠ pose.R 必须是**扁平 3×3（9 个数）**：传嵌套数组 [[..],[..],[..]] 不会报错，matMul 直接算出 NaN
const poseId = A.poseFromTransform({ t: [0, 0, 0], r: [0, 0, 0, 1] });
const poseShift = A.poseFromTransform({ t: [84, 0, 0], r: [0, 0, 0, 1] });

test("装配UI：面-面菜单类型齐全且顺序固定（对齐不在 mateTypesFor 里，它是 UI 里的第一项）", () => {
  // 「锁定」对任意参考都成立（refsCompatible 里是 any/any），所以永远排在最后
  const types = M.mateTypesFor("plane", "plane").map((x) => x.type);
  assert.deepEqual(types, ["coincident", "distance", "parallel", "perpendicular", "angle", "lock"]);
});

test("装配UI：轴-轴菜单是 同轴 优先", () => {
  const types = M.mateTypesFor("axis", "axis").map((x) => x.type);
  assert.deepEqual(types, ["concentric", "parallel", "perpendicular", "angle", "lock"]);
});

test("装配UI：点-点 / 点-面 只给 重合 + 距离", () => {
  assert.deepEqual(M.mateTypesFor("point", "point").map((x) => x.type), ["coincident", "distance", "lock"]);
  assert.deepEqual(M.mateTypesFor("point", "plane").map((x) => x.type), ["coincident", "distance", "lock"]);
});

test("装配UI：菜单过滤结果必须与求解器 refsCompatible 完全一致（不另维护一张规则表）", () => {
  for (const [ka, kb] of [["plane", "plane"], ["axis", "axis"], ["point", "point"], ["point", "plane"], ["plane", "axis"], ["axis", "plane"]]) {
    const ui = M.mateTypesFor(ka, kb).map((x) => x.type).sort();
    const solver = A.MATE_TYPES.filter((t) => A.refsCompatible(t, ka, kb)).sort();
    assert.deepEqual(ui, solver, `${ka}-${kb}`);
  }
});

test("装配UI：距离/角度预填值取当前实测（两板 8mm / 180°）", () => {
  const m = M.measurePair(plateRefs.top, poseId, plateRefs.bottom, poseShift);
  near(m.distance, 8);
  near(m.angleDeg, 180);
  // 同一对面（都朝 +Z）夹角 0°
  const m2 = M.measurePair(plateRefs.top, poseId, plateRefs.top, poseShift);
  near(m2.angleDeg, 0);
});

test("装配UI：一次性对齐（面-面）→ 两面共面且法向相对，距离 0", () => {
  // B 的底面先放在 (84,0,0)：对齐后应贴到 A 的顶面 z=8，且法向与 A 相反
  const tr = M.alignTransform(plateRefs.top, poseId, plateRefs.bottom, poseShift);
  const poseB = A.poseFromTransform(tr);
  const rb = A.transformRef(plateRefs.bottom, poseB);
  const ra = A.transformRef(plateRefs.top, poseId);
  near(dot(ra.normal, rb.normal), -1, 1e-9);      // 反向贴合
  near(dot([rb.point[0] - ra.point[0], rb.point[1] - ra.point[1], rb.point[2] - ra.point[2]], ra.normal), 0, 1e-9);
  near(rb.point[2], 8, 1e-9);
  // 除了共面，B 参考点要真的落到 A 的参考点上（否则「对齐」会把零件甩到 x=−84，看着像没动）
  near(rb.point[0], ra.point[0], 1e-9);
  near(rb.point[1], ra.point[1], 1e-9);
});

test("装配UI：一次性对齐（轴-轴）→ 两轴重合（径向偏差 0）", () => {
  const tr = M.alignTransform(plateRefs.holeA, poseId, plateRefs.holeB, poseShift);
  const poseB = A.poseFromTransform(tr);
  const rb = A.transformRef(plateRefs.holeB, poseB);
  const ra = A.transformRef(plateRefs.holeA, poseId);
  near(Math.abs(dot(ra.direction, rb.direction)), 1, 1e-9);   // 平行（同向或反向）
  const d = [rb.point[0] - ra.point[0], rb.point[1] - ra.point[1], rb.point[2] - ra.point[2]];
  const perp = [d[0] - ra.direction[0] * dot(d, ra.direction), d[1] - ra.direction[1] * dot(d, ra.direction), d[2] - ra.direction[2] * dot(d, ra.direction)];
  near(len(perp), 0, 1e-9);
  near(len([rb.point[0] - ra.point[0], rb.point[1] - ra.point[1]]), 0, 1e-9);
});

test("装配UI：对齐 flip=true 时两面同向（法向点积 +1）", () => {
  const tr = M.alignTransform(plateRefs.top, poseId, plateRefs.bottom, poseShift, { flip: true });
  const rb = A.transformRef(plateRefs.bottom, A.poseFromTransform(tr));
  const ra = A.transformRef(plateRefs.top, poseId);
  near(dot(ra.normal, rb.normal), 1, 1e-9);
});

test("装配UI：quatBetween 正反两种极端都稳定（反向时转 180° 不除零）", () => {
  const q1 = M.quatBetween([0, 0, 1], [0, 0, -1]);
  const R1 = A.quatToMatrix(q1);
  const z = [R1[0] * 0 + R1[1] * 0 + R1[2] * 1, R1[3] * 0 + R1[4] * 0 + R1[5] * 1, R1[6] * 0 + R1[7] * 0 + R1[8] * 1];
  near(z[2], -1, 1e-9);
  const q2 = M.quatBetween([1, 0, 0], [1, 0, 0]);
  near(M.quatBetween([1, 0, 0], [1, 0, 0])[3], 1, 1e-9);       // 同向 = 单位四元数
  assert.ok(Number.isFinite(q2[0] + q2[1] + q2[2] + q2[3]));
});

test("装配UI：新实例自动摆在已有件旁边，间隙 24mm、底面仍落在 z=0", () => {
  const box = M.localBoxOf({ center: [0, 0, 4], width: 60, height: 40, depth: 8 });
  assert.deepEqual(box.min, [-30, -20, 0]);
  const first = M.placeNewTransform(box, []);
  assert.deepEqual(first.t, [0, 0, 0]);
  const w1 = M.worldBox(box, first.t);
  const second = M.placeNewTransform(box, [w1]);
  const w2 = M.worldBox(box, second.t);
  near(w2.min[0] - w1.max[0], 24);              // 间隙
  near(w2.min[2], 0);                           // 底面在 z=0
  near(w2.min[1], w1.min[1]);                   // Y 对齐
  assert.ok(w2.min[0] > w1.max[0], "两件不能重叠");
});

test("装配UI：连续插三件时一路往 +X 排开、两两不重叠", () => {
  const box = M.localBoxOf({ center: [0, 0, 4], width: 60, height: 40, depth: 8 });
  const boxes = [];
  for (let i = 0; i < 3; i++) {
    const tr = M.placeNewTransform(box, boxes);
    boxes.push(M.worldBox(box, tr.t));
  }
  for (let i = 0; i + 1 < boxes.length; i++) {
    near(boxes[i + 1].min[0] - boxes[i].max[0], 24);
  }
});

test("装配UI：DOF 措辞（完全定位 / 剩 N 自由度 / 冲突 / 未求解）", () => {
  assert.equal(M.dofLabel(null).text, "未求解");
  assert.equal(M.dofLabel(null).tone, "muted");
  const ok = M.dofLabel({ status: "solved", dof: 0, rank: 6, variables: 6 });
  assert.equal(ok.text, "完全定位");
  assert.equal(ok.tone, "ok");
  const free = M.dofLabel({ status: "solved", dof: 3, rank: 3, variables: 6 });
  assert.equal(free.text, "剩 3 自由度");
  assert.equal(free.tone, "warn");
  const bad = M.dofLabel({ status: "conflict", dof: 0, maxResidual: 2.5, conflicts: ["m1", "m2"] });
  assert.equal(bad.text, "配合冲突");
  assert.equal(bad.tone, "bad");
  assert.match(bad.hint, /2 条配合/);
  const over = M.dofLabel({ status: "solved", dof: 1, rank: 5, variables: 6, overDefined: true, redundantMates: ["m3"] });
  assert.match(over.hint, /多余配合 1 条/);
});

test("装配UI：配合行文案（类型/值/两侧/参考短写）", () => {
  const asm = { instances: [{ id: "i1", name: "下板" }, { id: "i2", name: "上板" }] };
  const s1 = M.mateSummary({ id: "m1", type: "coincident", value: 0, flip: false, a: { inst: "i1", ref: plateRefs.top }, b: { inst: "i2", ref: plateRefs.bottom } }, asm);
  assert.equal(s1.title, "重合");
  assert.equal(s1.icon, "≡");
  assert.equal(s1.flipText, "反向");
  assert.equal(s1.refsShort, "面");
  assert.equal(s1.sidesShort, "下板↔上板");
  const s2 = M.mateSummary({ id: "m2", type: "distance", value: 5, a: { inst: "i1", ref: plateRefs.top }, b: { inst: "i2", ref: plateRefs.bottom } }, asm);
  assert.equal(s2.valueText, "5 mm");
  const s3 = M.mateSummary({ id: "m3", type: "concentric", value: 0, a: { inst: "i1", ref: plateRefs.holeA }, b: { inst: "i2", ref: plateRefs.holeB } }, asm);
  assert.equal(s3.refsShort, "圆边轴");
  assert.equal(s3.title, "同轴");
  const s4 = M.mateSummary({ id: "m4", type: "angle", value: 30, a: { inst: "i1", ref: plateRefs.top }, b: { inst: "i2", ref: plateRefs.corner } }, asm);
  assert.equal(s4.valueText, "30°");
  assert.equal(s4.refsShort, "面");   // 两侧都是面 → 压成一个词（列表行只有 ~114px）
});

test("装配UI：参考类型措辞（面 / 轴线 / 圆边轴 / 点）", () => {
  assert.equal(M.refKindWord(plateRefs.top), "面");
  assert.equal(M.refKindWord(plateRefs.holeA), "圆边轴");
  assert.equal(M.refKindWord({ kind: "axis", point: [0, 0, 0], direction: [1, 0, 0] }), "轴线");
  assert.equal(M.refKindWord(plateRefs.pt), "点");
  assert.equal(M.refKindWord(null), "无参考");
});

test("装配UI：数值格式（残差/长度/体积）", () => {
  assert.equal(M.formatResidual(0), "0");
  assert.match(M.formatResidual(2.842170943040401e-14), /e-14$/);
  assert.equal(M.formatResidual(1e-3), "0.0010");
  assert.equal(M.formatLength(8), "8 mm");
  assert.equal(M.formatLength(-3.5), "-3.5 mm");   // 负距离是合法输入（配合方向由 flip 管），不要悄悄取绝对值
  assert.equal(M.formatVolume(9486.902664), "9.49 cm³");
});

test("装配UI：实例配色按序号循环，固定件有单独的灰", () => {
  assert.equal(M.instanceColor(0), M.ASM_COLORS[0]);
  assert.equal(M.instanceColor(M.ASM_COLORS.length), M.ASM_COLORS[0]);
  assert.equal(M.instanceColor(99), M.ASM_COLORS[99 % M.ASM_COLORS.length]);
  assert.ok(/^#[0-9a-f]{6}$/i.test(M.FIXED_COLOR));
  for (const c of M.ASM_COLORS) assert.ok(/^#[0-9a-f]{6}$/i.test(c), c);
});

test("装配UI：模型模块是纯逻辑（不碰 DOM/窗口）", () => {
  const src = fs.readFileSync(new URL("./src/assembly-ui-model.js", import.meta.url), "utf8");
  assert.ok(!/\bdocument\./.test(src), "assembly-ui-model.js 不应访问 document");
  assert.ok(!/\bwindow\./.test(src), "assembly-ui-model.js 不应访问 window");
  assert.ok(!/addEventListener/.test(src), "assembly-ui-model.js 不应挂事件");
});

test("装配UI：DOM 模块只挂一个模式、只改自己的节点，且按钮命中区有 44px 下限", () => {
  const src = fs.readFileSync(new URL("./src/assembly-ui.js", import.meta.url), "utf8");
  assert.ok(src.includes('registerAppMode("assembly"'), "必须注册 assembly 应用模式");
  assert.ok(!/from "\.\/main\.js"/.test(src), "不能反向 import main.js（那样会成环）");
  // 装配模式的一切样式都必须在 body.asm-mode 下，退出后对既有界面零影响
  const css = fs.readFileSync(new URL("./src/assembly-ui.css", import.meta.url), "utf8");
  assert.ok(css.includes("body.asm-mode #toolDock"), "必须收起零件模式工具坞");
  assert.match(css, /\.asm-mini\s*\{[^}]*min-height:\s*44px/s, "小按钮命中区 ≥44px");
  assert.match(css, /#asmRoot \.asm-btn\s*\{[^}]*min-height:\s*48px/s, "工具轨按钮命中区 ≥48px");
  assert.match(css, /#asmMenu \.asm-mate-btn\s*\{[^}]*min-height:\s*52px/s, "配合菜单按钮命中区 ≥52px");
  // 装配存档键必须与零件工程分开
  assert.ok(src.includes("padcad.asm.v1"), "装配存档键");
  assert.ok(!/localStorage\.(set|get|remove)Item\(\s*"padcad\.projects/.test(src), "不许读写零件工程的 localStorage 键");
});
