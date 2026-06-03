import http, { type IncomingMessage } from "node:http";
import { once } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { CoreAPI } from "../src/core/core-api.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { buildTool } from "../src/tools/schemas.js";
import { AnthropicProvider } from "../src/agent/anthropic-provider.js";
import { OpenAIProvider } from "../src/agent/openai-provider.js";
import { DeepSeekProvider } from "../src/agent/deepseek-provider.js";
import { HttpGateway } from "../src/gateways/http/http-gateway.js";
import { createHttpServer } from "../src/gateways/http/http-server.js";
import { AuthStore } from "../src/auth/auth-store.js";
import type { ModelProvider } from "../src/agent/model-provider.js";
import type { SessionEvent, ToolCall, ToolResult } from "../src/streams/event-types.js";

type PermissionMode = "allow_once" | "allow_session" | "deny" | "manual";

type ScenarioResult = {
  name: string;
  ok: boolean;
  durationMs: number;
  detail: string;
};

type SoakContext = {
  api: CoreAPI;
  provider: ModelProvider;
  dataDir: string;
  workspaceDir: string;
  permissionModes: Map<string, PermissionMode>;
};

const DATA_DIR = resolve(process.env.SOAK_COMPLEX_DATA_DIR ?? ".forge-soak-complex");
const RUN_ID = `complex_${new Date().toISOString().replace(/[:.]/g, "-")}`;
const WORKSPACE_DIR = resolve(DATA_DIR, "workspace");
const DEFAULT_WAIT_MS = Number(process.env.SOAK_COMPLEX_WAIT_MS ?? "240000");
const CYCLES = Number(process.env.SOAK_COMPLEX_CYCLES ?? "1");
const PROVIDER_KIND = (process.env.SOAK_PROVIDER ?? "deepseek").toLowerCase();

const CLI_SOURCE = {
  kind: "cli" as const,
  interactive: true,
  deviceId: "complex-soak-cli",
  deviceName: "Complex Soak Harness",
};

