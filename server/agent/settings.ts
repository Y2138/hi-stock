import type pg from "pg";

export type Db = Pick<pg.Pool | pg.PoolClient, "query">;

export interface AgentSettings {
  yolo_mode: boolean;
  market_domain_tools_enabled: boolean;
  web_research_enabled: boolean;
  updated_at: string;
}

export async function getAgentSettings(db: Db): Promise<AgentSettings> {
  const result = await db.query<AgentSettings>(
    `SELECT yolo_mode, market_domain_tools_enabled, web_research_enabled, updated_at
       FROM agent_setting WHERE singleton = true`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("agent_setting 单例记录不存在");
  return row;
}

export async function updateAgentSettings(
  db: Db,
  patch: Partial<Pick<AgentSettings, "yolo_mode" | "market_domain_tools_enabled" | "web_research_enabled">>,
): Promise<AgentSettings> {
  const result = await db.query<AgentSettings>(
    `UPDATE agent_setting
        SET yolo_mode = COALESCE($1, yolo_mode),
            market_domain_tools_enabled = COALESCE($2, market_domain_tools_enabled),
            web_research_enabled = COALESCE($3, web_research_enabled),
            updated_at = now()
      WHERE singleton = true
      RETURNING yolo_mode, market_domain_tools_enabled, web_research_enabled, updated_at`,
    [patch.yolo_mode ?? null, patch.market_domain_tools_enabled ?? null, patch.web_research_enabled ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new Error("agent_setting 单例记录不存在");
  return row;
}
