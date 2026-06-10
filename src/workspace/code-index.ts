import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { buildWorkspaceFileIndex, likelyTextFile } from "./file-index.js";

const MAX_INDEX_FILES = 2_000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SYMBOLS_PER_FILE = 400;
const MAX_WORKSPACE_SYMBOLS = 200;
const MAX_REFERENCE_FILES = 500;
const MAX_REFERENCES = 200;

const CODE_EXTENSIONS = new Set([
  ".py", ".rs", ".go", ".java", ".kt", ".kts", ".swift", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".cs", ".rb", ".php",
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts",
]);

type Pattern = {
  kind: string;
  regex: RegExp;
  nameGroup?: number;
  containerGroup?: number;
};

const COMMON_PATTERNS: Pattern[] = [
  { kind: "class", regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/ },
  { kind: "interface", regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/ },
  { kind: "enum", regex: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/ },
  { kind: "function", regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/ },
  { kind: "const", regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/ },
];

const PATTERNS_BY_EXTENSION: Record<string, Pattern[]> = {
  ".py": [
    { kind: "class", regex: /^\s*class\s+([A-Za-z_]\w*)\b/ },
    { kind: "function", regex: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\b/ },
    { kind: "variable", regex: /^\s*([A-Za-z_]\w*)\s*[:=]/ },
  ],
  ".rs": [
    { kind: "function", regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)\b/ },
    { kind: "struct", regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)\b/ },
    { kind: "enum", regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)\b/ },
    { kind: "trait", regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)\b/ },
    { kind: "impl", regex: /^\s*impl(?:<[^>]+>)?\s+(?:[A-Za-z_]\w*\s+for\s+)?([A-Za-z_]\w*)\b/ },
  ],
  ".go": [
    { kind: "function", regex: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\b/ },
    { kind: "type", regex: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface|func|\w+)/ },
    { kind: "variable", regex: /^\s*(?:var|const)\s+([A-Za-z_]\w*)\b/ },
  ],
  ".java": [
    { kind: "class", regex: /^\s*(?:public|private|protected|abstract|final|static|\s)*\s*class\s+([A-Za-z_]\w*)\b/ },
    { kind: "interface", regex: /^\s*(?:public|private|protected|abstract|static|\s)*\s*interface\s+([A-Za-z_]\w*)\b/ },
    { kind: "enum", regex: /^\s*(?:public|private|protected|static|\s)*\s*enum\s+([A-Za-z_]\w*)\b/ },
    { kind: "method", regex: /^\s*(?:public|private|protected|static|final|abstract|synchronized|native|\s)+[\w<>\[\], ?]+\s+([A-Za-z_]\w*)\s*\(/ },
  ],
  ".kt": [
    { kind: "class", regex: /^\s*(?:data\s+|sealed\s+|open\s+|abstract\s+)?class\s+([A-Za-z_]\w*)\b/ },
    { kind: "interface", regex: /^\s*interface\s+([A-Za-z_]\w*)\b/ },
    { kind: "function", regex: /^\s*fun\s+(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)\s*\(/ },
    { kind: "property", regex: /^\s*(?:val|var)\s+([A-Za-z_]\w*)\b/ },
  ],
  ".kts": [
    { kind: "function", regex: /^\s*fun\s+(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)\s*\(/ },
    { kind: "property", regex: /^\s*(?:val|var)\s+([A-Za-z_]\w*)\b/ },
  ],
  ".swift": [
    { kind: "class", regex: /^\s*(?:public|private|internal|open|final|\s)*class\s+([A-Za-z_]\w*)\b/ },
    { kind: "struct", regex: /^\s*(?:public|private|internal|\s)*struct\s+([A-Za-z_]\w*)\b/ },
    { kind: "protocol", regex: /^\s*(?:public|private|internal|\s)*protocol\s+([A-Za-z_]\w*)\b/ },
    { kind: "function", regex: /^\s*(?:public|private|internal|static|class|\s)*func\s+([A-Za-z_]\w*)\b/ },
    { kind: "property", regex: /^\s*(?:public|private|internal|static|\s)*(?:let|var)\s+([A-Za-z_]\w*)\b/ },
  ],
  ".cs": [
    { kind: "class", regex: /^\s*(?:public|private|protected|internal|abstract|sealed|static|\s)*class\s+([A-Za-z_]\w*)\b/ },
    { kind: "interface", regex: /^\s*(?:public|private|protected|internal|\s)*interface\s+([A-Za-z_]\w*)\b/ },
    { kind: "method", regex: /^\s*(?:public|private|protected|internal|static|virtual|override|async|sealed|\s)+[\w<>\[\], ?]+\s+([A-Za-z_]\w*)\s*\(/ },
  ],
  ".rb": [
    { kind: "class", regex: /^\s*class\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\b/ },
    { kind: "module", regex: /^\s*module\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\b/ },
    { kind: "method", regex: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)\b/ },
  ],
  ".php": [
    { kind: "class", regex: /^\s*(?:final\s+|abstract\s+)?class\s+([A-Za-z_]\w*)\b/ },
    { kind: "interface", regex: /^\s*interface\s+([A-Za-z_]\w*)\b/ },
    { kind: "function", regex: /^\s*(?:public|private|protected|static|\s)*function\s+([A-Za-z_]\w*)\b/ },
  ],
  ".c": [],
  ".h": [],
  ".cc": [],
  ".cpp": [],
  ".cxx": [],
  ".hpp": [],
};

const C_LIKE_FUNCTION: Pattern = {
  kind: "function",
  regex: /^\s*(?:template\s*<[^>]+>\s*)?(?:static\s+|inline\s+|extern\s+|constexpr\s+|virtual\s+|friend\s+|[\w:*&<>\[\],]+\s+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:->\s*[\w:<>,*&\s]+)?[{;]/,
};

for (const ext of [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp"]) {
  PATTERNS_BY_EXTENSION[ext] = [
    { kind: "class", regex: /^\s*(?:class|struct)\s+([A-Za-z_]\w*)\b/ },
    { kind: "enum", regex: /^\s*enum(?:\s+class)?\s+([A-Za-z_]\w*)\b/ },
    C_LIKE_FUNCTION,
  ];
}

export type GenericCodeSymbol = {
  name: string;
  kind: string;
  filePath: string;
  line: number;
  character: number;
  language: string;
  text: string;
  containerName?: string;
};

export type GenericCodeLocation = {
  filePath: string;
  line: number;
  character: number;
  text: string;
};

export type GenericCodeHover = GenericCodeLocation & {
  display: string;
  documentation?: string;
};

function languageForExtension(ext: string): string {
  switch (ext) {
    case ".py": return "python";
    case ".rs": return "rust";
    case ".go": return "go";
    case ".java": return "java";
    case ".kt":
    case ".kts": return "kotlin";
    case ".swift": return "swift";
    case ".c":
    case ".h":
    case ".cc":
    case ".cpp":
    case ".cxx":
    case ".hpp": return "c-family";
    case ".cs": return "csharp";
    case ".rb": return "ruby";
    case ".php": return "php";
    default: return "generic";
  }
}

function patternsFor(filePath: string): Pattern[] {
  const ext = extname(filePath).toLowerCase();
  return [...(PATTERNS_BY_EXTENSION[ext] ?? []), ...COMMON_PATTERNS];
}

function symbolFromMatch(
  filePath: string,
  language: string,
  lineText: string,
  lineIndex: number,
  pattern: Pattern,
  match: RegExpMatchArray,
): GenericCodeSymbol | null {
  const name = match[pattern.nameGroup ?? 1];
  if (!name) return null;
  const character = Math.max(1, lineText.indexOf(name) + 1);
  const symbol: GenericCodeSymbol = {
    name,
    kind: pattern.kind,
    filePath,
    line: lineIndex + 1,
    character,
    language,
    text: lineText.trim(),
  };
  const container = pattern.containerGroup ? match[pattern.containerGroup] : undefined;
  if (container) symbol.containerName = container;
  return symbol;
}

function isIndexableCodeFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return CODE_EXTENSIONS.has(ext) && likelyTextFile(filePath);
}

function readSmallTextFile(filePath: string): string | null {
  try {
    if (statSync(filePath).size > MAX_FILE_BYTES) return null;
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

export function genericFileSymbols(filePath: string): GenericCodeSymbol[] {
  const absolute = resolve(filePath);
  if (!isIndexableCodeFile(absolute)) return [];
  const content = readSmallTextFile(absolute);
  if (content === null) return [];
  const language = languageForExtension(extname(absolute).toLowerCase());
  const patterns = patternsFor(absolute);
  const symbols: GenericCodeSymbol[] = [];
  const seen = new Set<string>();
  const lines = content.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length && symbols.length < MAX_SYMBOLS_PER_FILE; lineIndex++) {
    const line = lines[lineIndex]!;
    for (const pattern of patterns) {
      const match = line.match(pattern.regex);
      if (!match) continue;
      const symbol = symbolFromMatch(absolute, language, line, lineIndex, pattern, match);
      if (!symbol) continue;
      const key = `${symbol.kind}:${symbol.name}:${symbol.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push(symbol);
      break;
    }
  }
  return symbols;
}

function projectCodeFiles(projectRoot: string): string[] {
  const index = buildWorkspaceFileIndex(projectRoot);
  return index.files
    .filter(isIndexableCodeFile)
    .slice(0, MAX_INDEX_FILES)
    .map((file) => resolve(index.root, file));
}

export function genericWorkspaceSymbols(projectRoot: string, query: string): GenericCodeSymbol[] {
  const needle = query.toLowerCase();
  const symbols: GenericCodeSymbol[] = [];
  for (const file of projectCodeFiles(projectRoot)) {
    for (const symbol of genericFileSymbols(file)) {
      if (!needle || symbol.name.toLowerCase().includes(needle) || symbol.text.toLowerCase().includes(needle)) {
        symbols.push(symbol);
        if (symbols.length >= MAX_WORKSPACE_SYMBOLS) return symbols;
      }
    }
  }
  return symbols;
}

export function genericDefinitions(projectRoot: string, symbol: string): GenericCodeLocation[] {
  if (!symbol.trim()) return [];
  return genericWorkspaceSymbols(projectRoot, symbol)
    .filter((candidate) => candidate.name === symbol)
    .map(({ filePath, line, character, text }) => ({ filePath, line, character, text }));
}

export function genericDefinitionsForInput(
  projectRoot: string,
  input: { symbol?: string; filePath?: string; line?: number; character?: number },
): GenericCodeLocation[] {
  const symbol = input.symbol || (
    input.filePath && input.line !== undefined && input.character !== undefined
      ? symbolAtPosition(resolve(input.filePath), input.line, input.character)
      : undefined
  );
  return symbol ? genericDefinitions(projectRoot, symbol) : [];
}

function symbolAtPosition(filePath: string, line: number, character: number): string | undefined {
  const content = readSmallTextFile(filePath);
  if (content === null) return undefined;
  const textLine = content.split(/\r?\n/)[Math.max(0, line - 1)] ?? "";
  const position = Math.max(0, character - 1);
  let start = position;
  let end = position;
  while (start > 0 && /[$\w]/.test(textLine[start - 1] ?? "")) start--;
  while (end < textLine.length && /[$\w]/.test(textLine[end] ?? "")) end++;
  const word = textLine.slice(start, end);
  return word || undefined;
}

export function genericReferences(
  projectRoot: string,
  input: { symbol?: string; filePath?: string; line?: number; character?: number },
): GenericCodeLocation[] {
  const symbol = input.symbol || (
    input.filePath && input.line !== undefined && input.character !== undefined
      ? symbolAtPosition(resolve(input.filePath), input.line, input.character)
      : undefined
  );
  if (!symbol) return [];
  const pattern = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const results: GenericCodeLocation[] = [];
  for (const file of projectCodeFiles(projectRoot).slice(0, MAX_REFERENCE_FILES)) {
    const content = readSmallTextFile(file);
    if (content === null) continue;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const match = line.match(pattern);
      if (!match || match.index === undefined) continue;
      results.push({
        filePath: file,
        line: i + 1,
        character: match.index + 1,
        text: line.trim(),
      });
      if (results.length >= MAX_REFERENCES) return results;
    }
  }
  return results;
}

export function genericHover(
  projectRoot: string,
  input: { symbol?: string; filePath?: string; line?: number; character?: number },
): GenericCodeHover | undefined {
  const symbol = input.symbol || (
    input.filePath && input.line !== undefined && input.character !== undefined
      ? symbolAtPosition(resolve(input.filePath), input.line, input.character)
      : undefined
  );
  if (!symbol) return undefined;
  const definition = genericDefinitions(projectRoot, symbol)[0];
  if (definition) {
    return {
      ...definition,
      display: `Generic code index symbol ${symbol}`,
      documentation: "This is a lexical workspace index result, not a language-server semantic hover.",
    };
  }
  const reference = genericReferences(projectRoot, { symbol })[0];
  if (!reference) return undefined;
  return {
    ...reference,
    display: `Generic code index reference ${symbol}`,
    documentation: "This is a lexical workspace index result, not a language-server semantic hover.",
  };
}
