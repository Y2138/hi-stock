import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import * as ts from "typescript";
import { PROJECT_ROOT } from "../config.js";
import { apiErrors } from "../http/router.js";
import { cleanupStaleBacktestSourceCandidates } from "../modules/backtests/repo.js";
import type {
  AgentBacktestBar,
  AgentBacktestMarketEvent,
  AgentBacktestRequest,
  AgentBacktestRunSummary,
  AgentBacktestWorkerInput,
  AgentBacktestWorkerResult,
} from "./agent-contract.js";
import {
  AGENT_BACKTEST_IMAGE,
  AGENT_BACKTEST_INPUT_LIMIT,
  AGENT_BACKTEST_MAX_ROWS,
  AGENT_BACKTEST_MEMORY_LIMIT,
  AGENT_BACKTEST_RESULT_LIMIT,
  AGENT_BACKTEST_SDK_VERSION,
  AGENT_BACKTEST_SOURCE_LIMIT,
  AGENT_BACKTEST_TIMEOUT_MS,
  AGENT_BACKTEST_WORKER_VERSION,
} from "./agent-contract.js";

const WORKSPACE_ROOT = path.join(os.tmpdir(), "stock-agent-backtests");
const WORKSPACE_PREFIX = "run-";
const RUNNER_PATH = path.join(PROJECT_ROOT, "server", "backtest", "worker-runner.mjs");
let workerQueue = Promise.resolve();

interface WorkerOutcome {
  result: AgentBacktestWorkerResult | null;
  error: string | null;
  timedOut: boolean;
  aborted: boolean;
}

interface BacktestRunRow extends AgentBacktestRunSummary {
  created_at: string;
}

const WORKER_CONTRACT_ERRORS: Record<string, string> = {
  result_type: "返回值必须是对象",
  daily_returns_count: "daily_returns 必须包含 1–50000 个交易日；诊断运行也至少返回 1 个零收益交易日",
  daily_returns_item: "daily_returns 每项必须是 {date:'YYYY-MM-DD', return:有限数值}",
  daily_returns_range: "daily_returns 的单日 return 必须大于 -1 且不超过 10",
  daily_returns_duplicate: "daily_returns 不允许出现重复日期",
  metrics_type: "metrics 必须是扁平对象",
  metrics_count: "metrics 最多允许 100 项",
  metrics_value: "metrics 键只能使用小写字母、数字、下划线且以字母开头，值只能是有限数值或 null；结构化详情请写入 conclusion",
  conclusion: "conclusion 必须是 1–16000 字符的非空文本",
  data_gaps: "data_gaps 必须是数组且最多 200 项",
};

const WORKER_RUNTIME_ERRORS: Record<string, { stableCode: string; message: string }> = {
  reference_error: { stableCode: "STRATEGY_REFERENCE_ERROR", message: "引用了未定义变量" },
  type_error: { stableCode: "STRATEGY_TYPE_ERROR", message: "对象、数组或函数调用类型不匹配" },
  syntax_error: { stableCode: "STRATEGY_SYNTAX_ERROR", message: "策略模块加载时发生语法错误" },
  stack_overflow: { stableCode: "STRATEGY_STACK_OVERFLOW", message: "递归或大数组展开导致调用栈溢出" },
  invalid_array_length: { stableCode: "STRATEGY_INVALID_ARRAY_LENGTH", message: "策略生成了非法数组长度" },
  range_error: { stableCode: "STRATEGY_RANGE_ERROR", message: "策略数值或集合范围非法" },
  runtime_error: { stableCode: "STRATEGY_RUNTIME_ERROR", message: "策略发生未分类运行错误" },
};

const WORKER_PHASES: Record<string, string> = {
  startup: "启动工作器",
  read_input: "读取输入",
  index_bars: "建立行情索引",
  index_events: "建立市场事件索引",
  load_strategy: "加载策略",
  execute_strategy: "执行策略",
  validate_result: "校验结果",
  write_result: "写出结果",
};

