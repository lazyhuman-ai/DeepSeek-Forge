import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionEvent } from "../../src/streams/event-types.js";
import { lspDiagnosticsTool } from "../../src/tools/built-in/lsp-diagnostics.js";
import { lspQueryTool } from "../../src/tools/built-in/lsp-query.js";
import { clearTypeScriptWorkspaceServices } from "../../src/workspace/typescript-service.js";
import { clearWorkspaceLanguageServerManagers } from "../../src/workspace/language-server-manager.js";
import { WorkspaceActivityManager } from "../../src/workspace/activity-manager.js";

const tmpDir = resolve("tests/tmp/lsp-tools");

function activity(events: SessionEvent[]): WorkspaceActivityManager {
  let seq = 1;
  return new WorkspaceActivityManager({
    nextSeq: () => seq++,
    now: () => new Date(0).toISOString(),
    appendSessionEvent: (_sid, event) => events.push(event),
  });
}

function writeProject(files: Record<string, string>): void {
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(resolve(tmpDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
      noEmit: true,
    },
    include: ["src/**/*.ts"],
  }));
  mkdirSync(resolve(tmpDir, "src"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(resolve(tmpDir, "src", name), content);
  }
}

beforeEach(() => {
  clearTypeScriptWorkspaceServices();
  clearWorkspaceLanguageServerManagers();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  clearTypeScriptWorkspaceServices();
  clearWorkspaceLanguageServerManagers();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("lsp tools", () => {
  it("advertises semantic TypeScript plus generic multi-language code navigation", () => {
    expect(lspQueryTool.description).toContain("TypeScript/JavaScript use the semantic TypeScript language service");
    expect(lspQueryTool.description).toContain("Python uses Pyright language-server symbols when available");
    expect(lspQueryTool.description).toContain("generic lexical multi-language code index");
    expect(lspQueryTool.description).toContain("semantic TS/JS-only");
  });

  it("uses TypeScript language service for symbols, definitions, references, and hover", async () => {
    writeProject({
      "math.ts": [
        "export function double(value: number): number {",
        "  return value * 2;",
        "}",
        "",
        "export const answer = double(21);",
        "",
      ].join("\n"),
    });
    const filePath = resolve(tmpDir, "src/math.ts");

    const symbols = await lspQueryTool.handler({ query: "symbols", file_path: filePath }, "s1", {
      projectRoot: tmpDir,
    });
    expect(String(symbols)).toContain("function double");
    expect(String(symbols)).toContain("const answer");

    const definitions = await lspQueryTool.handler({ query: "definition", symbol: "double" }, "s1", {
      projectRoot: tmpDir,
    });
    expect(String(definitions)).toContain("src/math.ts:1");

    const references = await lspQueryTool.handler({ query: "references", symbol: "double" }, "s1", {
      projectRoot: tmpDir,
    });
    expect(String(references)).toContain("src/math.ts:1");
    expect(String(references)).toContain("src/math.ts:5");

    const hover = await lspQueryTool.handler({ query: "hover", file_path: filePath, line: 5, character: 23 }, "s1", {
      projectRoot: tmpDir,
    });
    expect(String(hover)).toContain("double");
    expect(String(hover)).toContain("number");
  });

  it("supports workspace symbol and implementation queries", async () => {
    writeProject({
      "types.ts": [
        "export interface Renderer {",
        "  render(): string;",
        "}",
        "",
      ].join("\n"),
      "impl.ts": [
        "import type { Renderer } from './types';",
        "export class HtmlRenderer implements Renderer {",
        "  render(): string {",
        "    return '<main />';",
        "  }",
        "}",
        "",
      ].join("\n"),
    });

    const workspaceSymbols = await lspQueryTool.handler({ query: "workspace_symbols", symbol: "HtmlRenderer" }, "s1", {
      projectRoot: tmpDir,
    });
    expect(String(workspaceSymbols)).toContain("class HtmlRenderer");

    const implementation = await lspQueryTool.handler({ query: "implementation", symbol: "Renderer" }, "s1", {
      projectRoot: tmpDir,
    });
    expect(String(implementation)).toContain("src/impl.ts:2");
    expect(String(implementation)).toContain("HtmlRenderer");
  });

  it("supports TypeScript call hierarchy queries", async () => {
    writeProject({
      "calls.ts": [
        "export function leaf(): string {",
        "  return 'leaf';",
        "}",
        "",
        "export function middle(): string {",
        "  return leaf();",
        "}",
        "",
        "export function root(): string {",
        "  return middle();",
        "}",
        "",
      ].join("\n"),
    });

    const hierarchy = await lspQueryTool.handler({ query: "call_hierarchy", symbol: "middle" }, "s1", {
      projectRoot: tmpDir,
    });
    expect(String(hierarchy)).toContain("Call hierarchy items for middle");
    expect(String(hierarchy)).toContain("function middle");

    const incoming = await lspQueryTool.handler({ query: "incoming_calls", symbol: "middle" }, "s1", {
      projectRoot: tmpDir,
    });
    expect(String(incoming)).toContain("Incoming calls for middle");
    expect(String(incoming)).toContain("function root");

    const outgoing = await lspQueryTool.handler({ query: "outgoing_calls", symbol: "middle" }, "s1", {
      projectRoot: tmpDir,
    });
    expect(String(outgoing)).toContain("Outgoing calls for middle");
    expect(String(outgoing)).toContain("function leaf");
  });

  it("records structured diagnostics from TypeScript language service", async () => {
    writeProject({
      "broken.ts": [
        "export const label: string = 42;",
        "",
      ].join("\n"),
    });
    const events: SessionEvent[] = [];

    const result = await lspDiagnosticsTool.handler({}, "s1", {
      projectRoot: tmpDir,
      workspaceActivity: activity(events),
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(String((result as { output?: unknown }).output ?? result)).toContain("TS2322");
    const diagnosticEvent = events.find((event) => event.type === "diagnostic_event");
    expect(diagnosticEvent).toMatchObject({
      type: "diagnostic_event",
      source: "workspace-language-server",
      status: "issues",
    });
    if (diagnosticEvent?.type === "diagnostic_event") {
      expect(diagnosticEvent.diagnostics[0]).toMatchObject({
        filePath: resolve(tmpDir, "src/broken.ts"),
        severity: "error",
        code: "TS2322",
      });
    }
  });

  it("does not report clean diagnostics when no TypeScript or JavaScript files exist", async () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(resolve(tmpDir, "pyproject.toml"), "[project]\nname = \"demo\"\n");
    mkdirSync(resolve(tmpDir, "tests"), { recursive: true });
    const events: SessionEvent[] = [];

    const result = await lspDiagnosticsTool.handler({}, "s1", {
      projectRoot: tmpDir,
      workspaceActivity: activity(events),
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(String((result as { output?: unknown }).output)).toContain("no TypeScript/JavaScript source files");
    expect(String((result as { output?: unknown }).output)).toContain("Detected safe workspace verification command");
    expect(String((result as { output?: unknown }).output)).toContain("python -m pytest");
    expect(events).toContainEqual(expect.objectContaining({
      type: "diagnostic_event",
      source: "workspace-language-server",
      status: "failed",
    }));
  });

  it("uses Pyright language-server symbols for Python when available", async () => {
    const oldPath = process.env.PATH;
    const binDir = resolve(tmpDir, "bin");
    mkdirSync(resolve(tmpDir, "src"), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const serverPath = resolve(binDir, "pyright-langserver");
    writeFileSync(serverPath, [
      `#!${process.execPath}`,
      "if (!process.argv.includes('--stdio')) process.exit(42);",
      "let buffer = Buffer.alloc(0);",
      "function send(id, result) {",
      "  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }));",
      "  process.stdout.write(`Content-Length: ${body.length}\\r\\n\\r\\n`);",
      "  process.stdout.write(body);",
      "}",
      "function handle(raw) {",
      "  const msg = JSON.parse(raw);",
      "  if (msg.id === undefined) return;",
      "  if (msg.method === 'initialize') return send(msg.id, { capabilities: { documentSymbolProvider: true } });",
      "  if (msg.method === 'textDocument/documentSymbol') return send(msg.id, [",
      "    { name: 'PriceCalculator', kind: 5, range: { start: { line: 5, character: 6 }, end: { line: 8, character: 0 } }, selectionRange: { start: { line: 5, character: 6 }, end: { line: 5, character: 21 } }, children: [",
      "      { name: 'subtotal', kind: 6, range: { start: { line: 6, character: 8 }, end: { line: 8, character: 0 } }, selectionRange: { start: { line: 6, character: 8 }, end: { line: 6, character: 16 } } }",
      "    ] }",
      "  ]);",
      "  return send(msg.id, null);",
      "}",
      "process.stdin.on('data', chunk => {",
      "  buffer = Buffer.concat([buffer, chunk]);",
      "  while (true) {",
      "    const end = buffer.indexOf('\\r\\n\\r\\n');",
      "    if (end < 0) return;",
      "    const header = buffer.subarray(0, end).toString('ascii');",
      "    const match = /Content-Length:\\s*(\\d+)/i.exec(header);",
      "    if (!match) return;",
      "    const len = Number(match[1]);",
      "    const start = end + 4;",
      "    if (buffer.length < start + len) return;",
      "    const body = buffer.subarray(start, start + len).toString('utf8');",
      "    buffer = buffer.subarray(start + len);",
      "    handle(body);",
      "  }",
      "});",
      "",
    ].join("\n"));
    chmodSync(serverPath, 0o755);
    const filePath = resolve(tmpDir, "src/pricing.py");
    writeFileSync(filePath, [
      "from typing import TypedDict",
      "",
      "class Item(TypedDict):",
      "    price: float",
      "",
      "class PriceCalculator:",
      "    def subtotal(self, items: list[Item]) -> float:",
      "        return sum(item['price'] for item in items)",
      "",
    ].join("\n"));
    process.env.PATH = binDir;
    try {
      const symbols = await lspQueryTool.handler({ query: "symbols", file_path: filePath }, "s1", {
        projectRoot: tmpDir,
      });

      expect(String(symbols)).toContain("Language-server symbols");
      expect(String(symbols)).toContain("PriceCalculator");
      expect(String(symbols)).toContain("subtotal");
      expect(String(symbols)).not.toContain("Generic code index");
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it("falls back to a generic multi-language code index for Python navigation when Pyright is unavailable", async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = resolve(tmpDir, "empty-bin");
    clearWorkspaceLanguageServerManagers();
    writeProject({
      "pipeline.py": [
        "class DataLoader:",
        "    def load(self):",
        "        return [1, 2, 3]",
        "",
        "def build_dataset(loader: DataLoader):",
        "    return loader.load()",
        "",
        "result = build_dataset(DataLoader())",
        "",
      ].join("\n"),
    });
    const filePath = resolve(tmpDir, "src/pipeline.py");

    try {
      const symbols = await lspQueryTool.handler({ query: "symbols", file_path: filePath }, "s1", {
        projectRoot: tmpDir,
      });
      expect(String(symbols)).toContain("Generic code index symbols");
      expect(String(symbols)).toContain("python class DataLoader");
      expect(String(symbols)).toContain("python function build_dataset");

      const workspaceSymbols = await lspQueryTool.handler({ query: "workspace_symbols", symbol: "build_dataset" }, "s1", {
        projectRoot: tmpDir,
      });
      expect(String(workspaceSymbols)).toContain("build_dataset");
      expect(String(workspaceSymbols)).toContain("generic lexical code index");

      const definition = await lspQueryTool.handler({ query: "definition", file_path: filePath, line: 8, character: 10 }, "s1", {
        projectRoot: tmpDir,
      });
      expect(String(definition)).toContain("Definitions for");
      expect(String(definition)).toContain("src/pipeline.py:5");

      const references = await lspQueryTool.handler({ query: "references", symbol: "DataLoader" }, "s1", {
        projectRoot: tmpDir,
      });
      expect(String(references)).toContain("References for DataLoader");
      expect(String(references)).toContain("src/pipeline.py:1");
      expect(String(references)).toContain("src/pipeline.py:8");

      const hover = await lspQueryTool.handler({ query: "hover", file_path: filePath, line: 8, character: 10 }, "s1", {
        projectRoot: tmpDir,
      });
      expect(String(hover)).toContain("Generic code index symbol build_dataset");
      expect(String(hover)).toContain("not a language-server semantic hover");
    } finally {
      process.env.PATH = oldPath;
    }
  });
});
