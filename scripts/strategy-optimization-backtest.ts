// 策略优化预案回测验证脚本（本地研究工具，不经过内置 Agent，不写回测运行台账）。
//
// 目的：对 docs/系统策略优化方案预案.md 中的方案做同口径消融验证——
//   止损档位、震荡期同类限仓、震荡过滤器（MA20斜率/ADX/贴近MA20/宽度）、
//   大盘板块宽度确认、回撤与连止损熔断、左侧/试盘/波段基线与组合处理。
//
// 复用系统能力：server/backtest/input.ts 冻结输入（六年共同种子+881环境+基准）
//   + server/backtest/portfolio-engine.ts 日频内核 + server/backtest/settlement.ts 独立核账。
// 只读 PostgreSQL；结果写到 支撑/tmp/策略优化回测/（gitignored 研究中间数据）。
//
// 用法：
//   npx tsx scripts/strategy-optimization-backtest.ts                       # 全部窗口全部实验
//   npx tsx scripts/strategy-optimization-backtest.ts --window train        # 只跑训练窗
//   npx tsx scripts/strategy-optimization-backtest.ts --only 基线,止损      # 按名称过滤
//   npx tsx scripts/strategy-optimization-backtest.ts --sample 100          # 固定样本数量
//
// 证据边界：固定样本（当前数据等距抽取，非历史时点池）、前复权研究价格、
//   显式费用假设；全部结果为 research_only，不构成生产发布证据。
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import { inspectStandardInput } from "../server/backtest/input.js";
import { decodeStandardChunk } from "../server/backtest/input.js";
import { createPortfolioEngine } from "../server/backtest/portfolio-engine.js";
import { verifySettlement } from "../server/backtest/settlement.js";
import { evaluateOscillation } from "../server/backtest/engine.js";
import {
  validateStandardPlan, type StandardBacktestPlan, type StandardDay, type StandardEquity, type StandardRightSideParams,
} from "../server/backtest/contracts.js";
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";

// 市场参照改用冻结输入内的 881 合成指数；本地指数日线 2023 年前失真，不作超额基准。
const BENCHMARK_NOTE = "881_industry_composite";
const SAMPLE_SIZE = 100;
const COSTS = {
  label: "研究费用假设:佣金万2.5最低5元,卖税10bp,滑点10bp",
  commission_bps: 2.5,
  minimum_commission: 5,
  sell_tax_bps: 10,
  slippage_bps: 10,
  volume_participation: 0.02,
} as const;

const WINDOWS = {
  train: { start: "2023-01-03", end: "2024-12-31" },
  test: { start: "2025-01-02", end: "2026-08-31" },
  full: { start: "2023-01-03", end: "2026-08-31" },
  /** 长窗口（用户要求：拉长时间、均衡牛熊）。881 行业数据 2021-09 才开始，长窗口只能用无环境模式：
   *  熔断与行业闸门不可用，回撤控制由 drawdown_scale_max（连续缩仓，无环境依赖）承担。 */
  longTrain: { start: "2016-10-10", end: "2021-12-31", sampleStart: "2016-10-10", env: "none" },
  longTest: { start: "2022-01-04", end: "2026-08-31", sampleStart: "2016-10-10", env: "none" },
  /** 周期股长窗（第十轮追加）：2017 起覆盖 2018 熊、2019-20 成长牛（周期弱）、2021 周期大年、2022 熊；
   *  2017-2021 无真实 881，统一用合成行业环境（与 2023-2026 同一口径跑完全程）。 */
  longEarly: { start: "2017-01-03", end: "2022-12-30", env: "synthetic_881" },
  longFull: { start: "2017-01-03", end: "2026-08-31", env: "synthetic_881" },
} as const;
type WindowName = keyof typeof WINDOWS;

// ===== 市场状态连续分段（regime 窗口）：替代机械的等长年份切分 =====
// 规则（简单可辩护，不拟合）：以合成 881 等权综合指数（2015 起）标注每日状态——
//   Bull: 收盘 ≥ MA200 且 250 日收益 > +15%；Bear: 收盘 < MA200 且 250 日收益 < -15%；其余为 Chop。
// 同状态连续 ≥60 交易日的区间保留为一段（每段自身连续，不跨段拼接）；跨界 2022 年的段按交易日拆分，
// 前半归训练池、后半归样本外池，保证两侧都包含牛/熊/震荡状态。
interface RegimeSegment { name: string; kind: "bull" | "bear" | "chop"; start: string; end: string; tradingDays: number }
const REGIME_MIN_DAYS = 60;
const REGIME_FROM = "2016-01-01";
const REGIME_TO = "2026-08-31";
const REGIME_SPLIT = "2021-12-31";
async function loadRegimeSegments(): Promise<RegimeSegment[]> {
  const pool = getPool(loadConfig().databaseUrl);
  const { rows } = await pool.query<{ d: string; r: number | null }>(
    `WITH board_ret AS (
       SELECT bar_date, code, close / NULLIF(lag(close) OVER (PARTITION BY instrument_id ORDER BY bar_date), 0) - 1 AS ret
       FROM market_bar b JOIN market_instrument i ON i.id = b.instrument_id
       WHERE i.kind='board' AND i.code LIKE '881%.SY' AND b.freq='day')
     SELECT bar_date::text AS d, avg(ret)::float8 AS r
     FROM board_ret WHERE ret IS NOT NULL GROUP BY bar_date HAVING count(*) >= 60 ORDER BY bar_date`);
  const dates: string[] = [];
  const closes: number[] = [];
  let index = 1000;
  for (const row of rows) {
    index *= 1 + (row.r ?? 0);
    dates.push(row.d);
    closes.push(index);
  }
  const stateAt = (i: number): "bull" | "bear" | "chop" | null => {
    if (i < 250) return null;
    let sum = 0;
    for (let k = i - 199; k <= i; k += 1) sum += closes[k]!;
    const ma200 = sum / 200;
    const ret250 = closes[i]! / closes[i - 250]! - 1;
    if (closes[i]! >= ma200 && ret250 > 0.15) return "bull";
    if (closes[i]! < ma200 && ret250 < -0.15) return "bear";
    return "chop";
  };
  const raw: Array<{ kind: string; first: number; last: number }> = [];
  for (let i = 0; i < dates.length; i += 1) {
    const state = stateAt(i);
    if (state === null) continue;
    const current = raw.at(-1);
    if (current && current.kind === state) current.last = i;
    else raw.push({ kind: state, first: i, last: i });
  }
  const kindLabel = { bull: "牛", bear: "熊", chop: "震荡" } as const;
  const firstAtOrAfter = (date: string) => Math.max(0, dates.findIndex(d => d >= date));
  const firstAfter = (date: string) => {
    const index = dates.findIndex(d => d > date);
    return index < 0 ? dates.length : index;
  };
  const idxFrom = firstAtOrAfter(REGIME_FROM);
  const idxTest = firstAfter(REGIME_SPLIT);
  const idxEnd = firstAfter(REGIME_TO);
  const segments: RegimeSegment[] = [];
  for (const run of raw) {
    if (run.last - run.first + 1 < REGIME_MIN_DAYS) continue;
    // 与研究区间求交，再按 2021/2022 界拆分（每段自身连续；不足 60 日的碎段丢弃）
    for (const [from, to, side] of [
      [Math.max(run.first, idxFrom), Math.min(run.last, idxTest - 1), "train"],
      [Math.max(run.first, idxTest), Math.min(run.last, idxEnd - 1), "test"],
    ] as Array<[number, number, string]>) {
      if (to - from + 1 < REGIME_MIN_DAYS) continue;
      segments.push({
        name: `regime_${side}_${run.kind}_${dates[from]!.slice(0, 7)}`,
        kind: run.kind as RegimeSegment["kind"],
        start: dates[from]!, end: dates[to]!, tradingDays: to - from + 1,
      });
    }
  }
  console.log(`市场状态分段（${kindLabel.bull}≥MA200且250日>+15% / ${kindLabel.bear}<MA200且250日<-15% / 其余${kindLabel.chop}；连续≥${REGIME_MIN_DAYS}交易日）：`);
  for (const seg of segments) console.log(`  ${seg.name}: ${seg.start} ~ ${seg.end}（${seg.tradingDays} 日）`);
  return segments;
}

/** 881 一级行业分组（当前成分，board 用合成 .SY 代码与冻结环境对齐；无归属样本股不参与行业类实验）。 */
async function loadIndustryGroups(codes: string[]): Promise<Array<{ board: string; codes: string[] }>> {
  const pool = getPool(loadConfig().databaseUrl);
  const universe = new Set(codes);
  const { rows } = await pool.query<{ board: string; code: string }>(
    `SELECT i2.code AS board, mi.code
     FROM market_board b2 JOIN market_instrument i2 ON i2.id=b2.instrument_id
     JOIN market_board_membership mm ON mm.board_instrument_id=b2.instrument_id AND mm.effective_to IS NULL
     JOIN market_instrument mi ON mi.id=mm.member_instrument_id
     WHERE b2.active AND b2.source='hithink' AND b2.board_type='industry' AND i2.code LIKE '881%'
       AND mi.code ~ '^[0-9]{6}[.](SH|SZ)$' ORDER BY i2.code, mi.code`);
  const byBoard = new Map<string, string[]>();
  for (const row of rows) {
    if (!universe.has(row.code)) continue;
    let list = byBoard.get(row.board);
    if (!list) { list = []; byBoard.set(row.board, list); }
    list.push(row.code);
  }
  return [...byBoard.entries()]
    .filter(([, list]) => list.length >= 3)
    .map(([board, list]) => ({ board: board.replace(/\.TI$/, ".SY"), codes: list }));
}

