export type HtmlDocumentCandidate = {
  html: string;
  sourceStart: number;
  sourceEnd: number;
  kind: "document" | "fragment";
};

const HTML_FENCE_PATTERN = /```(?:html|HTML)\s*\n([\s\S]*?)```/g;
const ROOT_FRAGMENT_TAGS = [
  "main",
  "section",
  "article",
  "div",
  "header",
  "footer",
  "table",
  "svg",
  "canvas",
].join("|");

function looksLikeHtmlDocument(value: string): boolean {
  return /<!doctype\s+html/i.test(value) || /<html[\s>]/i.test(value);
}

function looksLikeRenderableHtmlFragment(value: string): boolean {
  const blockMatches = value.match(/<\/?(body|main|section|article|div|header|footer|h[1-6]|p|ul|ol|li|table|thead|tbody|tr|td|th|svg|canvas)\b/gi) ?? [];
  if (blockMatches.length === 0) return false;
  return /<style[\s>]/i.test(value) ||
    /\sstyle\s*=/i.test(value) ||
    /\sclass\s*=/i.test(value) ||
    blockMatches.length >= 4;
}

function findDocumentRange(text: string): { start: number; end: number } | null {
  const doctype = text.search(/<!doctype\s+html/i);
  const html = text.search(/<html[\s>]/i);
  const candidates = [doctype, html].filter((index) => index >= 0);
  if (candidates.length === 0) return null;

  const start = Math.min(...candidates);
  const closeMatch = /<\/html\s*>/i.exec(text.slice(start));
  const end = closeMatch ? start + closeMatch.index + closeMatch[0].length : text.length;
  return { start, end };
}

function findMatchingElementEnd(text: string, start: number, tag: string): number | null {
  const pattern = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  pattern.lastIndex = start;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const token = match[0];
    if (/^<\//.test(token)) {
      depth -= 1;
      if (depth <= 0) return match.index + token.length;
    } else if (!/\/>$/.test(token)) {
      depth += 1;
    }
  }
  return null;
}

function findFragmentRange(text: string): { start: number; end: number } | null {
  const openPattern = new RegExp(`<(${ROOT_FRAGMENT_TAGS})\\b[^>]*>`, "i");
  const match = openPattern.exec(text);
  if (!match || match.index === undefined) return null;

  const tag = match[1]?.toLowerCase();
  if (!tag) return null;
  const end = findMatchingElementEnd(text, match.index, tag);
  if (!end) return null;

  const html = text.slice(match.index, end).trim();
  if (!looksLikeRenderableHtmlFragment(html)) return null;
  return { start: match.index, end };
}

export function extractRenderableHtml(text: string): HtmlDocumentCandidate | null {
  const directDocument = findDocumentRange(text);
  if (directDocument) {
    const html = text.slice(directDocument.start, directDocument.end).trim();
    if (html) {
      return {
        html,
        sourceStart: directDocument.start,
        sourceEnd: directDocument.end,
        kind: "document",
      };
    }
  }

  HTML_FENCE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(HTML_FENCE_PATTERN)) {
    const html = match[1]?.trim() ?? "";
    if (!html) continue;
    if (looksLikeHtmlDocument(html) || looksLikeRenderableHtmlFragment(html)) {
      return {
        html,
        sourceStart: match.index ?? 0,
        sourceEnd: (match.index ?? 0) + match[0].length,
        kind: looksLikeHtmlDocument(html) ? "document" : "fragment",
      };
    }
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("<") && looksLikeRenderableHtmlFragment(trimmed)) {
    const start = text.indexOf(trimmed);
    return {
      html: trimmed,
      sourceStart: start,
      sourceEnd: start + trimmed.length,
      kind: "fragment",
    };
  }

  const fragmentRange = findFragmentRange(text);
  if (fragmentRange) {
    return {
      html: text.slice(fragmentRange.start, fragmentRange.end).trim(),
      sourceStart: fragmentRange.start,
      sourceEnd: fragmentRange.end,
      kind: "fragment",
    };
  }

  return null;
}

export function toPreviewDocument(html: string): string {
  const trimmed = html.trim();
  if (looksLikeHtmlDocument(trimmed)) return trimmed;

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "</head>",
    "<body>",
    trimmed,
    "</body>",
    "</html>",
  ].join("\n");
}
