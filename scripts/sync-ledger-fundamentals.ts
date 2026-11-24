// 只从台账表格收集A股代码，抓取经领域服务落库；不改台账、不回填历史估值。
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import { closePool, getPool } from "../server/db/client.js";
import { loadConfig } from "../server/config.js";
import { fetchFinancialAndStore, fetchFundamentalHistoryAndStore } from "../server/datasource/service.js";

function ledgerCodes(directory: string): string[] {
  const codes = new Set<string>();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) ledgerCodes(file).forEach(code => codes.add(code));
    else if (entry.name === "03-每日结论.md") {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!/^\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(line)) continue;
        const matches = (line.split("|")[2] ?? "").match(/\b\d{6}\.(?:SH|SZ|BJ)\b/g) ?? [];
        matches.forEach(code => codes.add(code));
      }
    }
  }
  return [...codes].sort();
}
const codes = ledgerCodes(path.resolve("研究台账"));
console.log(JSON.stringify({ mode: process.argv.includes("--apply") ? "apply" : "preview", count: codes.length, codes }));
if (process.argv.includes("--apply")) {
  if (codes.length !== 29) throw new Error("台账标的数不是29，先核对范围再同步");
  const pool = getPool(loadConfig().databaseUrl);
  try {
    const deadline = Date.now() + 30 * 60_000;
    let waitReported = false;
    for (;;) {
      const active = await pool.query(`SELECT run.id, definition.code, run.status FROM job_run run JOIN job_definition definition ON definition.id=run.job_id
        WHERE run.status IN ('queued','running') AND definition.job_type='datasource'`);
      if (!active.rows.length) break;
      if (!process.argv.includes("--wait-until-idle") || Date.now() >= deadline) {
        throw new Error(`存在数据源任务，暂不交错同步：${active.rows.map(row => `${row.code}#${row.id}:${row.status}`).join(',')}`);
      }
      if (!waitReported) {
        console.log(JSON.stringify({ status: "waiting_for_datasource_idle", active: active.rows, timeout_minutes: 30 }));
        waitReported = true;
      }
      await new Promise(resolve => setTimeout(resolve, 30_000));
    }
    let written = 0, failed = 0, partial = 0;
    for (const code of codes) {
      for (const [operation, sync] of [["latest", fetchFinancialAndStore], ["history", fetchFundamentalHistoryAndStore]] as const) {
        try {
          const result = await sync(pool, { code });
          written += result.rowsWritten;
          if (result.status === "partial") partial++;
          console.log(JSON.stringify({ code, operation, status: result.status, rows: result.rowsWritten, fetch_run_id: result.fetchRunId, gap_count: result.gaps.length }));
        } catch {
          failed++;
          // 不输出上游错误正文（可能回显敏感信息），失败细节看安全留痕。
          console.log(JSON.stringify({ code, operation, status: "failed", reason: "同步失败，未补造数据" }));
        }
      }
    }
    console.log(JSON.stringify({ completed: true, codes: codes.length, written, partial, failed }));
    if (failed || partial) process.exitCode = 2;
  } finally { await closePool(); }
}
