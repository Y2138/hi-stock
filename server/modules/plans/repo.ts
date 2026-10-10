import { positionGapReasons } from "./evaluation-gaps.js";
// 每日计划盯防预案：任务会话写入 draft，运行成功后激活并绑定 plan_output_id。
import type pg from "pg";
import { apiErrors } from "../../http/router.js";
import { inServiceTransaction, type TransactionDb } from "../../db/transaction.js";
import { isWeekdayDate } from "../../scheduler/time.js";
import { listPositions } from "../positions/repo.js";

export type Db = Pick<pg.Pool, "query">;

type PlaybookKind = "position_action" | "off_pool_opportunity";
type PlaybookAction = "exit" | "reduce" | "buy" | "hold" | "observe";
type PlaybookTrigger = "open" | "price_range" | "condition";
export type AuctionConclusion = "worth_entering" | "signal_passed" | "observe" | "give_up" | "unavailable";
export type AuctionReviewType =
  | "one_word_continue"
  | "turnover_advance"
  | "divergence"
  | "give_up"
  | "data_insufficient"
  | "legacy_observe";
export type AuctionDataStatus = "ready" | "not_ready" | "missing" | "stale";

export interface AuctionAssessmentInput {
  code: string;
  conclusion: AuctionConclusion;
  review_type: AuctionReviewType;
  metrics_summary: string;
  assessment_summary: string;
  benchmark_tags?: string[];
  data_status: AuctionDataStatus;
  data_time?: string;
}

export interface AuctionScopeInput {
  target_key: string;
  conclusion: "plan_aligned" | "risk_alert" | "confirmed" | "wait" | "give_up" | "promotion_strong" | "promotion_normal" | "divergence_hold" | "weak_exit" | "unavailable";
  metrics_summary: string;
  assessment_summary: string;
  data_status: AuctionDataStatus;
  data_time?: string;
}

export interface AuctionAssessmentRow extends AuctionAssessmentInput {
  id: string;
  output_id: string | null;
  assessed_at: string;
}

export interface PlaybookItemInput {
  item_kind: PlaybookKind;
  code: string;
  grade?: "A" | "B" | "C";
  priority?: number;
  action: PlaybookAction;
  trigger_kind: PlaybookTrigger;
  price_lower?: number;
  price_upper?: number;
  headline: string;
  auction_md?: string;
  intraday_md?: string;
  evidence_md?: string;
  missing_md?: string;
  invalidation_md?: string;
  risk_md?: string;
  key_levels?: DailyPlanKeyLevel[];
  strategy_code?: string;
  strategy_runtime_version?: number;
  primary_evaluation_run_id?: string | null;
  fallback_evaluation_run_id?: string | null;
  primary_action?: "hold" | "observe" | "reduce" | "exit" | null;
  fallback_action?: "hold" | "observe" | "reduce" | "exit" | null;
  effective_action?: "hold" | "observe" | "reduce" | "exit";
  evaluation_status?: "success" | "partial" | "failed" | "waiting";
  evaluation_data_date?: string | null;
  evaluation_missing?: string[];
}

/** 情景预案五类固定情景；与提示词、前端标签一一对应。 */
export type DailyPlanScenarioKind =
  | "surge_reversal"
  | "open_plunge"
  | "wide_swing"
  | "strong_continuation"
  | "weak_breakdown";

export const DAILY_PLAN_SCENARIO_ORDER: Record<DailyPlanScenarioKind, number> = {
  surge_reversal: 1,
  open_plunge: 2,
  wide_swing: 3,
  strong_continuation: 4,
  weak_breakdown: 5,
};

/** 关键点位事实：服务端机械计算写入，情景/做T预案只引用不转抄。 */
export interface DailyPlanKeyLevel {
  kind: "support" | "resistance" | "limit";
  label: string;
  price: number;
}

/** 做T预案：默认给出低吸/兑现区间；只有流动性极端才允许 skip_reason。 */
export type DailyPlanTPlan =
  | { buy_lower: number; buy_upper: number; sell_lower: number; sell_upper: number; confirm_md: string; cancel_md: string }
  | { skip_reason: string };

export interface DailyPlanScenarioInput {
  scenario_kind: DailyPlanScenarioKind;
  observable_md: string;
  response_md: string;
  invalidation_md: string;
}

export interface DailyPlanScenarioRow extends DailyPlanScenarioInput {
  id: string;
}

export interface ReplaceScenariosInput {
  source_job_run_id: string;
  items: Array<{
    code: string;
    auction_md?: string;
    intraday_md?: string;
    invalidation_md?: string;
    risk_md?: string;
    t_plan: DailyPlanTPlan;
    scenarios: DailyPlanScenarioInput[];
  }>;
}

export interface ReplacePlaybookInput {
  source_job_run_id: string;
  items: PlaybookItemInput[];
}

export interface PlaybookItemRow {
  id: string;
  item_kind: PlaybookKind;
  code: string;
  name: string;
  grade: string | null;
  priority: number;
  action: PlaybookAction;
  trigger_kind: PlaybookTrigger;
  price_lower: number | null;
  price_upper: number | null;
  headline: string;
  auction_md: string | null;
  intraday_md: string | null;
  evidence_md: string | null;
  missing_md: string | null;
  invalidation_md: string | null;
  risk_md: string | null;
  strategy_code: string | null;
  strategy_runtime_version: number | null;
  primary_evaluation_run_id: string | null;
  fallback_evaluation_run_id: string | null;
  primary_action: string | null;
  fallback_action: string | null;
  effective_action: string | null;
  evaluation_status: string | null;
  evaluation_data_date: string | null;
  evaluation_missing: string[];
  key_levels: DailyPlanKeyLevel[];
  t_plan: DailyPlanTPlan | null;
  scenarios?: DailyPlanScenarioRow[];
  target_date: string;
  auction_assessment: AuctionAssessmentRow | null;
}

export interface DailyPlanBoard {
  plan: { output_id: string; target_date: string; status: string; created_at: string };
  position_actions: PlaybookItemRow[];
  opportunities: PlaybookItemRow[];
}

interface InstrumentMatch {
  id: bigint;
  code: string;
  name: string;
}

async function resolveInstruments(client: pg.PoolClient, codes: string[]): Promise<Map<string, InstrumentMatch>> {
  const rows = await client.query<{ id: string; code: string; name: string }>(
    `SELECT id::text, code, name FROM market_instrument WHERE code = ANY($1::text[])`,
    [codes],
  );
  return new Map(rows.rows.map((row) => [row.code, { id: BigInt(row.id), code: row.code, name: row.name }]));
}