const args = process.argv.slice(2);
const argOf = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const onlyWindows = (argOf("--window")?.split(",") ?? ["train", "test"]) as WindowName[];
/** 状态分段模式：--regime 启用，忽略 --window。 */
const regimeMode = args.includes("--regime");
/** 只输出分段与宇宙统计，不执行实验。 */
const segmentsOnly = args.includes("--segments-only");
/** 按段名子串过滤（regime 模式）。 */
const segmentFilter = argOf("--segment");
/** 周期行业收口模式：--close 跑收口矩阵；--signals 跑入场信号研究矩阵；--cyclical-ablate 剔除指定行业（留一消融）。 */
const closeMode = args.includes("--close");
const signalsMode = args.includes("--signals");
const ablateBoards = (argOf("--cyclical-ablate") ?? "").split(",").map(b => b.trim()).filter(Boolean);
const onlyNames = argOf("--only")?.split(",");
const sampleSize = Number(argOf("--sample") ?? SAMPLE_SIZE);
/** CH-3 卫生检查（代理口径）：剔除 2021-22 中位成交额最低 30% 的标的（壳价值/流动性意图与
 *  Liu-Stambaugh-Yuan 2019 一致；真市值数据缺失，以 close×volume 中位数代理，需披露口径差异）。 */
const excludeSmall = args.includes("--exclude-small");
const TURNOVER_WINDOW = { start: "2021-01-01", end: "2022-12-31" };
async function smallCapExclusion(): Promise<Set<string>> {
  if (!excludeSmall) return new Set();
  const pool = getPool(loadConfig().databaseUrl);
  const { rows } = await pool.query<{ code: string }>(
    `WITH px AS (
       SELECT i.code, b.close * b.volume AS turnover
       FROM market_bar b JOIN market_instrument i ON i.id=b.instrument_id
       WHERE i.kind='stock' AND b.freq='day' AND b.bar_date BETWEEN $1 AND $2 AND b.volume > 0 AND b.close > 0
     ), med AS (
       SELECT code, percentile_cont(0.5) WITHIN GROUP (ORDER BY turnover) AS med
       FROM px GROUP BY code HAVING count(*) >= 200
     ), ranked AS (
       SELECT code, med, percent_rank() OVER (ORDER BY med) AS pct
       FROM med
     )
     SELECT code FROM ranked WHERE pct < 0.3`, [TURNOVER_WINDOW.start, TURNOVER_WINDOW.end]);
  console.log(`CH-3 卫生检查（换手代理）：剔除中位成交额最低 30%，共 ${rows.length} 只。`);
  return new Set(rows.map(row => row.code));
}
const smallExclusion: Promise<Set<string>> | null = excludeSmall ? smallCapExclusion() : null;
function applyExclusion(codes: string[], excluded: Set<string> | null): string[] {
  if (!excluded || excluded.size === 0) return codes;
  return codes.filter(code => !excluded.has(code));
}
const outDir = path.resolve("支撑/tmp/策略优化回测");
fs.mkdirSync(outDir, { recursive: true });

interface Experiment { name: string; question: string; overrides: Partial<StandardBacktestPlan> }

