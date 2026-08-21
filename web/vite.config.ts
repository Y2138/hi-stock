// web/ 独立 Vite 工程：构建产物输出 server/public/app/（gitignored，由 server 托管）
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v2.0.md §1.2 T2、§三
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [vue()],
  base: "/",
  build: {
    outDir: path.resolve(here, "..", "server", "public", "app"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
});
