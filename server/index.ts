// 服务入口：建池、迁移检查、起 HTTP
// 本机默认只绑定 127.0.0.1；容器内可绑定 0.0.0.0，但宿主端口仍只映射到 127.0.0.1。
import { loadConfig } from "./config.js";
import { closePool, getPool } from "./db/client.js";
import { MigrationConflictError, runMigrations } from "./db/migrate.js";
import { createApiServer } from "./http/router.js";
import { JobScheduler } from "./scheduler/service.js";
import { IndicatorWorker } from "./indicators/worker.js";
import { recoverInterruptedAgentSessions } from "./agent/session-runner.js";
import {
  cleanupAgentBacktestWorkspaces,
  failInterruptedAgentBacktests,
  isAgentBacktestWorkerEnabled,
} from "./backtest/agent-workspace.js";
import { importLegacyHithinkApiKey } from "./system-settings.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  const pool = getPool(config.databaseUrl);
  try {
    const result = await runMigrations(pool);
    if (result.applied.length > 0) {
      console.log(`启动时新应用迁移：[${result.applied.join(", ")}]`);
    }
  } catch (err) {
    if (err instanceof MigrationConflictError) {
      console.error(err.message);
    } else {
      console.error("数据库连接或迁移失败，请检查 DATABASE_URL 与本地 PostgreSQL 是否已启动");
      console.error((err as Error).message);
    }
    process.exitCode = 1;
    await closePool();
    return;
  }

  const legacyHithinkApiKey = process.env.HITHINK_FINANCE_API_KEY;
  delete process.env.HITHINK_FINANCE_API_KEY;
  if (await importLegacyHithinkApiKey(pool, legacyHithinkApiKey)) {
    console.log("已把旧 HITHINK_FINANCE_API_KEY 迁入系统设置；可从 .env.local 删除该项。");
  }

  try {
    const cleaned = await cleanupAgentBacktestWorkspaces();
    if (cleaned > 0) console.log(`已清理 ${cleaned} 个遗留 Agent 回测临时工作区。`);
    const interrupted = await failInterruptedAgentBacktests(pool);
    if (interrupted > 0) console.log(`已将 ${interrupted} 个重启中断的 Agent 回测标记为失败。`);
    const interruptedSessions = await recoverInterruptedAgentSessions(pool);
    if (interruptedSessions > 0) {
      console.log(`已将 ${interruptedSessions} 个重启中断的 Agent 会话标记为失败。`);
    }
  } catch (error) {
    console.error(`Agent 回测临时工作区启动清理失败：${(error as Error).message}`);
    process.exitCode = 1;
    await closePool();
    return;
  }

  const scheduler = new JobScheduler({
    pool,
    databaseUrl: config.databaseUrl,
  });
  const indicatorWorker = new IndicatorWorker(pool);
  const server = createApiServer({ pool });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("正在停止指标工作器和调度器，并等待当前任务安全退出…");
    await indicatorWorker.stop().catch((error) => {
      console.error(`指标工作器停止失败：${(error as Error).message}`);
      process.exitCode = 1;
    });
    await scheduler.stop().catch((error) => {
      console.error(`调度器停止失败：${(error as Error).message}`);
      process.exitCode = 1;
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      console.log(`Stock 策略演进系统服务已启动：http://${config.host}:${config.port}/（M3：资产工作台 + AI 对话 + 作业调度）`);
      console.log("服务无认证；仅允许通过宿主机 127.0.0.1 访问，请勿暴露到局域网或公网。");
      resolve();
    });
  });
  if (shuttingDown) return;
  try {
    await scheduler.start();
    indicatorWorker.start();
    console.log("作业调度器已启动：30 秒 tick，时区 Asia/Shanghai。");
    console.log("指标工作器已启动。");
    console.log("统一 Agent session 执行器已启用。");
    console.log(`Agent 临时代码回测工作器：${isAgentBacktestWorkerEnabled() ? "已启用" : "已关闭"}。`);
  } catch (error) {
    console.error(`作业调度器启动失败：${(error as Error).message}`);
    process.exitCode = 1;
    await shutdown();
  }
}

void main();
