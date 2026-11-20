// 6.0.0 真机：示例装配 JSON 在 APK 里 404（vite build 只拷 public/，samples/ 不进 dist）。
// 守住：assembly-ui 里引用的每个 samples/*.json 都必须由 import 打进 bundle（BUNDLED_SAMPLES 有键）。
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
test("装配示例 JSON 全部打进 bundle，不靠运行时 fetch", () => {
  const src = fs.readFileSync("./src/assembly-ui.js", "utf8");
  const used = new Set([...src.matchAll(/file:\s*"(samples\/[^"]+\.json)"/g)].map((m) => m[1]));
  assert.ok(used.size >= 2, `应找到示例引用，实际 ${used.size}`);
  const block = src.match(/const BUNDLED_SAMPLES = \{([^}]*)\}/);
  assert.ok(block, "缺少 BUNDLED_SAMPLES");
  for (const f of used) {
    assert.ok(block[1].includes(`"${f}"`), `${f} 没有打进 bundle`);
    assert.ok(fs.existsSync("./" + f), `${f} 文件不存在`);
  }
});
