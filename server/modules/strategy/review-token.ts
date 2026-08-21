import crypto from "node:crypto";

const REVIEW_TOKEN_TTL_MS = 5 * 60_000;

interface ReviewGrant {
  token_hash: string;
  expires_at: number;
}

const grants = new Map<string, ReviewGrant>();

function hash(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * 本机单用户应用没有账号体系。真人审核采用页面临时令牌：令牌只存在当前 server 内存，
 * 不写数据库、Agent 消息或工具结果，重启后必须由策略页面重新领取。
 */
export function issueStrategyReviewToken(proposalId: string): { token: string; expires_at: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + REVIEW_TOKEN_TTL_MS;
  grants.set(proposalId, { token_hash: hash(token), expires_at: expiresAt });
  return { token, expires_at: new Date(expiresAt).toISOString() };
}

export function consumeStrategyReviewToken(proposalId: string, token: string): boolean {
  const grant = grants.get(proposalId);
  grants.delete(proposalId);
  if (!grant || grant.expires_at < Date.now()) return false;
  const actual = Buffer.from(hash(token), "hex");
  const expected = Buffer.from(grant.token_hash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
