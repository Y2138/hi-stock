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
           (source_job_run_id, playbook_item_id, code, conclusion, review_type, metrics_summary,
            assessment_summary, benchmark_tags, data_status, data_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
  const run = await db.query<{ code: string; target_date: string; is_open: boolean | null }>(
    `SELECT definition.code, run.target_date::text, calendar.is_open
       FROM job_run run
       JOIN job_definition definition ON definition.id = run.job_id
       LEFT JOIN market_trading_day calendar ON calendar.trade_date = run.target_date
      WHERE run.id = $1`,
    [sourceJobRunId],
  );
  const runRow = run.rows[0];
  if (runRow?.code !== "auction_opportunity_assessment") return 0;
  const isOpen = runRow.is_open ?? isWeekdayDate(runRow.target_date);

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
  if (isOpen && (
    expectedIds.length !== draftIds.length
    || expectedIds.some((id, index) => id !== draftIds[index])
  )) {
    throw new Error(`集合竞价任务未完整回写打板机会：期望 ${expectedIds.length}，实际 ${draftIds.length}`);
  }
  if (!isOpen && draftIds.length > 0) {
    throw new Error("非交易日不得激活集合竞价判断");
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

/** 按不可变结果 ID 读取历史预案；保留已被替代的历史，不混入后续竞价判断。 */
export async function queryHistoricalPlanItems(db: Db, outputId: string, offset = 0) {
  const count = await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM daily_plan_playbook WHERE plan_output_id = $1 AND status <> 'draft'",
    [outputId],
  );
  const result = await db.query<Record<string, unknown>>(
    `SELECT id::text, item_kind, code, name, grade, priority, action, trigger_kind,
            price_lower, price_upper, headline, auction_md, intraday_md, evidence_md,
            missing_md, invalidation_md, risk_md, target_date::text
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
    instruction: "这是该结果保存时的持仓预案和打板机会；短线与波段信号见同一结果正文。priority仅为计划内顺序，各策略分数不可跨口径直接比较。没有结构化行不等于没有信号。",
    items: result.rows.map(toRow),
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

/** 集合竞价任务的完整紧凑输入；覆盖候选全集，但不返回无关池属性或历史正文。 */
export async function queryAuctionAssessmentContext(db: Db, targetDate: string) {
  const [calendarResult, previousOpenResult, outputResult, positions, poolResult] = await Promise.all([
    db.query<{ is_open: boolean }>(
      "SELECT is_open FROM market_trading_day WHERE trade_date = $1::date",
      [targetDate],
    ),
    db.query<{ trade_date: string | null }>(
      `SELECT max(trade_date)::text AS trade_date
         FROM market_trading_day
        WHERE trade_date < $1::date AND is_open = true`,
      [targetDate],
    ),
    db.query<{ id: string; target_date: string; status: string; created_at: string }>(
      `SELECT output.id::text, output.target_date::text, output.status, output.created_at::text
         FROM job_run_output output
         JOIN job_definition definition ON definition.id = output.job_id
        WHERE definition.code = 'daily_plan_flow'
        ORDER BY output.id DESC LIMIT 1`,
    ),
    listPositions(db),
    db.query<{
      code: string;
      name: string;
      pool: "short" | "long";
      role: string;
      attention_reason: string | null;
      attention_from: string | null;
      attention_until: string | null;
    }>(
      `SELECT instrument.code, instrument.name, membership.pool, membership.role,
              membership.attention_reason, membership.attention_from::text, membership.attention_until::text
         FROM pool_membership membership
         JOIN market_instrument instrument ON instrument.id = membership.instrument_id
        WHERE membership.effective_to IS NULL
        ORDER BY membership.pool, instrument.code`,
    ),
  ]);

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
  const rawOpportunities = playbookItems.filter((item) => item.item_kind === "off_pool_opportunity");
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
  if (shouldRun && output && planValidity !== "valid") {
    gaps.push({ scope: "plan", reason: `每日计划不可用于本次竞价：${planValidity}` });
  }
  for (const position of positions) {
    if (!positionActionByCode.has(position.code)) {
      gaps.push({ scope: "position_plan", code: position.code, reason: "当前持仓缺少对应竞价预案" });
    }
  }

  const opportunities = rawOpportunities.map((item) => {
    const conflict = positionCodes.has(item.code)
      ? "existing_position" as const
      : poolByCode.has(item.code) ? "existing_pool_member" as const : null;
    if (conflict) gaps.push({ scope: "opportunity", code: item.code, reason: `打板候选冲突：${conflict}` });
    return { ...compactPlaybookItem(item), conflict };
  });
  const attentions = poolResult.rows
    .filter((member) => member.attention_reason !== null)
    .filter((member) => !member.attention_from || member.attention_from <= targetDate)
    .filter((member) => !member.attention_until || member.attention_until >= targetDate)
    .filter((member) => !positionCodes.has(member.code))
    .map((member) => ({
      code: member.code,
      name: member.name,
      pool: member.pool,
      role: member.role,
      attention_reason: member.attention_reason,
      attention_from: member.attention_from,
      attention_until: member.attention_until,
    }));
  const positionItems = positions.map((position) => ({
    code: position.code,
    name: position.name,
    quantity: position.quantity,
    cost_price: position.cost_price,
    close: position.close,
    close_date: position.close_date,
    plan_action: positionActionByCode.has(position.code)
      ? compactPlaybookItem(positionActionByCode.get(position.code)!)
      : null,
  }));
  const candidateCodes = [...new Set([
    ...positionItems.map((item) => item.code),
    ...attentions.map((item) => item.code),
    ...opportunities.map((item) => item.code),
  ])].sort();

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
      candidate_count: candidateCodes.length,
    },
    candidate_codes: candidateCodes,
    positions: positionItems,
    attentions,
    opportunities,
    gaps,
  };
}
