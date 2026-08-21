import crypto from "node:crypto";
import type pg from "pg";
import { inServiceTransaction, type TransactionDb } from "../../db/transaction.js";
import { apiErrors } from "../../http/router.js";

type QueryDb = Pick<pg.Pool | pg.PoolClient, "query">;

export interface StrategyStateRow {
  change_seq: string;
  current_hash: string;
  last_evolution_id: string | null;
  updated_at: string;
}

export interface StrategyDocumentRow {
  id: string;
  code: string;
  title: string;
  role: "portfolio" | "short" | "long" | "guidance";
  injection_order: number;
  current_revision_id: string;
  current_revision_no: number;
  current_sha256: string;
  current_content: string;
  updated_at: string;
}

export interface StrategyBundle {
  state: StrategyStateRow;
  documents: StrategyDocumentRow[];
}

export interface StrategyEvolutionRow {
  id: string;
  session_id: string | null;
  outline: string;
  conclusion: string;
  adjustments: string[];
  adoption_status: "pending" | "adopted" | "rejected";
  strategy_hash_before: string;
  strategy_hash_after: string | null;
  backtest_run_ids: string[];
  created_at: string;
  decided_at: string | null;
}

export interface StrategyProposalChange {
  document_id: string;
  base_revision_id: string;
  content: string;
}

export interface StrategyProposalInput {
  session_id: string;
  base_change_seq: string;
  base_strategy_hash: string;
  outline: string;
  conclusion: string;
  adjustments: string[];
  summary: string;
  changes: StrategyProposalChange[];
  backtest_run_ids: string[];
}

export interface StrategyProposalRow {
  id: string;
  session_id: string;
  evolution_id: string;
  base_change_seq: string;
  base_strategy_hash: string;
  summary: string;
  proposed_changes: StrategyProposalChange[] | null;
  status: "pending" | "approved" | "rejected" | "expired" | "conflict";
  requires_human: true;
  decided_by: string | null;
  decision_note: string | null;
  created_at: string;
  decided_at: string | null;
  outline?: string;
  conclusion?: string;
  adjustments?: string[];
}

const STATE_SELECT = `SELECT change_seq::text, current_hash, last_evolution_id::text, updated_at
  FROM strategy_state WHERE singleton = 1`;
const DOCUMENT_SELECT = `SELECT d.id::text, d.code, d.title, d.role, d.injection_order,
       d.current_revision_id::text, r.revision_no AS current_revision_no,
       r.sha256 AS current_sha256, r.content AS current_content, d.updated_at
  FROM strategy_document d
  JOIN strategy_document_revision r ON r.id = d.current_revision_id
 ORDER BY d.injection_order, d.id`;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function calculateStrategyHash(documents: StrategyDocumentRow[]): string {
  return sha256(documents.map((document) => `${document.code}:${document.current_sha256}`).join("\n"));
}

function stringField(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw apiErrors.badRequest(`${field} 必须是 1–${max} 字符的非空字符串`);
  }
  return value.trim();
}

function idField(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw apiErrors.badRequest(`${field} 必须是正整数 ID 字符串`);
  }
  return value;
}

function hashField(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw apiErrors.badRequest(`${field} 必须是 64 位小写 SHA-256`);
  }
  return value;
}

