import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import * as ts from "typescript";
import type { Diagnostic } from "../streams/event-types.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);
const SKIP_DIRS = new Set([
  ".git",
  ".forge",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "claude-code",
]);

type ScriptRecord = {
  version: string;
  snapshot: ts.IScriptSnapshot;
};

export type TypeScriptWorkspaceDiagnostic = Diagnostic;

export type TypeScriptSymbol = {
  name: string;
  kind: string;
  filePath: string;
  line: number;
  character: number;
  containerName?: string;
};

export type TypeScriptLocation = {
  filePath: string;
  line: number;
  character: number;
  text: string;
};

export type TypeScriptHover = {
  filePath: string;
  line: number;
  character: number;
  display: string;
  documentation?: string;
};

export type TypeScriptCallHierarchyEntry = {
  name: string;
  kind: string;
  filePath: string;
  line: number;
  character: number;
  text: string;
};

function walkSourceFiles(root: string, files: string[] = []): string[] {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = readdirSync(root, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".d.ts") {
      if (SKIP_DIRS.has(entry.name)) continue;
    }
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkSourceFiles(fullPath, files);
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

function lineText(filePath: string, line: number): string {
  try {
    const content = ts.sys.readFile(filePath) ?? "";
    return content.split(/\r?\n/)[line - 1]?.trim() ?? "";
  } catch {
    return "";
  }
}

function formatDiagnosticMessage(message: string | ts.DiagnosticMessageChain): string {
  return ts.flattenDiagnosticMessageText(message, "\n");
}

function severity(category: ts.DiagnosticCategory): Diagnostic["severity"] {
  if (category === ts.DiagnosticCategory.Error) return "error";
  if (category === ts.DiagnosticCategory.Warning) return "warning";
  return "info";
}

function locationForDiagnostic(diagnostic: ts.Diagnostic): {
  filePath?: string;
  line?: number;
  character?: number;
} {
  if (!diagnostic.file || diagnostic.start === undefined) return {};
  const pos = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return {
    filePath: diagnostic.file.fileName,
    line: pos.line + 1,
    character: pos.character + 1,
  };
}

function toWorkspaceDiagnostic(diagnostic: ts.Diagnostic): TypeScriptWorkspaceDiagnostic {
  return {
    ...locationForDiagnostic(diagnostic),
    severity: severity(diagnostic.category),
    source: "typescript-language-service",
    code: `TS${diagnostic.code}`,
    message: formatDiagnosticMessage(diagnostic.messageText),
  };
}

function stableFileList(files: string[]): string {
  return files.slice().sort().join("\n");
}

function getWordAt(sourceFile: ts.SourceFile, line: number, character: number): string | undefined {
  const position = sourceFile.getPositionOfLineAndCharacter(line - 1, character - 1);
  const text = sourceFile.getFullText();
  let start = position;
  let end = position;
  while (start > 0 && /[$\w]/.test(text[start - 1] ?? "")) start--;
  while (end < text.length && /[$\w]/.test(text[end] ?? "")) end++;
  const word = text.slice(start, end);
  return word || undefined;
}

function findSymbolPosition(service: ts.LanguageService, fileNames: string[], symbol: string): {
  filePath: string;
  position: number;
} | undefined {
  for (const filePath of fileNames) {
    const source = service.getProgram()?.getSourceFile(filePath);
    if (!source) continue;
    const text = source.getFullText();
    const pattern = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const position = match.index;
      const definitions = service.getDefinitionAtPosition(filePath, position);
      if (definitions && definitions.length > 0) return { filePath, position };
    }
  }
  return undefined;
}

function sourceFilePosition(service: ts.LanguageService, filePath: string, line: number, character: number): number | undefined {
  const source = service.getProgram()?.getSourceFile(filePath);
  if (!source) return undefined;
  return source.getPositionOfLineAndCharacter(Math.max(0, line - 1), Math.max(0, character - 1));
}

