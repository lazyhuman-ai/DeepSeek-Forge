import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join as pathJoin, relative, resolve as pathResolve } from "node:path";
import { randomUUID } from "node:crypto";

export type MemoryKind = "fact" | "episode" | "procedure";

export type MemoryType =
  | "instruction"
  | "profile"
  | "project"
  | "procedure"
  | "episode";

export type MemoryStatus = "active" | "stale" | "archived" | "rejected";

export type MemorySourceRef = {
  sessionId?: string | undefined;
  seq?: number | undefined;
  note?: string | undefined;
  path?: string | undefined;
};

export type MemoryEntry = {
  id: string;
  type: MemoryType;
  /** Compatibility field for the old JSON memory API. */
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  status: MemoryStatus;
  sources: MemorySourceRef[];
  createdAt: string;
  updatedAt: string;
  path: string;
  /** Compatibility field for the old session-scoped memory API. */
  sessionId?: string | undefined;
};

export type MemoryStoreInput = {
  type?: MemoryType | undefined;
  kind?: MemoryKind | undefined;
  title?: string | undefined;
  content: string;
  tags?: string[] | undefined;
  status?: MemoryStatus | undefined;
  sources?: MemorySourceRef[] | undefined;
  sessionId?: string | undefined;
};

export type MemoryProposalStatus = "pending" | "accepted" | "rejected";

export type MemoryProposal = {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  tags: string[];
  sources: MemorySourceRef[];
  reason: string;
  status: MemoryProposalStatus;
  createdAt: string;
  updatedAt: string;
};

export type MemorySearchResult = {
  entry: MemoryEntry;
  score: number;
  snippet: string;
  source: string;
};

type MemoryState = {
  legacyJsonMigrated: boolean;
  updatedAt: string;
};

const MEMORY_TYPES: MemoryType[] = ["instruction", "profile", "project", "procedure", "episode"];
const DEFAULT_MANIFEST_LIMIT = 12_000;
const DEFAULT_READ_LIMIT = 50_000;

function now(): string {
  return new Date().toISOString();
}

function typeToKind(type: MemoryType): MemoryKind {
  if (type === "episode") return "episode";
  if (type === "procedure") return "procedure";
  return "fact";
}

function kindToType(kind: MemoryKind | undefined): MemoryType {
  if (kind === "episode") return "episode";
  if (kind === "procedure") return "procedure";
  return "project";
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(
    tags
      .filter((tag): tag is string => typeof tag === "string")
      .map((tag) => tag.trim().toLowerCase())
      .filter((tag) => tag.length > 0),
  )];
}

function titleFromContent(content: string): string {
  const first = content.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!first) return "Untitled memory";
  return first.length <= 80 ? first : `${first.slice(0, 77)}...`;
}

function safeSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "memory";
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value);
}

function renderYamlArray(values: string[]): string {
  if (values.length === 0) return "[]";
  return `[${values.map(quoteYamlString).join(", ")}]`;
}

function parseYamlArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "[]") return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === "string")
        : [];
    } catch {
      return [];
    }
  }
  return trimmed.split(",").map((v) => v.trim()).filter(Boolean);
}

function parseYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseSources(value: string): MemorySourceRef[] {
  if (!value.trim() || value.trim() === "[]") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is MemorySourceRef => (
      typeof item === "object" && item !== null
    ));
  } catch {
    return [];
  }
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } | null {
  if (!raw.startsWith("---\n")) return null;
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const metaRaw = raw.slice(4, end);
  const body = raw.slice(end + "\n---\n".length);
  const meta: Record<string, string> = {};
  for (const line of metaRaw.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  }
  return { meta, body };
}

function renderMemoryMarkdown(entry: MemoryEntry): string {
  return [
    "---",
    `id: ${quoteYamlString(entry.id)}`,
    `type: ${quoteYamlString(entry.type)}`,
    `kind: ${quoteYamlString(entry.kind)}`,
    `title: ${quoteYamlString(entry.title)}`,
    `tags: ${renderYamlArray(entry.tags)}`,
    `status: ${quoteYamlString(entry.status)}`,
    `createdAt: ${quoteYamlString(entry.createdAt)}`,
    `updatedAt: ${quoteYamlString(entry.updatedAt)}`,
    `sessionId: ${quoteYamlString(entry.sessionId ?? "")}`,
    `sources: ${JSON.stringify(entry.sources)}`,
    "---",
    "",
    entry.content.trim(),
    "",
  ].join("\n");
}

