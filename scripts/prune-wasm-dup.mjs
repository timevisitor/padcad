// 删掉 vite 额外产出的 hashed wasm —— 运行时走的是 kernel.js 的 locateFile("./replicad_single.wasm")，
// 也就是 public/ 里那份；hashed 那份只在「没传 locateFile」的分支里才会用到（本项目永远传）。
// 不删的话 APK 里会有两份 23MB 的 wasm（36MB → 18MB）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const assets = path.join(root, "dist", "assets");
let n = 0;
if (fs.existsSync(assets)) {
  for (const f of fs.readdirSync(assets)) {
    if (/^replicad_single-.*\.wasm$/.test(f)) {
      fs.unlinkSync(path.join(assets, f));
      n++;
    }
  }
}
const keep = path.join(root, "dist", "replicad_single.wasm");
console.log(`[prune-wasm] 删除 ${n} 份 hashed wasm；保留 dist/replicad_single.wasm ${fs.existsSync(keep) ? "✓" : "✗ 缺失!"}`);
if (!fs.existsSync(keep)) process.exit(1);
