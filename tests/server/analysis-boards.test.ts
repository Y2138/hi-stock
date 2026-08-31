// 板块温度口径测试：默认集合为同花顺 881 一级行业板块，不再包含 884 二级、概念板块或旧代理指数。
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../server/db/migrate.js";
import { executeAnalysis } from "../../server/analysis/service.js";
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
    const result = row.result_json as { average_temperature: number; state: string };
    expect(result.average_temperature).toBe(75);
    expect(result.state).toBe("高温");
    expect(row.data_gaps).toEqual([{ code: "881103.TI", reason: "日线不足 20 条（5）" }]);
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
});
