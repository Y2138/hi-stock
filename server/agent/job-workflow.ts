// 固定流程的完成门禁只认本次执行的工具事件，不认模型声明或历史会话中的成功记录。
import type { AgentCoreFrame } from "./core/loop.js";

const REQUIRED_READS: Record<string, readonly string[]> = {
  cross_strategy_selection: ["strategy_document_query", "selection_context_query", "selection_result_write"],
  daily_plan_flow: ["strategy_document_query", "daily_plan_strategy_query"],
  evening_plan_preview: ["daily_plan_context_query", "evening_preview_write"],
  value_anchor_opportunity_scan: ["strategy_document_query", "strategy_evaluation_query"],
  swing_signal_scan: ["strategy_document_query", "strategy_evaluation_query"],
  copper_left_launch_signal_scan: ["strategy_document_query", "strategy_evaluation_query"],
  first_board_intraday_scan: ["strategy_document_query", "strategy_evaluation_query"],
  limit_up_close_scan: ["strategy_document_query", "strategy_evaluation_query"],
  two_year_reversal_scan: ["strategy_document_query", "strategy_evaluation_query"],
  nightly_sector_opportunity_scan: [
    "pool_context_query",
    "strategy_document_query",
    "analysis_run",
  ],
  pre_market_news_scan: ["pool_context_query", "web_search", "pool_news_write"],
  // 周复盘必须读取投资总策略作为仓位与纪律评判口径；事实快照由 Runner 在模型运行前注入，
  // 快照工具不设为硬门禁，避免快照构建失败时无法按缺口产出报告。
  weekly_trading_review: ["strategy_document_query"],
};
const TARGET_DATE_TOOLS = new Set([
  "selection_context_query",
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

function isNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

/** 板块当日确认度分档齐全性：档位、总分、五项分项、脉冲标记与结构位失效位缺任一项即不合格。 */
function sectorTierGap(result: unknown): string | null {
  const signals = object(result).signals;
  if (!Array.isArray(signals)) return "结果缺少 signals";
  for (const raw of signals) {
    const confirmation = object(object(raw).confirmation);
    const label = String(object(raw).sector ?? object(raw).code ?? "板块");
    if (!["A", "B", "C"].includes(String(confirmation.tier))) return `${label} 缺少 A/B/C 档位`;
    if (!isNumber(confirmation.score)) return `${label} 缺少确认度总分`;
    const parts = object(confirmation.parts);
    for (const key of ["m1", "m2", "m3", "m4", "m5"]) {
      if (!isNumber(parts[key])) return `${label} 缺少 ${key.toUpperCase()} 分项`;
    }
    if (typeof object(confirmation.metrics).intraday_pulse !== "boolean") return `${label} 缺少脉冲标记`;
    const invalidation = object(confirmation.invalidation);
    if (!isNumber(invalidation.price)) return `${label} 缺少结构位失效位`;
    if (!isNumber(invalidation.distance_pct)) return `${label} 缺少失效位距收盘百分比`;
  }
  return null;
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
      if (jobCode === "nightly_sector_opportunity_scan") {
        required.push("pool_attention_write");
      }
      if (jobCode === "auction_opportunity_assessment") {
        required.push("auction_context_query");
        const context = results.get("auction_context_query");
        if (context && object(context.market_day).should_run !== false) {
          required.push("strategy_document_query");
          if (Array.isArray(context.candidate_codes) && context.candidate_codes.length > 0) required.push("fetch_hithink_data");
          if ([context.attentions, context.opportunities, context.intraday_ladder_candidates].some((items) => Array.isArray(items) && items.length > 0)) required.push("auction_assessment_write");
        }
      }
      const missing = required.filter((name) => !results.has(name));
      if (["limit_up_close_scan", "first_board_intraday_scan"].includes(jobCode)) {
        const native = object(results.get("strategy_evaluation_query")?.result);
        if (native.selection_method === "stage_pk_v2" && Array.isArray(native.signals) && native.signals.length
          && !results.has("web_search")) missing.push("web_search（同高度PK必须实际检索拟选者和竞争者消息）");
      }
      if (jobCode === "cross_strategy_selection" && results.has("selection_result_write")) {
        const written = results.get("selection_result_write")!;
        if (written.target_date !== targetDate || !Array.isArray(written.recommendations))
          missing.push("selection_result_write（目标日或结构化推荐不完整）");
      }
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
      if (jobCode === "nightly_sector_opportunity_scan" && results.has("strategy_document_query")) {
        const docs = results.get("strategy_document_query")?.documents;
        if (!Array.isArray(docs) || !docs.some((item) => object(item).code === "nightly_sector_strategy")
          || !docs.some((item) => object(item).role === "portfolio")) {
          missing.push("strategy_document_query（必须读取夜间板块左侧趋势策略和投资总策略）");
        }
      }
      if (jobCode === "nightly_sector_opportunity_scan" && results.has("analysis_run")) {
        const items = results.get("analysis_run")?.items;
        const requests = successfulArgs.get("analysis_run")?.requests;
        const hasFullSectorScan = Array.isArray(items) && items.some((item) =>
          object(item).analysis_type === "sector_trend_structure"
          && ["success", "partial"].includes(String(object(item).status)),
        ) && Array.isArray(requests) && requests.some((request) => {
          const value = object(request);
          return value.analysis_type === "sector_trend_structure"
            && value.as_of === targetDate
            && value.codes === undefined;
        });
        if (!hasFullSectorScan) {
          missing.push("analysis_run（需要目标日完整 881 一级行业趋势结构扫描或明确缺口）");
        } else {
          // 分档表是结论主依据：信号缺档位、分项、脉冲标记或结构位失效位即不合格。
          const tierGap = (Array.isArray(items) ? items : [])
            .filter((item) => object(item).analysis_type === "sector_trend_structure"
              && ["success", "partial"].includes(String(object(item).status)))
            .map((item) => sectorTierGap(object(item).result))
            .find((reason) => reason !== null);
          if (tierGap) missing.push(`analysis_run（板块当日确认度分档不完整：${tierGap}）`);
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
        } else if (items.length > 0) {
          // 情景/做T预案是持仓预案的必备输出：有持仓而未完成结构化情景写入不得收尾。
          const scenarioWrite = object(results.get("daily_plan_scenario_write"));
          if (scenarioWrite.replaced_items !== items.length) {
            missing.push("daily_plan_scenario_write（情景与做T预案未完成结构化写入）");
          }
        }
      }
      if (jobCode === "evening_plan_preview" && results.has("daily_plan_context_query")
        && !results.has("evening_preview_write")) {
        missing.push("evening_preview_write（晚间明日预案预览未完成结构化写入）");
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
