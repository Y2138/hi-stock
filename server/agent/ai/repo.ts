import type pg from "pg";
import type { ActiveLlmConfig, LlmModelRow, LlmProviderRow } from "./types.js";

export type Db = Pick<pg.Pool, "query">;

const PROVIDER_COLS = `
  id::text, provider_key, name, api_protocol, base_url,
  (api_key IS NOT NULL AND length(api_key) > 0) AS api_key_configured,
  enabled, created_at, updated_at`;
const MODEL_COLS = `
  id::text, provider_id::text, model_key, name, input_modalities,
  reasoning, context_window, max_tokens, enabled, created_at, updated_at`;

export async function listLlmProviders(db: Db): Promise<LlmProviderRow[]> {
  const [providerRows, modelRows] = await Promise.all([
    db.query<Omit<LlmProviderRow, "models">>(
      `SELECT ${PROVIDER_COLS} FROM llm_provider ORDER BY created_at, id`,
    ),
    db.query<LlmModelRow>(
      `SELECT ${MODEL_COLS} FROM llm_model ORDER BY provider_id, created_at, id`,
    ),
  ]);
  const byProvider = new Map<string, LlmModelRow[]>();
  for (const model of modelRows.rows) {
    const list = byProvider.get(model.provider_id) ?? [];
    list.push(model);
    byProvider.set(model.provider_id, list);
  }
  return providerRows.rows.map((provider) => ({
    ...provider,
    models: byProvider.get(provider.id) ?? [],
  }));
}

