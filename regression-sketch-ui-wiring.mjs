/**
 * 回归：智能草图 UI 接线的数据契约（v6 第二阶段）
 *
 * 这里钉的是 main.js 接线时**依赖的那些约定**，不是几何算法本身：
 *   ① 推理结果的 draft 占位（{draft:i} / {draftLine:true}）必须能被
 *      `applyInferred(..., {e, seg, pointRefs})` 换成新图元上的具名点 —— 换错下标就会
 *      "约束写在别的一条线上" 或 "指向不存在的点"（buildConstraints 直接抛）。
 *   ② 折线每一段要落成各自的 `{e,seg}`：第二段写成 seg 0 等于把约束加到第一段上。
 *   ③ 闭合多边形收尾那一下落回 p0，不是 pN（下标越界会静默丢掉约束）。
 *   ④ 被抑制的候选（水平 vs 相切）只能写一条，写两条就是过定义。
 *   ⑤ 覆盖层着色依赖 entityColors 的三色契约：完全定义 #1f2328 / 欠定义 #2f6fed / 冲突 #e0362c。
 *   ⑥ 拖动保约束：圆被标了半径尺寸后拖圆心，半径不许变（UI 拖动路径 dragSolve 的判据）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { inferRelations, applyInferred } from "./src/sketch-infer.js";
import { analyzeSketch, entityColors, SKETCH_STATES, summarizeAnalysis } from "./src/sketch-dof.js";
import { dragSolve } from "./src/sketch-drag.js";
import { buildConstraints, solveSketch } from "./src/solver.js";

const TAN15 = Math.tan((1.5 * Math.PI) / 180);

/** 一条 1.5° 的"看起来水平"的线（pointRefs 走 main.js 里 commitPendingInferred 的同一套构造） */
function tiltDraft(len = 40) {
  return { kind: "segment", a: [0, 0], b: [len, len * TAN15] };
}

test("UI 接线 ①：horizontal 推理的 draft 占位被换成新图元的 p0/p1，求解后严格水平", () => {
  const entities = [];
  const r = inferRelations(entities, tiltDraft(), { tolMm: 2, distTolPx: 10, mmPerPx: 0.25 });
  assert.ok(r.relations.some((x) => x.type === "horizontal"), "1.5° 应推理出水平");
  assert.equal(r.snapped.b[1], r.snapped.a[1], "吸附后 y 必须完全相等");

  // 把线 push 进去（模拟 lineTap 落点 + finishPolyline）
  entities.push({ kind: "polyline", pts: [r.snapped.a.slice(), r.snapped.b.slice()], closed: false });
  const out = applyInferred(entities, r.relations, {
    e: 0, seg: 0,
    pointRefs: [{ e: 0, p: "p0" }, { e: 0, p: "p1" }],
    lineRef: { e: 0, seg: 0 },
  });
  const h = out.accepted.find((a) => a.type === "horizontal");
  assert.ok(h, "应写出一条 horizontal");
  assert.deepEqual(h.spec.a, { e: 0, p: "p0" });
  assert.deepEqual(h.spec.b, { e: 0, p: "p1" });
  // 写得进去（buildConstraints 校验通过），并且解出来仍然水平
  buildConstraints(entities, out.specs);
  const res = solveSketch(entities, out.specs);
  assert.ok(res.ok);
  const pts = entities[0].pts;
  assert.ok(Math.abs(pts[1][1] - pts[0][1]) <= 1e-9, `求解后仍水平，实测 Δy=${pts[1][1] - pts[0][1]}`);
});

