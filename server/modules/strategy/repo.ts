import crypto from "node:crypto";
import { inServiceTransaction, type TransactionDb } from "../../db/transaction.js";
import { apiErrors } from "../../http/router.js";

export interface StrategyStateRow {
  change_seq: string;
  current_hash: string;
  updated_at: string;
}

export interface StrategyDocumentRow {
  id: string;
  code: string;
  title: string;
  role: "portfolio" | "task" | "guidance";
  injection_order: number;
  job_code: string | null;
  sha256: string;
  content: string;
  updated_at: string;
}

export interface StrategyBundle {
  state: StrategyStateRow;
  documents: StrategyDocumentRow[];
}

const STATE_SELECT = `SELECT change_seq::text, current_hash, updated_at
  FROM strategy_state WHERE singleton = 1`;
const DOCUMENT_SELECT = `SELECT d.id::text, d.code, d.title, d.role, d.injection_order, d.job_code,
       d.sha256, d.content, d.updated_at
  FROM strategy_document d
 ORDER BY d.injection_order, d.id`;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function calculateStrategyHash(documents: StrategyDocumentRow[]): string {
  return sha256(documents.map((document) => `${document.code}:${document.sha256}`).join("\n"));
}

/**
 * 系统只保留当前最终策略：策略正文由迁移与本地回测→策略文档链路维护，
 * 不再有内置 Agent 提案或页面审核发布。运行中的会话和任务始终读取当前正文。
 */
export async function getCurrentStrategy(db: TransactionDb): Promise<StrategyBundle> {
  return inServiceTransaction(db, async (client) => {
    const [stateResult, documentsResult] = await Promise.all([
      client.query<StrategyStateRow>(`${STATE_SELECT} FOR SHARE`),
      client.query<StrategyDocumentRow>(DOCUMENT_SELECT),
    ]);
    const state = stateResult.rows[0];
    if (!state) throw apiErrors.notFound("当前策略尚未初始化");
    const actualHash = calculateStrategyHash(documentsResult.rows);
    if (actualHash !== state.current_hash) {
      throw apiErrors.conflict("当前策略清单哈希不一致，请检查 strategy_document 与 strategy_state", {
        expected_hash: state.current_hash,
        actual_hash: actualHash,
      });
    }
    return { state, documents: documentsResult.rows };
  });
}