export function validateStrategyProposalInput(value: unknown): StrategyProposalInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw apiErrors.badRequest("策略发布提案必须是对象");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "session_id", "base_change_seq", "base_strategy_hash", "outline", "conclusion",
    "adjustments", "summary", "changes", "backtest_run_ids",
  ]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw apiErrors.badRequest(`策略发布提案包含未知字段：${unknown.join("、")}`);
  const rawAdjustments = input.adjustments;
  if (!Array.isArray(rawAdjustments) || rawAdjustments.length === 0 || rawAdjustments.length > 30) {
    throw apiErrors.badRequest("adjustments 必须包含 1–30 项调整点");
  }
  const adjustments = rawAdjustments.map((item, index) => stringField(item, `adjustments[${index}]`, 1000));
  const rawChanges = input.changes;
  if (!Array.isArray(rawChanges) || rawChanges.length === 0 || rawChanges.length > 20) {
    throw apiErrors.badRequest("changes 必须包含 1–20 份策略文档变更");
  }
  const seen = new Set<string>();
  const changes = rawChanges.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw apiErrors.badRequest(`changes[${index}] 必须是对象`);
    }
    const change = item as Record<string, unknown>;
    const itemUnknown = Object.keys(change).filter((key) => !["document_id", "base_revision_id", "content"].includes(key));
    if (itemUnknown.length > 0) throw apiErrors.badRequest(`changes[${index}] 包含未知字段：${itemUnknown.join("、")}`);
    const documentId = idField(change.document_id, `changes[${index}].document_id`);
    if (seen.has(documentId)) throw apiErrors.badRequest(`changes 存在重复 document_id：${documentId}`);
    seen.add(documentId);
    const content = stringField(change.content, `changes[${index}].content`, 1024 * 1024);
    return {
      document_id: documentId,
      base_revision_id: idField(change.base_revision_id, `changes[${index}].base_revision_id`),
      content,
    };
  });
  const rawBacktests = input.backtest_run_ids ?? [];
  if (!Array.isArray(rawBacktests) || rawBacktests.length > 50) {
    throw apiErrors.badRequest("backtest_run_ids 最多 50 项");
  }
  const backtestRunIds = rawBacktests.map((id, index) => idField(id, `backtest_run_ids[${index}]`));
  if (new Set(backtestRunIds).size !== backtestRunIds.length) {
    throw apiErrors.badRequest("backtest_run_ids 存在重复项");
  }
  return {
    session_id: idField(input.session_id, "session_id"),
    base_change_seq: idField(input.base_change_seq, "base_change_seq"),
    base_strategy_hash: hashField(input.base_strategy_hash, "base_strategy_hash"),
    outline: stringField(input.outline, "outline", 4000),
    conclusion: stringField(input.conclusion, "conclusion", 8000),
    adjustments,
    summary: stringField(input.summary, "summary", 2000),
    changes,
    backtest_run_ids: backtestRunIds,
  };
}

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
      throw apiErrors.conflict("当前策略清单哈希不一致，请停止发布并检查数据库", {
        expected_hash: state.current_hash,
        actual_hash: actualHash,
      });
    }
    return { state, documents: documentsResult.rows };
  });
}

/**
 * 读取指定 change_seq 的技术快照。页面不暴露历史正文，但作业重试必须能够复用首次
 * 固化的策略，而不能悄悄改用发布后的新策略。
 */
export async function getStrategySnapshot(
  db: TransactionDb,
  changeSeq: string,
): Promise<StrategyBundle> {
  if (!/^\d+$/.test(changeSeq)) throw apiErrors.badRequest("strategy change_seq 必须是非负整数");
  return inServiceTransaction(db, async (client) => {
    const currentState = (await client.query<StrategyStateRow>(`${STATE_SELECT} FOR SHARE`)).rows[0];
    if (!currentState) throw apiErrors.notFound("当前策略尚未初始化");
    if (BigInt(changeSeq) > BigInt(currentState.change_seq)) {
      throw apiErrors.notFound(`策略快照不存在：change_seq=${changeSeq}`);
    }
    if (changeSeq === currentState.change_seq) return getCurrentStrategy(client);

    const documents = await client.query<StrategyDocumentRow>(
      `SELECT d.id::text, d.code, d.title, d.role, d.injection_order,
              r.id::text AS current_revision_id, r.revision_no AS current_revision_no,
              r.sha256 AS current_sha256, r.content AS current_content, r.created_at AS updated_at
         FROM strategy_document d
         JOIN LATERAL (
           SELECT revision.*
             FROM strategy_document_revision revision
             LEFT JOIN strategy_publish_proposal proposal ON proposal.id = revision.proposal_id
            WHERE revision.document_id = d.id
              AND (
                revision.source = 'migration'
                OR (proposal.status = 'approved' AND proposal.base_change_seq < $1::bigint)
              )
            ORDER BY revision.revision_no DESC
            LIMIT 1
         ) r ON true
        ORDER BY d.injection_order, d.id`,
      [changeSeq],
    );
    const currentCount = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM strategy_document");
    if (documents.rows.length !== Number(currentCount.rows[0]!.count)) {
      throw apiErrors.conflict(`策略快照 ${changeSeq} 不完整，已停止作业执行`);
    }
    const snapshotHash = calculateStrategyHash(documents.rows);
    const evolution = await client.query<{ id: string; decided_at: string }>(
      `SELECT e.id::text, e.decided_at
         FROM strategy_publish_proposal p
         JOIN strategy_evolution_log e ON e.id = p.evolution_id
        WHERE p.status = 'approved' AND p.base_change_seq < $1::bigint
        ORDER BY p.base_change_seq DESC LIMIT 1`,
      [changeSeq],
    );
    return {
      state: {
        change_seq: changeSeq,
        current_hash: snapshotHash,
        last_evolution_id: evolution.rows[0]?.id ?? null,
        updated_at: evolution.rows[0]?.decided_at ?? documents.rows.at(-1)!.updated_at,
      },
      documents: documents.rows,
    };
  });
}

