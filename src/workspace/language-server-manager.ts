import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readTextFile } from "../tools/text-file-io.js";
import type { Diagnostic } from "../streams/event-types.js";
import { clearTypeScriptWorkspaceServices, typeScriptWorkspace } from "./typescript-service.js";

export type LanguageId =
  | "typescript"
  | "javascript"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "swift"
  | "kotlin"
  | "cpp"
  | "unknown";

export type LanguageServerStatus = {
  language: LanguageId;
  state: "native" | "available" | "unavailable";
  command?: string;
  message: string;
};

type OpenFileState = {
  filePath: string;
  language: LanguageId;
  version: number;
  content: string;
  openedAt: string;
  updatedAt: string;
};

export type LanguageServerSymbol = {
  name: string;
  kind: number;
  filePath: string;
  line: number;
  character: number;
  detail?: string;
};

export type LanguageServerLocation = {
  filePath: string;
  line: number;
  character: number;
  text?: string;
};

export type LanguageServerHover = {
  filePath: string;
  line: number;
  character: number;
  display: string;
  documentation?: string;
};

export type LanguageServerCallHierarchyEntry = {
  name: string;
  kind: number;
  filePath: string;
  line: number;
  character: number;
  detail?: string;
  text?: string;
};

export type LanguageServerDiagnosticsResult = {
  diagnostics: Diagnostic[];
  openedFiles: number;
  receivedFiles: number;
  source: string;
};

const MANAGERS = new Map<string, WorkspaceLanguageServerManager>();

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const COMMANDS: Partial<Record<LanguageId, string[]>> = {
  typescript: ["typescript-language-server"],
  javascript: ["typescript-language-server"],
  python: ["pyright-langserver"],
  rust: ["rust-analyzer"],
  go: ["gopls"],
  java: ["jdtls"],
  swift: ["sourcekit-lsp"],
  kotlin: ["kotlin-language-server"],
  cpp: ["clangd"],
};

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".swift", ".kt", ".kts",
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hh",
]);

