// Agent 最小遥测：只保存 token、成本、时延、状态和 UTF-8 大小，不保存任何正文。
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type pg from "pg";
import { estimateContextTokens } from "./context-compaction.js";
import type { AgentCoreFrame } from "./core/loop.js";

type RunMetricStatus = "complete" | "failed" | "cancelled" | "blocked";
type ToolMetricStatus = "ok" | "error" | "blocked" | "cancelled";

interface ToolState {
  startedAt: number;
  sequence: number;
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
}

function warnTelemetry(action: string, error: unknown): void {
  console.warn(`[agent-metrics] ${action}失败，已忽略：${(error as Error).message}`);
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}

function resultRows(value: unknown, depth = 0): number | null {
  if (depth > 3) return null;
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["rows", "items", "quotes", "constituents", "values", "tables", "queries"]) {
    if (Array.isArray(record[key])) return record[key].length;
  }
  for (const key of ["row_count", "total_rows"]) {
    if (typeof record[key] === "number" && Number.isSafeInteger(record[key]) && record[key] >= 0) {
      return record[key];
    }
  }
  return resultRows(record.details, depth + 1);
}

function resultWasTruncated(value: unknown): boolean {
  try {
    const text = JSON.stringify(value) ?? "";
    return text.includes("[截断]") || text.includes("结果过长已截断") || text.includes('"truncated":true');
  } catch {
    return false;
  }
}

function sumUsage(messages: AgentMessage[]): UsageTotals {
  const total: UsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cost: 0,
  };
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    total.input += Math.max(0, message.usage.input ?? 0);
    total.output += Math.max(0, message.usage.output ?? 0);
    total.cacheRead += Math.max(0, message.usage.cacheRead ?? 0);
    total.cacheWrite += Math.max(0, message.usage.cacheWrite ?? 0);
    total.reasoning += Math.max(0, message.usage.reasoning ?? 0);
    total.cost += Math.max(0, message.usage.cost?.total ?? 0);
  }
  return total;
}

/** 单轮记录器；所有数据库失败都只告警，绝不改变 Agent 主流程。 */
export class AgentRunMetricRecorder {
  private readonly toolStates = new Map<string, ToolState>();
  private writes = Promise.resolve();
  private sequence = 0;
  private firstTextMs: number | null = null;

  private constructor(
    private readonly pool: pg.Pool,
    private readonly metricId: string | null,
    private readonly startedAt: number,
  ) {}