export async function listStrategyEvolutions(db: QueryDb, limit = 50): Promise<StrategyEvolutionRow[]> {
  const result = await db.query<StrategyEvolutionRow>(
    `SELECT e.id::text, e.session_id::text, e.outline, e.conclusion, e.adjustments,
            e.adoption_status, e.strategy_hash_before, e.strategy_hash_after,
            COALESCE((SELECT json_agg(b.backtest_run_id::text ORDER BY b.backtest_run_id)
                        FROM strategy_evolution_backtest b WHERE b.evolution_id = e.id), '[]') AS backtest_run_ids,
            e.created_at, e.decided_at
       FROM strategy_evolution_log e ORDER BY e.id DESC LIMIT $1`,
    [Math.min(200, Math.max(1, limit))],
  );
  return result.rows;
}

export async function listStrategyProposals(db: QueryDb, limit = 50): Promise<StrategyProposalRow[]> {
  const result = await db.query<StrategyProposalRow>(
    `SELECT p.id::text, p.session_id::text, p.evolution_id::text, p.base_change_seq::text,
            p.base_strategy_hash, p.summary,
            CASE WHEN p.status = 'pending' THEN p.proposed_changes ELSE NULL END AS proposed_changes,
            p.status, p.requires_human, p.decided_by, p.decision_note, p.created_at, p.decided_at,
            e.outline, e.conclusion, e.adjustments
       FROM strategy_publish_proposal p
       JOIN strategy_evolution_log e ON e.id = p.evolution_id
      ORDER BY (p.status = 'pending') DESC, p.id DESC LIMIT $1`,
    [Math.min(200, Math.max(1, limit))],
  );
  return result.rows;
}