/** 右侧实验矩阵：先单因素消融（预案第四节：先单因素、再组合），组合实验第二轮追加。 */
const RIGHT_SIDE_EXPERIMENTS: Experiment[] = [
  { name: "基线_止损8_限5", question: "当前近似口径的基线", overrides: {} },
  { name: "止损06", question: "预案3:提高止损条件是否降低回撤", overrides: { stop_loss_pct: 0.06 } },
  { name: "止损10", question: "止损放宽对照", overrides: { stop_loss_pct: 0.10 } },
  { name: "止损12", overrides: { stop_loss_pct: 0.12 }, question: "止损放宽对照" },
  { name: "限仓2_无条件", question: "预案1:同类1-2名的无条件对照", overrides: { daily_buy_limit: 2 } },
  { name: "限仓1_无条件", question: "预案1:同类1名的无条件对照", overrides: { daily_buy_limit: 1 } },
  { name: "震荡_斜率平_限2", question: "预案4:MA20斜率接近0单因素", overrides: {
    oscillation_filter: { composite_slope_band: 0.001, require_all: false, oscillating_daily_buy_limit: 2 } } },
  { name: "震荡_ADX低_限2", question: "预案4:ADX14<20单因素(881行业中位数)", overrides: {
    oscillation_filter: { adx_max: 20, require_all: false, oscillating_daily_buy_limit: 2 } } },
  { name: "震荡_贴近MA20_限2", question: "预案4:价格在MA20附近反复单因素", overrides: {
    oscillation_filter: { near_ma20_band: 0.015, require_all: false, oscillating_daily_buy_limit: 2 } } },
  { name: "震荡_宽度弱_限2", question: "预案4:上涨行业占比低单因素", overrides: {
    oscillation_filter: { breadth_max: 0.5, require_all: false, oscillating_daily_buy_limit: 2 } } },
  { name: "震荡_斜率或ADX_限2", question: "预案4:两因素任一成立的组合", overrides: {
    oscillation_filter: { composite_slope_band: 0.001, adx_max: 20, require_all: false, oscillating_daily_buy_limit: 2 } } },
  { name: "震荡_斜率且ADX_限2", question: "预案4:两因素同时成立的组合", overrides: {
    oscillation_filter: { composite_slope_band: 0.001, adx_max: 20, require_all: true, oscillating_daily_buy_limit: 2 } } },
  { name: "宽度确认_40", question: "预案1:大盘/板块宽度确认(上涨行业<40%不开新仓)", overrides: { breadth_confirm_min: 0.4 } },
  { name: "宽度确认_50", question: "预案1:宽度确认50%", overrides: { breadth_confirm_min: 0.5 } },
  { name: "宽度确认_60", question: "预案1:宽度确认60%", overrides: { breadth_confirm_min: 0.6 } },
  { name: "熔断_回撤5", question: "预案3:20日高点回撤>5%熔断", overrides: { drawdown_circuit: true } },
  { name: "熔断_连损3", question: "预案3:连续3笔策略止损熔断", overrides: { stop_streak_circuit: true } },
  { name: "熔断_双开", question: "预案3:两类熔断同时启用", overrides: { drawdown_circuit: true, stop_streak_circuit: true } },
  { name: "止盈12_锚生产", question: "生产§2.2一档止盈+12%收盘触发(引擎简化为全退)", overrides: { take_profit_pct: 0.12 } },
  { name: "止盈8", question: "更紧的止盈对照", overrides: { take_profit_pct: 0.08 } },
  { name: "止盈20", question: "更松的止盈对照", overrides: { take_profit_pct: 0.20 } },
  // 第二轮：训练窗胜出因素组合 + 熔断阈值敏感性（预案给定5%，其余为敏感性对照）。
  { name: "组_熔断5_止盈12", question: "两个最大正贡献因素组合", overrides: { drawdown_circuit: true, take_profit_pct: 0.12 } },
  { name: "组_熔断5_止盈12_宽度60", question: "组合+宽度确认", overrides: { drawdown_circuit: true, take_profit_pct: 0.12, breadth_confirm_min: 0.6 } },
  { name: "组_熔断5_止盈12_ADX限2", question: "组合+震荡期ADX限仓", overrides: { drawdown_circuit: true, take_profit_pct: 0.12,
    oscillation_filter: { adx_max: 20, require_all: false, oscillating_daily_buy_limit: 2 } } },
  { name: "组_熔断5_止盈12_止损6", question: "组合+紧止损交互", overrides: { drawdown_circuit: true, take_profit_pct: 0.12, stop_loss_pct: 0.06 } },
  { name: "组_熔断5_止盈12_止损10", question: "组合+松止损交互", overrides: { drawdown_circuit: true, take_profit_pct: 0.12, stop_loss_pct: 0.10 } },
  { name: "组_熔断3_止盈12", question: "熔断阈值敏感性3%", overrides: { drawdown_circuit: true, drawdown_circuit_pct: 0.03, take_profit_pct: 0.12 } },
  { name: "组_熔断8_止盈12", question: "熔断阈值敏感性8%", overrides: { drawdown_circuit: true, drawdown_circuit_pct: 0.08, take_profit_pct: 0.12 } },
  { name: "组_熔断12_止盈12", question: "熔断阈值敏感性12%", overrides: { drawdown_circuit: true, drawdown_circuit_pct: 0.12, take_profit_pct: 0.12 } },
  { name: "组_止盈12_宽度60", question: "止盈+宽度确认（无熔断对照）", overrides: { take_profit_pct: 0.12, breadth_confirm_min: 0.6 } },
  { name: "组_止盈12_限仓2", question: "止盈+无条件限仓2（无熔断对照）", overrides: { take_profit_pct: 0.12, daily_buy_limit: 2 } },
  { name: "组_双熔断_宽度60", question: "最终候选:双熔断+宽度确认60", overrides: { drawdown_circuit: true, stop_streak_circuit: true, breadth_confirm_min: 0.6 } },
  { name: "组_双熔断_宽度60_止盈12", question: "最终候选+一档止盈", overrides: { drawdown_circuit: true, stop_streak_circuit: true, breadth_confirm_min: 0.6, take_profit_pct: 0.12 } },
  { name: "组_双熔断_止损12", question: "双熔断+宽止损交互", overrides: { drawdown_circuit: true, stop_streak_circuit: true, stop_loss_pct: 0.12 } },
  // 扩池实验（--sample 500）：停牌近似纳入后，同类限仓与震荡过滤首次具备验证条件。
  { name: "右侧500_基线_限5", question: "扩池基线：候选变密后每日限5是否成为约束", overrides: {} },
  { name: "右侧500_限仓2_无条件", question: "预案1:扩池后无条件限2", overrides: { daily_buy_limit: 2 } },
  { name: "右侧500_震荡_斜率限2", question: "预案1+4:扩池后震荡期限2(MA20斜率平)", overrides: {
    oscillation_filter: { composite_slope_band: 0.001, require_all: false, oscillating_daily_buy_limit: 2 } } },
  { name: "右侧500_震荡_ADX限2", question: "预案1+4:扩池后震荡期限2(ADX低)", overrides: {
    oscillation_filter: { adx_max: 20, require_all: false, oscillating_daily_buy_limit: 2 } } },
  { name: "右侧500_宽度确认60", question: "预案1:扩池后宽度确认", overrides: { breadth_confirm_min: 0.6 } },
  { name: "右侧500_熔断5", question: "预案3:扩池后回撤熔断", overrides: { drawdown_circuit: true, stop_streak_circuit: true } },
  { name: "右侧500_止盈12", question: "扩池后一档止盈", overrides: { take_profit_pct: 0.12 } },
  { name: "左侧500_严格基线", question: "预案4:扩池后严格左侧信号密度与收益", overrides: { rule: "left_reversal_daily_v1" } },
  { name: "左侧500_放开_跌幅4", question: "单因素:5日跌幅-6%→-4%", overrides: { rule: "left_reversal_daily_v1",
    left_reversal_params: { five_day_decline_pct: 0.04 } } },
  { name: "左侧500_放开_跌幅3", question: "单因素:5日跌幅-6%→-3%", overrides: { rule: "left_reversal_daily_v1",
    left_reversal_params: { five_day_decline_pct: 0.03 } } },
  { name: "左侧500_放开_RSI40", question: "单因素:RSI≤35→≤40", overrides: { rule: "left_reversal_daily_v1",
    left_reversal_params: { rsi_max: 40 } } },
  { name: "左侧500_放开_MA20偏移5", question: "单因素:低于MA20 8%→5%", overrides: { rule: "left_reversal_daily_v1",
    left_reversal_params: { ma20_deviation_pct: 0.05 } } },
  { name: "左侧500_放开_组合A", question: "组合:跌幅4%+RSI40+MA20偏移5%", overrides: { rule: "left_reversal_daily_v1",
    left_reversal_params: { five_day_decline_pct: 0.04, rsi_max: 40, ma20_deviation_pct: 0.05 } } },
  { name: "左侧500_放开_组合B", question: "组合(更深):跌幅3%+RSI45+MA20偏移3%", overrides: { rule: "left_reversal_daily_v1",
    left_reversal_params: { five_day_decline_pct: 0.03, rsi_max: 45, ma20_deviation_pct: 0.03 } } },
  { name: "左侧500_组合A_加仓", question: "组合A验证信号质量:单笔0.2→0.4、槽位5→10", overrides: { rule: "left_reversal_daily_v1",
    left_reversal_params: { five_day_decline_pct: 0.04, rsi_max: 40, ma20_deviation_pct: 0.05 },
    position_fraction: 0.4, max_positions: 10, daily_buy_limit: 10 } },
  { name: "左侧1000_严格基线", question: "方向验证:千只池严格左侧", overrides: { rule: "left_reversal_daily_v1" } },
  { name: "左侧1000_组合A", question: "方向验证:千只池组合A(信号频率×2)", overrides: { rule: "left_reversal_daily_v1",
    left_reversal_params: { five_day_decline_pct: 0.04, rsi_max: 40, ma20_deviation_pct: 0.05 } } },
  // 优化落地验证：右侧生产分档退出 ± 组合级熔断。
  { name: "右侧500_分档退出", question: "优化1:生产§2分档退出(冷却/分批/移动/转弱/复核/时间)", overrides: { exit_model: "production_tiered" } },
  { name: "右侧500_分档退出_熔断5", question: "优化1+2:分档退出+组合级熔断5%", overrides: { exit_model: "production_tiered", drawdown_circuit: true, stop_streak_circuit: true } },
  // 优化第三轮：针对负期望根源——盈利单被截断与入场追高。
  { name: "右侧500_盈利奔跑", question: "优化3:profit_trail(分批止盈+移动止损,无时间兜底/复核换手)", overrides: { exit_model: "profit_trail" } },
  { name: "右侧500_盈利奔跑_熔断5", question: "优化3+2:盈利奔跑+熔断5%", overrides: { exit_model: "profit_trail", drawdown_circuit: true, stop_streak_circuit: true } },
  { name: "右侧500_股性过滤35", question: "优化4:20日振幅≥3.5%才可入场(时点安全)", overrides: { min_amplitude_20: 0.035 } },
  { name: "右侧500_股性过滤45", question: "优化4:20日振幅≥4.5%才可入场", overrides: { min_amplitude_20: 0.045 } },
  { name: "右侧500_股性45_盈利奔跑_熔断5", question: "优化3+4+2:股性过滤+盈利奔跑+熔断", overrides: { min_amplitude_20: 0.045, exit_model: "profit_trail", drawdown_circuit: true, stop_streak_circuit: true } },
  { name: "右侧500_不追高", question: "优化5:T+1开盘不高于信号收盘才买(缺口上限0)", overrides: { max_open_gap_pct: 0 } },
  { name: "右侧500_不追高_股性45_盈利奔跑_熔断5", question: "优化3+4+5+2:全部入场与退出优化叠加", overrides: { max_open_gap_pct: 0, min_amplitude_20: 0.045, exit_model: "profit_trail", drawdown_circuit: true, stop_streak_circuit: true } },
];

interface WindowSpec {
  start: string; end: string;
  env?: "none" | "current_881" | "synthetic_881";
  warmup?: number;
  label: string;
}
function windowSpec(window: WindowName): WindowSpec {
  const config = WINDOWS[window] as { start: string; end: string; env?: WindowSpec["env"] };
  return { start: config.start, end: config.end, env: config.env ?? "current_881", label: window };
}
function basePlan(spec: WindowSpec, codes: string[]): StandardBacktestPlan {
  return {
    name: "预案验证", hypothesis: "系统策略优化方案预案消融实验", codes,
    start: spec.start, end: spec.end,
    rule: "right_side_daily_v1",
    environment_mode: spec.env ?? "current_881",
    ...(spec.warmup !== undefined ? { environment_warmup_days: spec.warmup } : {}),
    price_mode: "forward_research",
    initial_cash: 1_000_000, max_positions: 5, daily_buy_limit: 5, position_fraction: 0.2,
    stop_loss_pct: 0.08, max_holding_days: 20,
    drawdown_circuit: false, stop_streak_circuit: false, costs: { ...COSTS },
  };
}

/** regime 段实验矩阵：聚焦本轮因子问题——行业动量 vs 个股动量、残差动量、绝对动量闸门、52周高位。 */
function regimeExperiments(groups: Array<{ board: string; codes: string[] }>): Experiment[] {
  const topK = Math.min(30, groups.length);
  const stacked = {
    absolute_momentum: { days: 60, min_return: 0 },
    industry_groups: groups, industry_momentum: { days: 20, top_k: topK },
    near_52w_high_min: 0.9,
    residual_momentum: { days: 60, min_value: 0 },
    exit_model: "profit_trail" as const,
    drawdown_circuit: true, stop_streak_circuit: true,
  };
  return [
    { name: "基线", question: "段内基线：右侧六条件+止损8%+限5", overrides: {} },
    { name: "盈利奔跑", question: "profit_trail 退出（此前单因素最优）", overrides: { exit_model: "profit_trail" } },
    { name: "盈利奔跑_熔断5", question: "此前最优对照：profit_trail+双熔断", overrides: { exit_model: "profit_trail", drawdown_circuit: true, stop_streak_circuit: true } },
    { name: "绝对动量60", question: "MOP2012:综合60日收益<0停止新开仓", overrides: { absolute_momentum: { days: 60, min_return: 0 } } },
    { name: "绝对动量120", question: "MOP2012:120日版本", overrides: { absolute_momentum: { days: 120, min_return: 0 } } },
    { name: "行业闸门20_top30", question: "MG1999:个股行业20日动量>0且行业排名Top30", overrides: { industry_groups: groups, industry_momentum: { days: 20, top_k: topK } } },
    { name: "行业闸门60_top30", question: "MG1999:60日版本", overrides: { industry_groups: groups, industry_momentum: { days: 60, top_k: topK } } },
    { name: "残差动量60", question: "Blitz2011:个股60日收益跑赢所在行业≥0才入场", overrides: { industry_groups: groups, residual_momentum: { days: 60, min_value: 0 } } },
    { name: "行业60_残差60", question: "行业动量闸门+个股残差动量（行业与个股分解）", overrides: { industry_groups: groups, industry_momentum: { days: 60, top_k: topK }, residual_momentum: { days: 60, min_value: 0 } } },
    { name: "52周高位90", question: "GH2004:距52周最高收盘≥90%才入场", overrides: { near_52w_high_min: 0.9 } },
    { name: "全叠加", question: "绝对动量60+行业闸门20+残差60+52周+盈利奔跑+熔断5", overrides: { ...stacked } },
    { name: "全叠加_费用压力", question: "全叠加+30bp滑点压力", overrides: { ...stacked,
      costs: { label: "费用压力假设:佣金万2.5最低5元,卖税10bp,滑点30bp", commission_bps: 2.5, minimum_commission: 5, sell_tax_bps: 10, slippage_bps: 30, volume_participation: 0.02 } } },
  ];
}

