import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectLanguage, WorkspaceLanguageServerManager } from "../src/workspace/language-server-manager.js";
import { clearTypeScriptWorkspaceServices } from "../src/workspace/typescript-service.js";

const tmpDir = resolve("tests/tmp/workspace-language-server-manager");

beforeEach(() => {
  clearTypeScriptWorkspaceServices();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(resolve(tmpDir, "src"), { recursive: true });
});

afterEach(() => {
  clearTypeScriptWorkspaceServices();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("WorkspaceLanguageServerManager", () => {
  it("tracks didOpen, didChange, and didSave lifecycle for workspace files", () => {
    const filePath = resolve(tmpDir, "src/app.ts");
    writeFileSync(filePath, "export const label = 'ok';\n");
    const manager = new WorkspaceLanguageServerManager(tmpDir);

    const opened = manager.notifyDidOpen(filePath);
    const changed = manager.notifyDidChange(filePath, "export const label = 'changed';\n");
    writeFileSync(filePath, "export const label = 'saved';\n");
    const saved = manager.notifyDidSave(filePath);
    const snapshot = manager.snapshot();

    expect(opened).toMatchObject({
      language: "typescript",
      state: "native",
      command: "typescript-language-service",
    });
    expect(changed.state).toBe("native");
    expect(saved.state).toBe("native");
    expect(snapshot.openFiles).toEqual([
      expect.objectContaining({
        filePath,
        language: "typescript",
        version: 3,
      }),
    ]);
    expect(snapshot.servers).toEqual([
      expect.objectContaining({
        language: "typescript",
        state: "native",
      }),
    ]);
  });

  it("reports non-TypeScript language server availability without throwing", () => {
    const manager = new WorkspaceLanguageServerManager(tmpDir);
    const pythonPath = resolve(tmpDir, "src/pipeline.py");
    writeFileSync(pythonPath, "print('ok')\n");

    const status = manager.notifyDidOpen(pythonPath);

    expect(detectLanguage(pythonPath)).toBe("python");
    expect(status.language).toBe("python");
    expect(["available", "unavailable"]).toContain(status.state);
    expect(status.message).toContain(status.state === "available" ? "available" : "No python language server executable");
  });

  it("can request document symbols from a real JSON-RPC language server transport", async () => {
    const oldPath = process.env.PATH;
    const binDir = resolve(tmpDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const serverPath = resolve(binDir, "pyright-langserver");
    writeFileSync(serverPath, [
      "#!/usr/bin/env node",
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
      "  if (msg.method === 'textDocument/documentSymbol') return send(msg.id, [{ name: 'FakePySymbol', kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } } }]);",
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
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    const pythonPath = resolve(tmpDir, "src/server.py");
    writeFileSync(pythonPath, "def fake_py_symbol():\n    return 1\n");
    try {
      const manager = new WorkspaceLanguageServerManager(tmpDir);
      const status = manager.statusForLanguage("python");
      const symbols = await manager.documentSymbols(pythonPath);

      expect(status).toMatchObject({
        language: "python",
        state: "available",
        command: "pyright-langserver",
      });
      expect(symbols).toEqual([
        expect.objectContaining({
          name: "FakePySymbol",
          filePath: pythonPath,
          line: 1,
          character: 1,
        }),
      ]);
      manager.dispose();
    } finally {
      process.env.PATH = oldPath;
    }
  });
});
