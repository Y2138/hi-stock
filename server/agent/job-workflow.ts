// 固定流程的完成门禁只认本次执行的工具事件，不认模型声明或历史会话中的成功记录。
import type { AgentCoreFrame } from "./core/loop.js";

const REQUIRED_READS: Record<string, readonly string[]> = {
  daily_plan_flow: ["strategy_document_query", "daily_plan_strategy_query"],
  copper_inventory_signal_review: ["strategy_document_query", "copper_inventory_signal_query"],
  lithium_warehouse_signal_review: ["strategy_document_query", "lithium_warehouse_signal_query"],
  value_anchor_opportunity_scan: ["strategy_document_query", "value_anchor_signal_query"],
  two_year_reversal_scan: ["strategy_document_query", "two_year_reversal_signal_query"],
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
const TARGET_DATE_TOOLS = new Set([
  "daily_plan_strategy_query", "daily_plan_context_query", "swing_signal_query", "auction_context_query", "copper_inventory_signal_query", "lithium_warehouse_signal_query",
  "value_anchor_signal_query", "two_year_reversal_signal_query", "strategy_evaluation_query",
]);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function createJobCompletionGate(jobCode: string, targetDate: string) {
  const calls = new Map<string, Record<string, unknown>>();
  const results = new Map<string, Record<string, unknown>>();
  const successfulArgs = new Map<string, Record<string, unknown>>();
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
      }
    },
    unavailableGaps(): unknown[] {
      const signal = results.get("two_year_reversal_signal_query");
      return jobCode === "two_year_reversal_scan" && signal
        && (signal.status === "unavailable" || signal.data_date !== targetDate) && Array.isArray(signal.gaps)
        ? signal.gaps : [];
    },
    missing(): string[] {
      const required = [...(Object.hasOwn(REQUIRED_READS, jobCode) ? REQUIRED_READS[jobCode]! : [])];
      if (jobCode === "daily_plan_flow") {
        const items = results.get("daily_plan_strategy_query")?.playbook_items;
        if (Array.isArray(items) && items.length > 0) required.push("daily_plan_write");
      }
      if (jobCode === "nightly_sector_opportunity_scan" || jobCode === "value_anchor_opportunity_scan") {
        required.push("pool_attention_write");
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
      const missing = required.filter((name) => !results.has(name));
      if (jobCode === "daily_plan_flow" && results.has("daily_plan_strategy_query")
        && results.has("strategy_document_query")) {
        const requiredDocs = results.get("daily_plan_strategy_query")?.required_strategy_documents;
        const docs = results.get("strategy_document_query")?.documents;
        if (Array.isArray(requiredDocs) && Array.isArray(docs)) {
          const loaded = new Set(docs.map((item) => String(object(item).code)));
          const absent = requiredDocs.map(String).filter((code) => !loaded.has(code));
          if (absent.length) missing.push(`strategy_document_query（缺少统一编排要求的策略正文：${absent.join("、")}）`);
        }
      }
      if (jobCode === "two_year_reversal_scan" && results.has("strategy_document_query")) {
        const docs = results.get("strategy_document_query")?.documents;
        if (!Array.isArray(docs) || !docs.some((item) => object(item).code === "two_year_reversal_strategy")
          || !docs.some((item) => object(item).role === "portfolio")) {
          missing.push("strategy_document_query（必须读取本任务策略和投资总策略）");
        }
      }
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
      if (jobCode === "daily_plan_flow" && results.has("daily_plan_write")) {
        const expected = results.get("daily_plan_strategy_query")?.playbook_items;
        const submitted = successfulArgs.get("daily_plan_write")?.items;
        if (Array.isArray(expected) && Array.isArray(submitted)
          && JSON.stringify(expected) !== JSON.stringify(submitted)) {
          missing.push("daily_plan_write（必须原样提交统一策略编排生成的 playbook_items）");
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
