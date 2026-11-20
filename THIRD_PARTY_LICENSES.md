# 第三方组件与许可

本项目（PadCAD）自身代码以 **AGPL-3.0-or-later** 发布（见 LICENSE）；下面是它依赖/内嵌的第三方组件及其许可。

## 运行时依赖

| 组件 | 版本 | 许可 | 说明 |
|---|---|---|---|
| [replicad](https://github.com/sgenoud/replicad) | 1.1.0 | MIT | OCCT 的高层 JS 封装，几何 API 都从这里来 |
| [replicad-opencascadejs](https://github.com/sgenoud/replicad) | 1.1.0 | **LGPL-2.1-only** | OCCT 的 wasm 构建；`replicad_single.wasm`(22MB) 由它提供 |
| [OpenCASCADE Technology](https://dev.opencascade.org/) | 随上游 | **LGPL-2.1 + 例外条款** | 几何内核本体 |
| [three.js](https://threejs.org/) | r186 | MIT | WebGL 渲染 |
| [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | 0.9.x | MIT | 三角网格 BVH：大模型拾取与渲染筛选加速 |
| [@capacitor/core · android · filesystem](https://capacitorjs.com/) | 8.x | MIT | 打包成安卓应用、文件读写 |

## 开发依赖

| 组件 | 许可 |
|---|---|
| [vite](https://vite.dev/) | MIT |
| @capacitor/cli | MIT |

## LGPL 义务说明

- `replicad_single.wasm` **不随本仓库提交**，由 `npm install` 的 `postinstall` 从
  `node_modules/replicad-opencascadejs/dist/` 拷到 `public/`；仓库里只有源码，二进制从上游包获取。
- 如果你分发打包后的应用（APK 或静态站点），需要一并提供 OpenCASCADE / opencascade.js 的许可文本与
  获取对应源码的途径（上游仓库地址即可）。本文件即许可声明文本。
- 本项目的 AGPL-3.0 许可**不覆盖**这些第三方组件；它们的许可各自独立（LGPL-2.1 与 AGPL-3.0 兼容）。

## 致谢与参考

实现过程中参考了以下公开项目的**设计与规格**（未拷贝其代码）：

- [Chili3D](https://github.com/xiangechen/chili3d)（AGPL-3.0）——同技术栈的 CAD，界面与时间线交互作对照
- [JSketcher](https://github.com/xibyte/jsketcher)（MIT）——约束求解与拓扑 ID 传播的思路
- [SolidCraft](https://github.com/tangency-labs/solidcraft)（MIT / Apache-2.0）——UI 体系与时间线增量重建
- [solvespace](https://github.com/solvespace/solvespace)（GPL-3.0）/ [dune3d](https://github.com/dune3d/dune3d)（GPL-3.0）——仅作算法阅读，未引入任何代码
