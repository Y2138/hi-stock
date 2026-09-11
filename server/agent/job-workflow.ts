// 固定流程的完成门禁只认本次执行的工具事件，不认模型声明或历史会话中的成功记录。
import type { AgentCoreFrame } from "./core/loop.js";

const REQUIRED_READS: Record<string, readonly string[]> = {
  daily_plan_flow: ["strategy_document_query", "daily_plan_context_query", "swing_signal_query", "limit_up_signal_query"],
  midweek_check: ["strategy_document_query", "pool_context_query", "daily_plan_context_query"],
  weekly_review: ["strategy_document_query", "pool_context_query", "portfolio_context_query", "daily_plan_context_query", "swing_signal_query"],
  nightly_sector_opportunity_scan: [
    "strategy_document_query",
    "analysis_run",
    "board_query",
    "market_snapshot_query",
    "indicator_query",
    "strategy_screen_query",
    "stock_research_query",
  ],
};
const TARGET_DATE_TOOLS = new Set(["daily_plan_context_query", "swing_signal_query", "auction_context_query"]);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function createJobCompletionGate(jobCode: string, targetDate: string) {
  const calls = new Map<string, Record<string, unknown>>();
  const results = new Map<string, Record<string, unknown>>();
  const successfulArgs = new Map<string, Record<string, unknown>>();
  const fullPools = new Map<string, Record<string, unknown>>();
  return {
    observe(frame: AgentCoreFrame) {
      const name = String(frame.data.name);
      const id = String(frame.data.toolCallId);
      if (frame.type === "tool_start") calls.set(id, object(frame.data.args));
      if (frame.type !== "tool_end") return;
      const args = calls.get(id);
      calls.delete(id);
      if (!args || frame.data.isError || (TARGET_DATE_TOOLS.has(name) && args.date !== targetDate)) {
        results.delete(name);
        return;
      }
      const details = object(object(frame.data.result).details);
      if (details.status === "failed" || details.status === "error") results.delete(name);
      else {
        results.set(name, details);
        successfulArgs.set(name, args);
        if (name === "pool_context_query" && args.codes === undefined && Array.isArray(details.pools)) {
          for (const pool of details.pools) fullPools.set(String(object(pool).pool), object(pool));
        }
      }
    },
    missing(): string[] {
      const required = [...(Object.hasOwn(REQUIRED_READS, jobCode) ? REQUIRED_READS[jobCode]! : [])];
      if (jobCode === "daily_plan_flow") {
        required.push("pool_attention_write");
        const positions = object(results.get("daily_plan_context_query")?.positions);
        const signals = results.get("limit_up_signal_query")?.signals;
        if (Number(positions.position_count) > 0 || (Array.isArray(signals) && signals.length > 0)) {
          required.push("daily_plan_write");
        }
      }
      if (jobCode === "auction_opportunity_assessment") {
        required.push("auction_context_query");
        const context = results.get("auction_context_query");
        if (context && object(context.market_day).should_run !== false) {
          required.push("strategy_document_query");
          if (Array.isArray(context.candidate_codes) && context.candidate_codes.length > 0) required.push("fetch_hithink_data");
          if (Array.isArray(context.opportunities) && context.opportunities.length > 0) required.push("auction_assessment_write");
        }
      }
      if (jobCode === "weekly_review") {
        if (Number(fullPools.get("long")?.member_count) > 0) {
          required.push("analysis_run");
        }
      }
      const missing = required.filter((name) => !results.has(name));
      if (jobCode === "nightly_sector_opportunity_scan" && results.has("analysis_run")) {
        const items = results.get("analysis_run")?.items;
        const requests = successfulArgs.get("analysis_run")?.requests;
        const hasFullSectorScan = Array.isArray(items) && items.some((item) =>
          object(item).analysis_type === "sector_temperature"
          && ["success", "partial"].includes(String(object(item).status)),
        ) && Array.isArray(requests) && requests.some((request) => {
          const value = object(request);
          return value.analysis_type === "sector_temperature"
            && value.as_of === targetDate
            && value.codes === undefined;
        });
        if (!hasFullSectorScan) {
          missing.push("analysis_run（需要目标日完整 881 一级行业板块温度扫描或明确缺口）");
        }
      }
      const neededPools = jobCode === "weekly_review" ? ["short", "long"] : jobCode === "midweek_check" ? ["short"] : [];
      if (neededPools.some((pool) => !fullPools.has(pool))) {
        missing.push(`pool_context_query（需要 ${neededPools.join("、")} 池完整摘要，不能只查询部分代码）`);
      }
      if (jobCode === "daily_plan_flow" && results.has("daily_plan_write")) {
        const expected = object(results.get("daily_plan_context_query")?.positions).items;
        const submitted = successfulArgs.get("daily_plan_write")?.items;
        if (Array.isArray(expected) && Array.isArray(submitted)) {
          const held = new Set(expected.map((item) => object(item).code));
          const written = submitted.filter((item) => object(item).item_kind === "position_action");
          if (held.size !== written.length || written.some((item) => !held.has(object(item).code))) {
            missing.push("daily_plan_write（必须完整覆盖本次查询的真实持仓）");
          }
        }
      }
      if (jobCode === "weekly_review" && results.has("analysis_run")) {
        const items = results.get("analysis_run")?.items;
        if (!Array.isArray(items) || !items.some((item) => object(item).analysis_type === "long_valuation"
          && ["success", "partial"].includes(String(object(item).status)))) {
          missing.push("analysis_run（需要长线估值结果或明确缺口）");
        }
      }
      if (jobCode === "auction_opportunity_assessment" && results.has("auction_assessment_write")
        && object(results.get("fetch_hithink_data")?.summary).succeeded === 0) {
        const items = successfulArgs.get("auction_assessment_write")?.items;
        if (Array.isArray(items) && items.some((item) => object(item).conclusion !== "unavailable")) {
          missing.push("auction_assessment_write（竞价取数全部失败时只能回写数据不足）");
        }
      }
      return missing;
    },
  };
}