/** 长窗口实验集（无环境模式：熔断与行业闸门不可用，回撤控制用连续缩仓）。 */
function longWindowExperiments(): Experiment[] {
  return [
    { name: "长窗_基线", question: "长窗基线（简化退出）", overrides: {} },
    { name: "长窗_盈利奔跑", question: "profit_trail 长窗稳健性", overrides: { exit_model: "profit_trail" } },
    { name: "长窗_52周高位_盈利奔跑", question: "52周高位+盈利奔跑（无熔断）", overrides: { near_52w_high_min: 0.9, exit_model: "profit_trail" } },
    { name: "长窗_波动率目标", question: "波动率目标仓位长窗", overrides: { vol_target_sigma: 0.02 } },
    { name: "长窗_回撤缩仓5", question: "回撤连续缩仓长窗", overrides: { drawdown_scale_max: 0.05 } },
    { name: "长窗_叠加", question: "52周高位+波动目标+回撤缩仓+盈利奔跑（无熔断无行业闸门）", overrides: {
      near_52w_high_min: 0.9, vol_target_sigma: 0.02, drawdown_scale_max: 0.1, exit_model: "profit_trail" } },
    { name: "长窗_左侧组合A", question: "左侧组合A 长窗", overrides: { rule: "left_reversal_daily_v1",
      left_reversal_params: { five_day_decline_pct: 0.04, rsi_max: 40, ma20_deviation_pct: 0.05 } } },
  ];
}

/** 研究引擎三策略与组合模式（预案2:震荡市处理——右侧/试盘限名、波段0.8、左侧保留）。 */
function nonRightExperiments(codes: string[]): Experiment[] {
  const third = Math.floor(codes.length / 3);
  const fifth = Math.floor(codes.length / 5);
  return [
    { name: "左侧反转_基线", question: "预案4:左侧保持严格,提供胜率证据", overrides: { rule: "left_reversal_daily_v1" } },
    { name: "试盘启动_基线", question: "预案4:试盘T+1收盘复核口径(收盘信号+次日执行)", overrides: { rule: "trial_start_daily_v1" } },
    { name: "波段箱体_基线", question: "预案4:波段箱底止损证据", overrides: { rule: "swing_box_daily_v1" } },
    { name: "组合_右左波段", question: "预案2:多策略预算竞争与波段0.8仓位", overrides: {
      rule: "portfolio_daily_v1",
      strategies: [
        { rule: "right_side_daily_v1", codes: codes.slice(0, third), allocation_pct: 0.5, max_positions: 3, daily_buy_limit: 3, position_fraction: 0.34, stop_loss_pct: 0.08, max_holding_days: 20 },
        { rule: "left_reversal_daily_v1", codes: codes.slice(third, 2 * third), allocation_pct: 0.25, max_positions: 2, daily_buy_limit: 1, position_fraction: 0.5 },
        { rule: "swing_box_daily_v1", codes: codes.slice(2 * third), allocation_pct: 0.25, max_positions: 2, daily_buy_limit: 1, position_fraction: 0.4 },
      ] } },
    { name: "组合500_优化版", question: "优化落地组合:右分档退出+组合熔断,左组合A,波段保留", overrides: {
      rule: "portfolio_daily_v1", drawdown_circuit: true, stop_streak_circuit: true,
      strategies: [
        { rule: "right_side_daily_v1", codes: codes.slice(0, 3 * fifth), allocation_pct: 0.5, max_positions: 4, daily_buy_limit: 2, position_fraction: 0.34, stop_loss_pct: 0.08, max_holding_days: 20, exit_model: "production_tiered" },
        { rule: "left_reversal_daily_v1", codes: codes.slice(3 * fifth, 4 * fifth), allocation_pct: 0.25, max_positions: 2, daily_buy_limit: 1, position_fraction: 0.5,
          left_reversal_params: { five_day_decline_pct: 0.04, rsi_max: 40, ma20_deviation_pct: 0.05 } },
        { rule: "swing_box_daily_v1", codes: codes.slice(4 * fifth), allocation_pct: 0.25, max_positions: 2, daily_buy_limit: 1, position_fraction: 0.4 },
      ] } },
    { name: "组合500_对照", question: "对照:简化退出+严格左侧+无熔断的同结构组合", overrides: {
      rule: "portfolio_daily_v1",
      strategies: [
        { rule: "right_side_daily_v1", codes: codes.slice(0, 3 * fifth), allocation_pct: 0.5, max_positions: 4, daily_buy_limit: 2, position_fraction: 0.34, stop_loss_pct: 0.08, max_holding_days: 20 },
        { rule: "left_reversal_daily_v1", codes: codes.slice(3 * fifth, 4 * fifth), allocation_pct: 0.25, max_positions: 2, daily_buy_limit: 1, position_fraction: 0.5 },
        { rule: "swing_box_daily_v1", codes: codes.slice(4 * fifth), allocation_pct: 0.25, max_positions: 2, daily_buy_limit: 1, position_fraction: 0.4 },
      ] } },
  ];
}

/** 固定样本：所有窗口共用。扩池口径——只要首根行情不晚于区间起点、末根行情不早于区间终点
 *  （上市覆盖整个区间）且无非法价格行即入选；区间内缺行或零量日按停牌近似由冻结输入层处理。
 *  按代码等距抽取 sampleSize 只，保证训练/样本外同池可比。 */
const SAMPLE_RANGE = { start: standardSeed(WINDOWS.train.start), end: WINDOWS.test.end };
interface SampleRow { code: string; suspended_days: number }
async function selectSample(window: WindowName): Promise<{ codes: string[]; universe: number; avgSuspended: number }> {
  const rangeStart = (WINDOWS[window] as { sampleStart?: string }).sampleStart ?? SAMPLE_RANGE.start;
  return selectSampleForRange(standardSeed(WINDOWS[window].start), rangeStart, WINDOWS[window].end);
}
/** 通用选样：上市覆盖 [rangeStart, rangeEnd] 整个区间、种子期（screenStart 起）无非法价格行的股票等距抽取。 */
async function selectSampleForRange(screenStart: string, rangeStart: string, rangeEnd: string): Promise<{ codes: string[]; universe: number; avgSuspended: number }> {
  const pool = getPool(loadConfig().databaseUrl);
  const { rows } = await pool.query<SampleRow>(
    `WITH span AS (SELECT count(*)::int AS open_days FROM market_trading_day WHERE is_open AND trade_date BETWEEN $2 AND $3),
       cov AS (SELECT i.code, count(*)::int AS n, min(b.bar_date) AS f, max(b.bar_date) AS l,
                      count(*) FILTER (WHERE b.volume IS NULL OR b.volume <= 0) AS zero_vol,
                      count(*) FILTER (WHERE b.low IS NULL OR b.low <= 0
                        OR b.low > LEAST(b.open, b.close) OR b.high < GREATEST(b.open, b.close)) AS bad_price
               FROM market_instrument i JOIN market_bar b ON b.instrument_id=i.id AND b.freq='day'
               WHERE i.kind='stock' AND b.bar_date BETWEEN $2 AND $3 GROUP BY i.code)
     SELECT code, span.open_days - n AS suspended_days FROM cov, span
     WHERE f <= $2 AND l >= $3 AND bad_price = 0
       AND code NOT IN (SELECT i.code FROM market_bar b JOIN market_instrument i ON i.id=b.instrument_id
                        WHERE i.kind='stock' AND b.freq='day' AND b.bar_date BETWEEN $1 AND $3
                          AND (b.low IS NULL OR b.low <= 0 OR b.low > LEAST(b.open, b.close) OR b.high < GREATEST(b.open, b.close)))
     ORDER BY code`, [screenStart, rangeStart, rangeEnd]);
  if (rows.length < sampleSize) throw new Error(`区间覆盖标的不足：${rows.length} < ${sampleSize}`);
  const excluded = (await smallExclusion) ?? new Set<string>();
  const eligible = rows.filter(row => !excluded.has(row.code));
  const picked: SampleRow[] = [];
  const step = eligible.length / sampleSize;
  for (let index = 0; index < sampleSize; index += 1) picked.push(eligible[Math.floor(index * step)]!);
  const avgSuspended = picked.reduce((sum, row) => sum + Number(row.suspended_days), 0) / picked.length;
  return { codes: picked.map(row => row.code).sort(), universe: rows.length, avgSuspended };
}

/** 股性分层（用户假设：右侧主升适配炒作型标的、左侧适配周期股）。
 *  股性指标全部用 2021-01-01→2022-12-31（两个实验窗口之前）的已实现行情计算，无前视；
 *  行业归属为当前 881 归属回看（研究近似）。涨停口径按生产公式 前收×1.1（创业板/科创板 20% 制不适用，落入大阳桶）。 */
