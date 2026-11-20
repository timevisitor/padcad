/**
 * 浮动界面几何（径向菜单 / 浮卡避让 / 工具坞）的纯函数回归。
 * 只 import src/float-layout.js，不需要浏览器、不碰几何内核。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { radialLayout, placeCard, placeCardScan, dockMetrics, overlapArea, clamp } from "./src/float-layout.js";

const PAD = { w: 1163, h: 776 };   // 小米 Pad 7 横屏的 CSS 视口

test("clamp / overlapArea 基本语义", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-3, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
  assert.equal(overlapArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), 25);
  assert.equal(overlapArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 10, h: 10 }), 0);
});

test("径向菜单：视口中央时圆心就是手指（距离 0），容器是以圆心为中心的正方形", () => {
  const r = radialLayout({ x: 581, y: 388, count: 6, viewport: PAD });
  assert.equal(r.fingerDist, 0);
  assert.equal(r.center.x, 581);
  assert.equal(r.center.y, 388);
  assert.ok(Math.abs((r.box.x + r.box.w / 2) - 581) < 1e-9, "容器中心 x 必须等于圆心");
  assert.ok(Math.abs((r.box.y + r.box.h / 2) - 388) < 1e-9, "容器中心 y 必须等于圆心");
  assert.equal(r.box.w, r.box.h, "容器必须是正方形（否则验收量出来的中心会偏）");
  assert.equal(r.items.length, 6);
});

test("径向菜单：任意项数下按钮都在环上、彼此不重叠、圆心不变", () => {
  for (let n = 2; n <= 10; n++) {
    const r = radialLayout({ x: 500, y: 400, count: n, viewport: PAD });
    const half = r.itemSize / 2;
    for (const it of r.items) {
      const d = Math.hypot(it.x - r.center.x, it.y - r.center.y);
      assert.ok(Math.abs(d - r.radius) < 1e-6, `${n} 项：按钮必须在半径上`);
      assert.ok(it.x - half >= 0 && it.x + half <= PAD.w, `${n} 项：按钮不许越视口左右`);
      assert.ok(it.y - half >= 0 && it.y + half <= PAD.h, `${n} 项：按钮不许越视口上下`);
    }
    // 相邻按钮的间隙：圆环周长必须容得下 n 个按钮
    const arc = (2 * Math.PI * r.radius) / n;
    assert.ok(arc >= r.itemSize + 5.9, `${n} 项：弧长 ${arc.toFixed(1)} 要能装下 ${r.itemSize} 的按钮`);
  }
});

test("径向菜单：贴左上角时整体夹进视口，圆心离手指仍在 40px 量级内", () => {
  const r = radialLayout({ x: 10, y: 10, count: 6, viewport: PAD, radius: 88, itemSize: 56, margin: 8 });
  assert.ok(r.box.x >= 8 - 1e-6 && r.box.y >= 8 - 1e-6, "容器不许出屏");
  assert.ok(r.fingerDist > 0, "贴边时圆心必须被推开");
  // 推开量有下限：容器边长就是 2(R+half)，圆心至少要离边框这么远才算不出屏
  assert.ok(r.fingerDist <= (r.box.w / 2) * 1.5, `贴角推开距离 ${r.fingerDist.toFixed(1)} 不该超过容器半径的 1.5 倍`);
});

test("径向菜单：贴右下角同理，容器四边都不越界", () => {
  const r = radialLayout({ x: 1150, y: 770, count: 8, viewport: PAD, margin: 8 });
  assert.ok(r.box.x + r.box.w <= PAD.w - 8 + 1e-6);
  assert.ok(r.box.y + r.box.h <= PAD.h - 8 + 1e-6);
  for (const it of r.items) {
    assert.ok(it.x + r.itemSize / 2 <= PAD.w && it.y + r.itemSize / 2 <= PAD.h);
  }
});

test("径向菜单：项数 0 / 1 不炸", () => {
  const z = radialLayout({ x: 100, y: 100, count: 0, viewport: PAD });
  assert.equal(z.items.length, 0);
  const one = radialLayout({ x: 100, y: 100, count: 1, viewport: PAD });
  assert.equal(one.items.length, 1);
  assert.ok(one.box.w > 0);
});

test("浮卡：锚点在中间时贴着锚点放下，且完全在视口内、不压住锚点", () => {
  const p = placeCard({ anchor: { x: 500, y: 400 }, size: { w: 236, h: 150 }, viewport: PAD, gap: 46 });
  assert.equal(p.inside, true);
  assert.equal(p.overlap, 0);
  assert.ok(["right", "above", "below", "left"].includes(p.side), `方向 ${p.side}`);
  // 面卡中心到锚点的距离：验收门槛 260px
  const d = Math.hypot(p.x + 118 - 500, p.y + 75 - 400);
  assert.ok(d > 46, "卡心必须让开锚点 46px（给尺寸手柄留位）");
  assert.ok(d <= 260, `卡中心距锚点 ${d.toFixed(1)}px 必须 ≤ 260`);
  // 锚点本身落在卡片外（尺寸手柄就长在锚点上）
  assert.equal(overlapArea({ x: p.x, y: p.y, w: 236, h: 150 }, { x: 478, y: 378, w: 44, h: 44 }), 0, "卡片不许盖住尺寸手柄");
});

test("浮卡：右侧被尺寸手柄占住时改走别的方向，绝不盖住手柄", () => {
  const handle = { x: 520, y: 370, w: 60, h: 60 };   // 手柄就在锚点右侧
  const p = placeCard({ anchor: { x: 500, y: 400 }, size: { w: 236, h: 150 }, viewport: PAD, avoid: [handle], gap: 46 });
  assert.equal(p.overlap, 0, "不许与手柄重叠");
  assert.ok(p.side !== "right" || p.x > handle.x + handle.w, `实际方向 ${p.side} @ ${Math.round(p.x)},${Math.round(p.y)}`);
});

test("浮卡：锚点贴右缘时翻到左侧，仍然不出屏", () => {
  const p = placeCard({ anchor: { x: 1120, y: 400 }, size: { w: 236, h: 150 }, viewport: PAD, gap: 46 });
  assert.ok(p.x + 236 <= PAD.w - 8 + 1e-6, "不许出右边");
  assert.ok(p.x < 1120, "必须翻到锚点左边");
});

test("浮卡：锚点贴底/贴顶时上下夹取，不出视口", () => {
  const bottom = placeCard({ anchor: { x: 500, y: 770 }, size: { w: 236, h: 150 }, viewport: PAD, gap: 46 });
  assert.ok(bottom.y + 150 <= PAD.h - 8 + 1e-6, "贴底不许出屏");
  const top = placeCard({ anchor: { x: 500, y: 20 }, size: { w: 236, h: 150 }, viewport: PAD, gap: 46 });
  assert.ok(top.y >= 8 - 1e-6, "贴顶不许出屏");
});

test("浮卡：多个避让区（尺寸手柄 + 顶部浮块 + 工具坞）时选到零重叠位置", () => {
  const avoid = [
    { x: 460, y: 350, w: 80, h: 80 },     // 尺寸手柄
    { x: 8, y: 8, w: 300, h: 54 },        // 左上 chip
    { x: 8, y: 200, w: 58, h: 420 },      // 左缘工具坞
  ];
  const p = placeCard({ anchor: { x: 600, y: 380 }, size: { w: 236, h: 150 }, viewport: PAD, avoid, gap: 46 });
  assert.equal(p.overlap, 0, `${p.side} 方向仍然压到别的东西`);
  assert.equal(p.inside, true);
});

test("浮卡：视口比卡片还小时退回夹取，不抛错", () => {
  const p = placeCard({ anchor: { x: 10, y: 10 }, size: { w: 236, h: 150 }, viewport: { w: 200, h: 120 } });
  assert.equal(p.x, 8);
  assert.equal(p.y, 8);
});

test("浮卡：宁可离远一点也不许盖住锚点（夹取后压到落点＝用户看不见自己刚点了什么）", () => {
  // 高度 300 的卡、锚点在 y=250：'above' 候选被夹到 y=8，跨 8..308 → 会把落点整个盖住
  const p = placeCard({ anchor: { x: 222, y: 250 }, size: { w: 268, h: 300 }, viewport: PAD, gap: 14 });
  const covers = 222 > p.x && 222 < p.x + 268 && 250 > p.y && 250 < p.y + 300;
  assert.equal(covers, false, `浮卡 ${Math.round(p.x)},${Math.round(p.y)} 盖住了落点`);
  assert.equal(p.coversPoint, false);
});

const sx = 268, sy = 224;   // 配合菜单实测尺寸
const overlapPx = (p, b) => Math.round(Math.max(0, Math.min(p.x + sx, b.x + b.w) - Math.max(p.x, b.x))
  * Math.max(0, Math.min(p.y + sy, b.y + b.h) - Math.max(p.y, b.y)));

test("大浮层扫描定位：两个被选面都不许压，落点不许盖，且仍在落点附近", () => {
  // 实测场景（装配配合菜单）：面 B 420×211、面 A 303×133，落点 (222,250) 落在面 B 里
  const faceB = { x: 108.9, y: 175.6, w: 420.7, h: 210.9 };
  const faceA = { x: 476.8, y: 330.9, w: 303.5, h: 132.7 };
  const p = placeCardScan({ anchor: { x: 222, y: 250 }, size: { w: sx, h: sy }, viewport: PAD, avoid: [faceA, faceB], step: 12 });
  assert.equal(overlapPx(p, faceA), 0, "不许压面 A");
  assert.equal(overlapPx(p, faceB), 0, "不许压面 B");
  assert.equal(p.coversPoint, false, "不许盖住落点");
  assert.equal(p.inside, true, "不许出视口");
  const d = Math.hypot(p.x + sx / 2 - 222, p.y + sy / 2 - 250);
  assert.ok(d <= 260, `菜单中心距落点 ${d.toFixed(0)}px 必须 ≤260（比之前 316px 更近）`);
});

test("大浮层扫描定位：没有障碍时贴着落点放（不许无脑丢到角落）", () => {
  const p = placeCardScan({ anchor: { x: 600, y: 400 }, size: { w: 268, h: 224 }, viewport: PAD, step: 12 });
  const d = Math.hypot(p.x + 134 - 600, p.y + 112 - 400);
  assert.ok(d <= 200, `无遮挡时应当贴近落点，实际 ${d.toFixed(0)}px`);
  assert.equal(p.overlap, 0);
});

test("工具坞：可用高度不够时先压缩按钮，压到 48 才允许滚动", () => {
  const tall = dockMetrics({ count: 6, viewport: PAD, reservedTop: 64, reservedBottom: 64 });
  assert.equal(tall.size, 52);
  assert.equal(tall.overflow, false);
  const short = dockMetrics({ count: 9, viewport: { w: 700, h: 420 }, reservedTop: 64, reservedBottom: 64 });
  assert.ok(short.size >= 48, "按钮不许小于 48（触摸目标下限）");
  assert.equal(short.overflow, true, "压到下限还放不下就必须允许滚动");
  const none = dockMetrics({ count: 0, viewport: PAD });
  assert.equal(none.height, 0);
});
