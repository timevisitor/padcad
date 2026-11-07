/**
 * C 批「实体特征」回归：平面分割 / 布尔运算 / 移动面 / 加厚
 *
 * 判据一律是**解析体积**（公式写在注释里），不看面数、不靠肉眼。
 * 基准件：60×40×8 板 = 19 200 mm³（makeBaseBox 以原点为 XY 中心、底面 z=0）。
 *
 * 三个额外的硬要求也在这里断言：
 *   1) 每个 op 都能通过 rebuild([{op:{type:'base'}}, {op:...}], 1) 完整重放；
 *   2) 参数非法时抛中文错误，绝不静默返回空体；
 *   3) op 不能消费调用方传进来的实体（布尔会吃掉输入，实现里必须 clone）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import opencascade from "replicad-opencascadejs";
import { setOC, makeBaseBox, measureVolume } from "replicad";
import * as OPS from "./src/ops.js";
import { rebuild, replayOp } from "./src/replay.js";
import { registeredOps } from "./src/op-registry.js";

setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }

const PI = Math.PI;
/** 布尔与网格都不该动摇解析值：平面件卡 1e-3，曲面件卡 1e-2 */
const close = (a, b, tol = 1e-3) =>
  assert.ok(Math.abs(a - b) < tol, `体积 ${(+a).toFixed(6)} != 期望 ${(+b).toFixed(6)}（差 ${(a - b).toFixed(6)}）`);

const PLATE = 60 * 40 * 8;                    // 19 200
const plate = () => makeBaseBox(60, 40, 8);
const V = (s) => measureVolume(s);
const bbOf = (s) => [s.boundingBox.width, s.boundingBox.height, s.boundingBox.depth];

function assertBox(shape, w, h, d) {
  const [bw, bh, bd] = bbOf(shape);
  assert.ok(Math.abs(bw - w) < 1e-5 && Math.abs(bh - h) < 1e-5 && Math.abs(bd - d) < 1e-5,
    `包围盒 ${bw.toFixed(3)}×${bh.toFixed(3)}×${bd.toFixed(3)} != ${w}×${h}×${d}`);
}

// ---------------------------------------------------------------- 0) 注册到位
test("四个 op 都已注册进 op 注册表", () => {
  const all = registeredOps();
  for (const t of ["split_plane", "combine", "offset_face", "thicken"]) {
    assert.ok(all.includes(t), `注册表里没有 ${t}，实际有 ${all.join(", ")}`);
  }
});

// ---------------------------------------------------------------- 1) split_plane
test("分割：y=0 平面，正/负两侧各 9600，合计 = 原体积", () => {
  const n = [0, 1, 0];
  const pos = replayOp(plate(), { type: "split_plane", origin: [0, 0, 0], normal: n, keep: "positive" });
  const neg = replayOp(plate(), { type: "split_plane", origin: [0, 0, 0], normal: n, keep: "negative" });
  const vp = V(pos), vn = V(neg);
  close(vp, 60 * 20 * 8);                     // 9600
  close(vn, 60 * 20 * 8);                     // 9600
  close(vp + vn, PLATE);                      // 两半之和 = 19200
});

test("分割：与 replicad 自带 split() 逐侧对账（独立第二路径）", () => {
  const ref = plate().split("XZ");            // XZ 面 = 过原点、法向 +Y
  const mine = replayOp(plate(), { type: "split_plane", origin: [0, 0, 0], normal: [0, 1, 0], keep: "positive" });
  close(V(mine), V(ref.positive));
});

test("分割：斜平面（法向 [1,1,0] 未归一化）过中心 → 对半，各 9600", () => {
  const pos = replayOp(plate(), { type: "split_plane", origin: [0, 0, 0], normal: [1, 1, 0], keep: "positive" });
  const neg = replayOp(plate(), { type: "split_plane", origin: [0, 0, 0], normal: [1, 1, 0], keep: "negative" });
  close(V(pos), 9600, 1e-2);
  close(V(pos) + V(neg), PLATE, 1e-2);
});

test("分割：z=6 处切，保留负侧 → 60×40×6 = 14400", () => {
  const out = replayOp(plate(), { type: "split_plane", origin: [0, 0, 6], normal: [0, 0, 2], keep: "negative" });
  close(V(out), 60 * 40 * 6);
  assertBox(out, 60, 40, 6);
});

test("分割：平面在实体外 → 明确报错「这个位置切不到实体」", () => {
  assert.throws(
    () => replayOp(plate(), { type: "split_plane", origin: [0, 0, 100], normal: [0, 0, 1], keep: "positive" }),
    /切不到实体/);
});

