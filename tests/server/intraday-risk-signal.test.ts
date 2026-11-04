// 盘中判断历史：每轮判断追加一行 intraday_position_signal，最新状态仍只有一行。
import { afterAll, describe, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { setAiRuntimeForTests } from "../../server/agent/ai/runtime.js";
import { runMigrations } from "../../server/db/migrate.js";
import { runIntradayRiskCycle } from "../../server/modules/intraday-risk/service.js";
import { prepareTestDb, resetSchema } from "./helpers.js";

const prepared = await prepareTestDb();
const CODE = "990199.SZ";

describe.skipIf(!prepared)("盘中判断历史", () => {
  const pool = prepared!.pool;

  afterAll(async () => {
    await pool.end();
  });

  it("逐轮追加历史，旧结论不被最新判断覆盖", async () => {
    await resetSchema(pool);
    await runMigrations(pool);

    await pool.query(`INSERT INTO llm_model(provider_id,model_key,name,input_modalities,reasoning,context_window,max_tokens)
      SELECT id,'GLM-5.3-Flash','判断历史测试','["text"]',false,200000,128000 FROM llm_provider WHERE provider_key='deepseek'`);
    await pool.query(`WITH instrument AS (
      INSERT INTO market_instrument(code,name,kind) VALUES($1,'历史样本','stock') RETURNING id)
      INSERT INTO portfolio_position(instrument_id,quantity,cost_price) SELECT id,100,10 FROM instrument`, [CODE]);

    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = models.getModels("faux")[0]!;
    setAiRuntimeForTests({ models, model, provider: "faux", providerName: "Faux", modelId: model.id });

    const add = { price_lower: 10.2, price_upper: 10.4, condition: "缩量回踩不创新低后放量回收", invalidation: "放量下探且承接消失", status: "triggered" };
    let item = { code: CODE, action: "add", emotion: "ice_point", add_plan: add as typeof add | null,
      reduce_plan: null as typeof add | null, reason: "情绪冰点后个股止跌回收" };
    const complete = vi.spyOn(models, "completeSimple").mockImplementation(async () => fauxAssistantMessage(JSON.stringify({ items: [item] })));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const at = new Date("2026-08-17T02:00:00Z");
      vi.setSystemTime(at);
      await pool.query(
        `INSERT INTO intraday_market_sentiment(trade_date,captured_at,status,payload) VALUES('2026-08-17',$1,'ready',$2::jsonb)`,
        [at, JSON.stringify({ counts: { up: 8, down: 70, break: 60 },
          source_times: { up: at.toISOString(), down: at.toISOString(), break: at.toISOString() } })],
      );
      const cycle = async (offset: number, price: number, volume: number) => {
        const time = new Date(at.getTime() + offset);
        vi.setSystemTime(time);
        return runIntradayRiskCycle(pool, time, true, "1", {
          at: time, gaps: [],
          quotes: new Map([[CODE, { code: CODE, timestampMs: time.getTime(), open: 10.3, high: 10.5, low: 10.15, close: price, prevClose: 11, volume, turnover: volume * 10.3 }]]),
        });
      };

      await cycle(0, 10.3, 1000);
      await cycle(30_000, 10.2, 1300);
      expect((await cycle(60_000, 10.3, 1350))?.positions[0]).toMatchObject({ action: "add", add_plan: { status: "triggered" } });

      const history = (await pool.query<{ at: string; action: string; reason: string; price: number; plan: { price_lower: number } | null }>(
        `SELECT sample_at::text AS at,action,reason,latest_price::float8 AS price,add_plan AS plan
           FROM intraday_position_signal WHERE code=$1 ORDER BY sample_at`, [CODE])).rows;
      // 三轮各一条，旧轮次保留当时的结论；最新判断只覆盖 intraday_position_risk。
      expect(history.map((row) => row.action)).toEqual(["wait", "wait", "add"]);
      expect(history[0]!.price).toBeCloseTo(10.3);
      expect(history[2]!.price).toBeCloseTo(10.3);
      expect(history[2]!.plan).toMatchObject({ price_lower: 10.2, price_upper: 10.4 });
      expect(history[1]!.reason.length).toBeGreaterThan(0);
      const latest = (await pool.query<{ action: string }>("SELECT action FROM intraday_position_risk WHERE code=$1", [CODE])).rows;
      expect(latest).toHaveLength(1);
      expect(latest[0]!.action).toBe("add");

      // 同一采样时刻重复执行不追加重复历史。
      await cycle(60_000, 10.3, 1350);
      const count = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM intraday_position_signal WHERE code=$1", [CODE])).rows[0]!.n;
      expect(count).toBe(3);

      // 后续轮次转为减仓，历史继续追加，旧加仓结论仍然保留。
      item = { ...item, action: "reduce", emotion: "weak", add_plan: { ...add, status: "waiting" },
        reduce_plan: { ...add, price_lower: 10.2, price_upper: 10.3, condition: "放量下探后回收失败", status: "triggered" }, reason: "当日平台承接转弱" };
      await cycle(90_000, 10.25, 1800);
      const after = (await pool.query<{ action: string }>(
        "SELECT action FROM intraday_position_signal WHERE code=$1 ORDER BY sample_at", [CODE])).rows.map((row) => row.action);
      expect(after).toEqual(["wait", "wait", "add", "reduce"]);
      expect((await pool.query<{ action: string }>("SELECT action FROM intraday_position_risk WHERE code=$1", [CODE])).rows)
        .toEqual([{ action: "reduce" }]);
    } finally {
      vi.useRealTimers();
      complete.mockRestore();
      setAiRuntimeForTests(null);
    }
  });
});
