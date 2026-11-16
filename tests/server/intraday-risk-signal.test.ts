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
      // 第 3 轮才形成可触发的 add；首轮展示按去抖规则仍保持 wait（落库已是 add）。
      expect((await cycle(60_000, 10.3, 1350))?.positions[0]).toMatchObject({ action: "wait", add_plan: { status: "triggered" } });

      // 给模型的时间一律北京墙钟：sampled_at 为北京时刻，正文不残留 UTC 时间戳（Z/+00），
      // 否则模型会把早盘 10 点（UTC 02:00）误读成午后等时段。
      const prompt = complete.mock.calls.at(-1)![1] as unknown as {
        systemPrompt: string;
        messages: Array<{ role: string; content: string }>;
      };
      const userText = prompt.messages[0]!.content;
      expect(prompt.systemPrompt).toContain("北京时间");
      expect(userText).toContain('"sampled_at":"2026-08-17 10:0');
      expect(userText).not.toMatch(/\\?"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\\"]*Z\\?"/);
      expect(userText).not.toContain("+00");

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

      // 连续第二轮 add 才确认展示方向；落库仍是每轮原始判断。
      expect((await cycle(120_000, 10.3, 1400))?.positions[0]).toMatchObject({ action: "add", add_plan: { status: "triggered" } });
      expect((await pool.query<{ action: string }>(
        "SELECT action FROM intraday_position_signal WHERE code=$1 ORDER BY sample_at", [CODE])).rows.map((row) => row.action))
        .toEqual(["wait", "wait", "add", "add"]);

      // 方向反转：第一轮 reduce 已落库，但展示保持 add；payload 的 previous 取上一轮原始判断（add）。
      item = { ...item, action: "reduce", emotion: "weak", add_plan: { ...add, status: "waiting" },
        reduce_plan: { ...add, price_lower: 10.2, price_upper: 10.3, condition: "放量下探后回收失败", status: "triggered" }, reason: "当日平台承接转弱" };
      const flipping = await cycle(150_000, 10.25, 1800);
      expect(flipping?.positions[0]).toMatchObject({ action: "add" });
      const rawAfterFlip = (await pool.query<{ action: string }>(
        "SELECT action FROM intraday_position_signal WHERE code=$1 ORDER BY sample_at", [CODE])).rows.map((row) => row.action);
      expect(rawAfterFlip).toEqual(["wait", "wait", "add", "add", "reduce"]);
      expect((await pool.query<{ action: string }>("SELECT action FROM intraday_position_risk WHERE code=$1", [CODE])).rows)
        .toEqual([{ action: "reduce" }]);
      const flipPrompt = JSON.parse((complete.mock.calls.at(-1)![1] as unknown as {
        messages: Array<{ content: string }>;
      }).messages[0]!.content) as { positions: Array<{ previous: Record<string, unknown> | null }> };
      expect(flipPrompt.positions[0]!.previous).toMatchObject({ action: "add", sampled_at: expect.any(String) });
      expect(flipPrompt.positions[0]!.previous!.add_plan).toMatchObject({ price_lower: 10.2, price_upper: 10.4 });

      // reduce 还要等确认轮 + 最短保持轮结束；历史继续追加，最新风险仍是模型原始判断。
      expect((await cycle(180_000, 10.25, 1850))?.positions[0]).toMatchObject({ action: "add" });
      expect((await cycle(210_000, 10.25, 1860))?.positions[0]).toMatchObject({ action: "reduce" });
      expect((await pool.query<{ action: string }>(
        "SELECT action FROM intraday_position_signal WHERE code=$1 ORDER BY sample_at", [CODE])).rows.map((row) => row.action))
        .toEqual(["wait", "wait", "add", "add", "reduce", "reduce", "reduce"]);
      expect((await pool.query<{ action: string }>("SELECT action FROM intraday_position_risk WHERE code=$1", [CODE])).rows)
        .toEqual([{ action: "reduce" }]);

      // 跨交易日重置：新交易日的首轮即使模型给 reduce，也从未确认状态起步（旧状态不得延续）。
      const nextDay = new Date("2026-08-18T02:00:00Z");
      vi.setSystemTime(nextDay);
      await pool.query(
        `INSERT INTO intraday_market_sentiment(trade_date,captured_at,status,payload) VALUES('2026-08-18',$1,'ready',$2::jsonb)`,
        [nextDay, JSON.stringify({ counts: { up: 8, down: 70, break: 60 },
          source_times: { up: nextDay.toISOString(), down: nextDay.toISOString(), break: nextDay.toISOString() } })],
      );
      const next = await runIntradayRiskCycle(pool, nextDay, true, "1", {
        at: nextDay, gaps: [],
        quotes: new Map([[CODE, { code: CODE, timestampMs: nextDay.getTime(), open: 10.3, high: 10.5, low: 10.15, close: 10.25, prevClose: 11, volume: 2000, turnover: 2000 * 10.3 }]]),
      });
      expect(next?.positions[0]?.action).toBe("wait");
      expect((await pool.query<{ action: string }>(
        "SELECT action FROM intraday_position_signal WHERE code=$1 AND trade_date='2026-08-18'", [CODE])).rows)
        .toEqual([{ action: "wait" }]);
    } finally {
      vi.useRealTimers();
      complete.mockRestore();
      setAiRuntimeForTests(null);
    }
  });
});