/** 只解释工作器生成的固定错误码；策略自定义异常不得进入数据库或会话。 */
export function formatAgentBacktestWorkerError(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "回测工作器未返回可识别错误";
  const error = value as Record<string, unknown>;
  if (error.kind === "result_contract" && typeof error.code === "string") {
    return `回测结果契约错误：${WORKER_CONTRACT_ERRORS[error.code] ?? "返回结果未通过校验"}`;
  }
  const runtime = typeof error.code === "string" ? WORKER_RUNTIME_ERRORS[error.code] : undefined;
  const location = error.location;
  const suffix = Array.isArray(location) && location.every((item) => /^\d+$/.test(String(item)))
    ? `（策略模块第 ${location[0]} 行第 ${location[1]} 列）`
    : "";
  const phase = typeof error.phase === "string" ? WORKER_PHASES[error.phase] ?? "未知阶段" : "未知阶段";
  return runtime
    ? `回测策略运行失败：[${runtime.stableCode}] 阶段=${phase}；${runtime.message}${suffix}`
    : `回测策略运行失败：[STRATEGY_RUNTIME_ERROR] 阶段=${phase}${suffix}`;
}

function processFailure(exitCode: number | null, spawnFailed: boolean): string {
  if (spawnFailed || exitCode === 125) return "[CONTAINER_START_FAILED] 隔离回测容器启动失败";
  if (exitCode === 126 || exitCode === 127) return `[CONTAINER_COMMAND_FAILED] 工作器命令不可用，退出码=${exitCode}`;
  if (exitCode === 137) return "[WORKER_RESOURCE_KILLED] 工作器被资源限制终止，退出码=137";
  return exitCode === null
    ? "[WORKER_PROCESS_FAILED] 工作器进程未正常启动"
    : `[WORKER_ABNORMAL_EXIT] 工作器异常退出，退出码=${exitCode}`;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function booleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}

export function isAgentBacktestWorkerEnabled(): boolean {
  return booleanFlag(process.env.AGENT_BACKTEST_WORKER_ENABLED, true);
}

function locationOf(source: ts.SourceFile, position: number | undefined): string {
  if (position === undefined) return "未知位置";
  const point = source.getLineAndCharacterOfPosition(position);
  return `第 ${point.line + 1} 行第 ${point.character + 1} 列`;
}

function messageOf(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "；").slice(0, 500);
}

/** 只编译纯模块；SDK 通过 default export 函数参数注入，不允许源码声明任何 import。 */
export function compileAgentBacktestSource(sourceCode: string): { javascript: string; sha256: string; bytes: number } {
  const bytes = Buffer.byteLength(sourceCode, "utf8");
  if (bytes < 1 || bytes > AGENT_BACKTEST_SOURCE_LIMIT) {
    throw apiErrors.badRequest(`source_code 必须为 1–${AGENT_BACKTEST_SOURCE_LIMIT} 字节`);
  }
  if (sourceCode.includes("\u0000")) throw apiErrors.badRequest("source_code 不允许包含 NUL 字符");
  const source = ts.createSourceFile("strategy.ts", sourceCode, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const syntactic = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (syntactic[0]) {
    throw apiErrors.badRequest(`回测源码语法错误（${locationOf(source, syntactic[0].start)}）：${messageOf(syntactic[0])}`);
  }
  let forbidden: ts.Node | null = null;
  const visit = (node: ts.Node): void => {
    if (forbidden) return;
    if (
      ts.isImportDeclaration(node)
      || ts.isImportEqualsDeclaration(node)
      || (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined)
      || (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      forbidden = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (forbidden) {
    throw apiErrors.badRequest(`回测源码不允许 import 外部模块（${locationOf(source, (forbidden as ts.Node).getStart(source))}）；只能使用注入的 sdk`);
  }
  const transpiled = ts.transpileModule(sourceCode, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      sourceMap: false,
      inlineSourceMap: false,
      inlineSources: false,
      removeComments: true,
    },
    fileName: "strategy.ts",
    reportDiagnostics: true,
  });
  const error = transpiled.diagnostics?.find((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (error) throw apiErrors.badRequest(`回测源码无法编译（${locationOf(source, error.start)}）：${messageOf(error)}`);
  if (!/export\s+default/.test(transpiled.outputText)) {
    throw apiErrors.badRequest("回测源码必须 default export 一个 async 函数；函数接收固定 sdk 并返回 daily_returns、metrics、conclusion、data_gaps");
  }
  return { javascript: transpiled.outputText, sha256: sha256(sourceCode), bytes };
}

async function killContainer(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn("docker", ["kill", name], { stdio: "ignore" });
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
}

export function validateAgentBacktestWorkerResult(value: unknown): AgentBacktestWorkerResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("工作器结果不是对象");
  const result = value as Record<string, unknown>;
  const metrics = result.metrics;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics) || Object.keys(metrics).length > 120) {
    throw new Error("工作器 metrics 非法");
  }
  for (const [key, metric] of Object.entries(metrics)) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(key) || (metric !== null && (typeof metric !== "number" || !Number.isFinite(metric)))) {
      throw new Error("工作器 metrics 包含非法项");
    }
  }
  if (typeof result.conclusion !== "string" || !result.conclusion.trim() || result.conclusion.length > 16_000) {
    throw new Error("工作器 conclusion 非法");
  }
  if (!Array.isArray(result.data_gaps) || result.data_gaps.length > 200) throw new Error("工作器 data_gaps 非法");
  if (!Number.isInteger(result.observations) || Number(result.observations) < 1 || Number(result.observations) > 50_000) {
    throw new Error("工作器 observations 非法");
  }
  return result as unknown as AgentBacktestWorkerResult;
}

