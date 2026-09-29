// 受控网页正文抓取：只读取公网 HTTP(S) 文本内容，并在每次跳转前重新校验地址。
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import zlib from "node:zlib";
import { isIP, type LookupFunction as NetLookupFunction } from "node:net";
import { X509Certificate } from "node:crypto";

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
  requestImpl?: (url: URL, address: LookupAddress, signal: AbortSignal, extraCa?: readonly string[]) => Promise<RawWebResponse>;
  now?: () => Date;
  /** 探测对端叶子证书（DER），默认用拒绝校验的临时 TLS 连接仅读取证书后立即断开。 */
  probePeerCertificate?: (url: URL, address: LookupAddress, signal: AbortSignal) => Promise<Buffer>;
  /** 按 AIA caIssuers URI 下载签发者证书（DER 或 PEM），默认走同一套 URL/地址校验的受限请求。 */
  fetchIssuerCertificate?: (uri: string, signal: AbortSignal) => Promise<Buffer | string>;
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

function pinnedLookup(address: LookupAddress): NetLookupFunction {
  return ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) {
      callback(null, [address]);
      return;
    }
    callback(null, address.address, address.family);
  }) as NetLookupFunction;
}

/** 透明解压服务端压缩响应；输出封顶防止压缩炸弹，未知编码保持显式失败。 */
export function decodeResponseBody(body: Buffer, encoding: string | undefined): Buffer {
  const normalized = (encoding ?? "").trim().toLowerCase();
  if (!normalized || normalized === "identity") return body;
  const limits = { maxOutputLength: WEB_FETCH_CONTRACT_LIMITS.maxResponseBytes };
  try {
    if (normalized === "gzip") return zlib.gunzipSync(body, limits);
    if (normalized === "br") return zlib.brotliDecompressSync(body, limits);
    if (normalized === "deflate") {
      try {
        return zlib.inflateSync(body, limits);
      } catch {
        return zlib.inflateRawSync(body, limits);
      }
    }
  } catch {
    throw new Error("Web Fetch 响应解压失败或解压结果超过大小限制");
  }
  throw new Error("Web Fetch 服务端返回了不支持的压缩内容");
}

