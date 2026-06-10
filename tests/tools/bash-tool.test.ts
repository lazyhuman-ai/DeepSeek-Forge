import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { bashTool } from "../../src/tools/built-in/bash-tool.js";
import { taskKillTool } from "../../src/tools/built-in/task-kill.js";
import { taskOutputTool } from "../../src/tools/built-in/task-output.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { ToolRuntime } from "../../src/tools/tool-runtime.js";
import { PermissionBroker } from "../../src/permissions/tool-policy.js";
import { PathSandbox } from "../../src/sandbox/path-sandbox.js";
import { WorkspaceActivityManager } from "../../src/workspace/activity-manager.js";
import type { SessionEvent } from "../../src/streams/event-types.js";

const tmpDir = resolve("tests/tmp/bash-tool");

function activity(events: SessionEvent[]): WorkspaceActivityManager {
  let seq = 1;
  return new WorkspaceActivityManager({
    nextSeq: () => seq++,
    now: () => new Date(0).toISOString(),
    appendSessionEvent: (_sid, event) => events.push(event),
  });
}

beforeEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  delete process.env.FORGE_SHELL_STALL_MS;
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("bash", () => {
  it("executes a simple command", async () => {
    const result = await bashTool.handler(
      { command: "echo hello world" },
      "s1",
    );
    expect(result).toContain("hello world");
  });

  it("returns output for stderr", async () => {
    const result = await bashTool.handler(
      { command: "echo error >&2", shell: "/bin/bash" },
      "s1",
    );
    // The command should output "error" to stderr
    // When using exec, stderr is captured and included
    expect(typeof result).toBe("string");
  });

  it("declares process and filesystem capabilities for policy enforcement", () => {
    expect(bashTool.capabilities).toEqual(["process.exec", "fs.read", "fs.write"]);
  });

  it("runs common low-risk commands without prompting", async () => {
    const registry = new ToolRegistry();
    registry.register(bashTool);
    const runtime = new ToolRuntime(registry);
    const broker = new PermissionBroker({
      nextSeq: () => 1,
      now: () => new Date(0).toISOString(),
      appendSessionEvent: () => undefined,
    });

    const result = await runtime.execute("bash", { command: "echo hello" }, "s1", {
      permissionBroker: broker,
      source: { kind: "trigger", interactive: false },
    });

    expect(result.isError).toBe(false);
    expect(String(result.output)).toContain("hello");
  });

  it("is denied by ToolRuntime policy before risky execution when approval is unavailable", async () => {
    const registry = new ToolRegistry();
    registry.register(bashTool);
    const runtime = new ToolRuntime(registry);
    const broker = new PermissionBroker({
      nextSeq: () => 1,
      now: () => new Date(0).toISOString(),
      appendSessionEvent: () => undefined,
    });

    const result = await runtime.execute("bash", { command: "npm install left-pad" }, "s1", {
      permissionBroker: broker,
      source: { kind: "trigger", interactive: false },
    });

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain("Tool permission denied before execution.");
    expect(String(result.output)).toContain("Tool: bash");
    expect(String(result.output)).toContain("Requested action: process.exec, fs.read, fs.write");
    expect(String(result.output)).toContain("Command: npm install left-pad");
    expect(String(result.output)).toContain("Recovery:");
  });

  it("allows common read-only inspection commands without approval", async () => {
    const registry = new ToolRegistry();
    registry.register(bashTool);
    const runtime = new ToolRuntime(registry);
    const broker = new PermissionBroker({
      nextSeq: () => 1,
      now: () => new Date(0).toISOString(),
      appendSessionEvent: () => undefined,
    });

    const result = await runtime.execute("bash", { command: "ls src" }, "s1", {
      permissionBroker: broker,
      pathSandbox: new PathSandbox({ projectRoot: process.cwd() }),
      projectRoot: process.cwd(),
      bashSandboxMode: "disabled",
      source: { kind: "trigger", interactive: false },
    });

    expect(result.isError).toBe(false);
    expect(String(result.output)).toContain("permissions");
  });

  it("handles command failures gracefully", async () => {
    const result = await bashTool.handler(
      { command: "nonexistent_command_xyz 2>/dev/null; exit 1" },
      "s1",
    );
    expect(result).toEqual(expect.objectContaining({
      isError: true,
      output: expect.stringContaining("Command failed:"),
    }));
  });

  it("does not mark grep no-match exit code as a tool execution failure", async () => {
    const result = await bashTool.handler(
      { command: "grep missing /dev/null" },
      "s1",
    );

    expect(typeof result).toBe("string");
    expect(String(result)).toContain("no matches were found");
  });

  it("records structured TypeScript diagnostics from verification commands", async () => {
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
    writeFileSync(resolve(tmpDir, "src/broken.ts"), "export const label: string = 42;\n");
    const events: SessionEvent[] = [];

    const result = await bashTool.handler(
      { command: `cd ${tmpDir} && npx tsc --noEmit --pretty false 2>&1`, timeout: 120_000 },
      "s1",
      {
        projectRoot: tmpDir,
        workspaceActivity: activity(events),
      },
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    const diagnosticEvent = events.find((event) => event.type === "diagnostic_event");
    expect(diagnosticEvent).toMatchObject({
      type: "diagnostic_event",
      source: "bash-verification",
      status: "issues",
    });
    if (diagnosticEvent?.type === "diagnostic_event") {
      expect(diagnosticEvent.diagnostics).toContainEqual(expect.objectContaining({
        severity: "error",
        code: "TS2322",
      }));
    }
  });

  it("reads durable shell task status when the live process handle is gone", async () => {
    const events: SessionEvent[] = [
      {
        type: "shell_task_event",
        seq: 1,
        timestamp: new Date(0).toISOString(),
        sessionId: "s1",
        taskId: "task_restarted",
        action: "failed",
        command: "npm run dev",
        status: "failed",
        message: "Process restarted before this background task completed.",
        outputPreview: "last dev server line",
      },
    ];

    const result = await taskOutputTool.handler(
      { task_id: "task_restarted" },
      "s1",
      { readThread: () => events },
    );

    expect(String(result)).toContain("Task: task_restarted");
    expect(String(result)).toContain("Status: failed");
    expect(String(result)).toContain("Last known output preview:");
    expect(String(result)).toContain("last dev server line");
  });

  it("explains that a recovered shell task has no live process to kill", async () => {
    const events: SessionEvent[] = [
      {
        type: "shell_task_event",
        seq: 1,
        timestamp: new Date(0).toISOString(),
        sessionId: "s1",
        taskId: "task_restarted",
        action: "failed",
        command: "npm run dev",
        status: "failed",
        message: "Process restarted before this background task completed.",
      },
    ];

    const result = await taskKillTool.handler(
      { task_id: "task_restarted" },
      "s1",
      { readThread: () => events },
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(String((result as { output?: unknown }).output)).toContain("No live background process is available");
    expect(String((result as { output?: unknown }).output)).toContain("Latest durable status: failed");
  });

  it("records a readable stalled prompt event for background commands waiting on input", async () => {
    process.env.FORGE_SHELL_STALL_MS = "150";
    const events: SessionEvent[] = [];
    const context = {
      projectRoot: tmpDir,
      workspaceActivity: activity(events),
    };

    const started = await bashTool.handler(
      {
        command: "node -e \"process.stdout.write('Continue? '); setTimeout(() => {}, 5000)\"",
        description: "Run interactive prompt fixture",
        run_in_background: true,
        timeout: 10_000,
      },
      "s1",
      context,
    );
    const taskId = /Task:\s+(task_[a-f0-9]+)/.exec(String(started))?.[1];
    expect(taskId).toBeTruthy();

    for (let attempt = 0; attempt < 20; attempt++) {
      if (events.some((event) => (
        event.type === "shell_task_event" &&
        event.taskId === taskId &&
        event.action === "output" &&
        event.message.includes("waiting for interactive input")
      ))) break;
      await delay(50);
    }

    const stalledEvent = events.find((event) => (
      event.type === "shell_task_event" &&
      event.taskId === taskId &&
      event.action === "output"
    ));
    expect(stalledEvent).toMatchObject({
      type: "shell_task_event",
      status: "running",
    });
    if (stalledEvent?.type === "shell_task_event") {
      expect(stalledEvent.message).toContain("waiting for interactive input");
      expect(stalledEvent.message).toContain("Recovery:");
      expect(stalledEvent.outputPreview).toContain("Continue?");
    }

    const output = await taskOutputTool.handler({ task_id: taskId }, "s1");
    expect(String(output)).toContain("Warning:");
    expect(String(output)).toContain("waiting for interactive input");
    expect(String(output)).toContain("Continue?");

    const killed = await taskKillTool.handler({ task_id: taskId }, "s1", context);
    expect(String(killed)).toContain("Task killed");
  });

  it("records verification evidence when a background safe check completes", async () => {
    writeFileSync(resolve(tmpDir, "package.json"), JSON.stringify({
      scripts: {
        typecheck: "node -e \"console.log('typecheck ok')\"",
      },
    }));
    const events: SessionEvent[] = [];
    const context = {
      projectRoot: tmpDir,
      workspaceActivity: activity(events),
    };

    const started = await bashTool.handler(
      {
        command: "npm run typecheck",
        description: "Run background typecheck",
        run_in_background: true,
        timeout: 10_000,
      },
      "s1",
      context,
    );
    const taskId = /Task:\s+(task_[a-f0-9]+)/.exec(String(started))?.[1];
    expect(taskId).toBeTruthy();

    for (let attempt = 0; attempt < 40; attempt++) {
      if (events.some((event) => event.type === "verification_event" && event.command === "npm run typecheck")) break;
      await delay(50);
    }

    expect(events).toContainEqual(expect.objectContaining({
      type: "verification_event",
      command: "npm run typecheck",
      status: "passed",
      summary: expect.stringContaining("typecheck ok"),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "shell_task_event",
      taskId,
      status: "completed",
    }));
  });

  it("moves a foreground long-running command to a background task", async () => {
    writeFileSync(resolve(tmpDir, "package.json"), JSON.stringify({
      scripts: {
        typecheck: "node -e \"setTimeout(() => { console.log('late typecheck ok') }, 250)\"",
      },
    }));
    const events: SessionEvent[] = [];
    const context = {
      projectRoot: tmpDir,
      workspaceActivity: activity(events),
    };

    const result = await bashTool.handler(
      {
        command: "npm run typecheck",
        description: "Run foreground typecheck that should auto-background",
        auto_background_after_ms: 50,
        timeout: 10_000,
      },
      "s1",
      context,
    );

    const text = String(result);
    expect(text).toContain("moved to the background");
    const taskId = /Task:\s+(task_[a-f0-9]+)/.exec(text)?.[1];
    expect(taskId).toBeTruthy();
    expect(events).toContainEqual(expect.objectContaining({
      type: "shell_task_event",
      taskId,
      action: "started",
      status: "running",
      message: expect.stringContaining("moved to background"),
    }));

    for (let attempt = 0; attempt < 40; attempt++) {
      if (events.some((event) => event.type === "verification_event" && event.command === "npm run typecheck")) break;
      await delay(50);
    }

    const output = await taskOutputTool.handler({ task_id: taskId }, "s1");
    expect(String(output)).toContain("late typecheck ok");
    expect(events).toContainEqual(expect.objectContaining({
      type: "verification_event",
      command: "npm run typecheck",
      status: "passed",
      summary: expect.stringContaining("late typecheck ok"),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "shell_task_event",
      taskId,
      action: "completed",
      status: "completed",
    }));
  });
});
