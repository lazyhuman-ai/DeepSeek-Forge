import { describe, expect, it } from "vitest";
import type { ModelMessage, ModelProvider } from "../../src/agent/model-provider.js";
import type { ToolExecutor } from "../../src/agent/tool-executor.js";
import type { SessionEvent } from "../../src/streams/event-types.js";
import { agentTaskTool } from "../../src/tools/built-in/agent-task.js";
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
});