test("分割：参数非法时报中文错，且不消费传入实体", () => {
  const p = plate();
  assert.throws(() => replayOp(p, { type: "split_plane", origin: [0, 0, 0], normal: [0, 1, 0], keep: "both" }), /keep 只能是/);
  assert.throws(() => replayOp(p, { type: "split_plane", origin: [0, 0, 0], normal: [0, 0, 0], keep: "positive" }), /零向量/);
  assert.throws(() => replayOp(p, { type: "split_plane", origin: [0, 0], normal: [0, 1, 0] }), /三元数组/);
  assert.throws(() => replayOp(null, { type: "split_plane", origin: [0, 0, 0], normal: [0, 1, 0] }), /需要一个已有的实体/);
  // 上面对同一块 p 连做了 4 次失败调用，p 必须仍然完好
  close(V(p), PLATE);
});

test("分割：连续两次分割得到 1/4（可链式重放）", () => {
  const s1 = replayOp(plate(), { type: "split_plane", origin: [0, 0, 0], normal: [0, 1, 0], keep: "positive" });
  const s2 = replayOp(s1, { type: "split_plane", origin: [0, 0, 0], normal: [1, 0, 0], keep: "positive" });
  close(V(s2), 30 * 20 * 8);                   // 4800
});

// ---------------------------------------------------------------- 2) combine
const BOX_TOOL = { shape: "box", size: [20, 20, 20], at: [0, 0, 4] };  // 与板重叠 20×20×4 = 1600
const INT_BOX = 20 * 20 * 4;

test("布尔 fuse：体积 = 19200 + 8000 − 1600 = 25600", () => {
  const out = replayOp(plate(), { type: "combine", mode: "fuse", tool: BOX_TOOL });
  close(V(out), PLATE + 20 * 20 * 20 - INT_BOX);   // 19 200 + 8 000 − 1 600
});

test("布尔 cut：体积 = 19200 − 1600 = 17600", () => {
  const out = replayOp(plate(), { type: "combine", mode: "cut", tool: BOX_TOOL });
  close(V(out), PLATE - INT_BOX);
});

test("布尔 common：体积 = 公共 1600", () => {
  const out = replayOp(plate(), { type: "combine", mode: "common", tool: BOX_TOOL });
  close(V(out), INT_BOX);
});

test("布尔 cut 圆柱 Ø12 贯通：体积 = 19200 − π·6²·8", () => {
  const out = replayOp(plate(), {
    type: "combine", mode: "cut",
    tool: { shape: "cylinder", r: 6, h: 20, at: [0, 0, -6], dir: [0, 0, 1] },
  });
  close(V(out), PLATE - PI * 36 * 8, 1e-2);
});

test("布尔 common 球 R6 压顶面：体积 = 下半球 (2/3)π·6³", () => {
  // 球心在 z=8（顶面），半径 6 → 球最低点 z=2 仍在板内，所以公共体就是完整下半球
  const out = replayOp(plate(), {
    type: "combine", mode: "common",
    tool: { shape: "sphere", r: 6, at: [0, 0, 8] },
  });
  close(V(out), (2 / 3) * PI * 216, 1e-2);     // 452.389
});

test("布尔：工具体不沾边时 cut / common 明确报错，不静默无变化", () => {
  const far = { shape: "box", size: [10, 10, 10], at: [500, 0, 0] };
  assert.throws(() => replayOp(plate(), { type: "combine", mode: "cut", tool: far }), /没有交集/);
  assert.throws(() => replayOp(plate(), { type: "combine", mode: "common", tool: far }), /没有交集/);
  // fuse 不沾边是合法并集：19200 + 1000
  close(V(replayOp(plate(), { type: "combine", mode: "fuse", tool: far })), PLATE + 1000);
});

test("布尔：模式 / 工具体非法时报中文错", () => {
  assert.throws(() => replayOp(plate(), { type: "combine", mode: "xor", tool: BOX_TOOL }), /布尔模式/);
  assert.throws(() => replayOp(plate(), { type: "combine", mode: "cut" }), /需要一个工具体/);
  assert.throws(() => replayOp(plate(), { type: "combine", mode: "cut", tool: { shape: "trapezoid" } }), /不认识的形体/);
  assert.throws(() => replayOp(plate(), { type: "combine", mode: "cut", tool: { shape: "cylinder", r: 0, h: 5 } }), /半径和高度/);
  assert.throws(() => replayOp(null, { type: "combine", mode: "cut", tool: BOX_TOOL }), /需要一个已有的实体/);
});

