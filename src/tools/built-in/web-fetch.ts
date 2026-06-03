import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";

const FETCH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 10;
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024;
const MAX_OUTPUT_LENGTH = 100_000;
const CACHE_TTL_MS = 15 * 60 * 1000;

const urlCache = new Map<string, { content: string; timestamp: number }>();

const FORGEAGENT_USER_AGENT = "ForgeAgent/1.0";

async function handler(
  args: Record<string, unknown>,
  _sessionId: string,
  context?: { signal?: AbortSignal },
): Promise<unknown> {
  let url = (args.url as string).trim();
  const prompt = (args.prompt as string) ?? "Extract the main content from this page.";

  if (context?.signal?.aborted) {
    return "Request aborted.";
  }

  if (url.startsWith("http://")) {
    url = url.replace("http://", "https://");
  }

  if (!url.startsWith("https://")) {
    return `Invalid URL: ${url}. URL must start with https:// (or http:// which gets upgraded).`;
  }

  // Check cache
  const cached = urlCache.get(url);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    const truncated = cached.content.length > MAX_OUTPUT_LENGTH
      ? cached.content.slice(0, MAX_OUTPUT_LENGTH) + "\n[Content truncated]"
      : cached.content;
    return `[Cached result from ${new Date(cached.timestamp).toISOString()}]\n\n${truncated}`;
  }

  try {
    let currentUrl = url;
    let redirects = 0;

    while (redirects <= MAX_REDIRECTS) {
      const controller = new AbortController();
      const abortFromSignal = (): void => controller.abort();
      context?.signal?.addEventListener("abort", abortFromSignal, { once: true });
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const response = await fetch(currentUrl, {
          method: "GET",
          headers: {
            "User-Agent": FORGEAGENT_USER_AGENT,
            Accept: "text/html, text/plain, text/markdown, application/json, */*",
          },
          signal: controller.signal,
          redirect: "manual",
        });
        clearTimeout(timeout);

        // Handle redirects
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location) return "Redirect response with no Location header.";
          const redirectUrl = new URL(location, currentUrl).toString();
          if (!redirectUrl.startsWith("https://") && !redirectUrl.startsWith("http://")) {
            return "Redirect to non-HTTP URL blocked.";
          }
          currentUrl = redirectUrl.replace(/^http:/, "https:");
          redirects++;
          continue;
        }

        if (!response.ok) {
          return `HTTP ${response.status}: ${response.statusText}`;
        }

        const contentType = response.headers.get("content-type") ?? "";
        const contentLength = parseInt(response.headers.get("content-length") ?? "0", 10);

        if (contentLength > MAX_CONTENT_LENGTH) {
          return `Content too large (${contentLength} bytes). Maximum is ${MAX_CONTENT_LENGTH} bytes.`;
        }

        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_CONTENT_LENGTH) {
          return `Content too large (${buffer.byteLength} bytes). Maximum is ${MAX_CONTENT_LENGTH} bytes.`;
        }

        let text: string;
        if (contentType.includes("text/html")) {
          const html = new TextDecoder().decode(buffer);
          text = stripHtml(html);
        } else if (
          contentType.includes("application/json") ||
          contentType.includes("text/plain") ||
          contentType.includes("text/markdown")
        ) {
          text = new TextDecoder().decode(buffer);
        } else {
          return `Unsupported content type: ${contentType}. Only HTML, JSON, plain text, and Markdown are supported.`;
        }

        // Cache the result
        urlCache.set(url, { content: text, timestamp: Date.now() });

        // Clean up old cache entries
        if (urlCache.size > 128) {
          const now = Date.now();
          for (const [key, value] of urlCache) {
            if (now - value.timestamp > CACHE_TTL_MS * 2) {
              urlCache.delete(key);
            }
          }
        }

        const truncated = text.length > MAX_OUTPUT_LENGTH
          ? text.slice(0, MAX_OUTPUT_LENGTH) + "\n[Content truncated]"
          : text;

        return `[Fetched from ${url}]\n\n${truncated}`;
      } finally {
        clearTimeout(timeout);
        context?.signal?.removeEventListener("abort", abortFromSignal);
      }
    }

    return `Too many redirects (${MAX_REDIRECTS}).`;
  } catch (error: unknown) {
    const err = error as Error;
    if (err.name === "AbortError") {
      if (context?.signal?.aborted) {
        return "Request aborted.";
      }
      return "Request timed out.";
    }
    return `Failed to fetch URL: ${err.message}`;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n\s*\n\s*\n/g, "\n\n")
    .trim();
}

export const webFetchTool: ExecutableToolDefinition = buildTool({
  name: "web_fetch",
  description: `Fetches content from a specified URL and processes it.

Usage:
- IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead.
- The URL must be a fully-formed valid URL.
- HTTP URLs will be automatically upgraded to HTTPS.
- Results may be summarized if the content is very large.
- Includes a self-cleaning ${CACHE_TTL_MS / 60_000}-minute cache for faster responses when repeatedly accessing the same URL.
- When a URL redirects to a different host, the tool will follow the redirect up to ${MAX_REDIRECTS} times.
- HTML content is automatically stripped to plain text.`,
  params: {
    url: {
      type: "string",
      description: "The URL to fetch content from",
    },
    prompt: {
      type: "string",
      description: "The type of information to extract from the page",
      optional: true,
    },
  },
  handler,
  isConcurrencySafe: true,
  isReadOnly: true,
  capabilities: ["network.http"],
});
