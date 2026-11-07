---
name: padcad-modeling
description: 生成 PadCAD 建模脚本（JSON）并通过脚本面板 / __padcad.runScript 交给 PadCAD 执行，按返回的逐步几何报告迭代到成功且几何正确。
---

# PadCAD 建模脚本（AI 辅助建模）

工作目录是 PadCAD 仓库。产物是一份 **JSON 建模脚本**（`v:1`），交给 PadCAD 执行；
PadCAD 每跑一步都返回体积/包围盒/面数，可以据此判断「是执行成功」还是「几何也对」。

> 这份 skill 的结构与纪律参照 Yi3D（Apache-2.0）的 `skills/YI3D/SKILL.md`：
> 自然语言 → 脚本 → 内核执行 → **读回结果做几何校验** → 有界重试。
> 差别是 PadCAD 没有 Python/IPC，脚本就是纯数据 JSON，通道见下。

## 一、两条执行通道

> 界面侧已经开始为这些新特征接线（孔向导、布尔/分割/移动面/加厚、曲面四项的按钮正在并行开发），
> 但本 skill 只保证**脚本通道**的写法和数值；界面交互路径未经本次验收，别把下面的参数当成界面表单的字段名。

### A. 离线（推荐给平板用户）
1. 写一份 `*.json`（格式见 `docs/MODEL_SCRIPT_2026-09-30.md`，示例见 `samples/`）。
2. 把文件拷到平板 → PadCAD 顶栏「脚本」→「导入脚本…」→「运行（重建模型）」。
3. 面板报告区逐行给出每步的耗时/体积/面数/校验结果。

### B. 联机（Hermes / CDP 直接驱动，开发时用）
```js
window.__padcad.runScript(scriptObject, "replace")   // 或 "append"
window.__padcad.runScriptJSON(jsonText, "append")
// 返回 {ok, stepCount, checked, checksPassed, totalMs, volume, steps:[{index,label,ok,ms,volume,faces,check}], failed}
// ok=false 时返回 null，当前模型没有被改动
```
联机调试用 headless Edge + CDP（`npm run dev` 起 5173，浏览器开 `--remote-debugging-port=9333`），
参见仓库根的 `verify40_script.mjs`。

## 二、写脚本的硬规矩

1. **参数集中在开头**，`params` + `$名字` 引用；不要在步骤里散魔法数字。
   表达式支持 `+ - * / ^ ( )`、`$PI`、`$sqrt/$abs/$min/$max`；坐标数组里也能直接写算式。
2. **每步尽量写 `expect`**（至少关键尺寸那几步）。体积、包围盒、面数都能对账；
   体积默认相对容差 0.1%，扫掠类零件放宽到 0.2~0.3%。
3. `strict` 默认 `true`：校验不过就**中止且不动模型**。不要为了「让它跑完」而关掉 strict，
   先弄清是脚本写错了还是几何确实不对。
4. **不要凭记忆写 API**：先看 `docs/MODEL_SCRIPT_2026-09-30.md` 的 op 清单，再看 `samples/` 里最接近的例子。
5. 方向与位置语义（写错不会报错但全歪）：
   - `cylinder` 的 `at` 是**底面圆心**、`dir` 是轴向；`box` 的 `at` 是**底面中心**、`size = [宽(x), 深(y), 高(z)]`
   - `cone` 的 `r1` 在 `at` 端、`r2` 在 `dir` 侧 h 处（`r2: 0` 是真锥）
   - `helix` 的 `at` 是螺旋轴起点、`dir` 是轴方向；`R` 是中径半径，`wireR` 是钢丝半径（必须 `wireR < R`）
   - 挖料用 `mode: "cut"`，加料是默认；布尔刀具体要**真的与主体相交/穿透**，别只切一半
6. **阵列的源是「上一步新增的那份材料」，不含原件**。所以连续两次线性阵列是**累加**：
   原件 + 第1次副本 + 第2次副本。要排 N 个用**一次阵列 count=N**，别想着用两次阵列相乘。
   `source` 写的是**步骤下标**（从 0 开始）。
7. 选择器命中多个候选时 PadCAD 会**报错**，不会替你猜。写选择器时：
   - 面：给 `at`（参考点）+ `normal`（法向）+ 必要时 `type: "PLANE"/"CYLINDRE"`
   - 边：给 `dir`（直线边方向）、`closed: true`（孔口圆边）、`of`（限定在某个面上）、`all: true`（要一组）
   - 报「多个面/两条边同样符合」时，把 `at` 指到更明确的位置，或加 `dir`/`of`/`normal` 限定

## 三、常见零件的优先策略