export class WorkspaceLanguageServerManager {
  readonly projectRoot: string;
  #openFiles = new Map<string, OpenFileState>();
  #statusCache = new Map<LanguageId, LanguageServerStatus>();
  #clients = new Map<LanguageId, JsonRpcLanguageServerClient>();

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
  }

  notifyDidOpen(filePath: string, content?: string): LanguageServerStatus {
    const absolute = resolve(filePath);
    const language = detectLanguage(absolute);
    const resolvedContent = content ?? readTextIfSafe(absolute) ?? "";
    const existing = this.#openFiles.get(absolute);
    const timestamp = new Date().toISOString();
    this.#openFiles.set(absolute, {
      filePath: absolute,
      language,
      version: existing?.version ?? 1,
      content: resolvedContent,
      openedAt: existing?.openedAt ?? timestamp,
      updatedAt: timestamp,
    });
    return this.statusForLanguage(language);
  }

  notifyDidChange(filePath: string, content: string): LanguageServerStatus {
    const absolute = resolve(filePath);
    const language = detectLanguage(absolute);
    const existing = this.#openFiles.get(absolute);
    const timestamp = new Date().toISOString();
    this.#openFiles.set(absolute, {
      filePath: absolute,
      language,
      version: (existing?.version ?? 0) + 1,
      content,
      openedAt: existing?.openedAt ?? timestamp,
      updatedAt: timestamp,
    });
    if (language === "typescript" || language === "javascript") {
      clearTypeScriptWorkspaceServices();
    }
    const client = this.#clients.get(language);
    if (client) {
      void client.didChange(absolute, content, (existing?.version ?? 0) + 1);
    }
    return this.statusForLanguage(language);
  }

  notifyDidSave(filePath: string): LanguageServerStatus {
    const absolute = resolve(filePath);
    const existing = this.#openFiles.get(absolute);
    if (existing && existsSync(absolute)) {
      const text = readTextIfSafe(absolute);
      if (text !== null) {
        this.#openFiles.set(absolute, {
          ...existing,
          content: text,
          version: existing.version + 1,
          updatedAt: new Date().toISOString(),
        });
      }
    }
    const language = existing?.language ?? detectLanguage(absolute);
    if (language === "typescript" || language === "javascript") {
      clearTypeScriptWorkspaceServices();
    }
    const client = this.#clients.get(language);
    if (client) {
      const latest = this.#openFiles.get(absolute);
      if (latest) void client.didSave(absolute, latest.content, latest.version);
    }
    return this.statusForLanguage(language);
  }

  statusForFile(filePath: string): LanguageServerStatus {
    return this.statusForLanguage(detectLanguage(filePath));
  }

  statusForLanguage(language: LanguageId): LanguageServerStatus {
    if (language === "typescript" || language === "javascript") {
      return {
        language,
        state: "native",
        command: "typescript-language-service",
        message: "DeepSeek-Forge native TypeScript/JavaScript semantic service is available.",
      };
    }
    if (language === "unknown") {
      return {
        language,
        state: "unavailable",
        message: "No language server is configured for this file type.",
      };
    }
    const cached = this.#statusCache.get(language);
    if (cached) return cached;
    const command = firstAvailableCommand(COMMANDS[language] ?? [], this.projectRoot);
    const status: LanguageServerStatus = command
      ? {
        language,
        state: "available",
        command,
        message: `${command} is available for ${language}.`,
      }
      : {
        language,
        state: "unavailable",
        message: `No ${language} language server executable was found on PATH. Install ${(COMMANDS[language] ?? []).join(" or ")} for semantic LSP support; DeepSeek-Forge will fall back to lexical code search where possible.`,
      };
    this.#statusCache.set(language, status);
    return status;
  }

  diagnosticsForProject(): Diagnostic[] {
    const ts = typeScriptWorkspace(this.projectRoot);
    return ts.fileNames().length > 0 ? ts.diagnostics() : [];
  }

  diagnosticsForLanguageProject(language: LanguageId): Diagnostic[] | null {
    if (language === "typescript" || language === "javascript") return this.diagnosticsForProject();
    if (language !== "python") return null;
    if (!projectContainsExtension(this.projectRoot, ".py")) return null;
    const command = firstAvailableCommand(["pyright"], this.projectRoot);
    if (!command) return null;
    let raw = "";
    try {
      raw = execFileSync(command, ["--outputjson", this.projectRoot], {
        cwd: this.projectRoot,
        encoding: "utf-8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
        },
      });
    } catch (error) {
      const err = error as { stdout?: Buffer | string };
      raw = typeof err.stdout === "string" ? err.stdout : err.stdout?.toString("utf-8") ?? "";
      if (!raw.trim()) throw error;
    }
    const parsed = JSON.parse(raw) as {
      generalDiagnostics?: Array<{
        file?: string;
        severity?: string;
        message?: string;
        rule?: string;
        range?: {
          start?: { line?: number; character?: number };
        };
      }>;
    };
    return (parsed.generalDiagnostics ?? []).map((diagnostic) => {
      const severity = diagnostic.severity === "error"
        ? "error"
        : diagnostic.severity === "warning"
          ? "warning"
          : "info";
      return {
        ...(diagnostic.file ? { filePath: resolve(diagnostic.file) } : {}),
        ...(typeof diagnostic.range?.start?.line === "number" ? { line: diagnostic.range.start.line + 1 } : {}),
        ...(typeof diagnostic.range?.start?.character === "number" ? { character: diagnostic.range.start.character + 1 } : {}),
        severity,
        message: diagnostic.message ?? "Pyright diagnostic",
        source: "pyright",
        ...(diagnostic.rule ? { code: diagnostic.rule } : {}),
      } satisfies Diagnostic;
    });
  }

  async diagnosticsForLspProject(language: LanguageId, maxFiles = 80): Promise<LanguageServerDiagnosticsResult | null> {
    if (language === "typescript" || language === "javascript" || language === "unknown" || language === "python") return null;
    const status = this.statusForLanguage(language);
    if (status.state !== "available" || !status.command) return null;
    const files = projectFilesForLanguage(this.projectRoot, language, maxFiles);
    if (files.length === 0) return null;
    const uris: string[] = [];
    let client: JsonRpcLanguageServerClient | undefined;
    for (const file of files) {
      try {
        const opened = await this.#openDocument(file);
        if (!opened) continue;
        client = opened.client;
        uris.push(pathToFileURL(file).href);
      } catch {
        // Continue opening the rest of the project; diagnostics should be best-effort per file.
      }
    }
    if (!client || uris.length === 0) return null;
    const diagnosticsByUri = await client.waitForDiagnostics(uris, 3_000);
    const diagnostics: Diagnostic[] = [];
    for (const uri of uris) {
      const fileDiagnostics = diagnosticsByUri.get(uri);
      if (!fileDiagnostics) continue;
      diagnostics.push(...fileDiagnostics);
    }
    return {
      diagnostics,
      openedFiles: uris.length,
      receivedFiles: [...diagnosticsByUri.keys()].length,
      source: status.command,
    };
  }

  async documentSymbols(filePath: string): Promise<LanguageServerSymbol[] | null> {
    const absolute = resolve(filePath);
    const opened = await this.#openDocument(absolute);
    if (!opened) return null;
    const { language, client } = opened;
    try {
      const raw = await client.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri: pathToFileURL(absolute).href },
      });
      return flattenDocumentSymbols(absolute, raw);
    } catch (error) {
      this.#clients.delete(language);
      client.dispose();
      throw error;
    }
  }

  async workspaceSymbols(query: string): Promise<LanguageServerSymbol[] | null> {
    const symbols: LanguageServerSymbol[] = [];
    const languages = languagesInProject(this.projectRoot);
    for (const language of languages) {
      if (language === "typescript" || language === "javascript" || language === "unknown") continue;
      const status = this.statusForLanguage(language);
      if (status.state !== "available" || !status.command) continue;
      const client = this.#clientFor(language, status.command);
      try {
        await client.initialize(this.projectRoot);
        const raw = await client.sendRequest("workspace/symbol", { query }, 5_000);
        symbols.push(...flattenWorkspaceSymbols(raw));
      } catch {
        this.#clients.delete(language);
        client.dispose();
        continue;
      }
    }
    return symbols.length > 0 ? symbols : null;
  }

  async definitions(filePath: string, line: number, character: number): Promise<LanguageServerLocation[] | null> {
    return this.#locationRequest("textDocument/definition", filePath, line, character);
  }

  async references(filePath: string, line: number, character: number): Promise<LanguageServerLocation[] | null> {
    return this.#locationRequest("textDocument/references", filePath, line, character, {
      context: { includeDeclaration: true },
    });
  }

  async implementations(filePath: string, line: number, character: number): Promise<LanguageServerLocation[] | null> {
    return this.#locationRequest("textDocument/implementation", filePath, line, character);
  }

  async hover(filePath: string, line: number, character: number): Promise<LanguageServerHover | null> {
    const absolute = resolve(filePath);
    const opened = await this.#openDocument(absolute);
    if (!opened) return null;
    const { language, client } = opened;
    try {
      const raw = await client.sendRequest("textDocument/hover", textDocumentPositionParams(absolute, line, character));
      const hover = flattenHover(absolute, line, character, raw);
      return hover;
    } catch (error) {
      this.#clients.delete(language);
      client.dispose();
      throw error;
    }
  }

  async callHierarchy(filePath: string, line: number, character: number): Promise<LanguageServerCallHierarchyEntry[] | null> {
    const items = await this.#prepareCallHierarchy(filePath, line, character);
    return items;
  }

  async incomingCalls(filePath: string, line: number, character: number): Promise<LanguageServerCallHierarchyEntry[] | null> {
    return this.#callHierarchyDirection("callHierarchy/incomingCalls", "from", filePath, line, character);
  }

  async outgoingCalls(filePath: string, line: number, character: number): Promise<LanguageServerCallHierarchyEntry[] | null> {
    return this.#callHierarchyDirection("callHierarchy/outgoingCalls", "to", filePath, line, character);
  }

  dispose(): void {
    for (const client of this.#clients.values()) client.dispose();
    this.#clients.clear();
  }

  #clientFor(language: LanguageId, command: string): JsonRpcLanguageServerClient {
    const existing = this.#clients.get(language);
    if (existing) return existing;
    const client = new JsonRpcLanguageServerClient(command);
    this.#clients.set(language, client);
    return client;
  }

  async #openDocument(filePath: string): Promise<{ language: LanguageId; client: JsonRpcLanguageServerClient } | null> {
    const absolute = resolve(filePath);
    const language = detectLanguage(absolute);
    if (language === "typescript" || language === "javascript" || language === "unknown") return null;
    const status = this.statusForLanguage(language);
    if (status.state !== "available" || !status.command) return null;
    const content = readTextIfSafe(absolute);
    if (content === null) return null;
    const existing = this.#openFiles.get(absolute);
    const version = existing?.version ?? 1;
    this.#openFiles.set(absolute, {
      filePath: absolute,
      language,
      version,
      content,
      openedAt: existing?.openedAt ?? new Date().toISOString(),
      updatedAt: existing?.updatedAt ?? new Date().toISOString(),
    });
    const client = this.#clientFor(language, status.command);
    await client.initialize(this.projectRoot);
    await client.openOrChange(absolute, language, content, version);
    return { language, client };
  }

  async #locationRequest(
    method: string,
    filePath: string,
    line: number,
    character: number,
    extraParams: Record<string, unknown> = {},
  ): Promise<LanguageServerLocation[] | null> {
    const absolute = resolve(filePath);
    const opened = await this.#openDocument(absolute);
    if (!opened) return null;
    const { language, client } = opened;
    try {
      const raw = await client.sendRequest(method, {
        ...textDocumentPositionParams(absolute, line, character),
        ...extraParams,
      });
      const locations = flattenLocations(raw);
      return locations.length > 0 ? locations : [];
    } catch (error) {
      this.#clients.delete(language);
      client.dispose();
      throw error;
    }
  }

  async #prepareCallHierarchy(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LanguageServerCallHierarchyEntry[] | null> {
    const absolute = resolve(filePath);
    const opened = await this.#openDocument(absolute);
    if (!opened) return null;
    const { language, client } = opened;
    try {
      const raw = await client.sendRequest("textDocument/prepareCallHierarchy", textDocumentPositionParams(absolute, line, character));
      return flattenCallHierarchyItems(raw);
    } catch (error) {
      this.#clients.delete(language);
      client.dispose();
      throw error;
    }
  }

  async #callHierarchyDirection(
    method: string,
    itemKey: "from" | "to",
    filePath: string,
    line: number,
    character: number,
  ): Promise<LanguageServerCallHierarchyEntry[] | null> {
    const absolute = resolve(filePath);
    const opened = await this.#openDocument(absolute);
    if (!opened) return null;
    const { language, client } = opened;
    try {
      const rawItems = await client.sendRequest("textDocument/prepareCallHierarchy", textDocumentPositionParams(absolute, line, character));
      const items = Array.isArray(rawItems) ? rawItems : [];
      const output: LanguageServerCallHierarchyEntry[] = [];
      for (const item of items) {
        const rawCalls = await client.sendRequest(method, { item }, 5_000);
        if (!Array.isArray(rawCalls)) continue;
        for (const call of rawCalls) {
          const record = call as Record<string, unknown>;
          const entry = flattenCallHierarchyItems([record[itemKey]]).at(0);
          if (entry) output.push(entry);
        }
      }
      return output;
    } catch (error) {
      this.#clients.delete(language);
      client.dispose();
      throw error;
    }
  }

  snapshot(): { projectRoot: string; openFiles: Array<Omit<OpenFileState, "content">>; servers: LanguageServerStatus[] } {
    const languages = new Set<LanguageId>();
    for (const file of this.#openFiles.values()) languages.add(file.language);
    return {
      projectRoot: this.projectRoot,
      openFiles: [...this.#openFiles.values()].map(({ content: _content, ...rest }) => rest),
      servers: [...languages].map((language) => this.statusForLanguage(language)),
    };
  }
}

function projectContainsExtension(root: string, extension: string, depth = 0): boolean {
  if (depth > 6) return false;
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".venv" || entry.name === "__pycache__") continue;
    const fullPath = join(root, entry.name);
    if (entry.isFile() && extname(entry.name).toLowerCase() === extension) return true;
    if (entry.isDirectory() && projectContainsExtension(fullPath, extension, depth + 1)) return true;
  }
  return false;
}

