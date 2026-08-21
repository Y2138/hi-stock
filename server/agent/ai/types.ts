import type { Api } from "@earendil-works/pi-ai";

export const LLM_API_PROTOCOLS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const satisfies readonly Api[];

export type LlmApiProtocol = (typeof LLM_API_PROTOCOLS)[number];
export type LlmInputModality = "text" | "image";

export interface LlmModelRow {
  id: string;
  provider_id: string;
  model_key: string;
  name: string;
  input_modalities: LlmInputModality[];
  reasoning: boolean;
  context_window: number;
  max_tokens: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface LlmProviderRow {
  id: string;
  provider_key: string;
  name: string;
  api_protocol: LlmApiProtocol;
  base_url: string;
  api_key_configured: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  models: LlmModelRow[];
}

export interface ActiveLlmConfig {
  provider: Omit<LlmProviderRow, "models" | "api_key_configured"> & {
    api_key_configured: boolean;
  };
  model: LlmModelRow;
}