| 零件 | 做法 |
|---|---|
| 板类（支架、盖板、法兰） | `primitive box/cylinder` 搭主体 → 刀具体 `mode: "cut"` 挖孔槽 → 一次阵列排孔 → `fillet` 选择器倒角 |
| 轴对称（轴套、垫圈、轮毂） | 优先 `primitive cylinder` + `cut`；带锥度的用 `cone`（`r1/r2/h`） |
| 弹簧/螺旋 | `helix`（`R/wireR/pitch/turns`）；要左旋 `clockwise: true`。体积期望用 `$PI*$wireR^2*$sqrt((2*$PI*$R)^2+$pitch^2)*$turns` |
| 圆环/卡箍 | `primitive torus`（`R` 环半径、`r` 管半径，`r < R`） |
| 球头/滚珠 | `primitive sphere` |
| 有草图轮廓的异形件 | `extrude`（`plane` 用 `{kind:"datum", name:"XY"/"XZ"/"YZ", origin, normal, xDir}` + 2D `entities`） |
| 回转体 | `revolve`（`angle`、`axisX` 是草图平面内的 2D 轴位置） |
| 需要被切掉的一块 | 先造刀具体（`primitive` 或 `extrude` + `mode:"cut"`），再阵列/镜像它 |

## 四、新特征的写法（孔 / 分割 / 布尔 / 加厚 / 曲面）

下面四段都是**可直接贴进脚本面板**的最小片段；参数单位一律 mm、角度是度。
完整的参数表与真实限制见 `docs/FEATURES_2026-11-04.md`，别凭记忆写字段名。

### 4.1 孔向导 `hole`（通孔 / 盲孔 / 沉头 / 埋头）

```json
{ "op": { "type": "hole", "kind": "counterbore",
          "at": [0, 0, "$T"], "normal": [0, 0, 1],
          "diameter": "$BOLT", "headDiameter": "$HEAD", "headDepth": "$HEAD_D" },
  "label": "Ø6 通孔 + Ø12×2 沉头",
  "expect": { "volume": "$L*$W*$T - $PI*($BOLT/2)^2*$T - $PI*(($HEAD/2)^2-($BOLT/2)^2)*$HEAD_D" } }
```

- `at` 是**孔口在面上的点**，`normal` 是那个面的**朝外**法向（写反会从背面起刀，盲孔必错）。
- `kind: "through"` 不用写深度；`"blind"` 用 `depth`（从面朝里量）；`"counterbore"` 用 `headDiameter`+`headDepth`；`"countersink"` 用 `headDiameter`+`angle`（默认 90°）。
- 沉头的体积减项是**圆环** `π((HEAD/2)²-(BOLT/2)²)·HEAD_D`，不是整圆——写成整圆会得到「差一点点」的错误断言。
- ⚠ `hole` **不检查孔是否落在材料里**，也不检查 `headDepth` 是否超过板厚：位置写错只会得到体积没变的模型，断言会替你抓住它。

### 4.2 平面分割 `split_plane`（只保留一侧）

```json
{ "op": { "type": "split_plane", "origin": [0, 0, 0], "normal": [1, 0, 0], "keep": "positive" },
  "label": "保留 x≥0 一半",
  "expect": { "volume": "$L*$W*$T/2" } }
```

- `origin` 是平面上任一点，`normal` 定朝向，`keep` 是 `positive`（法向那侧）或 `negative`。
- 语义是「保留侧半空间 ∩ 实体」，结果**只有一个实体**；不是把零件切成两片分别保留。
- ⚠ 平面没真正切开时**不报错**（整块都在保留侧 → 返回原体积）。要断言「确实切开了」，必须写体积 expect。

### 4.3 布尔 `combine`（并 / 差 / 交）

```json
{ "op": { "type": "combine", "mode": "cut",
          "tool": { "shape": "box", "size": [10, 10, 20], "at": [0, 0, -6] } },
  "label": "切一个 10×10 通槽",
  "expect": { "volume": "$L*$W*$T - 10*10*$T" } }
```

- `mode`：`fuse` / `cut` / `common`（别名 `union`/`add`、`subtract`/`difference`、`intersect`）。
- `tool` 只认基础形体（box/cylinder/sphere/cone/torus，朝向约定同 `primitive`）；**不能**拿前面某一步的实体当刀。
- 刀具体必须真的碰到材料：`cut`/`common` 无交集会直接报错（这点比 `hole` 严格）。

### 4.4 加厚 `thicken`（闭合空腔，不是抽壳）

```json
{ "op": { "type": "thicken", "thickness": "$WALL" },
  "label": "壁厚 2 闭合空腔",
  "expect": { "volume": "$L*$W*$T/2 - ($L/2-2*$WALL)*($W-2*$WALL)*($T-2*$WALL)" } }
```

- 几何定义是「**原实体 − 内缩 t 的实体**」，所以体积可以直接写成解析式：外形减去每个方向都缩 `2t`（两面各 t）的内腔。
- 上面这个体积公式对应 **4.2 分割后的那一半**（30×40×8）；若对整块 60×40×8 板直接加厚，写成 `$L*$W*$T - ($L-2*$WALL)*($W-2*$WALL)*($T-2*$WALL)`（= 11136）。
- 只有 `thickness` 一个参数，**没有「开口面」参数**——要开口请用 `shell`（`thickness` + `selector`/`faceRef`）。
- 约束：`t>0` 且 `2t` 小于零件最薄方向，否则报「两面内缩就会撞在一起」。

### 4.5 曲面四件套（要实体就再补一步加厚）