function projectFilesForLanguage(root: string, language: LanguageId, limit: number): string[] {
  const output: string[] = [];
  const skipped = new Set([
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    "target",
    "build",
    "dist",
    ".next",
    ".turbo",
    ".gradle",
    ".idea",
    ".vscode",
  ]);
  const visit = (dir: string, depth: number): void => {
    if (output.length >= limit || depth > 8) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (output.length >= limit) return;
      if (skipped.has(entry.name) || entry.isSymbolicLink()) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (detectLanguage(fullPath) === language) output.push(fullPath);
    }
  };
  visit(root, 0);
  return output.sort();
}

export function workspaceLanguageServerManager(projectRoot: string): WorkspaceLanguageServerManager {
  const absolute = resolve(projectRoot);
  let manager = MANAGERS.get(absolute);
  if (!manager) {
    manager = new WorkspaceLanguageServerManager(absolute);
    MANAGERS.set(absolute, manager);
  }
  return manager;
}

export function clearWorkspaceLanguageServerManagers(): void {
  for (const manager of MANAGERS.values()) manager.dispose();
  MANAGERS.clear();
}

class JsonRpcLanguageServerClient {
  #command: string;
  #child: ChildProcessWithoutNullStreams | null = null;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #initialized: Promise<void> | null = null;
  #openedDocuments = new Map<string, number>();
  #diagnostics = new Map<string, Diagnostic[]>();

