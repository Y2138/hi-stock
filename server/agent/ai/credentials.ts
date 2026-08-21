import type pg from "pg";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { getProviderApiKey, setProviderApiKey } from "./repo.js";

/** pi-ai 凭据适配：密钥只从 PostgreSQL 读取，不回退文件或环境变量。 */
export class DatabaseCredentialStore implements CredentialStore {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly pool: pg.Pool) {}

  async read(
    providerId: string,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const key = await getProviderApiKey(this.pool, providerId);
    return key ? { type: "api_key", key } : undefined;
  }

  async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const result = await this.pool.query<{ provider_id: string }>(
      `SELECT provider_key AS provider_id
       FROM llm_provider
       WHERE api_key IS NOT NULL AND length(api_key) > 0
       ORDER BY provider_key`,
    );
    return result.rows.map((row) => ({ providerId: row.provider_id, type: "api_key" }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const task = (this.chains.get(providerId) ?? Promise.resolve()).then(async () => {
      const current = await this.read(providerId);
      const next = await fn(current);
      if (next?.type === "oauth") {
        throw new Error("数据库 LLM 配置当前只支持 API Key，不支持 OAuth 凭据");
      }
      if (next !== undefined) await setProviderApiKey(this.pool, providerId, next.key ?? null);
      return next ?? current;
    });
    this.chains.set(providerId, task.catch(() => {}));
    return task;
  }

  async delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
    const task = (this.chains.get(providerId) ?? Promise.resolve()).then(() =>
      setProviderApiKey(this.pool, providerId, null),
    );
    this.chains.set(providerId, task.catch(() => {}));
    await task;
  }
}