const CHARACTER_WINDOW = { start: "2021-01-01", end: "2022-12-31" };
const CYCLICAL_BOARDS = ["881105.TI", "881107.TI", "881108.TI", "881112.TI", "881115.TI", "881137.TI",
  "881148.TI", "881168.TI", "881169.TI", "881170.TI", "881180.TI", "881264.TI", "881267.TI"];
/** 周期行业分组（行业动量闸门的计划载荷：board → 成员代码），由 selectByCharacter 动态填充。 */
const CYCLICAL_GROUPS: Array<{ board: string; codes: string[] }> = CYCLICAL_BOARDS.map(board => ({ board, codes: [] }));
/** since 传入时启用长窗口径：上市须覆盖 since（首根 ≤ since）、坏行筛查扩到六年种子期。 */
async function selectByCharacter(kind: "hype" | "cyclical" | "calm", since?: string): Promise<string[]> {
  const pool = getPool(loadConfig().databaseUrl);
  if (kind === "cyclical") {
    const screenStart = since ? standardSeed(since) : "2017-01-03";
    const spanJoin = since
      ? `JOIN span s ON s.code = i.code AND s.first_day <= $5::date`
      : "";
    const spanCte = since
      ? `, span AS (SELECT i.code, min(b.bar_date) AS first_day FROM market_bar b JOIN market_instrument i ON i.id=b.instrument_id
          WHERE i.kind='stock' AND b.freq='day' AND i.code ~ '^\\d{6}\\.(SH|SZ)$' GROUP BY i.code)`
      : "";
    const { rows } = await pool.query<{ code: string; board: string }>(
      `WITH boards AS (SELECT i.id, i.code AS board_code FROM market_instrument i WHERE i.code = ANY($1::text[])),
         bad AS (SELECT i.code FROM market_bar b JOIN market_instrument i ON i.id=b.instrument_id
                 WHERE i.kind='stock' AND b.freq='day' AND b.bar_date BETWEEN $4 AND '2026-08-31'
                   AND (b.low IS NULL OR b.low <= 0 OR b.low > LEAST(b.open, b.close) OR b.high < GREATEST(b.open, b.close))
                 GROUP BY i.code)${spanCte},
         px AS (SELECT i.code, count(*)::int AS n FROM market_bar b JOIN market_instrument i ON i.id=b.instrument_id
                WHERE i.kind='stock' AND b.freq='day' AND b.bar_date BETWEEN $2 AND $3 AND b.volume > 0 AND b.close > 0 GROUP BY i.code)
       SELECT DISTINCT i.code AS code, bd.board_code AS board FROM market_board_membership m
       JOIN boards bd ON bd.id = m.board_instrument_id
       JOIN market_instrument i ON i.id = m.member_instrument_id
       JOIN px ON px.code = i.code${spanJoin ? " " + spanJoin.trim() : ""}
       WHERE m.effective_to IS NULL AND px.n >= 200 AND i.code NOT IN (SELECT code FROM bad) AND i.code ~ '^\\d{6}\\.(SH|SZ)$' ORDER BY i.code`,
      since
        ? [CYCLICAL_BOARDS, CHARACTER_WINDOW.start, CHARACTER_WINDOW.end, screenStart, since]
        : [CYCLICAL_BOARDS, CHARACTER_WINDOW.start, CHARACTER_WINDOW.end, screenStart]);
    if (rows.length < 50) throw new Error(`周期行业分层过小：${rows.length}`);
    const excludedC = (await smallExclusion) ?? new Set<string>();
    const codes = applyExclusion(rows.map(row => row.code), excludedC);
    for (const group of CYCLICAL_GROUPS) group.codes = [];
    const groupByBoard = new Map(CYCLICAL_GROUPS.map(group => [group.board, group]));
    for (const row of rows) {
      if (excludedC.has(row.code)) continue;
      groupByBoard.get(row.board)?.codes.push(row.code);
    }
    return codes;
  }
  const cap = kind === "hype" ? 500 : 600;
  const hypeFilter = kind === "hype" ? "AND (lu::float / days > 0.015 OR bu::float / days > 0.04)" : "";
  const order = kind === "hype" ? "ORDER BY lu DESC, code" : "ORDER BY mean_amp, code";
  const { rows } = await pool.query<{ code: string }>(
    `WITH px AS (
       SELECT i.code, CASE WHEN b.close > 0 THEN (b.high - b.low) / b.close END AS amp, b.close,
              lag(b.close) OVER (PARTITION BY i.code ORDER BY b.bar_date) AS pc
       FROM market_bar b JOIN market_instrument i ON i.id=b.instrument_id
       WHERE i.kind='stock' AND b.freq='day' AND b.bar_date BETWEEN $1 AND $2 AND b.volume > 0 AND b.close > 0
     ), bad AS (SELECT i.code FROM market_bar b JOIN market_instrument i ON i.id=b.instrument_id
                WHERE i.kind='stock' AND b.freq='day' AND b.bar_date BETWEEN '2017-01-03' AND '2026-08-31'
                  AND (b.low IS NULL OR b.low <= 0 OR b.low > LEAST(b.open, b.close) OR b.high < GREATEST(b.open, b.close))
                GROUP BY i.code), st AS (
       SELECT code, count(*)::int AS days, avg(amp) AS mean_amp,
              count(*) FILTER (WHERE pc > 0 AND close >= round(pc * 1.1 * 100) / 100 - 1e-9) AS lu,
              count(*) FILTER (WHERE pc > 0 AND close / pc - 1 >= 0.05) AS bu
       FROM px GROUP BY code HAVING count(*) >= 200
     )
     SELECT code FROM st WHERE mean_amp > 0 ${hypeFilter === "" ? (kind === "calm" ? "AND mean_amp < 0.03" : "") : hypeFilter} AND code NOT IN (SELECT code FROM bad) AND code ~ '^\\d{6}\\.(SH|SZ)$' ${order} LIMIT $3`,
    [CHARACTER_WINDOW.start, CHARACTER_WINDOW.end, cap]);
  if (rows.length < 50) throw new Error(`分层过小：${kind} ${rows.length}`);
  const excludedK = await smallExclusion;
  return applyExclusion(rows.map(row => row.code), excludedK);
}

/** 分层矩阵策略集：同一组策略跑在不同股性分层上，检验「策略×股性」匹配假设。 */
function stratumExperiments(): Experiment[] {
  return [
    { name: "右侧_基线", question: "动量信号在该分层上的裸表现", overrides: {} },
    { name: "右侧_盈利奔跑_熔断5", question: "动量信号+已验证风控", overrides: { exit_model: "profit_trail", drawdown_circuit: true, stop_streak_circuit: true } },
    { name: "左侧_组合A", question: "超卖反转信号在该分层上的裸表现", overrides: { rule: "left_reversal_daily_v1",
      left_reversal_params: { five_day_decline_pct: 0.04, rsi_max: 40, ma20_deviation_pct: 0.05 } } },
    { name: "右侧_盈利奔跑_熔断5_费用压力", question: "费用压力:佣金万5+滑点20bp", overrides: { exit_model: "profit_trail", drawdown_circuit: true, stop_streak_circuit: true,
      costs: { label: "费用压力假设:佣金万5最低5元,卖税10bp,滑点20bp", commission_bps: 5, minimum_commission: 5, sell_tax_bps: 10, slippage_bps: 20, volume_participation: 0.02 } } },
    { name: "试盘启动", question: "回踩突破信号(炒作型假设的适配信号)", overrides: { rule: "trial_start_daily_v1" } },
    // 阶段二：行业动量闸门（Moskowitz-Grinblatt 行业动量 + MOP 绝对动量）与阶段三：52周高位过滤。
    { name: "右侧_行业闸门20Top10", question: "阶段2:行业20日动量排名前10才入场", overrides: {
      industry_groups: CYCLICAL_GROUPS, industry_momentum: { days: 20, top_k: 10 } } },
    { name: "右侧_行业闸门20绝对", question: "阶段2:行业20日动量为正才入场(绝对动量)", overrides: {
      industry_groups: CYCLICAL_GROUPS, industry_momentum: { days: 20 } } },
    { name: "右侧_行业闸门60Top10_熔断5_盈利奔跑", question: "阶段2:60日动量Top10+盈利奔跑+熔断", overrides: {
      exit_model: "profit_trail", drawdown_circuit: true, stop_streak_circuit: true,
      industry_groups: CYCLICAL_GROUPS, industry_momentum: { days: 60, top_k: 10 } } },
    { name: "右侧_52周高位09", question: "阶段3:现价距52周高点≤10%才入场", overrides: { near_52w_high_min: 0.9 } },
    { name: "右侧_52周高位09_盈利奔跑_熔断5", question: "阶段3+盈利奔跑+熔断", overrides: {
      near_52w_high_min: 0.9, exit_model: "profit_trail", drawdown_circuit: true, stop_streak_circuit: true } },
    // 阶段四：波动率目标仓位与回撤连续缩仓。
    { name: "右侧_波动率目标", question: "阶段4:单笔预算按20日波动缩放(目标日波动2%)", overrides: { vol_target_sigma: 0.02 } },
    { name: "右侧_回撤缩仓5", question: "阶段4:回撤越深新开仓越少(连续函数)", overrides: { drawdown_scale_max: 0.05 } },
    { name: "右侧_全叠加_周期", question: "阶段2+3+4:行业闸门+52周高位+波动目标+回撤缩仓+盈利奔跑+熔断", overrides: {
      industry_groups: CYCLICAL_GROUPS, industry_momentum: { days: 60, top_k: 10 }, near_52w_high_min: 0.9,
      vol_target_sigma: 0.02, drawdown_scale_max: 0.1, exit_model: "profit_trail", drawdown_circuit: true, stop_streak_circuit: true } },
    { name: "右侧_全叠加_周期_费用压力", question: "全叠加+费用压力(佣金万5+滑点20bp)", overrides: {
      industry_groups: CYCLICAL_GROUPS, industry_momentum: { days: 60, top_k: 10 }, near_52w_high_min: 0.9,
      vol_target_sigma: 0.02, drawdown_scale_max: 0.1, exit_model: "profit_trail", drawdown_circuit: true, stop_streak_circuit: true,
      costs: { label: "费用压力假设:佣金万5最低5元,卖税10bp,滑点20bp", commission_bps: 5, minimum_commission: 5, sell_tax_bps: 10, slippage_bps: 20, volume_participation: 0.02 } } },
  ];
}