test("布尔别名 union / subtract / intersect 与 fuse / cut / common 等价", () => {
  close(V(replayOp(plate(), { type: "combine", mode: "union", tool: BOX_TOOL })), PLATE + 8000 - INT_BOX);
  close(V(replayOp(plate(), { type: "combine", mode: "subtract", tool: BOX_TOOL })), PLATE - INT_BOX);
  close(V(replayOp(plate(), { type: "combine", mode: "intersect", tool: BOX_TOOL })), INT_BOX);
});

// ---------------------------------------------------------------- 3) offset_face
test("移动面：顶面 +2 → 19200 + 60·40·2 = 24000，厚度变 10", () => {
  const out = replayOp(plate(), { type: "offset_face", at: [0, 0, 8], normal: [0, 0, 1], distance: 2 });
  close(V(out), PLATE + 60 * 40 * 2);
  assertBox(out, 60, 40, 10);
});

test("移动面：顶面 −3 → 19200 − 60·40·3 = 12000，厚度变 5", () => {
  const out = replayOp(plate(), { type: "offset_face", at: [0, 0, 8], normal: [0, 0, 1], distance: -3 });
  close(V(out), PLATE - 60 * 40 * 3);
  assertBox(out, 60, 40, 5);
});

test("移动面：+X 侧面 +5 → 19200 + 40·8·5 = 20800，宽度变 65", () => {
  const out = replayOp(plate(), { type: "offset_face", at: [30, 0, 4], normal: [1, 0, 0], distance: 5 });
  close(V(out), PLATE + 40 * 8 * 5);
  assertBox(out, 65, 40, 8);
});

test("移动面：底面 −2（向下长料）→ 19200 + 60·40·2，且底面落到 z=−2", () => {
  const out = replayOp(plate(), { type: "offset_face", at: [0, 0, 0], normal: [0, 0, -1], distance: 2 });
  close(V(out), PLATE + 60 * 40 * 2);
  assert.ok(Math.abs(out.boundingBox.bounds[0][2] - (-2)) < 1e-6, "底面没有降到 z=−2");
});

test("移动面：点不在面上 / 距离为 0 / 空实体 → 明确中文报错", () => {
  assert.throws(() => replayOp(plate(), { type: "offset_face", at: [0, 0, 100], normal: [0, 0, 1], distance: 2 }), /找不到要移动的面/);
  assert.throws(() => replayOp(plate(), { type: "offset_face", at: [0, 0, 8], normal: [0, 0, 1], distance: 0 }), /移动距离太小/);
  assert.throws(() => replayOp(plate(), { type: "offset_face", at: [0, 0, 8], normal: [0, 0, 1] }), /移动距离必须是数字/);
  assert.throws(() => replayOp(null, { type: "offset_face", at: [0, 0, 8], normal: [0, 0, 1], distance: 2 }), /需要一个已有的实体/);
});

test("移动面：重复移动是累积的（+2 再 +3 → 24000+7200=31200）", () => {
  const s1 = replayOp(plate(), { type: "offset_face", at: [0, 0, 8], normal: [0, 0, 1], distance: 2 });
  const s2 = replayOp(s1, { type: "offset_face", at: [0, 0, 10], normal: [0, 0, 1], distance: 3 });
  close(V(s2), PLATE + 60 * 40 * 5);
});

// ---------------------------------------------------------------- 4) thicken
test("加厚：60×40×8 壁厚 2 → 19200 − 56·36·4 = 11136（内腔 56×36×4）", () => {
  const out = replayOp(plate(), { type: "thicken", thickness: 2 });
  const INNER = 56 * 36 * 4;                  // 8 064
  close(V(out), PLATE - INNER);               // 11 136
  assertBox(out, 60, 40, 8);                  // 外形不变，只是中间空了
});

test("加厚：壁厚 1 → 19200 − 58·38·6 = 5976", () => {
  const out = replayOp(plate(), { type: "thicken", thickness: 1 });
  close(V(out), PLATE - 58 * 38 * 6);
});

test("加厚：带 Ø12 中心孔的板，壁厚 2 → 18295.2213 − (8064 − π·8²·4)", () => {
  const base = OPS.starterModel();
  const v0 = V(base);
  const inner = 56 * 36 * 4 - PI * 64 * 4;    // 孔向内也长 2：R6 → R8
  const out = replayOp(base, { type: "thicken", thickness: 2 });
  close(V(out), v0 - inner, 1e-2);
});

