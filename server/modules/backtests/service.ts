import type pg from "pg";
import {
  canonicalJson, contentHash, STANDARD_INPUT_VERSION, validateStandardPlan,
  type StandardBacktestPlan, type StandardDay, type StandardInputManifest,
} from "../../backtest/contracts.js";
import { decodeStandardChunk, inspectStandardInput, type StandardPreflight } from "../../backtest/input.js";

export class StandardBacktestPreflightError extends Error {
  constructor(public readonly report: StandardPreflight) { super("标准回测必要数据或能力不完整；请按缺口通过外部流程补齐数据库，系统不会自动同步"); }
}

async function snapshot<T>(pool: pg.Pool, readOnly: boolean, operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL REPEATABLE READ${readOnly ? " READ ONLY" : ""}`);
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '5min'");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function preflightStandardBacktest(pool: pg.Pool, input: unknown, signal?: AbortSignal): Promise<StandardPreflight> {
  const plan = validateStandardPlan(input);
  return snapshot(pool, true, async client => (await inspectStandardInput(client, plan, false, signal)).report);
}

export interface FrozenStandardInput {
  id: string;
  sha256: string;
  plan: StandardBacktestPlan;
  manifest: StandardInputManifest;
  evidence_status: "research_only";
}

/** 冻结是独立领域写入，不提供HTTP写入口；无效或取消的准备不会留下部分输入。 */
export async function freezeStandardBacktestInput(
  pool: pg.Pool, input: unknown,
  expected: { plan_hash: string; input_hash: string },
  signal?: AbortSignal,
): Promise<FrozenStandardInput> {
  const plan = validateStandardPlan(input);
  if (contentHash(plan) !== expected.plan_hash) throw new Error("执行计划已变化，请重新预检");
  return snapshot(pool, false, async client => {
    const { report, chunks } = await inspectStandardInput(client, plan, true, signal);
    if (!report.executable) throw new StandardBacktestPreflightError(report);
    if (report.input_hash !== expected.input_hash) throw new Error("预检后数据库输入已变化，请重新确认预检结果");
    if (signal?.aborted) throw new Error("输入冻结已取消");
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO backtest_input_set (sha256,schema_version,manifest,row_count,byte_count)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (sha256) DO NOTHING RETURNING id::text`,
      [report.input_hash, STANDARD_INPUT_VERSION, canonicalJson(report.manifest), report.manifest.row_count, report.estimated_compressed_bytes],
    );
    let id = inserted.rows[0]?.id;
    if (id) {
      for (const [seq, chunk] of chunks.entries()) {
        if (signal?.aborted) throw new Error("输入冻结已取消");
        await client.query(
          `INSERT INTO backtest_input_chunk (input_set_id,seq,trade_date,sha256,encoding,payload,raw_bytes,row_count)
           VALUES ($1,$2,$3,$4,'gzip-json-v1',$5,$6,$7)`,
          [id, seq, chunk.day, chunk.hash, chunk.payload, chunk.rawBytes, chunk.rows],
        );
      }
    } else {
      id = (await client.query<{ id: string }>("SELECT id::text FROM backtest_input_set WHERE sha256=$1", [report.input_hash])).rows[0]?.id;
    }
    if (!id) throw new Error("输入冻结并发冲突，请重试预检");
    if (signal?.aborted) throw new Error("输入冻结已取消");
    return { id, sha256: report.input_hash, plan, manifest: report.manifest, evidence_status: "research_only" };
  });
}

/** 逐块读取不会加载全部历史；生命周期由调用方的只读快照覆盖整个迭代。 */
export async function* readFrozenStandardInput(pool: pg.Pool, id: string, expectedHash: string): AsyncGenerator<StandardDay> {
  if (!/^\d+$/.test(id) || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("冻结输入标识非法");
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const set = (await client.query<{ sha256: string; schema_version: string; manifest: StandardInputManifest; row_count: number }>(
      "SELECT sha256,schema_version,manifest,row_count FROM backtest_input_set WHERE id=$1", [id],
    )).rows[0];
    if (!set || set.sha256 !== expectedHash || set.schema_version !== STANDARD_INPUT_VERSION || contentHash(set.manifest) !== expectedHash || !Array.isArray(set.manifest.chunks)) throw new Error("冻结输入清单校验失败");
    let rowCount = 0;
    for (const [seq, expected] of set.manifest.chunks.entries()) {
      const row = (await client.query<{ payload: Buffer; encoding: string; raw_bytes: number; sha256: string; trade_date: string; row_count: number }>(
        "SELECT payload,encoding,raw_bytes,sha256,trade_date::text,row_count FROM backtest_input_chunk WHERE input_set_id=$1 AND seq=$2", [id, seq],
      )).rows[0];
      if (!row || row.sha256 !== expected.sha256 || row.raw_bytes !== expected.bytes || row.trade_date !== expected.date || row.row_count !== expected.rows) throw new Error("冻结输入分块缺失或与清单不一致");
      const day = decodeStandardChunk(row);
      if (day.bars.length + (day.environment_bars?.length ?? 0) + (day.benchmark ? 1 : 0) !== row.row_count) throw new Error("冻结输入行数不符");
      rowCount += row.row_count;
      yield day;
    }
    const count = (await client.query<{ count: number }>("SELECT count(*)::int AS count FROM backtest_input_chunk WHERE input_set_id=$1", [id])).rows[0]!.count;
    if (count !== set.manifest.day_count || count !== set.manifest.chunks.length || rowCount !== set.row_count || rowCount !== set.manifest.row_count) throw new Error("冻结输入总行数或日期数不一致");
    await client.query("COMMIT");
  } finally {
    // 正常提交后ROLLBACK无副作用；提前break/异常时结束只读事务并归还连接。
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}