function now(): number {
  return Date.now();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function makeProvider(): ModelProvider {
  if (PROVIDER_KIND === "openai") {
    return new OpenAIProvider({
      requestTimeoutMs: Number(process.env.SOAK_PROVIDER_TIMEOUT_MS ?? "120000"),
      maxRetries: Number(process.env.SOAK_PROVIDER_RETRIES ?? "1"),
    });
  }
  if (PROVIDER_KIND === "anthropic") {
    return new AnthropicProvider({
      requestTimeoutMs: Number(process.env.SOAK_PROVIDER_TIMEOUT_MS ?? "120000"),
      maxRetries: Number(process.env.SOAK_PROVIDER_RETRIES ?? "1"),
    });
  }
  return new DeepSeekProvider({
    requestTimeoutMs: Number(process.env.SOAK_PROVIDER_TIMEOUT_MS ?? "120000"),
    maxRetries: Number(process.env.SOAK_PROVIDER_RETRIES ?? "1"),
  });
}

function registerComplexTools(registry: ToolRegistry): void {
  registry.register(buildTool({
    name: "soak_complex_large_report",
    description: "Generate a large soak report with a deep marker that is only visible through read_artifact.",
    params: {
      label: { type: "string", description: "Report label" },
    },
    capabilities: ["fs.read"],
    isConcurrencySafe: true,
    isReadOnly: true,
    handler: async (args) => {
      const label = String(args.label ?? "complex-report");
      return [
        `SOAK_COMPLEX_REPORT_BEGIN label=${label}`,
        "A".repeat(60_000),
        "SOAK_DEEP_MARKER: quartz-92741",
        "B".repeat(20_000),
        "SOAK_COMPLEX_REPORT_END",
      ].join("\n");
    },
  }));
}

function makeCore(dataDir: string, provider: ModelProvider): CoreAPI {
  const registry = new ToolRegistry();
  const api = new CoreAPI(registry, {
    dataDir,
    memoryDir: join(dataDir, "memory"),
    artifactDir: join(dataDir, "artifacts"),
  });
  api.registerBuiltInTools();
  registerComplexTools(registry);
  api.initSupervisor(2);
  api.initScheduler();
  api.initMemoryManager({ autoRun: false, proposalThreshold: 2 });
  api.initToolPolicy({
    timeoutMs: Number(process.env.SOAK_COMPLEX_PERMISSION_TIMEOUT_MS ?? "45000"),
    projectRoot: process.cwd(),
  });
  api.setModelProvider(provider);
  return api;
}

function setupCore(): SoakContext {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(WORKSPACE_DIR, { recursive: true });

  const provider = makeProvider();
  const api = makeCore(DATA_DIR, provider);
  const permissionModes = new Map<string, PermissionMode>();

  api.onSessionEvent((sessionId, event) => {
    if (event.type !== "permission_request") return;
    const mode = permissionModes.get(sessionId) ?? "allow_once";
    if (mode === "manual") return;
    setTimeout(() => {
      try {
        api.respondToPermissionRequest(event.permissionRequestId, {
          decision: mode,
          message: mode === "deny"
            ? "Complex soak intentionally denied this permission request."
            : "Complex soak auto-approved this permission request.",
          deviceId: "complex-soak-cli",
          deviceName: "Complex Soak Harness",
        });
      } catch {
        // The request may already have timed out or been interrupted.
      }
    }, 10);
  });

  return { api, provider, dataDir: DATA_DIR, workspaceDir: WORKSPACE_DIR, permissionModes };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForSessionStatus(
  api: CoreAPI,
  sessionId: string,
  statuses: string[],
  timeoutMs = DEFAULT_WAIT_MS,
): Promise<void> {
  const started = now();
  while (now() - started < timeoutMs) {
    const status = api.getSession(sessionId)?.status;
    if (status && statuses.includes(status)) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for session ${sessionId}; current status=${api.getSession(sessionId)?.status}`);
}

async function waitForThreadEvent(
  api: CoreAPI,
  sessionId: string,
  predicate: (event: SessionEvent) => boolean,
  timeoutMs = DEFAULT_WAIT_MS,
): Promise<SessionEvent> {
  const started = now();
  while (now() - started < timeoutMs) {
    const found = api.getThread(sessionId).find(predicate);
    if (found) return found;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for thread event in ${sessionId}`);
}

async function runScenario(
  name: string,
  fn: () => Promise<string>,
): Promise<ScenarioResult> {
  const started = now();
  try {
    const detail = await fn();
    return { name, ok: true, durationMs: now() - started, detail };
  } catch (err) {
    return {
      name,
      ok: false,
      durationMs: now() - started,
      detail: err instanceof Error ? err.stack ?? err.message : String(err),
    };
  }
}

function threadTypes(events: SessionEvent[]): string {
  return events.map((event) => event.type).join(" -> ");
}

function assertToolPairs(events: SessionEvent[]): void {
  const calls = new Map<string, ToolCall>();
  const results = new Set<string>();
  for (const event of events) {
    if (event.type === "tool_call") {
      calls.set(event.toolUseId ?? `call_${event.seq}`, event);
    } else if (event.type === "tool_result") {
      results.add(event.toolUseId ?? `call_${event.seq - 1}`);
    }
  }
  const missing = [...calls.keys()].filter((id) => !results.has(id));
  assert(missing.length === 0, `Dangling tool_call(s): ${missing.join(", ")}`);
}

function lastAssistantText(events: SessionEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "assistant_message") return event.text;
  }
  return "";
}

function toolResults(events: SessionEvent[], toolName: string): ToolResult[] {
  return events.filter((event): event is ToolResult => event.type === "tool_result" && event.toolName === toolName);
}