  static async start(input: {
    pool: pg.Pool;
    runKey: string;
    sessionId: string;
    modelId: string | null;
    systemPrompt: string;
    historyMessages: AgentMessage[];
    tools: AgentTool[];
    compacted: boolean;
  }): Promise<AgentRunMetricRecorder> {
    const startedAt = Date.now();
    try {
      const result = await input.pool.query<{ id: string }>(
        `INSERT INTO agent_run_metric
           (run_key, session_id, model_id, estimated_system_tokens,
            estimated_history_tokens, estimated_tool_definition_tokens,
            compaction_count, status, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', to_timestamp($8 / 1000.0))
         RETURNING id::text`,
        [
          input.runKey,
          input.sessionId,
          input.modelId,
          estimateContextTokens(input.systemPrompt),
          estimateContextTokens(input.historyMessages),
          estimateContextTokens(input.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          }))),
          input.compacted ? 1 : 0,
          startedAt,
        ],
      );
      return new AgentRunMetricRecorder(input.pool, result.rows[0]?.id ?? null, startedAt);
    } catch (error) {
      warnTelemetry("创建运行记录", error);
      return new AgentRunMetricRecorder(input.pool, null, startedAt);
    }
  }

  observeFrame(frame: AgentCoreFrame): void {
    const observedAt = Date.now();
    if (frame.type === "text" && this.firstTextMs === null && String(frame.data.delta ?? "").length > 0) {
      this.firstTextMs = Math.max(0, observedAt - this.startedAt);
    }
    if (!this.metricId) return;

    if (frame.type === "tool_start") {
      const toolCallId = String(frame.data.toolCallId ?? "unknown");
      const toolName = String(frame.data.name ?? "unknown").slice(0, 200);
      this.sequence += 1;
      this.toolStates.set(toolCallId, { startedAt: observedAt, sequence: this.sequence });
      const argsBytes = jsonBytes(frame.data.args);
      this.schedule("创建工具记录", () => this.pool.query(
        `INSERT INTO agent_tool_metric
           (run_metric_id, tool_call_id, tool_name, sequence_no, status, args_bytes, started_at)
         VALUES ($1, $2, $3, $4, 'running', $5, to_timestamp($6 / 1000.0))
         ON CONFLICT (run_metric_id, tool_call_id) DO NOTHING`,
        [this.metricId, toolCallId, toolName, this.sequence, argsBytes, observedAt],
      ));
      return;
    }

    if (frame.type === "tool_end") {
      const toolCallId = String(frame.data.toolCallId ?? "unknown");
      const state = this.toolStates.get(toolCallId);
      const status: ToolMetricStatus = frame.data.isError ? "error" : "ok";
      const result = frame.data.result;
      this.schedule("完成工具记录", () => this.pool.query(
        `UPDATE agent_tool_metric
            SET duration_ms=$3, status=$4, result_bytes=$5, result_rows=$6,
                truncated=$7, finished_at=to_timestamp($8 / 1000.0)
          WHERE run_metric_id=$1 AND tool_call_id=$2`,
        [
          this.metricId,
          toolCallId,
          Math.max(0, observedAt - (state?.startedAt ?? observedAt)),
          status,
          jsonBytes(result),
          resultRows(result),
          resultWasTruncated(result),
          observedAt,
        ],
      ));
      this.toolStates.delete(toolCallId);
    }
  }

  async finish(status: RunMetricStatus, freshMessages: AgentMessage[] = []): Promise<void> {
    if (!this.metricId) return;
    const finishedAt = Date.now();
    const unfinishedStatus: ToolMetricStatus = status === "cancelled" ? "cancelled" : "error";
    this.schedule("关闭未完成工具记录", () => this.pool.query(
      `UPDATE agent_tool_metric
          SET status=$2, duration_ms=COALESCE(duration_ms, GREATEST(0, $3 - EXTRACT(EPOCH FROM started_at) * 1000)::int),
              finished_at=COALESCE(finished_at, to_timestamp($3 / 1000.0))
        WHERE run_metric_id=$1 AND status='running'`,
      [this.metricId, unfinishedStatus, finishedAt],
    ));
    await this.writes;
    const usage = sumUsage(freshMessages);
    try {
      await this.pool.query(
        `UPDATE agent_run_metric SET
           input_tokens=$2, output_tokens=$3, cache_read_tokens=$4, cache_write_tokens=$5,
           reasoning_tokens=$6, cost_amount=$7, first_text_ms=$8, total_ms=$9,
           status=$10, finished_at=to_timestamp($11 / 1000.0)
         WHERE id=$1`,
        [
          this.metricId,
          usage.input,
          usage.output,
          usage.cacheRead,
          usage.cacheWrite,
          usage.reasoning,
          usage.cost,
          this.firstTextMs,
          Math.max(0, finishedAt - this.startedAt),
          status,
          finishedAt,
        ],
      );
    } catch (error) {
      warnTelemetry("完成运行记录", error);
    }
  }

  private schedule(action: string, operation: () => Promise<unknown>): void {
    this.writes = this.writes.then(async () => {
      try {
        await operation();
      } catch (error) {
        warnTelemetry(action, error);
      }
    });
  }
}

export interface AgentMetricSummary {
  range: { from: string | null; to: string | null; model_id: string | null };
  runs: {
    total: number;
    status: Record<string, number>;
    average_tool_calls: number;
  };
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    reasoning: number;
  };
  cost_amount: number;
  latency_ms: {
    first_text_average: number | null;
    first_text_p95: number | null;
    total_average: number | null;
    total_p95: number | null;
  };
  tools: {
    total: number;
    average_duration_ms: number | null;
    status: Record<string, number>;
  };
}