async function getLlmConfig(db: Db, modelId: string | null): Promise<ActiveLlmConfig | null> {
  const result = await db.query<
    Omit<ActiveLlmConfig["provider"], "api_key_configured"> &
      Omit<LlmModelRow, "id" | "provider_id" | "name" | "enabled" | "created_at" | "updated_at"> & {
        provider_api_key_configured: boolean;
        provider_enabled: boolean;
        provider_created_at: string;
        provider_updated_at: string;
        model_id: string;
        model_name: string;
        model_enabled: boolean;
        model_created_at: string;
        model_updated_at: string;
      }
  >(
    `SELECT
       p.id::text, p.provider_key, p.name, p.api_protocol, p.base_url,
       (p.api_key IS NOT NULL AND length(p.api_key) > 0) AS provider_api_key_configured,
       p.enabled AS provider_enabled, p.created_at AS provider_created_at,
       p.updated_at AS provider_updated_at,
       m.id::text AS model_id, m.model_key, m.name AS model_name, m.input_modalities,
       m.reasoning, m.context_window, m.max_tokens, m.enabled AS model_enabled,
       m.created_at AS model_created_at, m.updated_at AS model_updated_at
     FROM llm_model m
     JOIN llm_provider p ON p.id = m.provider_id
     WHERE m.id = COALESCE(
       $1::bigint,
       (SELECT active_model_id FROM llm_setting WHERE singleton = true)
     )`,
    [modelId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    provider: {
      id: row.id,
      provider_key: row.provider_key,
      name: row.name,
      api_protocol: row.api_protocol,
      base_url: row.base_url,
      api_key_configured: row.provider_api_key_configured,
      enabled: row.provider_enabled,
      created_at: row.provider_created_at,
      updated_at: row.provider_updated_at,
    },
    model: {
      id: row.model_id,
      provider_id: row.id,
      model_key: row.model_key,
      name: row.model_name,
      input_modalities: row.input_modalities,
      reasoning: row.reasoning,
      context_window: row.context_window,
      max_tokens: row.max_tokens,
      enabled: row.model_enabled,
      created_at: row.model_created_at,
      updated_at: row.model_updated_at,
    },
  };
}

/** 全局当前模型：设置页与自动流程的默认模型。 */
export async function getActiveLlmConfig(db: Db): Promise<ActiveLlmConfig | null> {
  return getLlmConfig(db, null);
}

/** 会话指定模型：不读取或改写全局当前模型。 */
export async function getLlmConfigByModelId(
  db: Db,
  modelId: string,
): Promise<ActiveLlmConfig | null> {
  return getLlmConfig(db, modelId);
}

export async function getProviderApiKey(
  db: Db,
  providerKey: string,
): Promise<string | null> {
  const result = await db.query<{ api_key: string | null }>(
    `SELECT api_key FROM llm_provider WHERE provider_key = $1`,
    [providerKey],
  );
  return result.rows[0]?.api_key ?? null;
}

/** 只为受控服务端能力读取已启用厂商的密钥；密钥不会进入工具参数或结果。 */
export async function getEnabledProviderApiKey(
  db: Db,
  providerKey: string,
  requiredOrigin?: string,
): Promise<string | null> {
  const result = await db.query<{ api_key: string | null; base_url: string }>(
    `SELECT api_key, base_url FROM llm_provider WHERE provider_key = $1 AND enabled = true`,
    [providerKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (requiredOrigin) {
    try {
      if (new URL(row.base_url).origin !== requiredOrigin) return null;
    } catch {
      return null;
    }
  }
  return row.api_key;
}

export async function setProviderApiKey(
  db: Db,
  providerKey: string,
  apiKey: string | null,
): Promise<void> {
  await db.query(
    `UPDATE llm_provider SET api_key = $2, updated_at = now() WHERE provider_key = $1`,
    [providerKey, apiKey],
  );
}

export async function getActiveModelId(db: Db): Promise<string | null> {
  const result = await db.query<{ active_model_id: string | null }>(
    `SELECT active_model_id::text FROM llm_setting WHERE singleton = true`,
  );
  return result.rows[0]?.active_model_id ?? null;
}

export async function createLlmProvider(
  db: Db,
  input: {
    provider_key: string;
    name: string;
    api_protocol: string;
    base_url: string;
    api_key: string | null;
  },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO llm_provider (provider_key, name, api_protocol, base_url, api_key)
     VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
    [input.provider_key, input.name, input.api_protocol, input.base_url, input.api_key],
  );
  return result.rows[0]!.id;
}

export async function updateLlmProvider(
  db: Db,
  id: string,
  patch: {
    name?: string;
    api_protocol?: string;
    base_url?: string;
    api_key?: string | null;
    enabled?: boolean;
  },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE llm_provider SET
       name = COALESCE($2, name),
       api_protocol = COALESCE($3, api_protocol),
       base_url = COALESCE($4, base_url),
       api_key = CASE WHEN $5::boolean THEN $6 ELSE api_key END,
       enabled = COALESCE($7, enabled),
       updated_at = now()
     WHERE id = $1`,
    [
      id,
      patch.name ?? null,
      patch.api_protocol ?? null,
      patch.base_url ?? null,
      Object.prototype.hasOwnProperty.call(patch, "api_key"),
      patch.api_key ?? null,
      patch.enabled ?? null,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteLlmProvider(db: Db, id: string): Promise<boolean> {
  const active = await db.query(
    `SELECT 1
     FROM llm_setting s
     JOIN llm_model m ON m.id = s.active_model_id
     WHERE s.singleton = true AND m.provider_id = $1`,
    [id],
  );
  if ((active.rowCount ?? 0) > 0) return false;
  const result = await db.query(`DELETE FROM llm_provider WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function createLlmModel(
  db: Db,
  providerId: string,
  input: {
    model_key: string;
    name: string;
    input_modalities: string[];
    reasoning: boolean;
    context_window: number;
    max_tokens: number;
  },
): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO llm_model (
       provider_id, model_key, name, input_modalities, reasoning, context_window, max_tokens
     )
     SELECT id, $2, $3, $4, $5, $6, $7 FROM llm_provider WHERE id = $1
     RETURNING id::text`,
    [
      providerId,
      input.model_key,
      input.name,
      JSON.stringify(input.input_modalities),
      input.reasoning,
      input.context_window,
      input.max_tokens,
    ],
  );
  return result.rows[0]?.id ?? null;
}

export async function updateLlmModel(
  db: Db,
  id: string,
  patch: {
    model_key?: string;
    name?: string;
    input_modalities?: string[];
    reasoning?: boolean;
    context_window?: number;
    max_tokens?: number;
    enabled?: boolean;
  },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE llm_model SET
       model_key = COALESCE($2, model_key),
       name = COALESCE($3, name),
       input_modalities = COALESCE($4::jsonb, input_modalities),
       reasoning = COALESCE($5, reasoning),
       context_window = COALESCE($6, context_window),
       max_tokens = COALESCE($7, max_tokens),
       enabled = COALESCE($8, enabled),
       updated_at = now()
     WHERE id = $1`,
    [
      id,
      patch.model_key ?? null,
      patch.name ?? null,
      patch.input_modalities ? JSON.stringify(patch.input_modalities) : null,
      patch.reasoning ?? null,
      patch.context_window ?? null,
      patch.max_tokens ?? null,
      patch.enabled ?? null,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteLlmModel(db: Db, id: string): Promise<"deleted" | "active" | "missing"> {
  const activeId = await getActiveModelId(db);
  if (activeId === id) return "active";
  const result = await db.query(`DELETE FROM llm_model WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0 ? "deleted" : "missing";
}

export async function activateLlmModel(db: Db, id: string): Promise<boolean> {
  const exists = await db.query(
    `SELECT 1
     FROM llm_model m
     JOIN llm_provider p ON p.id = m.provider_id
     WHERE m.id = $1 AND m.enabled = true AND p.enabled = true`,
    [id],
  );
  if ((exists.rowCount ?? 0) === 0) return false;
  await db.query(
    `UPDATE llm_setting SET active_model_id = $1, updated_at = now() WHERE singleton = true`,
    [id],
  );
  return true;
}
