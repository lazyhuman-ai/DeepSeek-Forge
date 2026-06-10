import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { PermissionBroker, type ToolPolicyInput } from "../src/permissions/tool-policy.js";
import { PathSandbox } from "../src/sandbox/path-sandbox.js";
import type { SessionEvent } from "../src/streams/event-types.js";
import { enterPlanModeTool, exitPlanModeTool } from "../src/tools/built-in/plan-mode.js";
import { WorkspaceActivityManager } from "../src/workspace/activity-manager.js";

function broker(): PermissionBroker {
  return new PermissionBroker({
    nextSeq: () => 1,
    now: () => new Date(0).toISOString(),
    appendSessionEvent: () => undefined,
  });
}

function activity(events: SessionEvent[]): WorkspaceActivityManager {
  let seq = 1;
  return new WorkspaceActivityManager({
    nextSeq: () => seq++,
    now: () => new Date(0).toISOString(),
    appendSessionEvent: (_sid, event) => events.push(event),
  });
}

describe("permission grants", () => {
  it("allows granted workspace edits while still requiring sandbox success", () => {
    const b = broker();
    b.createPermissionGrant({
      sessionId: "s1",
      grantKind: "workspace_edits",
      scope: "session",
    });
    const inside = b.policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "multi_edit_file",
        description: "edit",
        params: {},
        capabilities: ["fs.write"],
      },
      args: { file_path: resolve("src/example.ts") },
      pathSandbox: new PathSandbox({ projectRoot: resolve(".") }),
    });
    expect(inside.decision).toBe("allow");
    expect(inside.reason).toContain("autopilot");

    const outside = b.policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "multi_edit_file",
        description: "edit",
        params: {},
        capabilities: ["fs.write"],
      },
      args: { file_path: "/etc/hosts" },
      pathSandbox: new PathSandbox({ projectRoot: resolve(".") }),
    });
    expect(outside.decision).not.toBe("allow");
  });

  it("allows package install only when package_install grant exists", () => {
    const b = broker();
    const base: ToolPolicyInput = {
      sessionId: "s1",
      tool: {
        name: "bash",
        description: "shell",
        params: {},
        capabilities: ["process.exec", "fs.read", "fs.write"],
      },
      args: { command: "npm install left-pad" },
      pathSandbox: new PathSandbox({ projectRoot: resolve(".") }),
    };
    expect(b.policy.evaluate(base).decision).toBe("ask");
    b.createPermissionGrant({
      sessionId: "s1",
      grantKind: "package_install",
      scope: "session",
    });
    expect(b.policy.evaluate(base).decision).toBe("allow");
  });

  it("allows wrapped workspace typecheck commands without approval", () => {
    const b = broker();
    const root = resolve(".");
    const decision = b.policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "bash",
        description: "shell",
        params: {},
        capabilities: ["process.exec", "fs.read", "fs.write"],
      },
      args: { command: `cd ${root} && npx tsc --noEmit --pretty false 2>&1` },
      pathSandbox: new PathSandbox({ projectRoot: root }),
    });
    expect(decision.decision).toBe("allow");
    expect(decision.reason).toContain("Read-only shell inspection");
  });

  it("plan mode blocks workspace-changing tools until exit", async () => {
    const b = broker();
    await enterPlanModeTool.handler({ reason: "Need to inspect first" }, "s1", { permissionBroker: b });
    expect(b.isPlanMode("s1")).toBe(true);

    const editDecision = b.policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "edit_file",
        description: "edit",
        params: {},
        capabilities: ["fs.write"],
      },
      args: { file_path: resolve("src/example.ts") },
      pathSandbox: new PathSandbox({ projectRoot: resolve(".") }),
    });
    expect(editDecision.decision).toBe("deny");
    expect(editDecision.reason).toContain("Plan mode is active");

    const readDecision = b.policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "read_file",
        description: "read",
        params: {},
        isReadOnly: true,
        capabilities: ["fs.read"],
      },
      args: { file_path: resolve("src/example.ts") },
      pathSandbox: new PathSandbox({ projectRoot: resolve(".") }),
    });
    expect(readDecision.decision).toBe("allow");

    await exitPlanModeTool.handler({ plan: "Edit the file and run checks." }, "s1", { permissionBroker: b });
    expect(b.isPlanMode("s1")).toBe(false);
    expect(b.listPermissionGrants("s1").map((grant) => grant.grantKind).sort()).toEqual(["safe_commands", "workspace_edits"]);
  });

  it("exit_plan_mode records safe workspace autopilot grants by default", async () => {
    const b = broker();
    const events: SessionEvent[] = [];
    const result = await exitPlanModeTool.handler(
      { plan: "Edit files and run tests." },
      "s1",
      {
        permissionBroker: b,
        workspaceActivity: activity(events),
        branchId: "branch-a",
      },
    );

    expect(String(result)).toContain("Workspace autopilot is enabled");
    expect(b.listPermissionGrants("s1")).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({
      type: "permission_grant_event",
      grantKind: "workspace_edits",
      scope: "session",
      message: expect.stringContaining("plan approval"),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "permission_grant_event",
      grantKind: "safe_commands",
      scope: "session",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity_event",
      title: "Plan mode exited",
      payload: expect.objectContaining({
        grantWorkspaceAutopilot: true,
        grants: ["workspace_edits", "safe_commands"],
      }),
    }));
  });

  it("exit_plan_mode can opt out of autopilot grants", async () => {
    const b = broker();
    const result = await exitPlanModeTool.handler(
      { plan: "Only explain the findings.", grant_workspace_autopilot: false },
      "s1",
      { permissionBroker: b },
    );

    expect(String(result)).toContain("normal permissions");
    expect(b.listPermissionGrants("s1")).toEqual([]);
  });

  it("exit_plan_mode can scope autopilot grants to the active branch and avoids duplicates", async () => {
    const b = broker();
    await exitPlanModeTool.handler(
      { plan: "Edit branch files.", grant_scope: "branch" },
      "s1",
      { permissionBroker: b, branchId: "b1" },
    );
    await exitPlanModeTool.handler(
      { plan: "Continue branch files.", grant_scope: "branch" },
      "s1",
      { permissionBroker: b, branchId: "b1" },
    );

    const grants = b.listPermissionGrants("s1");
    expect(grants).toHaveLength(2);
    expect(grants.every((grant) => grant.scope === "branch" && grant.branchId === "b1")).toBe(true);
  });
});
