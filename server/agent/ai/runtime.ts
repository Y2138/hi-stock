import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type MutableModels,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type pg from "pg";
import { ApiError } from "../../http/router.js";
import { DatabaseCredentialStore } from "./credentials.js";
import { getActiveLlmConfig, getLlmConfigByModelId } from "./repo.js";
import type { ActiveLlmConfig, LlmApiProtocol } from "./types.js";

export type AnyModel = Model<Api>;

export interface ResolvedChatModel {
  models: MutableModels;
  model: AnyModel;
  provider: string;
  providerName: string;
  modelId: string;
}

let injectedRuntime: ResolvedChatModel | null = null;

/** 永久测试使用 faux provider 注入；生产路径始终从数据库组装。 */
export function setAiRuntimeForTests(runtime: ResolvedChatModel | null): void {
  injectedRuntime = runtime;
}

function apiFor(protocol: LlmApiProtocol): ProviderStreams {
  switch (protocol) {
    case "openai-completions":
      return openAICompletionsApi();
    case "openai-responses":
      return openAIResponsesApi();
    case "anthropic-messages":
      return anthropicMessagesApi();
  }
}

function toPiModel(config: ActiveLlmConfig): AnyModel {
  return {
    id: config.model.model_key,
    name: config.model.name,
    api: config.provider.api_protocol,
    provider: config.provider.provider_key,
    baseUrl: config.provider.base_url,
    reasoning: config.model.reasoning,
    input: config.model.input_modalities,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.model.context_window,
    maxTokens: config.model.max_tokens,
  };
}

/**
 * AI 层唯一入口：读取会话指定模型；未指定时读取全局当前模型。
 * 构建 pi-ai Provider/Models，并完成凭据检查。
 * core 层只消费统一的 model + streamFn，不感知厂商协议和密钥存储。
 */
export async function resolveActiveChatModel(
  pool: pg.Pool,
  modelId?: string | null,
): Promise<ResolvedChatModel> {
  if (injectedRuntime) return injectedRuntime;

  const config = modelId
    ? await getLlmConfigByModelId(pool, modelId)
    : await getActiveLlmConfig(pool);
  if (!config) {
    throw new ApiError(
      503,
      "LLM_NOT_CONFIGURED",
      modelId
        ? "本会话选择的模型已不存在，请在对话框中重新选择"
        : "尚未选择当前模型，请在设置页配置模型厂商并启用模型",
    );
  }
  if (!config.provider.enabled || !config.model.enabled) {
    throw new ApiError(503, "LLM_DISABLED", "当前模型或模型厂商已停用，请在设置页重新选择");
  }
  if (!config.provider.api_key_configured) {
    throw new ApiError(
      503,
      "LLM_NOT_CONFIGURED",
      `模型厂商 ${config.provider.name} 尚未配置 API Key，请在设置页补充`,
    );
  }

  const credentialStore = new DatabaseCredentialStore(pool);
  const models = createModels({ credentials: credentialStore });
  const model = toPiModel(config);
  models.setProvider(
    createProvider({
      id: config.provider.provider_key,
      name: config.provider.name,
      baseUrl: config.provider.base_url,
      auth: {
        apiKey: {
          name: `${config.provider.name} API Key`,
          resolve: async ({ credential }) =>
            credential?.key
              ? { auth: { apiKey: credential.key }, source: "PostgreSQL" }
              : undefined,
        },
      },
      models: [model],
      api: apiFor(config.provider.api_protocol),
    }),
  );

  let auth;
  try {
    auth = await models.getAuth(model);
  } catch (err) {
    throw new ApiError(503, "LLM_AUTH_ERROR", `读取数据库凭据失败：${(err as Error).message}`);
  }
  if (!auth) {
    throw new ApiError(503, "LLM_NOT_CONFIGURED", `${config.provider.name} 的数据库凭据不可用`);
  }

  return {
    models,
    model,
    provider: config.provider.provider_key,
    providerName: config.provider.name,
    modelId: config.model.model_key,
  };
}