async function executeContainer(
  input: AgentBacktestWorkerInput,
  javascript: string,
  signal?: AbortSignal,
): Promise<WorkerOutcome> {
  await fsp.mkdir(WORKSPACE_ROOT, { recursive: true, mode: 0o700 });
  const workspace = await fsp.mkdtemp(path.join(WORKSPACE_ROOT, WORKSPACE_PREFIX));
  const inputDir = path.join(workspace, "input");
  const outputDir = path.join(workspace, "output");
  const inputPath = path.join(inputDir, "data.json");
  const sourcePath = path.join(inputDir, "strategy.mjs");
  const resultPath = path.join(outputDir, "result.json");
  const containerName = `stock-agent-backtest-${crypto.randomUUID()}`;
  let cleanupError: Error | null = null;
  try {
    await fsp.mkdir(inputDir, { mode: 0o755 });
    await fsp.mkdir(outputDir, { mode: 0o777 });
    const inputJson = JSON.stringify(input);
    const inputBytes = Buffer.byteLength(inputJson, "utf8");
    if (inputBytes > AGENT_BACKTEST_INPUT_LIMIT) {
      return {
        result: null,
        error: `[INPUT_LIMIT] 回测输入快照 ${Math.ceil(inputBytes / 1024 / 1024)} MiB 超过 128 MiB 上限`,
        timedOut: false,
        aborted: false,
      };
    }
    await Promise.all([
      fsp.writeFile(inputPath, inputJson, { encoding: "utf8", mode: 0o644, flag: "wx" }),
      fsp.writeFile(sourcePath, javascript, { encoding: "utf8", mode: 0o644, flag: "wx" }),
    ]);
    const args = [
      "run", "--rm", "--name", containerName,
      "--network", "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "32",
      "--memory", AGENT_BACKTEST_MEMORY_LIMIT,
      "--memory-swap", AGENT_BACKTEST_MEMORY_LIMIT,
      "--cpus", "1",
      "--ulimit", `fsize=${AGENT_BACKTEST_RESULT_LIMIT}:${AGENT_BACKTEST_RESULT_LIMIT}`,
      "--user", "65534:65534",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
      "--mount", `type=bind,src=${inputDir},dst=/input,readonly`,
      "--mount", `type=bind,src=${outputDir},dst=/output`,
      "--mount", `type=bind,src=${RUNNER_PATH},dst=/runner.mjs,readonly`,
      AGENT_BACKTEST_IMAGE,
      "node", "--permission",
      "--allow-fs-read=/input", "--allow-fs-read=/runner.mjs",
      "--allow-fs-write=/output",
      "/runner.mjs", "/input/data.json", "/input/strategy.mjs", "/output/result.json",
    ];
    const outcome = await new Promise<{
      exitCode: number | null;
      timedOut: boolean;
      aborted: boolean;
      spawnFailed: boolean;
    }>((resolve) => {
      const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
      child.stdout.resume();
      child.stderr.resume();
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let spawnFailed = false;
      let stopping: Promise<void> | null = null;
      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ exitCode, timedOut, aborted, spawnFailed });
      };
      const stop = (reason: "timeout" | "abort") => {
        if (settled || stopping) return;
        timedOut = reason === "timeout";
        aborted = reason === "abort";
        stopping = killContainer(containerName).finally(() => {
          child.kill("SIGKILL");
        });
      };
      const timer = setTimeout(() => stop("timeout"), AGENT_BACKTEST_TIMEOUT_MS);
      const onAbort = () => stop("abort");
      signal?.addEventListener("abort", onAbort, { once: true });
      child.once("error", () => {
        spawnFailed = true;
        if (stopping) void stopping.then(() => finish(null));
        else finish(null);
      });
      child.once("exit", (code) => {
        if (stopping) void stopping.then(() => finish(code));
        else finish(code);
      });
    });
    if (outcome.timedOut) {
      return {
        result: null,
        error: `[WORKER_TIMEOUT] 回测工作器超过 ${AGENT_BACKTEST_TIMEOUT_MS / 1000} 秒限制`,
        timedOut: true,
        aborted: false,
      };
    }
    if (outcome.aborted) return { result: null, error: "[WORKER_ABORTED] 回测工作器已中断", timedOut: false, aborted: true };
    let raw: string;
    try {
      const stat = await fsp.stat(resultPath);
      if (stat.size > AGENT_BACKTEST_RESULT_LIMIT) throw new Error("result too large");
      raw = await fsp.readFile(resultPath, "utf8");
    } catch {
      return { result: null, error: processFailure(outcome.exitCode, outcome.spawnFailed), timedOut: false, aborted: false };
    }
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { result: null, error: "[WORKER_RESULT_INVALID_JSON] 回测工作器结果不是有效 JSON", timedOut: false, aborted: false };
    }
    if (envelope.ok !== true) {
      return {
        result: null,
        error: formatAgentBacktestWorkerError(envelope.error),
        timedOut: false,
        aborted: false,
      };
    }
    try {
      return { result: validateAgentBacktestWorkerResult(envelope.result), error: null, timedOut: false, aborted: false };
    } catch {
      return { result: null, error: "[WORKER_RESULT_REJECTED] 回测工作器结果未通过服务端契约校验", timedOut: false, aborted: false };
    }
  } catch {
    return { result: null, error: "[WORKER_PREPARE_FAILED] 回测工作区准备失败", timedOut: false, aborted: false };
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true }).catch((error: Error) => {
      cleanupError = error;
    });
    if (cleanupError) throw new Error("临时回测工作区清理失败");
  }
}

