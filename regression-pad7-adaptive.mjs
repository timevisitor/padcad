import assert from "node:assert/strict";
import test from "node:test";
import { renderPixelRatio, gpuTier, readGpuName, RenderGovernor } from "./src/render-budget.js";

// 小米 Pad 7 Ultra 的画布尺寸（CSS 像素）与玄戒 O1 的 GPU 标识。
const PAD_W = 1600, PAD_H = 1000, PAD_DPR = 2;
const XRING_GPU = "Immortalis-G925";

test("GPU 分级识别玄戒 O1 的 Immortalis-G925 为旗舰档", () => {
  assert.equal(gpuTier(XRING_GPU), "high");
  assert.equal(gpuTier("Mali-G925-MP16"), "high");
  assert.equal(gpuTier("Adreno 750"), "high");
  assert.equal(gpuTier("Mali-G76"), "mid");
  assert.equal(gpuTier("Adreno 660"), "mid");
  // 识别不到就走保守档，不去赌一块未知 GPU 的性能。
  assert.equal(gpuTier(""), "unknown");
  assert.equal(gpuTier("WebKit WebGL"), "unknown");
});

test("拿不到 renderer 信息时不抛异常，返回空串", () => {
  assert.equal(readGpuName(null), "");
  assert.equal(readGpuName({ getExtension: () => null }), "");
  assert.equal(readGpuName({ getExtension: () => { throw new Error("blocked"); } }), "");
  assert.equal(readGpuName({
    getExtension: (n) => (n === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: 1 } : null),
    getParameter: () => XRING_GPU,
  }), XRING_GPU);
});

test("预算缩放提高旗舰 GPU 的静止画质，但仍受 deviceRatio 与上限约束", () => {
  const baseline = renderPixelRatio(PAD_W, PAD_H, PAD_DPR, true, false);
  const raised = renderPixelRatio(PAD_W, PAD_H, PAD_DPR, true, false, 2.2);
  assert.ok(raised > baseline, "旗舰档应该允许比基线更清晰");
  assert.ok(raised <= PAD_DPR, "绝不超过原生 deviceRatio，避免无谓的超采样");
  // 基线契约不变：默认参数下触摸设备静止预算仍是 350 万像素。
  assert.ok(PAD_W * PAD_H * baseline ** 2 <= 3_500_001);
  assert.equal(renderPixelRatio(800, 500, 1, true, false), 1);
  // 缩放被夹在合理区间，异常值不会把分辨率压没或放大到爆。
  assert.ok(renderPixelRatio(PAD_W, PAD_H, PAD_DPR, true, true, 1e6) <= PAD_DPR);
  assert.ok(renderPixelRatio(PAD_W, PAD_H, PAD_DPR, true, true, 0) > 0);
});

test("连续掉帧时降低预算，且始终夹在 floor/ceiling 之间", () => {
  const g = new RenderGovernor({ tier: "high" });
  const start = g.scale;
  for (let i = 0; i < RenderGovernor.COOLDOWN * 6; i++) g.sample(40);   // 25fps，明显掉帧
  assert.ok(g.scale < start, "持续掉帧必须降分辨率");
  assert.ok(g.scale >= g.floor, "不能低于下限");
  assert.ok(g.consumeChanged(), "要通知渲染器重新分配帧缓冲");
  assert.equal(g.consumeChanged(), false, "信号只能取走一次");

  for (let i = 0; i < RenderGovernor.COOLDOWN * 40; i++) g.sample(40);
  assert.equal(g.scale, g.floor, "再怎么卡也只能降到下限");
});

test("帧率富余时回升到分级上限为止", () => {
  const g = new RenderGovernor({ tier: "high" });
  g.scale = g.floor;
  for (let i = 0; i < RenderGovernor.COOLDOWN * 60; i++) g.sample(4);    // 250fps 的余量
  assert.ok(g.scale > g.floor, "流畅时应该把画质加回去");
  assert.ok(g.scale <= g.ceiling, "不能超过该 GPU 分级的预算上限");
});

test("冷却期内不抖动，静止预算不低于基线", () => {
  const g = new RenderGovernor({ tier: "high" });
  const before = g.scale;
  for (let i = 0; i < RenderGovernor.COOLDOWN - 1; i++) g.sample(40);
  assert.equal(g.scale, before, "冷却期没到就先别动，避免反复重分配帧缓冲");

  g.scale = 0.8;
  assert.ok(g.idleScale >= 1, "静止时至少维持基线画质");
  assert.ok(g.idleScale <= g.ceiling);

  const unknown = new RenderGovernor({ tier: "unknown" });
  assert.equal(unknown.ceiling, 1, "识别不到 GPU 时不放大预算");
  assert.ok(unknown.ceiling < g.ceiling, "旗舰档上限必须高于保守档");
  assert.equal(unknown.scale, 1, "保守档从基线起步");
});

test("静止时的长间隔不会被误判成掉帧", () => {
  const g = new RenderGovernor({ tier: "high" });
  const before = g.scale;
  g.reset();
  g.sample(5000);          // 静止了 5 秒才来一帧
  assert.equal(g.scale, before, "reset 之后不该拿旧 EMA 继续下调");
  assert.ok(g.idleScale >= 1);
});
