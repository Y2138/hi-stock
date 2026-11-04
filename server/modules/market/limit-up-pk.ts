import type pg from "pg";

export interface LimitUpPkInput {
  code: string;
  streak: number;
  seal: number | null;
  maxSeal: number | null;
  turnover: number | null;
  minute: number | null;
  volumeRatio: number | null;
  oneWord: boolean | null;
  core: number | null;
  phase: "close" | "intraday";
}

export interface LimitUpPkProfile {
  stage: "first_board" | "confirmation" | "high_board";
  status: "review" | "observe_only" | "insufficient";
  seal_turnover_ratio: number | null;
  seal_retention: number | null;
  volume_ratio_prev: number | null;
  one_word: boolean | null;
  execution: "review_auction" | "queue_uncertain" | "unknown";
  flags: string[];
}

const positive = (v: number | null) => v !== null && Number.isFinite(v) && v > 0;

/** 研究分桶只标记风险；不把本期关联写成晋级概率或自动买入条件。 */
export function limitUpPkProfile(input: LimitUpPkInput): LimitUpPkProfile {
  const validSeal = input.seal !== null && Number.isFinite(input.seal) && input.seal >= 0;
  const ratio = validSeal && positive(input.turnover) ? input.seal! / input.turnover! : null;
  const retention = validSeal && positive(input.maxSeal)
    ? Math.min(1, input.seal! / input.maxSeal!) : null;
  const flags: string[] = [];
  const insufficient = ratio === null || input.minute === null || !Number.isFinite(input.minute) || input.oneWord === null;
  if (insufficient) flags.push("封单、成交额、首次封板或价格形态缺失，不能确定数据首位");
  if (retention === null) flags.push("最大封单缺失，封单保持率待核实");
  // 盘中累计成交量不能与前日全天量直接比较为“缩量”。
  const volumeRatio = input.phase === "close" && positive(input.volumeRatio) ? input.volumeRatio : null;
  const historyMissing = input.phase === "close" && input.streak >= 2 && volumeRatio === null;
  if (historyMissing) flags.push("前一开市日成交量缺失，承接变化待核实，仅观察");
  const deterioration = input.streak >= 3 && volumeRatio !== null && volumeRatio >= 2 && ratio !== null && ratio < 0.1;
  if (deterioration) flags.push("高位放量弱封：成交量至少为前日2倍且封单/成交额不足10%，仅观察");
  const weakSeal = ratio !== null && ratio < 0.05;
  if (weakSeal) flags.push("封单/成交额不足5%，买单覆盖偏弱，仅观察");
  if (input.oneWord) flags.push("一字强势与可成交收益分开，开板后被动成交风险");
  if (input.minute !== null && input.minute > 120) flags.push("午后首次封板，需解释晚封原因");
  return {
    stage: input.streak === 1 ? "first_board" : input.streak <= 3 ? "confirmation" : "high_board",
    status: insufficient ? "insufficient" : deterioration || weakSeal || historyMissing ? "observe_only" : "review",
    seal_turnover_ratio: ratio, seal_retention: retention, volume_ratio_prev: volumeRatio,
    one_word: input.oneWord,
    execution: input.oneWord === null ? "unknown" : input.oneWord ? "queue_uncertain" : "review_auction",
    flags,
  };
}

export interface LimitUpPkCandidate {
  code: string;
  streak_count: number;
  pk: LimitUpPkProfile;
  pk_minute: number | null;
  pk_turnover: number | null;
  pk_core: number | null;
}

/** 同高度数据排序，消息和情绪由当次证据复核；代码只稳定显示，不用于判胜。 */
export function compareLimitUpPk(a: LimitUpPkCandidate, b: LimitUpPkCandidate): number {
  const status = { review: 0, observe_only: 1, insufficient: 2 };
  return status[a.pk.status] - status[b.pk.status]
    || (b.pk.seal_turnover_ratio ?? -1) - (a.pk.seal_turnover_ratio ?? -1)
    || (b.pk.seal_retention ?? -1) - (a.pk.seal_retention ?? -1)
    || (a.pk_minute ?? Number.MAX_VALUE) - (b.pk_minute ?? Number.MAX_VALUE)
    || (b.pk_core ?? -1) - (a.pk_core ?? -1)
    || (a.pk_turnover ?? Number.MAX_VALUE) - (b.pk_turnover ?? Number.MAX_VALUE);
}

export function sameHeightPkGroups<T extends LimitUpPkCandidate>(candidates: T[]) {
  const heights = [...new Set(candidates.map((item) => item.streak_count))].sort((a, b) => a - b);
  return heights.map((height) => {
    const peers = candidates.filter((item) => item.streak_count === height)
      .sort((a, b) => compareLimitUpPk(a, b) || a.code.localeCompare(b.code));
    const first = peers[0]!;
    const tied = peers.length > 1 && compareLimitUpPk(first, peers[1]!) === 0;
    return {
      source_streak: height, target_streak: height + 1, stage: first.pk.stage,
      peer_codes: peers.map((item) => item.code),
      data_leader: first.pk.status === "review" && !tied ? first.code : null,
      participation_leader: (() => {
        const executable = peers.filter((item) => item.pk.status === "review" && item.pk.execution === "review_auction");
        return executable[0] && (!executable[1] || compareLimitUpPk(executable[0], executable[1]) !== 0)
          ? executable[0].code : null;
      })(),
      conclusion: first.pk.status !== "review" ? "无可复核数据首位" : tied ? "数据并列，不能凭代码判胜" : "数据首位待消息、情绪及竞价复核",
      required_comparison: ["同高度竞争者与题材角色", "买单覆盖和承接变化", "最高板与断板负反馈", "消息的新旧、直接受益、真伪和利空", "开盘价格与可成交性"],
    };
  });
}

/** 仅取当时已发布且已抓取的消息。未覆盖不等于利空，更不能补造利好。 */
export async function limitUpPkNews(db: Pick<pg.Pool, "query">, codes: string[], asOf: string) {
  const rows = (await db.query<{
    code: string | null; title: string; direction: string; source_url: string; source_level: string;
    published_at: string; fetched_at: string; scope: string; relation_type: string;
  }>(`SELECT i.code,n.title,n.direction,n.source_url,n.source_level,n.published_at::text,n.fetched_at::text,n.scope,n.relation_type
      FROM market_news_item n JOIN market_news_snapshot s ON s.id=n.snapshot_id
      JOIN job_run r ON r.id=s.run_id
      LEFT JOIN market_news_item_instrument link ON link.item_id=n.id
      LEFT JOIN market_instrument i ON i.id=link.instrument_id
     WHERE r.status IN ('success','partial') AND n.published_at <= $2::timestamptz
       AND n.published_at >= $2::timestamptz-interval '48 hours' AND n.fetched_at <= $2::timestamptz
       AND s.captured_at <= $2::timestamptz AND n.source_level <> 'unverified'
       AND (n.expires_at IS NULL OR n.expires_at > $2::timestamptz)
       AND (i.code=ANY($1::text[]) OR n.scope='market')
     ORDER BY n.published_at DESC,n.id,i.code`, [codes, asOf])).rows;
  return { as_of: asOf, items: rows, uncovered_codes: codes.filter((code) => !rows.some((item) => item.code === code)),
    instruction: "本地消息只作线索；逐只检索并核验原始公告与发布时间，无新消息可如实记载。未知消息不得加分，涨停原因不是公告证据。最终同高度PK必须说明胜者与落选者的差异，证据不足允许无首选。" };
}
