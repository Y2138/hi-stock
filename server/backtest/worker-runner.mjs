import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const [inputPath, strategyPath, outputPath] = process.argv.slice(2);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
let phase = "startup";

class ResultContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ResultContractError";
    this.code = code;
  }
}

function contractError(code, message) {
  throw new ResultContractError(code, message);
}

function runtimeCode(error) {
  if (error instanceof ReferenceError) return "reference_error";
  if (error instanceof TypeError) return "type_error";
  if (error instanceof SyntaxError) return "syntax_error";
  if (error instanceof RangeError) {
    if (/maximum call stack size exceeded/i.test(error.message)) return "stack_overflow";
    if (/invalid array length/i.test(error.message)) return "invalid_array_length";
    return "range_error";
  }
  return "runtime_error";
}

function finiteArray(values, label) {
  if (!Array.isArray(values) || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`${label} 必须是有限数值数组`);
  }
  return values;
}

function mean(values) {
  const checked = finiteArray(values, "values");
  return checked.length ? checked.reduce((sum, value) => sum + value, 0) / checked.length : 0;
}

function stdev(values) {
  const checked = finiteArray(values, "values");
  if (checked.length < 2) return 0;
  const average = mean(checked);
  return Math.sqrt(checked.reduce((sum, value) => sum + (value - average) ** 2, 0) / (checked.length - 1));
}

function standardMetrics(dailyReturns, initialCash) {
  let equity = initialCash;
  let peak = equity;
  let maxDrawdown = 0;
  for (const item of dailyReturns) {
    equity *= 1 + item.return;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  const totalReturn = equity / initialCash - 1;
  const average = mean(dailyReturns.map((item) => item.return));
  return {
    initial_cash: initialCash,
    final_equity: equity,
    total_return_pct: totalReturn * 100,
    annualized_return_pct: dailyReturns.length
      ? (Math.pow(Math.max(0, 1 + totalReturn), 252 / dailyReturns.length) - 1) * 100
      : 0,
    max_drawdown_pct: maxDrawdown * 100,
    annualized_volatility_pct: stdev(dailyReturns.map((item) => item.return)) * Math.sqrt(252) * 100,
    average_daily_return_pct: average * 100,
    observations: dailyReturns.length,
  };
}

function validateResult(raw, initialCash) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    contractError("result_type", "结果必须是对象");
  }
  const dailyReturns = raw.daily_returns;
  if (!Array.isArray(dailyReturns) || dailyReturns.length === 0 || dailyReturns.length > 50_000) {
    contractError("daily_returns_count", "daily_returns 必须包含 1–50000 项");
  }
  const normalizedReturns = dailyReturns.map((item) => {
    if (!item || typeof item !== "object" || !DATE_RE.test(item.date) || !Number.isFinite(item.return)) {
      contractError("daily_returns_item", "daily_returns 项格式非法");
    }
    if (item.return <= -1 || item.return > 10) {
      contractError("daily_returns_range", "daily return 超出安全范围");
    }
    return { date: item.date, return: item.return };
  });
  normalizedReturns.sort((left, right) => left.date.localeCompare(right.date));
  if (new Set(normalizedReturns.map((item) => item.date)).size !== normalizedReturns.length) {
    contractError("daily_returns_duplicate", "daily_returns 日期重复");
  }
  const extraMetrics = raw.metrics ?? {};
  if (!extraMetrics || typeof extraMetrics !== "object" || Array.isArray(extraMetrics)) {
    contractError("metrics_type", "metrics 必须是对象");
  }
  const metricEntries = Object.entries(extraMetrics);
  if (metricEntries.length > 100) contractError("metrics_count", "metrics 最多 100 项");
  const metrics = {};
  for (const [key, value] of metricEntries) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(key) || (value !== null && !Number.isFinite(value))) {
      contractError("metrics_value", "metrics 包含非法键或数值");
    }
    metrics[key] = value;
  }
  const conclusion = typeof raw.conclusion === "string" ? raw.conclusion.trim() : "";
  if (!conclusion || conclusion.length > 16_000) {
    contractError("conclusion", "conclusion 必须是 1–16000 字符");
  }
  const gaps = raw.data_gaps ?? [];
  if (!Array.isArray(gaps) || gaps.length > 200) {
    contractError("data_gaps", "data_gaps 最多 200 项");
  }
  return {
    metrics: { ...metrics, ...standardMetrics(normalizedReturns, initialCash) },
    conclusion,
    data_gaps: gaps,
    observations: normalizedReturns.length,
  };
}

async function main() {
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  phase = "read_input";
  const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
  phase = "index_bars";
  const grouped = new Map();
  for (const bar of input.bars) {
    const rows = grouped.get(bar.code) ?? [];
    rows.push(Object.freeze(bar));
    grouped.set(bar.code, rows);
  }
  for (const rows of grouped.values()) Object.freeze(rows);
  phase = "index_events";
  const allEvents = [];
  const eventsByType = new Map();
  const eventsByDate = new Map();
  const eventsByDateAndType = new Map();
  for (const rawEvent of input.market_events ?? []) {
    const event = Object.freeze(rawEvent);
    allEvents.push(event);
    const typed = eventsByType.get(event.type) ?? [];
    typed.push(event);
    eventsByType.set(event.type, typed);
    const dated = eventsByDate.get(event.date) ?? [];
    dated.push(event);
    eventsByDate.set(event.date, dated);
    const key = `${event.date}:${event.type}`;
    const datedAndTyped = eventsByDateAndType.get(key) ?? [];
    datedAndTyped.push(event);
    eventsByDateAndType.set(key, datedAndTyped);
  }
  Object.freeze(allEvents);
  for (const rows of [...eventsByType.values(), ...eventsByDate.values(), ...eventsByDateAndType.values()]) Object.freeze(rows);
  const empty = Object.freeze([]);
  const sdk = Object.freeze({
    version: input.sdk_version,
    codes: Object.freeze([...input.meta.codes]),
    start: input.meta.start,
    end: input.meta.end,
    initialCash: input.meta.initial_cash,
    parameters: Object.freeze({ ...input.meta.parameters }),
    bars: (code) => grouped.get(code) ?? Object.freeze([]),
    events: (type) => type === undefined ? allEvents : eventsByType.get(type) ?? empty,
    eventsOn: (date, type) => type === undefined
      ? eventsByDate.get(date) ?? empty
      : eventsByDateAndType.get(`${date}:${type}`) ?? empty,
    stats: Object.freeze({ mean, stdev }),
  });
  phase = "load_strategy";
  const module = await import(pathToFileURL(strategyPath).href);
  if (typeof module.default !== "function") throw new Error("策略模块必须 default export 函数");
  phase = "execute_strategy";
  const raw = await module.default(sdk);
  phase = "validate_result";
  const result = validateResult(raw, input.meta.initial_cash);
  phase = "write_result";
  await fs.writeFile(outputPath, JSON.stringify({ ok: true, result }), { encoding: "utf8", flag: "wx" });
}

try {
  await main();
} catch (error) {
  const stack = error instanceof Error ? error.stack ?? "" : "";
  const location = stack.match(/strategy\.mjs:(\d+):(\d+)/)?.slice(1) ?? null;
  const safeError = error instanceof ResultContractError
    ? { kind: "result_contract", code: error.code }
    : { kind: "runtime", code: runtimeCode(error), phase, location };
  await fs.writeFile(
    outputPath,
    JSON.stringify({ ok: false, error: safeError }),
    { encoding: "utf8", flag: "wx" },
  ).catch(() => {});
  process.exitCode = 1;
}
