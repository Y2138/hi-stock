// 固定流程的完成门禁只认本次执行的工具事件，不认模型声明或历史会话中的成功记录。
import type { AgentCoreFrame } from "./core/loop.js";

const REQUIRED_READS: Record<string, readonly string[]> = {
  daily_plan_flow: ["strategy_document_query", "daily_plan_strategy_query"],
  value_anchor_opportunity_scan: ["strategy_document_query", "value_anchor_signal_query"],
  swing_signal_scan: ["strategy_document_query", "strategy_evaluation_query"],
  copper_left_launch_signal_scan: ["strategy_document_query", "strategy_evaluation_query"],
  first_board_intraday_scan: ["strategy_document_query", "strategy_evaluation_query"],
  limit_up_close_scan: ["strategy_document_query", "strategy_evaluation_query"],
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
  "daily_plan_strategy_query", "daily_plan_context_query", "swing_signal_query", "auction_context_query",
  "value_anchor_signal_query", "two_year_reversal_signal_query", "strategy_evaluation_query",
]);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toolErrorText(value: unknown): string {
  const result = object(value);
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content.map((item) => object(item).text).find((item) => typeof item === "string" && item.trim());
    if (typeof text === "string") return text.trim();
  }
  return "工具执行失败";
}

function baseToolName(value: string): string {
  return value.split("（", 1)[0]!;
}

