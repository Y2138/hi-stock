// 晚间“明日预案预览”摘要：只读 19:15 轻量任务写入的事实，供精选报告/邮件使用。
import type pg from "pg";
import type { DailyPlanMarketForecast, EveningPreviewPosition } from "./repo.js";

type Db = Pick<pg.Pool | pg.PoolClient, "query">;

interface PreviewRow {
  account_id: string;
  account_name: string;
  as_of: string;
  market_forecast: DailyPlanMarketForecast;
  position_previews: EveningPreviewPosition[];
}

const ACTION_LABELS: Record<string, string> = {
  exit: "退出",
  reduce: "减仓",
  buy: "买入",
  hold: "持有",
  observe: "观察",
};

function text(value: unknown, max = 160): string {
  const plain = String(value ?? "").replace(/[\r\n]+/g, " ").replace(/\|/g, "｜").trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

function price(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "—";
}

function nextTradingDate(db: Db, date: string): Promise<string | null> {
  return db.query<{ target_date: string | null }>(
    `SELECT min(trade_date)::text AS target_date
       FROM market_trading_day
      WHERE trade_date > $1::date AND is_open`,
    [date],
  ).then((result) => result.rows[0]?.target_date ?? null);
}

/**
 * 生成精选报告/邮件追加段：目标日 = 精选目标日的下一交易日。
 * 晚间预览不存在时明确说明，不回退到早盘计划冒充“明日预案”。
 */
export async function buildTomorrowPreview(db: Db, selectionDate: string): Promise<string> {
  const targetDate = await nextTradingDate(db, selectionDate);
  if (!targetDate) return "## 明日预案\n\n缺少下一交易日日历，晚间预览暂不可用。";
  const rows = (await db.query<PreviewRow>(
    `SELECT preview.account_id::text, account.name AS account_name, preview.as_of::text,
            preview.market_forecast, preview.position_previews
       FROM daily_plan_evening_preview preview
       JOIN portfolio_account account ON account.id = preview.account_id
      WHERE preview.target_date = $1::date
      ORDER BY preview.account_id`,
    [targetDate],
  )).rows;
  if (rows.length === 0) {
    return `## 明日预案\n\n晚间预览尚未生成（目标日 ${targetDate}）；早盘每日计划完成后以工作台为准。`;
  }

  const forecast = rows[0]!.market_forecast;
  const positions = rows
    .flatMap((row) => row.position_previews.map((item) => ({ ...item, account: row.account_name })))
    .slice(0, 12);
  const lines: string[] = [
    "## 明日预案（晚间预览）",
    "",
    `> 目标日 ${targetDate}，数据日 ${rows[0]!.as_of}；这是收盘后的预判，早盘每日计划会覆盖，不是交易指令。`,
    "",
    "### 大盘预期",
    "",
    text(forecast.summary_md, 300),
  ];
  for (const scenario of forecast.scenarios ?? []) {
    lines.push(
      `- **${text(scenario.label, 20)} ${scenario.probability}%**：${text(scenario.view, 120)}`
      + `；触发：${text(scenario.triggers, 120)}；应对：${text(scenario.response, 120)}`
      + `；失效：${text(scenario.invalidation, 100)}`,
    );
  }
  if ((forecast.key_levels ?? []).length) {
    lines.push("", "关键位：");
    for (const level of forecast.key_levels) {
      lines.push(
        `- ${text(level.name, 40)}：支撑 ${price(level.support)} / 压力 ${price(level.resistance)}`
        + (level.volume_note ? `（${text(level.volume_note, 100)}）` : ""),
      );
    }
  }

  lines.push("", "### 持仓预案预览");
  if (positions.length === 0) {
    lines.push("", "当前没有持仓预览。");
  } else {
    lines.push("", "| 账户 | 标的 | 动作 | 核心判断 | 主要情景 |", "|---|---|---|---|---|");
    for (const item of positions) {
      const top = [...item.scenarios].sort((left, right) => right.probability - left.probability)[0];
      const scenarios = [...item.scenarios]
        .sort((left, right) => right.probability - left.probability)
        .slice(0, 2)
        .map((scenario) => `${text(scenario.label, 12)} ${scenario.probability}%（${text(scenario.trigger, 80)}）`)
        .join("；");
      lines.push(
        `| ${text(item.account, 30)} | ${text(item.code, 20)} | ${ACTION_LABELS[item.action] ?? text(item.action, 10)} | `
        + `${text(item.headline, 100)}${top ? `；主情景：${text(top.response, 80)}` : ""} | ${scenarios} |`,
      );
    }
    if (positions.length >= 12) lines.push("", "> 仅列前 12 笔，完整预览见工作台任务结果。");
  }
  lines.push("", "> 晚间预览只用于盘前准备；硬性退出、保护位与执行以早盘每日计划为准。");
  return lines.join("\n");
}
