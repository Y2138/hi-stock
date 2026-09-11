// 受控网页正文抓取：只读取公网 HTTP(S) 文本内容，并在每次跳转前重新校验地址。
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

export interface WebFetchResult {
  url: string;
  domain: string;
  status: number;
  contentType: string;
  fetchedAt: string;
  title: string | null;
  text: string;
  truncated: boolean;
}

export interface WebFetchProvider {
  fetch(input: { url: string; maxChars: number }, signal?: AbortSignal): Promise<WebFetchResult>;
}

export const WEB_FETCH_CONTRACT_LIMITS = Object.freeze({
  maxUrlChars: 2048,
  minTextChars: 1000,
  maxTextChars: 50_000,
  defaultTextChars: 20_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxRedirects: 3,
  timeoutMs: 30_000,
});

interface RawWebResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

interface SafeWebFetchOptions {
  lookupHost?: (hostname: string) => Promise<readonly LookupAddress[]>;
  requestImpl?: (url: URL, address: LookupAddress, signal: AbortSignal) => Promise<RawWebResponse>;
  now?: () => Date;
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal"];
const SENSITIVE_QUERY_NAMES = new Set([
  "token", "api_key", "api-key", "apikey", "key", "secret", "password",
  "access_token", "access-token", "authorization", "signature", "x-amz-signature",
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml"]);

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const values = parts.map((part) => Number(part));
  return values.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) ? values : null;
}

function isPublicIpv4(address: string): boolean {
  const parts = parseIpv4(address);
  if (!parts) return false;
  const [a = -1, b = -1, c = -1] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6Words(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  const [leftRaw = "", rightRaw = ""] = address.toLowerCase().split("::", 2);
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  if (!address.includes("::") && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  const words = groups.map((group) => Number.parseInt(group || "0", 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : null;
}

function isPublicIpv6(address: string): boolean {
  const words = ipv6Words(address);
  if (!words) return false;
  const [first = 0, second = 0, third = 0] = words;
  // 仅放行全球单播 2000::/3，并保守排除文档、基准与过渡地址段。
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2001 && second === 0x0000) return false; // Teredo
  if (first === 0x2001 && second === 0x0002 && third === 0x0000) return false; // benchmark
  if (first === 0x2001 && second >= 0x0010 && second <= 0x002f) return false; // ORCHID
  if (first === 0x2001 && second === 0x0db8) return false; // documentation
  if (first === 0x2002) return false; // 6to4
  return true;
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function validateUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Web Fetch URL 无效");
  }
  if (parsed.toString().length > WEB_FETCH_CONTRACT_LIMITS.maxUrlChars) throw new Error("Web Fetch URL 过长");
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Web Fetch 只允许 HTTP 或 HTTPS URL");
  if (parsed.username || parsed.password) throw new Error("Web Fetch URL 不得包含用户名或密码");
  if ((parsed.protocol === "http:" && parsed.port && parsed.port !== "80") ||
      (parsed.protocol === "https:" && parsed.port && parsed.port !== "443")) {
    throw new Error("Web Fetch 不允许非标准端口");
  }
  const hostname = normalizedHostname(parsed.hostname);
  if (!hostname || hostname === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new Error("Web Fetch 不允许本机或内部主机名");
  }
  for (const name of parsed.searchParams.keys()) {
    if (SENSITIVE_QUERY_NAMES.has(name.toLowerCase())) throw new Error("Web Fetch URL 不得包含敏感查询参数");
  }
  parsed.hash = "";
  return parsed;
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Web Fetch 已中断"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Web Fetch 已中断"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

async function resolvePublicAddress(
  url: URL,
  lookupHost: (hostname: string) => Promise<readonly LookupAddress[]>,
  signal: AbortSignal,
): Promise<LookupAddress> {
  const hostname = normalizedHostname(url.hostname);
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (!isPublicAddress(hostname)) throw new Error("Web Fetch 拒绝访问非公网地址");
    return { address: hostname, family: literalFamily };
  }
  let addresses: readonly LookupAddress[];
  try {
    addresses = await withAbort(lookupHost(hostname), signal);
  } catch {
    if (signal.aborted) throw signal.reason ?? new Error("Web Fetch 已中断");
    throw new Error("Web Fetch 域名解析失败");
  }
  if (!addresses.length) throw new Error("Web Fetch 域名没有可用地址");
  if (addresses.some((entry) => !isPublicAddress(entry.address))) throw new Error("Web Fetch 拒绝访问非公网地址");
  return [...addresses].sort((left, right) => left.family - right.family)[0]!;
}

function responseHeaders(headers: http.IncomingHttpHeaders): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name.toLowerCase(),
    Array.isArray(value) ? value[0] : value,
  ]));
}