  constructor(command: string) {
    this.#command = command;
  }

  async initialize(projectRoot: string): Promise<void> {
    if (this.#initialized) return this.#initialized;
    this.#initialized = (async () => {
      this.#start();
      await this.sendRequest("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(projectRoot).href,
        capabilities: {
          textDocument: {
            callHierarchy: {
              dynamicRegistration: false,
            },
            definition: {
              linkSupport: true,
            },
            documentSymbol: {
              hierarchicalDocumentSymbolSupport: true,
            },
            hover: {
              contentFormat: ["markdown", "plaintext"],
            },
            implementation: {
              linkSupport: true,
            },
            references: {},
            synchronization: {
              didSave: true,
              dynamicRegistration: false,
            },
          },
          workspace: {
            symbol: {
              dynamicRegistration: false,
            },
            workspaceFolders: true,
          },
        },
        workspaceFolders: [{ uri: pathToFileURL(projectRoot).href, name: "workspace" }],
      }, 5_000);
      this.sendNotification("initialized", {});
    })();
    return this.#initialized;
  }

  async didOpen(filePath: string, language: LanguageId, text: string): Promise<void> {
    this.#openedDocuments.set(pathToFileURL(filePath).href, 1);
    this.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(filePath).href,
        languageId: lspLanguageId(language),
        version: 1,
        text,
      },
    });
  }

  async openOrChange(filePath: string, language: LanguageId, text: string, version: number): Promise<void> {
    const uri = pathToFileURL(filePath).href;
    if (!this.#openedDocuments.has(uri)) {
      this.#openedDocuments.set(uri, version);
      this.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: lspLanguageId(language),
          version,
          text,
        },
      });
      return;
    }
    await this.didChange(filePath, text, version);
  }

  async didChange(filePath: string, text: string, version: number): Promise<void> {
    const uri = pathToFileURL(filePath).href;
    this.#openedDocuments.set(uri, version);
    this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  async didSave(filePath: string, text: string, version: number): Promise<void> {
    const uri = pathToFileURL(filePath).href;
    this.#openedDocuments.set(uri, version);
    this.sendNotification("textDocument/didSave", {
      textDocument: { uri },
      text,
    });
  }

  async sendRequest(method: string, params: unknown, timeoutMs = 3_000): Promise<unknown> {
    this.#start();
    const id = this.#nextId++;
    const message: JsonRpcMessage = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectRequest(new Error(`Language server request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveRequest(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectRequest(error);
        },
        timer,
      });
      this.#send(message);
    });
  }

  async waitForDiagnostics(uris: string[], timeoutMs: number): Promise<Map<string, Diagnostic[]>> {
    const wanted = new Set(uris);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if ([...wanted].every((uri) => this.#diagnostics.has(uri))) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    const output = new Map<string, Diagnostic[]>();
    for (const uri of wanted) {
      const diagnostics = this.#diagnostics.get(uri);
      if (diagnostics) output.set(uri, diagnostics);
    }
    return output;
  }

  sendNotification(method: string, params: unknown): void {
    this.#start();
    this.#send({ jsonrpc: "2.0", method, params });
  }

  dispose(): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Language server client disposed."));
      this.#pending.delete(id);
    }
    this.#child?.kill();
    this.#child = null;
  }

  #start(): void {
    if (this.#child) return;
    this.#child = spawn(this.#command, languageServerArgs(this.#command), {
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    this.#child.stdout.on("data", (chunk: Buffer) => this.#onData(chunk));
    this.#child.on("error", (error) => this.#rejectAll(error));
    this.#child.on("exit", (code, signal) => {
      this.#rejectAll(new Error(`Language server exited: ${this.#command} code=${code ?? "null"} signal=${signal ?? "null"}`));
      this.#child = null;
      this.#initialized = null;
    });
  }

  #send(message: JsonRpcMessage): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii");
    this.#child?.stdin.write(Buffer.concat([header, body]));
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        this.#buffer = this.#buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.#buffer.length < bodyEnd) return;
      const body = this.#buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.#buffer = this.#buffer.subarray(bodyEnd);
      this.#handleMessage(body);
    }
  }

  #handleMessage(body: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(body) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      this.#handleDiagnostics(message.params);
      return;
    }
    if (message.id === undefined) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message));
      return;
    }
    pending.resolve(message.result);
  }

  #handleDiagnostics(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const record = params as Record<string, unknown>;
    const uri = typeof record.uri === "string" ? record.uri : undefined;
    if (!uri) return;
    let filePath: string;
    try {
      filePath = fileURLToPath(uri);
    } catch {
      return;
    }
    const diagnostics = Array.isArray(record.diagnostics)
      ? record.diagnostics.flatMap((item) => lspDiagnosticToDiagnostic(filePath, item))
      : [];
    this.#diagnostics.set(uri, diagnostics);
  }

  #rejectAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }
}

