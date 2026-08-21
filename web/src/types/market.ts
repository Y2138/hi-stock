// 共享类型：与 market_bar 读库口径对齐的 K 线字段集（MA 列为服务端迁移/计算的原值）

/** 单根 K 线 */
export interface KlineBar {
  /** 日期，YYYY-MM-DD（30m 为 "YYYY-MM-DD HH:mm"） */
  date: string;
  open: number;
  close: number;
  low: number;
  high: number;
  /** 成交量（手），可选 */
  volume?: number;
  /** 均线原值（服务端给出即画，缺失自动断开） */
  ma5?: number | null;
  ma10?: number | null;
  ma20?: number | null;
  ma60?: number | null;
  dif?: number | null;
  dea?: number | null;
  macdHist?: number | null;
}