export async function findStrategyProposal(db: QueryDb, id: string): Promise<StrategyProposalRow | null> {
  const result = await db.query<StrategyProposalRow>(
    `SELECT p.id::text, p.session_id::text, p.evolution_id::text, p.base_change_seq::text,
            p.base_strategy_hash, p.summary,
            CASE WHEN p.status = 'pending' THEN p.proposed_changes ELSE NULL END AS proposed_changes,
            p.status, p.requires_human, p.decided_by, p.decision_note, p.created_at, p.decided_at,
            e.outline, e.conclusion, e.adjustments
       FROM strategy_publish_proposal p
       JOIN strategy_evolution_log e ON e.id = p.evolution_id
      WHERE p.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function createStrategyProposal(
  db: TransactionDb,
  rawInput: unknown,
): Promise<StrategyProposalRow> {
  const input = validateStrategyProposalInput(rawInput);
  return inServiceTransaction(db, async (client) => {
    const session = await client.query<{ session_type: string }>(
      "SELECT session_type FROM chat_session WHERE id = $1 FOR UPDATE",
      [input.session_id],
    );
    if (!session.rows[0] || !["interactive", "strategy_evolution"].includes(session.rows[0].session_type)) {
      throw apiErrors.badRequest("策略发布提案只能由交互或策略演进 session 发起");
    }
    const pending = await client.query("SELECT id FROM strategy_publish_proposal WHERE session_id = $1 AND status = 'pending'", [input.session_id]);
    if (pending.rows[0]) throw apiErrors.conflict("当前 session 已有待审核策略提案");
    const state = await client.query<StrategyStateRow>(`${STATE_SELECT} FOR UPDATE`);
    const current = state.rows[0];
    if (!current) throw apiErrors.notFound("当前策略尚未初始化");
    if (current.change_seq !== input.base_change_seq || current.current_hash !== input.base_strategy_hash) {
      throw apiErrors.conflict("策略基线已变化，请重新读取当前策略后生成新提案", {
        current_change_seq: current.change_seq,
        current_hash: current.current_hash,
      });
    }
    const documents = await client.query<{ id: string; current_revision_id: string }>(
      `SELECT id::text, current_revision_id::text FROM strategy_document
        WHERE id = ANY($1::bigint[]) FOR UPDATE`,
      [input.changes.map((change) => change.document_id)],
    );
    if (documents.rows.length !== input.changes.length) throw apiErrors.badRequest("changes 包含未知策略文档");
    const currentById = new Map(documents.rows.map((document) => [document.id, document.current_revision_id]));
    for (const change of input.changes) {
      if (currentById.get(change.document_id) !== change.base_revision_id) {
        throw apiErrors.conflict(`策略文档 ${change.document_id} 基线已变化`);
      }
    }
    if (input.backtest_run_ids.length > 0) {
      const runs = await client.query<{ id: string }>(
        `SELECT id::text FROM backtest_run
          WHERE id = ANY($1::bigint[])
            AND execution_status IN ('success','partial')
            AND conclusion_status = 'final'`,
        [input.backtest_run_ids],
      );
      if (runs.rows.length !== input.backtest_run_ids.length) {
        throw apiErrors.badRequest("backtest_run_ids 包含不存在、未完成或尚未晋升为最终结论的回测");
      }
    }
    const evolution = await client.query<{ id: string }>(
      `INSERT INTO strategy_evolution_log
         (session_id, outline, conclusion, adjustments, strategy_hash_before)
       VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
      [input.session_id, input.outline, input.conclusion, JSON.stringify(input.adjustments), current.current_hash],
    );
    const evolutionId = evolution.rows[0]!.id;
    const proposal = await client.query<{ id: string }>(
      `INSERT INTO strategy_publish_proposal
         (session_id, evolution_id, base_change_seq, base_strategy_hash, summary, proposed_changes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text`,
      [
        input.session_id,
        evolutionId,
        input.base_change_seq,
        input.base_strategy_hash,
        input.summary,
        JSON.stringify(input.changes),
      ],
    );
    if (input.backtest_run_ids.length > 0) {
      await client.query(
        `INSERT INTO strategy_evolution_backtest (evolution_id, backtest_run_id)
         SELECT $1, unnest($2::bigint[])`,
        [evolutionId, input.backtest_run_ids],
      );
    }
    return (await findStrategyProposal(client, proposal.rows[0]!.id))!;
  });
}

async function markProposalConflict(
  client: pg.PoolClient,
  proposal: StrategyProposalRow,
  note: string,
): Promise<void> {
  await client.query(
    `UPDATE strategy_publish_proposal
        SET status = 'conflict', proposed_changes = NULL, decided_by = 'local_user',
            decision_note = $2, decided_at = now()
      WHERE id = $1`,
    [proposal.id, note],
  );
  await client.query(
    `UPDATE strategy_evolution_log SET adoption_status = 'rejected', decided_at = now()
      WHERE id = $1`,
    [proposal.evolution_id],
  );
}

