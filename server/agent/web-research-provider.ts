// Web 研究供应商契约与首期 DeepSeek 原生搜索实现。只搜索并返回来源，不抓取任意 URL。

export const WEB_RESEARCH_ALLOWED_DOMAINS = [
  "bse.cn",
  "cninfo.com.cn",
  "csrc.gov.cn",
  "gov.cn",
  "ndrc.gov.cn",
  "pbc.gov.cn",
  "sse.com.cn",
  "stats.gov.cn",
  "szse.cn",
] as const;

export interface WebResearchResult {
  title: string;
  url: string;
  domain: string;
  publishedAt: string | null;
  fetchedAt: string;
  snippet: string;
}

export interface WebResearchProvider {
  search(input: {
    query: string;
    allowedDomains: string[];
    maxResults: number;
    recencyDays?: number;
  }, signal?: AbortSignal): Promise<WebResearchResult[]>;
}

export const WEB_RESEARCH_CONTRACT_LIMITS = Object.freeze({
  maxResults: 10,
  maxSnippetChars: 2000,
  maxTotalChars: 12000,
  allowedProtocols: ["http:", "https:"] as const,
});

interface DeepSeekWebResearchOptions {
  resolveApiKey: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface DeepSeekCitation {
  url?: unknown;
  cited_text?: unknown;
}

interface DeepSeekContentBlock {
  type?: unknown;
  citations?: unknown;
  content?: unknown;
}

const DEEPSEEK_SEARCH_ENDPOINT = "https://api.deepseek.com/anthropic/v1/messages";

function allowedDomain(url: string, domains: string[]): string | null {
  try {
    const parsed = new URL(url);
    if (!(WEB_RESEARCH_CONTRACT_LIMITS.allowedProtocols as readonly string[]).includes(parsed.protocol)) return null;
    const host = parsed.hostname.toLowerCase().replace(/\.$/u, "");
    return domains.find((domain) => host === domain || host.endsWith(`.${domain}`)) ?? null;
  } catch {
    return null;
  }
}

function citationSnippets(blocks: DeepSeekContentBlock[]): Map<string, string> {
  const snippets = new Map<string, string>();
  for (const block of blocks) {
    if (block.type !== "text" || !Array.isArray(block.citations)) continue;
    for (const citation of block.citations as DeepSeekCitation[]) {
      if (typeof citation.url === "string" && typeof citation.cited_text === "string" &&
          citation.url.length > 0 && citation.cited_text.length > 0 && !snippets.has(citation.url)) {
        snippets.set(citation.url, citation.cited_text);
      }
    }
  }
  return snippets;
}

/** DeepSeek 通过 Anthropic 兼容 Messages API 的原生 server-side web_search 执行搜索。 */
export function createDeepSeekWebResearchProvider(
  options: DeepSeekWebResearchOptions,
): WebResearchProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  return {
    async search(input, signal) {
      const apiKey = await options.resolveApiKey();
      if (!apiKey) {
        throw new Error("DeepSeek Web Search 不可用：请在设置页启用 DeepSeek 官方 api.deepseek.com 配置并填写 API Key");
      }
      if (signal?.aborted) throw signal.reason ?? new Error("Web Search 已中断");

      const cutoff = input.recencyDays === undefined
        ? null
        : new Date(now().getTime() - input.recencyDays * 86_400_000).toISOString().slice(0, 10);
      const scopedQuery = [
        `Perform a web search for the query: ${input.query}`,
        `Only return sources from these domains: ${input.allowedDomains.join(", ")}.`,
        cutoff ? `Prefer sources published on or after ${cutoff}; keep the publication date when available.` : "",
      ].filter(Boolean).join("\n");
      const timeoutSignal = AbortSignal.timeout(60_000);
      const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      const response = await fetchImpl(DEEPSEEK_SEARCH_ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal: requestSignal,
        headers: {
          "x-api-key": apiKey,
          authorization: `Bearer ${apiKey}`,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          max_tokens: 4096,
          messages: [{ role: "user", content: [{ type: "text", text: scopedQuery }] }],
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
        }),
      });
      if (!response.ok) throw new Error(`DeepSeek Web Search 请求失败（HTTP ${response.status}）`);

      const payload = await response.json() as { content?: unknown };
      if (!Array.isArray(payload.content)) throw new Error("DeepSeek Web Search 返回了无法识别的响应");
      const blocks = payload.content as DeepSeekContentBlock[];
      const snippets = citationSnippets(blocks);
      const fetchedAt = now().toISOString();
      const results: WebResearchResult[] = [];
      const seen = new Set<string>();
      let totalChars = 0;
      let sawSearchResultBlock = false;

      for (const block of blocks) {
        if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
        sawSearchResultBlock = true;
        for (const item of block.content as Array<Record<string, unknown>>) {
          if (item.type !== "web_search_result" || typeof item.url !== "string" || seen.has(item.url)) continue;
          const domain = allowedDomain(item.url, input.allowedDomains);
          if (!domain) continue;
          const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : domain;
          const snippet = (snippets.get(item.url) ?? "供应商未返回摘要")
            .slice(0, WEB_RESEARCH_CONTRACT_LIMITS.maxSnippetChars);
          const result: WebResearchResult = {
            title,
            url: item.url,
            domain,
            publishedAt: typeof item.page_age === "string" && item.page_age.trim() ? item.page_age : null,
            fetchedAt,
            snippet,
          };
          const chars = title.length + item.url.length + snippet.length;
          if (totalChars + chars > WEB_RESEARCH_CONTRACT_LIMITS.maxTotalChars) return results;
          seen.add(item.url);
          results.push(result);
          totalChars += chars;
          if (results.length >= input.maxResults) return results;
        }
      }
      if (!sawSearchResultBlock) throw new Error("DeepSeek 未执行原生 Web Search，请稍后重试");
      return results;
    },
  };
}