export async function getAgentMetricSummary(
  pool: pg.Pool,
  filter: { from: string | null; to: string | null; modelId: string | null },
): Promise<AgentMetricSummary> {
  const params = [filter.from, filter.to, filter.modelId];
  const where = `($1::timestamptz IS NULL OR started_at >= $1::timestamptz)
    AND ($2::timestamptz IS NULL OR started_at <= $2::timestamptz)
    AND ($3::bigint IS NULL OR model_id = $3::bigint)`;
  const [run, runStatuses, tool, toolStatuses] = await Promise.all([
    pool.query<{
      total: number;
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
      reasoning: number;
      cost: number;
      first_text_average: number | null;
      first_text_p95: number | null;
      total_average: number | null;
      total_p95: number | null;
      average_tool_calls: number;
    }>(
      `WITH filtered AS (SELECT * FROM agent_run_metric WHERE ${where}),
       tool_counts AS (
         SELECT f.id, COUNT(t.id)::float8 AS calls
           FROM filtered f LEFT JOIN agent_tool_metric t ON t.run_metric_id=f.id
          GROUP BY f.id
       )
       SELECT COUNT(*)::float8 AS total,
              COALESCE(SUM(input_tokens),0)::float8 AS input,
              COALESCE(SUM(output_tokens),0)::float8 AS output,
              COALESCE(SUM(cache_read_tokens),0)::float8 AS cache_read,
              COALESCE(SUM(cache_write_tokens),0)::float8 AS cache_write,
              COALESCE(SUM(reasoning_tokens),0)::float8 AS reasoning,
              COALESCE(SUM(cost_amount),0)::float8 AS cost,
              AVG(first_text_ms)::float8 AS first_text_average,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY first_text_ms)::float8 AS first_text_p95,
              AVG(total_ms)::float8 AS total_average,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms)::float8 AS total_p95,
              COALESCE((SELECT AVG(calls) FROM tool_counts),0)::float8 AS average_tool_calls
         FROM filtered`,
      params,
    ),
    pool.query<{ status: string; count: number }>(
      `SELECT status, COUNT(*)::int AS count FROM agent_run_metric
        WHERE ${where} GROUP BY status ORDER BY status`,
      params,
    ),
    pool.query<{ total: number; average_duration_ms: number | null }>(
      `SELECT COUNT(t.*)::float8 AS total, AVG(t.duration_ms)::float8 AS average_duration_ms
         FROM agent_tool_metric t JOIN agent_run_metric r ON r.id=t.run_metric_id
        WHERE ($1::timestamptz IS NULL OR r.started_at >= $1::timestamptz)
          AND ($2::timestamptz IS NULL OR r.started_at <= $2::timestamptz)
          AND ($3::bigint IS NULL OR r.model_id = $3::bigint)`,
      params,
    ),
    pool.query<{ status: string; count: number }>(
      `SELECT t.status, COUNT(*)::int AS count
         FROM agent_tool_metric t JOIN agent_run_metric r ON r.id=t.run_metric_id
        WHERE ($1::timestamptz IS NULL OR r.started_at >= $1::timestamptz)
          AND ($2::timestamptz IS NULL OR r.started_at <= $2::timestamptz)
          AND ($3::bigint IS NULL OR r.model_id = $3::bigint)
        GROUP BY t.status ORDER BY t.status`,
      params,
    ),
  ]);
  const values = run.rows[0]!;
  return {
    range: { from: filter.from, to: filter.to, model_id: filter.modelId },
    runs: {
      total: Number(values.total),
      status: Object.fromEntries(runStatuses.rows.map((row) => [row.status, Number(row.count)])),
      average_tool_calls: Number(values.average_tool_calls),
    },
    tokens: {
      input: Number(values.input),
      output: Number(values.output),
      cache_read: Number(values.cache_read),
      cache_write: Number(values.cache_write),
      reasoning: Number(values.reasoning),
    },
    cost_amount: Number(values.cost),
    latency_ms: {
      first_text_average: values.first_text_average === null ? null : Number(values.first_text_average),
      first_text_p95: values.first_text_p95 === null ? null : Number(values.first_text_p95),
      total_average: values.total_average === null ? null : Number(values.total_average),
      total_p95: values.total_p95 === null ? null : Number(values.total_p95),
    },
    tools: {
      total: Number(tool.rows[0]!.total),
      average_duration_ms: tool.rows[0]!.average_duration_ms === null
        ? null
        : Number(tool.rows[0]!.average_duration_ms),
      status: Object.fromEntries(toolStatuses.rows.map((row) => [row.status, Number(row.count)])),
    },
  };
}
