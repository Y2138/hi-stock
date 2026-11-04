import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type pg from "pg";
import { loadSelectionContext, prepareSelectionContext, writeSelectionResult, SELECTION_JOB } from "../modules/selection/service.js";
import { fillRawStockDaily } from "../datasource/service.js";
import { withMarketMutationLock } from "../datasource/mutation-lock.js";
import { shanghaiDate } from "../modules/market-news/repo.js";
import { validateToolInput } from "./tool-validation.js";
import { insertToolAudit } from "./repo.js";
import { sha256Json } from "./hash.js";

const strict = <T extends Record<string, ReturnType<typeof Type.String>>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const DateSchema = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const message = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const ContextSchema = Type.Object({ date: DateSchema }, { additionalProperties: false });
export const SelectionWriteSchema = Type.Object({
  target_date: DateSchema,
  input_hash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  reviews: Type.Array(Type.Object({
    code: Type.String({ pattern: "^[A-Za-z0-9._-]{1,32}$" }),
    decision: Type.Union(["priority", "observe", "exclude", "pending"].map((value) => Type.Literal(value))),
    strength: Type.Union(["strong", "adequate", "weak"].map((value) => Type.Literal(value))),
    rank: Type.Integer({ minimum: 1, maximum: 100 }),
    reason: message(65), risk: message(45), condition: message(40),
    dimensions: strict({ fundamental: message(600), news: message(600), industry_position: message(600),
      character: message(600), execution: message(600), price_fit: message(600) }),
    sources: Type.Array(Type.Object({
      kind: Type.Union([Type.Literal("local"), Type.Literal("web")]), reference: message(2048), fact: message(400),
    }, { additionalProperties: false }), { maxItems: 16 }),
  }, { additionalProperties: false }), { maxItems: 30 }),
  gaps: Type.Array(message(300), { maxItems: 40 }),
}, { additionalProperties: false });

export function buildSelectionTools(deps: { pool: pg.Pool; sessionId: string | null }): AgentTool[] {
  const running = async (date: string) => {
    const row = (await deps.pool.query<{ id: string; target_date: string }>(
      `SELECT r.id::text,r.target_date::text FROM job_run r JOIN job_definition d ON d.id=r.job_id
       WHERE r.session_id=$1 AND d.code=$2 AND r.status='running' ORDER BY r.id DESC LIMIT 1`, [deps.sessionId, SELECTION_JOB])).rows[0];
    if (!row || row.target_date !== date || date !== shanghaiDate()) throw new Error("精选工具只允许当前任务研究今日来源，不支持历史回填");
    return row.id;
  };
  return [
    { name: "selection_context_query", label: "读取盘后策略初筛", parameters: ContextSchema,
      description: "读取今日已完成策略初筛并锁定输入，返回原生条件、来源覆盖及去重共振；只用于盘后统一标的精选任务。",
      execute: async (_id, raw, signal) => {
        const input = validateToolInput<Static<typeof ContextSchema>>("selection_context_query", ContextSchema, raw);
        const runId = await running(input.date);
        const initial = await loadSelectionContext(deps.pool, input.date);
        if (initial.pending.length) throw new Error("来源仍在执行，不能提前研究");
        const priceGaps: string[] = [];
        const missing = initial.candidates.filter((item) => !item.reference_price);
        if (missing.length) await withMarketMutationLock(deps.pool, async () => {
          for (const item of missing) {
            if (signal?.aborted) throw new Error("原始价核验已中断");
            try { await fillRawStockDaily(deps.pool, item.code, input.date, { jobRunId: runId, hithinkDeps: { signal } }); }
            catch { if (signal?.aborted) throw new Error("原始价核验已中断"); priceGaps.push(`未复权价格待核验：${item.code}`); }
          }
        });
        const context = await prepareSelectionContext(deps.pool, runId, input.date, priceGaps);
        await insertToolAudit(deps.pool, { session_id: deps.sessionId, tool_name: "selection_context_query", args: input,
          result_sha256: sha256Json(context), status: "ok" });
        return { content: [{ type: "text", text: JSON.stringify(context) }], details: context };
      } },
    { name: "selection_result_write", label: "提交统一标的研究与推荐", parameters: SelectionWriteSchema, executionMode: "sequential",
      description: "每只正式候选必须提交逐股研究；无推荐也须保留reviews，核验失败标pending、有充分排除依据标exclude，不得清空研究。搜索失败时服务端把未完成消息核验的priority/observe降为pending并保留全部研究。sources的local引用reference必须严格等于同标的代码，如002756.SZ；web引用当次实际获取的URL。gaps每条最多300字。服务端确定最多三个推荐，不改持仓、关注或策略。",
      execute: async (_id, raw, signal) => {
        if (signal?.aborted) throw new Error("精选研究提交已中断");
        const input = validateToolInput<Static<typeof SelectionWriteSchema>>("selection_result_write", SelectionWriteSchema, raw);
        const written = await writeSelectionResult(deps.pool, await running(input.target_date), input);
        await insertToolAudit(deps.pool, { session_id: deps.sessionId, tool_name: "selection_result_write", args: { input_sha256: sha256Json(input) },
          result_sha256: sha256Json(written), status: "ok" });
        return { content: [{ type: "text", text: JSON.stringify(written) }], details: written };
      } },
  ];
}