/** 全量替换该任务运行的 draft 预案；逐行校验持仓/池外归属后写入。 */
export async function replaceDraftPlaybook(
  db: TransactionDb,
  input: ReplacePlaybookInput,
): Promise<{ replaced: number }> {
  return inServiceTransaction(db, async (client) => {
    const run = await client.query<{ target_date: string; code: string; account_id: string | null }>(
      `SELECT run.target_date::text, definition.code, CASE WHEN definition.code='daily_plan_flow' THEN COALESCE(run.account_id,1) ELSE run.account_id END::text AS account_id
         FROM job_run run
         JOIN job_definition definition ON definition.id = run.job_id
        WHERE run.id = $1 AND definition.code IN ('daily_plan_flow','limit_up_close_scan')`,
      [input.source_job_run_id],
    );
    if (!run.rows[0]) throw apiErrors.badRequest("预案只能由每日计划或收盘打板任务提交");
    const targetDate = run.rows[0]!.target_date;
    const allowedKind = run.rows[0]!.code === "daily_plan_flow" ? "position_action" : "off_pool_opportunity";
    if (input.items.some((item) => item.item_kind !== allowedKind))
      throw apiErrors.badRequest(`任务 ${run.rows[0]!.code} 只能写入 ${allowedKind}`);
    // 字段级校验（评级/证据/priority/区间顺序/重复）已在工具入口 validateDailyPlanWriteInput 完成；
    // 这里只做需要数据库事实的归属校验。
    const instruments = await resolveInstruments(client, input.items.map((item) => item.code));
    const unknown = input.items.filter((item) => !instruments.has(item.code));
    if (unknown.length > 0) {
      throw apiErrors.badRequest(`预案标的不在标的目录中：${unknown.map((item) => item.code).join("、")}`);
    }

    const heldCodes = await client.query<{ code: string }>(
      `SELECT DISTINCT instrument.code
         FROM portfolio_position position
         JOIN market_instrument instrument ON instrument.id = position.instrument_id
        WHERE position.quantity > 0 AND ($1::bigint IS NULL OR position.account_id=$1)`,
      [run.rows[0]!.account_id],
    );
    const heldSet = new Set(heldCodes.rows.map((row) => row.code));
    const pooledCodes = await client.query<{ code: string }>(
      `SELECT DISTINCT instrument.code
         FROM pool_membership membership
         JOIN market_instrument instrument ON instrument.id = membership.instrument_id
        WHERE membership.effective_to IS NULL`,
    );
    const pooledSet = new Set(pooledCodes.rows.map((row) => row.code));

    for (const item of input.items) {
      if (item.item_kind === "position_action" && !heldSet.has(item.code)) {
        throw apiErrors.badRequest(`position_action 标的 ${item.code} 不是数量大于 0 的真实持仓`);
      }
      if (item.item_kind === "off_pool_opportunity" && (heldSet.has(item.code) || pooledSet.has(item.code))) {
        throw apiErrors.badRequest(`off_pool_opportunity 标的 ${item.code} 不是池外标的`);
      }
    }

    if (run.rows[0]!.account_id) {
      const evaluationIds=[...new Set(input.items.flatMap(item=>[item.primary_evaluation_run_id,item.fallback_evaluation_run_id]).filter(Boolean))];
      if(evaluationIds.length) {
        const scoped=await client.query("SELECT id::text FROM strategy_evaluation_run WHERE id=ANY($1::bigint[]) AND account_id=$2",[evaluationIds,run.rows[0]!.account_id]);
        if(scoped.rows.length!==evaluationIds.length) throw apiErrors.badRequest("预案评估来源不属于当前账户");
      }
    }

    await client.query("DELETE FROM daily_plan_playbook WHERE source_job_run_id = $1", [input.source_job_run_id]);
    let index = 0;
    for (const item of input.items) {
      const instrument = instruments.get(item.code)!;
      // position_action 不接受 priority：按提交顺序固定为 100+序号，保证跨组排序稳定。
      const priority = item.item_kind === "position_action" ? 100 + index : item.priority ?? 100;
      index += 1;
      await client.query(
        `INSERT INTO daily_plan_playbook
           (source_job_run_id, target_date, item_kind, instrument_id, code, name,
            grade, priority, action, trigger_kind, price_lower, price_upper,
            headline, auction_md, intraday_md, evidence_md, missing_md, invalidation_md, risk_md, key_levels,
            strategy_code,strategy_runtime_version,primary_evaluation_run_id,fallback_evaluation_run_id,
            primary_action,fallback_action,effective_action,evaluation_status,evaluation_data_date,evaluation_missing,account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$30::jsonb,
                 $20,$21,$22,$23,$24,$25,$26,$27,$28,$29::jsonb,$31)`,
        [
          input.source_job_run_id,
          targetDate,
          item.item_kind,
          instrument.id.toString(),
          instrument.code,
          instrument.name,
          item.grade ?? null,
          priority,
          item.action,
          item.trigger_kind,
          item.price_lower ?? null,
          item.price_upper ?? null,
          item.headline.trim(),
          item.auction_md ?? null,
          item.intraday_md ?? null,
          item.evidence_md ?? null,
          item.missing_md ?? null,
          item.invalidation_md ?? null,
          item.risk_md ?? null,
          item.strategy_code ?? null,
          item.strategy_runtime_version ?? null,
          item.primary_evaluation_run_id ?? null,
          item.fallback_evaluation_run_id ?? null,
          item.primary_action ?? null,
          item.fallback_action ?? null,
          item.effective_action ?? item.action,
          item.evaluation_status ?? "success",
          item.evaluation_data_date ?? null,
          JSON.stringify(item.evaluation_missing ?? []),
          JSON.stringify(item.key_levels ?? []),
          run.rows[0]!.account_id,
        ],
      );
    }
    return { replaced: input.items.length };
  });
}