export function detectLanguage(filePath: string): LanguageId {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".py":
      return "python";
    case ".rs":
      return "rust";
    case ".go":
      return "go";
    case ".java":
      return "java";
    case ".swift":
      return "swift";
    case ".kt":
    case ".kts":
      return "kotlin";
    case ".c":
    case ".cc":
    case ".cpp":
    case ".cxx":
    case ".h":
    case ".hpp":
    case ".hh":
      return "cpp";
    default:
      return "unknown";
  }
}

function readTextIfSafe(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return null;
    if (!TEXT_EXTENSIONS.has(extname(filePath).toLowerCase())) return null;
    return readTextFile(filePath).content;
  } catch {
    try {
      return readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }
}

function lspLanguageId(language: LanguageId): string {
  switch (language) {
    case "cpp": return "cpp";
    case "typescript": return "typescript";
    case "javascript": return "javascript";
    default: return language;
  }
}

function languageServerArgs(command: string): string[] {
  return command.endsWith("pyright-langserver") ? ["--stdio"] : [];
}

function languagesInProject(root: string): LanguageId[] {
  const languages = new Set<LanguageId>();
  const visit = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".venv" || entry.name === "__pycache__") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const language = detectLanguage(fullPath);
      if (language !== "unknown") languages.add(language);
    }
  };
  visit(root, 0);
  return [...languages];
}

