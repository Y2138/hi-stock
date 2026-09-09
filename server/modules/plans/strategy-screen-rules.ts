// 策略筛选规则清单：独立于服务实现的无依赖叶子模块。
// 工具校验层（agent/tool-validation）只引用本文件，避免经服务实现拉入装配层形成循环依赖。
export const STRATEGY_SCREEN_RULES = ["short_right", "short_left", "trial", "swing"] as const;
export type StrategyScreenRule = (typeof STRATEGY_SCREEN_RULES)[number];

/** 各规则评估所需的最少日线根数（含指标预热）：
 * 右侧六条件要求最近两行具备 ma20 与 MACD（EMA26+DEA9 预热 34 根），左侧反转当前行需 ma20/RSI14/ATR14，
 * 试盘与波段窗口与每日计划确定性扫描一致。 */
export const STRATEGY_SCREEN_MIN_BARS: Record<StrategyScreenRule, number> = {
  short_right: 35,
  short_left: 21,
  trial: 15,
  swing: 40,
};