/** 研究收口终验：周期行业配置（盈利奔跑+熔断5）并入绝对动量闸门（参数稳健性 60/90/120）+ 全叠加变体。 */
function cyclicalCloseExperiments(): Experiment[] {
  const base = { exit_model: "profit_trail" as const, drawdown_circuit: true, stop_streak_circuit: true };
  const stacked = { ...base,
    industry_groups: CYCLICAL_GROUPS, industry_momentum: { days: 60, top_k: 10 },
    near_52w_high_min: 0.9, vol_target_sigma: 0.02, drawdown_scale_max: 0.1 };
  const stress = { label: "收口费用压力:佣金万2.5最低5元,卖税10bp,滑点30bp", commission_bps: 2.5,
    minimum_commission: 5, sell_tax_bps: 10, slippage_bps: 30, volume_participation: 0.02 };
  return [
    { name: "收口_基准_盈利奔跑熔断5", question: "第六轮推荐配置原样复跑（收口对照锚点）", overrides: { ...base } },
    { name: "收口_加绝对动量60", question: "基准+综合指数60日收益<0停开新仓", overrides: { ...base, absolute_momentum: { days: 60, min_return: 0 } } },
    { name: "收口_加绝对动量90", question: "参数稳健性:90日", overrides: { ...base, absolute_momentum: { days: 90, min_return: 0 } } },
    { name: "收口_加绝对动量120", question: "参数稳健性:120日", overrides: { ...base, absolute_momentum: { days: 120, min_return: 0 } } },
    { name: "收口_绝对动量60_费用压力", question: "60日+30bp滑点压力", overrides: { ...base, absolute_momentum: { days: 60, min_return: 0 }, costs: { ...stress } } },
    { name: "收口_绝对动量120_费用压力", question: "120日+30bp滑点压力", overrides: { ...base, absolute_momentum: { days: 120, min_return: 0 }, costs: { ...stress } } },
    { name: "收口_全叠加_加绝对动量60", question: "第六轮全叠加+绝对动量60", overrides: { ...stacked, absolute_momentum: { days: 60, min_return: 0 } } },
    { name: "收口_全叠加_加绝对动量60_费用压力", question: "全叠加+绝对动量60+30bp滑点", overrides: { ...stacked, absolute_momentum: { days: 60, min_return: 0 }, costs: { ...stress } } },
  ];
}

/** 周期股入场信号研究矩阵（第十轮）：确认强度、六条件逐条屏蔽、触发阈值敏感性、开盘执行与多信号结构。
 *  底座统一为已验证的盈利奔跑+熔断5；锚点=收口基准（六条件全过）。 */
function cyclicalSignalExperiments(): Experiment[] {
  const base = { exit_model: "profit_trail" as const, drawdown_circuit: true, stop_streak_circuit: true };
  const disable = (...conditions: Array<NonNullable<StandardRightSideParams["disable_conditions"]>[number]>) =>
    ({ right_side_params: { disable_conditions: conditions } });
  return [
    { name: "信号_底座_六条件", question: "锚点：收口基准复跑（六条件全过+盈利奔跑+熔断5）", overrides: { ...base } },
    { name: "信号_五条件", question: "确认强度：passed>=5（放宽量能或阳线类）", overrides: { ...base, right_side_params: { min_passed_count: 5 } } },
    { name: "信号_四条件", question: "确认强度：passed>=4", overrides: { ...base, right_side_params: { min_passed_count: 4 } } },
    { name: "信号_去量能", question: "屏蔽 volume_expanding：量能条件是否在周期股上是噪声", overrides: { ...base, ...disable("volume_expanding") } },
    { name: "信号_去阳线", question: "屏蔽 bullish_body：实体涨幅条件贡献", overrides: { ...base, ...disable("bullish_body") } },
    { name: "信号_去排列", question: "屏蔽 bullish_alignment：短期多头排列贡献", overrides: { ...base, ...disable("bullish_alignment") } },
    { name: "信号_去MA20上行", question: "屏蔽 ma20_rising：中期趋势条件贡献", overrides: { ...base, ...disable("ma20_rising") } },
    { name: "信号_去DIF", question: "屏蔽 dif_positive：DIF>0 贡献", overrides: { ...base, ...disable("dif_positive") } },
    { name: "信号_去MACD加速", question: "屏蔽 macd_accelerating：加速条件贡献", overrides: { ...base, ...disable("macd_accelerating") } },
    { name: "信号_MACD加速_0.05bp", question: "阈值敏感性：MACD增量门槛 0.1%→0.05%", overrides: { ...base, right_side_params: { macd_delta_min: 0.0005 } } },
    { name: "信号_MACD加速_0.2bp", question: "阈值敏感性：0.1%→0.2%", overrides: { ...base, right_side_params: { macd_delta_min: 0.002 } } },
    { name: "信号_MACD加速_0.03bp", question: "剂量响应：0.05%→0.03%（更松）", overrides: { ...base, right_side_params: { macd_delta_min: 0.0003 } } },
    { name: "信号_MACD加速_0.07bp", question: "剂量响应：0.05%与0.1%之间的0.07%", overrides: { ...base, right_side_params: { macd_delta_min: 0.0007 } } },
    { name: "信号_MACD加速_0.15bp", question: "剂量响应：0.1%与0.2%之间的0.15%", overrides: { ...base, right_side_params: { macd_delta_min: 0.0015 } } },
    { name: "信号_量比_1.0", question: "阈值敏感性：放量门槛 1.2→1.0 倍", overrides: { ...base, right_side_params: { volume_ratio_min: 1.0 } } },
    { name: "信号_量比_1.5", question: "阈值敏感性：1.2→1.5 倍", overrides: { ...base, right_side_params: { volume_ratio_min: 1.5 } } },
    { name: "信号_阳线_0.5", question: "阈值敏感性：阳线实体 1%→0.5%", overrides: { ...base, right_side_params: { body_min_pct: 0.005 } } },
    { name: "信号_阳线_2", question: "阈值敏感性：1%→2%", overrides: { ...base, right_side_params: { body_min_pct: 0.02 } } },
    { name: "信号_开盘缺口0", question: "执行：次日开盘不高于信号收盘（不追高）", overrides: { ...base, max_open_gap_pct: 0 } },
    { name: "信号_开盘缺口2", question: "执行：缺口上限 5%→2%", overrides: { ...base, max_open_gap_pct: 0.02 } },
    { name: "信号_左侧组合A_熔断", question: "多信号：左侧组合A+组合级熔断（左侧首次配底座）", overrides: {
      rule: "portfolio_daily_v1", drawdown_circuit: true, stop_streak_circuit: true,
      strategies: [{ rule: "left_reversal_daily_v1", codes: [], allocation_pct: 1, max_positions: 5, daily_buy_limit: 5, position_fraction: 0.2,
        left_reversal_params: { five_day_decline_pct: 0.04, rsi_max: 40, ma20_deviation_pct: 0.05 } }] } },
    { name: "信号_右左组合_熔断", question: "多信号：右侧底座60%+左侧组合A40%+组合级熔断", overrides: {
      rule: "portfolio_daily_v1", drawdown_circuit: true, stop_streak_circuit: true,
      strategies: [
        { rule: "right_side_daily_v1", codes: [], allocation_pct: 0.6, max_positions: 4, daily_buy_limit: 4, position_fraction: 0.25, exit_model: "profit_trail" },
        { rule: "left_reversal_daily_v1", codes: [], allocation_pct: 0.4, max_positions: 3, daily_buy_limit: 3, position_fraction: 0.34,
          left_reversal_params: { five_day_decline_pct: 0.04, rsi_max: 40, ma20_deviation_pct: 0.05 } },
      ] } },
    { name: "信号_波段_熔断", question: "多信号：波段箱体+组合级熔断（周期宇宙首测）", overrides: {
      rule: "portfolio_daily_v1", drawdown_circuit: true, stop_streak_circuit: true,
      strategies: [{ rule: "swing_box_daily_v1", codes: [], allocation_pct: 1, max_positions: 5, daily_buy_limit: 5, position_fraction: 0.2 }] } },
    // 第十轮合并验证：两个跨窗一致的单因素（MACD 门槛减半 + 开盘缺口 2%）叠加，加阳线档对照。
    { name: "合并_MACD005_缺口2", question: "MACD加速门槛0.05%+开盘缺口上限2%", overrides: { ...base,
      right_side_params: { macd_delta_min: 0.0005 }, max_open_gap_pct: 0.02 } },
    { name: "合并_MACD005_缺口2_阳线05", question: "合并+阳线实体0.5%（阳线档对照）", overrides: { ...base,
      right_side_params: { macd_delta_min: 0.0005, body_min_pct: 0.005 }, max_open_gap_pct: 0.02 } },
    { name: "缺口2_费用压力", question: "单因素缺口2+30bp滑点压力", overrides: { ...base, max_open_gap_pct: 0.02,
      costs: { label: "费用压力:佣金万2.5最低5元,卖税10bp,滑点30bp", commission_bps: 2.5, minimum_commission: 5, sell_tax_bps: 10, slippage_bps: 30, volume_participation: 0.02 } } },
    { name: "MACD005_费用压力", question: "单因素MACD005+30bp滑点压力", overrides: { ...base,
      right_side_params: { macd_delta_min: 0.0005 },
      costs: { label: "费用压力:佣金万2.5最低5元,卖税10bp,滑点30bp", commission_bps: 2.5, minimum_commission: 5, sell_tax_bps: 10, slippage_bps: 30, volume_participation: 0.02 } } },
    { name: "合并_MACD005_缺口2_费用压力", question: "合并+30bp滑点压力", overrides: { ...base,
      right_side_params: { macd_delta_min: 0.0005 }, max_open_gap_pct: 0.02,
      costs: { label: "费用压力:佣金万2.5最低5元,卖税10bp,滑点30bp", commission_bps: 2.5, minimum_commission: 5, sell_tax_bps: 10, slippage_bps: 30, volume_participation: 0.02 } } },
    { name: "合并_MACD005_缺口2_阳线05_费用压力", question: "合并阳线档+30bp滑点压力", overrides: { ...base,
      right_side_params: { macd_delta_min: 0.0005, body_min_pct: 0.005 }, max_open_gap_pct: 0.02,
      costs: { label: "费用压力:佣金万2.5最低5元,卖税10bp,滑点30bp", commission_bps: 2.5, minimum_commission: 5, sell_tax_bps: 10, slippage_bps: 30, volume_participation: 0.02 } } },
  ];
}