export function createJobCompletionGate(jobCode: string, targetDate: string) {
  const calls = new Map<string, Record<string, unknown>>();
  const results = new Map<string, Record<string, unknown>>();
  const failures = new Map<string, string>();
  const successfulArgs = new Map<string, Record<string, unknown>>();
  return {
    observe(frame: AgentCoreFrame) {
      const name = String(frame.data.name);
      const id = String(frame.data.toolCallId);
      if (frame.type === "tool_start") calls.set(id, object(frame.data.args));
      if (frame.type !== "tool_end") return;
      const args = calls.get(id);
      calls.delete(id);
      if (!args || (TARGET_DATE_TOOLS.has(name) && args.date !== targetDate)) return;
      let details = object(object(frame.data.result).details);
      if (frame.data.isError || details.status === "failed" || details.status === "error") {
        if (!results.has(name)) failures.set(name, toolErrorText(frame.data.result));
      } else {
        if (name === "strategy_document_query") {
          const previous = results.get(name);
          const documents = [...(Array.isArray(previous?.documents) ? previous.documents : []),
            ...(Array.isArray(details.documents) ? details.documents : [])];
          const unique = new Map(documents.map((item) => [String(object(item).code), item]));
          details = { ...previous, ...details, documents: [...unique.values()] };
        }
        results.set(name, details);
        failures.delete(name);
        successfulArgs.set(name, args);
      }
    },
    unavailableGaps(): unknown[] {
      const gaps: unknown[] = [];
      const signal = results.get("two_year_reversal_signal_query");
      if (jobCode === "two_year_reversal_scan" && signal
        && (signal.status === "unavailable" || signal.data_date !== targetDate) && Array.isArray(signal.gaps)) gaps.push(...signal.gaps);
      const evaluation = results.get("strategy_evaluation_query");
      const run = object(evaluation?.run);
      if ((jobCode === "swing_signal_scan" || jobCode === "limit_up_close_scan")
        && ["partial", "failed"].includes(String(run.status))) {
        if (Array.isArray(run.gaps) && run.gaps.length) gaps.push(...run.gaps);
        else gaps.push({ tool: "strategy_evaluation_query", reason: `评估状态 ${String(run.status)}` });
      }
      for (const item of this.missing()) {
        const name = baseToolName(item);
        const reason = failures.get(name);
        if (reason) gaps.push({ tool: name, reason });
      }
      return gaps;
    },
    failures(): Array<{ tool: string; reason: string }> {
      return [...failures].map(([tool, reason]) => ({ tool, reason }));
    },
    canFinalize(): boolean {
      return this.missing().every((item) => failures.has(baseToolName(item)));
    },
    missing(): string[] {
      const required = [...(Object.hasOwn(REQUIRED_READS, jobCode) ? REQUIRED_READS[jobCode]! : [])];
      if (jobCode === "nightly_sector_opportunity_scan" || jobCode === "value_anchor_opportunity_scan") {
        required.push("pool_attention_write");
      }
      if (jobCode === "auction_opportunity_assessment") {
        required.push("auction_context_query");
        const context = results.get("auction_context_query");
        if (context && object(context.market_day).should_run !== false) {
          required.push("strategy_document_query");
          if (Array.isArray(context.candidate_codes) && context.candidate_codes.length > 0) required.push("fetch_hithink_data");
          if ([context.positions, context.attentions, context.opportunities, context.intraday_ladder_candidates].some((items) => Array.isArray(items) && items.length > 0)) required.push("auction_assessment_write");
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
      if (jobCode === "copper_left_launch_signal_scan" && results.has("strategy_document_query")) {
        const docs = results.get("strategy_document_query")?.documents;
        if (!Array.isArray(docs) || !docs.some((item) => object(item).code === "copper_left_launch_strategy")
          || !docs.some((item) => object(item).role === "portfolio")) {
          missing.push("strategy_document_query（必须读取铜左侧启动策略和投资总策略）");
        }
      }
      if (jobCode === "limit_up_close_scan" && results.has("strategy_document_query")) {
        const docs = results.get("strategy_document_query")?.documents;
        if (!Array.isArray(docs) || !docs.some((item) => object(item).code === "limit_up_board")
          || !docs.some((item) => object(item).role === "portfolio")) {
          missing.push("strategy_document_query（必须读取涨停接力观察策略和投资总策略）");
        }
      }
      if (jobCode === "swing_signal_scan" && results.has("strategy_document_query")) {
        const docs = results.get("strategy_document_query")?.documents;
        if (!Array.isArray(docs) || !docs.some((item) => object(item).code === "swing_strategy")
          || !docs.some((item) => object(item).role === "portfolio")) {
          missing.push("strategy_document_query（必须读取波段策略和投资总策略）");
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
      if (jobCode === "limit_up_close_scan" && results.has("strategy_evaluation_query")) {
        const evaluation = results.get("strategy_evaluation_query")!;
        const run = object(evaluation.run);
        const outcome = object(evaluation.result);
        const signals = Array.isArray(outcome.signals) ? outcome.signals : [];
        // 有明确缺口的评估可形成“部分完成”报告，但不能激活候选；仅完整成功才强制写入。
        if (!["partial", "failed"].includes(String(run.status)) &&
          (run.status !== "success" || evaluation.execution === "waiting" ||
            object(evaluation.opportunity_write).replaced !== Math.min(signals.length, 4))) {
          missing.push("strategy_evaluation_query（收盘打板扫描未完成结构化机会写入）");
        }
      }
      if (jobCode === "daily_plan_flow" && results.has("daily_plan_strategy_query")) {
        const items = results.get("daily_plan_strategy_query")?.playbook_items;
        const write = object(results.get("daily_plan_strategy_query")?.playbook_write);
        if (!Array.isArray(items) || write.replaced !== items.length) {
          missing.push("daily_plan_strategy_query（服务端未完成结构化预案写入）");
        }
      }
      if (jobCode === "auction_opportunity_assessment" && results.has("auction_context_query")
        && object(results.get("auction_context_query")?.market_day).should_run !== false
        && results.has("strategy_document_query")) {
        const requiredDocs = results.get("auction_context_query")?.required_strategy_documents;
        const docs = results.get("strategy_document_query")?.documents;
        if (Array.isArray(requiredDocs) && Array.isArray(docs)) {
          const loaded = new Set(docs.map((item) => String(object(item).code)));
          const absent = requiredDocs.map(String).filter((code) => !loaded.has(code));
          if (absent.length) missing.push(`strategy_document_query（竞价缺少策略正文：${absent.join("、")}）`);
        }
      }
      if (jobCode === "auction_opportunity_assessment" && results.has("auction_assessment_write")
        && object(results.get("fetch_hithink_data")?.summary).succeeded === 0) {
        const items = successfulArgs.get("auction_assessment_write")?.items;
        const scopeItems = successfulArgs.get("auction_assessment_write")?.scope_items;
        if ((Array.isArray(items) && items.some((item) => object(item).conclusion !== "unavailable"))
          || (Array.isArray(scopeItems) && scopeItems.some((item) => object(item).conclusion !== "unavailable"))) {
          missing.push("auction_assessment_write（竞价取数全部失败时各类目标只能回写数据不足）");
        }
      }
      return missing;
    },
  };
}