function textDocumentPositionParams(filePath: string, line: number, character: number): {
  textDocument: { uri: string };
  position: { line: number; character: number };
} {
  return {
    textDocument: { uri: pathToFileURL(filePath).href },
    position: {
      line: Math.max(0, Math.floor(line) - 1),
      character: Math.max(0, Math.floor(character) - 1),
    },
  };
}

function flattenDocumentSymbols(filePath: string, raw: unknown): LanguageServerSymbol[] {
  const output: LanguageServerSymbol[] = [];
  const visit = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : undefined;
      if (!name) continue;
      const kind = typeof record.kind === "number" ? record.kind : 0;
      const detail = typeof record.detail === "string" ? record.detail : undefined;
      const range = (record.selectionRange ?? record.range) as Record<string, unknown> | undefined;
      const start = range?.start as Record<string, unknown> | undefined;
      const line = typeof start?.line === "number" ? start.line + 1 : 1;
      const character = typeof start?.character === "number" ? start.character + 1 : 1;
      output.push({
        name,
        kind,
        filePath,
        line,
        character,
        ...(detail !== undefined ? { detail } : {}),
      });
      visit(record.children);
    }
  };
  visit(raw);
  return output;
}

function flattenWorkspaceSymbols(raw: unknown): LanguageServerSymbol[] {
  const output: LanguageServerSymbol[] = [];
  if (!Array.isArray(raw)) return output;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : undefined;
    if (!name) continue;
    const kind = typeof record.kind === "number" ? record.kind : 0;
    const location = record.location as Record<string, unknown> | undefined;
    const uri = typeof location?.uri === "string" ? location.uri : typeof record.uri === "string" ? record.uri : undefined;
    const range = (location?.range ?? record.range ?? record.selectionRange) as Record<string, unknown> | undefined;
    const converted = lspRangeToLocation(uri, range);
    if (!converted) continue;
    const detail = typeof record.containerName === "string"
      ? record.containerName
      : typeof record.detail === "string"
        ? record.detail
        : undefined;
    output.push({
      name,
      kind,
      filePath: converted.filePath,
      line: converted.line,
      character: converted.character,
      ...(detail !== undefined ? { detail } : {}),
    });
  }
  return output;
}