test("UI 接线 ②：折线第二段的关系写在 seg 1，不是 seg 0", () => {
  const entities = [{ kind: "polyline", pts: [[0, 0], [30, 0]], closed: false }];
  // 从 (30,0) 往右上方拉一条"几乎竖直"的第二段
  const draft = { kind: "segment", a: [30, 0], b: [30 + 40 * Math.tan((1.0 * Math.PI) / 180), 40] };
  const r = inferRelations(entities, draft, { tolMm: 2, distTolPx: 10, mmPerPx: 0.25, angleTolDeg: 3 });
  assert.ok(r.relations.some((x) => x.type === "vertical"), "1° 偏角应推理出竖直");
  entities[0].pts.push(r.snapped.b.slice());
  const out = applyInferred(entities, r.relations, {
    e: 0, seg: 1,
    pointRefs: [{ e: 0, p: "p1" }, { e: 0, p: "p2" }],
    lineRef: { e: 0, seg: 1 },
  });
  const v = out.accepted.find((a) => a.type === "vertical");
  assert.ok(v);
  assert.deepEqual(v.spec.a, { e: 0, p: "p1" });
  assert.deepEqual(v.spec.b, { e: 0, p: "p2" });
  // 起笔点正好落在已有端点 p1 上，会顺带推出一条 coincident —— 它也必须是 p1，不能是 seg 0 的方向类约束
  const dirs = out.accepted.filter((a) => ["horizontal", "vertical", "parallel", "perpendicular", "angle"].includes(a.type));
  assert.equal(dirs.length, 1, `方向类只能有一条，实测 ${JSON.stringify(dirs.map((d) => d.type))}`);
  for (const a of out.accepted) {
    const refs = [a.spec?.l1, a.spec?.l2, a.spec?.l].filter(Boolean);
    for (const ref of refs) assert.notEqual(ref.seg, 0, "第二段的约束不许挂到 seg 0 上");
  }
});

test("UI 接线 ③：闭合多边形的收尾关系落在 p0（不是越界的 pN）", () => {
  const entities = [];
  // 三点几乎共线的三角形收尾段：(20,10) → 回到 (0,0) 附近，近似水平
  const draft = { kind: "segment", a: [20, 0.3], b: [0, 0] };
  const r = inferRelations(entities, draft, { tolMm: 2, distTolPx: 10, mmPerPx: 0.25 });
  entities.push({ kind: "polyline", pts: [[0, 0], [20, 0.3], [10, 12]], closed: true });
  const out = applyInferred(entities, r.relations, {
    e: 0, seg: 2,
    pointRefs: [{ e: 0, p: "p2" }, { e: 0, p: "p0" }],   // 收尾点回到 p0
    lineRef: { e: 0, seg: 2 },
  });
  // 至少有一条能被 buildConstraints 接受（下标没越界、点存在）
  assert.ok(out.accepted.length >= 1, "闭合段的约束必须能构建");
  buildConstraints(entities, out.specs);
  for (const a of out.accepted) {
    for (const k of ["a", "b", "p", "l1", "l2", "l"]) {
      const ref = a.spec?.[k];
      if (ref && typeof ref === "object" && "p" in ref && typeof ref.p === "string") {
        assert.match(ref.p, /^p[0-2]$/, `点引用必须在 p0~p2 之间，实测 ${ref.p}`);
      }
    }
  }
});

test("UI 接线 ④：水平与相切互斥时只写一条（写两条就是过定义）", () => {
  // 圆在 (25, -10)、半径 10；从 (0,0) 往右拉一条 y 略偏的线，切点刚好擦着圆底
  const entities = [{ kind: "circle", c: [25, -10], r: 10 }];
  const draft = { kind: "segment", a: [-5, -10 + 10 - 0.2], b: [40, -10 + 10 + 0.2] };
  const r = inferRelations(entities, draft, { tolMm: 1.5, distTolPx: 10, mmPerPx: 0.25, angleTolDeg: 3 });
  entities.push({ kind: "polyline", pts: [r.snapped.a.slice(), r.snapped.b.slice()], closed: false });
  const out = applyInferred(entities, r.relations, {
    e: 1, seg: 0, pointRefs: [{ e: 1, p: "p0" }, { e: 1, p: "p1" }], lineRef: { e: 1, seg: 0 },
  });
  const dirTypes = out.accepted.map((a) => a.type).filter((t) => ["horizontal", "vertical", "tangent", "parallel", "perpendicular"].includes(t));
  assert.ok(dirTypes.length <= 1, `方向类关系只能有一条，实测 ${JSON.stringify(dirTypes)}`);
});