test("加厚：壁厚过大 / 为 0 / 非法 → 明确中文报错", () => {
  assert.throws(() => replayOp(plate(), { type: "thicken", thickness: 5 }), /壁厚 5mm 太大/);
  assert.throws(() => replayOp(plate(), { type: "thicken", thickness: 4 }), /壁厚 4mm 太大/);
  assert.throws(() => replayOp(plate(), { type: "thicken", thickness: 0 }), /壁厚必须大于 0/);
  assert.throws(() => replayOp(plate(), { type: "thicken", thickness: "厚" }), /壁厚必须是数字/);
  assert.throws(() => replayOp(null, { type: "thicken", thickness: 2 }), /需要一个已有的实体/);
});

// ---------------------------------------------------------------- 5) 完整重放通道
test("重放：base → split_plane 保留正侧 = 带孔板的一半", () => {
  const base = OPS.starterModel();
  const half = V(base) / 2;
  const hist = [
    { op: { type: "base" } },
    { op: { type: "split_plane", origin: [0, 0, 0], normal: [0, 1, 0], keep: "positive" } },
  ];
  const { shape, steps } = rebuild(hist, 1);
  assert.equal(steps, 2);
  close(V(shape), half, 1e-2);
});

test("重放：base → combine(cut) → offset_face，能连跑两步", () => {
  const base = OPS.starterModel();
  const hist = [
    { op: { type: "base" } },
    { op: { type: "combine", mode: "cut", tool: { shape: "cylinder", r: 6, h: 20, at: [20, 0, -6], dir: [0, 0, 1] } } },
    // 挪 +X 侧面（那里没有孔，面积就是 40×8，解析值干净）
    { op: { type: "offset_face", at: [30, 0, 4], normal: [1, 0, 0], distance: 5 } },
  ];
  const out = rebuild(hist, 2).shape;
  close(V(out), V(base) - PI * 36 * 8 + 40 * 8 * 5, 1e-2);
});

test("重放：顶面带孔时移动面只在实际面面积上加料（不会把孔填死）", () => {
  // 板上先挖掉两个 Ø12 孔（中心孔 + x=20 处新孔），顶面面积 = 60·40 − 2·π·6²
  const base = OPS.starterModel();
  const hist = [
    { op: { type: "base" } },
    { op: { type: "combine", mode: "cut", tool: { shape: "cylinder", r: 6, h: 20, at: [20, 0, -6], dir: [0, 0, 1] } } },
    { op: { type: "offset_face", at: [0, 0, 8], normal: [0, 0, 1], distance: 2 } },
  ];
  const out = rebuild(hist, 2).shape;
  const faceArea = 60 * 40 - 2 * PI * 36;
  close(V(out), V(base) - PI * 36 * 8 + faceArea * 2, 1e-2);   // 21 738.053
});

test("重放：base → thicken / combine(fuse) 各走一遍", () => {
  const base = OPS.starterModel();
  const vBase = V(base);
  const t = rebuild([{ op: { type: "base" } }, { op: { type: "thicken", thickness: 2 } }], 1).shape;
  close(V(t), vBase - (56 * 36 * 4 - PI * 64 * 4), 1e-2);
  const f = rebuild([
    { op: { type: "base" } },
    { op: { type: "combine", mode: "fuse", tool: { shape: "box", size: [20, 20, 20], at: [0, 0, 8] } } },
  ], 1).shape;
  // 台子 20×20 完全落在顶面上：接触面体积 0
  close(V(f), vBase + 20 * 20 * 20);
});

test("重放：参数过了 JSON 往返仍然能重放（op 必须可序列化）", () => {
  const op = JSON.parse(JSON.stringify({ type: "split_plane", origin: [0, 0, 6], normal: [0, 0, 1], keep: "negative" }));
  close(V(replayOp(plate(), op)), 60 * 40 * 6);
});

test("重放：失败步骤带上 stepIndex，调用方知道是哪一步", () => {
  let err = null;
  try {
    rebuild([
      { op: { type: "base" } },
      { op: { type: "split_plane", origin: [0, 0, 100], normal: [0, 0, 1], keep: "positive" } },
    ], 1);
  } catch (e) { err = e; }
  assert.ok(err, "应当抛错");
  assert.match(String(err.message), /切不到实体/);
  assert.equal(err.stepIndex, 1);
});

console.log(`\nC 批实体特征回归：${passed} 项通过`);
