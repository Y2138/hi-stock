// 推送前检查：待推送的改动里是否出现本机运行数据（真实信号、真实交易日、真实价位）。
//
// 背景：边界 1 的影子回放曾把 908 条导出里的真实 signal id / 日期 / 风险价写进测试源码，
// 已在后续提交移除，但历史里仍留有那一段。凡是还没清理干净就推送，远端就永久留下运行数据。
//
// 用法：
//   npm run check:push                  # 默认扫描 origin/main..HEAD
//   npm run check:push -- ba93457..HEAD # 指定范围
//
// 判定：新增行同时出现「真实标的代码」与「该标的在导出里的真实交易日」，视为疑似硬编码。
// 命中即退出码 1，必须先清理（改写成合成样本或从历史移除）再推送。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EXPORT_FILE = path.join("artifacts", "signal-export-20261111", "strategy_entry_signal.jsonl");

interface RealRow {
  instrument_code: string;
  valid_from: string;
}

function loadRealRows(): RealRow[] {
  if (!fs.existsSync(EXPORT_FILE)) return [];
  return fs.readFileSync(EXPORT_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RealRow);
}

function resolveRange(): string {
  const explicit = process.argv[2];
  if (explicit) return explicit;
  try {
    execFileSync("git", ["rev-parse", "--verify", "origin/main"], { stdio: "ignore" });
    return "origin/main..HEAD";
  } catch {
    return "HEAD";
  }
}

interface CommitAdditions {
  sha: string;
  subject: string;
  lines: string[];
}

/**
 * 逐提交取新增行：净差异看不到「某个提交先加、后续提交又删」的情况，
 * 而推送一旦发生，每个历史提交都会永久留在远端，所以必须按提交检查。
 */
function addedLinesByCommit(range: string): CommitAdditions[] {
  const output = execFileSync("git", ["log", "--format=__COMMIT__%H %s", "-p", "-U0", range], {
    encoding: "utf8", maxBuffer: 128 * 1024 * 1024,
  });
  const commits: CommitAdditions[] = [];
  let current: CommitAdditions | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("__COMMIT__")) {
      const [sha, ...rest] = line.slice("__COMMIT__".length).split(" ");
      current = { sha: sha ?? "", subject: rest.join(" "), lines: [] };
      commits.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) current.lines.push(line);
  }
  return commits;
}

const realRows = loadRealRows();
if (realRows.length === 0) {
  console.log(`[check:push] 未找到本机导出 ${EXPORT_FILE}，跳过运行数据比对（只做本地检查）。`);
  process.exit(0);
}

const range = resolveRange();
const commits = addedLinesByCommit(range);
// 真实标的 + 真实交易日：只有两者同时出现在同一新增行，才算把运行记录搬进代码。
const fingerprints = new Map<string, Set<string>>();
for (const row of realRows) {
  const dates = fingerprints.get(row.instrument_code) ?? new Set<string>();
  dates.add(row.valid_from);
  fingerprints.set(row.instrument_code, dates);
}

const hits: Array<{ sha: string; subject: string; line: string; code: string; date: string }> = [];
for (const commit of commits) {
  for (const line of commit.lines) {
    for (const [code, dates] of fingerprints) {
      if (!line.includes(code)) continue;
      let matched = false;
      for (const date of dates) {
        if (line.includes(date)) {
          hits.push({ sha: commit.sha, subject: commit.subject, line: line.slice(0, 160), code, date });
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
  }
}

if (hits.length === 0) {
  const total = commits.reduce((sum, commit) => sum + commit.lines.length, 0);
  console.log(`[check:push] 范围 ${range}：${commits.length} 个提交、${total} 行新增，逐提交未发现真实信号样本。`);
  process.exit(0);
}

console.error(`[check:push] 范围 ${range}：发现 ${hits.length} 处疑似把本机运行数据写入代码，必须先清理再推送：`);
for (const hit of hits.slice(0, 20)) {
  console.error(`  - ${hit.sha.slice(0, 7)} ${hit.subject}｜${hit.code} @ ${hit.date}：${hit.line.trim()}`);
}
if (hits.length > 20) console.error(`  ... 另有 ${hits.length - 20} 处`);
process.exit(1);