```json
[
  { "op": { "type": "surface_fill", "points": [[0, 0], ["$S", 0], ["$S", "$S"], [0, "$S"]] },
    "label": "补出 20×20 片体" },
  { "op": { "type": "surface_thicken", "thickness": "$TH" },
    "label": "片体加厚 3",
    "expect": { "volume": "$S*$S*$TH" } }
]
```
（这两步按顺序放进脚本的 `steps` 数组。）

- `surface_fill` 产出**片体**（体积 0），不能直接接 `thicken`；要实体接 `surface_thicken`，要缝合接 `surface_stitch`。
- `surface_offset` 的 `whole:true` 是近似路径（整圆柱实测 −1.09%）；要精确就对单张面用选面路线。
- 实体选面类 op（`offset_face`/`surface_offset`/`surface_thicken` 的实体分支）用 `face:{normal,at,geomType}` 指定面，选择器命中多张会报错。

### 4.6 哪些参数会导致明确报错

| 参数写法 | 会得到的报错 |
|---|---|
| `hole.kind` 不是四种之一 | `孔类型只能是 through / blind / counterbore / countersink` |
| `hole.headDiameter <= diameter` | `沉头直径必须大于孔径` / `埋头直径必须大于孔径` |
| `hole.angle` 不在 1°~179° | `埋头角度必须在 1°~179° 之间` |
| `hole.depth <= 0`（blind） | `盲孔深度必须大于 0` |
| `hole.normal` 是零向量 | `孔轴向不能是零向量` |
| `split_plane.keep` 写成别的 | `keep 只能是 "positive" 或 "negative"（收到 …）` |
| `split_plane.normal` 零向量 | `分割平面的法向不能是零向量（方向定不下来）` |
| 分割平面完全在零件外 | `这个位置切不到实体：平面过点 […]，保留 positive 侧没有材料` |
| `combine.mode` 写错 | `布尔模式只能是 fuse / cut / common（收到 …）` |
| `combine.tool` 缺省/不是对象 | `布尔运算需要一个工具体（op.tool 里要写 shape 与尺寸字段）` |
| `combine` 刀具体不沾边（cut/common） | `工具体与这个实体没有交集，切除不会去掉任何材料…` |
| `thicken.thickness <= 0` | `壁厚必须大于 0（收到 …）` |
| `thicken` 壁厚 ≥ 最薄方向一半 | `壁厚 5mm 太大：零件最薄方向只有 8.00mm，两面内缩就会撞在一起` |
| `offset_face.distance ≈ 0` | `移动距离太小（≈0），面不会移动；要删掉这一步请直接移除特征` |
| `offset_face` 指到曲面 | `找不到要移动的面：… 附近没有法向 […] 的平面面（曲面不能整体推拉，请改用其它特征）` |
| `surface_offset.distance = 0` | `偏移距离 distance不能是 0` |
| `surface_fill.points` 少于 3 个 | `补面轮廓至少要 3 个点` |
| `surface_stitch` 只有一片 | `缝合至少要两片，现在只有 N 片` |
| `surface_thicken` 面片多于一片却没给 `face` | `这片片体有 N 个面，请用 face 指定要加厚的那一面…` |
| 第一步就是这些「加工类」op | `<特征名>需要一个已有的实体（第一步不能是它）` |

## 五、失败分类与重试（上限 5 轮，每轮只改一个主要问题）

| 报错/现象 | 先查什么 |
|---|---|
| `参数「X」没有定义` | 拼写、是否写进了 `params`、是否循环引用 |
| `找不到符合条件的面/棱边` | 参考点是不是写在了零件外、法向/方向写反、该面上确实没有这种边 |
| `有多个面/两条边同样符合条件` | 选择器太宽松 → 加 `normal`/`type`/`dir`/`of`，或把 `at` 指到唯一位置 |
| `体积 实测 A，期望 B`（A 与 B 差不多但不对） | 先看差值是不是「少了一个孔/多了一个副本」→ 多半是阵列语义（见二.6） |
| 「校验不过」但几何明显对 | 看看期望公式本身：圆柱是 `$PI*$r^2*$h`，圆台是 `$PI*$h/3*($r1^2+$r1*$r2+$r2^2)`，圆角每个角 `($R^2-$PI*$R^2/4)` |
| 形体跑出来「在原点朝 +Z」 | `at`/`dir` 没给，或给成了 `[0,0,0]` |
| 相加之后体积比预期大很多 | 两个体**真的重叠**了 —— 挪开，或改成 `cut` |
| 结果看着对但尺寸不对 | `strict` 被关掉了；打开它，让内核替你判 |

## 六、交付前自检

1. 脚本跑完 `ok: true`，且**带 `expect` 的步骤全部 `check.ok`**。
2. 用 `npm test`（回归）与 `node verify41_samples.mjs`（示例）确认没把别的东西弄坏。
3. 报告里明确区分「脚本执行成功」和「几何语义正确」，并写清做了哪些校验。
4. 给用户的说明里带上：脚本文件路径、体积、特征顺序（特征树里会显示的名字）。
