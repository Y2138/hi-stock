import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/server/**/*.test.ts"],
    // tests/server 共享一个测试库（重置 schema + 迁移），需串行执行
    fileParallelism: false,
    environment: "node",
    coverage: { enabled: false },
  },
});
