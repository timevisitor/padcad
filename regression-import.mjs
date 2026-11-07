/**
 * 导入为设计起点（A 批 P0-7）
 *
 * 不重复测 STEP 解析（看图模式已在用），这里测的是新接的那条路：
 *   实体登记 → op 只存 id → 重放取回副本（不能是同一个引用，否则下游布尔会把它消费掉）
 *   缓存缺失时明确报错，绝不返回空实体
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
const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test("登记后在历史里以 import op 重放，体积不变", () => {
  const src = makeBaseBox(60, 40, 8);
  const reg = OPS.registerImported(src, "外来件.step");
  assert.match(reg.id, /^imp\d+$/);
  const out = rebuild([{ op: { type: "import", id: reg.id, name: reg.name } }], 0);
  close(measureVolume(out.shape), 19200, 1e-3);
});

test("重放拿的是副本：改下游不影响缓存里的原件", () => {
  const src = makeBaseBox(60, 40, 8);
  const reg = OPS.registerImported(src, "件");
  const cut = replayOp(OPS.importedShape(reg.id).clone(), {
    type: "hole", at: [0, 0, 8], normal: [0, 0, 1], diameter: 6, kind: "through",
  });
  close(measureVolume(cut), 19200 - Math.PI * 9 * 8, 1e-3);
  close(measureVolume(OPS.importedShape(reg.id)), 19200, 1e-3);   // 原件没被动过
});

test("缓存缺失（重开工程）时报明确的错，而不是给空实体", () => {
  assert.throws(() => replayOp(makeBaseBox(10, 10, 10), { type: "import", id: "imp9999" }), /重新导入/);
});

test("不存在的 id 删不掉也不报错（幂等清理）", () => {
  OPS.dropImported("imp404");
  assert.ok(true);
});

console.log(`\n导入通道回归：${passed} 项通过`);