function createRepairProject(ctx: SoakContext): string {
  const projectDir = join(ctx.workspaceDir, "repair-project");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({
    type: "module",
    scripts: { test: "node test.js" },
  }, null, 2), "utf-8");
  writeFileSync(join(projectDir, "calculator.js"), [
    "export function add(a, b) {",
    "  return a - b;",
    "}",
    "",
  ].join("\n"), "utf-8");
  writeFileSync(join(projectDir, "test.js"), [
    "import { add } from './calculator.js';",
    "if (add(2, 3) !== 5) {",
    "  throw new Error(`Expected add(2, 3) to equal 5, got ${add(2, 3)}`);",
    "}",
    "console.log('SOAK_TEST_PASS');",
    "",
  ].join("\n"), "utf-8");
  return projectDir;
}

async function scenarioCodingRepair(ctx: SoakContext): Promise<string> {
  const projectDir = createRepairProject(ctx);
  const session = ctx.api.createSession(`${RUN_ID} coding repair`);
  ctx.permissionModes.set(session.id, "allow_once");
  ctx.api.appendUserMessage(
    session.id,
    [
      "You are fixing a real tiny JavaScript project.",
      `Project path: ${projectDir}`,
      "Required workflow: run `npm test` in that project, inspect the relevant file, fix the bug using file tools, then rerun `npm test`.",
      "When the test passes, reply with exact prefix SOAK_REPAIR_OK and include SOAK_TEST_PASS.",
      "Do not ask the user for clarification.",
    ].join("\n"),
    { source: CLI_SOURCE },
  );
  await waitForSessionStatus(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  const bashResults = toolResults(events, "bash");
  assert(bashResults.length >= 2, `Expected at least two bash runs; thread=${threadTypes(events)}`);
  const failedRun = bashResults.find((event) => String(event.result).includes("Command failed"));
  assert(failedRun, "Initial failing test output was not captured");
  assert(failedRun.isError, "Initial failing bash command was not marked isError=true");
  assert(bashResults.some((event) => String(event.result).includes("SOAK_TEST_PASS")), "Passing test output missing");
  assert(readFileSync(join(projectDir, "calculator.js"), "utf-8").includes("return a + b;"), "calculator.js was not fixed");
  assert(lastAssistantText(events).includes("SOAK_REPAIR_OK"), `Unexpected final assistant text: ${lastAssistantText(events)}`);
  assertToolPairs(events);
  return threadTypes(events);
}

async function scenarioSandboxRecovery(ctx: SoakContext): Promise<string> {
  const outsidePath = `/tmp/${RUN_ID}_outside_sandbox.txt`;
  rmSync(outsidePath, { force: true });
  const safePath = join(ctx.workspaceDir, "sandbox-recovery", "safe-output.txt");
  const session = ctx.api.createSession(`${RUN_ID} sandbox recovery`);
  ctx.permissionModes.set(session.id, "allow_once");
  ctx.api.appendUserMessage(
    session.id,
    [
      "This is a sandbox recovery test.",
      `First, you must try write_file with file_path="${outsidePath}" and content="outside attempt".`,
      "When the tool says sandbox blocked filesystem access, recover by using write_file again.",
      `The recovery path is "${safePath}" and the content must include SOAK_SANDBOX_OK.`,
      "Then reply with exact prefix SOAK_SANDBOX_OK and mention the recovery path.",
    ].join("\n"),
    { source: CLI_SOURCE },
  );
  await waitForSessionStatus(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  const writeResults = toolResults(events, "write_file");
  assert(writeResults.some((event) => event.isError && String(event.result).includes("Tool sandbox blocked filesystem access.")), "Sandbox error was not returned as readable isError tool_result");
  assert(!existsSync(outsidePath), "Outside sandbox file was created");
  assert(existsSync(safePath), "Safe recovery file was not created");
  assert(readFileSync(safePath, "utf-8").includes("SOAK_SANDBOX_OK"), "Safe recovery file missing marker");
  assert(lastAssistantText(events).includes("SOAK_SANDBOX_OK"), `Unexpected final assistant text: ${lastAssistantText(events)}`);
  assertToolPairs(events);
  return threadTypes(events);
}

async function scenarioArtifactRead(ctx: SoakContext): Promise<string> {
  const session = ctx.api.createSession(`${RUN_ID} artifact read`);
  ctx.api.appendUserMessage(
    session.id,
    [
      "You must call soak_complex_large_report with label='artifact-deep'.",
      "The full output will be saved as an artifact because it is too large.",
      "After that, you must call read_artifact with the visible artifact_id, offset=59000, and limit=8000.",
      "Use the read_artifact result to find SOAK_DEEP_MARKER.",
      "Reply with exact prefix SOAK_ARTIFACT_READ_OK and include the marker value.",
    ].join("\n"),
    { source: CLI_SOURCE },
  );
  await waitForSessionStatus(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  const pointer = events.find((event) => event.type === "artifact_pointer");
  assert(pointer?.type === "artifact_pointer", `No artifact_pointer; thread=${threadTypes(events)}`);
  assert(events.some((event) => event.type === "tool_call" && event.toolName === "read_artifact"), "Agent did not call read_artifact");
  assert(toolResults(events, "read_artifact").some((event) => String(event.result).includes("SOAK_DEEP_MARKER")), "read_artifact result did not include deep marker");
  assert(lastAssistantText(events).includes("SOAK_ARTIFACT_READ_OK"), `Unexpected assistant text: ${lastAssistantText(events)}`);
  assert(lastAssistantText(events).includes("quartz-92741"), "Final answer missing deep marker value");
  assertToolPairs(events);
  return `artifact=${pointer.artifactId}; ${threadTypes(events)}`;
}

async function scenarioMemoryRecall(ctx: SoakContext): Promise<string> {
  const save = ctx.api.createSession(`${RUN_ID} memory save`);
  ctx.permissionModes.set(save.id, "allow_once");
  ctx.api.appendUserMessage(
    save.id,
    [
      "Use memory_add to save this durable project fact.",
      "Title: Complex soak recall marker.",
      "Type: project.",
      "Content: SOAK_MEMORY_COMPLEX_FACT = quartz-17.",
      "Tags: soak, complex.",
      "After saving, reply with exact prefix SOAK_MEMORY_SAVE_OK.",
    ].join("\n"),
    { source: CLI_SOURCE },
  );
  await waitForSessionStatus(ctx.api, save.id, ["idle"]);
  const saveEvents = ctx.api.getThread(save.id);
  assert(saveEvents.some((event) => event.type === "tool_call" && event.toolName === "memory_add"), "Agent did not call memory_add");
  assert(lastAssistantText(saveEvents).includes("SOAK_MEMORY_SAVE_OK"), `Unexpected memory save text: ${lastAssistantText(saveEvents)}`);

  const recall = ctx.api.createSession(`${RUN_ID} memory recall`);
  ctx.api.appendUserMessage(
    recall.id,
    [
      "Find the saved memory about SOAK_MEMORY_COMPLEX_FACT.",
      "You must call memory_search first, then memory_get using the returned id or path.",
      "Reply with exact prefix SOAK_MEMORY_RECALL_OK and include the stored value.",
    ].join("\n"),
    { source: CLI_SOURCE },
  );
  await waitForSessionStatus(ctx.api, recall.id, ["idle"]);
  const recallEvents = ctx.api.getThread(recall.id);
  assert(recallEvents.some((event) => event.type === "tool_call" && event.toolName === "memory_search"), "Agent did not call memory_search");
  assert(recallEvents.some((event) => event.type === "tool_call" && event.toolName === "memory_get"), "Agent did not call memory_get");
  assert(lastAssistantText(recallEvents).includes("SOAK_MEMORY_RECALL_OK"), `Unexpected memory recall text: ${lastAssistantText(recallEvents)}`);
  assert(lastAssistantText(recallEvents).includes("quartz-17"), "Memory recall final answer missing stored value");
  assertToolPairs(saveEvents);
  assertToolPairs(recallEvents);
  return `${threadTypes(saveEvents)} || ${threadTypes(recallEvents)}`;
}

async function scenarioHttpMultiDevicePermission(ctx: SoakContext): Promise<string> {
  const authStore = new AuthStore(join(ctx.dataDir, "auth-http-complex"));
  const gateway = new HttpGateway(ctx.api);
  const server = createHttpServer(ctx.api, gateway, {
    authStore,
    allowedOrigins: ["http://localhost"],
    maxBodyBytes: 1024 * 1024,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object", "HTTP server did not expose a port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let sessionId: string | undefined;

  try {
    const desktopPair = authStore.issuePairingCode();
    const phonePair = authStore.issuePairingCode();
    const desktop = await jsonRequest(baseUrl, "POST", "/auth/pair", {
      code: desktopPair.code,
      name: "Soak Desktop",
      kind: "desktop",
    });
    const phone = await jsonRequest(baseUrl, "POST", "/auth/pair", {
      code: phonePair.code,
      name: "Soak Android",
      kind: "android",
    });
    assert(desktop.status === 201, `desktop pair failed: ${desktop.status}`);
    assert(phone.status === 201, `phone pair failed: ${phone.status}`);
    const desktopToken = (desktop.body as { token?: string }).token;
    const phoneToken = (phone.body as { token?: string }).token;
    assert(desktopToken && phoneToken, "Pairing did not return both tokens");

    const created = await jsonRequest(baseUrl, "POST", "/sessions", { title: `${RUN_ID} http permission` }, desktopToken);
    assert(created.status === 201, `session create failed: ${created.status}`);
    sessionId = (created.body as { id?: string }).id;
    assert(sessionId, "No session id returned");
    ctx.permissionModes.set(sessionId, "manual");

    const patched = await jsonRequest(baseUrl, "PATCH", "/device-state", {
      selectedSessionId: sessionId,
      sessionReadSeq: { [sessionId]: 0 },
    }, phoneToken);
    assert(patched.status === 200, `device-state patch failed: ${patched.status}`);

    const posted = await jsonRequest(baseUrl, "POST", `/sessions/${sessionId}/messages`, {
      text: [
        "You must call bash with command='echo SOAK_MULTI_APPROVED'.",
        "After the permission is approved and the tool result arrives, reply with exact prefix SOAK_MULTI_OK.",
      ].join(" "),
    }, desktopToken);
    assert(posted.status === 202, `message post failed: ${posted.status} ${JSON.stringify(posted.body)}`);

    const corePending = await waitForCorePendingPermission(ctx.api);
    const listedPending = await waitForPendingPermission(baseUrl, phoneToken);
    assert(listedPending.id === corePending.id, "HTTP pending permission did not match Core pending permission");

    const stream = await jsonRequest(baseUrl, "POST", "/auth/stream-token", {}, phoneToken);
    assert(stream.status === 201, `stream token failed: ${stream.status}`);
    const streamToken = (stream.body as { code?: string }).code;
    assert(streamToken, "No stream token");
    const sseRaw = await readSseUntil(
      baseUrl,
      `/events?cursor=0&stream_token=${encodeURIComponent(streamToken)}`,
      "session_event",
      "\"type\":\"permission_request\"",
    );
    assert(sseRaw.includes("event: session_event"), "SSE did not replay session_event");
    assert(sseRaw.includes("\"type\":\"permission_request\""), "SSE session_event replay did not include permission_request payload");
    const responded = await jsonRequest(baseUrl, "POST", `/permission-requests/${listedPending.id}/respond`, {
      decision: "allow_once",
      message: "Approved by the Android soak device.",
    }, phoneToken);
    assert(responded.status === 200, `permission response failed: ${responded.status} ${JSON.stringify(responded.body)}`);

    await waitForSessionStatus(ctx.api, sessionId, ["idle"]);
    const thread = await jsonRequest(baseUrl, "GET", `/sessions/${sessionId}/thread?afterSeq=0`, undefined, desktopToken);
    assert(thread.status === 200, `thread read failed: ${thread.status}`);
    const events = thread.body as SessionEvent[];
    assert(events.some((event) => event.type === "permission_request"), "Thread missing permission_request");
    assert(events.some((event) => event.type === "permission_response"), "Thread missing permission_response");
    assert(toolResults(events, "bash").some((event) => String(event.result).includes("SOAK_MULTI_APPROVED")), "Bash approved output missing");
    assert(lastAssistantText(events).includes("SOAK_MULTI_OK"), `Unexpected HTTP final text: ${lastAssistantText(events)}`);
    assertToolPairs(events);
    return `events=${events.length}; sseBytes=${sseRaw.length}`;
  } finally {
    if (sessionId && ctx.api.getSession(sessionId)?.status === "running") {
      try {
        ctx.api.interruptSession(sessionId);
      } catch {
        // Best-effort cleanup for failed soak runs.
      }
    }
    gateway.destroy();
    server.close();
    await once(server, "close").catch(() => undefined);
  }
}

async function scenarioRehydrateDanglingToolCall(ctx: SoakContext): Promise<string> {
  const session = ctx.api.createSession(`${RUN_ID} dangling rehydrate`);
  ctx.api.appendUserMessage(
    session.id,
    [
      "A previous tool may have been interrupted by a process restart.",
      "If you see a restart tool error in context, do not retry the tool.",
      "Reply with exact prefix SOAK_REHYDRATE_DANGLING_OK and summarize the recovery.",
    ].join("\n"),
    { dispatch: false, source: CLI_SOURCE },
  );
  ctx.api.flush();

  const threadPath = join(ctx.dataDir, "sessions", session.id, "thread.jsonl");
  const existingEvents = ctx.api.getThread(session.id);
  const seq = Math.max(...existingEvents.map((event) => event.seq)) + 1;
  appendFileSync(threadPath, JSON.stringify({
    type: "tool_call",
    seq,
    timestamp: new Date().toISOString(),
    sessionId: session.id,
    toolName: "soak_complex_large_report",
    args: { label: "restart-dangling" },
    toolUseId: "dangling_restart_tool",
  }) + "\n", "utf-8");

  const api2 = makeCore(ctx.dataDir, ctx.provider);
  api2.loadSessions();
  const report = await api2.rehydrateAfterStartup();
  await waitForSessionStatus(api2, session.id, ["idle"]);
  const events = api2.getThread(session.id);
  assert(report.repairedToolResults >= 1, `Expected repaired dangling tool_result; report=${JSON.stringify(report)}`);
  assert(toolResults(events, "soak_complex_large_report").some((event) => event.isError && String(event.result).includes("Process restarted before this tool completed.")), "Restart repair tool_result missing");
  assert(events.filter((event) => event.type === "tool_call" && event.toolName === "soak_complex_large_report").length === 1, "Agent retried the dangling tool after restart repair");
  assert(lastAssistantText(events).includes("SOAK_REHYDRATE_DANGLING_OK"), `Unexpected rehydrate final text: ${lastAssistantText(events)}`);
  assertToolPairs(events);
  api2.flush();
  ctx.api = api2;
  return `requeued=${report.requeuedSessions.length}; repaired=${report.repairedToolResults}; ${threadTypes(events)}`;
}

type JsonResponse = { status: number; body: unknown };

async function jsonRequest(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<JsonResponse> {
  return new Promise((resolvePromise, reject) => {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (raw !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(new URL(path, baseUrl), { method, headers, timeout: DEFAULT_WAIT_MS }, (res: IncomingMessage) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        try {
          resolvePromise({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null });
        } catch {
          resolvePromise({ status: res.statusCode ?? 0, body: data });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`HTTP ${method} ${path} timed out`));
    });
    if (raw !== undefined) req.write(raw);
    req.end();
  });
}

async function waitForPendingPermission(baseUrl: string, token: string): Promise<{ id: string }> {
  const started = now();
  while (now() - started < DEFAULT_WAIT_MS) {
    const response = await jsonRequest(baseUrl, "GET", "/permission-requests?status=pending", undefined, token);
    assert(response.status === 200, `permission list failed: ${response.status}`);
    const requests = response.body as Array<{ id?: string }>;
    const first = requests.find((request) => request.id);
    if (first?.id) return { id: first.id };
    await sleep(250);
  }
  throw new Error("Timed out waiting for pending permission request");
}

async function waitForCorePendingPermission(api: CoreAPI): Promise<{ id: string }> {
  const started = now();
  while (now() - started < DEFAULT_WAIT_MS) {
    const [first] = api.getPermissionRequests({ status: "pending" });
    if (first) return { id: first.id };
    await sleep(250);
  }
  throw new Error("Timed out waiting for Core pending permission request");
}

function readSseUntil(
  baseUrl: string,
  path: string,
  expectedEvent: string,
  expectedPayload?: string,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const req = http.request(new URL(path, baseUrl), { method: "GET", timeout: DEFAULT_WAIT_MS }, (res: IncomingMessage) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk.toString();
        if (raw.includes(`event: ${expectedEvent}`) && (!expectedPayload || raw.includes(expectedPayload))) {
          req.destroy();
          resolvePromise(raw);
        }
      });
      res.on("end", () => resolvePromise(raw));
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNRESET" && expectedEvent) return;
      reject(err);
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("SSE timed out"));
    });
    req.end();
  });
}

