// 每日计划盯防预案：任务会话写入 draft，运行成功后激活并绑定 plan_output_id。
import type pg from "pg";
import { apiErrors } from "../../http/router.js";
import { inServiceTransaction, type TransactionDb } from "../../db/transaction.js";

export type Db = Pick<pg.Pool, "query">;

type PlaybookKind = "position_action" | "off_pool_opportunity";
type PlaybookAction = "exit" | "reduce" | "buy" | "hold" | "observe";
type PlaybookTrigger = "open" | "price_range" | "condition";
export type AuctionConclusion = "worth_entering" | "observe" | "give_up" | "unavailable";
export type AuctionDataStatus = "ready" | "not_ready" | "missing" | "stale";

export interface AuctionAssessmentInput {
  code: string;
  conclusion: AuctionConclusion;
  metrics_summary: string;
  assessment_summary: string;
  benchmark_tags?: string[];
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
    const run = await client.query<{ target_date: string }>(
      `SELECT run.target_date::text
         FROM job_run run
         JOIN job_definition definition ON definition.id = run.job_id
        WHERE run.id = $1 AND definition.code = 'daily_plan_flow'`,
      [input.source_job_run_id],
    );
    if (!run.rows[0]) throw apiErrors.badRequest("预案只能由每日计划任务运行（daily_plan_flow）提交");
    const targetDate = run.rows[0]!.target_date;
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
        WHERE position.quantity > 0`,
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
            headline, auction_md, intraday_md, evidence_md, missing_md, invalidation_md, risk_md)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
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
        ],
      );
    }
    return { replaced: input.items.length };
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
    const source = await client.query<{ code: string }>(
      `SELECT definition.code
         FROM job_run run
         JOIN job_definition definition ON definition.id = run.job_id
        WHERE run.id = $1`,
      [sourceJobRunId],
    );
    if (source.rows[0]?.code !== "daily_plan_flow") return 0;
    const activated = await client.query(
      `UPDATE daily_plan_playbook
          SET status = 'active', plan_output_id = $2, updated_at = now()
        WHERE source_job_run_id = $1 AND status = 'draft'`,
      [sourceJobRunId, planOutputId],
    );
    await client.query(
      `UPDATE daily_plan_playbook
          SET status = 'superseded', updated_at = now()
        WHERE status = 'active'
          AND plan_output_id IS DISTINCT FROM $1
          AND plan_output_id IN (
            SELECT output.id FROM job_run_output output
            JOIN job_definition definition ON definition.id = output.job_id
            WHERE definition.code = 'daily_plan_flow'
          )`,
      [planOutputId],
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

async function latestActiveOpportunityRows(db: Db): Promise<Array<{ id: string; code: string }>> {
  const result = await db.query<{ id: string; code: string }>(
    `SELECT item.id::text, item.code
       FROM daily_plan_playbook item
      WHERE item.plan_output_id = (
              SELECT output.id
                FROM job_run_output output
                JOIN job_definition definition ON definition.id = output.job_id
               WHERE definition.code = 'daily_plan_flow'
               ORDER BY output.id DESC
               LIMIT 1
            )
        AND item.item_kind = 'off_pool_opportunity'
        AND item.status = 'active'
      ORDER BY item.priority, item.id`,
  );
  return result.rows;
}

/** 暂存本次竞价任务对当前全部打板机会的判断；任务成功后统一激活。 */
export async function replaceDraftAuctionAssessments(
  db: TransactionDb,
  input: { source_job_run_id: string; items: AuctionAssessmentInput[] },
): Promise<{ replaced: number }> {
  return inServiceTransaction(db, async (client) => {
    const run = await client.query(
      `SELECT run.id
         FROM job_run run
         JOIN job_definition definition ON definition.id = run.job_id
        WHERE run.id = $1 AND definition.code = 'auction_opportunity_assessment'`,
      [input.source_job_run_id],
    );
    if (!run.rows[0]) throw apiErrors.badRequest("竞价研判只能由 auction_opportunity_assessment 任务提交");

    const opportunities = await latestActiveOpportunityRows(client);
    const expectedCodes = opportunities.map((item) => item.code).sort();
    const submittedCodes = input.items.map((item) => item.code).sort();
    if (new Set(submittedCodes).size !== submittedCodes.length
      || expectedCodes.length !== submittedCodes.length
      || expectedCodes.some((code, index) => code !== submittedCodes[index])) {
      throw apiErrors.badRequest(
        `竞价研判必须完整覆盖当前打板机会：期望 ${expectedCodes.join("、") || "无"}，实际 ${submittedCodes.join("、") || "无"}`,
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
           (source_job_run_id, playbook_item_id, code, conclusion, metrics_summary,
            assessment_summary, benchmark_tags, data_status, data_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.source_job_run_id,
          opportunity.id,
          item.code,
          item.conclusion,
          item.metrics_summary.trim(),
          item.assessment_summary.trim(),
          JSON.stringify(item.benchmark_tags ?? []),
          item.data_status,
          item.data_time ?? null,
        ],
      );
    }
    return { replaced: input.items.length };
  });
}

/** 竞价任务结果与运行终态同事务入账；交易日有打板机会时不允许缺少结构化判断。 */
export async function activateAuctionAssessmentsForRun(
  db: Db,
  sourceJobRunId: string,
  outputId: string | null,
): Promise<number> {
  if (!outputId) return 0;
  const run = await db.query<{ code: string; is_open: boolean | null }>(
    `SELECT definition.code, calendar.is_open
       FROM job_run run
       JOIN job_definition definition ON definition.id = run.job_id
       LEFT JOIN market_trading_day calendar ON calendar.trade_date = run.target_date
      WHERE run.id = $1`,
    [sourceJobRunId],
  );
  if (run.rows[0]?.code !== "auction_opportunity_assessment") return 0;

  const expected = await latestActiveOpportunityRows(db);
  const drafts = await db.query<{ playbook_item_id: string }>(
    `SELECT playbook_item_id::text
       FROM daily_plan_auction_assessment
      WHERE source_job_run_id = $1 AND status = 'draft'
      ORDER BY playbook_item_id`,
    [sourceJobRunId],
  );
  const expectedIds = expected.map((item) => item.id).sort();
  const draftIds = drafts.rows.map((item) => item.playbook_item_id).sort();
  if (run.rows[0].is_open === true && (
    expectedIds.length !== draftIds.length
    || expectedIds.some((id, index) => id !== draftIds[index])
  )) {
    throw new Error(`集合竞价任务未完整回写打板机会：期望 ${expectedIds.length}，实际 ${draftIds.length}`);
  }
  if (run.rows[0].is_open !== true && draftIds.length > 0) {
    throw new Error("非交易日或交易日历缺失时不得激活集合竞价判断");
  }
  if (draftIds.length === 0) return 0;

  await db.query(
    `UPDATE daily_plan_auction_assessment current
        SET status = 'superseded', updated_at = now()
      WHERE current.status = 'active'
        AND current.playbook_item_id = ANY($1::bigint[])`,
    [draftIds],
  );
  const activated = await db.query(
    `UPDATE daily_plan_auction_assessment
        SET status = 'active', assessment_output_id = $2, updated_at = now()
      WHERE source_job_run_id = $1 AND status = 'draft'`,
    [sourceJobRunId, outputId],
  );
  return activated.rowCount ?? 0;
}

export async function discardDraftAuctionAssessmentsForRun(db: Db, sourceJobRunId: string): Promise<number> {
  const result = await db.query(
    "DELETE FROM daily_plan_auction_assessment WHERE source_job_run_id = $1 AND status = 'draft'",
    [sourceJobRunId],
  );
  return result.rowCount ?? 0;
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
    target_date: String(row.target_date),
    auction_assessment: row.auction_assessment_id === null || row.auction_assessment_id === undefined
      ? null
      : {
          id: String(row.auction_assessment_id),
          output_id: row.auction_output_id === null ? null : String(row.auction_output_id),
          code: String(row.code),
          conclusion: String(row.auction_conclusion) as AuctionConclusion,
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

/** 最新一份每日计划的激活预案；没有计划或计划无结构化数据时抛 404。 */
export async function getLatestDailyPlanBoard(pool: Db): Promise<DailyPlanBoard> {
  const outputs = await pool.query<{ id: string; target_date: string; status: string; created_at: string }>(
    `SELECT output.id::text, output.target_date::text, output.status, output.created_at::text
       FROM job_run_output output
       JOIN job_definition definition ON definition.id = output.job_id
      WHERE definition.code = 'daily_plan_flow'
      ORDER BY output.id DESC
      LIMIT 1`,
  );
  const output = outputs.rows[0];
  if (!output) throw apiErrors.notFound("尚无每日交易计划");

  const items = await pool.query<Record<string, unknown>>(
    `SELECT item.id, item.item_kind, item.code, item.name, item.grade, item.priority,
            item.action, item.trigger_kind, item.price_lower, item.price_upper,
            item.headline, item.auction_md, item.intraday_md, item.evidence_md,
            item.missing_md, item.invalidation_md, item.risk_md, item.target_date::text,
            assessment.id::text AS auction_assessment_id,
            assessment.assessment_output_id::text AS auction_output_id,
            assessment.conclusion AS auction_conclusion,
            assessment.metrics_summary AS auction_metrics_summary,
            assessment.assessment_summary AS auction_assessment_summary,
            assessment.benchmark_tags AS auction_benchmark_tags,
            assessment.data_status AS auction_data_status,
            assessment.data_time::text AS auction_data_time,
            assessment.updated_at::text AS auction_assessed_at
       FROM daily_plan_playbook item
       LEFT JOIN daily_plan_auction_assessment assessment
         ON assessment.playbook_item_id = item.id AND assessment.status = 'active'
      WHERE item.plan_output_id = $1 AND item.status = 'active'
      ORDER BY item.priority ASC, item.id ASC`,
    [output.id],
  );
  const rows = items.rows.map(toRow);
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