async function serializeWorker<T>(operation: () => Promise<T>): Promise<T> {
  const previous = workerQueue;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  workerQueue = previous.catch(() => {}).then(() => gate);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function cleanupAgentBacktestWorkspaces(): Promise<number> {
  await fsp.mkdir(WORKSPACE_ROOT, { recursive: true, mode: 0o700 });
  const entries = await fsp.readdir(WORKSPACE_ROOT, { withFileTypes: true });
  const stale = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(WORKSPACE_PREFIX));
  await Promise.all(stale.map((entry) => fsp.rm(path.join(WORKSPACE_ROOT, entry.name), { recursive: true, force: true })));
  return stale.length;
}

/** 服务重启后源码已不可恢复；清理目录后把中断运行收敛为明确失败，禁止旧 worker 接管。 */
export async function failInterruptedAgentBacktests(pool: pg.Pool): Promise<number> {
  const result = await pool.query(
    `UPDATE backtest_run
        SET execution_status = 'failed', progress = 100, finished_at = now(),
            error_message = '服务重启中断了临时回测；源码未保存，请由 Agent 重新验证',
            code_cleanup_status = 'deleted'
      WHERE execution_origin = 'agent_workspace'
        AND execution_status IN ('queued', 'running')`,
  );
  return result.rowCount ?? 0;
}

function conclusionMarkdown(
  request: AgentBacktestRequest,
  result: AgentBacktestWorkerResult,
  state: { change_seq: string; current_hash: string },
  resolvedCodeCount: number,
  marketEventCount: number,
): string {
  const compared = request.comparison_run_ids.length ? request.comparison_run_ids.map((id) => `#${id}`).join("、") : "无";
  return [
    `# Agent 自驱回测结论：${request.name}`,
    "",
    `- 研究大纲：${request.research_outline}`,
    `- 待验证假设：${request.hypothesis}`,
    `- 当前策略：序号 ${state.change_seq} · ${state.current_hash}`,
    `- 数据区间：${request.start} 至 ${request.end}`,
    `- 标的数量：${resolvedCodeCount}`,
    `- 市场事件数量：${marketEventCount}`,
    `- 对比历史回测：${compared}`,
    `- 工作器 / SDK：${AGENT_BACKTEST_WORKER_VERSION} / ${AGENT_BACKTEST_SDK_VERSION}`,
    "",
    result.conclusion,
    "",
    "> 临时执行目录已删除；最终化后源码会固化为可复用版本。本记录不构成交易建议。",
  ].join("\n");
}

