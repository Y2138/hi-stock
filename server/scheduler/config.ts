import {
  type AnalysisJobConfig,
  type DatasourceJobConfig,
  type DatasourcePipeline,
  type JobType,
  type ValidatedJobConfig,
} from "./types.js";

function objectOf(value: unknown, field = "config"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function noUnknownKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`config 包含未知字段：${unknown.join(", ")}`);
}

const DATASOURCE_PIPELINES = new Set<DatasourcePipeline>([
  "daily_market_update",
  "market_catalog_sync",
  "board_membership_sync",
  "daily_market_structure",
]);

export function assertJobType(value: unknown): JobType {
  if (value !== "datasource" && value !== "analysis" && value !== "agent_flow") {
    throw new Error("job_type 必须是 datasource/analysis/agent_flow");
  }
  return value;
}

/** config 在 API 写入和 Runner 执行前各校验一次，不信任数据库中的历史 JSON。 */
export function validateJobConfig(jobType: JobType, input: unknown): ValidatedJobConfig {
  const config = objectOf(input);
  switch (jobType) {
    case "datasource": {
      noUnknownKeys(config, ["pipeline", "export_volume"]);
      if (!DATASOURCE_PIPELINES.has(config.pipeline as DatasourcePipeline)) {
        throw new Error("datasource config.pipeline 不在允许列表中");
      }
      if (config.export_volume !== undefined && typeof config.export_volume !== "boolean") {
        throw new Error("datasource config.export_volume 必须是布尔值");
      }
      return {
        pipeline: config.pipeline as DatasourcePipeline,
        export_volume: config.export_volume ?? config.pipeline === "daily_market_update",
      } satisfies DatasourceJobConfig;
    }
    case "analysis": {
      noUnknownKeys(config, ["analysis_type", "request"]);
      if (config.analysis_type !== "sector_temperature" && config.analysis_type !== "key_levels" && config.analysis_type !== "long_valuation") {
        throw new Error("analysis config.analysis_type 非法");
      }
      if (config.request !== undefined && (!config.request || typeof config.request !== "object" || Array.isArray(config.request))) {
        throw new Error("analysis config.request 必须是对象");
      }
      return { analysis_type: config.analysis_type, ...(config.request ? { request: config.request as AnalysisJobConfig["request"] } : {}) };
    }
    case "agent_flow": {
      // 兼容已保存的旧配置；readonly 不再改变定时 Agent 权限，也不向新工具输入暴露。
      noUnknownKeys(config, ["readonly", "pool_attention_write", "daily_plan_write"]);
      if (config.readonly !== undefined && config.readonly !== true) {
        throw new Error("agent_flow 旧 config.readonly 只能为 true");
      }
      if (config.pool_attention_write !== undefined && config.pool_attention_write !== true) {
        throw new Error("agent_flow config.pool_attention_write 只能为 true");
      }
      if (config.daily_plan_write !== undefined && config.daily_plan_write !== true) {
        throw new Error("agent_flow config.daily_plan_write 只能为 true");
      }
      return {
        ...(config.pool_attention_write ? { pool_attention_write: true as const } : {}),
        ...(config.daily_plan_write ? { daily_plan_write: true as const } : {}),
      };
    }
  }
}