function readMemoryMarkdown(absPath: string): MemoryEntry | null {
  const parsed = parseFrontmatter(readFileSync(absPath, "utf-8"));
  if (!parsed) return null;
  const meta = parsed.meta;
  const type = parseYamlScalar(meta.type ?? "project") as MemoryType;
  if (!MEMORY_TYPES.includes(type)) return null;
  const status = parseYamlScalar(meta.status ?? "active") as MemoryStatus;
  const id = parseYamlScalar(meta.id ?? basename(absPath, ".md"));
  const kind = parseYamlScalar(meta.kind ?? typeToKind(type)) as MemoryKind;
  const sessionId = parseYamlScalar(meta.sessionId ?? "");
  return {
    id,
    type,
    kind,
    title: parseYamlScalar(meta.title ?? titleFromContent(parsed.body)),
    content: parsed.body.trim(),
    tags: parseYamlArray(meta.tags ?? "[]"),
    status: status === "stale" || status === "archived" || status === "rejected" ? status : "active",
    sources: parseSources(meta.sources ?? "[]"),
    createdAt: parseYamlScalar(meta.createdAt ?? now()),
    updatedAt: parseYamlScalar(meta.updatedAt ?? now()),
    path: absPath,
    sessionId: sessionId || undefined,
  };
}

function atomicWrite(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, filePath);
}

function containsPromptInjection(content: string): boolean {
  const lower = content.toLowerCase();
  return [
    "ignore previous instructions",
    "ignore all previous instructions",
    "developer message",
    "system prompt",
    "reveal secrets",
    "exfiltrate",
    "bypass safety",
  ].some((pattern) => lower.includes(pattern));
}

export function redactSecrets(content: string): string {
  return content
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED]")
    .replace(/\b([A-Z0-9_]*(?:API|TOKEN|SECRET|KEY)[A-Z0-9_]*\s*=\s*)[^\s]+/gi, "$1[REDACTED]");
}

export function validateMemoryContent(content: string): string | null {
  if (!content.trim()) return "Memory content cannot be empty.";
  if (containsPromptInjection(content)) {
    return "Memory content appears to contain prompt-injection or secret-exfiltration instructions.";
  }
  return null;
}

export class MemoryStore {
  #baseDir: string;
  #manifestPath: string;
  #statePath: string;
  #indexPath: string;
  #lock: Promise<void> = Promise.resolve();

  constructor(baseDir = ".forge/memory") {
    this.#baseDir = pathResolve(baseDir);
    this.#manifestPath = pathJoin(this.#baseDir, "MEMORY.md");
    this.#statePath = pathJoin(this.#baseDir, "state.json");
    this.#indexPath = pathJoin(this.#baseDir, "index.json");
    this.#ensureLayout();
    this.#migrateLegacyJsonOnce();
    this.rebuildIndex();
  }

  get baseDir(): string {
    return this.#baseDir;
  }

  store(entry: MemoryStoreInput): MemoryEntry {
    const validation = validateMemoryContent(entry.content);
    if (validation) throw new Error(validation);

    const type = entry.type ?? kindToType(entry.kind);
    const id = randomUUID();
    const timestamp = now();
    const sessionSource = entry.sessionId ? [{ sessionId: entry.sessionId, note: "memory_add" }] : [];
    const full: MemoryEntry = {
      id,
      type,
      kind: entry.kind ?? typeToKind(type),
      title: entry.title?.trim() || titleFromContent(entry.content),
      content: redactSecrets(entry.content).trim(),
      tags: normalizeTags(entry.tags),
      status: entry.status ?? "active",
      sources: entry.sources ?? sessionSource,
      createdAt: timestamp,
      updatedAt: timestamp,
      path: "",
      sessionId: entry.sessionId,
    };
    full.path = this.#entryPath(full);
    atomicWrite(full.path, renderMemoryMarkdown(full));
    this.rebuildIndex();
    return full;
  }

  update(
    id: string,
    patch: Partial<Pick<MemoryEntry, "title" | "content" | "tags" | "status" | "sources" | "type">>,
  ): MemoryEntry | null {
    const existing = this.get(id);
    if (!existing) return null;
    const content = patch.content !== undefined ? redactSecrets(patch.content).trim() : existing.content;
    const validation = validateMemoryContent(content);
    if (validation) throw new Error(validation);
    const updated: MemoryEntry = {
      ...existing,
      ...patch,
      content,
      title: patch.title?.trim() || existing.title,
      tags: patch.tags ? normalizeTags(patch.tags) : existing.tags,
      type: patch.type ?? existing.type,
      kind: patch.type ? typeToKind(patch.type) : existing.kind,
      updatedAt: now(),
    };
    const nextPath = this.#entryPath(updated);
    if (nextPath !== existing.path && existsSync(existing.path)) {
      rmSync(existing.path);
    }
    updated.path = nextPath;
    atomicWrite(updated.path, renderMemoryMarkdown(updated));
    this.rebuildIndex();
    return updated;
  }

