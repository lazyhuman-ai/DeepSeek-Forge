import type { ToolExecutionContext } from "../../agent/tool-executor.js";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { resolveToolPath } from "./path-helper.js";
import {
  formatWorkspacePath,
  typeScriptWorkspace,
  type TypeScriptSymbol,
} from "../../workspace/typescript-service.js";
import {
  genericDefinitionsForInput,
  genericFileSymbols,
  genericHover,
  genericReferences,
  genericWorkspaceSymbols,
  type GenericCodeSymbol,
} from "../../workspace/code-index.js";
import { workspaceLanguageServerManager } from "../../workspace/language-server-manager.js";
import type { LanguageServerSymbol } from "../../workspace/language-server-manager.js";

type CodeLocation = {
  filePath: string;
  line: number;
  character: number;
  text?: string;
};

type CodeCallHierarchyEntry = {
  name: string;
  kind: string | number;
  filePath: string;
  line: number;
  character: number;
  text?: string;
};

function formatSymbols(projectRoot: string, filePath: string, symbols: TypeScriptSymbol[]): string {
  if (symbols.length === 0) return `No TypeScript/JavaScript symbols found in ${formatWorkspacePath(projectRoot, filePath)}.`;
  return [
    `Symbols in ${formatWorkspacePath(projectRoot, filePath)}:`,
    ...symbols.slice(0, 80).map((symbol) => {
      const container = symbol.containerName ? ` in ${symbol.containerName}` : "";
      return `${symbol.line}:${symbol.character} ${symbol.kind} ${symbol.name}${container}`;
    }),
    symbols.length > 80 ? `... ${symbols.length - 80} more symbol(s)` : "",
  ].filter(Boolean).join("\n");
}

function formatGenericSymbols(projectRoot: string, filePath: string, symbols: GenericCodeSymbol[]): string {
  if (symbols.length === 0) return `No generic code symbols found in ${formatWorkspacePath(projectRoot, filePath)}.`;
  return [
    `Generic code index symbols in ${formatWorkspacePath(projectRoot, filePath)}:`,
    "Note: this is a lexical multi-language index, not a full semantic LSP result.",
    ...symbols.slice(0, 80).map((symbol) => {
      const container = symbol.containerName ? ` in ${symbol.containerName}` : "";
      return `${symbol.line}:${symbol.character} ${symbol.language} ${symbol.kind} ${symbol.name}${container}`;
    }),
    symbols.length > 80 ? `... ${symbols.length - 80} more symbol(s)` : "",
  ].filter(Boolean).join("\n");
}

function formatLanguageServerSymbols(projectRoot: string, filePath: string, symbols: LanguageServerSymbol[]): string {
  if (symbols.length === 0) return `No language-server symbols found in ${formatWorkspacePath(projectRoot, filePath)}.`;
  return [
    `Language-server symbols in ${formatWorkspacePath(projectRoot, filePath)}:`,
    ...symbols.slice(0, 80).map((symbol) => {
      const detail = symbol.detail ? ` ${symbol.detail}` : "";
      return `${symbol.line}:${symbol.character} kind=${symbol.kind} ${symbol.name}${detail}`;
    }),
    symbols.length > 80 ? `... ${symbols.length - 80} more symbol(s)` : "",
  ].filter(Boolean).join("\n");
}

function formatLocations(projectRoot: string, label: string, symbol: string, locations: CodeLocation[], sourceLabel?: string): string {
  if (locations.length === 0) return `No ${label.toLowerCase()} found for ${symbol}.`;
  return [
    `${label} for ${symbol}${sourceLabel ? ` (${sourceLabel})` : ""}:`,
    ...locations.slice(0, 80).map((location) => {
      const line = location.text ? ` ${location.text}` : "";
      return `${formatWorkspacePath(projectRoot, location.filePath)}:${location.line}:${location.character}${line}`;
    }),
    locations.length > 80 ? `... ${locations.length - 80} more location(s)` : "",
  ].filter(Boolean).join("\n");
}

