// 宏观与研究因子读取：按 published_at 取点时可见值，口径只在这里收敛。
// 业务写入口在 datasource/commodity-service.ts；本模块只读。
import type pg from "pg";

export type Db = Pick<pg.Pool, "query">;

export interface MacroFactorQueryInput {
  /** 省略时返回全部 active 序列。 */
  seriesCodes?: string[];
  /** 报告期下界（period_end >= start）。 */
  start?: string;
  /** 报告期上界（period_end <= end）。 */
  end?: string;
  /** 观察时点（yyyy-MM-dd，东八区）；只返回该日结束前已发布的版本，默认今天。 */
  asOf?: string;
}

export interface MacroFactorObservation {
  period_end: string;
  value: number;
  /** 东八区发布时间，精确到秒。 */
  published_at: string;
  revision_no: number;
  /** true 表示发布时间是历史回补的合成假设，不是上游真实发布日期。 */
  synthetic_initial_published_at: boolean;
}

export interface MacroFactorSeriesView {
  series_code: string;
  market: string | null;
  metric_code: string;
  frequency: string;
  unit: string;
  source: string;
  revision_policy: string;
  observations: MacroFactorObservation[];
  latest_period: string | null;
  latest_value: number | null;
  latest_published_at: string | null;
}

export interface MacroFactorQueryResult {
  as_of: string;
  series: MacroFactorSeriesView[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 东八区当前日期；服务端不依赖宿主时区。 */
export function shanghaiDate(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

function assertDate(value: string | undefined, field: string): void {
  if (value === undefined) return;
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${field} 必须为YYYY-MM-DD：${value}`);
  }
}

/**
 * 查询宏观因子序列。
 *
 * 同一报告期可能有多次修订：只取 `published_at < as_of + 1 天` 中发布时间最新的一版，
 * 因此不同 as_of 看到的值可以不同，不会把后来修订回填到更早的时点。
 */
export async function queryMacroFactors(
  db: Db,
  input: MacroFactorQueryInput = {},
): Promise<MacroFactorQueryResult> {
  const asOf = input.asOf ?? shanghaiDate();
  assertDate(asOf, "as_of");
  assertDate(input.start, "start_date");
  assertDate(input.end, "end_date");
  if (input.start && input.end && input.end < input.start) throw new Error("end_date 不得早于 start_date");
  if (input.seriesCodes && input.seriesCodes.length === 0) throw new Error("series_codes 不能为空数组");

  const seriesResult = await db.query<{
    series_code: string; market: string | null; metric_code: string; frequency: string;
    unit: string; source: string; revision_policy: string;
  }>(
    `SELECT series_code,market,metric_code,frequency,unit,source,revision_policy
       FROM market_factor_series
      WHERE active AND ($1::text[] IS NULL OR series_code=ANY($1::text[]))
      ORDER BY series_code`,
    [input.seriesCodes ?? null],
  );

  const observations = (await db.query<{
    series_code: string; period_end: string; value: number; published_at: string;
    revision_no: number; synthetic: boolean;
  }>(
    `WITH ranked AS (
       SELECT series.series_code,observation.period_end::text period_end,
              observation.value::float8 value,
              to_char(observation.published_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD"T"HH24:MI:SS') published_at,
              observation.revision_no,
              COALESCE((observation.raw_summary->>'synthetic_initial_published_at')::boolean,false) synthetic,
              row_number() OVER(PARTITION BY series.series_code,observation.period_end
                                ORDER BY observation.published_at DESC,observation.revision_no DESC) rn
         FROM market_factor_observation observation
         JOIN market_factor_series series ON series.id=observation.series_id
        WHERE series.active
          AND observation.published_at < $1::date + interval '1 day'
          AND ($2::date IS NULL OR observation.period_end >= $2::date)
          AND ($3::date IS NULL OR observation.period_end <= $3::date)
          AND ($4::text[] IS NULL OR series.series_code=ANY($4::text[])))
     SELECT series_code,period_end,value,published_at,revision_no,synthetic
       FROM ranked WHERE rn=1 ORDER BY series_code,period_end`,
    [asOf, input.start ?? null, input.end ?? null, input.seriesCodes ?? null],
  )).rows;

  const byCode = new Map<string, MacroFactorObservation[]>();
  for (const row of observations) {
    const list = byCode.get(row.series_code) ?? [];
    list.push({
      period_end: row.period_end,
      value: Number(row.value),
      published_at: row.published_at,
      revision_no: row.revision_no,
      synthetic_initial_published_at: row.synthetic,
    });
    byCode.set(row.series_code, list);
  }

  return {
    as_of: asOf,
    series: seriesResult.rows.map((series) => {
      const list = byCode.get(series.series_code) ?? [];
      const last = list.at(-1) ?? null;
      return {
        ...series,
        observations: list,
        latest_period: last?.period_end ?? null,
        latest_value: last?.value ?? null,
        latest_published_at: last?.published_at ?? null,
      };
    }),
  };
}