async function main(): Promise<void> {
  if (!existsSync(".env") && !process.env.API_KEY) {
    throw new Error("No .env file or API_KEY environment variable found. Complex real soak requires a provider key.");
  }

  const ctx = setupCore();
  const allScenarios: Array<[string, (ctx: SoakContext) => Promise<string>]> = [
    ["coding_repair", scenarioCodingRepair],
    ["sandbox_recovery", scenarioSandboxRecovery],
    ["artifact_read", scenarioArtifactRead],
    ["memory_recall", scenarioMemoryRecall],
    ["http_multidevice_permission", scenarioHttpMultiDevicePermission],
    ["rehydrate_dangling_tool_call", scenarioRehydrateDanglingToolCall],
  ];
  const selected = process.env.SOAK_COMPLEX_SCENARIOS
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const scenarios = selected && selected.length > 0
    ? allScenarios.filter(([name]) => selected.includes(name))
    : allScenarios;
  assert(scenarios.length > 0, `No scenarios selected. Available: ${allScenarios.map(([name]) => name).join(", ")}`);

  const results: ScenarioResult[] = [];
  console.log(`[complex-soak] run=${RUN_ID} provider=${PROVIDER_KIND} cycles=${CYCLES} dataDir=${DATA_DIR}`);
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    console.log(`[complex-soak] cycle ${cycle + 1}/${CYCLES}`);
    for (const [name, scenario] of scenarios) {
      const result = await runScenario(`${name}#${cycle + 1}`, () => scenario(ctx));
      results.push(result);
      const mark = result.ok ? "PASS" : "FAIL";
      console.log(`[complex-soak] ${mark} ${result.name} ${result.durationMs}ms ${result.detail.split("\n")[0]}`);
      if (!result.ok && process.env.SOAK_CONTINUE_ON_FAILURE !== "1") break;
    }
    if (results.some((result) => !result.ok) && process.env.SOAK_CONTINUE_ON_FAILURE !== "1") break;
  }

  ctx.api.flush();
  const failed = results.filter((result) => !result.ok);
  const reportPath = join(DATA_DIR, "complex-soak-report.json");
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(reportPath, JSON.stringify({
    runId: RUN_ID,
    provider: PROVIDER_KIND,
    cycles: CYCLES,
    results,
    sessions: ctx.api.listSessions(),
    systemEvents: ctx.api.getSystemEvents(),
  }, null, 2), "utf-8");

  console.log(`[complex-soak] report=${reportPath}`);
  console.log(`[complex-soak] summary pass=${results.length - failed.length} fail=${failed.length}`);
  if (failed.length > 0) {
    for (const failure of failed) {
      console.error(`[complex-soak] failure ${failure.name}\n${failure.detail}`);
    }
    process.exitCode = 1;
  }

  if (process.env.SOAK_PRINT_LAST_REPORT === "1") {
    console.log(readFileSync(reportPath, "utf-8"));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
