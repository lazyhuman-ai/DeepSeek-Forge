const PREVIEW_PREFIX = "forgeagent.htmlPreview.";
const PREVIEW_TTL_MS = 10 * 60 * 1000;

export type StoredHtmlPreview = {
  html: string;
  title: string;
  createdAt: number;
  expiresAt: number;
};

export function storeHtmlPreview(html: string, title = "ForgeAgent HTML Preview"): string {
  cleanupExpiredHtmlPreviews();
  const id = crypto.randomUUID();
  const now = Date.now();
  const payload: StoredHtmlPreview = {
    html,
    title,
    createdAt: now,
    expiresAt: now + PREVIEW_TTL_MS,
  };
  localStorage.setItem(`${PREVIEW_PREFIX}${id}`, JSON.stringify(payload));
  return id;
}

export function readStoredHtmlPreview(id: string): StoredHtmlPreview | null {
  const raw = localStorage.getItem(`${PREVIEW_PREFIX}${id}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredHtmlPreview>;
    if (
      typeof parsed.html !== "string" ||
      typeof parsed.title !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt < Date.now()
    ) {
      localStorage.removeItem(`${PREVIEW_PREFIX}${id}`);
      return null;
    }
    return {
      html: parsed.html,
      title: parsed.title,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
      expiresAt: parsed.expiresAt,
    };
  } catch {
    localStorage.removeItem(`${PREVIEW_PREFIX}${id}`);
    return null;
  }
}

export function openHtmlPreviewDocument(html: string, title?: string): void {
  const id = storeHtmlPreview(html, title);
  const url = `/html-preview?id=${encodeURIComponent(id)}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

function cleanupExpiredHtmlPreviews(): void {
  const now = Date.now();
  for (let i = localStorage.length - 1; i >= 0; i -= 1) {
    const key = localStorage.key(i);
    if (!key?.startsWith(PREVIEW_PREFIX)) continue;
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? "{}") as Partial<StoredHtmlPreview>;
      if (typeof parsed.expiresAt !== "number" || parsed.expiresAt < now) {
        localStorage.removeItem(key);
      }
    } catch {
      localStorage.removeItem(key);
    }
  }
}
