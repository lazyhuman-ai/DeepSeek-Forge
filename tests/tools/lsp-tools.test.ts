import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionEvent } from "../../src/streams/event-types.js";
import { lspDiagnosticsTool } from "../../src/tools/built-in/lsp-diagnostics.js";
import { lspQueryTool } from "../../src/tools/built-in/lsp-query.js";
import { clearTypeScriptWorkspaceServices } from "../../src/workspace/typescript-service.js";
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
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  clearTypeScriptWorkspaceServices();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("lsp tools", () => {
  it("advertises semantic TypeScript plus generic multi-language code navigation", () => {
    expect(lspQueryTool.description).toContain("TypeScript/JavaScript use the semantic TypeScript language service");
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
      source: "typescript-language-service",
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
      source: "typescript-language-service",
      status: "failed",
    }));
  });

  it("falls back to a generic multi-language code index for Python navigation", async () => {
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
  });
});
