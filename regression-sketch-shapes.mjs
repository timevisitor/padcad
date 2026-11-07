/**
 * 草图几何 + 草图编辑回归（B 批 P0-2）
 *
 * 判据全部是**解析值**：多边形/椭圆用解析面积，槽口用 2rL+πr²，
 * 拉伸用 measureVolume 对面积×深度，剪断用长度守恒，镜像用面积+逐点。
 * 采样误差单独写成容差并注明来源（弦高误差 (2π/n)²/6），不用肉眼、不看面数。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import opencascade from "replicad-opencascadejs";
import { setOC, measureVolume } from "replicad";
import { rebuild } from "./src/replay.js";
import { polygonArea } from "./src/shapes2d.js";
import {
  addPolygon, addSlot, addArc, addEllipse,
  trimSegment, mirrorEntities, patternEntities, pathLength,
} from "./src/sketch-tools.js";

setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));

let passed = 0;
const near = (a, b, tol, label) =>
  assert.ok(Math.abs(a - b) < tol, `${label}：实测 ${a}，期望 ${b}，容差 ${tol}`);
function test(name, fn) {
  const info = fn();
  passed++;
  console.log(`PASS ${name}${info ? `  → ${info}` : ""}`);
}

const PI = Math.PI;
const PLANE = { kind: "datum", name: "XY", origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] };
/** 拉伸整条重放通道（grow:0 = 不做两端骑跨凸出，体积才等于面积×深度） */
const extrudeVolume = (entities, depth) => {
  const { shape } = rebuild([{ op: { type: "extrude", plane: PLANE, entities, depth, grow: 0 } }], 0);
  return measureVolume(shape);
};
const blank = () => ({ entities: [] });
const snap = (v) => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------------ 正多边形
test("内接 r=20 的正方形面积 = 2r² = 800（±0.5）", () => {
  const sk = blank();
  const e = addPolygon(sk, { center: [0, 0], r: 20, sides: 4 });
  assert.equal(e.kind, "polyline");
  assert.equal(e.closed, true);
  assert.equal(e.pts.length, 4, "闭合实体不该带重复收尾点");
  assert.equal(sk.entities.length, 1, "addPolygon 应把图元追加进草图");
  const A = polygonArea(e.pts);
  near(A, 800, 0.5, "正方形面积");
  return `面积 ${A.toFixed(6)} mm²`;
});

test("内接 r=10 的正六边形面积 = (3√3/2)r² = 259.8076（±1e-6，顶点是精确采样）", () => {
  const sk = blank();
  const e = addPolygon(sk, { center: [3, -4], r: 10, sides: 6, rotation: 0.3 });
  const A = polygonArea(e.pts);
  const expect = (3 * Math.sqrt(3) / 2) * 100;
  near(A, expect, 1e-6, "六边形面积");
  // 面积与转角无关；顺带证明 rotation 只转不缩
  const e2 = addPolygon(blank(), { center: [0, 0], r: 10, sides: 6, rotation: 0 });
  near(polygonArea(e2.pts), expect, 1e-9, "转角为 0 时的六边形面积");
  return `面积 ${A.toFixed(6)} mm²（期望 ${expect.toFixed(6)}）`;
});

