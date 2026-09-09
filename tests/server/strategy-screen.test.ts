// 策略条件参考筛选：任意代码×策略规则的确定性评估、指标同步重算与数据缺口降级
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../server/db/migrate.js";
import { storeBars } from "../../server/datasource/service.js";
import { queryStrategyScreen } from "../../server/modules/plans/strategy-screen.js";
import { buildChatTools } from "../../server/agent/tools.js";
import { createSession } from "../../server/agent/repo.js";
import { prepareTestDb, resetSchema, seedTestStrategy } from "./helpers.js";

const prepared = await prepareTestDb();

function series(count: number, startMonth: number, startDay: number) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(2026, startMonth - 1, startDay + index)).toISOString().slice(0, 10);
    const close = index + 10;
    return { date, open: close, high: close + 1, low: close - 1, close, volume: 1000 + index, adjustment: "forward" as const };
  });
}

describe.skipIf(!prepared)("策略条件参考筛选（stock_test 真实库）", () => {
  let pool: pg.Pool;
  let sessionId: string;

  beforeAll(async () => {
    pool = prepared!.pool;
    await resetSchema(pool);
    await runMigrations(pool);
    await seedTestStrategy(pool);
    await pool.query(
      `INSERT INTO market_instrument (code, name, kind) VALUES
         ('990100.SZ', '筛选完整样本', 'stock'),
         ('990101.SZ', '筛选缺日线样本', 'stock'),
         ('990102.SZ', '筛选波段样本', 'stock'),
         ('990103.SZ', '筛选重算样本', 'stock'),
         ('990104.SH', '筛选ETF样本', 'etf')`,
    );
    const instrumentIds = await pool.query<{ code: string; id: string }>(
      "SELECT code, id::text FROM market_instrument WHERE code LIKE '99010%'",
    );
    const idOf = new Map(instrumentIds.rows.map((row) => [row.code, row.id]));
    await storeBars(pool, idOf.get("990100.SZ")!, "day", series(45, 6, 1), "test");
    await storeBars(pool, idOf.get("990101.SZ")!, "day", series(3, 7, 1), "test");
    await storeBars(pool, idOf.get("990102.SZ")!, "day", series(45, 6, 1), "test");
    await storeBars(pool, idOf.get("990103.SZ")!, "day", series(40, 6, 1), "test");
    const session = await createSession(pool, "策略筛选测试");
    sessionId = session.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("未知代码与非个股标的返回显式缺口，不静默跳过", async () => {
    const result = await queryStrategyScreen(pool, {
      codes: ["999999.SZ", "990104.SH"],
      rules: ["trial"],
      date: "2026-07-31",
    });
    expect(result.status).toBe("partial");
    expect(result.items).toEqual([]);
    expect(result.data_gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "999999.SZ", reason: expect.stringContaining("市场目录中不存在该标的") }),
      expect.objectContaining({ code: "990104.SH", reason: expect.stringContaining("仅支持 A 股个股") }),
    ]));
  });

  it("缺日线时逐规则返回缺口并指引批量补拉后重跑", async () => {
    const result = await queryStrategyScreen(pool, {
      codes: ["990101.SZ"],
      rules: ["short_right", "short_left", "trial", "swing"],
      date: "2026-07-31",
    });
    expect(result.status).toBe("partial");
    expect(result.data_gaps).toHaveLength(4);
    for (const gap of result.data_gaps) {
      expect(gap.reason).toContain("根日线");
    }
    expect(result.instruction).toContain("fetch_market_data");
  });

  it("评估前同步重算过期指标，指标依赖规则可用且结果为参考口径", async () => {
    const result = await queryStrategyScreen(pool, {
      codes: ["990100.SZ"],
      rules: ["short_right", "trial"],
      date: "2026-07-31",
    });
    expect(result.status).toBe("success");
    expect(result.data_gaps).toEqual([]);
    expect(result.notice).toContain("不产生 signal_grade");
    const item = result.items[0]!;
    expect(item.code).toBe("990100.SZ");
    expect(item.latest_bar_date).toBe(series(45, 6, 1).at(-1)!.date);
    const outcomes = new Map(item.rules.map((rule) => [rule.rule, rule]));
    expect(outcomes.get("short_right")).toMatchObject({
      status: "evaluated",
      evaluation: expect.objectContaining({
        conditions: expect.objectContaining({
          dif_positive: expect.any(Boolean),
          volume_expanding: expect.any(Boolean),
        }),
      }),
    });
    expect(outcomes.get("trial")).toMatchObject({ status: "evaluated" });
    // storeBars 之后未做任何异步重算；右侧六条件能完成评估即证明请求内同步重算生效
  });

  it("指标重算失败时降级为数据缺口，不阻断无指标依赖的规则", async () => {
    const failing = await queryStrategyScreen(
      pool,
      { codes: ["990103.SZ"], rules: ["short_right", "trial"], date: "2026-07-31" },
      { recomputeIndicator: async () => { throw new Error("worker 不可用"); } },
    );
    expect(failing.status).toBe("partial");
    const outcomes = new Map(failing.items[0]!.rules.map((rule) => [rule.rule, rule]));
    expect(outcomes.get("short_right")).toMatchObject({
      status: "gap",
      reason: expect.stringContaining("重算失败"),
    });
    expect(outcomes.get("trial")).toMatchObject({ status: "evaluated" });
    // 注入失败不消费脏行；下一次调用用真实重算即可恢复
    const recovered = await queryStrategyScreen(pool, {
      codes: ["990103.SZ"],
      rules: ["short_right"],
      date: "2026-07-31",
    });
    expect(recovered.data_gaps).toEqual([]);
    expect(recovered.items[0]!.rules[0]).toMatchObject({ status: "evaluated" });
  });

  it("个股缺股性护盘画像时波段规则降级为缺口并指向正式口径", async () => {
    const result = await queryStrategyScreen(pool, {
      codes: ["990102.SZ"],
      rules: ["swing"],
      date: "2026-07-31",
    });
    expect(result.status).toBe("partial");
    expect(result.data_gaps).toEqual([
      expect.objectContaining({
        code: "990102.SZ",
        rule: "swing",
        reason: expect.stringContaining("缺少可信的股性护盘收回率"),
      }),
    ]);
  });

  it("工具注册于交互目录并严格校验参数", async () => {
    const tools = buildChatTools({ pool, sessionId });
    const tool = tools.find((item) => item.name === "strategy_screen_query")!;
    expect(tool.description).toContain("参考口径");
    await expect(tool.execute("tc-screen-strict", {
      codes: ["990100.SZ"],
      rules: ["unknown_rule"],
      date: "2026-07-31",
    } as never)).rejects.toThrow("参数校验失败");
    await expect(tool.execute("tc-screen-empty", {
      codes: [],
      rules: ["trial"],
      date: "2026-07-31",
    } as never)).rejects.toThrow("参数校验失败");
  });
});
