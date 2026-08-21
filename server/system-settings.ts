import type pg from "pg";

export type SystemSettingsDb = Pick<pg.Pool | pg.PoolClient, "query">;

export interface SystemSettings {
  hithink_api_key_configured: boolean;
  updated_at: string;
}

const SAFE_COLUMNS = `
  (hithink_api_key IS NOT NULL AND length(hithink_api_key) > 0) AS hithink_api_key_configured,
  updated_at`;

export async function getSystemSettings(db: SystemSettingsDb): Promise<SystemSettings> {
  const result = await db.query<SystemSettings>(
    `SELECT ${SAFE_COLUMNS} FROM system_setting WHERE singleton = true`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("system_setting 单例记录不存在");
  return row;
}

/** 仅供 datasource 服务端认证使用；不得把返回值放入 API、日志或审计。 */
export async function getHithinkApiKey(db: SystemSettingsDb): Promise<string | null> {
  const result = await db.query<{ hithink_api_key: string | null }>(
    "SELECT hithink_api_key FROM system_setting WHERE singleton = true",
  );
  return result.rows[0]?.hithink_api_key?.trim() || null;
}

export async function updateHithinkApiKey(
  db: SystemSettingsDb,
  apiKey: string | null,
): Promise<SystemSettings> {
  const result = await db.query<SystemSettings>(
    `UPDATE system_setting
        SET hithink_api_key = $1, updated_at = now()
      WHERE singleton = true
      RETURNING ${SAFE_COLUMNS}`,
    [apiKey],
  );
  const row = result.rows[0];
  if (!row) throw new Error("system_setting 单例记录不存在");
  return row;
}

/** 0040 上线兼容：只在库中尚无 Key 时接收一次旧 env 值，运行时请求不再读取 env。 */
export async function importLegacyHithinkApiKey(
  db: SystemSettingsDb,
  legacyValue: string | undefined,
): Promise<boolean> {
  const apiKey = legacyValue?.trim();
  if (!apiKey) return false;
  const result = await db.query(
    `UPDATE system_setting
        SET hithink_api_key = $1, updated_at = now()
      WHERE singleton = true AND hithink_api_key IS NULL`,
    [apiKey],
  );
  return (result.rowCount ?? 0) > 0;
}
