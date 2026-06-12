import { describe, it, expect, beforeEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CoreAPI } from "../src/core/core-api.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { enterWorktreeTool } from "../src/tools/built-in/worktree-tools.js";
import type { ModelProvider, ModelResponse, ModelMessage } from "../src/agent/model-provider.js";
import type { Session, SessionEvent } from "../src/streams/event-types.js";

function mockProvider(responses: ModelResponse[]): ModelProvider {
  let i = 0;
  return {
    generate: async (_msgs: ModelMessage[]) => {
      const r = responses[i];
      if (!r) throw new Error(`Unexpected generate call #${i}`);
      i++;
      return r;
    },
  };
}

function writePersistedThread(
  dataDir: string,
  session: Session,
  events: SessionEvent[],
): void {
  const sessionDir = join(dataDir, "sessions", session.id);
  mkdirSync(sessionDir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session_meta", ...session }),
    ...events.map((event) => JSON.stringify(event)),
  ];
  writeFileSync(join(sessionDir, "thread.jsonl"), `${lines.join("\n")}\n`, "utf-8");
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("CoreAPI", () => {
  let api: CoreAPI;

  beforeEach(() => {
    api = new CoreAPI();
  });

  it("creates a session with idle status", () => {
    const session = api.createSession("test session");
    expect(session.status).toBe("idle");
    expect(session.title).toBe("test session");
    expect(session.muted).toBe(false);
    expect(session.projectId).toBeDefined();
    expect(session.workspacePath).toBeDefined();
  });

  it("creates sessions in explicit workspace projects", () => {
    const dataDir = "tests/tmp/core-api-projects";
    const workspace = join(dataDir, "workspace-a");
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    const projectApi = new CoreAPI(undefined, { dataDir });
    const project = projectApi.createProject({ path: workspace, trustState: "trusted" });

    const session = projectApi.createSession("project session", { projectId: project.id });

    expect(session.projectId).toBe(project.id);
    expect(session.workspacePath).toBe(project.path);
    expect(projectApi.getProjectSessions(project.id).map((item) => item.id)).toContain(session.id);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("auto-titles a default session using the model after the first user message", async () => {
    let receivedTools: unknown = "unset";
    api.setModelProvider({
      generate: async (_messages, tools) => {
        receivedTools = tools;
        return {
          text: "工具权限设计",
          finishReason: "stop",
        };
      },
    });
    const session = api.createSession("New session");

    api.appendUserMessage(session.id, "请设计 DeepSeek-Forge 的工具权限系统", { dispatch: false });

    await waitUntil(() => api.getSession(session.id)?.title === "工具权限设计");
    expect(receivedTools).toBeUndefined();
  });

  it("does not auto-title a session with an explicit title", async () => {
    api.setModelProvider(mockProvider([{ text: "Should not be used", finishReason: "stop" }]));
    const session = api.createSession("Explicit title");

    api.appendUserMessage(session.id, "first message", { dispatch: false });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(api.getSession(session.id)?.title).toBe("Explicit title");
  });

  it("keeps new sessions as in-memory drafts until the first user message", () => {
    const dataDir = ".forge/test-core-draft";
    rmSync(dataDir, { recursive: true, force: true });

    const draftApi = new CoreAPI(undefined, { dataDir });
    const session = draftApi.createSession("draft");
    const sessionDir = join(dataDir, "sessions", session.id);
    const threadFile = join(sessionDir, "thread.jsonl");

    expect(existsSync(sessionDir)).toBe(false);
    expect(existsSync(threadFile)).toBe(false);

    draftApi.appendUserMessage(session.id, "first", { dispatch: false });
    draftApi.flush();

    expect(existsSync(sessionDir)).toBe(true);
    expect(existsSync(threadFile)).toBe(true);

    rmSync(dataDir, { recursive: true, force: true });
  });

  it("appendUserMessage transitions idle → running", () => {
    const { id } = api.createSession("s");
    const session = api.appendUserMessage(id, "hello", { dispatch: false });
    expect(session.status).toBe("running");
  });

  it("appendUserMessage treats waiting_user messages as replies", () => {
    const session = api.createSession("s");
    session.status = "waiting_user";

    const updated = api.appendUserMessage(session.id, "reply", { dispatch: false });

    expect(updated.status).toBe("running");
  });

  it("appendUserMessage stores event in thread", () => {
    const { id } = api.createSession("s");
    api.appendUserMessage(id, "hello", { dispatch: false });
    const thread = api.getThread(id);
    expect(thread).toHaveLength(1);
    expect(thread[0]!.type).toBe("user_message");
    expect((thread[0] as { text: string }).text).toBe("hello");
  });

  it("appendUserMessage blocks with a readable event when default dispatch is not runnable", () => {
    const { id } = api.createSession("s");

    const updated = api.appendUserMessage(id, "hello");

    expect(updated.status).toBe("blocked");
    const thread = api.getThread(id);
    expect(thread.map((e) => e.type)).toEqual(["user_message", "runtime_event"]);
    expect(thread[1]!.type).toBe("runtime_event");
    if (thread[1]!.type === "runtime_event") {
      expect(thread[1]!.runtimeKind).toBe("core");
      expect(thread[1]!.detail).toBe("failed");
      expect(thread[1]!.message).toContain("ModelProvider and ToolExecutor are not set");
    }
    expect(api.getSystemEvents().some((e) => e.message.includes("ModelProvider and ToolExecutor are not set"))).toBe(true);
  });

  it("dispatchTurn blocks running sessions when provider/tool wiring is missing", () => {
    const { id } = api.createSession("s");
    api.appendUserMessage(id, "hello", { dispatch: false });

    expect(api.dispatchTurn(id)).toBe("not_runnable");

    expect(api.getSession(id)!.status).toBe("blocked");
    const thread = api.getThread(id);
    expect(thread.map((e) => e.type)).toEqual(["user_message", "runtime_event"]);
    expect(thread[1]!.type).toBe("runtime_event");
    if (thread[1]!.type === "runtime_event") {
      expect(thread[1]!.message).toContain("ModelProvider and ToolExecutor are not set");
    }
  });

  it("runTurn blocks running sessions when provider/tool wiring is missing", async () => {
    const { id } = api.createSession("s");
    api.appendUserMessage(id, "hello", { dispatch: false });

    await expect(api.runTurn(id)).rejects.toThrow("ModelProvider and ToolExecutor are not set");

    expect(api.getSession(id)!.status).toBe("blocked");
    const thread = api.getThread(id);
    expect(thread.map((e) => e.type)).toEqual(["user_message", "runtime_event"]);
  });

  it("appendUserMessage throws for unknown session", () => {
    expect(() => api.appendUserMessage("bad-id", "x")).toThrow(
      "Session not found",
    );
  });

  it("appendUserMessage does not append when transition is illegal", () => {
    const { id } = api.createSession("s");
    api.appendUserMessage(id, "first", { dispatch: false });

    expect(() => api.appendUserMessage(id, "second")).toThrow("Illegal transition");
    const thread = api.getThread(id);
    expect(thread).toHaveLength(1);
    if (thread[0]!.type === "user_message") {
      expect(thread[0]!.text).toBe("first");
    }
  });

  it("creates editable message variants in the same session without mutating the original path", () => {
    const session = api.createSession("branching");
    api.appendUserMessage(session.id, "original request", { dispatch: false });
    session.status = "idle";

    const state = api.createMessageVariant(session.id, {
      sourceSeq: api.getThread(session.id)[0]!.seq,
      replacementText: "edited request",
      dispatch: false,
    });

    expect(state.variantGroups).toHaveLength(1);
    expect(state.variantGroups[0]!.variants).toHaveLength(2);
    expect(state.activeBranchId).not.toBe("main");

    const originalPath = api.getVisibleThread(session.id, "main");
    expect(originalPath.map((event) => event.type)).toEqual(["user_message"]);
    expect(originalPath[0]).toMatchObject({ type: "user_message", text: "original request" });

    const editedPath = api.getVisibleThread(session.id, state.activeBranchId);
    expect(editedPath.map((event) => event.type)).toEqual(["branch_event", "user_message"]);
    expect(editedPath[1]).toMatchObject({
      type: "user_message",
      text: "edited request",
      variantOfSeq: originalPath[0]!.seq,
    });

    expect(api.getThread(session.id).map((event) => event.type)).toEqual([
      "user_message",
      "branch_event",
      "user_message",
    ]);
  });

  it("runs an edited branch with only the selected visible path in model context", async () => {
    const registry = new ToolRegistry();
    const branchApi = new CoreAPI(registry);
    let received: ModelMessage[] = [];
    branchApi.setModelProvider({
      generate: async (messages) => {
        received = messages;
        return { text: "branch done", finishReason: "stop" };
      },
    });

    const session = branchApi.createSession("branch run");
    branchApi.appendUserMessage(session.id, "original task", { dispatch: false });
    session.status = "idle";
    const sourceSeq = branchApi.getThread(session.id)[0]!.seq;
    const state = branchApi.createMessageVariant(session.id, {
      sourceSeq,
      replacementText: "edited task",
      dispatch: false,
    });

    await branchApi.runTurn(session.id);

    expect(received.some((message) => message.role === "user" && message.content === "original task")).toBe(false);
    expect(received.some((message) => message.role === "user" && message.content === "edited task")).toBe(true);
    const editedPath = branchApi.getVisibleThread(session.id, state.activeBranchId);
    expect(editedPath.at(-1)).toMatchObject({ type: "assistant_message", text: "branch done" });
  });

  it("listSessions excludes archived sessions", () => {
    const { id } = api.createSession("keep");
    const { id: id2 } = api.createSession("archive me");
    api.deleteSession(id2);

    const sessions = api.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe(id);
  });

  it("getSession returns null for missing session", () => {
    expect(api.getSession("nope")).toBeNull();
  });

  it("getSession returns the session if it exists", () => {
    const created = api.createSession("s");
    const found = api.getSession(created.id);
    expect(found).not.toBeNull();
    expect(found!.title).toBe("s");
  });

  it("muteSession toggles muted flag", () => {
    const { id } = api.createSession("s");
    api.muteSession(id, true);
    expect(api.getSession(id)!.muted).toBe(true);
    api.muteSession(id, false);
    expect(api.getSession(id)!.muted).toBe(false);
  });

  it("muteSession throws for unknown session", () => {
    expect(() => api.muteSession("bad", true)).toThrow("Session not found");
  });

  it("deleteSession throws for unknown session", () => {
    expect(() => api.deleteSession("bad")).toThrow("Session not found");
  });

  it("creates sessions with unique IDs", () => {
    const a = api.createSession("a");
    const b = api.createSession("b");
    expect(a.id).not.toBe(b.id);
  });

  it("thread events are isolated per session", () => {
    const { id: id1 } = api.createSession("s1");
    const { id: id2 } = api.createSession("s2");

    api.appendUserMessage(id1, "a", { dispatch: false });
    api.appendUserMessage(id2, "b", { dispatch: false });

    expect(api.getThread(id1)).toHaveLength(1);
    expect(api.getThread(id2)).toHaveLength(1);
    expect((api.getThread(id1)[0] as { text: string }).text).toBe("a");
    expect((api.getThread(id2)[0] as { text: string }).text).toBe("b");
  });

  it("deleted session transitions to archived", () => {
    const { id } = api.createSession("s");
    api.deleteSession(id);
    const s = api.getSession(id);
    expect(s!.status).toBe("archived");
  });

  it("cannot delete from running state", () => {
    const { id } = api.createSession("s");
    api.appendUserMessage(id, "hello", { dispatch: false });
    expect(() => api.deleteSession(id)).toThrow("Illegal transition");
  });

  it("auto-wires ToolRuntime when ToolRegistry is passed to constructor", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "greet",
      description: "Greets",
      params: { name: { type: "string", description: "Name" } },
      handler: async (args) => `Hello, ${args.name}!`,
    });

    const api2 = new CoreAPI(registry);
    api2.setModelProvider(mockProvider([
      { text: "", finishReason: "tool_calls", toolCalls: [{ id: "t1", name: "greet", args: { name: "World" } }] },
      { text: "Done!", finishReason: "stop" },
    ]));

    const { id } = api2.createSession("s");
    // appendUserMessage transitions idle→running, thread is ready
    api2.appendUserMessage(id, "say hello", { dispatch: false });

    // runTurn should use the auto-wired ToolRuntime
    const session = await api2.runTurn(id);
    expect(session).toBeDefined();
  });

  it("passes the session project root into tool execution context", async () => {
    const dataDir = "tests/tmp/core-api-tool-project-root";
    const workspace = join(dataDir, "workspace-b");
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    const registry = new ToolRegistry();
    let seenProjectRoot = "";
    registry.register({
      name: "whereami",
      description: "Reports cwd",
      params: {},
      capabilities: ["fs.read"],
      handler: async (_args, _sessionId, context) => {
        seenProjectRoot = context?.projectRoot ?? "";
        return seenProjectRoot;
      },
    });
    const api2 = new CoreAPI(registry, { dataDir });
    const project = api2.createProject({ path: workspace, trustState: "trusted" });
    api2.initToolPolicy({ timeoutMs: 1000 });
    api2.setModelProvider(mockProvider([
      { text: "", finishReason: "tool_calls", toolCalls: [{ id: "tc1", name: "whereami", args: {} }] },
      { text: "done", finishReason: "stop" },
    ]));

    const { id } = api2.createSession("project tool", { projectId: project.id });
    api2.appendUserMessage(id, "where", { dispatch: false });
    await api2.runTurn(id);

    expect(seenProjectRoot).toBe(project.path);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("uses the active worktree as project root on later turns", async () => {
    const dataDir = "tests/tmp/core-api-active-worktree";
    const workspace = join(dataDir, "repo");
    const worktreePath = join(dataDir, "repo-worktree");
    const resolvedWorktreePath = resolve(worktreePath);
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "forgeagent@example.test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "DeepSeek-Forge Test"], { cwd: workspace, stdio: "ignore" });
    writeFileSync(join(workspace, "README.md"), "hello\n");
    execFileSync("git", ["add", "README.md"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    const registry = new ToolRegistry();
    registry.register(enterWorktreeTool);
    let seenProjectRoot = "";
    registry.register({
      name: "whereami",
      description: "Reports current project root",
      params: {},
      capabilities: ["fs.read"],
      handler: async (_args, _sessionId, context) => {
        seenProjectRoot = context?.projectRoot ?? "";
        return seenProjectRoot;
      },
    });
    const api2 = new CoreAPI(registry, { dataDir });
    const project = api2.createProject({ path: workspace, trustState: "trusted" });
    api2.setModelProvider(mockProvider([
      { text: "", finishReason: "tool_calls", toolCalls: [{ id: "wt1", name: "enter_worktree", args: { branch: "forge/test", path: worktreePath } }] },
      { text: "worktree ready", finishReason: "stop" },
      { text: "", finishReason: "tool_calls", toolCalls: [{ id: "where1", name: "whereami", args: {} }] },
      { text: "done", finishReason: "stop" },
    ]));

    const { id } = api2.createSession("worktree root", { projectId: project.id });
    api2.appendUserMessage(id, "enter worktree", { dispatch: false });
    await api2.runTurn(id);
    api2.appendUserMessage(id, "where now", { dispatch: false });
    await api2.runTurn(id);

    expect(seenProjectRoot).toBe(resolvedWorktreePath);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("executes a pending tool after permission approval", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "writer",
      description: "Writes",
      params: {},
      capabilities: ["fs.write"],
      handler: async () => "wrote",
    });
    const api2 = new CoreAPI(registry);
    api2.initToolPolicy({ timeoutMs: 1000 });
    api2.setModelProvider(mockProvider([
      { text: "", finishReason: "tool_calls", toolCalls: [{ id: "tc1", name: "writer", args: {} }] },
      { text: "done", finishReason: "stop" },
    ]));

    const { id } = api2.createSession("permission");
    api2.appendUserMessage(id, "write", {
      dispatch: false,
      source: { kind: "http", interactive: true, deviceId: "d1", deviceName: "Phone" },
    });

    const turn = api2.runTurn(id);
    await waitUntil(() => api2.getPermissionRequests({ status: "pending" }).length === 1);
    const [request] = api2.getPermissionRequests({ status: "pending" });
    api2.respondToPermissionRequest(request!.id, {
      decision: "allow_once",
      deviceId: "d1",
      deviceName: "Phone",
    });

    const session = await turn;
    expect(session.status).toBe("idle");
    const thread = api2.getThread(id);
    expect(thread.some((event) => event.type === "permission_request")).toBe(true);
    expect(thread.some((event) => event.type === "permission_response")).toBe(true);
    const toolResult = thread.find((event) => event.type === "tool_result");
    expect(toolResult?.type).toBe("tool_result");
    if (toolResult?.type === "tool_result") {
      expect(toolResult.isError).toBe(false);
      expect(toolResult.result).toBe("wrote");
    }
  });

  it("returns denied permissions as tool errors and lets the agent recover", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "writer",
      description: "Writes",
      params: {},
      capabilities: ["fs.write"],
      handler: async () => "wrote",
    });
    const api2 = new CoreAPI(registry);
    api2.initToolPolicy({ timeoutMs: 1000 });
    api2.setModelProvider(mockProvider([
      { text: "", finishReason: "tool_calls", toolCalls: [{ id: "tc1", name: "writer", args: {} }] },
      { text: "I saw the permission denial and chose a safer path.", finishReason: "stop" },
    ]));

    const { id } = api2.createSession("permission denied");
    api2.appendUserMessage(id, "write", {
      dispatch: false,
      source: { kind: "http", interactive: true, deviceId: "d1", deviceName: "Phone" },
    });

    const turn = api2.runTurn(id);
    await waitUntil(() => api2.getPermissionRequests({ status: "pending" }).length === 1);
    const [request] = api2.getPermissionRequests({ status: "pending" });
    api2.respondToPermissionRequest(request!.id, {
      decision: "deny",
      message: "No destructive writes now.",
      deviceId: "d1",
      deviceName: "Phone",
    });

    const session = await turn;
    expect(session.status).toBe("idle");
    const thread = api2.getThread(id);
    const toolResult = thread.find((event) => event.type === "tool_result");
    expect(toolResult?.type).toBe("tool_result");
    if (toolResult?.type === "tool_result") {
      expect(toolResult.isError).toBe(true);
      expect(String(toolResult.result)).toContain("Tool permission denied before execution.");
      expect(String(toolResult.result)).toContain("Recovery:");
    }
    const last = thread[thread.length - 1]!;
    expect(last.type).toBe("assistant_message");
    if (last.type === "assistant_message") {
      expect(last.text).toContain("permission denial");
    }
  });

  it("runTurn completes with stop response using ToolRegistry wiring", async () => {
    const registry = new ToolRegistry();
    const api2 = new CoreAPI(registry);
    api2.setModelProvider(mockProvider([
      { text: "Hello, user!", finishReason: "stop" },
    ]));

    const { id } = api2.createSession("s");
    api2.appendUserMessage(id, "hi", { dispatch: false });

    const session = await api2.runTurn(id);
    expect(session.status).toBe("idle");

    const thread = api2.getThread(id);
    expect(thread).toHaveLength(2); // user + assistant
  });

  it("ask_user tool transitions running session to waiting_user", async () => {
    const registry = new ToolRegistry();
    const api2 = new CoreAPI(registry);
    api2.registerBuiltInTools();
    api2.setModelProvider(mockProvider([
      {
        text: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "ask1",
          name: "ask_user",
          args: { question: "Which branch should I use?" },
        }],
      },
    ]));

    const { id } = api2.createSession("ask");
    api2.appendUserMessage(id, "start", { dispatch: false });

    const session = await api2.runTurn(id);
    expect(session.status).toBe("waiting_user");

    const thread = api2.getThread(id);
    expect(thread.map((e) => e.type)).toEqual([
      "user_message",
      "tool_call",
      "tool_result",
      "assistant_message",
    ]);
    expect(thread[3]!.type).toBe("assistant_message");
    if (thread[3]!.type === "assistant_message") {
      expect(thread[3]!.text).toBe("Which branch should I use?");
    }

    const replied = api2.appendUserMessage(id, "main", { dispatch: false });
    expect(replied.status).toBe("running");
  });

  it("continues sequence numbers after loading persisted sessions", async () => {
    const dataDir = ".forge/test-core-seq";
    rmSync(dataDir, { recursive: true, force: true });

    const first = new CoreAPI(new ToolRegistry(), { dataDir });
    first.setModelProvider(mockProvider([
      { text: "done", finishReason: "stop" },
    ]));
    const { id } = first.createSession("persisted");
    first.appendUserMessage(id, "first", { dispatch: false });
    await first.runTurn(id);
    first.flush();

    const second = new CoreAPI(undefined, { dataDir });
    second.loadSessions();
    second.appendUserMessage(id, "second", { dispatch: false });

    const thread = second.getThread(id);
    expect(thread).toHaveLength(3);
    expect(thread[2]!.seq).toBeGreaterThan(thread[1]!.seq);

    rmSync(dataDir, { recursive: true, force: true });
  });

  it("blocks persisted running sessions on startup instead of requeueing them", async () => {
    const dataDir = ".forge/test-core-rehydrate-running";
    rmSync(dataDir, { recursive: true, force: true });

    const first = new CoreAPI(new ToolRegistry(), { dataDir });
    const { id } = first.createSession("running");
    first.appendUserMessage(id, "resume me", { dispatch: false });
    first.flush();

    let generateCalls = 0;
    const provider: ModelProvider = {
      generate: async () => {
        generateCalls++;
        return { text: "resumed", finishReason: "stop" };
      },
    };
    const second = new CoreAPI(new ToolRegistry(), { dataDir });
    second.setModelProvider(provider);
    second.initSupervisor(1);
    second.loadSessions();

    const report = await second.rehydrateAfterStartup();

    expect(report.requeuedSessions).toEqual([]);
    expect(report.startupBlockedSessions).toContain(id);
    expect(generateCalls).toBe(0);
    expect(second.getSession(id)!.status).toBe("blocked");
    const thread = second.getThread(id);
    expect(thread.map((event) => event.type)).toEqual([
      "user_message",
      "runtime_event",
    ]);
    expect(thread[1]!.type).toBe("runtime_event");
    if (thread[1]!.type === "runtime_event") {
      expect(thread[1]!.message).toContain("Core restarted while this session was running");
      expect(thread[1]!.message).toContain("blocked instead of automatically resuming");
    }

    rmSync(dataDir, { recursive: true, force: true });
  });

  it("repairs dangling tool calls before blocking a startup running session", async () => {
    const dataDir = ".forge/test-core-rehydrate-dangling-tool";
    rmSync(dataDir, { recursive: true, force: true });
    const now = new Date().toISOString();
    const session: Session = {
      id: "dangling-session",
      title: "dangling",
      status: "running",
      muted: false,
      projectId: "fixture-project",
      workspacePath: join(dataDir, "fixture-workspace"),
      createdAt: now,
      updatedAt: now,
    };
    mkdirSync(session.workspacePath!, { recursive: true });
    writePersistedThread(dataDir, session, [
      {
        type: "user_message",
        seq: 1,
        timestamp: now,
        sessionId: session.id,
        text: "use a tool",
      },
      {
        type: "tool_call",
        seq: 2,
        timestamp: now,
        sessionId: session.id,
        toolName: "slow",
        args: {},
        toolUseId: "tc1",
      },
    ]);

    let generateCalls = 0;
    const provider: ModelProvider = {
      generate: async () => {
        generateCalls++;
        return { text: "continued after restart", finishReason: "stop" };
      },
    };
    const second = new CoreAPI(new ToolRegistry(), { dataDir });
    second.setModelProvider(provider);
    second.initSupervisor(1);
    second.loadSessions();

    const report = await second.rehydrateAfterStartup();

    expect(report.repairedToolResults).toBe(1);
    expect(report.startupBlockedSessions).toContain(session.id);
    expect(generateCalls).toBe(0);
    expect(second.getSession(session.id)!.status).toBe("blocked");
    const thread = second.getThread(session.id);
    expect(thread.map((event) => event.type)).toEqual([
      "user_message",
      "tool_call",
      "tool_result",
      "runtime_event",
    ]);
    expect(thread[2]!.type).toBe("tool_result");
    if (thread[2]!.type === "tool_result") {
      expect(thread[2]!.isError).toBe(true);
      expect(thread[2]!.result).toBe("Process restarted before this tool completed.");
      expect(thread[2]!.toolUseId).toBe("tc1");
    }

    rmSync(dataDir, { recursive: true, force: true });
  });

  it("marks persisted running background shell tasks failed on startup", async () => {
    const dataDir = ".forge/test-core-rehydrate-shell-tasks";
    rmSync(dataDir, { recursive: true, force: true });
    const timestamp = new Date().toISOString();
    const session: Session = {
      id: "shell-task-session",
      title: "shell tasks",
      status: "idle",
      muted: false,
      projectId: "fixture-project",
      workspacePath: join(dataDir, "fixture-workspace"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    mkdirSync(session.workspacePath!, { recursive: true });
    writePersistedThread(dataDir, session, [
      {
        type: "shell_task_event",
        seq: 1,
        timestamp,
        sessionId: session.id,
        taskId: "task_running",
        action: "started",
        command: "npm run dev",
        status: "running",
        message: "Background command started: npm run dev",
      },
      {
        type: "shell_task_event",
        seq: 2,
        timestamp,
        sessionId: session.id,
        taskId: "task_done",
        action: "completed",
        command: "npm test",
        status: "completed",
        message: "Background command completed: npm test",
      },
    ]);

    const second = new CoreAPI(new ToolRegistry(), { dataDir });
    second.loadSessions();

    const report = await second.rehydrateAfterStartup();

    expect(report.repairedShellTasks).toBe(1);
    const shellEvents = second.getThread(session.id).filter((event) => event.type === "shell_task_event");
    expect(shellEvents).toHaveLength(3);
    const repaired = shellEvents[shellEvents.length - 1]!;
    expect(repaired.type).toBe("shell_task_event");
    if (repaired.type === "shell_task_event") {
      expect(repaired.taskId).toBe("task_running");
      expect(repaired.action).toBe("failed");
      expect(repaired.status).toBe("failed");
      expect(repaired.message).toBe("Process restarted before this background task completed.");
    }
    expect(second.getWorkspaceActivity(session.id).shellTasks.at(-1)?.status).toBe("failed");

    rmSync(dataDir, { recursive: true, force: true });
  });

  it("does not dispatch waiting_user sessions during startup rehydration", async () => {
    const dataDir = ".forge/test-core-rehydrate-waiting";
    rmSync(dataDir, { recursive: true, force: true });
    const now = new Date().toISOString();
    const session: Session = {
      id: "waiting-session",
      title: "waiting",
      status: "waiting_user",
      muted: false,
      projectId: "fixture-project",
      workspacePath: join(dataDir, "fixture-workspace"),
      createdAt: now,
      updatedAt: now,
    };
    mkdirSync(session.workspacePath!, { recursive: true });
    writePersistedThread(dataDir, session, [
      {
        type: "assistant_message",
        seq: 1,
        timestamp: now,
        sessionId: session.id,
        text: "Which path should I use?",
      },
    ]);
    const provider = { generate: vi.fn() };
    const second = new CoreAPI(new ToolRegistry(), { dataDir });
    second.setModelProvider(provider);
    second.initSupervisor(1);
    second.loadSessions();

    const report = await second.rehydrateAfterStartup();

    expect(report.requeuedSessions).toEqual([]);
    expect(provider.generate).not.toHaveBeenCalled();
    expect(second.getSession(session.id)!.status).toBe("waiting_user");

    rmSync(dataDir, { recursive: true, force: true });
  });

  it("syncs sleeping sessions without enabled triggers back to idle on startup", async () => {
    const dataDir = ".forge/test-core-rehydrate-sleeping";
    rmSync(dataDir, { recursive: true, force: true });
    const now = new Date().toISOString();
    const session: Session = {
      id: "sleeping-session",
      title: "sleeping",
      status: "sleeping",
      muted: false,
      projectId: "fixture-project",
      workspacePath: join(dataDir, "fixture-workspace"),
      createdAt: now,
      updatedAt: now,
    };
    mkdirSync(session.workspacePath!, { recursive: true });
    writePersistedThread(dataDir, session, []);

    const second = new CoreAPI(new ToolRegistry(), { dataDir });
    second.initScheduler();
    second.loadSessions();

    const report = await second.rehydrateAfterStartup();

    expect(report.triggerSyncedSessions).toContain(session.id);
    expect(second.getSession(session.id)!.status).toBe("idle");

    rmSync(dataDir, { recursive: true, force: true });
  });

  it("deletes persisted legacy sessions without project metadata on load", () => {
    const dataDir = ".forge/test-core-legacy-project-cleanup";
    rmSync(dataDir, { recursive: true, force: true });
    const timestamp = new Date().toISOString();
    const legacy: Session = {
      id: "legacy-session",
      title: "legacy",
      status: "idle",
      muted: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    writePersistedThread(dataDir, legacy, []);

    const next = new CoreAPI(undefined, { dataDir });
    const loaded = next.loadSessions();

    expect(loaded).toEqual([]);
    expect(next.getSession(legacy.id)).toBeNull();
    expect(existsSync(join(dataDir, "sessions", legacy.id))).toBe(false);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("records model usage in the usage ledger and thread", async () => {
    const dataDir = ".forge/test-core-usage";
    rmSync(dataDir, { recursive: true, force: true });
    const registry = new ToolRegistry();
    const usageApi = new CoreAPI(registry, { dataDir });
    usageApi.setModelProvider({
      getMetadata: () => ({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        contextWindowTokens: 100_000,
        requiresUsage: true,
        pricing: { cacheHit: 0.02, input: 1, output: 2, currency: "¥" },
      }),
      generate: async () => ({
        text: "ok",
        finishReason: "stop",
        rawUsage: {
          input_tokens: 500,
          output_tokens: 50,
          total_tokens: 550,
          cache_hit_tokens: 450,
          cache_miss_tokens: 50,
          reasoning_tokens: 10,
        },
      }),
    });
    const session = usageApi.createSession("usage");
    usageApi.appendUserMessage(session.id, "hello", { dispatch: false });

    await usageApi.runTurn(session.id);

    const usageEvent = usageApi.getThread(session.id).find((event) => event.type === "usage_event");
    expect(usageEvent?.type).toBe("usage_event");
    if (usageEvent?.type === "usage_event") {
      expect(usageEvent.contextUsedPercent).toBe(0.5);
      expect(usageEvent.cacheHitTokens).toBe(450);
      expect(usageEvent.reasoningTokens).toBe(10);
      expect(usageEvent.estimated).toBe(false);
    }
    const summary = usageApi.getSessionUsage(session.id);
    expect(summary.contextUsedPercent).toBe(0.5);
    expect(summary.cacheHitRateNow).toBe(90);
    expect(summary.cacheHitRateSession).toBe(90);
    expect(summary.cost).toBeCloseTo(0.000159);
    expect(usageApi.getUsageRecords(session.id)).toHaveLength(1);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("runs read-only agent_task through the tracked provider and records usage", async () => {
    const dataDir = ".forge/test-core-agent-task-usage";
    rmSync(dataDir, { recursive: true, force: true });
    const registry = new ToolRegistry();
    const usageApi = new CoreAPI(registry, { dataDir });
    usageApi.registerBuiltInTools();
    let call = 0;
    const toolPresence: Array<boolean | undefined> = [];
    usageApi.setModelProvider({
      getMetadata: () => ({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        contextWindowTokens: 100_000,
        requiresUsage: true,
      }),
      generate: async (messages, tools) => {
        toolPresence.push(tools !== undefined);
        call++;
        if (call === 1) {
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [{
              id: "toolu_agent_task",
              name: "agent_task",
              args: { subagent_type: "verify", task: "Verify the current workspace evidence." },
            }],
            rawUsage: { input_tokens: 400, output_tokens: 20, total_tokens: 420 },
          };
        }
        if (call === 2) {
          expect(tools?.some((tool) => tool.name === "read_file")).toBe(true);
          expect(tools?.some((tool) => tool.name === "edit_file")).toBe(false);
          expect(messages.map((message) => message.content).join("\n")).toContain("read-only DeepSeek-Forge workspace subagent");
          return {
            text: "VERDICT: PASS\nEVIDENCE: durable activity is consistent.\nRISKS: none.\nREQUIRED NEXT ACTIONS: none.",
            finishReason: "stop",
            rawUsage: { input_tokens: 120, output_tokens: 40, total_tokens: 160 },
          };
        }
        return {
          text: "Verified.",
          finishReason: "stop",
          rawUsage: { input_tokens: 550, output_tokens: 25, total_tokens: 575 },
        };
      },
    });
    const session = usageApi.createSession("agent task usage");
    usageApi.appendUserMessage(session.id, "verify this", { dispatch: false });

    await usageApi.runTurn(session.id);

    expect(toolPresence).toEqual([true, true, true]);
    const thread = usageApi.getThread(session.id);
    expect(thread.some((event) =>
      event.type === "tool_result" &&
      event.toolName === "agent_task" &&
      String(event.result).includes("VERDICT: PASS"),
    )).toBe(true);
    expect(thread.some((event) =>
      event.type === "activity_event" &&
      event.title === "Subagent verify",
    )).toBe(true);
    expect(thread.filter((event) => event.type === "usage_event")).toHaveLength(3);
    expect(usageApi.getUsageRecords(session.id)).toHaveLength(3);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("shows local compacted context estimate after compaction without changing token totals", async () => {
    const dataDir = ".forge/test-core-context-estimate";
    rmSync(dataDir, { recursive: true, force: true });
    const registry = new ToolRegistry();
    const usageApi = new CoreAPI(registry, {
      dataDir,
      contextWindowTokens: 1000,
      autoCompactBuffer: 100,
      compactionKeepRecentTokens: 1,
    });
    usageApi.setModelProvider({
      getMetadata: () => ({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        contextWindowTokens: 1000,
        requiresUsage: true,
      }),
      generate: vi.fn()
        .mockResolvedValueOnce({
          text: "ok",
          finishReason: "stop",
          rawUsage: { input_tokens: 950, output_tokens: 10, total_tokens: 960 },
        })
        .mockResolvedValueOnce({
          text: "## Active Task\nNone.\n\n## Critical Context\nCompacted.",
          finishReason: "stop",
          rawUsage: { input_tokens: 120, output_tokens: 20, total_tokens: 140 },
        }),
    });
    const session = usageApi.createSession("context estimate");
    usageApi.appendUserMessage(session.id, "hello " + "context ".repeat(200), { dispatch: false });

    await usageApi.runTurn(session.id);

    const thread = usageApi.getThread(session.id);
    const estimate = thread.find((event) => event.type === "context_usage_event");
    expect(estimate?.type).toBe("context_usage_event");
    const summary = usageApi.getSessionUsage(session.id);
    expect(summary.records).toBe(2);
    expect(summary.inputTokens).toBe(1070);
    expect(summary.currentContextSource).toBe("local_estimate");
    expect(summary.currentContextEstimated).toBe(true);
    expect(summary.currentContextUsedPercent).toBeDefined();
    expect(summary.currentContextUsedPercent).not.toBe(summary.contextUsedPercent);
    expect(summary.currentContextMessage).toContain("Local compacted context estimate");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("blocks DeepSeek turns when real usage telemetry is missing", async () => {
    const registry = new ToolRegistry();
    const usageApi = new CoreAPI(registry);
    usageApi.setModelProvider({
      getMetadata: () => ({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        contextWindowTokens: 1000,
        requiresUsage: true,
      }),
      generate: async () => ({
        text: "ok without usage",
        finishReason: "stop",
      }),
    });
    const session = usageApi.createSession("missing usage");
    usageApi.appendUserMessage(session.id, "hello", { dispatch: false });

    await usageApi.runTurn(session.id);

    expect(usageApi.getSession(session.id)?.status).toBe("blocked");
    expect(usageApi.getThread(session.id).some((event) =>
      event.type === "runtime_event" &&
      event.runtimeKind === "usage_telemetry" &&
      event.message.includes("Provider did not return token usage"),
    )).toBe(true);
    expect(usageApi.getSessionUsage(session.id).records).toBe(0);
  });
});
