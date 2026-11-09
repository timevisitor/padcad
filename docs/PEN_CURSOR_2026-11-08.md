# 触控笔悬停虚拟光标（PadCAD 5.1.7）

日期：2026-11-08　版本：5.1.7（versionCode 72）

## 需求

> 使用笔的时候，非点击的状态下可以出现一个虚拟光标来展示当前的位置。

即电磁笔**悬停**（笔尖离屏、未落下）时的落点指示。

## 原理

电磁笔悬停在屏幕上时，Chromium 会派发 `pointermove`，其特征是
`buttons === 0`（没有按下的按钮）且 `pointerType === "pen"`。
触摸屏的手指事件始终是 `buttons === 1`，鼠标有浏览器原生指针 —— 两者都不参与。

## 实现

新模块 `src/pen-cursor.js`（约 200 行，独立于 3D 视口与草图逻辑）：

- 光标元件 `#penCursor`：SVG 圆环（r=8.5）+ 四段十字（内端留 4.2px 空隙）+ 中心实心点，
  尺寸 34×34，`margin: -17px` 让元件中心落在笔尖坐标上。
- 定位：`position: fixed` + `translate3d(x, y, 0)`，用 `requestAnimationFrame` 合并高频 move
  （悬停事件可达 120Hz，不合并会每事件触发一次样式写）。
- `pointer-events: none` + `z-index: 200`：不参与命中测试，压在所有浮层之上。
- 颜色取主题 `--accent`（砖红 #bf5634），描边加白色 `drop-shadow` 保证深色模型上也可见。

### 显示 / 隐藏规则

| 输入 | 行为 |
|---|---|
| 笔悬停移动（`buttons === 0`，非 touch/mouse） | 显示并跟随 |
| 笔落笔（`buttons !== 0`） | 立即隐藏，不遮挡落点 |
| 落笔中移动 | 保持隐藏 |
| 手指触摸 | 完全不触发（`pointerType === "touch"` 直接返回） |
| 鼠标 | 不画假光标（浏览器原生指针已在） |
| 笔离开屏幕（`pointerout` + `relatedTarget` 为空） | 隐藏 |
| 1.5s 无任何悬停事件 | 兜底隐藏（安卓 HOVER_EXIT 不一定转成 DOM 事件） |

### 判定为什么不写死 `pointerType === "pen"`

项目里 `isPrecisionPointer()` 已经把**空 pointerType** 当精细输入 —— 说明有设备的笔不上报类型。
所以判定放宽成「`buttons === 0` 且不是 touch、不是 mouse」：手指必然 `buttons === 1`，
鼠标有自己的指针，误伤面为零，同时兼容上报不规范的笔。

## 验证

### headless（合成 PointerEvent，验模块逻辑）

`node tools/verify-pen-cursor.mjs` → **16/16 PASS**：

存在 / 初始不可见 / `pointer-events:none` / `z-index:200` / 34×34 / 悬停显示 /
跟随 (400,300) → (812,645) / 落笔隐藏 / 落笔中移动仍隐藏 / 手指不触发 /
鼠标不触发 / 离屏隐藏 / 1.5s 超时隐藏 / hover 计数累加 / 无未捕获异常。

截图：`headless-光标.png`（放大后圆环与十字对称、中心点在圆心，浅底对比清晰）。

### 真机自检（**必须真笔**，adb 无法模拟悬停）

远程调试或 `chrome://inspect` 连上 WebView 后执行：

```js
window.__padcad.penCursor.stats()
// { hover: N, down: N, up: N, exit: N, touchMoves: N, lastPointerType: "pen", visible: true }
```

- `hover` **在涨** 且屏幕出现光标 → 功能正常。
- `hover` **一直为 0** → 系统没把笔的悬停派发给 WebView（设备/笔不支持，或 WebView 拦截
  `ACTION_HOVER_MOVE`）。此时纯前端无解，需要原生层（Capacitor 插件）拦 `MotionEvent.ACTION_HOVER_MOVE`
  再 `evaluateJavascript` 转发。
- `hover` 在涨但**没有光标** → 本模块样式/层级问题，查 `#penCursor` 的 computed style。

## 回归

`node scripts/test.mjs` → **226 / 226**。新模块不接入任何绘制路径，只读事件坐标。

## 已知限制

- 光标是**屏幕坐标**跟随，不做捕捉吸附高亮（悬停靠近端点/中点时不会变色）。
  需要的话下一步可以接 `SnapEngine` 做悬停预选。
- 不显示 mm 坐标数值。
- 笔按下时直接隐藏（而不是变成「按下态」小圈）：笔尖本身就是精确位置，光标留着反而挡落点。
