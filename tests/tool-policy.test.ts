import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { ToolPolicyManager } from "../src/permissions/tool-policy.js";
import { PathSandbox } from "../src/sandbox/path-sandbox.js";
import type { ToolDefinition } from "../src/tools/schemas.js";

const tool: ToolDefinition = {
  name: "bash",
  description: "Run shell",
  params: {},
  capabilities: ["process.exec"],
};

const bashTool: ToolDefinition = {
  name: "bash",
  description: "Run shell",
  params: {},
  capabilities: ["process.exec", "fs.read", "fs.write"],
};

describe("ToolPolicyManager", () => {
  it("prioritizes deny over ask over allow", () => {
    const policy = new ToolPolicyManager({
      rules: [
        { id: "allow-bash", decision: "allow", toolName: "bash", reason: "allowed" },
        { id: "ask-exec", decision: "ask", capability: "process.exec", reason: "ask first" },
        { id: "deny-rm", decision: "deny", subjectIncludes: "rm -rf", reason: "destructive command" },
      ],
    });

    const decision = policy.evaluate({
      sessionId: "s1",
      tool,
      args: { command: "rm -rf build" },
    });

    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("destructive command");
  });

  it("asks for sensitive read paths even though normal reads are allowed", () => {
    const policy = new ToolPolicyManager();
    const decision = policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "read_file",
        description: "Read",
        params: {},
        capabilities: ["fs.read"],
      },
      args: { file_path: ".env" },
    });

    expect(decision.decision).toBe("ask");
    expect(decision.reason).toContain("sensitive");
  });

  it("allows pure fs.write tools inside allowed workspace roots by default", () => {
    const policy = new ToolPolicyManager();
    const decision = policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "write_file",
        description: "Write",
        params: {},
        capabilities: ["fs.write"],
      },
      args: { file_path: resolve("src/generated.ts") },
      pathSandbox: new PathSandbox({ projectRoot: resolve(".") }),
    });

    expect(decision.decision).toBe("allow");
    expect(decision.reason).toContain("workspace roots");
  });

  it("still asks for pure fs.write tools outside allowed workspace roots", () => {
    const policy = new ToolPolicyManager();
    const decision = policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "write_file",
        description: "Write",
        params: {},
        capabilities: ["fs.write"],
      },
      args: { file_path: "/tmp/forge-policy-outside.txt" },
      pathSandbox: new PathSandbox({ projectRoot: resolve(".") }),
    });

    expect(decision.decision).toBe("ask");
  });

  it("allows common read-only bash inspection commands inside the workspace", () => {
    const policy = new ToolPolicyManager();
    const pathSandbox = new PathSandbox({ projectRoot: resolve(".") });

    for (const command of [
      "pwd",
      "ls -la src",
      "cd src && find . -maxdepth 2 -type f | head -n 20",
      "rg \"ToolPolicyManager\" src tests",
      "git status --short",
      "git diff -- src/permissions/tool-policy.ts",
      "npm test",
      "npm test -- --runInBand",
      "npm run typecheck -- --pretty=false",
      "npx --no-install tsc --noEmit --pretty=false",
      "cargo check",
      "go test ./...",
      "python -m pytest",
      "sed -n '1,20p' src/permissions/tool-policy.ts",
    ]) {
      const decision = policy.evaluate({
        sessionId: "s1",
        tool: bashTool,
        args: { command },
        pathSandbox,
      });

      expect(decision.decision, command).toBe("allow");
    }
  });

  it("still asks for bash commands that can write, escape, or run unclassified work", () => {
    const policy = new ToolPolicyManager();
    const pathSandbox = new PathSandbox({ projectRoot: resolve(".") });

    for (const command of [
      "find . -name '*.ts' -delete",
      "ls src > files.txt",
      "cd /tmp && ls",
      "git checkout main",
      "ls $(pwd)",
      "sed -i 's/a/b/' src/app.ts",
      "sed -n '1,20p' /tmp/outside.txt",
      "npm run deploy -- --prod",
    ]) {
      const decision = policy.evaluate({
        sessionId: "s1",
        tool: bashTool,
        args: { command },
        pathSandbox,
      });

      expect(decision.decision, command).toBe("ask");
    }
  });

  it("asks for overly complex compound shell commands instead of trying to auto-prove safety", () => {
    const policy = new ToolPolicyManager();
    const pathSandbox = new PathSandbox({ projectRoot: resolve(".") });
    const manySegments = Array.from({ length: 55 }, () => "pwd").join(" && ");
    const veryLongCommand = `echo ${"x".repeat(8_100)}`;

    for (const command of [manySegments, veryLongCommand]) {
      const decision = policy.evaluate({
        sessionId: "s1",
        tool: bashTool,
        args: { command },
        pathSandbox,
      });

      expect(decision.decision, command.slice(0, 120)).toBe("ask");
    }
  });

  it("dangerous free mode bypasses approval prompts but not explicit deny rules", () => {
    const policy = new ToolPolicyManager({
      rules: [
        { id: "deny-rm", decision: "deny", subjectIncludes: "rm -rf /", reason: "blocked" },
        { id: "ask-exec", decision: "ask", capability: "process.exec", reason: "ask first" },
      ],
    });
    policy.setDangerouslyAllowAllTools("s1", true);

    const allowed = policy.evaluate({
      sessionId: "s1",
      tool,
      args: { command: "npm test" },
    });
    expect(allowed.decision).toBe("allow");
    expect(allowed.reason).toContain("Dangerous free mode");

    const denied = policy.evaluate({
      sessionId: "s1",
      tool,
      args: { command: "rm -rf /" },
    });
    expect(denied.decision).toBe("deny");
  });

  it("allows workspace write tools by default while sandbox remains responsible for path boundaries", () => {
    const policy = new ToolPolicyManager();
    const decision = policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "write_file",
        description: "Write",
        params: {},
        capabilities: ["fs.write"],
      },
      args: { file_path: "notes.md", content: "ok" },
    });

    expect(decision.decision).toBe("allow");
    expect(decision.reason).toContain("PathSandbox");
  });

  it("allows safe shell commands but asks for package installation", () => {
    const policy = new ToolPolicyManager();

    const safe = policy.evaluate({
      sessionId: "s1",
      tool,
      args: { command: "npm run typecheck" },
    });
    expect(safe.decision).toBe("allow");

    const risky = policy.evaluate({
      sessionId: "s1",
      tool,
      args: { command: "npm install left-pad" },
    });
    expect(risky.decision).toBe("ask");
    expect(risky.reason).toContain("package installation");
  });

  it("lets agents install extension packages but asks before enabling runtime capability", () => {
    const policy = new ToolPolicyManager();

    const skillInstall = policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "extension_install",
        description: "Install extension",
        params: {},
        capabilities: ["extension.install"],
      },
      args: { install_input: { kind: "skill", name: "research" } },
    });
    expect(skillInstall.decision).toBe("allow");

    const mcpInstallDisabled = policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "extension_install",
        description: "Install extension",
        params: {},
        capabilities: ["extension.install"],
      },
      args: { install_input: { kind: "mcp_catalog", catalogId: "filesystem" } },
    });
    expect(mcpInstallDisabled.decision).toBe("allow");

    const mcpInstallEnabled = policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "extension_install",
        description: "Install extension",
        params: {},
        capabilities: ["extension.install"],
      },
      args: { install_input: { kind: "mcp_catalog", catalogId: "filesystem", enable: true } },
    });
    expect(mcpInstallEnabled.decision).toBe("ask");

    const skillEnable = policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "extension_enable",
        description: "Enable extension",
        params: {},
        capabilities: ["extension.manage"],
      },
      args: { kind: "skill", id_or_name: "research" },
    });
    expect(skillEnable.decision).toBe("allow");

    const enable = policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "extension_enable",
        description: "Enable extension",
        params: {},
        capabilities: ["extension.manage"],
      },
      args: { kind: "mcp_server", id_or_name: "filesystem" },
    });
    expect(enable.decision).toBe("ask");
  });
});