test("外切模式：边心距 = r（n=6, r=12），面积 = n·r²·tan(π/n) = 498.8306", () => {
  const sk = blank();
  const e = addPolygon(sk, { center: [0, 0], r: 12, sides: 6, inscribed: false });
  const pts = e.pts;
  // 每条边的中点到中心的距离就是边心距
  const apothem = Math.min(...pts.map((p, i) => {
    const q = pts[(i + 1) % pts.length];
    return Math.hypot((p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
  }));
  near(apothem, 12, 1e-9, "边心距");
  const A = polygonArea(pts);
  const expect = 6 * 144 * Math.tan(PI / 6);
  near(A, expect, 1e-6, "外切六边形面积");
  return `边心距 ${apothem.toFixed(9)}，面积 ${A.toFixed(6)}（期望 ${expect.toFixed(6)}）`;
});

// ------------------------------------------------------------------ 槽口 / 椭圆
test("槽口 L=40 r=5：面积 = 2rL + πr² = 478.5398（±1，采样偏低）", () => {
  const sk = blank();
  const e = addSlot(sk, { a: [-20, 0], b: [20, 0], r: 5 });
  const A = polygonArea(e.pts);
  const expect = 2 * 5 * 40 + PI * 25;
  near(A, expect, 1, "槽口面积");
  // 采样必然偏低（内接多边形），方向也断言掉
  assert.ok(A <= expect + 1e-9, `采样面积 ${A} 不该大于解析值 ${expect}`);
  return `面积 ${A.toFixed(4)} mm²（期望 ${expect.toFixed(4)}，差 ${(expect - A).toFixed(4)}）`;
});

test("椭圆 rx=30 ry=10：面积 = π·300 = 942.4778（±2）", () => {
  const sk = blank();
  const e = addEllipse(sk, { center: [5, 5], rx: 30, ry: 10, rotation: 0.7 });
  const A = polygonArea(e.pts);
  near(A, PI * 300, 2, "椭圆面积");
  // 转角不改变面积
  const e2 = addEllipse(blank(), { center: [0, 0], rx: 30, ry: 10 });
  near(polygonArea(e2.pts), PI * 300, 2, "不转角时的椭圆面积");
  return `面积 ${A.toFixed(4)} mm²（期望 942.4778）`;
});

test("圆 rx=ry=15：面积 = π·225 = 706.8583（±1）", () => {
  const e = addEllipse(blank(), { center: [0, 0], rx: 15, ry: 15 });
  const A = polygonArea(e.pts);
  near(A, PI * 225, 1, "圆面积");
  // 所有顶点到圆心等距，确认真的被采成圆
  const rr = e.pts.map(([x, y]) => Math.hypot(x, y));
  near(Math.max(...rr), 15, 1e-9, "最大半径");
  near(Math.min(...rr), 15, 1e-9, "最小半径");
  return `面积 ${A.toFixed(4)} mm²（期望 706.8583）`;
});

// ------------------------------------------------------------------ 三点圆弧
test("三点圆弧：圆心到三点等距（<1e-6），半径 = 10，端点精确落在 p1/p3", () => {
  const sk = blank();
  const p1 = [-10, 0], p2 = [0, 10], p3 = [10, 0];
  const e = addArc(sk, { p1, p2, p3 });
  assert.equal(e.closed, false, "圆弧是开口折线，不能标成闭合");
  const pts = e.pts;
  near(pts[0][0], p1[0], 1e-9, "起始点 x");
  near(pts[0][1], p1[1], 1e-9, "起始点 y");
  near(pts[pts.length - 1][0], p3[0], 1e-9, "终点 x");
  near(pts[pts.length - 1][1], p3[1], 1e-9, "终点 y");
  // 采样点全部落在同一圆上 → 反推圆心/半径并核对三个给定点
  const r = pts.map(([x, y]) => Math.hypot(x, y));
  near(Math.max(...r), 10, 1e-9, "半径（最大）");
  near(Math.min(...r), 10, 1e-9, "半径（最小）");
  // 圆弧必须经过中间点 p2（弦高 32 段 ~0.012mm，给 0.05 余量）
  const dMid = Math.min(...pts.map(([x, y]) => Math.hypot(x - p2[0], y - p2[1])));
  assert.ok(dMid < 0.05, `圆弧没经过中间点：最近 ${dMid}`);
  return `半径 ${r[0].toFixed(9)}，过中间点误差 ${dMid.toFixed(5)} mm`;
});

test("三点共线必须报错", () => {
  assert.throws(() => addArc(blank(), { p1: [0, 0], p2: [1, 0], p3: [2, 0] }), /共线/);
  assert.throws(() => addArc(blank(), { p1: [0, 0], p2: [5, 5], p3: [10, 10] }), /共线/);
});

// ------------------------------------------------------------------ 拉伸集成
test("集成：正六边形 r=10 拉伸 5mm，体积 = 259.8076×5 = 1299.038（±0.5）", () => {
  const sk = blank();
  addPolygon(sk, { center: [0, 0], r: 10, sides: 6 });
  const A = polygonArea(sk.entities[0].pts);
  const V = extrudeVolume(sk.entities, 5);
  near(V, A * 5, 0.5, "拉伸体积");
  near(V, ((3 * Math.sqrt(3) / 2) * 100) * 5, 0.5, "对解析体积");
  return `体积 ${V.toFixed(4)} mm³（解析 ${(((3 * Math.sqrt(3)) / 2) * 100 * 5).toFixed(4)}）`;
});

test("集成：槽口 L=40 r=5 拉伸 3mm，体积 = 478.5398×3 = 1435.619（±1）", () => {
  const sk = blank();
  addSlot(sk, { a: [-20, 0], b: [20, 0], r: 5 });
  const V = extrudeVolume(sk.entities, 3);
  near(V, (2 * 5 * 40 + PI * 25) * 3, 1, "槽口拉伸体积");
  return `体积 ${V.toFixed(4)} mm³（期望 1435.6193）`;
});

// ------------------------------------------------------------------ 剪断
test("剪断：10mm 直线在 4mm 处剪断 → 两段，总长守恒 10（±1e-6），其它实体与原件不动", () => {
  const line = { kind: "polyline", pts: [[0, 0], [10, 0]], closed: false };
  const other = { kind: "polyline", pts: [[0, 5], [5, 5], [5, 9]], closed: false };
  const before = snap([line, other]);
  const out = trimSegment([line, other], { e: 0, seg: 0 }, [4, 0]);
  assert.equal(out.length, 3, "一条线剪成两段后总数 +1");
  const total = pathLength(out[0].pts) + pathLength(out[1].pts);
  near(total, 10, 1e-6, "总长守恒");
  assert.deepEqual(out[0].pts, [[0, 0], [4, 0]]);
  assert.deepEqual(out[1].pts, [[4, 0], [10, 0]]);
  assert.deepEqual(out[2], other, "其它实体必须原样保留");
  assert.deepEqual([line, other], before, "入参不能被就地改");
  return `两段长 ${pathLength(out[0].pts)} + ${pathLength(out[1].pts)} = ${total} mm`;
});

test("剪断：闭合折线剪一刀 → 开口一笔，周长守恒 40（±1e-6）", () => {
  const sq = { kind: "polyline", pts: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true };
  const out = trimSegment([sq], { e: 0, seg: 0 }, [5, 0]);
  assert.equal(out.length, 1, "闭合轮廓剪一刀还是一个一笔（首尾都是切点）");
  assert.equal(out[0].closed, false, "剪开后必须变成开口");
  near(pathLength(out[0].pts), 40, 1e-6, "周长守恒");
  assert.deepEqual(out[0].pts[0], [5, 0]);
  assert.deepEqual(out[0].pts[out[0].pts.length - 1], [5, 0]);
  return `周长 ${pathLength(out[0].pts)}，点数 ${out[0].pts.length}`;
});

test("剪断：切点落在已有顶点上原样返回；段号越界/点太远要报错", () => {
  const line = { kind: "polyline", pts: [[0, 0], [10, 0]], closed: false };
  const same = trimSegment([line], { e: 0, seg: 0 }, [10, 0]);
  assert.equal(same.length, 1);
  assert.deepEqual(same[0].pts, line.pts);
  assert.throws(() => trimSegment([line], { e: 0, seg: 3 }, [4, 0]), /段号/);
  assert.throws(() => trimSegment([line], { e: 1, seg: 0 }, [4, 0]), /下标/);
  assert.throws(() => trimSegment([line], { e: 0, seg: 0 }, [4, 3]), /偏离/);
  assert.throws(() => trimSegment([{ kind: "circle", c: [0, 0], r: 5 }], { e: 0, seg: 0 }, [4, 0]), /折线/);
});

// ------------------------------------------------------------------ 镜像 / 阵列
test("镜像：关于 y 轴镜像正六边形 → 实体数 +1，面积不变，坐标逐点取反，原件未改", () => {
  const sk = blank();
  addPolygon(sk, { center: [12, 3], r: 8, sides: 6, rotation: 0.2 });
  const before = snap(sk.entities);
  const out = mirrorEntities(sk.entities, { axis: "y" });
  assert.equal(out.length, 2, "原件 + 镜像件");
  const A0 = polygonArea(sk.entities[0].pts);
  const A1 = polygonArea(out[1].pts);
  near(A1, A0, 1e-9, "镜像后面积");
  // 镜像会把绕向反过来，所以顶点序列按倒序存放（否则下游判方向会反）
  const src = sk.entities[0].pts, n = src.length;
  assert.equal(out[1].pts.length, n, "顶点数必须一致");
  out[1].pts.forEach(([x, y], i) => {
    near(x, -src[n - 1 - i][0], 1e-9, `第 ${i} 点 x 镜像`);
    near(y, src[n - 1 - i][1], 1e-9, `第 ${i} 点 y 不变`);
  });
  assert.deepEqual(sk.entities, before, "原实体不能被改");
  assert.deepEqual(out[0], sk.entities[0], "返回数组里的原件也是克隆");
  return `面积 ${A0.toFixed(6)} mm² 保持，${out[1].pts.length} 个顶点逐个对上`;
});

test("镜像：关于任意斜线镜像，圆仍是圆（半径不变，圆心对称）", () => {
  const circ = { kind: "circle", c: [3, 0], r: 4 };
  const line = [[0, 0], [1, 1]];
  const out = mirrorEntities([circ], { axis: line });
  assert.equal(out[1].kind, "circle", "圆镜像后必须还是圆（转成多边形会让孔不再是孔）");
  near(out[1].r, 4, 1e-12, "半径");
  near(out[1].c[0], 0, 1e-9, "镜像圆心 x");
  near(out[1].c[1], 3, 1e-9, "镜像圆心 y");
  assert.throws(() => mirrorEntities([circ], { axis: [[1, 1], [1, 1]] }), /重合/);
  return `圆心 (3,0) → (${out[1].c[0].toFixed(3)}, ${out[1].c[1].toFixed(3)})，r=${out[1].r}`;
});

test("线性阵列 count=3：实体数 +2，间距 40，原件坐标逐点未改", () => {
  const sk = blank();
  addPolygon(sk, { center: [0, 0], r: 5, sides: 4 });
  const before = snap(sk.entities);
  const out = patternEntities(sk.entities, { mode: "linear", count: 3, dx: 40, dy: 0 });
  assert.equal(out.length, 3, "count 含原件 → 总共 3 个");
  assert.deepEqual(out[0].pts, before[0].pts, "原件必须在原位（逐点）");
  for (let k = 1; k < 3; k++) {
    out[k].pts.forEach(([x, y], i) => {
      near(x, before[0].pts[i][0] + 40 * k, 1e-9, `第 ${k} 件第 ${i} 点 x`);
      near(y, before[0].pts[i][1], 1e-9, `第 ${k} 件第 ${i} 点 y`);
    });
  }
  assert.deepEqual(sk.entities, before, "入参不能被就地改");
  return `3 件面积 ${out.map((e) => polygonArea(e.pts).toFixed(2)).join("/")} mm²，中心 x = ${out.map((e) => (e.pts[0][0] - 5).toFixed(1)).join("/")}`;
});

test("圆周阵列 count=4 绕原点整圈：第 4 件转了 270°，面积全部相等", () => {
  const sk = blank();
  addPolygon(sk, { center: [10, 0], r: 5, sides: 4 });
  const out = patternEntities(sk.entities, { mode: "circular", count: 4, center: [0, 0], angle: 360 });
  assert.equal(out.length, 4);
  const A0 = polygonArea(sk.entities[0].pts);
  for (const e of out) near(polygonArea(e.pts), A0, 1e-9, "阵列件面积");
  // 90° 一步：第 k 件的每个点应是原件点转 90k 度
  for (let k = 1; k < 4; k++) {
    const rad = (90 * k * PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
    out[k].pts.forEach(([x, y], i) => {
      const [ox, oy] = sk.entities[0].pts[i];
      near(x, ox * c - oy * s, 1e-9, `第 ${k} 件第 ${i} 点 x`);
      near(y, ox * s + oy * c, 1e-9, `第 ${k} 件第 ${i} 点 y`);
    });
  }
  return `4 件均面积 ${A0.toFixed(6)} mm²，末件起点 (${out[3].pts[0].map((v) => v.toFixed(3)).join(", ")})`;
});

// ------------------------------------------------------------------ 参数校验
test("非法参数一律抛中文错误，不静默生成半成品", () => {
  assert.throws(() => addPolygon(blank(), { r: 10, sides: 2 }), /边数/);
  assert.throws(() => addPolygon(blank(), { r: 10, sides: 6.5 }), /边数/);
  assert.throws(() => addPolygon(blank(), { r: 0, sides: 6 }), /半径/);
  assert.throws(() => addPolygon(blank(), { r: 10, sides: 6, center: [0, "x"] }), /多边形中心/);
  assert.throws(() => addSlot(blank(), { a: [0, 0], b: [0, 0], r: 5 }), /重合/);
  assert.throws(() => addSlot(blank(), { a: [0, 0], b: [10, 0], r: -1 }), /槽口半径/);
  assert.throws(() => addEllipse(blank(), { rx: 0, ry: 10 }), /半轴/);
  assert.throws(() => addEllipse(blank(), { rx: 10 }), /半轴|有限数字/);
  assert.throws(() => addPolygon({}, { r: 10, sides: 6 }), /entities/);
  assert.throws(() => patternEntities([], { mode: "linear", count: 1, dx: 10 }), /≥2/);
  assert.throws(() => patternEntities([], { mode: "linear", count: 3, dx: 0, dy: 0 }), /间距/);
  assert.throws(() => patternEntities([], { mode: "spiral", count: 3 }), /linear 或 circular/);
});

console.log(`\n草图几何回归：${passed} 项通过`);