function locationFromSpan(service: ts.LanguageService, fileName: string, textSpan: ts.TextSpan): TypeScriptLocation {
  const source = service.getProgram()?.getSourceFile(fileName);
  const pos = source?.getLineAndCharacterOfPosition(textSpan.start);
  const line = pos ? pos.line + 1 : 1;
  const character = pos ? pos.character + 1 : 1;
  return {
    filePath: fileName,
    line,
    character,
    text: lineText(fileName, line),
  };
}

function callHierarchyEntry(service: ts.LanguageService, item: ts.CallHierarchyItem): TypeScriptCallHierarchyEntry {
  const source = service.getProgram()?.getSourceFile(item.file);
  const pos = source?.getLineAndCharacterOfPosition(item.selectionSpan.start);
  const line = pos ? pos.line + 1 : 1;
  const character = pos ? pos.character + 1 : 1;
  return {
    name: item.name,
    kind: item.kind,
    filePath: item.file,
    line,
    character,
    text: lineText(item.file, line),
  };
}

export class TypeScriptWorkspaceService {
  readonly projectRoot: string;
  #service: ts.LanguageService;
  #compilerOptions: ts.CompilerOptions;
  #fileNames: string[];
  #scriptCache = new Map<string, ScriptRecord>();
  #configPath: string | undefined = undefined;
  #fileListSignature = "";
  #configMtimeMs = 0;

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
    const loaded = this.#loadProject();
    this.#compilerOptions = loaded.compilerOptions;
    this.#fileNames = loaded.fileNames;
    this.#configPath = loaded.configPath;
    this.#fileListSignature = stableFileList(this.#fileNames);
    this.#configMtimeMs = this.#configPath && existsSync(this.#configPath)
      ? statSync(this.#configPath).mtimeMs
      : 0;
    this.#service = ts.createLanguageService(this.#host(), ts.createDocumentRegistry());
  }

