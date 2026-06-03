import { describe, it, expect } from "vitest";
import { ToolPolicyManager } from "../src/permissions/tool-policy.js";
import type { ToolDefinition } from "../src/tools/schemas.js";

const tool: ToolDefinition = {
  name: "bash",
  description: "Run shell",
  params: {},
  capabilities: ["process.exec"],
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
});
