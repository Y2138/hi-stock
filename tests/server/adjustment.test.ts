// 前复权计算内核测试：验证现金分红、送转、配股与锚点语义。
// 期望值取自与生产库 market_bar.adjustment='forward' 的逐行核对结果。
import { describe, expect, it } from "vitest";
import {
  computeForwardCloses,
  computeOfficialPrevCloses,
  type AdjustmentEvent,
  type RawPoint,
} from "../../server/datasource/adjustment.js";

function bar(date: string, close: number): RawPoint {
  return { date, close };
}

describe("computeForwardCloses", () => {
  it("无复权事件时前复权等于原价", () => {
    const raw = [bar("2024-01-02", 10), bar("2024-01-03", 11)];
    const result = computeForwardCloses(raw, [], "2024-01-03");
    expect(result.get("2024-01-02")).toBe(10);
    expect(result.get("2024-01-03")).toBe(11);
  });

  it("纯现金分红按加法扣减，且只在除权日之前的 bar 生效", () => {
    // 000636.SZ：2024-07-05 每股派 0.05、2025-07-11 派 0.15、2026-07-10 派 0.1
    const events: AdjustmentEvent[] = [
      { ex_date: "2024-07-05", dividend: 0.05, bonus: 0, rights_ratio: 0, rights_price: 0 },
      { ex_date: "2025-07-11", dividend: 0.15, bonus: 0, rights_ratio: 0, rights_price: 0 },
      { ex_date: "2026-07-10", dividend: 0.1, bonus: 0, rights_ratio: 0, rights_price: 0 },
    ];
    const raw = [bar("2024-06-03", 12.6), bar("2024-07-05", 12.5), bar("2026-09-10", 50.9)];
    const result = computeForwardCloses(raw, events, "2026-09-11");
    // 2024-06-03 之后共三笔分红 0.05+0.15+0.1=0.30
    expect(result.get("2024-06-03")).toBeCloseTo(12.3, 6);
    // 2024-07-05 当日已除权，不再含当日事件；其后 0.15+0.1=0.25
    expect(result.get("2024-07-05")).toBeCloseTo(12.25, 6);
    // 锚点当日等于原价
    expect(result.get("2026-09-10")).toBe(50.9);
  });

  it("送转按股本因子缩小历史价，且送转前的分红先按股本因子放大（000657.SZ）", () => {
    const events: AdjustmentEvent[] = [
      { ex_date: "2022-10-19", dividend: 0.13, bonus: 0, rights_ratio: 0, rights_price: 0 },
      { ex_date: "2023-06-09", dividend: 0, bonus: 0.3, rights_ratio: 0, rights_price: 0 },
      { ex_date: "2023-10-17", dividend: 0.12, bonus: 0, rights_ratio: 0, rights_price: 0 },
    ];
    // 2023-08-01 处于送转之后、第二批分红之前：仅扣 0.12，股本因子 1
    expect(computeForwardCloses([bar("2023-08-01", 13.0)], events, "2023-12-29").get("2023-08-01"))
      .toBeCloseTo(12.88, 6);
    // 2023-05-01 处于送转之前：0.12 按 1.3 放大后扣除，再整体除以 1.3
    expect(computeForwardCloses([bar("2023-05-01", 13.0)], events, "2023-12-29").get("2023-05-01"))
      .toBeCloseTo((13.0 - 0.12 * 1.3) / 1.3, 6);
  });

  it("复现生产库 000657.SZ 2020-01-07 的前复权值 4.644615（多笔分红叠加一次送转）", () => {
    // 生产 market_bar(adjustment='forward') 该日收盘为 4.644615384615384，原始价为 7.00
    const events: AdjustmentEvent[] = [
      { ex_date: "2022-10-19", dividend: 0.13, bonus: 0, rights_ratio: 0, rights_price: 0 },
      { ex_date: "2023-06-09", dividend: 0, bonus: 0.3, rights_ratio: 0, rights_price: 0 },
      { ex_date: "2023-10-17", dividend: 0.12, bonus: 0, rights_ratio: 0, rights_price: 0 },
      { ex_date: "2024-05-31", dividend: 0.13, bonus: 0, rights_ratio: 0, rights_price: 0 },
      { ex_date: "2025-06-19", dividend: 0.16, bonus: 0, rights_ratio: 0, rights_price: 0 },
      { ex_date: "2026-07-06", dividend: 0.23, bonus: 0, rights_ratio: 0, rights_price: 0 },
    ];
    const result = computeForwardCloses([bar("2020-01-07", 7.0)], events, "2026-09-11");
    expect(result.get("2020-01-07")).toBeCloseTo(4.644615, 6);
  });

  it("锚点之后的事件不参与调整", () => {
    const events: AdjustmentEvent[] = [
      { ex_date: "2026-09-18", dividend: 0.9, bonus: 0, rights_ratio: 0, rights_price: 0 },
    ];
    const result = computeForwardCloses([bar("2026-09-10", 44.01)], events, "2026-09-11");
    expect(result.get("2026-09-10")).toBe(44.01);
  });

  it("配股缴款计入现金流（000977.SZ 2020-03-19 每 10 股配 1.2 股、配股价 12.92）", () => {
    const events: AdjustmentEvent[] = [
      { ex_date: "2020-03-19", dividend: 0, bonus: 0, rights_ratio: 0.12, rights_price: 12.92 },
    ];
    const raw = [bar("2020-01-02", 30.72)];
    const result = computeForwardCloses(raw, events, "2020-12-31");
    // (30.72 - (0 - 0.12*12.92)) / 1.12 = (30.72 + 1.5504) / 1.12
    expect(result.get("2020-01-02")).toBeCloseTo((30.72 + 1.5504) / 1.12, 5);
  });
});

describe("computeOfficialPrevCloses", () => {
  it("无事件时为上一交易日原始收盘，首日为 null", () => {
    const raw = [bar("2024-01-02", 10), bar("2024-01-03", 11), bar("2024-01-04", 12)];
    const result = computeOfficialPrevCloses(raw, []);
    expect(result.get("2024-01-02")).toBeNull();
    expect(result.get("2024-01-03")).toBe(10);
    expect(result.get("2024-01-04")).toBe(11);
  });

  it("当日除权时，前收盘折算为除权参考价（000636.SZ 2024-07-05 派 0.05）", () => {
    const events: AdjustmentEvent[] = [
      { ex_date: "2024-07-05", dividend: 0.05, bonus: 0, rights_ratio: 0, rights_price: 0 },
    ];
    const raw = [bar("2024-07-03", 12.4), bar("2024-07-04", 12.35), bar("2024-07-05", 12.3)];
    const result = computeOfficialPrevCloses(raw, events);
    expect(result.get("2024-07-03")).toBeNull();
    expect(result.get("2024-07-04")).toBe(12.4);
    expect(result.get("2024-07-05")).toBeCloseTo(12.3, 6); // 12.35 − 0.05
  });

  it("当日送转时，前收盘按股本因子折算", () => {
    const events: AdjustmentEvent[] = [
      { ex_date: "2023-06-09", dividend: 0, bonus: 0.3, rights_ratio: 0, rights_price: 0 },
    ];
    const raw = [bar("2023-06-08", 13.0), bar("2023-06-09", 10.0)];
    const result = computeOfficialPrevCloses(raw, events);
    expect(result.get("2023-06-09")).toBeCloseTo(10.0, 6); // 13.0 / 1.3
  });
});