function nativeRequest(url: URL, address: LookupAddress, signal: AbortSignal): Promise<RawWebResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const hostname = normalizedHostname(url.hostname);
    const request = transport.request({
      protocol: url.protocol,
      hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      signal,
      servername: isIP(hostname) === 0 ? hostname : undefined,
      lookup: (_requestedHostname, options, callback) => {
        if (options.all) {
          callback(null, [address]);
          return;
        }
        callback(null, address.address, address.family);
      },
      headers: {
        accept: "text/html,application/xhtml+xml,application/json,application/xml,text/plain;q=0.9,*/*;q=0.1",
        "accept-encoding": "identity",
        "user-agent": "hi-stock-web-fetch/1.0",
      },
    }, (response) => {
      const status = response.statusCode ?? 0;
      const headers = responseHeaders(response.headers);
      if (REDIRECT_STATUSES.has(status) || status < 200 || status >= 300) {
        response.resume();
        resolve({ status, headers, body: Buffer.alloc(0) });
        return;
      }
      const declaredLength = Number(headers["content-length"] ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > WEB_FETCH_CONTRACT_LIMITS.maxResponseBytes) {
        response.destroy(new Error("Web Fetch 响应超过大小限制"));
        return;
      }
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > WEB_FETCH_CONTRACT_LIMITS.maxResponseBytes) {
          response.destroy(new Error("Web Fetch 响应超过大小限制"));
          return;
        }
        chunks.push(buffer);
      });
      response.on("end", () => resolve({ status, headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

function supportedContentType(value: string | undefined): { mime: string; charset: string } {
  const [rawMime = "", ...parameters] = (value ?? "").split(";");
  const mime = rawMime.trim().toLowerCase();
  const isText = mime.startsWith("text/") || HTML_CONTENT_TYPES.has(mime) ||
    mime === "application/json" || mime.endsWith("+json") || mime === "application/xml" || mime.endsWith("+xml") ||
    mime === "application/javascript";
  if (!isText) throw new Error("Web Fetch 仅支持文本、HTML、JSON 和 XML 内容");
  const charsetParameter = parameters.find((item) => item.trim().toLowerCase().startsWith("charset="));
  const charset = charsetParameter?.split("=", 2)[1]?.trim().replace(/^['"]|['"]$/gu, "") || "utf-8";
  return { mime, charset };
}

function decodeBody(body: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(body);
  }
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"',
    ndash: "–", mdash: "—", hellip: "…", middot: "·",
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/giu, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\f\v ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function htmlText(source: string): { title: string | null; text: string } {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(source);
  const title = titleMatch ? normalizeText(decodeHtmlEntities(titleMatch[1]!.replace(/<[^>]+>/gu, " "))) || null : null;
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/iu.exec(source);
  const body = bodyMatch?.[1] ?? source;
  const stripped = body
    .replace(/<!--([\s\S]*?)-->/gu, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/giu, " ")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(address|article|aside|blockquote|div|footer|form|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tr|ul)>/giu, "\n")
    .replace(/<[^>]+>/gu, " ");
  return { title, text: normalizeText(decodeHtmlEntities(stripped)) };
}

function extractText(body: Buffer, mime: string, charset: string): { title: string | null; text: string } {
  const decoded = decodeBody(body, charset).replace(/^\uFEFF/u, "");
  if (HTML_CONTENT_TYPES.has(mime)) return htmlText(decoded);
  if (mime === "application/xml" || mime.endsWith("+xml")) return { title: null, text: htmlText(decoded).text };
  if (mime === "application/json" || mime.endsWith("+json")) {
    try {
      return { title: null, text: JSON.stringify(JSON.parse(decoded), null, 2) };
    } catch {
      return { title: null, text: normalizeText(decoded) };
    }
  }
  return { title: null, text: normalizeText(decoded) };
}

/** 创建生产默认的安全网页正文抓取 Provider；测试可注入 DNS 与响应，但无法绕过 URL/地址校验。 */
export function createSafeWebFetchProvider(options: SafeWebFetchOptions = {}): WebFetchProvider {
  const lookupHost = options.lookupHost ?? ((hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
  const requestImpl = options.requestImpl ?? nativeRequest;
  const now = options.now ?? (() => new Date());
  return {
    async fetch(input, signal) {
      let current = validateUrl(input.url);
      const timeoutSignal = AbortSignal.timeout(WEB_FETCH_CONTRACT_LIMITS.timeoutMs);
      const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

      for (let redirectCount = 0; redirectCount <= WEB_FETCH_CONTRACT_LIMITS.maxRedirects; redirectCount += 1) {
        if (requestSignal.aborted) throw requestSignal.reason ?? new Error("Web Fetch 已中断");
        const address = await resolvePublicAddress(current, lookupHost, requestSignal);
        const response = await requestImpl(current, address, requestSignal);
        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.location;
          if (!location) throw new Error("Web Fetch 收到缺少目标地址的重定向");
          if (redirectCount === WEB_FETCH_CONTRACT_LIMITS.maxRedirects) throw new Error("Web Fetch 重定向次数过多");
          let redirected: URL;
          try {
            redirected = new URL(location, current);
          } catch {
            throw new Error("Web Fetch 重定向目标无效");
          }
          current = validateUrl(redirected.toString());
          continue;
        }
        if (response.status < 200 || response.status >= 300) throw new Error(`Web Fetch 请求失败（HTTP ${response.status}）`);
        if (response.headers["content-encoding"] && response.headers["content-encoding"]?.toLowerCase() !== "identity") {
          throw new Error("Web Fetch 服务端返回了不支持的压缩内容");
        }
        if (response.body.length > WEB_FETCH_CONTRACT_LIMITS.maxResponseBytes) throw new Error("Web Fetch 响应超过大小限制");
        const { mime, charset } = supportedContentType(response.headers["content-type"]);
        const extracted = extractText(response.body, mime, charset);
        const truncated = extracted.text.length > input.maxChars;
        return {
          url: current.toString(),
          domain: normalizedHostname(current.hostname),
          status: response.status,
          contentType: mime,
          fetchedAt: now().toISOString(),
          title: extracted.title,
          text: truncated ? extracted.text.slice(0, input.maxChars) : extracted.text,
          truncated,
        };
      }
      throw new Error("Web Fetch 重定向次数过多");
    },
  };
}
