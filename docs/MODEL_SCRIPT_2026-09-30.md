# 建模脚本（PadCAD Model Script）—— 2026-09-30

参考项目：[wangyao1052/Yi3D](https://github.com/wangyao1052/Yi3D)（Apache-2.0，OCCT + Qt/OSG 的桌面 CAD）。
本次把它的两块东西缝进了 PadCAD：**AI 辅助建模的流程**，以及**特征清单里缺的那几个形体**。
下面只写「实际落地了什么、怎么用、验过什么」，设计缘由写在每节开头。

---

## 一、脚本长什么样

脚本是**纯数据 JSON**（`.json`，不含任何 wasm 引用），可以直接存文件、发微信、让 AI 生成：

```json
{
  "v": 1,
  "name": "支架底板",
  "params": { "L": 120, "W": 80, "T": 10, "HOLE": 9, "SPACING": 30, "N": 3, "R": 6 },
  "steps": [
    { "op": { "type": "primitive", "shape": "box", "size": ["$L", "$W", "$T"] },
      "label": "底板", "expect": { "volume": "$L*$W*$T" } },
    { "op": { "type": "fillet", "radius": "$R", "selector": { "dir": [0, 0, 1], "all": true } },
      "label": "四角 R6" },
    { "op": { "type": "primitive", "shape": "cylinder", "r": "$HOLE/2", "h": "$T+20",
              "at": ["-($N-1)/2*$SPACING", 0, -10], "mode": "cut" },
      "label": "一个安装孔" },
    { "op": { "type": "pattern", "source": 2, "kind": "linear", "count": "$N",
              "direction": [1, 0, 0], "spacing": "$SPACING", "operation": "cut" },
      "label": "安装孔阵列",
      "expect": { "volume": "$L*$W*$T - 4*($R^2-$PI*$R^2/4)*$T - $N*$PI*($HOLE/2)^2*$T" } }
  ]
}
```

`steps[]` 的顺序就是特征树的顺序，`source` 指的是**步骤下标**（从 0 开始）。
`samples/` 里有三个可直接跑的示例：`01-法兰盘.json`、`02-压缩弹簧.json`、`03-支架底板.json`。

### 参数表达式

| 写法 | 说明 |
|---|---|
| `"$L"` `"$L*2-3"` | 以 `$` 开头的字符串是表达式，引用 `params` 里的参数 |
| `"$(...)"` | 支持 `+ - * / ^ ( )`、一元正负、幂右结合 |
| `"$PI"` `"$E"` | 内置常量 |
| `"$sqrt(x)"` `"$abs"` `"$min(a,b)"` `"$max"` | 内置函数 |
| `"-( $T+20 )/2"` | 非 `$` 开头但长成算式的字符串（数字/符号开头且含数字或 `$`）也会求值 —— 所以坐标里可以直接写算式 |
| `"$$L"` | 转义：字面量 `$L` |
| `"box"` `"XY"` `"凸台-拉伸"` | 名字类字符串原样保留，不会被当算式 |

参数值本身也可以是表达式（`"SW": "$L/2"`）；循环引用会报错并指出链路。
**参数集中写在开头**，是照 Yi3D 的 SKILL.md 抄的纪律 —— 平板上改一个数就能重跑整份脚本。

---

## 二、操作（op）清单

| type | 关键字段 | 说明 |
|---|---|---|
| `primitive` | `shape: box/cylinder/sphere/cone/torus` + 尺寸 + `at` `dir` `mode: add/cut` | 基础形体（新增） |
| `helix` | `R` `wireR` `pitch` `turns` `at` `dir` `clockwise` `startAngle` | 螺旋/弹簧（新增） |
| `pushface` | `selector` + `dist` | 按几何选择器推拉（新增，脚本友好） |
| `pushpull` | `faceRef` + `dist`（或同样接受 `selector`） | 交互点选的推拉 |
| `extrude` | `plane` + `entities` + `depth` `selected` `constraints` | 草图拉伸（与 UI 同一套定义） |
| `revolve` | `plane` + `entities` + `angle` `axisX` | 旋转 |
| `sweep` | `plane` + `entities`(截面+路径) + `length` | 沿草图法向扫掠 |
| `loft` | `plane` + `entities`(≥2 截面) | 放样 |
| `fillet` / `chamfer` | `radius` + `edgeRefs`（点选）**或** `selector`（脚本） | 圆角/倒角 |
| `shell` | `thickness` + `faceRef` **或** `selector` | 抽壳 |
| `pattern` | `source` `kind: linear/circular` `count` `direction`/`spacing`、`axisPoint`/`axisDir`/`angle` `operation: fuse/cut` | 阵列 |
| `mirror` | `source` `plane: XY/XZ/YZ` `at` `operation` | 镜像 |
| `move3d` | `dx` `dy` `dz` `rot` `axis` `pivot` | 整体移动/旋转 |
| `base` | — | 60×40×8 带孔起始零件 |

形体朝向约定：`cylinder` 的 `at` 是**底面圆心**、`dir` 是轴向；`box` 的 `at` 是**底面中心**、`size` 是 `[宽(x), 深(y), 高(z)]`；`cone` 的 `r1` 在 `at` 端、`r2` 在 `dir` 方向 h 处（`r2: 0` 就是真锥）。

### 几何选择器（脚本不用记点选的引用）

```json
{ "at": [0, 0, 12], "normal": [0, 0, 1], "type": "PLANE", "uniqueTol": 0.25 }   // 面
{ "dir": [0, 0, 1], "all": true }                                              // 全部竖直边
{ "at": [-20, -15, 5], "dir": [0, 0, 1] }                                      // 最近的竖直边
{ "closed": true, "all": true, "of": { "at": [0, 0, 0], "type": "CYLINDRE" } }  // 某个圆柱面上的孔口圆边
```

面选择器排序是**两级**：先「沿法向的垂距」定位高度（这是踩过的坑：只按到面中心的距离，
大零件上会挑到隔壁那个面），再在**同一高度**的候选里用「面内距离」定位位置
（共面被切开的多个面只有靠这一步才能区分）。两级都不唯一就报错。
边选择器的 `of` 用的是内核算的 `DistanceQuery` 真实距离，不是 uv 外推。

---

## 三、每步都能做几何校验（这条最值钱）

Yi3D 的 SKILL.md 里写得很清楚：**脚本执行成功 ≠ 几何正确**（你的齿轮可能执行成功但齿槽切反了）。
所以每一步可以写 `expect`：

```json
"expect": { "volume": "$L*$W*$T", "tol": 1e-3, "bbox": [120, 80, 10], "bboxTol": 0.1, "faces": 6 }
```

- 体积：相对容差，默认 `1e-3`（0.1%）
- 包围盒：每轴绝对容差，默认 0.1mm（扫掠体有离散误差）
- 面数：精确比较

`schema` 顶层还有 `"strict": true`（默认）：

| strict | 校验不过时 |
|---|---|
| `true`（默认） | **中止，且不动当前模型**，报告里写明第几步、哪一项、实测值 vs 期望值 |
| `false` | 只标红警告，继续跑完 |

解析失败、某步失败（找不到面/边、布尔失败）同样**不动当前模型** —— 一进一出都是
「整份脚本跑通 + 校验通过」才替换文档。

---

## 四、入口

| 入口 | 用途 |
|---|---|
| 工具栏 **「脚本」** | 打开面板：粘贴 JSON → 「运行（重建模型）」/「追加到当前模型」/「撤销本次运行」 |
| 面板「示例」 | 载入模板（底板+锥台+推拉+圆角+弹簧） |
| 面板「导入脚本…」 | 选 `.json` 文件载入文本框 |
| 面板「当前模型→脚本」 | 把当前特征树转成脚本文本（可读的往返，适合当 AI 改写的起点） |
| `window.__padcad.runScript(script, "replace"\|"append")` | 外部工具（Hermes / CDP / 测试）直接驱动，返回逐步报告 |
| `window.__padcad.runScriptJSON(text, mode)` | 同上，收字符串 |

返回的摘要形如：

```json
{ "ok": true, "stepCount": 4, "checked": 2, "checksPassed": 2, "totalMs": 344.3,
  "volume": 33708.990552,
  "steps": [ { "index": 0, "label": "底板", "ok": true, "ms": 12.1, "volume": 19200, "faces": 6,
               "check": { "ok": true, "items": [ ... ] } }, ... ] }
```

`runScript` 失败时返回 `null`，面板上写出失败步骤与原因（当前模型不受影响）。

---

## 五、和工程文件（`.padcad.json`）的区别

| | 工程文件 | 建模脚本 |
|---|---|---|
| 记录什么 | 交互操作（点哪个面、选了哪条边，带 `faceRef`/`edgeRef` 快照） | 几何意图（`selector`：在某点附近、法向朝上的那个面） |
| 上游改动后 | 按几何特征匹配找回引用，找不到就明确拒绝 | 每次重放都重新按几何解析，尺寸改了也照样跟上 |
| 用途 | 保存/打开工作进度 | AI 生成、批量出图、参数化模板 |

两者共用同一套 `op` 定义与重放引擎（`src/replay.js`），所以脚本产出的特征
可以继续在特征树里编辑、压制、删除，也能再次导出成工程文件。

---

## 六、本次新增的实现（对照 Yi3D 借了什么）

| 借来的点 | 落地 |
|---|---|
| **AI 辅助建模流程**（自然语言 → 脚本 → 内核 → 读回校验 → 迭代） | `src/model-script.js` + 脚本面板 + `__padcad.runScript` + `skills/padcad-modeling/SKILL.md` |
| **基础形体清单** Box/Cylinder/Sphere/Cone/Torus | `src/primitives.js`，体积逐个对账解析公式（误差 0 ~ 4e-16） |
| **螺旋（弹簧）**（它的 `helix.py` / `samples/spring.py`） | `helixSolid()`：截面平面法向取**内核给的起点切向**（`helix.tangentAt(0)`），不手算 |
| **几何选择器代替点选** | `src/selectors.js`：面/边的意图式选择，多候选明确报错 |
| **「成功 ≠ 正确」的验收纪律** | 每步 `expect` + 严格模式 + 回归测试里全部用体积/公式对账 |
| 未借（本轮） | 拔模（`BRepOffsetAPI_DraftAngle` 在绑定里存在，但 API 复杂，先不动）、DXF 草图导入导出、6 种基准面构造（平行/垂直/角度/过三点）、拓扑命名传播 |

### 内核踩坑（都实测过，别再试错）

1. **`BRepPrimAPI_MakeCone` 不在这个 wasm 绑定里**（`oc.BRepPrimAPI_MakeCone is not a constructor`）。
   圆台/圆锥走「平面轮廓 + `BRepPrimAPI_MakeRevol`」：`makePolygon(pts)` 返回的**已经是 Face**，
   直接喂给 `MakeRevol`。实测与 `πh(r₁²+r₁r₂+r₂²)/3` 完全吻合。
2. **`sketch.revolve()` 对同一轮廓给出体积 0、包围盒扁平的结果**（实测），别用它做回转体。
   另一条可行路径是「两个平行面上的圆 + `loft`」，体积也精确（误差 8e-6）。
3. `makeBaseBox(w,d,h)` 是**底面在 z=0、XY 居中**；`makeCylinder(r,h,loc,dir)` 的 `loc` 是**底面圆心**。
4. `makeHelix(pitch, height, radius, center, dir, lefthand)` 返回 Wire；
   `helix.tangentAt(0)` 给起点切向 —— 左右旋向不同，手算符号很容易写反。
5. 弹簧的体积对账用 `π·wireR²·螺旋线长`（斜边展开），实测相对误差 6e-7（扫掠离散）。
6. **阵列的源是「上一步新增的那份材料」，不含原件** —— 所以链式线性阵列是**累加**不是乘法。
   写「2×2 四角孔」不能靠两次阵列串起来（会得到 3 个孔），要用一个阵列 + 正确的间距/数量。
7. 面板颜色必须走主题变量。第一版把深色主题的硬编码色搬进新面板，浅色主题下变成
   「深底深字」，按钮文字几乎看不见 —— 截图一眼就露馅。输入框用 `var(--bg)` 做内凹，
   两个主题都成立。

---

## 七、验证

| 手段 | 结果 |
|---|---|
| `npm test`（统一回归，真实 OCCT） | **206/206 通过**（新增 15 项：表达式/选择器/形体/螺旋/校验纪律/重放往返） |
| `node verify41_samples.mjs` | `samples/` 三个示例全通过，体积校验 3/3 |
| `node verify40_script.mjs`（真浏览器 + 真 wasm + 真点击） | **24/24 通过**，含「校验不过不许动模型」「撤销本次运行」「导出→重跑体积一致」 |
| 独立复算 | 脚本总体积 33708.990552 vs 解析式 33708.996（相对 1.6e-7，差在弹簧扫掠） |

回归与示例都把**结论落在数值**上：体积 vs 解析公式、包围盒、面数，不看截图、不信「跑成功了」。
