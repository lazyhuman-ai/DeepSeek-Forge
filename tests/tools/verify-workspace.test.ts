import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionEvent } from "../../src/streams/event-types.js";
import { PermissionBroker } from "../../src/permissions/tool-policy.js";
import { PathSandbox } from "../../src/sandbox/path-sandbox.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { ToolRuntime } from "../../src/tools/tool-runtime.js";
import { verifyWorkspaceTool } from "../../src/tools/built-in/verify-workspace.js";
import { WorkspaceActivityManager } from "../../src/workspace/activity-manager.js";
import {
  detectWorkspaceVerificationCommands,
  isSafeWorkspaceVerificationCommand,
} from "../../src/workspace/verification-commands.js";

const tmpDir = resolve("tests/tmp/verify-workspace");

function activity(events: SessionEvent[]): WorkspaceActivityManager {
  let seq = 1;
  return new WorkspaceActivityManager({
    nextSeq: () => seq++,
    now: () => new Date(0).toISOString(),
    appendSessionEvent: (_sid, event) => events.push(event),
  });
}

function writePackage(scripts: Record<string, string>): void {
  writeFileSync(resolve(tmpDir, "package.json"), JSON.stringify({ scripts }, null, 2));
}

beforeEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("verify_workspace", () => {
  it("runs detected safe checks and records verification events", async () => {
    writePackage({ typecheck: "node -e \"console.log('ok')\"" });
    const events: SessionEvent[] = [];

    const result = await verifyWorkspaceTool.handler(
      { level: "quick" },
      "s1",
      {
        projectRoot: tmpDir,
        workspaceActivity: activity(events),
      },
    );

    expect(String(result)).toContain("Workspace verification: passed");
    expect(String(result)).toContain("npm run typecheck");
    expect(events).toContainEqual(expect.objectContaining({
      type: "verification_event",
      command: "npm run typecheck",
      status: "passed",
    }));
  });

  it("records TypeScript diagnostics from failed verification", async () => {
    writePackage({ typecheck: "tsc --noEmit --pretty false" });
    writeFileSync(resolve(tmpDir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        types: [],
      },
      include: ["src/**/*.ts"],
    }));
    mkdirSync(resolve(tmpDir, "src"), { recursive: true });
    writeFileSync(resolve(tmpDir, "src/broken.ts"), "export const value: string = 1;\n");
    const events: SessionEvent[] = [];

    const result = await verifyWorkspaceTool.handler(
      { commands: ["npm run typecheck"] },
      "s1",
      {
        projectRoot: tmpDir,
        workspaceActivity: activity(events),
      },
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    const diagnostic = events.find((event) => event.type === "diagnostic_event");
    expect(diagnostic).toMatchObject({
      type: "diagnostic_event",
      source: "verify-workspace",
      status: "issues",
    });
    if (diagnostic?.type === "diagnostic_event") {
      expect(diagnostic.diagnostics).toContainEqual(expect.objectContaining({
        code: "TS2322",
        severity: "error",
      }));
    }
  });

  it("refuses unsafe verification commands with a readable recovery path", async () => {
    const result = await verifyWorkspaceTool.handler(
      { commands: ["npm install left-pad"] },
      "s1",
      { projectRoot: tmpDir },
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(String((result as { output?: unknown }).output)).toContain("refused to run unsafe command");
    expect(String((result as { output?: unknown }).output)).toContain("Recovery:");
  });

  it("does not fallback to npx tsc when no safe project check exists", async () => {
    const events: SessionEvent[] = [];
    const result = await verifyWorkspaceTool.handler(
      { level: "quick" },
      "s1",
      {
        projectRoot: tmpDir,
        workspaceActivity: activity(events),
      },
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    const output = String((result as { output?: unknown }).output);
    expect(output).toContain("could not find a safe project check");
    expect(output).not.toContain("npx tsc");
    expect(events).toContainEqual(expect.objectContaining({
      type: "verification_event",
      command: "verify_workspace:auto-detect",
      status: "failed",
    }));
  });

  it("detects language-native verification commands without JS-only fallback", async () => {
    writeFileSync(resolve(tmpDir, "Cargo.toml"), "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
    expect(await detectWorkspaceVerificationCommands(tmpDir, "quick")).toEqual(["cargo check"]);

    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(resolve(tmpDir, "tests"), { recursive: true });
    writeFileSync(resolve(tmpDir, "pyproject.toml"), "[tool.pytest.ini_options]\n");
    expect(await detectWorkspaceVerificationCommands(tmpDir, "quick")).toEqual(["python -m pytest"]);
  });

  it("classifies common non-JS checks as safe verification commands", () => {
    expect(isSafeWorkspaceVerificationCommand("cargo test --workspace")).toBe(true);
    expect(isSafeWorkspaceVerificationCommand("go test ./...")).toBe(true);
    expect(isSafeWorkspaceVerificationCommand("python -m ruff check .")).toBe(true);
    expect(isSafeWorkspaceVerificationCommand("python3 -m unittest discover -s tests")).toBe(true);
    expect(isSafeWorkspaceVerificationCommand("./gradlew test")).toBe(true);
    expect(isSafeWorkspaceVerificationCommand("npm install left-pad")).toBe(false);
  });

  it("runs Python verification without creating bytecode cache noise", async () => {
    mkdirSync(resolve(tmpDir, "tests"), { recursive: true });
    writeFileSync(resolve(tmpDir, "tests", "test_demo.py"), [
      "import unittest",
      "",
      "class DemoTest(unittest.TestCase):",
      "    def test_ok(self):",
      "        self.assertEqual(1 + 1, 2)",
      "",
      "if __name__ == '__main__':",
      "    unittest.main()",
      "",
    ].join("\n"));
    writeFileSync(resolve(tmpDir, "Makefile"), [
      "test:",
      "\tpython3 -m unittest discover -s tests",
      "",
    ].join("\n"));

    const result = await verifyWorkspaceTool.handler(
      { commands: ["python3 -m unittest discover -s tests"] },
      "s1",
      { projectRoot: tmpDir },
    );

    expect(String(result)).toContain("Workspace verification: passed");
    expect(String(result)).toContain("python3 -m unittest discover -s tests");
    expect(existsSync(resolve(tmpDir, "tests", "__pycache__"))).toBe(false);
  });

  it("is allowed by ToolRuntime policy for safe checks but not unsafe command payloads", async () => {
    writePackage({ typecheck: "node -e \"console.log('ok')\"" });
    const registry = new ToolRegistry();
    registry.register(verifyWorkspaceTool);
    const runtime = new ToolRuntime(registry);
    const broker = new PermissionBroker({
      nextSeq: () => 1,
      now: () => new Date(0).toISOString(),
      appendSessionEvent: () => undefined,
    });

    const allowed = await runtime.execute("verify_workspace", { commands: ["npm run typecheck"] }, "s1", {
      permissionBroker: broker,
      pathSandbox: new PathSandbox({ projectRoot: tmpDir }),
      projectRoot: tmpDir,
      source: { kind: "trigger", interactive: false },
    });
    expect(allowed.isError).toBe(false);

    const denied = await runtime.execute("verify_workspace", { commands: ["npm install left-pad"] }, "s1", {
      permissionBroker: broker,
      pathSandbox: new PathSandbox({ projectRoot: tmpDir }),
      projectRoot: tmpDir,
      source: { kind: "trigger", interactive: false },
    });
    expect(denied.isError).toBe(true);
    expect(String(denied.output)).toContain("Tool permission denied before execution.");
  });

  it("allows detected non-JS safe checks through ToolRuntime policy", async () => {
    const registry = new ToolRegistry();
    registry.register(verifyWorkspaceTool);
    const runtime = new ToolRuntime(registry);
    const broker = new PermissionBroker({
      nextSeq: () => 1,
      now: () => new Date(0).toISOString(),
      appendSessionEvent: () => undefined,
    });

    const allowed = await runtime.execute("verify_workspace", { commands: ["python3 -m unittest discover -s tests"] }, "s1", {
      permissionBroker: broker,
      pathSandbox: new PathSandbox({ projectRoot: tmpDir }),
      projectRoot: tmpDir,
      source: { kind: "trigger", interactive: false },
    });
    expect(allowed.isError).toBe(true);
    expect(String(allowed.output)).toContain("python3 -m unittest discover -s tests");
    expect(String(allowed.output)).not.toContain("Tool permission denied before execution.");
  });
});
