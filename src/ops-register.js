/**
 * 功能模块登记入口（replay.js 只 import 这一个文件）
 * 新增一批特征时：写一个模块 → 在里面 registerOp → 在这里 import 一行。
 * 三条并行的工作线各占一个文件，互不改对方的代码。
 */
import "./solid-features.js";   // C 批：分割 / 合并 / 拔模 / 加厚 / 移动面
import "./surface.js";          // D 批：偏置曲面 / 缝合 / 补面 / 曲面加厚
