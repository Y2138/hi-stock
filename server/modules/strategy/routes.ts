import type pg from "pg";
import { persistAndPublishSessionEvent } from "../../agent/events.js";
import { withAgentMutationLock } from "../../agent/mutation-lock.js";
import { apiErrors } from "../../http/router.js";
import {
  approveStrategyProposal,
  findStrategyProposal,
  getCurrentStrategy,
  listStrategyEvolutions,
  listStrategyProposals,
  rejectStrategyProposal,
} from "./repo.js";
import { consumeStrategyReviewToken, issueStrategyReviewToken } from "./review-token.js";

interface Ctx {
  pool: pg.Pool;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw apiErrors.badRequest("请求体必须是对象");
  return value as Record<string, unknown>;
}

function reviewBody(value: unknown, requireNote: boolean): { review_token: string; decision_note: string | null } {
  const body = bodyRecord(value);
  const allowed = ["actor_type", "interaction_source", "review_token", "decision_note"];
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw apiErrors.badRequest(`包含未知字段：${unknown.join("、")}`);
  if (body.actor_type !== "user" || body.interaction_source !== "strategy_page") {
    throw apiErrors.forbidden("策略发布只接受当前策略页面的真实用户操作");
  }
  if (typeof body.review_token !== "string" || body.review_token.length < 20) {
    throw apiErrors.forbidden("策略审核页面令牌缺失或无效");
  }
  const note = body.decision_note;
  if (note !== undefined && note !== null && (typeof note !== "string" || note.trim().length > 2000)) {
    throw apiErrors.badRequest("decision_note 必须是不超过 2000 字的字符串");
  }
  if (requireNote && (typeof note !== "string" || note.trim().length === 0)) {
    throw apiErrors.badRequest("拒绝策略提案必须填写原因");
  }
  return { review_token: body.review_token, decision_note: typeof note === "string" ? note.trim() : null };
}

function limitOf(query: URLSearchParams): number {
  const value = Number(query.get("limit") ?? 50);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 200) : 50;
}

export const strategyRoutes = {
  async current({ pool }: Ctx) {
    return { data: await getCurrentStrategy(pool) };
  },

  async evolutions({ pool, query }: Ctx) {
    return { data: await listStrategyEvolutions(pool, limitOf(query)) };
  },

  async proposals({ pool, query }: Ctx) {
    return { data: await listStrategyProposals(pool, limitOf(query)) };
  },

  async review({ pool, params }: Ctx) {
    const proposal = await findStrategyProposal(pool, params.id!);
    if (!proposal) throw apiErrors.notFound(`策略发布提案不存在：${params.id}`);
    if (proposal.status !== "pending") throw apiErrors.conflict(`策略发布提案已是 ${proposal.status} 状态`);
    return { data: { proposal, review: issueStrategyReviewToken(proposal.id) } };
  },

  async approve({ pool, params, body }: Ctx) {
    const input = reviewBody(body, false);
    if (!consumeStrategyReviewToken(params.id!, input.review_token)) {
      throw apiErrors.forbidden("策略审核页面令牌已失效，请刷新提案后重试");
    }
    const result = await withAgentMutationLock(pool, (client) =>
      approveStrategyProposal(client, params.id!, input.decision_note),
    );
    await persistAndPublishSessionEvent(pool, {
      session_id: result.proposal.session_id,
      event_type: "strategy_publish_result",
      data: { proposal_id: result.proposal.id, status: result.proposal.status },
    }).catch(() => {});
    await persistAndPublishSessionEvent(pool, {
      session_id: result.proposal.session_id,
      event_type: "ui_refresh",
      data: { targets: ["strategies", "status"], reason: "策略发布审核结果已更新" },
    }).catch(() => {});
    if (result.conflict) {
      throw apiErrors.conflict("策略基线在审核前已变化，提案已标记冲突且未发布", {
        current_change_seq: result.state.change_seq,
        current_hash: result.state.current_hash,
      });
    }
    return { data: result };
  },

  async reject({ pool, params, body }: Ctx) {
    const input = reviewBody(body, true);
    if (!consumeStrategyReviewToken(params.id!, input.review_token)) {
      throw apiErrors.forbidden("策略审核页面令牌已失效，请刷新提案后重试");
    }
    const proposal = await withAgentMutationLock(pool, (client) =>
      rejectStrategyProposal(client, params.id!, input.decision_note!),
    );
    await persistAndPublishSessionEvent(pool, {
      session_id: proposal.session_id,
      event_type: "strategy_publish_result",
      data: { proposal_id: proposal.id, status: proposal.status },
    }).catch(() => {});
    await persistAndPublishSessionEvent(pool, {
      session_id: proposal.session_id,
      event_type: "ui_refresh",
      data: { targets: ["strategies", "status"], reason: "策略发布审核结果已更新" },
    }).catch(() => {});
    return { data: proposal };
  },
};