test("UI 接线 ⑤：entityColors 的三色契约（覆盖层按它描边）", () => {
  assert.equal(SKETCH_STATES.defined.color, "#1f2328");
  assert.equal(SKETCH_STATES.underdefined.color, "#2f6fed");
  assert.equal(SKETCH_STATES.conflict.color, "#e0362c");
  assert.equal(SKETCH_STATES.reference.color, "#9aa4b2");

  // 空草图：没有图元 → 没有颜色
  assert.deepEqual(entityColors(analyzeSketch([], [])), {});

  // 自由矩形 → 欠定义（蓝）
  const ent = [{ kind: "rect", c: [0, 0], w: 40, h: 20 }];
  const a1 = analyzeSketch(ent, []);
  assert.equal(a1.status, "underdefined");
  assert.equal(entityColors(a1)[0], "#2f6fed");
  assert.match(summarizeAnalysis(a1), /欠定义/);

  // 固定后 → 完全定义（黑）
  const specs = [{ type: "fix", e: 0, at: [0, 0, 40, 20], label: "固定" }];
  const a2 = analyzeSketch(structuredClone(ent), specs);
  assert.equal(a2.status, "defined");
  assert.equal(a2.dof, 0);
  assert.equal(entityColors(a2)[0], "#1f2328");

  // 再加一条矛盾的宽度 → 过定义（红），且文案里带「冲突」（状态条直接用它）
  const conflict = [...specs, { type: "fixed", e: 0, k: "w", value: 25, label: "宽(矛盾)" }];
  const a3 = analyzeSketch(structuredClone(ent), conflict);
  assert.equal(a3.status, "overdefined");
  assert.equal(entityColors(a3)[0], "#e0362c");
  assert.match(summarizeAnalysis(a3), /过定义/);
  assert.ok((a3.conflicts[0]?.group || []).length >= 2, "冲突应指出涉及哪几条约束");
});

test("UI 接线 ⑥：拖动路径（dragSolve）拖圆心时半径尺寸一条不破", () => {
  const entities = [{ kind: "circle", c: [0, 0], r: 12 }];
  const specs = [{ type: "fixed", e: 0, k: "r", value: 12, label: "半径" }];
  const res = dragSolve(entities, specs, { kind: "point", ref: { e: 0, p: "center" }, to: [8, -6] });
  assert.equal(res.blocked, false);
  const c = res.entities[0];
  assert.ok(Math.abs(c.c[0] - 8) < 1e-3, `圆心 x 应跟到 8，实测 ${c.c[0]}`);
  assert.ok(Math.abs(c.c[1] + 6) < 1e-3, `圆心 y 应跟到 -6，实测 ${c.c[1]}`);
  assert.equal(c.r, 12, "半径被尺寸锁住，一丁点都不许变");
});

test("UI 接线 ⑦：完全定义的图元拖动返回 blocked，几何一字节不变（UI 据此提示「拖不动」）", () => {
  const entities = [{ kind: "rect", c: [0, 0], w: 40, h: 20 }];
  const specs = [{ type: "fix", e: 0, at: [0, 0, 40, 20], label: "固定" }];
  const before = JSON.stringify(entities);
  const res = dragSolve(entities, specs, { kind: "point", ref: { e: 0, p: "center" }, to: [15, 12] });
  assert.equal(res.blocked, true);
  assert.ok(/约束|拖不动/.test(res.reason), `blocked 要给中文原因，实测「${res.reason}」`);
  assert.equal(JSON.stringify(res.entities), before, "blocked 时必须回滚成原几何");
});