  #loadProject(): {
    compilerOptions: ts.CompilerOptions;
    fileNames: string[];
    configPath: string | undefined;
  } {
    const configCandidate = join(this.projectRoot, "tsconfig.json");
    const configPath = existsSync(configCandidate) ? configCandidate : undefined;
    if (configPath) {
      const config = ts.readConfigFile(configPath, ts.sys.readFile);
      if (!config.error) {
        const parsed = ts.parseJsonConfigFileContent(
          config.config,
          ts.sys,
          dirname(configPath),
          undefined,
          configPath,
        );
        const fileNames = parsed.fileNames.filter((file) => SOURCE_EXTENSIONS.has(extname(file).toLowerCase()));
        return {
          compilerOptions: parsed.options,
          fileNames,
          configPath,
        };
      }
    }
    return {
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
        strict: true,
        noEmit: true,
      },
      fileNames: walkSourceFiles(this.projectRoot),
      configPath: undefined,
    };
  }

  #host(): ts.LanguageServiceHost {
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => this.#compilerOptions,
      getScriptFileNames: () => this.#fileNames,
      getScriptVersion: (fileName) => this.#script(fileName).version,
      getScriptSnapshot: (fileName) => this.#script(fileName).snapshot,
      getCurrentDirectory: () => this.projectRoot,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      getNewLine: () => ts.sys.newLine,
    };
    if (ts.sys.realpath) host.realpath = ts.sys.realpath;
    return host;
  }

  #script(fileName: string): ScriptRecord {
    const normalized = resolve(fileName);
    let version = "0";
    try {
      version = String(statSync(normalized).mtimeMs);
    } catch {
      // Let TypeScript surface the missing file through diagnostics.
    }
    const existing = this.#scriptCache.get(normalized);
    if (existing?.version === version) return existing;
    const content = ts.sys.readFile(normalized) ?? "";
    const record = {
      version,
      snapshot: ts.ScriptSnapshot.fromString(content),
    };
    this.#scriptCache.set(normalized, record);
    return record;
  }

  refresh(): void {
    const configMtimeMs = this.#configPath && existsSync(this.#configPath)
      ? statSync(this.#configPath).mtimeMs
      : 0;
    const loaded = this.#loadProject();
    const signature = stableFileList(loaded.fileNames);
    if (signature !== this.#fileListSignature || configMtimeMs !== this.#configMtimeMs) {
      this.#compilerOptions = loaded.compilerOptions;
      this.#fileNames = loaded.fileNames;
      this.#configPath = loaded.configPath;
      this.#fileListSignature = signature;
      this.#configMtimeMs = configMtimeMs;
      this.#scriptCache.clear();
    }
  }

  fileNames(): string[] {
    this.refresh();
    return this.#fileNames.slice();
  }

  diagnostics(): TypeScriptWorkspaceDiagnostic[] {
    this.refresh();
    const diagnostics: TypeScriptWorkspaceDiagnostic[] = [];
    diagnostics.push(...this.#service.getCompilerOptionsDiagnostics().map(toWorkspaceDiagnostic));
    for (const fileName of this.#fileNames) {
      diagnostics.push(...this.#service.getSyntacticDiagnostics(fileName).map(toWorkspaceDiagnostic));
      diagnostics.push(...this.#service.getSemanticDiagnostics(fileName).map(toWorkspaceDiagnostic));
      diagnostics.push(...this.#service.getSuggestionDiagnostics(fileName).map(toWorkspaceDiagnostic));
    }
    return diagnostics;
  }

  symbols(filePath: string): TypeScriptSymbol[] {
    this.refresh();
    const absolute = resolve(filePath);
    const navTree = this.#service.getNavigationTree(absolute);
    const output: TypeScriptSymbol[] = [];
    const visit = (item: ts.NavigationTree, containerName?: string): void => {
      for (const span of item.spans) {
        const source = this.#service.getProgram()?.getSourceFile(absolute);
        if (!source) continue;
        const pos = source.getLineAndCharacterOfPosition(span.start);
        output.push({
          name: item.text,
          kind: item.kind,
          filePath: absolute,
          line: pos.line + 1,
          character: pos.character + 1,
          ...(containerName ? { containerName } : {}),
        });
      }
      for (const child of item.childItems ?? []) visit(child, item.text);
    };
    for (const child of navTree.childItems ?? []) visit(child);
    return output;
  }

  workspaceSymbols(query: string): TypeScriptSymbol[] {
    this.refresh();
    const items = this.#service.getNavigateToItems(query, 80, undefined, false);
    return items.map((item) => {
      const source = this.#service.getProgram()?.getSourceFile(item.fileName);
      const pos = source?.getLineAndCharacterOfPosition(item.textSpan.start);
      return {
        name: item.name,
        kind: item.kind,
        filePath: item.fileName,
        line: pos ? pos.line + 1 : 1,
        character: pos ? pos.character + 1 : 1,
        ...(item.containerName ? { containerName: item.containerName } : {}),
      };
    });
  }

  resolvePosition(input: { filePath?: string; line?: number; character?: number; symbol?: string }): {
    filePath: string;
    position: number;
    symbol?: string;
  } | undefined {
    this.refresh();
    if (input.filePath && input.line !== undefined && input.character !== undefined) {
      const filePath = resolve(input.filePath);
      const position = sourceFilePosition(this.#service, filePath, input.line, input.character);
      if (position === undefined) return undefined;
      const source = this.#service.getProgram()?.getSourceFile(filePath);
      const word = source ? getWordAt(source, input.line, input.character) : input.symbol;
      return { filePath, position, ...(word ? { symbol: word } : {}) };
    }
    if (input.symbol) {
      const found = findSymbolPosition(this.#service, this.#fileNames, input.symbol);
      if (found) return { ...found, symbol: input.symbol };
    }
    return undefined;
  }

  definitions(input: { filePath?: string; line?: number; character?: number; symbol?: string }): TypeScriptLocation[] {
    const position = this.resolvePosition(input);
    if (!position) return [];
    const definitions = this.#service.getDefinitionAtPosition(position.filePath, position.position) ?? [];
    return definitions.map((definition) => locationFromSpan(this.#service, definition.fileName, definition.textSpan));
  }

  implementations(input: { filePath?: string; line?: number; character?: number; symbol?: string }): TypeScriptLocation[] {
    const position = this.resolvePosition(input);
    if (!position) return [];
    const implementations = this.#service.getImplementationAtPosition(position.filePath, position.position) ?? [];
    return implementations.map((implementation) => locationFromSpan(this.#service, implementation.fileName, implementation.textSpan));
  }

  references(input: { filePath?: string; line?: number; character?: number; symbol?: string }): TypeScriptLocation[] {
    const position = this.resolvePosition(input);
    if (!position) return [];
    const references = this.#service.getReferencesAtPosition(position.filePath, position.position) ?? [];
    return references.map((reference) => locationFromSpan(this.#service, reference.fileName, reference.textSpan));
  }

  hover(input: { filePath?: string; line?: number; character?: number; symbol?: string }): TypeScriptHover | undefined {
    const position = this.resolvePosition(input);
    if (!position) return undefined;
    const info = this.#service.getQuickInfoAtPosition(position.filePath, position.position);
    if (!info) return undefined;
    const source = this.#service.getProgram()?.getSourceFile(position.filePath);
    const pos = source?.getLineAndCharacterOfPosition(info.textSpan.start);
    const line = pos ? pos.line + 1 : 1;
    const character = pos ? pos.character + 1 : 1;
    const documentation = ts.displayPartsToString(info.documentation);
    return {
      filePath: position.filePath,
      line,
      character,
      display: ts.displayPartsToString(info.displayParts),
      ...(documentation ? { documentation } : {}),
    };
  }

  callHierarchy(input: { filePath?: string; line?: number; character?: number; symbol?: string }): TypeScriptCallHierarchyEntry[] {
    const position = this.resolvePosition(input);
    if (!position) return [];
    const prepared = this.#service.prepareCallHierarchy(position.filePath, position.position);
    const items = Array.isArray(prepared) ? prepared : prepared ? [prepared] : [];
    return items.map((item) => callHierarchyEntry(this.#service, item));
  }

  incomingCalls(input: { filePath?: string; line?: number; character?: number; symbol?: string }): TypeScriptCallHierarchyEntry[] {
    const position = this.resolvePosition(input);
    if (!position) return [];
    const calls = this.#service.provideCallHierarchyIncomingCalls(position.filePath, position.position) ?? [];
    return calls.map((call) => callHierarchyEntry(this.#service, call.from));
  }

  outgoingCalls(input: { filePath?: string; line?: number; character?: number; symbol?: string }): TypeScriptCallHierarchyEntry[] {
    const position = this.resolvePosition(input);
    if (!position) return [];
    const calls = this.#service.provideCallHierarchyOutgoingCalls(position.filePath, position.position) ?? [];
    return calls.map((call) => callHierarchyEntry(this.#service, call.to));
  }
}

const services = new Map<string, TypeScriptWorkspaceService>();

export function typeScriptWorkspace(projectRoot: string): TypeScriptWorkspaceService {
  const normalized = resolve(projectRoot);
  const existing = services.get(normalized);
  if (existing) return existing;
  const service = new TypeScriptWorkspaceService(normalized);
  services.set(normalized, service);
  return service;
}

export function clearTypeScriptWorkspaceServices(): void {
  services.clear();
}

export function formatWorkspacePath(projectRoot: string, filePath: string): string {
  const rel = relative(resolve(projectRoot), resolve(filePath));
  return rel.startsWith("..") ? filePath : rel;
}
