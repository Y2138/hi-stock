// 板块温度口径测试：默认集合为同花顺 881 一级行业板块，不再包含 884 二级、概念板块或旧代理指数。
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../server/db/migrate.js";
import { executeAnalysis } from "../../server/analysis/service.js";
import { generateValueMonthlyRank, listValueCandidates, queryValueRank } from "../../server/modules/value-ranking/service.js";
import { queryValueAnchorSignals } from "../../server/modules/plans/value-anchor-signal.js";
import { prepareTestDb, resetSchema } from "./helpers";

const prepared = await prepareTestDb();

interface SectorItem {
  sector: string;
  code: string;
  temperature: number;
}

function resultSectors(row: { result_json: unknown }): SectorItem[] {
  return (row.result_json as { sectors: SectorItem[] }).sectors;
}

describe("月度价值排名批量缺数隔离", () => {
  it("十只正式候选中一只缺数据仍完成其余九只排名", async () => {
    const candidates = Array.from({ length: 10 }, (_, index) => ({
      id: String(index + 1), code: `6000${String(index).padStart(2, "0")}.SH`, name: `候选${index}`,
      industry_code: "881145.TI", industry_name: "电力", in_value: true, in_csi300: true,
      median_turnover_60: 200_000_000, turnover_count_60: 60,
    }));
    const rows = candidates.map((candidate, index) => ({
      id: candidate.id, code: candidate.code, name: candidate.name,
      bar_date: index === 9 ? "2026-01-30" : "2026-02-02", close: 10,
      fundamental_date: "2025-12-31", net_profit: 100, operating_cashflow: 100,
      roe: 12, debt_ratio: 40, previous_net_profit: 90,
      valuation_date: "2026-02-02", pe_ttm: 10, pb: 1, ps_ttm: 2,
      latest_ex_date: "2025-06-01", dividend_ttm: 0.5, dividend_years_3y: 3,
    }));
    let persisted = 0;
    const db = { query: async (sql: string) => {
      if (sql.includes("WITH value_members AS")) return { rows: candidates };
      if (sql.includes("COALESCE(close_raw,close) AS close")) return { rows };
      if (sql.includes("SELECT trade_date::text AS date FROM market_trading_day")) return { rows: [{ date: "2026-02-03" }] };
      if (sql.includes("INSERT INTO value_rank_snapshot")) { persisted++; return { rowCount: 1, rows: [] }; }
      throw new Error(`unexpected query: ${sql.slice(0, 100)}`);
    } } as unknown as Parameters<typeof generateValueMonthlyRank>[0];
    const result = await generateValueMonthlyRank(db, "1", "2026-02-02");
    expect(result.gaps).toEqual([]);
    expect(result.result).toMatchObject({ eligible_count: 9, skipped: [expect.objectContaining({ code: candidates[9]!.code })] });
    expect(result.result.top50).toHaveLength(9);
    expect(persisted).toBe(10); // 保留异常行的审计快照，但不参与排序。
  });
});