export async function runAgentBacktest(
  pool: pg.Pool,
  sessionId: string,
  request: AgentBacktestRequest,
  options: { signal?: AbortSignal; execute?: typeof executeContainer } = {},
): Promise<BacktestRunRow> {
  if (!isAgentBacktestWorkerEnabled()) throw apiErrors.dbUnavailable("Agent 临时代码回测工作器当前已关闭");
  await cleanupStaleBacktestSourceCandidates(pool);
  const compiled = compileAgentBacktestSource(request.source_code);
  const session = await pool.query<{ session_type: string }>(
    "SELECT session_type FROM chat_session WHERE id = $1",
    [sessionId],
  );
  if (!session.rows[0] || !["interactive", "strategy_evolution", "backtest"].includes(session.rows[0].session_type)) {
    throw apiErrors.badRequest("Agent 回测只能由交互、策略演进或回测 session 发起");
  }
  const stateResult = await pool.query<{ change_seq: string; current_hash: string }>(
    "SELECT change_seq::text, current_hash FROM strategy_state WHERE singleton = 1",
  );
  const state = stateResult.rows[0];
  if (!state) throw apiErrors.notFound("当前策略尚未初始化");
  if (request.comparison_run_ids.length > 0) {
    const comparisons = await pool.query<{ id: string }>(
      `SELECT id::text FROM backtest_run
        WHERE id = ANY($1::bigint[]) AND execution_status IN ('legacy','success','partial','failed')`,
      [request.comparison_run_ids],
    );
    if (comparisons.rows.length !== request.comparison_run_ids.length) {
      throw apiErrors.badRequest("comparison_run_ids 包含不存在或尚未完成的回测");
    }
  }
  if (request.base_source_run_id) {
    const baseSource = await pool.query<{ id: string }>(
      `SELECT run.id::text
         FROM backtest_run run
         JOIN backtest_run_source source ON source.backtest_run_id = run.id
        WHERE run.id = $1
          AND run.conclusion_status IN ('final','superseded')
          AND source.retention_status = 'versioned'`,
      [request.base_source_run_id],
    );
    if (!baseSource.rows[0]) throw apiErrors.badRequest("base_source_run_id 必须指向已固化源码的最终回测版本");
  }
  const limitUpUniverse = request.limit_up_universe ?? "none";
  const selectedEventTypes = [...new Set([
    ...(request.market_event_types ?? []),
    ...(limitUpUniverse === "none" ? [] : ["up" as const]),
  ])];
  const eventRows = selectedEventTypes.length === 0
    ? []
    : (await pool.query<{
        date: string;
        type: "up" | "down" | "break";
        code: string;
        event_price: string | null;
        streak_count: number | null;
        open_count: number | null;
        first_event_time: Date | null;
        last_event_time: Date | null;
        industry_name: string | null;
        reason: string | null;
      }>(
        `SELECT event.trade_date::text AS date, event.event_type AS type, instrument.code,
                event.event_price::text, event.streak_count, event.open_count,
                event.first_event_time, event.last_event_time, event.industry_name, event.reason
           FROM market_limit_event event
           JOIN market_instrument instrument ON instrument.id = event.instrument_id
          WHERE event.trade_date BETWEEN $1::date AND $2::date
            AND event.event_type = ANY($3::text[])
          ORDER BY event.trade_date, event.event_type, instrument.code
          LIMIT $4`,
        [request.start, request.end, selectedEventTypes, AGENT_BACKTEST_MAX_ROWS + 1],
      )).rows;
  if (eventRows.length > AGENT_BACKTEST_MAX_ROWS) {
    throw apiErrors.badRequest("回测市场事件超过 500000 行上限，请缩小日期范围");
  }
  const marketEvents: AgentBacktestMarketEvent[] = eventRows.map((row) => ({
    date: row.date,
    type: row.type,
    code: row.code,
    event_price: row.event_price === null ? null : Number(row.event_price),
    streak_count: row.streak_count,
    open_count: row.open_count,
    first_event_time: row.first_event_time?.toISOString() ?? null,
    last_event_time: row.last_event_time?.toISOString() ?? null,
    industry_name: row.industry_name,
    reason: row.reason,
  }));
  if (marketEvents.some((event) => event.event_price !== null && !Number.isFinite(event.event_price))) {
    throw apiErrors.conflict("回测市场事件包含非有限价格，已停止执行");
  }
  const derivedCodes = marketEvents
    .filter((event) => event.type === "up")
    .map((event) => event.code)
    .filter((code) => limitUpUniverse === "all" || (limitUpUniverse === "mainboard" && /^(600|601|603|605|000|001|002|003)\d{3}\.(SH|SZ)$/.test(code)));
  const resolvedCodes = [...new Set([...request.codes, ...derivedCodes])].sort();
  if (resolvedCodes.length === 0) throw apiErrors.badRequest("回测没有可用标的：请提供 codes 或选择有数据的涨停候选范围");
  const barsResult = await pool.query<{
    code: string; date: string; open: string; high: string; low: string; close: string; volume: string | null;
  }>(
    `SELECT i.code, b.bar_date::text AS date, b.open::text, b.high::text, b.low::text,
            b.close::text, b.volume::text
       FROM market_bar b JOIN market_instrument i ON i.id = b.instrument_id
      WHERE i.code = ANY($1::text[]) AND b.freq = 'day'
        AND b.bar_date BETWEEN $2::date AND $3::date
      ORDER BY i.code, b.bar_date
      LIMIT $4`,
    [resolvedCodes, request.start, request.end, AGENT_BACKTEST_MAX_ROWS + 1],
  );
  if (barsResult.rows.length > AGENT_BACKTEST_MAX_ROWS) throw apiErrors.badRequest("回测行情超过 500000 行上限，请缩小标的或日期范围");
  const bars: AgentBacktestBar[] = barsResult.rows.map((row) => ({
    code: row.code,
    date: row.date,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: row.volume === null ? null : Number(row.volume),
  }));
  if (bars.some((bar) => [bar.open, bar.high, bar.low, bar.close].some((value) => !Number.isFinite(value)))) {
    throw apiErrors.conflict("回测行情包含非有限价格，已停止执行");
  }
  const availableCodes = [...new Set(bars.map((bar) => bar.code))];
  const marketEventCounts = Object.fromEntries(
    (["up", "down", "break"] as const).map((type) => [type, marketEvents.filter((event) => event.type === type).length]),
  );
  const inputSummary = {
    codes_requested: request.codes.length,
    codes_resolved: resolvedCodes.length,
    codes_available: availableCodes.length,
    bar_count: bars.length,
    market_event_count: marketEvents.length,
    market_event_counts: marketEventCounts,
    market_event_coverage_start: marketEvents[0]?.date ?? null,
    market_event_coverage_end: marketEvents.at(-1)?.date ?? null,
    coverage_start: bars.reduce<string | null>((min, bar) => min === null || bar.date < min ? bar.date : min, null),
    coverage_end: bars.reduce<string | null>((max, bar) => max === null || bar.date > max ? bar.date : max, null),
    input_sha256: sha256(JSON.stringify({ bars, market_events: marketEvents })),
  };
  const persistedRequest = {
    name: request.name,
    kind: request.kind,
    research_outline: request.research_outline,
    hypothesis: request.hypothesis,
    codes: request.codes,
    market_event_types: selectedEventTypes,
    limit_up_universe: limitUpUniverse,
    start: request.start,
    end: request.end,
    initial_cash: request.initial_cash,
    parameters: request.parameters,
    comparison_run_ids: request.comparison_run_ids,
    base_source_run_id: request.base_source_run_id,
  };
  const client = await pool.connect();
  let runId: string;
  try {
    await client.query("BEGIN");
    const created = await client.query<{ id: string }>(
      `INSERT INTO backtest_run
         (name, kind, status, config_snapshot, input_manifest, request_json, input_summary,
          service_version, execution_status, progress, execution_origin, session_id,
          strategy_change_seq, strategy_snapshot_hash, research_outline, hypothesis,
          worker_version, sdk_version, source_sha256, source_size_bytes, base_source_run_id, code_cleanup_status)
       VALUES ($1, $2, 'archived', $3, '[]', $3, $4, $5, 'running', 10, 'agent_workspace',
               $6, $7, $8, $9, $10, $5, $11, $12, $13, $14, 'not_applicable')
       RETURNING id::text`,
      [
        request.name, request.kind, JSON.stringify(persistedRequest), JSON.stringify(inputSummary),
        AGENT_BACKTEST_WORKER_VERSION, sessionId, state.change_seq, state.current_hash,
        request.research_outline, request.hypothesis, AGENT_BACKTEST_SDK_VERSION,
        compiled.sha256, compiled.bytes, request.base_source_run_id,
      ],
    );
    runId = created.rows[0]!.id;
    if (request.comparison_run_ids.length > 0) {
      await client.query(
        `INSERT INTO backtest_run_comparison (run_id, compared_run_id, relation)
         SELECT $1, unnest($2::bigint[]), 'prior'`,
        [runId, request.comparison_run_ids],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  const workerInput: AgentBacktestWorkerInput = {
    sdk_version: AGENT_BACKTEST_SDK_VERSION,
    meta: {
      codes: resolvedCodes,
      start: request.start,
      end: request.end,
      initial_cash: request.initial_cash,
      parameters: request.parameters,
    },
    bars,
    market_events: marketEvents,
  };
  let worker: WorkerOutcome;
  let cleanupStatus: "deleted" | "cleanup_failed" = "deleted";
  try {
    worker = await serializeWorker(() => (options.execute ?? executeContainer)(workerInput, compiled.javascript, options.signal));
  } catch {
    cleanupStatus = "cleanup_failed";
    worker = { result: null, error: "临时回测工作区清理失败，结果未采纳", timedOut: false, aborted: false };
  }
  if (worker.result && cleanupStatus === "deleted") {
    const status = worker.result.data_gaps.length > 0 || availableCodes.length < resolvedCodes.length ? "partial" : "success";
    const gaps = [
      ...resolvedCodes.filter((code) => !availableCodes.includes(code)).map((code) => ({ code, reason: "请求区间没有日线" })),
      ...worker.result.data_gaps,
    ];
    const completed = await pool.connect();
    try {
      await completed.query("BEGIN");
      await completed.query(
        `UPDATE backtest_run
            SET execution_status=$2, progress=100, metrics_json=$3, metrics=$3,
                conclusion_md=$4, data_gaps=$5, error_message=NULL, finished_at=now(),
                code_cleanup_status='deleted'
          WHERE id=$1`,
        [runId, status, JSON.stringify(worker.result.metrics), conclusionMarkdown(request, worker.result, state, resolvedCodes.length, marketEvents.length), JSON.stringify(gaps)],
      );
      await completed.query(
        `INSERT INTO backtest_run_source (backtest_run_id, source_code)
         VALUES ($1, $2)`,
        [runId, request.source_code],
      );
      await completed.query("COMMIT");
    } catch {
      await completed.query("ROLLBACK").catch(() => {});
      await pool.query(
        `UPDATE backtest_run
            SET execution_status='failed', progress=100,
                error_message='回测源码保存失败，结果未采纳', finished_at=now(),
                code_cleanup_status='deleted'
          WHERE id=$1`,
        [runId],
      );
    } finally {
      completed.release();
    }
  } else {
    await pool.query(
      `UPDATE backtest_run
          SET execution_status='failed', progress=100, error_message=$2, finished_at=now(),
              code_cleanup_status=$3
        WHERE id=$1`,
      [runId, worker.error ?? "回测工作器失败", cleanupStatus],
    );
  }
  const final = await pool.query<BacktestRunRow>(
    `SELECT r.id::text, r.name, r.kind, r.execution_status, r.session_id::text,
            r.strategy_change_seq::text, r.strategy_snapshot_hash, r.research_outline, r.hypothesis,
            COALESCE((SELECT json_agg(c.compared_run_id::text ORDER BY c.compared_run_id)
                        FROM backtest_run_comparison c WHERE c.run_id=r.id), '[]') AS comparison_run_ids,
            r.input_summary, r.metrics_json, r.conclusion_md, r.data_gaps,
            r.worker_version, r.sdk_version, r.source_sha256, r.source_size_bytes,
            r.base_source_run_id::text,
            COALESCE((SELECT source.retention_status FROM backtest_run_source source
                       WHERE source.backtest_run_id = r.id), 'none') AS source_retention_status,
            r.code_cleanup_status, r.error_message, r.created_at
       FROM backtest_run r WHERE r.id=$1`,
    [runId],
  );
  return final.rows[0]!;
}