export async function approveStrategyProposal(
  client: pg.PoolClient,
  id: string,
  decisionNote: string | null,
): Promise<{ proposal: StrategyProposalRow; conflict: boolean; state: StrategyStateRow }> {
  const locked = await client.query<StrategyProposalRow>(
    `SELECT id::text, session_id::text, evolution_id::text, base_change_seq::text,
            base_strategy_hash, summary, proposed_changes, status, requires_human,
            decided_by, decision_note, created_at, decided_at
       FROM strategy_publish_proposal WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const proposal = locked.rows[0];
  if (!proposal) throw apiErrors.notFound(`策略发布提案不存在：${id}`);
  if (proposal.status !== "pending") throw apiErrors.conflict(`策略发布提案已是 ${proposal.status} 状态`);
  if (proposal.requires_human !== true || !proposal.proposed_changes) {
    throw apiErrors.conflict("策略发布提案缺少真人门禁或待发布正文");
  }
  const stateResult = await client.query<StrategyStateRow>(`${STATE_SELECT} FOR UPDATE`);
  const state = stateResult.rows[0]!;
  if (state.change_seq !== proposal.base_change_seq || state.current_hash !== proposal.base_strategy_hash) {
    await markProposalConflict(client, proposal, "批准时策略整体基线已变化");
    return { proposal: (await findStrategyProposal(client, id))!, conflict: true, state };
  }
  const changes = validateStrategyProposalInput({
    session_id: proposal.session_id,
    base_change_seq: proposal.base_change_seq,
    base_strategy_hash: proposal.base_strategy_hash,
    outline: "批准阶段内部复核",
    conclusion: "批准阶段内部复核",
    adjustments: ["批准阶段内部复核"],
    summary: proposal.summary,
    changes: proposal.proposed_changes,
    backtest_run_ids: [],
  }).changes;
  const documents = await client.query<{ id: string; current_revision_id: string }>(
    `SELECT id::text, current_revision_id::text FROM strategy_document
      WHERE id = ANY($1::bigint[]) FOR UPDATE`,
    [changes.map((change) => change.document_id)],
  );
  const currentById = new Map(documents.rows.map((document) => [document.id, document.current_revision_id]));
  if (
    documents.rows.length !== changes.length ||
    changes.some((change) => currentById.get(change.document_id) !== change.base_revision_id)
  ) {
    await markProposalConflict(client, proposal, "批准时策略文档基线已变化");
    return { proposal: (await findStrategyProposal(client, id))!, conflict: true, state };
  }
  for (const change of changes) {
    const next = await client.query<{ revision_no: number }>(
      "SELECT COALESCE(MAX(revision_no), 0) + 1 AS revision_no FROM strategy_document_revision WHERE document_id = $1",
      [change.document_id],
    );
    const revision = await client.query<{ id: string }>(
      `INSERT INTO strategy_document_revision
         (document_id, revision_no, content, sha256, source, proposal_id)
       VALUES ($1, $2, $3, $4, 'human_publish', $5) RETURNING id::text`,
      [change.document_id, next.rows[0]!.revision_no, change.content, sha256(change.content), id],
    );
    await client.query(
      "UPDATE strategy_document SET current_revision_id = $2, updated_at = now() WHERE id = $1",
      [change.document_id, revision.rows[0]!.id],
    );
  }
  const currentDocuments = (await client.query<StrategyDocumentRow>(DOCUMENT_SELECT)).rows;
  const nextHash = calculateStrategyHash(currentDocuments);
  await client.query(
    `UPDATE strategy_evolution_log
        SET adoption_status = 'adopted', strategy_hash_after = $2, decided_at = now()
      WHERE id = $1`,
    [proposal.evolution_id, nextHash],
  );
  await client.query(
    `UPDATE strategy_publish_proposal
        SET status = 'approved', proposed_changes = NULL, decided_by = 'local_user',
            decision_note = $2, decided_at = now()
      WHERE id = $1`,
    [id, decisionNote],
  );
  const updatedState = await client.query<StrategyStateRow>(
    `UPDATE strategy_state
        SET change_seq = change_seq + 1, current_hash = $1,
            last_evolution_id = $2, updated_at = now()
      WHERE singleton = 1
      RETURNING change_seq::text, current_hash, last_evolution_id::text, updated_at`,
    [nextHash, proposal.evolution_id],
  );
  return {
    proposal: (await findStrategyProposal(client, id))!,
    conflict: false,
    state: updatedState.rows[0]!,
  };
}

export async function rejectStrategyProposal(
  client: pg.PoolClient,
  id: string,
  decisionNote: string,
): Promise<StrategyProposalRow> {
  const result = await client.query<{ evolution_id: string; session_id: string }>(
    `UPDATE strategy_publish_proposal
        SET status = 'rejected', proposed_changes = NULL, decided_by = 'local_user',
            decision_note = $2, decided_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING evolution_id::text, session_id::text`,
    [id, decisionNote],
  );
  const row = result.rows[0];
  if (!row) {
    const proposal = await findStrategyProposal(client, id);
    if (!proposal) throw apiErrors.notFound(`策略发布提案不存在：${id}`);
    throw apiErrors.conflict(`策略发布提案已是 ${proposal.status} 状态`);
  }
  await client.query(
    `UPDATE strategy_evolution_log SET adoption_status = 'rejected', decided_at = now()
      WHERE id = $1`,
    [row.evolution_id],
  );
  return (await findStrategyProposal(client, id))!;
}