describe.skipIf(!prepared)("板块温度同花顺口径", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
    await runMigrations(pool);

    const instruments: Array<[string, string, string]> = [
      ["881101.TI", "半导体", "board"],
      ["881102.TI", "电力", "board"],
      ["881103.TI", "煤炭", "board"],
      ["884901.TI", "半导体材料", "board"],
      ["860901.TI", "机器人概念", "board"],
      ["000819.SH", "有色金属", "index"],
    ];
    for (const [code, name, kind] of instruments) {
      const inserted = await pool.query(
        `INSERT INTO market_instrument (code, name, kind) VALUES ($1, $2, $3) RETURNING id`,
        [code, name, kind],
      );
      const boardType = code === "860901.TI" ? "concept" : "industry";
      await pool.query(
        `INSERT INTO market_board (instrument_id, board_type) VALUES ($1, $2)`,
        [inserted.rows[0]!.id, boardType],
      );
    }

    const bars: Array<[string, number, number]> = [
      ["881101.TI", 30, 0.1],
      ["881102.TI", 30, 0],
      ["881103.TI", 5, 0.1],
      ["884901.TI", 30, 0.1],
      ["860901.TI", 30, 0.1],
      ["000819.SH", 30, 0.1],
    ];
    for (const [code, days, slope] of bars) {
      await pool.query(
        `WITH instrument AS (SELECT id FROM market_instrument WHERE code = $1),
              points AS (SELECT generate_series(0, $2::int - 1) AS offset)
         INSERT INTO market_bar
           (instrument_id, freq, bar_date, bar_time, open, high, low, close, volume, channel)
         SELECT instrument.id, 'day', date '2026-01-01' + points.offset,
                (date '2026-01-01' + points.offset)::timestamp AT TIME ZONE 'UTC',
                10 + points.offset * $3::numeric, 10.5 + points.offset * $3::numeric,
                9.5 + points.offset * $3::numeric, 10 + points.offset * $3::numeric,
                1000, 'test'
           FROM instrument CROSS JOIN points
         ON CONFLICT DO NOTHING`,
        [code, days, slope],
      );
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it("默认集合只取 881 一级行业：含名称与温度，缺日线进缺口", async () => {
    const row = await executeAnalysis(pool, { analysis_type: "sector_temperature" });
    expect(row.status).toBe("partial");
    const sectors = resultSectors(row);
    expect(sectors.map((item) => item.code)).toEqual(["881101.TI", "881102.TI"]);
    expect(sectors.map((item) => item.sector)).toEqual(["半导体", "电力"]);
    expect(sectors.map((item) => item.temperature)).toEqual([100, 50]);
    const result = row.result_json as {
      average_temperature: number | null;
      available_average_temperature: number;
      state: string;
      market_regime: { status: string; state: string | null };
    };
    expect(result.average_temperature).toBeNull();
    expect(result.available_average_temperature).toBe(75);
    expect(result.state).toBe("数据不足");
    expect(result.market_regime).toMatchObject({ status: "partial", state: null });
    expect(row.data_gaps).toEqual(expect.arrayContaining([
      { code: "881103.TI", reason: "日线不足 20 条（5）" },
      expect.objectContaining({ scope: "market_regime" }),
    ]));
  });

  it("显式 codes 可下钻 884 或旧指数，名称取自 market_instrument", async () => {
    const row = await executeAnalysis(pool, { analysis_type: "sector_temperature", codes: ["884901.TI", "000819.SH"] });
    expect(row.status).toBe("success");
    const sectors = resultSectors(row);
    expect(sectors.map((item) => item.code)).toEqual(["884901.TI", "000819.SH"]);
    expect(sectors.map((item) => item.sector)).toEqual(["半导体材料", "有色金属"]);
  });

  it("停用板块退出默认集合", async () => {
    await pool.query(
      `UPDATE market_board SET active = false WHERE instrument_id = (SELECT id FROM market_instrument WHERE code = '881101.TI')`,
    );
    const row = await executeAnalysis(pool, { analysis_type: "sector_temperature" });
    expect(resultSectors(row).map((item) => item.code)).toEqual(["881102.TI"]);
    await pool.query(
      `UPDATE market_board SET active = true WHERE instrument_id = (SELECT id FROM market_instrument WHERE code = '881101.TI')`,
    );
  });

  it("完整一级行业全集合成 MA5/MA20/ROC5 并确定市场状态", async () => {
    await pool.query(
      `UPDATE market_board SET active = false WHERE instrument_id = (SELECT id FROM market_instrument WHERE code = '881103.TI')`,
    );
    const row = await executeAnalysis(pool, { analysis_type: "sector_temperature" });
    expect(row.status).toBe("success");
    expect((row.result_json as { market_regime: unknown }).market_regime).toMatchObject({
      status: "success",
      state: "牛市",
      coverage: { expected_boards: 2, available_boards: 2, required_dates: 21 },
    });
    await pool.query(
      `UPDATE market_board SET active = true WHERE instrument_id = (SELECT id FROM market_instrument WHERE code = '881103.TI')`,
    );
  });
  it("单个一级行业缺日线只跳过该行业，九成覆盖仍输出可用市场状态", async () => {
    const codes = Array.from({ length: 7 }, (_, i) => `88111${i}.TI`);
    try {
      await pool.query(`INSERT INTO market_instrument(code,name,kind)
        SELECT code,code,'board' FROM unnest($1::text[]) code`, [codes]);
      await pool.query(`INSERT INTO market_board(instrument_id,board_type,source,active)
        SELECT id,'industry','hithink',true FROM market_instrument WHERE code=ANY($1::text[])`, [codes]);
      await pool.query(`INSERT INTO market_bar(instrument_id,freq,bar_date,bar_time,open,high,low,close,volume,channel)
        SELECT instrument.id,'day',date '2026-01-01'+n,
               (date '2026-01-01'+n)::timestamp AT TIME ZONE 'UTC',10,11,9,10+n*0.1,1000,'test'
          FROM market_instrument instrument CROSS JOIN generate_series(0,29) n
         WHERE instrument.code=ANY($1::text[])`, [codes]);
      const row = await executeAnalysis(pool, { analysis_type: "sector_temperature" });
      expect(row.status).toBe("success");
      expect(row.data_gaps).toEqual([]);
      expect(row.result_json).toMatchObject({
        market_regime: { status: "success", coverage: { expected_boards: 10, available_boards: 9 } },
        skipped: [expect.objectContaining({ code: "881103.TI" })],
      });
    } finally {
      await pool.query("DELETE FROM market_board WHERE instrument_id IN (SELECT id FROM market_instrument WHERE code=ANY($1::text[]))", [codes]);
      await pool.query("DELETE FROM market_bar WHERE instrument_id IN (SELECT id FROM market_instrument WHERE code=ANY($1::text[]))", [codes]);
      await pool.query("DELETE FROM market_instrument WHERE code=ANY($1::text[])", [codes]);
    }
  });

  it("板块趋势结构：指数衰减后放量阳包阴脱离触发信号，补涨候选分A/B分支", async () => {
    const boardCode = "881104.TI";
    const stockCodes = ["600001.SH", "600002.SH", "600003.SH", "300001.SZ"];
    try {
      // 信号板块：64根二次加速下跌 + 压平V尾 + 最后一根放量阳包阴跳穿60日趋势线。
      await pool.query(`INSERT INTO market_instrument(code,name,kind) VALUES ($1,'测试行业','board')`, [boardCode]);
      await pool.query(
        `INSERT INTO market_board(instrument_id,board_type,source,active)
         SELECT id,'industry','hithink',true FROM market_instrument WHERE code=$1`, [boardCode]);
      await pool.query(
        `WITH instrument AS (SELECT id FROM market_instrument WHERE code=$1), points AS (
           SELECT n, (100 - 0.018*n*n)::numeric AS base FROM generate_series(0,64) n)
         INSERT INTO market_bar(instrument_id,freq,bar_date,bar_time,open,high,low,close,volume,channel)
         SELECT instrument.id,'day',date '2025-11-03'+n, (date '2025-11-03'+n)::timestamp AT TIME ZONE 'UTC',
                CASE WHEN n=0 THEN base*1.02 ELSE lag(base) OVER (ORDER BY n) END,
                CASE WHEN n=0 THEN base*1.02+0.2 ELSE lag(base) OVER (ORDER BY n)+0.2 END,
                base-0.2, base, 1000, 'test'
           FROM instrument CROSS JOIN points`,
        [boardCode],
      );
      await pool.query(
        `WITH instrument AS (SELECT id FROM market_instrument WHERE code=$1), tail(bar_date,open,high,low,close,volume) AS (
           VALUES (date '2026-01-07',26.0,26.7,26.3,26.5,1000),(date '2026-01-08',26.5,27.1,26.6,26.8,1000),
                  (date '2026-01-09',26.8,27.2,26.9,27.0,1000),(date '2026-01-10',27.8,28.0,26.9,27.2,1000),
                  (date '2026-01-11',27.0,46.5,26.7,46.0,1150))
         INSERT INTO market_bar(instrument_id,freq,bar_date,bar_time,open,high,low,close,volume,channel)
         SELECT instrument.id,'day',tail.bar_date, tail.bar_date::timestamp AT TIME ZONE 'UTC',
                tail.open, tail.high, tail.low, tail.close, tail.volume, 'test'
           FROM instrument CROSS JOIN tail`,
        [boardCode],
      );
      // 观察截止日：信号日后第20个开市日。
      await pool.query(
        `INSERT INTO market_trading_day(trade_date,is_open,source,fetched_at)
         SELECT date '2026-01-12'+n, true, 'test', now() FROM generate_series(0,24) n`,
      );
      // 成分股：补跌、止跌修复、低流动性、创业板（应被主板过滤排除）。
      await pool.query(`INSERT INTO market_instrument(code,name,kind)
        SELECT code,code,'stock' FROM unnest($1::text[]) code`, [stockCodes]);
      await pool.query(
        `INSERT INTO market_board_membership(board_instrument_id,member_instrument_id,effective_from)
         SELECT board.id, member.id, date '2020-01-01'
           FROM market_instrument board, market_instrument member
          WHERE board.code=$1 AND member.code=ANY($2::text[])`,
        [boardCode, stockCodes],
      );
      await pool.query(
        `WITH instrument AS (SELECT id, code FROM market_instrument WHERE code=ANY($1::text[]) AND code <> '300001.SZ'), points AS (
           SELECT n FROM generate_series(0,124) n)
         INSERT INTO market_bar(instrument_id,freq,bar_date,bar_time,open,high,low,close,volume,channel)
         SELECT instrument.id,'day',date '2026-01-11'-124+n, (date '2026-01-11'-124+n)::timestamp AT TIME ZONE 'UTC',
                close*1.002, close*1.004, close*0.998, close, 3000000, 'test'
           FROM instrument CROSS JOIN points
           CROSS JOIN LATERAL (SELECT CASE instrument.code
                 WHEN '600001.SH' THEN CASE WHEN n<105 THEN 20 ELSE 20-(n-105)*0.3 END
                 WHEN '600002.SH' THEN CASE WHEN n<115 THEN 20-n*0.05
                     WHEN n<120 THEN 10.8+(115-n)*0.2
                     ELSE 10.6+(n-119)*0.6 END
                 ELSE 10 END AS close) v`,
        [stockCodes],
      );
      await pool.query(
        `UPDATE market_bar SET volume=100000 WHERE instrument_id=(SELECT id FROM market_instrument WHERE code='600003.SH')`,
      );

      const row = await executeAnalysis(pool, { analysis_type: "sector_trend_structure" });
      const result = row.result_json as {
        signals: Array<{
          code: string; pattern: string; pattern_tier: number; trigger: string; volume_class: string;
          valid_through: string | null; prior_low: number; second_bottom: boolean; contracting: boolean;
          catch_up: {
            branch_a: Array<{ code: string; ret20: number }>;
            branch_b: Array<{ code: string }>;
            eligible_count: number;
            skipped: Array<{ reason: string; count: number }>;
          } | null;
        }>;
        skipped: Array<{ code: string; reason: string }>;
      };
      expect(["success", "partial"]).toContain(row.status);
      expect(result.signals).toHaveLength(1);
      const signal = result.signals[0]!;
      expect(signal.code).toBe(boardCode);
      expect(signal.pattern).toBe("阳包阴");
      expect(signal.pattern_tier).toBe(1);
      expect(signal.trigger).toBe("中期脱离");
      expect(signal.volume_class).toBe("温和放量");
      expect(signal.valid_through).toBe("2026-01-31");
      expect(signal.prior_low).toBeLessThan(27);
      expect(signal.second_bottom).toBe(false);
      expect(signal.catch_up!.branch_a.map((item) => item.code)).toEqual(["600001.SH", "600002.SH"]);
      expect(signal.catch_up!.branch_a[0]!.ret20).toBeLessThan(-0.2);
      expect(signal.catch_up!.branch_b.map((item) => item.code)).toEqual(["600002.SH"]);
      expect(signal.catch_up!.eligible_count).toBe(2);
      expect(signal.catch_up!.skipped).toContainEqual(expect.objectContaining({ reason: "20日均成交额不足 2000 万元", count: 1 }));
      expect(result.skipped).toContainEqual(expect.objectContaining({ code: "881103.TI" }));
    } finally {
      await pool.query("DELETE FROM market_board_membership WHERE board_instrument_id=(SELECT id FROM market_instrument WHERE code=$1)", [boardCode]);
      await pool.query("DELETE FROM market_bar WHERE instrument_id IN (SELECT id FROM market_instrument WHERE code=$1 OR code=ANY($2::text[]))", [boardCode, stockCodes]);
      await pool.query("DELETE FROM market_board WHERE instrument_id=(SELECT id FROM market_instrument WHERE code=$1)", [boardCode]);
      await pool.query("DELETE FROM market_instrument WHERE code=$1 OR code=ANY($2::text[])", [boardCode, stockCodes]);
      await pool.query("DELETE FROM market_trading_day WHERE source='test'");
    }
  });

  it("板块趋势结构：非中期下跌的急跌V反由补充线触发并标记急跌反转", async () => {
    const boardCode = "881105.TI";
    try {
      await pool.query(`INSERT INTO market_instrument(code,name,kind) VALUES ($1,'测试急跌行业','board')`, [boardCode]);
      await pool.query(
        `INSERT INTO market_board(instrument_id,board_type,source,active)
         SELECT id,'industry','hithink',true FROM market_instrument WHERE code=$1`, [boardCode]);
      // 57根缓涨（85→105，60日斜率为正，主线背景不成立）+ 11根加速下跌（105→84，13日斜率-21%）+ 红线 + V跳阳包阴。
      await pool.query(
        `WITH instrument AS (SELECT id FROM market_instrument WHERE code=$1), points AS (
           SELECT n,
             CASE WHEN n<=56 THEN (85+0.35*n)::numeric
                  WHEN n<=67 THEN (105-(n-57)*1.9-(n-57)*(n-57)*0.02)::numeric
                  WHEN n=68 THEN 82.0 ELSE 93.0 END AS close
           FROM generate_series(0,69) n)
         INSERT INTO market_bar(instrument_id,freq,bar_date,bar_time,open,high,low,close,volume,channel)
         SELECT instrument.id,'day',date '2025-11-03'+n, (date '2025-11-03'+n)::timestamp AT TIME ZONE 'UTC',
                CASE WHEN n=0 THEN close*1.01 WHEN n=68 THEN 84.5 WHEN n=69 THEN 81.5
                     ELSE lag(close) OVER (ORDER BY n) END,
                CASE WHEN n=68 THEN 84.7 WHEN n=69 THEN 94.0
                     ELSE GREATEST(CASE WHEN n=0 THEN close*1.01 WHEN n=68 THEN 84.5 WHEN n=69 THEN 81.5
                          ELSE lag(close) OVER (ORDER BY n) END, close)+0.15 END,
                CASE WHEN n=68 THEN 81.5 WHEN n=69 THEN 81.0 ELSE close-0.15 END,
                close, CASE WHEN n=69 THEN 1150 ELSE 1000 END, 'test'
           FROM instrument CROSS JOIN points`,
        [boardCode],
      );
      const row = await executeAnalysis(pool, { analysis_type: "sector_trend_structure" });
      const result = row.result_json as {
        signals: Array<{ code: string; trigger: string; pattern: string; volume_class: string; prior_low: number }>;
      };
      const signal = result.signals.find((item) => item.code === boardCode);
      expect(signal).toMatchObject({
        code: boardCode, trigger: "急跌反转", pattern: "阳包阴", volume_class: "温和放量",
      });
      expect(signal!.prior_low).toBeLessThan(82);
    } finally {
      await pool.query("DELETE FROM market_bar WHERE instrument_id=(SELECT id FROM market_instrument WHERE code=$1)", [boardCode]);
      await pool.query("DELETE FROM market_board WHERE instrument_id=(SELECT id FROM market_instrument WHERE code=$1)", [boardCode]);
      await pool.query("DELETE FROM market_instrument WHERE code=$1", [boardCode]);
    }
  });

  it("板块趋势结构：区间回撤后创新低回升由第三线触发，不受量比门槛限制", async () => {
    const boardCode = "881106.TI";
    try {
      await pool.query(`INSERT INTO market_instrument(code,name,kind) VALUES ($1,'测试新低回升行业','board')`, [boardCode]);
      await pool.query(
        `INSERT INTO market_board(instrument_id,board_type,source,active)
         SELECT id,'industry','hithink',true FROM market_instrument WHERE code=$1`, [boardCode]);
      // 53根正弦区间震荡（92~108，60/13日斜率均为正，两斜率线背景不成立）
      // + 7根下跌至90（60日新低）+ 9根反弹 + 末根收107破10日高、量比约1.9（明显放量，验证第三线无量比门槛）。
      await pool.query(
        `WITH instrument AS (SELECT id FROM market_instrument WHERE code=$1),
         wave AS (SELECT n, round((100+8*sin(n*pi()/8))::numeric,2) AS close FROM generate_series(0,52) n),
         tail(n, close) AS (
           VALUES (53,104.0),(54,101.0),(55,98.0),(56,95.0),(57,92.0),(58,90.5),(59,90.0),
                  (60,92.0),(61,95.0),(62,98.0),(63,101.0),(64,103.5),(65,105.0),(66,105.5),
                  (67,106.0),(68,106.2),(69,107.0)),
         points AS (SELECT n::int AS n, close FROM wave UNION ALL SELECT n, close FROM tail)
         INSERT INTO market_bar(instrument_id,freq,bar_date,bar_time,open,high,low,close,volume,channel)
         SELECT instrument.id,'day',date '2025-11-03'+points.n, (date '2025-11-03'+points.n)::timestamp AT TIME ZONE 'UTC',
                CASE WHEN points.n=0 THEN points.close*1.01 ELSE lag(points.close) OVER (ORDER BY points.n) END,
                GREATEST(CASE WHEN points.n=0 THEN points.close*1.01 ELSE lag(points.close) OVER (ORDER BY points.n) END, points.close)+0.2,
                points.close-0.2, points.close, CASE WHEN points.n=69 THEN 2500 ELSE 1000 END, 'test'
           FROM instrument CROSS JOIN points`,
        [boardCode],
      );
      const row = await executeAnalysis(pool, { analysis_type: "sector_trend_structure" });
      const result = row.result_json as {
        signals: Array<{ code: string; trigger: string; pattern: string | null; volume_class: string }>;
      };
      const signal = result.signals.find((item) => item.code === boardCode);
      expect(signal).toMatchObject({ code: boardCode, trigger: "新低回升" });
      expect(["阳包阴", "双日止跌", "金针探底", null]).toContain(signal!.pattern);
      expect(signal!.volume_class).toBe("明显放量");
    } finally {
      await pool.query("DELETE FROM market_bar WHERE instrument_id=(SELECT id FROM market_instrument WHERE code=$1)", [boardCode]);
      await pool.query("DELETE FROM market_board WHERE instrument_id=(SELECT id FROM market_instrument WHERE code=$1)", [boardCode]);
      await pool.query("DELETE FROM market_instrument WHERE code=$1", [boardCode]);
    }
  });

  it("关键位和估值批量分析只跳过异常标的，保留其他完整结果", async () => {
    const levels = await executeAnalysis(pool, {
      analysis_type: "key_levels", as_of: "2026-01-30", codes: ["881101.TI", "881103.TI"],
    });
    expect(levels.status).toBe("success");
    expect(levels.result_json).toMatchObject({
      items: [expect.objectContaining({ code: "881101.TI" })],
      skipped: [expect.objectContaining({ code: "881103.TI" })],
      warnings: [expect.objectContaining({ code: "881101.TI" })],
    });
    const codes = ["600901.SH", "600902.SH"];
    try {
      await pool.query(`INSERT INTO market_instrument(code,name,kind)
        SELECT code,code,'stock' FROM unnest($1::text[]) code`, [codes]);
      await pool.query(`INSERT INTO valuation_snapshot(instrument_id,as_of_date,pe_ttm,pb,source)
        SELECT id,'2026-01-30',10,1,'test' FROM market_instrument WHERE code=$1`, [codes[0]]);
      await pool.query(`INSERT INTO fundamental_snapshot(instrument_id,as_of_date,report_period,net_profit,source)
        SELECT id,'2026-01-30','2025-12-31',100,'test' FROM market_instrument WHERE code=$1`, [codes[0]]);
      const value = await executeAnalysis(pool, {
        analysis_type: "long_valuation", as_of: "2026-01-30", codes,
      });
      expect(value.status).toBe("success");
      expect(value.result_json).toMatchObject({
        items: [expect.objectContaining({ code: codes[0] })],
        skipped: [expect.objectContaining({ code: codes[1] })],
      });
    } finally {
      await pool.query("DELETE FROM valuation_snapshot WHERE instrument_id IN (SELECT id FROM market_instrument WHERE code=ANY($1::text[]))", [codes]);
      await pool.query("DELETE FROM fundamental_snapshot WHERE instrument_id IN (SELECT id FROM market_instrument WHERE code=ANY($1::text[]))", [codes]);
      await pool.query("DELETE FROM market_instrument WHERE code=ANY($1::text[])", [codes]);
    }
  });

  it("价值排名缺交易日历时拒绝激活，候选以行业与沪深300并集且保留流动性资格", async () => {
    const missingCalendar = await executeAnalysis(pool, { analysis_type: "value_monthly_rank", as_of: "2026-01-29" });
    expect(missingCalendar.status).toBe("partial");
    expect((missingCalendar.result_json as { status: string }).status).toBe("unavailable");
    expect((await pool.query("SELECT count(*)::int AS n FROM value_rank_snapshot")).rows[0].n).toBe(0);

    await pool.query(`INSERT INTO market_instrument(code,name,kind,lifecycle_status)
      VALUES ('881145.TI','电力','board','active'),('000300.SH','沪深300','index','active'),
        ('600001.SH','稳定股票','stock','active'),('600002.SH','大盘股票','stock','active'),
        ('300001.SZ','创业板股票','stock','active'),('688001.SH','科创板股票','stock','active')`);
    await pool.query(`INSERT INTO market_board(instrument_id,board_type,source,active)
      SELECT id, CASE WHEN code='000300.SH' THEN 'special' ELSE 'industry' END,'hithink',true
        FROM market_instrument WHERE code IN ('881145.TI','000300.SH')`);
    await pool.query(`INSERT INTO market_board_membership(board_instrument_id,member_instrument_id,effective_from)
      SELECT board.id,member.id,'2026-01-01' FROM market_instrument board CROSS JOIN market_instrument member
       WHERE (board.code='881145.TI' AND member.code='600001.SH')
          OR (board.code='000300.SH' AND member.code IN ('600002.SH','300001.SZ','688001.SH'))`);
    // 沪深300成员仍须遵守《投资总策略》交易权限：创业板、科创板不得进入候选与排名。
    const candidates = await listValueCandidates(pool, "2026-01-29");
    expect(candidates.map((item) => [item.code, item.formal])).toEqual([
      ["600001.SH", false], ["600002.SH", true],
    ]);
    expect((await queryValueRank(pool, { asOf: "2026-01-29" })).status).toBe("missing");
  });

  it("月末全路径仅在次一开市日生效，缺失行情不激活且扫描不误报", async () => {
    await pool.query(`INSERT INTO market_trading_day(trade_date,is_open,source)
      VALUES ('2026-01-30',true,'test'),('2026-02-02',true,'test')`);
    for (const code of ["600001.SH", "600002.SH"]) {
      await pool.query(`WITH instrument AS (SELECT id FROM market_instrument WHERE code=$1),
        points AS (SELECT generate_series(0,249) AS n)
        INSERT INTO market_bar(instrument_id,freq,bar_date,bar_time,open,high,low,close,volume,turnover,channel)
        SELECT instrument.id,'day',date '2026-01-30'-points.n,
          (date '2026-01-30'-points.n)::timestamp AT TIME ZONE 'UTC',10,10,10,10,1000,
          CASE WHEN $1='600001.SH' THEN 200000000 ELSE 100000000 END,'test'
        FROM instrument CROSS JOIN points ON CONFLICT DO NOTHING`, [code]);
      await pool.query(`INSERT INTO fundamental_snapshot(instrument_id,as_of_date,report_period,net_profit,roe,operating_cashflow,debt_ratio,source)
        SELECT id,'2026-01-15','2025-12-31',100,12,150,40,'hithink' FROM market_instrument WHERE code=$1`, [code]);
      await pool.query(`INSERT INTO valuation_snapshot(instrument_id,as_of_date,pe_ttm,pb,ps_ttm,source)
        SELECT id,'2026-01-30',10,1,2,'hithink' FROM market_instrument WHERE code=$1`, [code]);
    }
    await pool.query(`INSERT INTO market_corporate_action(instrument_id,ex_date,dividend_per_share,source)
      SELECT instrument.id,dividend.ex_date,0.5,'test' FROM market_instrument instrument
      CROSS JOIN (VALUES (date '2023-06-01'),(date '2024-06-01'),(date '2025-06-01')) dividend(ex_date)
      WHERE instrument.code='600001.SH'`);
    // 先拒绝缺目标日行情，不生成任何可供扫描的 Top。
    await pool.query(`DELETE FROM market_bar WHERE instrument_id=(SELECT id FROM market_instrument WHERE code='600002.SH') AND bar_date='2026-01-30'`);
    await expect(executeAnalysis(pool, { analysis_type: "value_monthly_rank", as_of: "2026-01-30" }))
      .rejects.toThrow("月末行情覆盖不足");
    expect((await pool.query("SELECT count(*)::int AS n FROM value_rank_snapshot")).rows[0].n).toBe(0);
    await pool.query(`INSERT INTO market_bar(instrument_id,freq,bar_date,bar_time,open,high,low,close,volume,turnover,channel)
      SELECT id,'day','2026-01-30','2026-01-30'::timestamp AT TIME ZONE 'UTC',10,10,10,10,1000,100000000,'test'
      FROM market_instrument WHERE code='600002.SH'`);
    const run = await executeAnalysis(pool, { analysis_type: "value_monthly_rank", as_of: "2026-01-30" });
    expect(run.status).toBe("success");
    expect((await queryValueRank(pool, { asOf: "2026-01-30" })).status).toBe("missing");
    const rank = await queryValueRank(pool, { asOf: "2026-02-02" });
    expect(rank.status).toBe("success");
    expect(rank.items).toHaveLength(2);
    const duplicate = await executeAnalysis(pool, { analysis_type: "value_monthly_rank", as_of: "2026-02-02" });
    expect((duplicate.result_json as { status: string }).status).toBe("skipped");
    await pool.query(`INSERT INTO market_trading_day(trade_date,is_open,source)
      SELECT date '2026-02-02'+n,true,'test' FROM generate_series(1,20) n ON CONFLICT DO NOTHING`);
    await pool.query(`INSERT INTO market_bar(instrument_id,freq,bar_date,bar_time,open,high,low,close,volume,turnover,channel)
      SELECT id,'day','2026-02-02','2026-02-02'::timestamp AT TIME ZONE 'UTC',10,10,10,10,1000,200000000,'test'
      FROM market_instrument WHERE code IN ('600001.SH','600002.SH')`);
    await pool.query(`INSERT INTO market_corporate_action_sync_state(instrument_id,last_checked_at,latest_ex_date,status)
      SELECT id,'2026-02-02'::timestamptz,'2025-06-01','success' FROM market_instrument WHERE code='600001.SH'`);
    const scan = await queryValueAnchorSignals(pool, "2026-02-02");
    expect(scan.qualified).toEqual([]);
    expect(scan.status).toBe("success"); // 无公司行动同步状态的个股被跳过，不拖累完整候选。
    expect(scan.gaps).toEqual([]);
    expect(scan).toMatchObject({ completed_count: 1, skipped_count: 1,
      skipped: [expect.objectContaining({ code: "600002.SH" })] });
    await pool.query("DELETE FROM market_trading_day WHERE trade_date > '2026-02-02'");
    const missingReviewDate = await queryValueAnchorSignals(pool, "2026-02-02");
    expect(missingReviewDate.status).toBe("partial");
    expect(missingReviewDate.scanned_count).toBe(2);
    expect(missingReviewDate.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "calendar" }),
    ]));
  });

});
