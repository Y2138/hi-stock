// 服务端配置：读取 DATABASE_URL / PORT，只加载仓库根目录的 .env.local
// 设计契约：docs/design/Stock_策略演进系统_技术设计_v1.0.md §2、§八
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根目录（server/ 的上一级） */
export const PROJECT_ROOT = path.resolve(here, "..");
// 运行连接串只放在 gitignored 的 .env.local；datasource/LLM 凭据统一存 PostgreSQL。
dotenv.config({ path: path.join(PROJECT_ROOT, ".env.local"), quiet: true });

export interface ServerConfig {
  databaseUrl: string;
  host: "127.0.0.1" | "0.0.0.0";
  port: number;
}

/** 读取运行配置；缺少 DATABASE_URL 时抛错，由入口打印检查提示 */
export function loadConfig(): ServerConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "缺少 DATABASE_URL：请复制 .env.local.example 为 .env.local 并填写本机连接串",
    );
  }
  const port = Number(process.env.PORT ?? "8787");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT 非法：${process.env.PORT}`);
  }
  const host = process.env.SERVER_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "0.0.0.0") {
    throw new Error(`SERVER_HOST 非法：${host}`);
  }
  return { databaseUrl, host, port };
}

/**
 * 解析测试库连接串：优先 TEST_DATABASE_URL，缺省时由 DATABASE_URL 派生（库名加 _test 后缀）。
 * 无配置时返回 null，测试据此 skip。
 */
export function resolveTestDatabaseUrl(): string | null {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const base = process.env.DATABASE_URL;
  if (!base) return null;
  try {
    const url = new URL(base);
    const dbName = url.pathname.replace(/^\//, "");
    if (!dbName) return null;
    url.pathname = `/${dbName}_test`;
    return url.toString();
  } catch {
    return null;
  }
}