function flattenLocations(raw: unknown): LanguageServerLocation[] {
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const output: LanguageServerLocation[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const uri = typeof record.uri === "string"
      ? record.uri
      : typeof record.targetUri === "string"
        ? record.targetUri
        : undefined;
    const range = (record.range ?? record.targetSelectionRange ?? record.targetRange) as Record<string, unknown> | undefined;
    const converted = lspRangeToLocation(uri, range);
    if (!converted) continue;
    const text = lineText(converted.filePath, converted.line);
    output.push({
      ...converted,
      ...(text !== undefined ? { text } : {}),
    });
  }
  return output;
}

function flattenHover(filePath: string, line: number, character: number, raw: unknown): LanguageServerHover | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const display = formatMarkupContent(record.contents);
  if (!display.trim()) return null;
  return {
    filePath,
    line,
    character,
    display,
  };
}

function flattenCallHierarchyItems(raw: unknown): LanguageServerCallHierarchyEntry[] {
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const output: LanguageServerCallHierarchyEntry[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : undefined;
    const uri = typeof record.uri === "string" ? record.uri : undefined;
    const range = (record.selectionRange ?? record.range) as Record<string, unknown> | undefined;
    const converted = lspRangeToLocation(uri, range);
    if (!name || !converted) continue;
    const detail = typeof record.detail === "string" ? record.detail : undefined;
    const text = lineText(converted.filePath, converted.line);
    output.push({
      name,
      kind: typeof record.kind === "number" ? record.kind : 0,
      filePath: converted.filePath,
      line: converted.line,
      character: converted.character,
      ...(detail !== undefined ? { detail } : {}),
      ...(text !== undefined ? { text } : {}),
    });
  }
  return output;
}

function lspRangeToLocation(uri: string | undefined, range: Record<string, unknown> | undefined): LanguageServerLocation | null {
  if (!uri || !range) return null;
  let filePath: string;
  try {
    filePath = fileURLToPath(uri);
  } catch {
    return null;
  }
  const start = range.start as Record<string, unknown> | undefined;
  const line = typeof start?.line === "number" ? start.line + 1 : 1;
  const character = typeof start?.character === "number" ? start.character + 1 : 1;
  return { filePath, line, character };
}

function lineText(filePath: string, line: number): string | undefined {
  const text = readTextIfSafe(filePath);
  if (text === null) return undefined;
  return text.split(/\r?\n/)[line - 1]?.trim();
}

function formatMarkupContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(formatMarkupContent).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.value === "string") return record.value;
  if (typeof record.language === "string" && typeof record.value === "string") return record.value;
  return "";
}

function lspDiagnosticSeverity(value: unknown): Diagnostic["severity"] {
  if (value === 1) return "error";
  if (value === 2) return "warning";
  return "info";
}

function lspDiagnosticToDiagnostic(filePath: string, value: unknown): Diagnostic[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const message = typeof record.message === "string" && record.message.trim()
    ? record.message
    : "Language server diagnostic";
  const range = record.range as Record<string, unknown> | undefined;
  const start = range?.start as Record<string, unknown> | undefined;
  const line = typeof start?.line === "number" ? start.line + 1 : undefined;
  const character = typeof start?.character === "number" ? start.character + 1 : undefined;
  const code = typeof record.code === "string"
    ? record.code
    : typeof record.code === "number"
      ? String(record.code)
      : undefined;
  const source = typeof record.source === "string" ? record.source : "lsp";
  return [{
    filePath,
    ...(line !== undefined ? { line } : {}),
    ...(character !== undefined ? { character } : {}),
    severity: lspDiagnosticSeverity(record.severity),
    message,
    source,
    ...(code !== undefined ? { code } : {}),
  }];
}

function firstAvailableCommand(commands: string[], projectRoot: string): string | undefined {
  for (const command of commands) {
    const local = resolve(join(projectRoot, "node_modules", ".bin", command));
    if (existsSync(local)) return local;
    try {
      execFileSync("/bin/bash", ["-lc", `command -v ${shellQuote(command)}`], {
        stdio: "ignore",
        timeout: 1000,
      });
      return command;
    } catch {
      // Try next candidate.
    }
  }
  return undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