function formatGenericLocations(projectRoot: string, label: string, symbol: string, locations: CodeLocation[]): string {
  if (locations.length === 0) return `No ${label.toLowerCase()} found for ${symbol}.`;
  return [
    `${label} for ${symbol} (generic lexical code index):`,
    "Note: these are lexical symbol/reference matches, not full semantic LSP results.",
    ...locations.slice(0, 80).map((location) => {
      const line = location.text ? ` ${location.text}` : "";
      return `${formatWorkspacePath(projectRoot, location.filePath)}:${location.line}:${location.character}${line}`;
    }),
    locations.length > 80 ? `... ${locations.length - 80} more location(s)` : "",
  ].filter(Boolean).join("\n");
}

function formatCallHierarchy(projectRoot: string, label: string, symbol: string, entries: CodeCallHierarchyEntry[], sourceLabel?: string): string {
  if (entries.length === 0) return `No ${label.toLowerCase()} found for ${symbol}.`;
  return [
    `${label} for ${symbol}${sourceLabel ? ` (${sourceLabel})` : ""}:`,
    ...entries.slice(0, 80).map((entry) => {
      const line = entry.text ? ` ${entry.text}` : "";
      return `${formatWorkspacePath(projectRoot, entry.filePath)}:${entry.line}:${entry.character} ${entry.kind} ${entry.name}${line}`;
    }),
    entries.length > 80 ? `... ${entries.length - 80} more call hierarchy item(s)` : "",
  ].filter(Boolean).join("\n");
}

function dedupeSymbols(symbols: TypeScriptSymbol[]): TypeScriptSymbol[] {
  const seen = new Set<string>();
  const output: TypeScriptSymbol[] = [];
  for (const symbol of symbols) {
    const key = `${symbol.filePath}:${symbol.line}:${symbol.character}:${symbol.kind}:${symbol.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(symbol);
  }
  return output;
}

function dedupeLanguageServerSymbols(symbols: LanguageServerSymbol[]): LanguageServerSymbol[] {
  const seen = new Set<string>();
  const output: LanguageServerSymbol[] = [];
  for (const symbol of symbols) {
    const key = `${symbol.filePath}:${symbol.line}:${symbol.character}:${symbol.kind}:${symbol.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(symbol);
  }
  return output;
}

async function resolveLanguageServerPosition(
  projectRoot: string,
  languageServerManager: ReturnType<typeof workspaceLanguageServerManager>,
  input: { filePath?: string; line?: number; character?: number; symbol?: string },
): Promise<{ filePath: string; line: number; character: number; label: string } | undefined> {
  if (input.filePath && input.line !== undefined && input.character !== undefined) {
    return {
      filePath: input.filePath,
      line: input.line,
      character: input.character,
      label: `${formatWorkspacePath(projectRoot, input.filePath)}:${input.line}:${input.character}`,
    };
  }
  if (!input.symbol) return undefined;
  let symbols: LanguageServerSymbol[] | null = null;
  try {
    symbols = await languageServerManager.workspaceSymbols(input.symbol);
  } catch {
    symbols = null;
  }
  const match = (symbols ?? []).find((candidate) => candidate.name === input.symbol)
    ?? (symbols ?? []).find((candidate) => candidate.name.toLowerCase().includes(input.symbol!.toLowerCase()));
  if (!match) return undefined;
  return {
    filePath: match.filePath,
    line: match.line,
    character: match.character,
    label: input.symbol,
  };
}

function formatHover(projectRoot: string, label: string, hover: CodeLocation & { display: string; documentation?: string }, sourceLabel?: string): string {
  return [
    `Hover for ${label}${sourceLabel ? ` (${sourceLabel})` : ""}:`,
    `${formatWorkspacePath(projectRoot, hover.filePath)}:${hover.line}:${hover.character}`,
    hover.display,
    hover.documentation ? `\n${hover.documentation}` : "",
  ].filter(Boolean).join("\n");
}

function codeIndexFailure(operation: string, projectRoot: string, error: unknown): { output: string; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    output: [
      `Code index ${operation} failed.`,
      `Project: ${projectRoot}`,
      `Reason: ${message}`,
      "Recovery: make sure the workspace path exists and is a directory, then retry lsp_query or use read_file/grep with an explicit path.",
    ].join("\n"),
    isError: true,
  };
}

