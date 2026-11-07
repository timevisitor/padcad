import { defineConfig } from "vite";

export default defineConfig({
  // 相对路径：APK 里 WebView 用 capacitor:// 或 file:// 加载，
  // 绝对路径 "/assets/..." 会 404
  base: "./",
  server: {
    host: "0.0.0.0",   // 平板通过局域网访问
    port: 5173,
    strictPort: true,
  },
  optimizeDeps: {
    // OCCT 的 wasm glue 不能被打包器处理，必须原样加载
    exclude: ["replicad-opencascadejs"],
  },
  build: {
    target: "es2022",
    outDir: "dist",
    // APK 里 22MB 的 wasm 单独成文件，别让 Vite 内联或改名
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 3000,
  },
});
