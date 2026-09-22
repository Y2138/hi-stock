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
        ('600001.SH','稳定股票','stock','active'),('600002.SH','大盘股票','stock','active')`);
    await pool.query(`INSERT INTO market_board(instrument_id,board_type,source,active)
      SELECT id, CASE WHEN code='000300.SH' THEN 'special' ELSE 'industry' END,'hithink',true
        FROM market_instrument WHERE code IN ('881145.TI','000300.SH')`);
    await pool.query(`INSERT INTO market_board_membership(board_instrument_id,member_instrument_id,effective_from)
      SELECT board.id,member.id,'2026-01-01' FROM market_instrument board CROSS JOIN market_instrument member
       WHERE (board.code='881145.TI' AND member.code='600001.SH')
          OR (board.code='000300.SH' AND member.code='600002.SH')`);
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
