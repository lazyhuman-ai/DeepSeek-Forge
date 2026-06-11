import { describe, expect, it } from "vitest";
import type { ModelMessage, ModelProvider } from "../../src/agent/model-provider.js";
import type { ToolExecutor } from "../../src/agent/tool-executor.js";
import type { SessionEvent } from "../../src/streams/event-types.js";
import { agentTaskCancelTool, agentTaskOutputTool, agentTaskTool } from "../../src/tools/built-in/agent-task.js";
import type { ToolDefinition } from "../../src/tools/schemas.js";
import { WorkspaceActivityManager } from "../../src/workspace/activity-manager.js";

function activity(events: SessionEvent[]): WorkspaceActivityManager {
  let seq = 10;
  return new WorkspaceActivityManager({
    nextSeq: () => seq++,
    now: () => new Date(0).toISOString(),
    appendSessionEvent: (_sid, event) => events.push(event),
  });
}

describe("agent_task", () => {
  it("returns a readable error when no model provider is available", async () => {
    const result = await agentTaskTool.handler({ task: "verify the work" }, "s1");

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(String((result as { output?: unknown }).output)).toContain("no ModelProvider");
  });

  it("runs a read-only verifier without tools and records activity", async () => {
    const events: SessionEvent[] = [
      {
        type: "diff_event",
        seq: 1,
        timestamp: new Date(0).toISOString(),
        sessionId: "s1",
        filePath: "/repo/src/app.ts",
        operation: "updated",
        additions: 1,
        deletions: 1,
        summary: "updated app",
      },
      {
        type: "verification_event",
        seq: 2,
        timestamp: new Date(0).toISOString(),
        sessionId: "s1",
        command: "npm run typecheck",
        status: "passed",
        exitCode: 0,
        summary: "clean",
      },
    ];
    let capturedMessages: ModelMessage[] = [];
    let capturedTools: ToolDefinition[] | undefined;
    const provider: ModelProvider = {
      generate: async (messages, tools) => {
        capturedMessages = messages;
        capturedTools = tools;
        return {
          finishReason: "stop",
          text: [
            "VERDICT: PASS",
            "EVIDENCE: npm run typecheck passed after the latest diff.",
            "RISKS: No runtime test evidence.",
            "REQUIRED NEXT ACTIONS: none",
          ].join("\n"),
          rawUsage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        };
      },
    };

    const result = await agentTaskTool.handler(
      { subagent_type: "verify", task: "Verify whether the TypeScript edit is complete." },
      "s1",
      {
        modelProvider: provider,
        readThread: () => events,
        workspaceActivity: activity(events),
      },
    );

    expect(String(result)).toContain("VERDICT: PASS");
    expect(capturedTools).toBeUndefined();
    expect(capturedMessages.map((message) => message.content).join("\n")).toContain("read-only ForgeAgent workspace subagent");
    expect(capturedMessages.map((message) => message.content).join("\n")).toContain("skeptical release reviewer");
    expect(capturedMessages.map((message) => message.content).join("\n")).toContain("If evidence is missing, stale, narrow, or only implied by intent, treat it as not proven.");
    expect(capturedMessages.map((message) => message.content).join("\n")).toContain("Do not write PASS based only on source reading.");
    expect(capturedMessages.map((message) => message.content).join("\n")).toContain("Output exactly these sections: VERDICT, CHECKS, EVIDENCE, RISKS, REQUIRED NEXT ACTIONS.");
    expect(capturedMessages.map((message) => message.content).join("\n")).toContain("npm run typecheck");
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity_event",
      activityKind: "verification",
      status: "completed",
      title: "Subagent verify",
    }));
  });

  it("can use constrained read-only tools before returning a final verdict", async () => {
    const events: SessionEvent[] = [];
    let call = 0;
    const provider: ModelProvider = {
      generate: async (messages, tools) => {
        call++;
        if (call === 1) {
          expect(tools?.map((tool) => tool.name)).toEqual(["read_file"]);
          return {
            finishReason: "tool_calls",
            text: "I will inspect the file before verifying.",
            toolCalls: [{ id: "toolu_read", name: "read_file", args: { file_path: "src/app.ts" } }],
          };
        }
        expect(messages.map((message) => message.content).join("\n")).toContain("export const ok = true");
        return {
          finishReason: "stop",
          text: "VERDICT: PASS\nEVIDENCE: read_file showed the expected export.\nRISKS: No test command evidence.\nREQUIRED NEXT ACTIONS: Run a check if runtime behavior matters.",
          rawUsage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        };
      },
    };
    const toolExecutor: ToolExecutor = {
      execute: async (toolName, _args, _sessionId, context) => {
        expect(toolName).toBe("read_file");
        expect(context?.source?.interactive).toBe(false);
        return {
          toolCallId: context?.toolUseId ?? "",
          toolName,
          isError: false,
          output: "export const ok = true;",
        };
      },
    };

    const result = await agentTaskTool.handler(
      { subagent_type: "verify", task: "Verify by reading the file." },
      "s1",
      {
        modelProvider: provider,
        readThread: () => events,
        workspaceActivity: activity(events),
        toolExecutor,
        toolsProvider: () => [{
          name: "read_file",
          description: "Read a file",
          params: {},
          isReadOnly: true,
          capabilities: ["fs.read"],
        }],
      },
    );

    expect(String(result)).toContain("VERDICT: PASS");
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity_event",
      activityKind: "verification",
      payload: expect.objectContaining({
        toolMode: "read_only",
        toolCalls: [{ name: "read_file", isError: false }],
      }),
    }));
  });

  it("returns verify PARTIAL as an error tool result and records the verdict", async () => {
    const events: SessionEvent[] = [];
    const provider: ModelProvider = {
      generate: async () => ({
        finishReason: "stop",
        text: [
          "VERDICT: PARTIAL",
          "EVIDENCE: I found a diff but no check after it.",
          "RISKS: The change may be unverified.",
          "REQUIRED NEXT ACTIONS: Run verify_workspace.",
        ].join("\n"),
      }),
    };

    const result = await agentTaskTool.handler(
      { subagent_type: "verify", task: "Verify release readiness." },
      "s1",
      {
        modelProvider: provider,
        readThread: () => events,
        workspaceActivity: activity(events),
      },
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(String((result as { output?: unknown }).output)).toContain("VERDICT: PARTIAL");
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity_event",
      activityKind: "verification",
      status: "failed",
      payload: expect.objectContaining({ verdict: "PARTIAL" }),
    }));
  });

  it("accepts common Markdown VERDICT headings from verifier output", async () => {
    const events: SessionEvent[] = [];
    const provider: ModelProvider = {
      generate: async () => ({
        finishReason: "stop",
        text: [
          "## VERDICT: PASS",
          "",
          "**EVIDENCE**",
          "The latest strong check passed after the diff.",
          "",
          "**RISKS**",
          "None found.",
          "",
          "**REQUIRED NEXT ACTIONS**",
          "None.",
        ].join("\n"),
      }),
    };

    const result = await agentTaskTool.handler(
      { subagent_type: "verify", task: "Verify release readiness." },
      "s1",
      {
        modelProvider: provider,
        readThread: () => events,
        workspaceActivity: activity(events),
      },
    );

    expect(String(result)).toContain("VERDICT: PASS");
    expect((result as { isError?: boolean }).isError).not.toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity_event",
      activityKind: "verification",
      status: "completed",
      payload: expect.objectContaining({ verdict: "PASS" }),
    }));
  });

  it("normalizes split Markdown VERDICT headings from verifier output", async () => {
    const events: SessionEvent[] = [];
    const provider: ModelProvider = {
      generate: async () => ({
        finishReason: "stop",
        text: [
          "## VERDICT",
          "",
          "**PASS**",
          "",
          "## CHECKS",
          "",
          "The latest strong check passed after the diff.",
          "",
          "## EVIDENCE",
          "",
          "git_diff and verify_workspace were inspected.",
          "",
          "## RISKS",
          "",
          "None found.",
          "",
          "## REQUIRED NEXT ACTIONS",
          "",
          "None.",
        ].join("\n"),
      }),
    };

    const result = await agentTaskTool.handler(
      { subagent_type: "verify", task: "Verify release readiness." },
      "s1",
      {
        modelProvider: provider,
        readThread: () => events,
        workspaceActivity: activity(events),
      },
    );

    expect(String(result)).toContain("VERDICT: PASS");
    expect((result as { isError?: boolean }).isError).not.toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity_event",
      activityKind: "verification",
      status: "completed",
      message: expect.stringContaining("VERDICT: PASS"),
      payload: expect.objectContaining({ verdict: "PASS" }),
    }));
  });

  it("returns invalid verify output as an error instead of silently accepting it", async () => {
    const events: SessionEvent[] = [];
    const provider: ModelProvider = {
      generate: async () => ({
        finishReason: "stop",
        text: "Looks fine to me, but I did not follow the verifier schema.",
      }),
    };

    const result = await agentTaskTool.handler(
      { subagent_type: "verify", task: "Verify release readiness." },
      "s1",
      {
        modelProvider: provider,
        readThread: () => events,
        workspaceActivity: activity(events),
      },
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(String((result as { output?: unknown }).output)).toContain("did not produce a valid VERDICT");
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity_event",
      activityKind: "verification",
      status: "failed",
      payload: expect.objectContaining({ verdict: "UNKNOWN" }),
    }));
  });

  it("runs a bounded implementation subagent with only workspace write tools", async () => {
    const events: SessionEvent[] = [];
    let call = 0;
    const capturedToolNames: string[][] = [];
    const provider: ModelProvider = {
      generate: async (messages, tools) => {
        call++;
        capturedToolNames.push(tools?.map((tool) => tool.name) ?? []);
        if (call === 1) {
          expect(messages.map((message) => message.content).join("\n")).toContain("workspace implementation subagent");
          expect(messages.map((message) => message.content).join("\n")).toContain("Output exactly these sections: SUMMARY, CHANGES, CHECKS, RISKS, HANDOFF.");
          expect(tools?.some((tool) => tool.name === "edit_file")).toBe(true);
          expect(tools?.some((tool) => tool.name === "verify_workspace")).toBe(true);
          expect(tools?.some((tool) => tool.name === "extension_install")).toBe(false);
          return {
            finishReason: "tool_calls",
            text: "I will make the bounded workspace edit.",
            toolCalls: [{ id: "toolu_edit", name: "edit_file", args: { file_path: "src/app.ts", old_text: "bad", new_text: "good" } }],
          };
        }
        expect(messages.map((message) => message.content).join("\n")).toContain("updated src/app.ts");
        return {
          finishReason: "stop",
          text: [
            "SUMMARY: updated the implementation.",
            "CHANGES: src/app.ts",
            "CHECKS: not run in unit test.",
            "RISKS: no runtime check evidence.",
            "HANDOFF: main agent should verify.",
          ].join("\n"),
          rawUsage: { input_tokens: 140, output_tokens: 50, total_tokens: 190 },
        };
      },
    };
    const toolExecutor: ToolExecutor = {
      execute: async (toolName, _args, _sessionId, context) => {
        expect(toolName).toBe("edit_file");
        expect(context?.source?.interactive).toBe(false);
        return {
          toolCallId: context?.toolUseId ?? "",
          toolName,
          isError: false,
          output: "updated src/app.ts",
        };
      },
    };

    const result = await agentTaskTool.handler(
      { subagent_type: "implement", task: "Replace bad with good in src/app.ts." },
      "s1",
      {
        modelProvider: provider,
        readThread: () => events,
        workspaceActivity: activity(events),
        toolExecutor,
        toolsProvider: () => [
          {
            name: "read_file",
            description: "Read a file",
            params: {},
            isReadOnly: true,
            capabilities: ["fs.read"],
          },
          {
            name: "edit_file",
            description: "Edit a file",
            params: {},
            isReadOnly: false,
            capabilities: ["fs.write"],
          },
          {
            name: "verify_workspace",
            description: "Verify workspace",
            params: {},
            isReadOnly: true,
            capabilities: ["process.exec"],
          },
          {
            name: "extension_install",
            description: "Install extension",
            params: {},
            isReadOnly: false,
            capabilities: ["extension.install"],
          },
        ],
      },
    );

    expect(String(result)).toContain("SUMMARY: updated");
    expect(capturedToolNames[0]).toEqual(["read_file", "edit_file", "verify_workspace"]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity_event",
      activityKind: "change",
      title: "Subagent implement",
      payload: expect.objectContaining({
        subagentType: "implement",
        toolMode: "workspace_write",
        toolCalls: [{ name: "edit_file", isError: false }],
      }),
    }));
  });

  it("rejects non-workspace tools requested by implementation subagents", async () => {
    const events: SessionEvent[] = [];
    let call = 0;
    const provider: ModelProvider = {
      generate: async (messages, tools) => {
        call++;
        if (call === 1) {
          expect(tools?.some((tool) => tool.name === "extension_install")).toBe(false);
          return {
            finishReason: "tool_calls",
            text: "I will try an extension install.",
            toolCalls: [{ id: "toolu_ext", name: "extension_install", args: { query: "demo" } }],
          };
        }
        expect(messages.map((message) => message.content).join("\n")).toContain("not in the workspace_write subagent allowlist");
        return {
          finishReason: "stop",
          text: "SUMMARY: no change\nCHANGES: none\nCHECKS: none\nRISKS: extension install was denied\nHANDOFF: main agent must decide.",
        };
      },
    };

    const result = await agentTaskTool.handler(
      { subagent_type: "implement", task: "Install an extension." },
      "s1",
      {
        modelProvider: provider,
        readThread: () => events,
        workspaceActivity: activity(events),
        toolExecutor: {
          execute: async () => {
            throw new Error("extension tool should not execute");
          },
        },
        toolsProvider: () => [
          {
            name: "edit_file",
            description: "Edit a file",
            params: {},
            isReadOnly: false,
            capabilities: ["fs.write"],
          },
          {
            name: "extension_install",
            description: "Install extension",
            params: {},
            isReadOnly: false,
            capabilities: ["extension.install"],
          },
        ],
      },
    );

    expect(String(result)).toContain("SUMMARY: no change");
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity_event",
      activityKind: "change",
      payload: expect.objectContaining({
        toolCalls: [{ name: "extension_install", isError: true }],
      }),
    }));
  });

  it("allows implementation subagents enough bounded tool rounds to hand off after edit and checks", async () => {
    const events: SessionEvent[] = [];
    const sequence = ["read_file", "edit_file", "read_file", "verify_workspace", "git_diff"];
    let call = 0;
    const provider: ModelProvider = {
      generate: async (messages, tools) => {
        if (call < sequence.length) {
          const name = sequence[call]!;
          call++;
          expect(tools?.some((tool) => tool.name === name)).toBe(true);
          return {
            finishReason: "tool_calls",
            text: `calling ${name}`,
            toolCalls: [{ id: `toolu_${call}`, name, args: { file_path: "src/app.ts" } }],
          };
        }
        expect(messages.map((message) => message.content).join("\n")).toContain("Tool: git_diff");
        return {
          finishReason: "stop",
          text: "SUMMARY: done\nCHANGES: src/app.ts\nCHECKS: verify_workspace passed\nRISKS: none\nHANDOFF: ready for main agent review",
        };
      },
    };

    const result = await agentTaskTool.handler(
      { subagent_type: "implement", task: "Make a bounded edit and verify it." },
      "s1",
      {
        modelProvider: provider,
        readThread: () => events,
        workspaceActivity: activity(events),
        toolExecutor: {
          execute: async (toolName, _args, _sessionId, context) => ({
            toolCallId: context?.toolUseId ?? "",
            toolName,
            isError: false,
            output: `${toolName} ok`,
          }),
        },
        toolsProvider: () => sequence.map((name) => ({
          name,
          description: name,
          params: {},
          isReadOnly: name !== "edit_file",
          capabilities: name === "edit_file" ? ["fs.write"] : ["fs.read"],
        })),
      },
    );

    expect(String(result)).toContain("HANDOFF: ready");
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity_event",
      title: "Subagent implement",
      status: "completed",
      payload: expect.objectContaining({
        toolCalls: sequence.map((name) => ({ name, isError: false })),
      }),
    }));
  });

  it("rejects subagent tool calls", async () => {
    const provider: ModelProvider = {
      generate: async () => ({
        finishReason: "tool_calls",
        text: "",
        toolCalls: [{ id: "toolu_1", name: "bash", args: { command: "npm test" } }],
      }),
    };

    const result = await agentTaskTool.handler(
      { subagent_type: "verify", task: "Run tests" },
      "s1",
      { modelProvider: provider, readThread: () => [] },
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(String((result as { output?: unknown }).output)).toContain("attempted to call tools");
  });

  it("runs background subagents and lets the main agent join with agent_task_output", async () => {
    const events: SessionEvent[] = [];
    let resolveProvider!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      resolveProvider = resolve;
    });
    const provider: ModelProvider = {
      generate: async (_messages, _tools, callbacks) => {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(new Error("aborted"));
          callbacks?.signal?.addEventListener("abort", onAbort, { once: true });
          providerStarted.then(() => {
            callbacks?.signal?.removeEventListener("abort", onAbort);
            resolve();
          }).catch(reject);
        });
        return {
          finishReason: "stop",
          text: "PLAN: background plan complete\nFILES/TOOLS: none\nVALIDATION: none\nRISKS: none",
        };
      },
    };

    const start = await agentTaskTool.handler(
      {
        subagent_type: "plan",
        tool_mode: "none",
        task: "Plan the next change.",
        run_in_background: true,
      },
      "s1",
      {
        modelProvider: provider,
        readThread: () => events,
        workspaceActivity: activity(events),
      },
    );

    const taskId = String(start).match(/subagent_[a-z0-9_]+/)?.[0] ?? "";
    expect(taskId).toBeTruthy();
    expect(String(start)).toContain("Background subagent started");
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity_event",
      status: "running",
      title: "Background subagent plan",
      payload: expect.objectContaining({ backgroundTaskId: taskId }),
    }));

    const running = await agentTaskOutputTool.handler({ task_id: taskId }, "s1");
    expect(String(running)).toContain("still running");

    resolveProvider();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const completed = await agentTaskOutputTool.handler({ task_id: taskId }, "s1");
    expect(String(completed)).toContain("background plan complete");
    expect(String(completed)).toContain('"status": "completed"');
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity_event",
      status: "completed",
      title: "Background subagent plan",
      payload: expect.objectContaining({ backgroundTaskId: taskId }),
    }));
  });

  it("cancels running background subagents with agent_task_cancel", async () => {
    const events: SessionEvent[] = [];
    let sawAbort = false;
    const provider: ModelProvider = {
      generate: async (_messages, _tools, callbacks) => {
        await new Promise<never>((_resolve, reject) => {
          callbacks?.signal?.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("aborted by test"));
          }, { once: true });
        });
        throw new Error("unreachable");
      },
    };

    const start = await agentTaskTool.handler(
      {
        subagent_type: "verify",
        tool_mode: "none",
        task: "Verify in the background.",
        run_in_background: true,
      },
      "s1",
      {
        modelProvider: provider,
        readThread: () => events,
        workspaceActivity: activity(events),
      },
    );

    const taskId = String(start).match(/subagent_[a-z0-9_]+/)?.[0] ?? "";
    expect(taskId).toBeTruthy();
    const cancelled = await agentTaskCancelTool.handler(
      { task_id: taskId },
      "s1",
      { workspaceActivity: activity(events) },
    );
    expect(String(cancelled)).toContain("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sawAbort).toBe(true);
    const output = await agentTaskOutputTool.handler({ task_id: taskId }, "s1");
    expect((output as { isError?: boolean }).isError).toBe(true);
    expect(String((output as { output?: unknown }).output)).toContain('"status": "cancelled"');
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity_event",
      status: "cancelled",
      title: "Background subagent verify",
      payload: expect.objectContaining({ backgroundTaskId: taskId }),
    }));
  });
});
