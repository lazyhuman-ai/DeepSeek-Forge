import type { ToolExecutionContext } from "../../agent/tool-executor.js";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { resolveToolPath } from "./path-helper.js";
import {
  formatWorkspacePath,
  typeScriptWorkspace,
  type TypeScriptCallHierarchyEntry,
  type TypeScriptLocation,
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

function formatLocations(projectRoot: string, label: string, symbol: string, locations: TypeScriptLocation[]): string {
  if (locations.length === 0) return `No ${label.toLowerCase()} found for ${symbol}.`;
  return [
    `${label} for ${symbol}:`,
    ...locations.slice(0, 80).map((location) => {
      const line = location.text ? ` ${location.text}` : "";
      return `${formatWorkspacePath(projectRoot, location.filePath)}:${location.line}:${location.character}${line}`;
    }),
    locations.length > 80 ? `... ${locations.length - 80} more location(s)` : "",
  ].filter(Boolean).join("\n");
}

function formatGenericLocations(projectRoot: string, label: string, symbol: string, locations: TypeScriptLocation[]): string {
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

function formatCallHierarchy(projectRoot: string, label: string, symbol: string, entries: TypeScriptCallHierarchyEntry[]): string {
  if (entries.length === 0) return `No ${label.toLowerCase()} found for ${symbol}.`;
  return [
    `${label} for ${symbol}:`,
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
  if (!["symbols", "workspace_symbols", "definition", "implementation", "references", "hover", "call_hierarchy", "incoming_calls", "outgoing_calls"].includes(query)) {
    return { output: "query must be one of symbols, workspace_symbols, definition, implementation, references, hover, call_hierarchy, incoming_calls, outgoing_calls.", isError: true };
  }
  const service = typeScriptWorkspace(projectRoot);

  if (query === "workspace_symbols") {
    if (!symbol) return { output: "symbol is required for workspace_symbols query.", isError: true };
    const tsSymbols = service.workspaceSymbols(symbol);
    const genericSymbols = genericWorkspaceSymbols(projectRoot, symbol);
    const combined = dedupeSymbols([...tsSymbols, ...genericSymbols]);
    if (combined.length > 0) {
      const hasGenericOnly = genericSymbols.length > 0 && tsSymbols.length === 0;
      const formatted = formatSymbols(projectRoot, projectRoot, combined);
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
    try {
      const tsSymbols = service.fileNames().includes(resolvedPath.path)
        ? service.symbols(resolvedPath.path)
        : [];
      if (tsSymbols.length > 0) return formatSymbols(projectRoot, resolvedPath.path, tsSymbols);
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
    const generic = genericReferences(projectRoot, queryInput);
    return formatGenericLocations(projectRoot, "References", label, generic);
  }
  if (query === "definition") {
    const locations = service.definitions(queryInput);
    if (locations.length > 0) return formatLocations(projectRoot, "Definitions", label, locations);
    const generic = genericDefinitionsForInput(projectRoot, queryInput);
    return formatGenericLocations(projectRoot, "Definitions", label, generic);
  }
  if (query === "implementation") {
    const locations = service.implementations(queryInput);
    if (locations.length > 0) return formatLocations(projectRoot, "Implementations", label, locations);
    return "No implementations found. Generic code index fallback does not infer implementation relationships; use workspace_symbols, definitions, or references for lexical multi-language navigation.";
  }
  if (query === "call_hierarchy") {
    return formatCallHierarchy(projectRoot, "Call hierarchy items", label, service.callHierarchy(queryInput));
  }
  if (query === "incoming_calls") {
    return formatCallHierarchy(projectRoot, "Incoming calls", label, service.incomingCalls(queryInput));
  }
  if (query === "outgoing_calls") {
    return formatCallHierarchy(projectRoot, "Outgoing calls", label, service.outgoingCalls(queryInput));
  }
  const hover = service.hover(queryInput);
  if (!hover) {
    const generic = genericHover(projectRoot, queryInput);
    if (!generic) return `No hover information found for ${label}.`;
    return [
      `Hover for ${label} (generic lexical code index):`,
      `${formatWorkspacePath(projectRoot, generic.filePath)}:${generic.line}:${generic.character}`,
      generic.display,
      generic.documentation ? `\n${generic.documentation}` : "",
    ].filter(Boolean).join("\n");
  }
  return [
    `Hover for ${label}:`,
    `${formatWorkspacePath(projectRoot, hover.filePath)}:${hover.line}:${hover.character}`,
    hover.display,
    hover.documentation ? `\n${hover.documentation}` : "",
  ].filter(Boolean).join("\n");
}

export const lspQueryTool: ExecutableToolDefinition = buildTool({
  name: "lsp_query",
  description: "Queries code symbols, workspace-wide symbol search, definitions, references, and hover-like context without creating a separate coding runtime. TypeScript/JavaScript use the semantic TypeScript language service; Python/Rust/Go/Java/Kotlin/Swift/C-family/C#/Ruby/PHP and similar files fall back to a generic lexical multi-language code index. Implementation and call hierarchy are semantic TS/JS-only.",
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
