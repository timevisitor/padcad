# 草图覆盖层不跟随视图（蓝点/尺寸/引导线错位）— 根因与修复（PadCAD 5.1.6）

日期：2026-11-08　版本：5.1.6（versionCode 71）　发现：小米平板 7 Ultra（25032RP42C / 玄戒 O1 / Immortalis-G925）

## 1. 现象（用户原话）

> 在草图模式通过触摸点了四个点建立几个线段之后，我用触摸移动了画面位置，然后四个点没有跟着动，导致错位了。

进草图 → 用直线工具点几下落点 → **点一下左侧坞的「选择」** → 单指拖动画面：线段（WebGL 层）跟着视图走，
而端点蓝点、尺寸标注、捕捉引导线（覆盖层 canvas）全部停在原屏幕位置，错位量等于平移量。

## 2. 根因：`mode` 被改成 `"select"`，而所有「是否在草图」的判断都写死 `mode === "sketch"`

草图坞的第一个按钮是 `data-act="select"`（`workspace-ui.js` 里 `sketch.primary = ["select","line","rect","circle","dim"]`），
它走的是**全局命令分发**（`main.js` 的 `[data-act]` onclick）：

```js
if (a === "select" || a === "pushpull") { setMode(a); ... }   // setMode 里无条件 mode = m
```

于是「在草图里点选择」把 `mode` 从 `"sketch"` 改成了 `"select"`。而下面的判断全部依赖 `mode === "sketch"`：

| 位置 | 后果 |
|---|---|
| `viewer.onFrame` 里的相机签名分支 | 相机变了也不重画覆盖层 → **蓝点/标注/引导线冻结**（用户看到的错位） |
| `drawSnapOverlay()` 开头 `if (mode !== "sketch") return` | 任何一次重画只清空不画 → 切工具后覆盖层变空白 |
| `viewer.cam.onDragStart` 的 `mode === "sketch"` | 草图里的拖动绘制、特征点拖动一起失灵 |

也就是说：**在草图里按一下「选择」，整个草图交互就退化成建模模式**，只剩相机平移还工作。

> 注：`sketch`（草图会话对象）始终非空，`mode` 与它不一致才是问题根源。`sketchTool` 才是"草图内工具"的正确载体。

## 3. 修复（`src/main.js`，3 处）

1. **草图内点「选择」不再改全局 mode**：只切 `sketchTool = "select"`，`mode` 保持 `"sketch"`，顺手点亮按钮高亮 + `redrawSketch()`。
2. `drawSnapOverlay()` 的守卫改成 `if (!sketch) return;` —— 覆盖层是否存在只取决于有没有草图会话。
3. `viewer.onFrame` 里的重画分支改成 `if (sketch && planarMode)` —— 与工具切换解耦。

## 4. 证据（真机 CDP，可调试构建，同一套断言）

探针：`<资料目录>`
（`device-repro.mjs` 造场景、`read-state.mjs` 读状态，判据 = 覆盖层上实际画出的蓝点像素位置 vs 按当前相机现算的端点位置）

| 状态 | `mode` | 覆盖层重画计数 | 蓝点最大偏差 | 判定 |
|---|---|---|---|---|
| 修复前 · 画完 4 点 | sketch | 23 | 0.7px | 正常 |
| 修复前 · **点「选择」+ 平移** | **select** | **冻结在 23** | **147.8px** | ★ bug 复现 |
| 修复前 · 再平移 | select | 23 | 22.4px | 错位随平移变化 |
| 修复后 · 点「选择」+ 平移 | sketch | 46 | **0.5px** | PASS |
| 修复后 · 再平移 | sketch | 73 | **0.5px** | PASS |

真机截图对照：`19-单指平移后.png`（线走了、蓝点+橙色引导线留在原地）vs `修复后-平移1/2.png`。

另：修复前切工具后再画第三段线，覆盖层会变成**全空白**（`drawSnapOverlay` 清空后直接 return 的那条路径）；
修复后不再出现。

## 5. 回归

- `node scripts/test.mjs` → **226 / 226**
- headless（1422×949 / dpr 2.25，真实触摸）：点坞「选择」后 `mode` 保持 `sketch`，蓝点跟随、`overlayRedraws` 1→13
- 真机：可调试包（5.1.6-dbg，vc70）通过后出正式包 5.1.6（vc71，调试关闭）

## 6. 遗留

- 其它仍以 `mode === "sketch"` 判定的分支（如 `snapAt`、`onDragStart`）本轮未改：修复 1 之后 `mode` 在草图里恒为 `"sketch"`，这些判断正确。
  但若将来又有入口在草图内改 `mode`，同类问题会复发 —— 新代码请统一用 `sketch`（会话）判断「是否在草图」，不要用 `mode`。
- 真机双指捏合缩放仍未自动化（`adb input` 不支持多点触控），本轮平移路径用单指/真实触摸覆盖。