/** 全量替换本次运行草稿预案的情景矩阵与做T/盯防叙述；code 集合必须与草稿 position_action 完全一致。 */
export async function replaceDraftScenarios(
  db: TransactionDb,
  input: ReplaceScenariosInput,
): Promise<{ replaced_items: number; replaced_scenarios: number }> {
  return inServiceTransaction(db, async (client) => {
    const run = await client.query<{ code: string; account_id: string | null }>(
      `SELECT definition.code, run.account_id::text
         FROM job_run run
         JOIN job_definition definition ON definition.id = run.job_id
        WHERE run.id = $1 AND definition.code = 'daily_plan_flow'`,
      [input.source_job_run_id],
    );
    if (!run.rows[0]) throw apiErrors.badRequest("情景预案只能由每日计划任务提交");
    const drafts = await client.query<{ id: string; code: string }>(
      `SELECT id::text, code FROM daily_plan_playbook
        WHERE source_job_run_id = $1 AND item_kind = 'position_action' AND status = 'draft'`,
      [input.source_job_run_id],
    );
    const draftByCode = new Map(drafts.rows.map((row) => [row.code, row.id]));
    const inputCodes = new Set(input.items.map((item) => item.code));
    const missing = [...draftByCode.keys()].filter((code) => !inputCodes.has(code));
    const unknown = [...inputCodes].filter((code) => !draftByCode.has(code));
    if (missing.length > 0 || unknown.length > 0) {
      const parts: string[] = [];
      if (missing.length > 0) parts.push(`缺少持仓：${missing.join("、")}`);
      if (unknown.length > 0) parts.push(`不在本次结构化预案中：${unknown.join("、")}`);
      throw apiErrors.badRequest(`情景预案覆盖不完整；${parts.join("；")}`);
    }
    let replacedScenarios = 0;
    for (const item of input.items) {
      const itemId = draftByCode.get(item.code)!;
      await client.query(
        `UPDATE daily_plan_playbook
            SET auction_md = COALESCE($2, auction_md),
                intraday_md = COALESCE($3, intraday_md),
                invalidation_md = COALESCE($4, invalidation_md),
                risk_md = COALESCE($5, risk_md),
                t_plan = $6::jsonb,
                updated_at = now()
          WHERE id = $1`,
        [
          itemId,
          item.auction_md ?? null,
          item.intraday_md ?? null,
          item.invalidation_md ?? null,
          item.risk_md ?? null,
          JSON.stringify(item.t_plan),
        ],
      );
      await client.query("DELETE FROM daily_plan_scenario WHERE playbook_item_id = $1", [itemId]);
      for (const scenario of item.scenarios) {
        await client.query(
          `INSERT INTO daily_plan_scenario
             (playbook_item_id, source_job_run_id, scenario_kind, observable_md, response_md, invalidation_md)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            itemId,
            input.source_job_run_id,
            scenario.scenario_kind,
            scenario.observable_md.trim(),
            scenario.response_md.trim(),
            scenario.invalidation_md.trim(),
          ],
        );
        replacedScenarios += 1;
      }
    }
    return { replaced_items: input.items.length, replaced_scenarios: replacedScenarios };
  });
}

/** 任务成功后把 draft 行激活并绑定本次输出；更旧的激活行转入 superseded。 */
export async function activatePlaybookForRun(
  db: TransactionDb,
  sourceJobRunId: string,
  planOutputId: string | null,
): Promise<number> {
  return inServiceTransaction(db, async (client) => {
    if (!planOutputId) return 0;
    const source = await client.query<{ code: string; account_id: string | null }>(
      `SELECT definition.code,CASE WHEN definition.code='daily_plan_flow' THEN COALESCE(run.account_id,1) ELSE run.account_id END::text AS account_id
         FROM job_run run
         JOIN job_definition definition ON definition.id = run.job_id
        WHERE run.id = $1`,
      [sourceJobRunId],
    );
    if (!source.rows[0] || !["daily_plan_flow", "limit_up_close_scan"].includes(source.rows[0].code)) return 0;
    if (source.rows[0].code === "limit_up_close_scan") {
      const status = await client.query<{ status: string }>("SELECT status FROM job_run WHERE id=$1", [sourceJobRunId]);
      if (status.rows[0]?.status !== "success") return 0;
    }
    const kind = source.rows[0].code === "daily_plan_flow" ? "position_action" : "off_pool_opportunity";
    const activated = await client.query(
      `UPDATE daily_plan_playbook
          SET status = 'active', plan_output_id = $2, updated_at = now()
        WHERE source_job_run_id = $1 AND item_kind = $3 AND status = 'draft'`,
      [sourceJobRunId, planOutputId, kind],
    );
    await client.query(
      `UPDATE daily_plan_playbook
          SET status = 'superseded', updated_at = now()
        WHERE status = 'active' AND item_kind = $2
          AND account_id IS NOT DISTINCT FROM $4::bigint
          AND plan_output_id IS DISTINCT FROM $1
          AND plan_output_id IN (
            SELECT output.id FROM job_run_output output
            JOIN job_definition definition ON definition.id = output.job_id
            WHERE definition.code = $3
          )`,
      [planOutputId, kind, source.rows[0].code, source.rows[0].account_id],
    );
    await client.query(
      `UPDATE daily_plan_auction_assessment assessment
          SET status = 'superseded', updated_at = now()
        WHERE assessment.status = 'active'
          AND assessment.playbook_item_id IN (
            SELECT item.id FROM daily_plan_playbook item WHERE item.status = 'superseded'
          )`,
    );
    return activated.rowCount ?? 0;
  });
}

/** 暂存本次竞价任务对当前全部打板机会的判断；任务成功后统一激活。 */
export async function replaceDraftAuctionAssessments(
  db: TransactionDb,
  input: { source_job_run_id: string; items: AuctionAssessmentInput[]; scope_items: AuctionScopeInput[] },
): Promise<{ replaced: number }> {
  return inServiceTransaction(db, async (client) => {
    const run = await client.query<{ id: string; target_date: string; account_id: string }>(
      `SELECT run.id::text,run.target_date::text,COALESCE(run.account_id,1)::text AS account_id
         FROM job_run run
         JOIN job_definition definition ON definition.id = run.job_id
        WHERE run.id = $1 AND definition.code = 'auction_opportunity_assessment'`,
      [input.source_job_run_id],
    );
    if (!run.rows[0]) throw apiErrors.badRequest("竞价研判只能由 auction_opportunity_assessment 任务提交");

    const context = await queryAuctionAssessmentContext(client, run.rows[0]!.target_date, run.rows[0]!.account_id);
    const opportunities = context.opportunities.map((item) => ({ id: item.target_key.slice("board:".length), code: item.code }));
    const expectedCodes = opportunities.map((item) => item.code).sort();
    const submittedCodes = input.items.map((item) => item.code).sort();
    if (new Set(submittedCodes).size !== submittedCodes.length
      || expectedCodes.length !== submittedCodes.length
      || expectedCodes.some((code, index) => code !== submittedCodes[index])) {
      throw apiErrors.badRequest(
        `竞价研判必须完整覆盖当前打板机会：期望 ${expectedCodes.join("、") || "无"}，实际 ${submittedCodes.join("、") || "无"}`,
      );
    }

    if (!context.market_day.should_run && (input.items.length || input.scope_items.length)) {
      throw apiErrors.badRequest("非交易日不得写入竞价研判");
    }
    const targets = new Map<string, { code: string; scope_kind: "position" | "attention" | "ladder"; attention_entry_id: string | null; strategy_code: string | null }>([
      ...context.positions.map((item) => [item.target_key, { code: item.code, scope_kind: "position" as const,
        attention_entry_id: null, strategy_code: item.strategy_code } ] as const),
      ...context.attentions.map((item) => [item.target_key, { code: item.code, scope_kind: "attention" as const,
        attention_entry_id: item.attention_entry_id, strategy_code: item.strategy_code } ] as const),
      ...context.intraday_ladder_candidates.map((item) => [item.target_key, { code: String(item.code), scope_kind: "ladder" as const,
        attention_entry_id: null, strategy_code: "first_board_advance" } ] as const),
    ]);
    const submittedKeys = input.scope_items.map((item) => item.target_key);
    if (new Set(submittedKeys).size !== submittedKeys.length || targets.size !== submittedKeys.length
      || submittedKeys.some((key) => !targets.has(key))) {
      throw apiErrors.badRequest(`竞价研判必须完整覆盖持仓和关注来源及盘中梯队：期望 ${[...targets.keys()].join("、") || "无"}，实际 ${submittedKeys.join("、") || "无"}`);
    }
    const instrumentIds = await resolveInstruments(client, [...new Set([...targets.values()].map((item) => item.code))]);
    await client.query("DELETE FROM auction_scope_assessment WHERE source_job_run_id=$1 AND status='draft'", [input.source_job_run_id]);
    for (const item of input.scope_items) {
      const target = targets.get(item.target_key)!;
      const allowed = target.scope_kind === "position"
        ? ["plan_aligned", "risk_alert", "unavailable"]
        : target.scope_kind === "ladder"
          ? ["promotion_strong", "promotion_normal", "divergence_hold", "weak_exit", "unavailable"]
          : ["confirmed", "wait", "give_up", "unavailable"];
      if (!allowed.includes(item.conclusion)) throw apiErrors.badRequest(`${item.target_key} 竞价结论类型与位置不匹配`);
      if (item.data_status !== "ready" && item.conclusion !== "unavailable") {
        throw apiErrors.badRequest(`${item.target_key} 竞价数据未就绪只能标记 unavailable`);
      }
      await client.query(
        `INSERT INTO auction_scope_assessment
           (source_job_run_id,target_date,target_key,scope_kind,instrument_id,attention_entry_id,strategy_code,
            conclusion,metrics_summary,assessment_summary,data_status,data_time,account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [input.source_job_run_id,run.rows[0]!.target_date,item.target_key,target.scope_kind,
          instrumentIds.get(target.code)!.id.toString(),target.attention_entry_id,target.strategy_code,
          item.conclusion,item.metrics_summary.trim(),item.assessment_summary.trim(),item.data_status,item.data_time ?? null,run.rows[0]!.account_id],
      );
    }
    const opportunityByCode = new Map(opportunities.map((item) => [item.code, item]));
    await client.query(
      "DELETE FROM daily_plan_auction_assessment WHERE source_job_run_id = $1 AND status = 'draft'",
      [input.source_job_run_id],
    );
    for (const item of input.items) {
      const opportunity = opportunityByCode.get(item.code)!;
      await client.query(
        `INSERT INTO daily_plan_auction_assessment
           (source_job_run_id, playbook_item_id, code, conclusion, review_type, metrics_summary,
            assessment_summary, benchmark_tags, data_status, data_time, account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          input.source_job_run_id,
          opportunity.id,
          item.code,
          item.conclusion,
          item.review_type,
          item.metrics_summary.trim(),
          item.assessment_summary.trim(),
          JSON.stringify(item.benchmark_tags ?? []),
          item.data_status,
          item.data_time ?? null,
          run.rows[0]!.account_id,
        ],
      );
    }
    return { replaced: input.items.length, scope_replaced: input.scope_items.length };
  });
}

/** 竞价任务结果与运行终态同事务入账；交易日有打板机会时不允许缺少结构化判断。 */
export async function activateAuctionAssessmentsForRun(
  db: Db,
  sourceJobRunId: string,
  outputId: string | null,
): Promise<number> {
  if (!outputId) return 0;
  const run = await db.query<{ code: string; target_date: string; is_open: boolean | null; account_id: string }>(
    `SELECT definition.code, run.target_date::text, calendar.is_open, COALESCE(run.account_id,1)::text AS account_id
       FROM job_run run
       JOIN job_definition definition ON definition.id = run.job_id
       LEFT JOIN market_trading_day calendar ON calendar.trade_date = run.target_date
      WHERE run.id = $1`,
    [sourceJobRunId],
  );
  const runRow = run.rows[0];
  if (runRow?.code !== "auction_opportunity_assessment") return 0;
  const isOpen = runRow.is_open ?? isWeekdayDate(runRow.target_date);
  const shouldRun = isOpen;

  const context = await queryAuctionAssessmentContext(db, runRow.target_date, runRow.account_id);
  const expected = context.opportunities.map((item) => ({ id: item.target_key.slice("board:".length), code: item.code }));
  const drafts = await db.query<{ playbook_item_id: string }>(
    `SELECT playbook_item_id::text
       FROM daily_plan_auction_assessment
      WHERE source_job_run_id = $1 AND status = 'draft'
      ORDER BY playbook_item_id`,
    [sourceJobRunId],
  );
  const expectedIds = expected.map((item) => item.id).sort();
  const draftIds = drafts.rows.map((item) => item.playbook_item_id).sort();
  if (isOpen && (
    expectedIds.length !== draftIds.length
    || expectedIds.some((id, index) => id !== draftIds[index])
  )) {
    throw new Error(`集合竞价任务未完整回写打板机会：期望 ${expectedIds.length}，实际 ${draftIds.length}`);
  }
  if (!isOpen && draftIds.length > 0) {
    throw new Error("非交易日不得激活集合竞价判断");
  }
  const requiredKeys = [...context.positions.map((item) => item.target_key), ...context.attentions.map((item) => item.target_key), ...context.intraday_ladder_candidates.map((item) => item.target_key)].sort();
  const scopeDrafts = await db.query<{ target_key: string }>(
    "SELECT target_key FROM auction_scope_assessment WHERE source_job_run_id=$1 AND status='draft' ORDER BY target_key",
    [sourceJobRunId],
  );
  if (shouldRun && (requiredKeys.length !== scopeDrafts.rows.length
    || requiredKeys.some((key,index) => key !== scopeDrafts.rows[index]?.target_key))) {
    throw new Error(`竞价任务未完整回写持仓与关注来源：期望 ${requiredKeys.length}，实际 ${scopeDrafts.rows.length}`);
  }
  if (!shouldRun && scopeDrafts.rows.length) throw new Error("非交易日不得激活持仓或关注竞价研判");
  if (draftIds.length === 0 && scopeDrafts.rows.length === 0) return 0;

  await db.query(
    `UPDATE daily_plan_auction_assessment current
        SET status = 'superseded', updated_at = now()
      WHERE current.status = 'active'
        AND current.playbook_item_id = ANY($1::bigint[]) AND current.account_id=$2`,
    [draftIds, runRow.account_id],
  );
  const activated = await db.query(
    `UPDATE daily_plan_auction_assessment
        SET status = 'active', assessment_output_id = $2, updated_at = now()
      WHERE source_job_run_id = $1 AND status = 'draft'`,
    [sourceJobRunId, outputId],
  );
  await db.query(
    `UPDATE auction_scope_assessment previous SET status='superseded',updated_at=now()
       WHERE previous.status='active' AND previous.account_id=(SELECT account_id FROM job_run WHERE id=$1) AND previous.target_key IN
         (SELECT target_key FROM auction_scope_assessment WHERE source_job_run_id=$1 AND status='draft')`,
    [sourceJobRunId],
  );
  const scopeActivated = await db.query(
    `UPDATE auction_scope_assessment SET status='active',assessment_output_id=$2,updated_at=now()
      WHERE source_job_run_id=$1 AND status='draft'`, [sourceJobRunId,outputId],
  );
  return (activated.rowCount ?? 0) + (scopeActivated.rowCount ?? 0);
}

export async function discardDraftAuctionAssessmentsForRun(db: Db, sourceJobRunId: string): Promise<number> {
  const result = await db.query(
    "DELETE FROM daily_plan_auction_assessment WHERE source_job_run_id = $1 AND status = 'draft'",
    [sourceJobRunId],
  );
  const scope = await db.query(
    "DELETE FROM auction_scope_assessment WHERE source_job_run_id=$1 AND status='draft'", [sourceJobRunId],
  );
  return (result.rowCount ?? 0) + (scope.rowCount ?? 0);
}

function parseKeyLevels(value: unknown): DailyPlanKeyLevel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): DailyPlanKeyLevel[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const kind = record.kind === "support" || record.kind === "resistance" || record.kind === "limit"
      ? record.kind : null;
    const label = typeof record.label === "string" && record.label.trim() ? record.label.trim() : null;
    const price = typeof record.price === "number" && Number.isFinite(record.price) && record.price > 0
      ? record.price : null;
    return kind && label && price !== null ? [{ kind, label, price }] : [];
  });
}

function parseTPlan(value: unknown): DailyPlanTPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.skip_reason === "string" && record.skip_reason.trim()) {
    return { skip_reason: record.skip_reason.trim() };
  }
  const zones = [record.buy_lower, record.buy_upper, record.sell_lower, record.sell_upper];
  if (zones.every((zone) => typeof zone === "number" && Number.isFinite(zone) && zone > 0)
    && typeof record.confirm_md === "string" && typeof record.cancel_md === "string") {
    return {
      buy_lower: record.buy_lower as number,
      buy_upper: record.buy_upper as number,
      sell_lower: record.sell_lower as number,
      sell_upper: record.sell_upper as number,
      confirm_md: record.confirm_md,
      cancel_md: record.cancel_md,
    };
  }
  return null;
}

function toRow(row: Record<string, unknown>): PlaybookItemRow {
  return {
    id: String(row.id),
    item_kind: String(row.item_kind) as PlaybookKind,
    code: String(row.code),
    name: String(row.name),
    grade: (row.grade as string | null) ?? null,
    priority: Number(row.priority),
    action: String(row.action) as PlaybookAction,
    trigger_kind: String(row.trigger_kind) as PlaybookTrigger,
    price_lower: row.price_lower === null ? null : Number(row.price_lower),
    price_upper: row.price_upper === null ? null : Number(row.price_upper),
    headline: String(row.headline),
    auction_md: (row.auction_md as string | null) ?? null,
    intraday_md: (row.intraday_md as string | null) ?? null,
    evidence_md: (row.evidence_md as string | null) ?? null,
    missing_md: (row.missing_md as string | null) ?? null,
    invalidation_md: (row.invalidation_md as string | null) ?? null,
    risk_md: (row.risk_md as string | null) ?? null,
    key_levels: parseKeyLevels(row.key_levels),
    t_plan: parseTPlan(row.t_plan),
    strategy_code: (row.strategy_code as string | null) ?? null,
    strategy_runtime_version: row.strategy_runtime_version === null || row.strategy_runtime_version === undefined ? null : Number(row.strategy_runtime_version),
    primary_evaluation_run_id: row.primary_evaluation_run_id === null || row.primary_evaluation_run_id === undefined ? null : String(row.primary_evaluation_run_id),
    fallback_evaluation_run_id: row.fallback_evaluation_run_id === null || row.fallback_evaluation_run_id === undefined ? null : String(row.fallback_evaluation_run_id),
    primary_action: (row.primary_action as string | null) ?? null,
    fallback_action: (row.fallback_action as string | null) ?? null,
    effective_action: (row.effective_action as string | null) ?? null,
    evaluation_status: (row.evaluation_status as string | null) ?? null,
    evaluation_data_date: row.evaluation_data_date === null || row.evaluation_data_date === undefined ? null : String(row.evaluation_data_date),
    evaluation_missing: positionGapReasons(Array.isArray(row.evaluation_missing) ? row.evaluation_missing : [], String(row.code)),
    target_date: String(row.target_date),
    auction_assessment: row.auction_assessment_id === null || row.auction_assessment_id === undefined
      ? null
      : {
          id: String(row.auction_assessment_id),
          output_id: row.auction_output_id === null ? null : String(row.auction_output_id),
          code: String(row.code),
          conclusion: String(row.auction_conclusion) as AuctionConclusion,
          review_type: String(row.auction_review_type) as AuctionReviewType,
          metrics_summary: String(row.auction_metrics_summary),
          assessment_summary: String(row.auction_assessment_summary),
          benchmark_tags: Array.isArray(row.auction_benchmark_tags)
            ? row.auction_benchmark_tags.map(String)
            : [],
          data_status: String(row.auction_data_status) as AuctionDataStatus,
          data_time: row.auction_data_time === null ? undefined : String(row.auction_data_time),
          assessed_at: String(row.auction_assessed_at),
        },
  };
}

/** 按不可变结果 ID 读取历史持仓预案或收盘打板候选；不混入后续竞价判断。 */
export async function queryHistoricalPlanItems(db: Db, outputId: string, offset = 0) {
  const count = await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM daily_plan_playbook WHERE plan_output_id = $1 AND status <> 'draft'",
    [outputId],
  );
  const result = await db.query<Record<string, unknown>>(
    `SELECT id::text, item_kind, code, name, grade, priority, action, trigger_kind,
            price_lower, price_upper, headline, auction_md, intraday_md, evidence_md,
            missing_md, invalidation_md, risk_md, key_levels, t_plan, strategy_code,strategy_runtime_version,
            primary_evaluation_run_id::text,fallback_evaluation_run_id::text,primary_action,fallback_action,
            effective_action,evaluation_status,evaluation_data_date::text,evaluation_missing,target_date::text
       FROM daily_plan_playbook
      WHERE plan_output_id = $1 AND status <> 'draft'
      ORDER BY priority, id LIMIT 100 OFFSET $2`,
    [outputId, offset],
  );
  const total = count.rows[0]!.count;
  const next = offset + result.rows.length;
  return {
    output_id: outputId, total_count: total, returned_count: result.rows.length,
    offset, complete: next >= total, next_offset: next < total ? next : null,
    instruction: "这是该任务结果保存时的结构化持仓预案或独立收盘打板候选；各策略分数不可跨口径直接比较。没有结构化行不等于没有信号。",
    items: result.rows.map(toRow),
  };
}

/** 最新一份每日计划的激活预案；没有计划或计划无结构化数据时抛 404。 */
export async function getLatestDailyPlanBoard(pool: Db, accountId = "1"): Promise<DailyPlanBoard> {
  const outputs = await pool.query<{ id: string; target_date: string; status: string; created_at: string }>(
    `SELECT output.id::text, output.target_date::text, output.status, output.created_at::text
       FROM job_run_output output
       JOIN job_definition definition ON definition.id = output.job_id
      LEFT JOIN job_run run ON run.id = output.run_id
      WHERE definition.code = 'daily_plan_flow' AND COALESCE(run.account_id,output.account_id,1) = $1
      ORDER BY output.id DESC
      LIMIT 1`,
    [accountId],
  );
  const output = outputs.rows[0];
  if (!output) throw apiErrors.notFound("尚无每日交易计划");

  const items = await pool.query<Record<string, unknown>>(
    `SELECT item.id, item.item_kind, item.code, item.name, item.grade, item.priority,
            item.action, item.trigger_kind, item.price_lower, item.price_upper,
            item.headline, item.auction_md, item.intraday_md, item.evidence_md,
            item.missing_md, item.invalidation_md, item.risk_md, item.key_levels, item.t_plan,
            item.strategy_code,item.strategy_runtime_version,
            item.primary_evaluation_run_id::text,item.fallback_evaluation_run_id::text,item.primary_action,item.fallback_action,
            item.effective_action,item.evaluation_status,item.evaluation_data_date::text,item.evaluation_missing,item.target_date::text,
            assessment.id::text AS auction_assessment_id,
            assessment.assessment_output_id::text AS auction_output_id,
            assessment.conclusion AS auction_conclusion,
            assessment.review_type AS auction_review_type,
            assessment.metrics_summary AS auction_metrics_summary,
            assessment.assessment_summary AS auction_assessment_summary,
            assessment.benchmark_tags AS auction_benchmark_tags,
            assessment.data_status AS auction_data_status,
            assessment.data_time::text AS auction_data_time,
            assessment.updated_at::text AS auction_assessed_at
       FROM daily_plan_playbook item
       LEFT JOIN daily_plan_auction_assessment assessment
         ON assessment.playbook_item_id = item.id AND assessment.status = 'active'
        AND assessment.account_id = item.account_id
      WHERE item.plan_output_id = $1 AND item.account_id = $2 AND item.status = 'active' AND item.item_kind='position_action'
      ORDER BY item.priority ASC, item.id ASC`,
    [output.id, accountId],
  );
  const rows = items.rows.map(toRow);
  const scenarios = await pool.query<{
    id: string;
    playbook_item_id: string;
    scenario_kind: DailyPlanScenarioKind;
    observable_md: string;
    response_md: string;
    invalidation_md: string;
  }>(
    `SELECT scenario.id::text, scenario.playbook_item_id::text, scenario.scenario_kind,
            scenario.observable_md, scenario.response_md, scenario.invalidation_md
       FROM daily_plan_scenario scenario
       JOIN daily_plan_playbook item ON item.id = scenario.playbook_item_id
      WHERE item.plan_output_id = $1 AND item.account_id = $2 AND item.status = 'active' AND item.item_kind = 'position_action'`,
    [output.id, accountId],
  );
  const scenariosByItem = new Map<string, DailyPlanScenarioRow[]>();
  for (const scenario of scenarios.rows) {
    const { playbook_item_id, ...rest } = scenario;
    scenariosByItem.set(playbook_item_id, [...(scenariosByItem.get(playbook_item_id) ?? []), rest]);
  }
  for (const row of rows) {
    row.scenarios = (scenariosByItem.get(row.id) ?? []).sort(
      (left, right) => DAILY_PLAN_SCENARIO_ORDER[left.scenario_kind] - DAILY_PLAN_SCENARIO_ORDER[right.scenario_kind],
    );
  }
  return {
    plan: {
      output_id: output.id,
      target_date: output.target_date,
      status: output.status,
      created_at: output.created_at,
    },
    position_actions: rows.filter((row) => row.item_kind === "position_action"),
    opportunities: rows.filter((row) => row.item_kind === "off_pool_opportunity"),
  };
}

function compactPlaybookItem(item: PlaybookItemRow) {
  return {
    code: item.code,
    name: item.name,
    grade: item.grade,
    priority: item.priority,
    action: item.action,
    trigger_kind: item.trigger_kind,
    price_lower: item.price_lower,
    price_upper: item.price_upper,
    headline: item.headline,
    auction_md: item.auction_md,
    evidence_md: item.evidence_md,
    missing_md: item.missing_md,
    invalidation_md: item.invalidation_md,
    risk_md: item.risk_md,
  };
}

/** 独立收盘打板任务最新结构化机会；空结果保留任务日期，旧每日计划机会不回退。 */
export async function getLatestLimitUpOpportunities(db: Db) {
  const result = await db.query<{ id: string; target_date: string; status: string; created_at: string; run_status: string }>(
    `SELECT output.id::text,output.target_date::text,output.status,output.created_at::text,
            run.status AS run_status
       FROM job_run_output output JOIN job_definition job ON job.id=output.job_id
       JOIN job_run run ON run.id=output.run_id
      WHERE job.code='limit_up_close_scan'
      ORDER BY output.id DESC LIMIT 1`,
  );
  const output = result.rows[0];
  if (!output || output.run_status !== "success" || !["generated", "approved"].includes(output.status))
    throw apiErrors.notFound("尚无有效的收盘打板机会扫描结果");
  const rows = await db.query<Record<string, unknown>>(
    `SELECT item.id::text,item.item_kind,item.code,item.name,item.grade,item.priority,
            item.action,item.trigger_kind,item.price_lower,item.price_upper,item.headline,
            item.auction_md,item.intraday_md,item.evidence_md,item.missing_md,item.invalidation_md,
            item.risk_md,item.strategy_code,item.strategy_runtime_version,
            item.primary_evaluation_run_id::text,item.fallback_evaluation_run_id::text,
            item.primary_action,item.fallback_action,item.effective_action,item.evaluation_status,
            item.evaluation_data_date::text,item.evaluation_missing,item.target_date::text,
            assessment.id::text AS auction_assessment_id,
            assessment.assessment_output_id::text AS auction_output_id,
            assessment.conclusion AS auction_conclusion,
            assessment.review_type AS auction_review_type,
            assessment.metrics_summary AS auction_metrics_summary,
            assessment.assessment_summary AS auction_assessment_summary,
            assessment.benchmark_tags AS auction_benchmark_tags,
            assessment.data_status AS auction_data_status,
            assessment.data_time::text AS auction_data_time,
            assessment.updated_at::text AS auction_assessed_at
       FROM daily_plan_playbook item
       LEFT JOIN daily_plan_auction_assessment assessment
         ON assessment.playbook_item_id=item.id AND assessment.status='active'
       WHERE item.plan_output_id=$1 AND item.item_kind='off_pool_opportunity' AND item.status='active'
       ORDER BY item.priority,item.id`, [output.id],
  );
  return { plan: { output_id: output.id, target_date: output.target_date, status: output.status, created_at: output.created_at },
    opportunities: rows.rows.map(toRow) };
}

/** 集合竞价任务的完整紧凑输入；覆盖候选全集，但不返回无关池属性或历史正文。 */
export async function queryAuctionAssessmentContext(db: Db, targetDate: string, accountId = "1") {
  const calendarResult = await db.query<{ is_open: boolean }>(
      "SELECT is_open FROM market_trading_day WHERE trade_date = $1::date",
      [targetDate],
    );
  const previousOpenResult = await db.query<{ trade_date: string | null }>(
      `SELECT max(trade_date)::text AS trade_date
         FROM market_trading_day
        WHERE trade_date < $1::date AND is_open = true`,
      [targetDate],
    );
  const outputResult = await db.query<{ id: string; target_date: string; status: string; created_at: string }>(
      `SELECT output.id::text, output.target_date::text, output.status, output.created_at::text
         FROM job_run_output output
         JOIN job_definition definition ON definition.id = output.job_id
        LEFT JOIN job_run run ON run.id=output.run_id
        WHERE definition.code = 'daily_plan_flow' AND COALESCE(run.account_id,output.account_id,1)=$1
        ORDER BY output.id DESC LIMIT 1`,
      [accountId],
    );
  const opportunityOutputResult = await db.query<{ id: string; target_date: string; status: string; run_status: string }>(
    `SELECT output.id::text,output.target_date::text,output.status,run.status AS run_status
       FROM job_run_output output JOIN job_definition job ON job.id=output.job_id
       JOIN job_run run ON run.id=output.run_id WHERE job.code='limit_up_close_scan'
       ORDER BY output.id DESC LIMIT 1`,
  );
  const opportunityOutput = opportunityOutputResult.rows[0] ?? null;
  const positions = await listPositions(db, accountId);
  const poolResult = await db.query<{
      code: string;
      name: string;
      pool: "watch";
      role: string;
      attention: Array<{ id: string; strategy_code: string | null; strategy_name: string | null; source_job: string; status: string; reason: string; missing_signals: string[]; stale_reason: string | null }>;
    }>(
      `SELECT instrument.code, instrument.name, membership.pool, membership.role,
              COALESCE(attention.entries, '[]'::jsonb) AS attention
         FROM pool_membership membership
         JOIN market_instrument instrument ON instrument.id = membership.instrument_id
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object('id',entry.id::text,'strategy_code',entry.strategy_code,
                  'strategy_name',strategy.name,'source_job',entry.source_job,'status',entry.status,
                  'reason',entry.reason,'missing_signals',entry.missing_signals,'stale_reason',entry.stale_reason)
                            ORDER BY entry.strategy_code NULLS LAST,entry.source_job) AS entries
             FROM pool_attention_entry entry
             LEFT JOIN strategy_definition strategy ON strategy.code=entry.strategy_code
            WHERE entry.instrument_id = membership.instrument_id
              AND entry.valid_from <= $1::date
              AND (entry.valid_until IS NULL OR entry.valid_until >= $1::date)
         ) attention ON true
        WHERE membership.effective_to IS NULL
        ORDER BY membership.pool, instrument.code`,
      [targetDate],
    );

  const calendarRow = calendarResult.rows[0];
  const weekday = isWeekdayDate(targetDate);
  const marketDayStatus = calendarRow
    ? calendarRow.is_open ? "open" as const : "closed" as const
    : weekday ? "missing_weekday" as const : "missing_weekend" as const;
  const shouldRun = calendarRow?.is_open ?? weekday;
  const previousOpenDate = previousOpenResult.rows[0]?.trade_date ?? null;
  const output = outputResult.rows[0] ?? null;
  const itemResult = output
    ? await db.query<Record<string, unknown>>(
        `SELECT item.id, item.item_kind, item.code, item.name, item.grade, item.priority,
                item.action, item.trigger_kind, item.price_lower, item.price_upper,
                item.headline, item.auction_md, item.intraday_md, item.evidence_md,
                item.missing_md, item.invalidation_md, item.risk_md, item.target_date::text
           FROM daily_plan_playbook item
          WHERE item.plan_output_id = $1 AND item.status = 'active'
          ORDER BY item.priority, item.id`,
        [output.id],
      )
    : { rows: [] as Record<string, unknown>[] };
  const playbookItems = itemResult.rows.map(toRow);
  const positionActions = playbookItems.filter((item) => item.item_kind === "position_action");
  const opportunityRows = opportunityOutput ? await db.query<Record<string, unknown>>(
    `SELECT item.id::text,item.item_kind,item.code,item.name,item.grade,item.priority,item.action,item.trigger_kind,
            item.price_lower,item.price_upper,item.headline,item.auction_md,item.intraday_md,item.evidence_md,
            item.missing_md,item.invalidation_md,item.risk_md,item.target_date::text
       FROM daily_plan_playbook item WHERE item.plan_output_id=$1 AND item.item_kind='off_pool_opportunity'
        AND item.status='active' ORDER BY item.priority,item.id`, [opportunityOutput.id],
  ) : { rows: [] as Record<string, unknown>[] };
  const rawOpportunities = opportunityRows.rows.map(toRow);
  const positionActionByCode = new Map(positionActions.map((item) => [item.code, item]));
  const positionCodes = new Set(positions.map((position) => position.code));
  const poolByCode = new Map(poolResult.rows.map((member) => [member.code, member]));

  let planValidity: "valid" | "missing" | "invalid_status" | "not_before_target" | "expired" | "calendar_unresolved" = "missing";
  if (output) {
    if (["rejected", "superseded"].includes(output.status)) planValidity = "invalid_status";
    else if (output.target_date >= targetDate) planValidity = "not_before_target";
    else if (!previousOpenDate) planValidity = "calendar_unresolved";
    else if (output.target_date < previousOpenDate) planValidity = "expired";
    else planValidity = "valid";
  }

  const gaps: Array<{ scope: string; code?: string; reason: string }> = [];
  if (shouldRun && !previousOpenDate) gaps.push({ scope: "calendar", reason: "缺少目标日前一开市日" });
  if (shouldRun && !output) gaps.push({ scope: "plan", reason: "缺少每日计划" });
  if (shouldRun && (!opportunityOutput || opportunityOutput.run_status !== 'success'
    || opportunityOutput.status === 'rejected' || opportunityOutput.status === 'superseded'
    || !previousOpenDate || opportunityOutput.target_date !== previousOpenDate))
    gaps.push({ scope: "opportunity", reason: "缺少前一开市日的有效收盘打板扫描，不得使用过期候选" });
  if (shouldRun && output && planValidity !== "valid") {
    gaps.push({ scope: "plan", reason: `每日计划不可用于本次竞价：${planValidity}` });
  }
  for (const position of positions) {
    if (!positionActionByCode.has(position.code)) {
      gaps.push({ scope: "position_plan", code: position.code, reason: "当前持仓缺少对应竞价预案" });
    }
  }

  const opportunities = (opportunityOutput?.target_date === previousOpenDate && opportunityOutput.run_status === 'success' &&
    !['rejected','superseded'].includes(opportunityOutput.status) ? rawOpportunities : []).map((item) => {
    const conflict = positionCodes.has(item.code)
      ? "existing_position" as const
      : poolByCode.has(item.code) ? "existing_pool_member" as const : null;
    if (conflict) gaps.push({ scope: "opportunity", code: item.code, reason: `打板候选冲突：${conflict}` });
    return { ...compactPlaybookItem(item), target_key: `board:${item.id}`, conflict };
  });
  // 关注池多来源条目：同一标的多来源并列，不合成统一原因；已持仓标的不进入自动关注。
  const attentions = poolResult.rows
    .filter((member) => member.attention.length > 0)
    .filter((member) => !positionCodes.has(member.code))
    .flatMap((member) => member.attention.map((entry) => ({
      target_key: `attention:${entry.id}`,
      attention_entry_id: entry.id,
      code: member.code,
      name: member.name,
      pool: member.pool,
      role: member.role,
      ...entry,
    })));
  const intradayLadderResult = previousOpenDate ? await db.query<{ signal_id: string; code: string; name: string; reason: string; evidence: Record<string, unknown>; valid_from: string; evaluation_run_id: string }>(
    `SELECT signal.id::text AS signal_id,instrument.code,instrument.name,signal.reason,signal.evidence,
            signal.valid_from::text,run.id::text AS evaluation_run_id
       FROM strategy_entry_signal signal
       JOIN strategy_evaluation_run run ON run.id=signal.run_id
       JOIN market_instrument instrument ON instrument.id=signal.instrument_id
      WHERE signal.run_id=(
        SELECT id FROM strategy_evaluation_run
         WHERE strategy_code='first_board_advance' AND phase='entry' AND target_date=$1::date
           AND status IN ('success','partial')
         ORDER BY created_at DESC,id DESC LIMIT 1
      ) AND signal.signal_status='qualified'
      ORDER BY signal.id`, [previousOpenDate]) : { rows: [] as Array<{ signal_id: string; code: string; name: string; reason: string; evidence: Record<string, unknown>; valid_from: string; evaluation_run_id: string }> };
  const intradayLadderCandidates = intradayLadderResult.rows.map((item) => ({
    ...item, target_key: `ladder:${item.signal_id}`, strategy_code: 'first_board_advance',
  }));
  const positionItems = positions.map((position) => ({
    target_key: `position:${position.code}`,
    code: position.code,
    name: position.name,
    strategy_code: position.strategy_code,
    strategy_name: position.strategy_name,
    quantity: position.quantity,
    cost_price: position.cost_price,
    close: position.close,
    close_date: position.close_date,
    plan_action: positionActionByCode.has(position.code)
      ? compactPlaybookItem(positionActionByCode.get(position.code)!)
      : null,
  }));
  const ladderRows = previousOpenDate ? (await db.query<{
    code: string; name: string; streak_count: number;
  }>(`SELECT instrument.code,instrument.name,event.streak_count
        FROM market_limit_event event JOIN market_instrument instrument ON instrument.id=event.instrument_id
       WHERE event.trade_date=$1::date AND event.event_type='up' AND event.streak_count IS NOT NULL
         AND COALESCE(event.is_st,false)=false AND COALESCE(event.is_new,false)=false
         AND instrument.code ~ '^(600|601|603|605|000|001|002|003)'
       ORDER BY event.streak_count DESC,instrument.code`, [previousOpenDate])).rows : [];
  const maxStreak = ladderRows[0]?.streak_count ?? 0;
  const highestBoard = ladderRows.filter((item) => item.streak_count === maxStreak);
  const streakByCode = new Map(ladderRows.map((item) => [item.code, item.streak_count]));
  const progressionCandidates = [...opportunities.map((item) => ({ code: item.code, name: item.name, source: 'limit_up_relay' })),
    ...intradayLadderCandidates.map((item) => ({ code: item.code, name: item.name, source: 'first_board_advance' }))]
    .map((item) => ({ ...item, source_streak: streakByCode.get(String(item.code)) ?? null,
      target_streak: (streakByCode.get(String(item.code)) ?? 0) + 1 }))
    .filter((item) => item.source_streak !== null);
  const limitLadderPk = {
    data_date: previousOpenDate,
    max_streak: maxStreak,
    highest_board: highestBoard,
    progression_candidates: progressionCandidates,
    relevant_candidates: progressionCandidates.filter((item) => item.source_streak! >= 3 && item.target_streak >= Math.max(4,maxStreak-1)),
  };
  const candidateCodes = [...new Set([
    ...positionItems.map((item) => item.code),
    ...attentions.map((item) => item.code),
    ...opportunities.map((item) => item.code),
    ...intradayLadderCandidates.map((item) => String(item.code)),
    ...highestBoard.map((item) => item.code),
  ])].sort();
  const relevantStrategies = [...new Set([
    ...positions.map((position) => position.strategy_code),
    ...attentions.map((item) => item.strategy_code),
    ...intradayLadderCandidates.map(() => 'first_board_advance'),
    'limit_up',
  ].filter((code): code is string => Boolean(code)))];
  const documents = await db.query<{ code: string }>(
    `SELECT DISTINCT document.code FROM strategy_document document
      LEFT JOIN strategy_definition strategy ON strategy.strategy_document_code=document.code
     WHERE document.role='portfolio' OR strategy.code=ANY($1::text[])
     ORDER BY document.code`, [relevantStrategies],
  );

  return {
    requested_date: targetDate,
    status: gaps.length === 0 ? "success" as const : "partial" as const,
    market_day: {
      status: marketDayStatus,
      should_run: shouldRun,
      previous_open_date: previousOpenDate,
    },
    plan: output ? {
      output_id: output.id,
      target_date: output.target_date,
      status: output.status,
      created_at: output.created_at,
      validity: planValidity,
    } : null,
    coverage: {
      position_count: positionItems.length,
      position_plan_count: positionItems.filter((item) => item.plan_action !== null).length,
      attention_count: attentions.length,
      opportunity_count: opportunities.length,
      intraday_ladder_count: intradayLadderCandidates.length,
      required_scope_keys: [...positionItems.map((item) => item.target_key), ...attentions.map((item) => item.target_key), ...intradayLadderCandidates.map((item) => item.target_key)],
      candidate_count: candidateCodes.length,
    },
    candidate_codes: candidateCodes,
    required_strategy_documents: documents.rows.map((row) => row.code),
    positions: positionItems,
    attentions,
    opportunities,
    intraday_ladder_candidates: intradayLadderCandidates,
    limit_ladder_pk: limitLadderPk,
    gaps,
  };
}

/** 最新成功竞价任务对持仓和各策略关注来源的结构化研判；打板仍从每日计划机会读取。 */
export async function getLatestAuctionScopeAssessments(db: Db, accountId: string | null = "1") {
  const output = await db.query<{ id: string; target_date: string }>(
    `SELECT output.id::text,output.target_date::text FROM job_run_output output
      JOIN job_definition definition ON definition.id=output.job_id
     JOIN job_run run ON run.id=output.run_id
     WHERE definition.code='auction_opportunity_assessment' AND ($1::bigint IS NULL OR COALESCE(run.account_id,output.account_id,1)=$1) AND output.status IN ('generated','approved')
     ORDER BY output.id DESC LIMIT 1`,
    [accountId],
  );
  if (!output.rows[0]) throw apiErrors.notFound("尚无竞价研判结果");
  const rows = await db.query<{
    id: string; target_key: string; scope_kind: string; code: string; name: string;
    attention_entry_id: string | null; strategy_code: string | null; strategy_name: string | null;
    conclusion: string; metrics_summary: string; assessment_summary: string;
    data_status: string; data_time: string | null;
  }>(`SELECT assessment.id::text,assessment.target_key,assessment.scope_kind,instrument.code,instrument.name,
             assessment.attention_entry_id::text,assessment.strategy_code,strategy.name AS strategy_name,
             assessment.conclusion,assessment.metrics_summary,assessment.assessment_summary,
             assessment.data_status,assessment.data_time::text
        FROM auction_scope_assessment assessment
        JOIN market_instrument instrument ON instrument.id=assessment.instrument_id
        LEFT JOIN strategy_definition strategy ON strategy.code=assessment.strategy_code
       WHERE assessment.assessment_output_id=$1 AND assessment.status='active'
         AND ($2::boolean = false OR assessment.scope_kind <> 'position')
       ORDER BY assessment.scope_kind,instrument.code,assessment.target_key`, [output.rows[0].id, accountId === null]);
  return { output_id: output.rows[0].id, target_date: output.rows[0].target_date, items: rows.rows };
}
