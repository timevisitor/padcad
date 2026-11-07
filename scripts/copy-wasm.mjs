// 把 OCCT 的 wasm 从 node_modules 拷到 public/（不进仓库，22MB 只从依赖里来）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = path.join(root, "node_modules", "replicad-opencascadejs", "dist", "replicad_single.wasm");
const dir = path.join(root, "public");
const dst = path.join(dir, "replicad_single.wasm");

if (!fs.existsSync(src)) {
  console.warn("[copy-wasm] 找不到 " + src + "，跳过（先 npm install）");
  process.exit(0);
}
fs.mkdirSync(dir, { recursive: true });
const a = fs.statSync(src);
if (fs.existsSync(dst) && fs.statSync(dst).size === a.size) {
  console.log("[copy-wasm] 已是最新，跳过");
  process.exit(0);
}
fs.copyFileSync(src, dst);
console.log("[copy-wasm] -> public/replicad_single.wasm (" + (a.size / 1048576).toFixed(1) + " MB)");
