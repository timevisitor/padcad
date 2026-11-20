/**
 * 回归：语境工具栏的纯函数层（src/ui-context.js）
 *
 * 为什么只测纯函数：按钮清单是"按对象类型过滤"的规格，改错一个 key 就是"点了没反应"，
 * 而这种错在真机上只能靠逐个点才发现。把规格钉成断言，改代码时立刻红。
 * 端到端（按钮真的执行、history/体积变化）在 tools/accept-context.mjs 里用 CDP 验。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { contextActions, contextTag, renderContextToolbar, KIND_TITLE } from "./src/ui-context.js";

const labels = (kind, ctx) => contextActions(kind, ctx).map((a) => a.label);

test("平面面：给出 推拉/草图/孔/移动面/圆角/加选面", () => {
  assert.deepEqual(labels("face-plane"), ["推拉", "草图", "孔", "移动面", "圆角", "加选面"]);
});

test("加选开着时，最后一个动作变成「退出加选」", () => {
  assert.equal(labels("face-plane", { multi: true }).at(-1), "退出加选");
  assert.equal(labels("face-cylinder", { multi: true }).at(-1), "退出加选");
});

test("圆柱面：给出 改直径/同轴孔/加选面", () => {
  assert.deepEqual(labels("face-cylinder"), ["改直径", "同轴孔", "加选面"]);
});

test("一般曲面：只给加选（没有可唯一确认的尺寸来源）", () => {
  assert.deepEqual(labels("face-curved"), ["加选面"]);
});

test("棱边：给出 圆角/倒角", () => {
  assert.deepEqual(labels("edge"), ["圆角", "倒角"]);
});

test("草图轮廓：给出 拉伸/旋转/扫掠/完成草图", () => {
  assert.deepEqual(labels("profile"), ["拉伸", "旋转", "扫掠", "完成草图"]);
});

test("两个面：给出 距离/智能尺寸", () => {
  assert.deepEqual(labels("pair"), ["距离", "智能尺寸"]);
});

test("未知类型：返回空清单（不要给一堆点了没反应的按钮）", () => {
  assert.deepEqual(contextActions("nope"), []);
});

test("每个动作都带 hint（按钮上要写清它干什么）", () => {
  for (const kind of Object.keys(KIND_TITLE)) {
    for (const a of contextActions(kind)) {
      assert.ok(a.hint && a.hint.length > 4, `${kind}/${a.key} 缺少说明`);
      assert.ok(a.key && a.label, `${kind} 有动作缺 key/label`);
    }
  }
});

test("标志位只有推拉与改直径这两个带数值输入", () => {
  const withValue = [];
  for (const kind of Object.keys(KIND_TITLE)) {
    for (const a of contextActions(kind)) if (a.value) withValue.push(a.key);
  }
  assert.deepEqual(withValue.sort(), ["diameter", "pushpull"]);
});

test("标签：面号补零到 5 位，边/轮廓/两面各有说法", () => {
  assert.equal(contextTag("face-plane", { faceId: 123 }), "#00123");
  assert.equal(contextTag("edge", { tag: "#00042" }), "#00042");
  assert.equal(contextTag("profile", { count: 3 }), "3 个轮廓");
  assert.equal(contextTag("pair", { count: 2 }), "2 个面");
});

test("渲染：动作进 DOM 的顺序与清单一致，且每个按钮都带 data-ctx", () => {
  const el = { innerHTML: "" };
  const r = renderContextToolbar(el, {
    kind: "edge", tag: "#00001", headline: "棱边", sub: "棱边",
    actions: contextActions("edge"),
  });
  assert.deepEqual(r.labels, ["圆角", "倒角"]);
  assert.match(el.innerHTML, /data-ctx="fillet"/);
  assert.match(el.innerHTML, /data-ctx="chamfer"/);
  assert.ok(el.innerHTML.indexOf("圆角") < el.innerHTML.indexOf("倒角"), "按钮顺序必须稳定");
});

test("渲染：带 value 的动作落进数值行（平面=推拉，圆柱=改直径），并保留 #dist 与 data-act=apply", () => {
  const el = { innerHTML: "" };
  renderContextToolbar(el, { kind: "face-plane", tag: "#00002", actions: contextActions("face-plane"), value: 6 });
  assert.match(el.innerHTML, /id="dist"/);
  assert.match(el.innerHTML, /data-act="apply"/);
  assert.match(el.innerHTML, /data-ctx="pushpull"/);
  assert.match(el.innerHTML, /value="6"/);
  const cyl = { innerHTML: "" };
  renderContextToolbar(cyl, { kind: "face-cylinder", tag: "#00003", actions: contextActions("face-cylinder"), value: 12 });
  assert.match(cyl.innerHTML, /data-ctx="diameter"/);
  assert.match(cyl.innerHTML, /id="dist"/);
  assert.doesNotMatch(cyl.innerHTML, /data-ctx="pushpull"/);
});

test("main.js 里每一个 data-ctx 的 key 都有实现（否则就是点了没反应的按钮）", () => {
  const main = fs.readFileSync(new URL("./src/main.js", import.meta.url), "utf8");
  const runStart = main.indexOf("function runContextAction(key)");
  assert.ok(runStart > 0, "main.js 缺少 runContextAction");
  const runEnd = main.indexOf("\n}\n", runStart);
  const body = main.slice(runStart, runEnd);
  const implemented = new Set([...body.matchAll(/case "([a-zA-Z]+)":/g)].map((m) => m[1]));
  const keys = new Set();
  for (const kind of Object.keys(KIND_TITLE)) for (const a of contextActions(kind)) keys.add(a.key);
  const missing = [...keys].filter((k) => !implemented.has(k));
  assert.deepEqual(missing, [], `这些语境动作没有实现：${missing.join(", ")}`);
});

test("渲染：headline 会替换默认标题（paintContextCard 必须把它透传下去）", () => {
  const el = { innerHTML: "" };
  renderContextToolbar(el, { kind: "profile", headline: "草图", tag: "2 个轮廓", actions: contextActions("profile") });
  assert.match(el.innerHTML, /草图 <b>2 个轮廓<\/b>/);
  assert.doesNotMatch(el.innerHTML, /草图轮廓 <b>/);
  // 静态检查：main.js 的 paintContextCard 要把 headline 透传给渲染器（漏了就会显示默认标题）
  const main = fs.readFileSync(new URL("./src/main.js", import.meta.url), "utf8");
  assert.match(main, /renderContextToolbar\(el, \{ kind, headline, tag,/);
});

test("渲染：4 个动作排 2 列（避免第二行只剩一个孤按钮）", () => {
  const el = { innerHTML: "" };
  renderContextToolbar(el, { kind: "profile", tag: "1 个轮廓", actions: contextActions("profile") });
  assert.match(el.innerHTML, /pk-cols-2/);
  const el5 = { innerHTML: "" };
  renderContextToolbar(el5, { kind: "face-plane", tag: "#00001", actions: contextActions("face-plane"), value: 5 });
  assert.match(el5.innerHTML, /pk-cols-3/);
});