function nativeRequest(
  url: URL,
  address: LookupAddress,
  signal: AbortSignal,
  extraCa?: readonly string[],
): Promise<RawWebResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const hostname = normalizedHostname(url.hostname);
    // 追加的签发者证书只能补全链，不能成为信任锚（OpenSSL 要求锚点自签且在库内）。
    const ca = extraCa?.length
      ? [...tls.rootCertificates.filter((entry): entry is string => typeof entry === "string"), ...extraCa]
      : undefined;
    const request = transport.request({
      protocol: url.protocol,
      hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      signal,
      servername: isIP(hostname) === 0 ? hostname : undefined,
      lookup: pinnedLookup(address),
      ...(ca ? { ca } : {}),
      headers: {
        accept: "text/html,application/xhtml+xml,application/json,application/xml,text/plain;q=0.9,*/*;q=0.1",
        "accept-encoding": "gzip, deflate, br",
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

/** 部分站点（如财联社 detail 页）不回 Content-Type；按正文首字节判定文本类型。 */
function sniffContentType(body: Buffer): { mime: string; charset: string } {
  let offset = 0;
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) offset = 3;
  while (offset < body.length && [0x20, 0x09, 0x0a, 0x0d].includes(body[offset]!)) offset += 1;
  const first = body[offset];
  if (first === 0x3c) return { mime: "text/html", charset: "utf-8" };
  if (first === 0x7b || first === 0x5b) return { mime: "application/json", charset: "utf-8" };
  return { mime: "text/plain", charset: "utf-8" };
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

// AIA caIssuers（1.3.6.1.5.5.7.48.2）+ uniformResourceIdentifier（[6] 0x86）的字节特征；
// 只做受控扫描，不引入完整 ASN.1 解析器。
const CA_ISSUERS_OID = Buffer.from([0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x02]);

/** 从叶子证书 DER 提取 AIA caIssuers URI；无法解析或非 HTTP(S) URI 时返回空。 */
export function extractCaIssuersUris(certificateDer: Buffer): string[] {
  const uris: string[] = [];
  let index = certificateDer.indexOf(CA_ISSUERS_OID);
  while (index !== -1) {
    let cursor = index + CA_ISSUERS_OID.length;
    if (cursor < certificateDer.length && certificateDer[cursor] === 0x86) {
      cursor += 1;
      if (cursor < certificateDer.length) {
        const length = certificateDer[cursor]!;
        cursor += 1;
        if (length < 0x80 && cursor + length <= certificateDer.length) {
          const uri = certificateDer.subarray(cursor, cursor + length).toString("latin1");
          if (/^https?:\/\//iu.test(uri) && !uris.includes(uri)) uris.push(uri);
        }
      }
    }
    index = certificateDer.indexOf(CA_ISSUERS_OID, index + 1);
  }
  return uris;
}

function parseCertificate(raw: Buffer | string): X509Certificate | null {
  try {
    return new X509Certificate(raw);
  } catch {
    if (Buffer.isBuffer(raw)) {
      try {
        return new X509Certificate(raw.toString("utf8"));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function probePeerCertificate(url: URL, address: LookupAddress, signal: AbortSignal): Promise<Buffer> {
  if (url.protocol !== "https:") throw new Error("仅 HTTPS 连接支持证书链补全");
  const hostname = normalizedHostname(url.hostname);
  return new Promise<Buffer>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Web Fetch 已中断"));
      return;
    }
    const socket = tls.connect({
      host: hostname,
      port: url.port ? Number(url.port) : 443,
      servername: isIP(hostname) === 0 ? hostname : undefined,
      rejectUnauthorized: false,
      lookup: pinnedLookup(address),
    }, () => {
      const raw = socket.getPeerCertificate().raw;
      cleanup();
      socket.destroy();
      if (Buffer.isBuffer(raw) && raw.length > 0) resolve(Buffer.from(raw));
      else reject(new Error("未能读取对端证书"));
    });
    const onAbort = () => socket.destroy(new Error(signal.reason instanceof Error ? signal.reason.message : "Web Fetch 已中断"));
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      socket.off("error", onError);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.on("error", onError);
  });
}

async function fetchIssuerCertificate(
  uri: string,
  lookupHost: (hostname: string) => Promise<readonly LookupAddress[]>,
  signal: AbortSignal,
): Promise<Buffer | string> {
  const url = validateUrl(uri);
  const address = await resolvePublicAddress(url, lookupHost, signal);
  const response = await nativeRequest(url, address, signal);
  if (response.status < 200 || response.status >= 300) throw new Error(`签发者证书下载失败（HTTP ${response.status}）`);
  return decodeResponseBody(response.body, response.headers["content-encoding"]);
}

// 补链结果按叶子证书指纹缓存；自签中间证书一律拒绝，确保追加证书无法成为信任锚。
const tlsChainCache = new Map<string, readonly string[]>();

async function completeIssuerChain(
  url: URL,
  address: LookupAddress,
  requestSignal: AbortSignal,
  deps: {
    lookupHost: (hostname: string) => Promise<readonly LookupAddress[]>;
    probe: (url: URL, address: LookupAddress, signal: AbortSignal) => Promise<Buffer>;
    fetchIssuer: (uri: string, signal: AbortSignal) => Promise<Buffer | string>;
  },
): Promise<readonly string[] | null> {
  let leaf: X509Certificate;
  let leafDer: Buffer;
  try {
    leafDer = await deps.probe(url, address, requestSignal);
    leaf = parseCertificate(leafDer) ?? (() => { throw new Error("对端证书无法解析"); })();
  } catch {
    return null;
  }
  const cached = tlsChainCache.get(leaf.fingerprint256);
  if (cached) return cached;
  for (const uri of extractCaIssuersUris(leafDer)) {
    try {
      const intermediate = parseCertificate(await deps.fetchIssuer(uri, requestSignal));
      if (!intermediate || !intermediate.ca) continue;
      if (intermediate.subject === intermediate.issuer) continue;
      if (intermediate.subject !== leaf.issuer) continue;
      if (!leaf.verify(intermediate.publicKey)) continue;
      const extraCa = [intermediate.toString()];
      tlsChainCache.set(leaf.fingerprint256, extraCa);
      return extraCa;
    } catch {
      continue;
    }
  }
  return null;
}

/** 创建生产默认的安全网页正文抓取 Provider；测试可注入 DNS 与响应，但无法绕过 URL/地址校验。 */
export function createSafeWebFetchProvider(options: SafeWebFetchOptions = {}): WebFetchProvider {
  const lookupHost = options.lookupHost ?? ((hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
  const requestImpl = options.requestImpl ?? nativeRequest;
  const now = options.now ?? (() => new Date());
  const probe = options.probePeerCertificate ?? probePeerCertificate;
  const fetchIssuer = options.fetchIssuerCertificate
    ?? ((uri: string, requestSignal: AbortSignal) => fetchIssuerCertificate(uri, lookupHost, requestSignal));
  return {
    async fetch(input, signal) {
      let current = validateUrl(input.url);
      const timeoutSignal = AbortSignal.timeout(WEB_FETCH_CONTRACT_LIMITS.timeoutMs);
      const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      // 服务端漏发中间证书时经 AIA 补链一次；补链证书只用于本次及后续跳转。
      let extraCa: readonly string[] | null = null;

      for (let redirectCount = 0; redirectCount <= WEB_FETCH_CONTRACT_LIMITS.maxRedirects; redirectCount += 1) {
        if (requestSignal.aborted) throw requestSignal.reason ?? new Error("Web Fetch 已中断");
        const address = await resolvePublicAddress(current, lookupHost, requestSignal);
        let response: RawWebResponse;
        try {
          response = await requestImpl(current, address, requestSignal, extraCa ?? undefined);
        } catch (error) {
          if ((error as NodeJS.ErrnoException | undefined)?.code !== "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || extraCa) throw error;
          extraCa = await completeIssuerChain(current, address, requestSignal, { lookupHost, probe, fetchIssuer });
          if (!extraCa) throw error;
          response = await requestImpl(current, address, requestSignal, extraCa);
        }
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
        const body = decodeResponseBody(response.body, response.headers["content-encoding"]);
        if (body.length > WEB_FETCH_CONTRACT_LIMITS.maxResponseBytes) throw new Error("Web Fetch 响应超过大小限制");
        const contentTypeHeader = response.headers["content-type"];
        const { mime, charset } = contentTypeHeader?.trim()
          ? supportedContentType(contentTypeHeader)
          : sniffContentType(body);
        const extracted = extractText(body, mime, charset);
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