async function handler(
  args: Record<string, unknown>,
  _sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  const query = typeof args.query === "string" ? args.query : "";
  const symbol = typeof args.symbol === "string" ? args.symbol.trim() : "";
  const line = typeof args.line === "number" ? args.line : undefined;
  const character = typeof args.character === "number" ? args.character : undefined;
  const projectRoot = context?.projectRoot ?? process.cwd();
  const languageServerManager = workspaceLanguageServerManager(projectRoot);
  if (!["symbols", "workspace_symbols", "definition", "implementation", "references", "hover", "call_hierarchy", "incoming_calls", "outgoing_calls"].includes(query)) {
    return { output: "query must be one of symbols, workspace_symbols, definition, implementation, references, hover, call_hierarchy, incoming_calls, outgoing_calls.", isError: true };
  }
  const service = typeScriptWorkspace(projectRoot);

  if (query === "workspace_symbols") {
    if (!symbol) return { output: "symbol is required for workspace_symbols query.", isError: true };
    const tsSymbols = service.workspaceSymbols(symbol);
    let lspSymbols: LanguageServerSymbol[] = [];
    try {
      lspSymbols = dedupeLanguageServerSymbols(await languageServerManager.workspaceSymbols(symbol) ?? []);
    } catch {
      lspSymbols = [];
    }
    let genericSymbols: GenericCodeSymbol[] = [];
    try {
      genericSymbols = genericWorkspaceSymbols(projectRoot, symbol);
    } catch (error) {
      if (tsSymbols.length === 0 && lspSymbols.length === 0) {
        return codeIndexFailure("workspace_symbols", projectRoot, error);
      }
    }
    if (tsSymbols.length > 0 || lspSymbols.length > 0 || genericSymbols.length > 0) {
      const sections: string[] = [];
      if (tsSymbols.length > 0) sections.push(formatSymbols(projectRoot, projectRoot, tsSymbols));
      if (lspSymbols.length > 0) sections.push([
        `Language-server workspace symbols for ${symbol}:`,
        ...lspSymbols.slice(0, 80).map((item) => {
          const detail = item.detail ? ` ${item.detail}` : "";
          return `${formatWorkspacePath(projectRoot, item.filePath)}:${item.line}:${item.character} kind=${item.kind} ${item.name}${detail}`;
        }),
        lspSymbols.length > 80 ? `... ${lspSymbols.length - 80} more symbol(s)` : "",
      ].filter(Boolean).join("\n"));
      if (genericSymbols.length > 0 && tsSymbols.length === 0 && lspSymbols.length === 0) {
        sections.push(formatGenericSymbols(projectRoot, projectRoot, genericSymbols));
      }
      const hasGenericOnly = genericSymbols.length > 0 && tsSymbols.length === 0 && lspSymbols.length === 0;
      const formatted = sections.join("\n\n");
      return hasGenericOnly
        ? `${formatted}\n\nNote: result came from the generic lexical code index because TypeScript language-service symbols were unavailable or empty.`
        : formatted;
    }
    return `No workspace symbols found for ${symbol}.`;
  }

  if (query === "symbols") {
    const resolvedPath = resolveToolPath(args, context, {
      argName: "file_path",
      access: "read",
      toolName: "lsp_query",
      action: "fs.read",
    });
    if (!resolvedPath.ok) return resolvedPath;
    languageServerManager.notifyDidOpen(resolvedPath.path);
    try {
      const tsSymbols = service.fileNames().includes(resolvedPath.path)
        ? service.symbols(resolvedPath.path)
        : [];
      if (tsSymbols.length > 0) return formatSymbols(projectRoot, resolvedPath.path, tsSymbols);
      const lspSymbols = await languageServerManager.documentSymbols(resolvedPath.path);
      if (lspSymbols && lspSymbols.length > 0) return formatLanguageServerSymbols(projectRoot, resolvedPath.path, lspSymbols);
      return formatGenericSymbols(projectRoot, resolvedPath.path, genericFileSymbols(resolvedPath.path));
    } catch (error) {
      const genericSymbols = genericFileSymbols(resolvedPath.path);
      if (genericSymbols.length > 0) return formatGenericSymbols(projectRoot, resolvedPath.path, genericSymbols);
      return {
        output: `Code index could not read symbols for ${resolvedPath.path}: ${(error as Error).message}`,
        isError: true,
      };
    }
  }

  if (!symbol && (typeof args.file_path !== "string" || line === undefined || character === undefined)) {
    return {
      output: "Provide either symbol, or file_path with line and character, for definition, implementation, references, hover, and call hierarchy queries.",
      isError: true,
    };
  }
  let resolvedFilePath: string | undefined;
  if (typeof args.file_path === "string") {
    const resolvedPath = resolveToolPath(args, context, {
      argName: "file_path",
      access: "read",
      toolName: "lsp_query",
      action: "fs.read",
    });
    if (!resolvedPath.ok) return resolvedPath;
    resolvedFilePath = resolvedPath.path;
    languageServerManager.notifyDidOpen(resolvedFilePath);
  }
  const queryInput = {
    ...(resolvedFilePath !== undefined ? { filePath: resolvedFilePath } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(character !== undefined ? { character } : {}),
    ...(symbol ? { symbol } : {}),
  };
  const label = symbol || (resolvedFilePath && line !== undefined && character !== undefined
    ? `${formatWorkspacePath(projectRoot, resolvedFilePath)}:${line}:${character}`
    : "position");
  if (query === "references") {
    const locations = service.references(queryInput);
    if (locations.length > 0) return formatLocations(projectRoot, "References", label, locations);
    const position = await resolveLanguageServerPosition(projectRoot, languageServerManager, queryInput);
    if (position) {
      try {
        const lspLocations = await languageServerManager.references(position.filePath, position.line, position.character);
        if (lspLocations && lspLocations.length > 0) {
          return formatLocations(projectRoot, "References", position.label, lspLocations, "language server");
        }
      } catch {
        // Fall through to the generic lexical index.
      }
    }
    let generic: CodeLocation[];
    try {
      generic = genericReferences(projectRoot, queryInput);
    } catch (error) {
      return codeIndexFailure("references", projectRoot, error);
    }
    return formatGenericLocations(projectRoot, "References", label, generic);
  }
  if (query === "definition") {
    const locations = service.definitions(queryInput);
    if (locations.length > 0) return formatLocations(projectRoot, "Definitions", label, locations);
    const position = await resolveLanguageServerPosition(projectRoot, languageServerManager, queryInput);
    if (position) {
      try {
        const lspLocations = await languageServerManager.definitions(position.filePath, position.line, position.character);
        if (lspLocations && lspLocations.length > 0) {
          return formatLocations(projectRoot, "Definitions", position.label, lspLocations, "language server");
        }
      } catch {
        // Fall through to the generic lexical index.
      }
    }
    let generic: CodeLocation[];
    try {
      generic = genericDefinitionsForInput(projectRoot, queryInput);
    } catch (error) {
      return codeIndexFailure("definition", projectRoot, error);
    }
    return formatGenericLocations(projectRoot, "Definitions", label, generic);
  }
  if (query === "implementation") {
    const locations = service.implementations(queryInput);
    if (locations.length > 0) return formatLocations(projectRoot, "Implementations", label, locations);
    const position = await resolveLanguageServerPosition(projectRoot, languageServerManager, queryInput);
    if (position) {
      try {
        const lspLocations = await languageServerManager.implementations(position.filePath, position.line, position.character);
        if (lspLocations && lspLocations.length > 0) {
          return formatLocations(projectRoot, "Implementations", position.label, lspLocations, "language server");
        }
      } catch {
        // Fall through to the no-result explanation.
      }
    }
    return "No implementations found. If a language server is unavailable or the server does not support implementation queries, use workspace_symbols, definitions, or references for lexical multi-language navigation.";
  }
  if (query === "call_hierarchy") {
    const entries = service.callHierarchy(queryInput);
    if (entries.length > 0) return formatCallHierarchy(projectRoot, "Call hierarchy items", label, entries);
    const position = await resolveLanguageServerPosition(projectRoot, languageServerManager, queryInput);
    if (position) {
      try {
        const lspEntries = await languageServerManager.callHierarchy(position.filePath, position.line, position.character);
        if (lspEntries && lspEntries.length > 0) {
          return formatCallHierarchy(projectRoot, "Call hierarchy items", position.label, lspEntries, "language server");
        }
      } catch {
        // Fall through.
      }
    }
    return `No call hierarchy items found for ${label}.`;
  }
  if (query === "incoming_calls") {
    const entries = service.incomingCalls(queryInput);
    if (entries.length > 0) return formatCallHierarchy(projectRoot, "Incoming calls", label, entries);
    const position = await resolveLanguageServerPosition(projectRoot, languageServerManager, queryInput);
    if (position) {
      try {
        const lspEntries = await languageServerManager.incomingCalls(position.filePath, position.line, position.character);
        if (lspEntries && lspEntries.length > 0) {
          return formatCallHierarchy(projectRoot, "Incoming calls", position.label, lspEntries, "language server");
        }
      } catch {
        // Fall through.
      }
    }
    return `No incoming calls found for ${label}.`;
  }
  if (query === "outgoing_calls") {
    const entries = service.outgoingCalls(queryInput);
    if (entries.length > 0) return formatCallHierarchy(projectRoot, "Outgoing calls", label, entries);
    const position = await resolveLanguageServerPosition(projectRoot, languageServerManager, queryInput);
    if (position) {
      try {
        const lspEntries = await languageServerManager.outgoingCalls(position.filePath, position.line, position.character);
        if (lspEntries && lspEntries.length > 0) {
          return formatCallHierarchy(projectRoot, "Outgoing calls", position.label, lspEntries, "language server");
        }
      } catch {
        // Fall through.
      }
    }
    return `No outgoing calls found for ${label}.`;
  }
  const hover = service.hover(queryInput);
  if (!hover) {
    const position = await resolveLanguageServerPosition(projectRoot, languageServerManager, queryInput);
    if (position) {
      try {
        const lspHover = await languageServerManager.hover(position.filePath, position.line, position.character);
        if (lspHover) return formatHover(projectRoot, position.label, lspHover, "language server");
      } catch {
        // Fall through to generic hover.
      }
    }
    let generic: (CodeLocation & { display: string; documentation?: string }) | null;
    try {
      generic = genericHover(projectRoot, queryInput) ?? null;
    } catch (error) {
      return codeIndexFailure("hover", projectRoot, error);
    }
    if (!generic) return `No hover information found for ${label}.`;
    return formatHover(projectRoot, label, generic, "generic lexical code index");
  }
  return formatHover(projectRoot, label, hover);
}

export const lspQueryTool: ExecutableToolDefinition = buildTool({
  name: "lsp_query",
  description: "Queries code symbols, workspace-wide symbol search, definitions, references, hover, implementation, and call hierarchy without creating a separate coding runtime. TypeScript/JavaScript use the semantic TypeScript language service. Python uses Pyright language-server symbols when available; Rust/Go/Java/Swift/Kotlin/C++ use their language server when available. Unavailable servers fall back to a generic lexical multi-language code index where possible, so this is no longer semantic TS/JS-only.",
  params: {
    query: {
      type: "string",
      description: "symbols, workspace_symbols, definition, implementation, references, hover, call_hierarchy, incoming_calls, or outgoing_calls.",
    },
    file_path: {
      type: "string",
      description: "Absolute file path for symbols query.",
      optional: true,
    },
    symbol: {
      type: "string",
      description: "Symbol name for definition, references, or hover queries.",
      optional: true,
    },
    line: {
      type: "number",
      description: "1-based line for position-based definition, references, or hover queries.",
      optional: true,
    },
    character: {
      type: "number",
      description: "1-based character for position-based definition, references, or hover queries.",
      optional: true,
    },
  },
  handler,
  isConcurrencySafe: true,
  isReadOnly: true,
  capabilities: ["fs.read"],
});