  get(id: string): MemoryEntry | null {
    return this.all().find((entry) => entry.id === id) ?? null;
  }

  getByPath(path: string): MemoryEntry | null {
    const abs = this.resolveMemoryPath(path);
    if (!abs || !existsSync(abs) || !abs.endsWith(".md")) return null;
    return readMemoryMarkdown(abs);
  }

  delete(id: string): boolean {
    const entry = this.get(id);
    if (!entry) return false;
    rmSync(entry.path);
    this.rebuildIndex();
    return true;
  }

  archive(id: string): MemoryEntry | null {
    const entry = this.update(id, { status: "archived" });
    if (!entry) return null;
    const archivePath = pathJoin(this.#baseDir, "archive", `${entry.id}.md`);
    atomicWrite(archivePath, renderMemoryMarkdown({ ...entry, path: archivePath }));
    if (existsSync(entry.path)) rmSync(entry.path);
    this.rebuildIndex();
    return { ...entry, path: archivePath };
  }

  search(query: string, options?: { types?: MemoryType[] | undefined; limit?: number | undefined }): MemoryEntry[] {
    return this.searchDetailed(query, options).map((result) => result.entry);
  }

  searchDetailed(query: string, options?: { types?: MemoryType[] | undefined; limit?: number | undefined }): MemorySearchResult[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const typeSet = options?.types ? new Set(options.types) : null;
    const limit = options?.limit ?? 20;
    return this.all()
      .filter((entry) => entry.status === "active" || entry.status === "stale")
      .filter((entry) => !typeSet || typeSet.has(entry.type))
      .map((entry) => ({
        entry,
        score: this.#score(entry, terms),
        snippet: this.#snippet(entry, terms),
        source: this.relativePath(entry.path),
      }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
      .slice(0, limit);
  }

  listByKind(kind: MemoryKind): MemoryEntry[] {
    return this.all().filter((entry) => entry.kind === kind);
  }

  listByType(type: MemoryType): MemoryEntry[] {
    return this.all().filter((entry) => entry.type === type);
  }

  listBySession(sessionId: string): MemoryEntry[] {
    return this.all().filter((entry) =>
      entry.sessionId === sessionId ||
      entry.sources.some((source) => source.sessionId === sessionId)
    );
  }

  listByTag(tag: string): MemoryEntry[] {
    const lower = tag.toLowerCase();
    return this.all().filter((entry) => entry.tags.some((t) => t === lower));
  }

  all(): MemoryEntry[] {
    return this.#readEntriesFrom(pathJoin(this.#baseDir, "topics"))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  listInstructionMemories(): MemoryEntry[] {
    return this.all().filter((entry) => entry.type === "instruction" && entry.status === "active");
  }

  readManifest(maxChars = DEFAULT_MANIFEST_LIMIT): string {
    if (!existsSync(this.#manifestPath)) return "";
    const raw = readFileSync(this.#manifestPath, "utf-8").trim();
    if (raw.length <= maxChars) return raw;
    return `${raw.slice(0, maxChars)}\n\n[Memory manifest truncated. Use memory_search for details.]`;
  }

  writeProposal(input: Omit<MemoryProposal, "id" | "status" | "createdAt" | "updatedAt">): MemoryProposal {
    const validation = validateMemoryContent(input.content);
    if (validation) {
      const rejected = this.#proposalFrom(input, "rejected");
      atomicWrite(this.#proposalPath(rejected.id), JSON.stringify(rejected, null, 2));
      return rejected;
    }
    const proposal = this.#proposalFrom({
      ...input,
      content: redactSecrets(input.content).trim(),
      tags: normalizeTags(input.tags),
    }, "pending");
    atomicWrite(this.#proposalPath(proposal.id), JSON.stringify(proposal, null, 2));
    return proposal;
  }

  listProposals(status?: MemoryProposalStatus): MemoryProposal[] {
    const dir = pathJoin(this.#baseDir, "proposals");
    if (!existsSync(dir)) return [];
    const proposals: MemoryProposal[] = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const proposal = JSON.parse(readFileSync(pathJoin(dir, entry), "utf-8")) as MemoryProposal;
        if (!status || proposal.status === status) proposals.push(proposal);
      } catch {
        // Ignore malformed proposal files; the manager will report model/runtime failures separately.
      }
    }
    return proposals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  markProposal(id: string, status: MemoryProposalStatus): MemoryProposal | null {
    const proposal = this.listProposals().find((p) => p.id === id);
    if (!proposal) return null;
    const updated: MemoryProposal = { ...proposal, status, updatedAt: now() };
    atomicWrite(this.#proposalPath(id), JSON.stringify(updated, null, 2));
    return updated;
  }

  rebuildIndex(): void {
    const entries = this.all();
    atomicWrite(this.#manifestPath, this.#renderManifest(entries));
    atomicWrite(this.#indexPath, JSON.stringify({
      version: 1,
      updatedAt: now(),
      entries: entries.map((entry) => ({
        id: entry.id,
        type: entry.type,
        title: entry.title,
        tags: entry.tags,
        status: entry.status,
        updatedAt: entry.updatedAt,
        path: this.relativePath(entry.path),
      })),
    }, null, 2));
  }

  read(idOrPath: { id?: string | undefined; path?: string | undefined }, options?: { offset?: number | undefined; limit?: number | undefined }): string | null {
    const entry = idOrPath.id ? this.get(idOrPath.id) : idOrPath.path ? this.getByPath(idOrPath.path) : null;
    if (!entry) return null;
    const offset = Math.max(0, Math.floor(options?.offset ?? 0));
    const limit = Math.max(1, Math.floor(options?.limit ?? DEFAULT_READ_LIMIT));
    const rendered = [
      `[Memory ${entry.id} ${entry.type}: ${entry.title}]`,
      `Source: ${this.relativePath(entry.path)}`,
      `Updated: ${entry.updatedAt}`,
      "",
      entry.content,
    ].join("\n");
    const chunk = rendered.slice(offset, offset + limit);
    const end = offset + chunk.length;
    return end < rendered.length
      ? `${chunk}\n\n[Memory truncated: showing chars ${offset}-${end} of ${rendered.length}. Call memory_get with offset=${end} to continue.]`
      : chunk;
  }

  resolveMemoryPath(path: string): string | null {
    const abs = pathResolve(this.#baseDir, path);
    const rel = relative(this.#baseDir, abs);
    if (rel.startsWith("..") || rel === "" || pathResolve(abs) === this.#baseDir) return null;
    return abs;
  }

  relativePath(path: string): string {
    return relative(this.#baseDir, path).replaceAll("\\", "/");
  }

  async withWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = this.#lock;
    let release!: () => void;
    this.#lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  #ensureLayout(): void {
    mkdirSync(this.#baseDir, { recursive: true });
    mkdirSync(pathJoin(this.#baseDir, "topics"), { recursive: true });
    for (const type of MEMORY_TYPES) mkdirSync(pathJoin(this.#baseDir, "topics", type), { recursive: true });
    mkdirSync(pathJoin(this.#baseDir, "proposals"), { recursive: true });
    mkdirSync(pathJoin(this.#baseDir, "archive"), { recursive: true });
    if (!existsSync(this.#statePath)) {
      this.#writeState({ legacyJsonMigrated: false, updatedAt: now() });
    }
  }

  #readState(): MemoryState {
    try {
      return JSON.parse(readFileSync(this.#statePath, "utf-8")) as MemoryState;
    } catch {
      return { legacyJsonMigrated: false, updatedAt: now() };
    }
  }

  #writeState(state: MemoryState): void {
    atomicWrite(this.#statePath, JSON.stringify(state, null, 2));
  }

  #migrateLegacyJsonOnce(): void {
    const state = this.#readState();
    if (state.legacyJsonMigrated) return;
    for (const entry of readdirSync(this.#baseDir)) {
      if (!entry.endsWith(".json")) continue;
      if (entry === "state.json" || entry === "index.json") continue;
      const filePath = pathJoin(this.#baseDir, entry);
      try {
        const legacy = JSON.parse(readFileSync(filePath, "utf-8")) as {
          id?: string;
          sessionId?: string;
          kind?: MemoryKind;
          content?: string;
          tags?: string[];
          createdAt?: string;
        };
        if (!legacy.content) continue;
        const type = kindToType(legacy.kind);
        const timestamp = legacy.createdAt ?? now();
        const migrated: MemoryEntry = {
          id: legacy.id ?? randomUUID(),
          type,
          kind: legacy.kind ?? typeToKind(type),
          title: titleFromContent(legacy.content),
          content: redactSecrets(legacy.content),
          tags: normalizeTags(legacy.tags),
          status: "active",
          sources: legacy.sessionId ? [{ sessionId: legacy.sessionId, note: "legacy_json_migration" }] : [],
          createdAt: timestamp,
          updatedAt: timestamp,
          path: "",
          sessionId: legacy.sessionId,
        };
        migrated.path = this.#entryPath(migrated);
        if (!existsSync(migrated.path)) {
          atomicWrite(migrated.path, renderMemoryMarkdown(migrated));
        }
      } catch {
        // Leave malformed legacy JSON in place.
      }
    }
    this.#writeState({ legacyJsonMigrated: true, updatedAt: now() });
  }

  #entryPath(entry: Pick<MemoryEntry, "id" | "type" | "title">): string {
    return pathJoin(this.#baseDir, "topics", entry.type, `${entry.id}-${safeSlug(entry.title)}.md`);
  }

  #proposalPath(id: string): string {
    return pathJoin(this.#baseDir, "proposals", `${id}.json`);
  }

  #proposalFrom(
    input: Omit<MemoryProposal, "id" | "status" | "createdAt" | "updatedAt">,
    status: MemoryProposalStatus,
  ): MemoryProposal {
    const timestamp = now();
    return {
      ...input,
      id: randomUUID(),
      type: input.type,
      title: input.title.trim() || titleFromContent(input.content),
      tags: normalizeTags(input.tags),
      status,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  #readEntriesFrom(dir: string): MemoryEntry[] {
    if (!existsSync(dir)) return [];
    const entries: MemoryEntry[] = [];
    for (const item of readdirSync(dir)) {
      const abs = pathJoin(dir, item);
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        entries.push(...this.#readEntriesFrom(abs));
      } else if (item.endsWith(".md") && item !== "MEMORY.md") {
        const parsed = readMemoryMarkdown(abs);
        if (parsed) entries.push(parsed);
      }
    }
    return entries;
  }

  #score(entry: MemoryEntry, terms: string[]): number {
    const title = entry.title.toLowerCase();
    const content = entry.content.toLowerCase();
    const tags = entry.tags.join(" ").toLowerCase();
    let score = 0;
    let matched = false;
    for (const term of terms) {
      if (title.includes(term)) {
        score += 12;
        matched = true;
      }
      if (tags.includes(term)) {
        score += 8;
        matched = true;
      }
      if (content.includes(term)) {
        score += 3;
        matched = true;
      }
      if (entry.type.includes(term)) {
        score += 2;
        matched = true;
      }
    }
    if (!matched) return 0;
    if (entry.status === "stale") score -= 2;
    const ageMs = Date.now() - Date.parse(entry.updatedAt);
    if (Number.isFinite(ageMs)) {
      score += Math.max(0, 3 - ageMs / (1000 * 60 * 60 * 24 * 30));
    }
    return score;
  }

  #snippet(entry: MemoryEntry, terms: string[]): string {
    const content = entry.content.replace(/\s+/g, " ").trim();
    const lower = content.toLowerCase();
    const idx = terms
      .map((term) => lower.indexOf(term))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
    const start = Math.max(0, idx - 80);
    const snippet = content.slice(start, start + 240);
    return `${start > 0 ? "..." : ""}${snippet}${start + 240 < content.length ? "..." : ""}`;
  }

  #renderManifest(entries: MemoryEntry[]): string {
    const active = entries.filter((entry) => entry.status === "active" || entry.status === "stale");
    const lines = [
      "# ForgeAgent Memory",
      "",
      "This is a searchable registry. Use memory_search and memory_get for details.",
      "",
    ];
    for (const type of MEMORY_TYPES) {
      const typed = active.filter((entry) => entry.type === type);
      if (typed.length === 0) continue;
      lines.push(`## ${type}`);
      for (const entry of typed.slice(0, 50)) {
        const tags = entry.tags.length > 0 ? ` tags=${entry.tags.join(",")}` : "";
        const stale = entry.status === "stale" ? " [stale]" : "";
        lines.push(`- ${entry.title}${stale} (${entry.id}; ${this.relativePath(entry.path)}; updated=${entry.updatedAt}${tags})`);
      }
      lines.push("");
    }
    return lines.join("\n").trim() + "\n";
  }
}
