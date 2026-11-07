import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = readdirSync(root).filter((name) => /^regression-.*\.mjs$/.test(name)).sort();
if (!files.length) throw new Error("No regression tests found");
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
  cwd: root, stdio: "inherit", timeout: 120000,
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