/** 组合类信号实验的 strategies.codes 用运行时宇宙填充（脚本阶段静态数组不可用）。 */
function fillSignalCodes(overrides: Partial<StandardBacktestPlan>, codes: string[]): Partial<StandardBacktestPlan> {
  const strategies = (overrides as { strategies?: Array<Record<string, unknown>> }).strategies;
  if (!strategies) return overrides;
  // 多策略按 allocation 比例前后段切分宇宙（契约禁止同一标的进多个子策略）。
  if (strategies.length <= 1) {
    return { ...overrides, strategies: strategies.map(strategy => ({ ...strategy, codes })) } as Partial<StandardBacktestPlan>;
  }
  const weights = strategies.map(strategy => Number(strategy.allocation_pct ?? 0));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = 0;
  const filled = strategies.map((strategy, index) => {
    const share = Math.max(1, Math.round((weights[index]! / totalWeight) * codes.length));
    const slice = codes.slice(cursor, index === strategies.length - 1 ? codes.length : cursor + share);
    cursor += slice.length;
    return { ...strategy, codes: slice };
  });
  return { ...overrides, strategies: filled } as Partial<StandardBacktestPlan>;
}

/** 与契约一致：正式起点前六年、按月截断。 */
function standardSeed(start: string): string {
  const year = Number(start.slice(0, 4)) - 6;
  const month = Number(start.slice(5, 7));
  const day = Math.min(Number(start.slice(8, 10)), new Date(Date.UTC(year, month, 0)).getUTCDate());
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

interface RunStats {
  name: string; question: string;
  total_return: number; annual_return: number; max_drawdown: number; market_reference: number; excess_return: number;
  trade_count: number; win_rate: number | null; fees_yuan: number; open_positions: number;
  exposure: number; paused_days: number; trading_days: number;
  exits: Record<string, number>;
  suppressed: Record<string, number>; expired: Record<string, number>; rejected: Record<string, number>;
  risk_triggers: Record<string, number>; recoveries: number;
  per_year: Record<string, number>;
  oscillating_days?: number; factor_days?: number;
}

async function runExperiment(exp: Experiment, plan: StandardBacktestPlan, days: StandardDay[],
    marketReference: number): Promise<RunStats> {
  const validated = validateStandardPlan({ ...plan, ...exp.overrides, name: exp.name, hypothesis: `预案验证:${exp.question}` });
  const engine = createPortfolioEngine(validated);
  let lastSeq = 0;
  let previous: StandardEquity | null = null;
  let realized: Record<string, number> = {};
  const equities: StandardEquity[] = [];
  const exits: Record<string, number> = {};
  const suppressed: Record<string, number> = {};
  const expired: Record<string, number> = {};
  const rejected: Record<string, number> = {};
  const riskTriggers: Record<string, number> = {};
  let recoveries = 0;
  let pausedDays = 0;
  for (const day of days) {
    const result = engine.next(day);
    realized = verifySettlement(validated, day, result, previous, lastSeq, realized);
    lastSeq += result.events.length;
    let riskEventToday = false;
    for (const event of result.events) {
      if (event.type === "closed") exits[event.reason] = (exits[event.reason] ?? 0) + 1;
      if (event.type === "suppressed") {
        suppressed[event.reason] = (suppressed[event.reason] ?? 0) + 1;
        if (event.reason === "risk_paused") riskEventToday = true;
      }
      if (event.type === "expired") expired[event.reason] = (expired[event.reason] ?? 0) + 1;
      if (event.type === "rejected") rejected[event.reason] = (rejected[event.reason] ?? 0) + 1;
      if (event.type === "risk_trigger") { riskTriggers[event.reason] = (riskTriggers[event.reason] ?? 0) + 1; riskEventToday = true; }
      if (event.type === "risk_recover") recoveries += 1;
    }
    if (result.equity) equities.push(result.equity);
    if (riskEventToday) pausedDays += 1;
    previous = result.equity ?? previous;
  }
  const metrics = engine.finish();
  const tradingDays = equities.length;
  const years: Record<string, number> = {};
  for (const equity of equities) years[equity.date.slice(0, 4)] = (years[equity.date.slice(0, 4)] ?? 1) * (1 + equity.daily_return);
  for (const key of Object.keys(years)) years[key] = Number((years[key]! - 1).toFixed(4));
  const exposure = equities.reduce((sum, equity) => sum + equity.market_value_cents / equity.equity_cents, 0) / Math.max(1, tradingDays);
  const totalReturn = metrics.total_return ?? 0;
  const oscillationFilter = validated.oscillation_filter;
  let oscillatingDays: number | undefined;
  let factorDays: number | undefined;
  if (oscillationFilter) {
    oscillatingDays = 0; factorDays = 0;
    for (const day of days) {
      if (day.date < validated.start) continue;
      if (!day.market_factors) continue;
      factorDays += 1;
      if (evaluateOscillation(day.market_factors, oscillationFilter)) oscillatingDays += 1;
    }
  }
  return {
    name: exp.name, question: exp.question,
    total_return: totalReturn,
    annual_return: Number((Math.pow(1 + totalReturn, 252 / Math.max(1, tradingDays)) - 1).toFixed(4)),
    max_drawdown: metrics.max_drawdown ?? 0,
    market_reference: Number(marketReference.toFixed(4)),
    excess_return: Number((totalReturn - marketReference).toFixed(4)),
    trade_count: metrics.trade_count ?? 0,
    win_rate: typeof metrics.win_rate === "number" ? Number(metrics.win_rate.toFixed(4)) : null,
    fees_yuan: (metrics.fees_cents ?? 0) / 100,
    open_positions: metrics.open_position_count ?? 0,
    exposure: Number(exposure.toFixed(4)),
    paused_days: pausedDays,
    trading_days: tradingDays,
    exits, suppressed, expired, rejected,
    risk_triggers: riskTriggers, recoveries,
    per_year: years,
    oscillating_days: oscillatingDays, factor_days: factorDays,
  };
}

function formatTable(stats: RunStats[]): string {
  const header = ["实验", "总收益", "年化", "最大回撤", "881参照", "超额", "交易", "胜率", "暴露", "暂停日", "费用元"];
  const rows = stats.map(stat => [stat.name, pct(stat.total_return), pct(stat.annual_return), pct(stat.max_drawdown),
    pct(stat.market_reference), pct(stat.excess_return), String(stat.trade_count),
    stat.win_rate === null ? "-" : pct(stat.win_rate), pct(stat.exposure), String(stat.paused_days), stat.fees_yuan.toFixed(0)]);
  const width = Math.max(...header.map((_, column) => Math.max(header[column]!.length, ...rows.map(row => row[column]!.length))));
  const line = (cells: string[]) => cells.map(cell => cell.padEnd(width, " ")).join("  ");
  return [line(header), line(header.map(() => "-".repeat(width))), ...rows.map(line)].join("\n");
}
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

const strataArg = argOf("--strata");

async function runBatch(spec: WindowSpec, codes: string[], experiments: Experiment[], tag: string, note: string): Promise<void> {
  console.log(`\n===== 窗口 ${spec.label} · ${tag} =====`);
  const plan = basePlan(spec, codes);
  console.log(`标的 ${codes.length} 只；实验 ${experiments.length} 组。${note}`);
  console.time("冻结输入");
  const pool = getPool(loadConfig().databaseUrl);
  const { report, chunks } = await inspectStandardInput(pool, plan, true);
  if (!report.executable) {
    console.error("预检未通过，缺口：");
    for (const gap of report.manifest.gaps.filter(item => item.severity === "error").slice(0, 20)) {
      console.error(` - [${gap.code}] ${gap.domain}${gap.instrument ? " " + gap.instrument : ""}${gap.date ? " " + gap.date : ""}: ${gap.message}`);
    }
    throw new Error("冻结输入不可执行");
  }
  console.timeEnd("冻结输入");
  const suspensionGap = report.manifest.gaps.find(gap => gap.domain === "suspension");
  if (suspensionGap) console.log(`停牌近似：${suspensionGap.message}`);
  console.log(`输入集 ${report.input_hash.slice(0, 12)}；${report.manifest.day_count} 日，${report.manifest.row_count} 行，压缩 ${(report.estimated_compressed_bytes / 1024 / 1024).toFixed(1)} MiB。`);
  const days = chunks.map(chunk => decodeStandardChunk({
    payload: chunk.payload, encoding: "gzip-json-v1", raw_bytes: chunk.rawBytes, sha256: chunk.hash, trade_date: chunk.day }));
  // 市场参照：冻结输入内 881 行业等权合成指数在正式窗口的涨跌。
  const formalDays = days.filter(day => day.date >= plan.start);
  const compositeFirst = formalDays[0]?.market_factors?.composite_close;
  const compositeLast = formalDays.at(-1)?.market_factors?.composite_close;
  const marketReference = compositeFirst && compositeLast ? compositeLast / compositeFirst - 1 : 0;
  console.log(`881合成指数正式窗口参照：${pct(marketReference)}。`);
  const stats: RunStats[] = [];
  for (const exp of experiments) {
    const started = Date.now();
    const stat = await runExperiment(exp, plan, days, marketReference);
    stats.push(stat);
    const extra = stat.oscillating_days !== undefined ? `，震荡日 ${stat.oscillating_days}/${stat.factor_days}` : "";
    console.log(`✓ ${exp.name}: 收益 ${pct(stat.total_return)}，年化 ${pct(stat.annual_return)}，回撤 ${pct(stat.max_drawdown)}，交易 ${stat.trade_count}${extra}（${((Date.now() - started) / 1000).toFixed(1)}s）`);
  }
  console.log(`\n--- ${tag} · 窗口 ${spec.label} 结果（按总收益排序）---`);
  console.log(formatTable([...stats].sort((a, b) => b.total_return - a.total_return)));
  const outputFile = path.join(outDir, `${tag}-${spec.label}-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.json`);
  fs.writeFileSync(outputFile, JSON.stringify({
    window: spec.label, window_range: { start: spec.start, end: spec.end, env: spec.env ?? "current_881" },
    tag, input_hash: report.input_hash, plan_hash: report.plan_hash, codes,
    sample_note: note,
    price_mode: plan.price_mode, market_reference: BENCHMARK_NOTE, costs: COSTS, evidence: "research_only", results: stats,
  }, null, 2));
  console.log(`结果已写入 ${outputFile}`);
}

if (regimeMode) {
  // 市场状态分段模式：段自身连续；统一宇宙（覆盖最早段种子到最晚段终点）；全部段用合成 881 环境（口径一致）。
  const segments = await loadRegimeSegments();
  if (!segments.length) throw new Error("没有满足条件的连续状态段");
  const minStart = segments.reduce((min, seg) => seg.start < min ? seg.start : min, segments[0]!.start);
  const maxEnd = segments.reduce((max, seg) => seg.end > max ? seg.end : max, segments[0]!.end);
  console.time("统一样本选择");
  const sample = await selectSampleForRange(standardSeed(minStart), minStart, maxEnd);
  console.timeEnd("统一样本选择");
  const groups = await loadIndustryGroups(sample.codes);
  const groupedCount = groups.reduce((sum, group) => sum + group.codes.length, 0);
  console.log(`行业分组 ${groups.length} 组，宇宙内已归属 ${groupedCount}/${sample.codes.length} 只。`);
  if (segmentsOnly) process.exit(0);
  const experiments = regimeExperiments(groups).filter(exp => !onlyNames || onlyNames.some(name => exp.name.includes(name)));
  for (const seg of segmentFilter ? segments.filter(seg => seg.name.includes(segmentFilter)) : segments) {
    const spec: WindowSpec = { start: seg.start, end: seg.end, env: "synthetic_881", warmup: 260, label: seg.name };
    await runBatch(spec, sample.codes, experiments, `状态段-${seg.kind}`,
      `${seg.tradingDays} 个连续交易日（${seg.kind}）；统一宇宙 ${sample.universe} 只等距抽取 ${sample.codes.length} 只，平均停牌近似 ${sample.avgSuspended.toFixed(0)} 日/只${excludeSmall ? "；CH-3 换手代理剔除最小30%" : ""}`);
  }
} else for (const window of onlyWindows) {
  if (strataArg) {
    const names = strataArg.split(",").map(name => name.trim());
    for (const name of names) {
      const outerCodes = await selectByCharacter(name as "hype" | "cyclical" | "calm");
      const label = name === "hype" ? "炒作型" : name === "cyclical" ? "周期行业" : `未知分层(${name})`;
      if (name === "cyclical" && signalsMode) {
        const longWindow = window.startsWith("long");
        const codes = longWindow
          ? await selectByCharacter("cyclical", WINDOWS[window].start)
          : outerCodes;
        const spec: WindowSpec = { ...windowSpec(window), warmup: 130 };
        const experiments = cyclicalSignalExperiments().map(exp => ({
          ...exp,
          overrides: fillSignalCodes(exp.overrides, codes),
        })).filter(exp => !onlyNames || onlyNames.some(n => exp.name.includes(n)));
        await runBatch(spec, codes, experiments, "周期信号研究",
          `周期行业 13 类成分 ${codes.length} 只（归属回看近似）${excludeSmall ? "；CH-3 换手代理剔除最小30%" : ""}；底座=盈利奔跑+熔断5`);
        continue;
      }
      if (name === "cyclical" && (closeMode || ablateBoards.length)) {
        // 收口/消融：剔除指定板块的股票与分组，环境预热加长覆盖绝对动量窗口。
        const ablated = new Set(ablateBoards);
        const keptCodes = ablated.size ? outerCodes.filter((code: string) => {
          const group = CYCLICAL_GROUPS.find(g => g.codes.includes(code));
          return !group || !ablated.has(group.board);
        }) : outerCodes;
        const keptGroups = CYCLICAL_GROUPS.filter(g => !ablated.has(g.board) && g.codes.length > 0);
        const removed = CYCLICAL_GROUPS.filter(g => ablated.has(g.board));
        for (const group of keptGroups) group.codes = group.codes.filter(code => keptCodes.includes(code));
        // 实验矩阵引用的是同一个数组对象：原地替换内容，被剔除行业不进入任何计划的分组载荷。
        CYCLICAL_GROUPS.length = 0;
        CYCLICAL_GROUPS.push(...keptGroups);
        const spec: WindowSpec = { ...windowSpec(window), warmup: 130, label: window + (ablated.size ? "-消融" + [...ablated].join("+") : "") };
        const closeExperiments = cyclicalCloseExperiments()
          .filter(exp => !onlyNames || onlyNames.some(name => exp.name.includes(name)));
        await runBatch(spec, keptCodes, closeExperiments,
          ablated.size ? `收口消融-${removed.map(g => g.board).join(",")}` : `收口-周期行业`,
          `周期行业 ${keptGroups.length}/13 类成分 ${keptCodes.length} 只${ablated.size ? `；已剔除 ${removed.map(g => g.board).join("、")}` : ""}${excludeSmall ? "；CH-3 换手代理剔除最小30%" : ""}；环境预热130日（绝对动量120窗口）`);
        continue;
      }
      const note = name === "hype" ? `2021-22 涨停次数 Top ${outerCodes.length}（股性=快拉且波动大口径）` :
        name === "cyclical" ? `当前 881 周期行业 13 类成分 ${outerCodes.length} 只（归属回看近似）` :
          `2021-22 日均振幅 <3% 的 ${outerCodes.length} 只`;
      await runBatch(windowSpec(window), outerCodes, stratumExperiments(), `分层-${label}`, note);
    }
  } else {
    const longWindow = window.startsWith("long");
    console.time("固定样本选择");
    const sample = await selectSample(window);
    console.timeEnd("固定样本选择");
    const experiments = (longWindow ? longWindowExperiments() : [...RIGHT_SIDE_EXPERIMENTS, ...nonRightExperiments(sample.codes)])
      .filter(exp => !onlyNames || onlyNames.some(name => exp.name.includes(name)));
    await runBatch(windowSpec(window), sample.codes, experiments, `${longWindow ? "长" : ""}样本${sample.codes.length}`,
      `上市覆盖整个区间（首根行情≤${(WINDOWS[window] as { sampleStart?: string }).sampleStart ?? SAMPLE_RANGE.start}、末根≥${WINDOWS[window].end}）的合格股票 ${sample.universe} 只按代码等距抽取 ${sample.codes.length} 只；区间内缺行或零量日按停牌近似，平均 ${sample.avgSuspended.toFixed(0)} 日/只`);
  }
}
await closePool();
