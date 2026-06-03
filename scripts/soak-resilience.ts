import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CoreAPI } from "../src/core/core-api.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { buildTool } from "../src/tools/schemas.js";
import { AnthropicProvider } from "../src/agent/anthropic-provider.js";
import { OpenAIProvider } from "../src/agent/openai-provider.js";
import { DeepSeekProvider } from "../src/agent/deepseek-provider.js";
import { BrowserRuntime } from "../src/runtimes/browser/browser-runtime.js";
import type { CdpTransport } from "../src/runtimes/browser/cdp-client.js";
import type { ModelMessage, ModelProvider, ModelResponse } from "../src/agent/model-provider.js";
import type { SessionEvent, ToolCall } from "../src/streams/event-types.js";

type ScenarioResult = {
  name: string;
  ok: boolean;
  durationMs: number;
  detail: string;
};

type SoakContext = {
  dataDir: string;
  workspaceDir: string;
  provider: ModelProvider;
};

type PermissionMode = "allow_once" | "allow_session" | "deny" | "manual";

const DATA_DIR = resolve(process.env.SOAK_RESILIENCE_DATA_DIR ?? ".forge-soak-resilience");
const WORKSPACE_DIR = resolve(DATA_DIR, "workspace");
const RUN_ID = `resilience_${new Date().toISOString().replace(/[:.]/g, "-")}`;
const DEFAULT_WAIT_MS = Number(process.env.SOAK_RESILIENCE_WAIT_MS ?? "240000");
const CYCLES = Number(process.env.SOAK_RESILIENCE_CYCLES ?? "1");
const PROVIDER_KIND = (process.env.SOAK_PROVIDER ?? "deepseek").toLowerCase();

const CLI_SOURCE = {
  kind: "cli" as const,
  interactive: true,
  deviceId: "resilience-soak-cli",
  deviceName: "Resilience Soak Harness",
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

function registerResilienceTools(registry: ToolRegistry): void {
  registry.register(buildTool({
    name: "soak_hanging_tool",
    description: "A soak test tool that intentionally runs for a long time until interrupted.",
    params: {
      label: { type: "string", description: "Marker label" },
    },
    capabilities: ["fs.read"],
    isConcurrencySafe: false,
    isReadOnly: true,
    handler: async (args) => {
      const label = String(args.label ?? "hang");
      await new Promise((resolvePromise) => {
        const timer = setTimeout(resolvePromise, 120_000);
        timer.unref?.();
      });
      return `SOAK_HANG_FINISHED:${label}`;
    },
  }));
}

function makeCore(
  ctx: SoakContext,
  options?: ConstructorParameters<typeof CoreAPI>[1],
): { api: CoreAPI; permissionModes: Map<string, PermissionMode> } {
  const registry = new ToolRegistry();
  const api = new CoreAPI(registry, {
    dataDir: ctx.dataDir,
    memoryDir: join(ctx.dataDir, "memory"),
    artifactDir: join(ctx.dataDir, "artifacts"),
    ...options,
  });
  api.registerBuiltInTools();
  registerResilienceTools(registry);
  api.initSupervisor(2);
  api.initScheduler();
  api.initMemoryManager({ autoRun: false });
  api.initToolPolicy({
    timeoutMs: Number(process.env.SOAK_RESILIENCE_PERMISSION_TIMEOUT_MS ?? "45000"),
    projectRoot: process.cwd(),
  });
  api.setModelProvider(ctx.provider);

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
            ? "Resilience soak intentionally denied this permission request."
            : "Resilience soak auto-approved this permission request.",
          deviceId: "resilience-soak-cli",
          deviceName: "Resilience Soak Harness",
        });
      } catch {
        // The request may already have been interrupted.
      }
    }, 10);
  });

  return { api, permissionModes };
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
    await sleep(100);
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
    const event = api.getThread(sessionId).find(predicate);
    if (event) return event;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for event in ${sessionId}`);
}

async function runScenario(name: string, fn: () => Promise<string>): Promise<ScenarioResult> {
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

function lastAssistantText(events: SessionEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "assistant_message") return event.text;
  }
  return "";
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

async function scenarioProviderInterrupt(ctx: SoakContext): Promise<string> {
  const { api } = makeCore(ctx);
  const session = api.createSession(`${RUN_ID} provider interrupt`);
  let sawDelta = false;
  const unsubscribe = api.onSessionEvent((sid, event) => {
    if (sid === session.id && event.type === "assistant_delta") sawDelta = true;
  });
  try {
    try {
      api.appendUserMessage(
        session.id,
        [
          "Write a long answer with at least 120 numbered lines.",
          "Do not call tools.",
          "Every line should include SOAK_PROVIDER_INTERRUPT_STREAM.",
        ].join(" "),
        { source: CLI_SOURCE },
      );
      const started = now();
      while (!sawDelta && now() - started < DEFAULT_WAIT_MS) {
        if (api.getSession(session.id)?.status !== "running") break;
        await sleep(50);
      }
      assert(sawDelta, "Provider did not stream before interrupt");
      api.interruptSession(session.id);
      await waitForSessionStatus(api, session.id, ["idle"]);

      const events = api.getThread(session.id);
      assert(!events.some((event) => event.type === "assistant_message"), "Assistant message was committed after provider interrupt");
      assert(!events.some((event) => event.type === "runtime_event" && event.detail === "failed"), "Provider interrupt produced a failure event");
      return threadTypes(events);
    } finally {
      await api.shutdown();
    }
  } finally {
    unsubscribe();
  }
}

async function scenarioToolInterrupt(ctx: SoakContext): Promise<string> {
  const { api } = makeCore(ctx);
  const session = api.createSession(`${RUN_ID} tool interrupt`);
  try {
    api.appendUserMessage(
      session.id,
      [
        "You must call soak_hanging_tool with label='tool-interrupt'.",
        "Do not call any other tool.",
        "If interrupted, do not produce a final answer.",
      ].join(" "),
      { source: CLI_SOURCE },
    );
    await waitForThreadEvent(api, session.id, (event) => event.type === "tool_call" && event.toolName === "soak_hanging_tool");
    api.interruptSession(session.id);
    await waitForSessionStatus(api, session.id, ["idle"]);
    const events = api.getThread(session.id);
    assert(events.some((event) =>
      event.type === "tool_result" &&
      event.toolName === "soak_hanging_tool" &&
      event.isError &&
      String(event.result).includes("Interrupted by user before tool completed."),
    ), "Interrupted tool_result was not written");
    assert(!events.some((event) => event.type === "assistant_message"), "Assistant message was committed after tool interrupt");
    assertToolPairs(events);
    return threadTypes(events);
  } finally {
    await api.shutdown();
  }
}

async function scenarioPendingPermissionInterrupt(ctx: SoakContext): Promise<string> {
  const { api, permissionModes } = makeCore(ctx);
  const session = api.createSession(`${RUN_ID} permission interrupt`);
  permissionModes.set(session.id, "manual");
  try {
    api.appendUserMessage(
      session.id,
      [
        "You must call bash with command='echo SHOULD_NOT_RUN_PERMISSION_INTERRUPT'.",
        "Wait for permission if required.",
      ].join(" "),
      { source: CLI_SOURCE },
    );
    await waitForThreadEvent(api, session.id, (event) => event.type === "permission_request");
    api.interruptSession(session.id);
    await waitForSessionStatus(api, session.id, ["idle"]);
    const events = api.getThread(session.id);
    assert(events.some((event) => event.type === "permission_request"), "Permission request missing");
    assert(events.some((event) => event.type === "tool_result" && event.toolName === "bash" && event.isError), "Interrupt did not close pending bash tool_call with an error result");
    assert(!events.some((event) => event.type === "tool_result" && String(event.result).includes("SHOULD_NOT_RUN_PERMISSION_INTERRUPT")), "Interrupted command appears to have executed");
    assertToolPairs(events);
    return threadTypes(events);
  } finally {
    await api.shutdown();
  }
}

async function scenarioAutoCompaction(ctx: SoakContext): Promise<string> {
  const { api } = makeCore(ctx, {
    maxContextTokens: 450,
    autoCompactBuffer: 100,
    compactionKeepRecentTokens: 1,
  });
  const session = api.createSession(`${RUN_ID} auto compaction`);
  const filler = "context-filler ".repeat(1200);
  try {
    api.appendUserMessage(
      session.id,
      [
        "Important durable fact for automatic compaction: SOAK_COMPACTION_AUTO_FACT = amber-44.",
        "Reply with exact prefix SOAK_COMPACTION_STAGE1_OK.",
        filler,
      ].join("\n"),
      { source: CLI_SOURCE },
    );
    await waitForSessionStatus(api, session.id, ["idle", "blocked"]);
    assert(api.getSession(session.id)?.status === "idle", `Initial compaction turn ended as ${api.getSession(session.id)?.status}`);
    let events = api.getThread(session.id);
    assert(events.some((event) => event.type === "compaction_block"), `No compaction_block after threshold-crossing turn; thread=${threadTypes(events)}`);

    api.appendUserMessage(
      session.id,
      "Using the compacted history, what is SOAK_COMPACTION_AUTO_FACT? Reply with exact prefix SOAK_COMPACTION_AUTO_OK.",
      { source: CLI_SOURCE },
    );
    await waitForSessionStatus(api, session.id, ["idle"]);
    events = api.getThread(session.id);
    assert(lastAssistantText(events).includes("SOAK_COMPACTION_AUTO_OK"), `Unexpected compaction follow-up answer: ${lastAssistantText(events)}`);
    assert(lastAssistantText(events).includes("amber-44"), "Compacted fact was not recovered in follow-up answer");
    return threadTypes(events);
  } finally {
    await api.shutdown();
  }
}

class AutoCdpTransport implements CdpTransport {
  onMessage: ((data: string) => void) | null = null;
  onClose: (() => void) | null = null;
  onError: ((err: Error) => void) | null = null;
  sent: string[] = [];
  closed = false;
  #targetCounter = 0;
  #sessionCounter = 0;

  send(data: string): void {
    this.sent.push(data);
    const msg = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown> };
    setTimeout(() => this.#respond(msg), 0);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }

  unexpectedClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }

  #respond(msg: { id: number; method: string; params?: Record<string, unknown> }): void {
    if (this.closed) return;
    switch (msg.method) {
      case "Browser.getVersion":
        this.#emit({ id: msg.id, result: { product: "SoakChrome/1.0" } });
        break;
      case "Target.createTarget": {
        this.#targetCounter++;
        this.#emit({ id: msg.id, result: { targetId: `target-${this.#targetCounter}` } });
        break;
      }
      case "Target.attachToTarget": {
        this.#sessionCounter++;
        this.#emit({ id: msg.id, result: { sessionId: `cdp-session-${this.#sessionCounter}` } });
        break;
      }
      case "Runtime.evaluate":
        this.#emit({ id: msg.id, result: { result: { value: "SOAK_BROWSER_RUNTIME_OK" } } });
        break;
      case "Target.closeTarget":
      case "Page.enable":
      case "Page.navigate":
        this.#emit({ id: msg.id, result: {} });
        break;
      default:
        this.#emit({ id: msg.id, result: {} });
    }
  }

  #emit(message: unknown): void {
    this.onMessage?.(JSON.stringify(message));
  }
}

class RecoveringProvider implements ModelProvider {
  calls = 0;
  aborted = false;
  startedFirst!: () => void;
  firstStarted = new Promise<void>((resolve) => {
    this.startedFirst = resolve;
  });

  async generate(
    _messages: ModelMessage[],
    _tools?: unknown,
    callbacks?: { signal?: AbortSignal },
  ): Promise<ModelResponse> {
    this.calls++;
    if (this.calls === 1) {
      callbacks?.signal?.addEventListener("abort", () => {
        this.aborted = true;
      }, { once: true });
      this.startedFirst();
      await new Promise(() => undefined);
    }
    return {
      text: "SOAK_BROWSER_RUNTIME_RECOVER_OK",
      finishReason: "stop",
      rawUsage: { input_tokens: 10, output_tokens: 5 },
    };
  }
}

async function scenarioBrowserRuntimeReconnect(ctx: SoakContext): Promise<string> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/soak",
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  const firstTransport = new AutoCdpTransport();
  const secondTransport = new AutoCdpTransport();
  const transports = [firstTransport, secondTransport];
  const browser = new BrowserRuntime({
    cdpUrl: "http://127.0.0.1:9222",
    wsTransport: async () => {
      const transport = transports.shift();
      if (!transport) throw new Error("No reconnect transport available");
      return transport;
    },
    baseDelayMs: 20,
    maxDelayMs: 20,
    giveUpAfterMs: 1000,
    jitterMs: 0,
  });

  const registry = new ToolRegistry();
  const api = new CoreAPI(registry, {
    dataDir: ctx.dataDir,
    memoryDir: join(ctx.dataDir, "memory"),
    artifactDir: join(ctx.dataDir, "artifacts"),
  });
  api.registerBuiltInTools();
  api.initSupervisor(1);
  api.initRuntimeManager();
  api.registerBrowserRuntime("browser", browser);
  api.initMemoryManager({ autoRun: false });
  const provider = new RecoveringProvider();
  api.setModelProvider(provider);

  try {
    await api.startRuntimes();
    const session = api.createSession(`${RUN_ID} browser runtime reconnect`);
    await browser.createTab(session.id);
    await waitForThreadEvent(api, session.id, (event) => event.type === "runtime_event" && event.detail === "attached");

    api.appendUserMessage(session.id, "Continue after runtime recovery and reply with SOAK_BROWSER_RUNTIME_RECOVER_OK.", { source: CLI_SOURCE });
    await provider.firstStarted;
    firstTransport.unexpectedClose();

    await waitForThreadEvent(api, session.id, (event) => event.type === "runtime_event" && event.detail === "degraded");
    await waitForThreadEvent(api, session.id, (event) => event.type === "runtime_event" && event.detail === "reattached");
    await waitForThreadEvent(api, session.id, (event) => event.type === "runtime_event" && event.detail === "recovered");
    await waitForSessionStatus(api, session.id, ["idle"]);

    const events = api.getThread(session.id);
    assert(provider.aborted, "Runtime failure did not abort the active turn");
    assert(api.getSession(session.id)?.status === "idle", "Recovered runtime session did not finish idle");
    assert(lastAssistantText(events).includes("SOAK_BROWSER_RUNTIME_RECOVER_OK"), `Unexpected runtime recovery final answer: ${lastAssistantText(events)}`);
    assert(events.some((event) => event.type === "runtime_event" && event.detail === "attached"), "Attached runtime event missing");
    assert(events.some((event) => event.type === "runtime_event" && event.detail === "degraded"), "Degraded runtime event missing");
    assert(events.some((event) => event.type === "runtime_event" && event.detail === "reattached"), "Reattached runtime event missing");
    assert(events.some((event) => event.type === "runtime_event" && event.detail === "recovered"), "Recovered runtime event missing");
    api.flush();
    return threadTypes(events);
  } finally {
    await api.shutdown();
    await browser.disconnect().catch(() => undefined);
    globalThis.fetch = originalFetch;
  }
}

async function main(): Promise<void> {
  if (!existsSync(".env") && !process.env.API_KEY) {
    throw new Error("No .env file or API_KEY environment variable found. Resilience soak requires a provider key.");
  }

  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  const ctx: SoakContext = {
    dataDir: DATA_DIR,
    workspaceDir: WORKSPACE_DIR,
    provider: makeProvider(),
  };

  const allScenarios: Array<[string, (ctx: SoakContext) => Promise<string>]> = [
    ["provider_interrupt", scenarioProviderInterrupt],
    ["tool_interrupt", scenarioToolInterrupt],
    ["pending_permission_interrupt", scenarioPendingPermissionInterrupt],
    ["auto_compaction", scenarioAutoCompaction],
    ["browser_runtime_reconnect", scenarioBrowserRuntimeReconnect],
  ];
  const selected = process.env.SOAK_RESILIENCE_SCENARIOS
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const scenarios = selected && selected.length > 0
    ? allScenarios.filter(([name]) => selected.includes(name))
    : allScenarios;
  assert(scenarios.length > 0, `No scenarios selected. Available: ${allScenarios.map(([name]) => name).join(", ")}`);

  const results: ScenarioResult[] = [];
  console.log(`[resilience-soak] run=${RUN_ID} provider=${PROVIDER_KIND} cycles=${CYCLES} dataDir=${DATA_DIR}`);
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    console.log(`[resilience-soak] cycle ${cycle + 1}/${CYCLES}`);
    for (const [name, scenario] of scenarios) {
      const result = await runScenario(`${name}#${cycle + 1}`, () => scenario(ctx));
      results.push(result);
      console.log(`[resilience-soak] ${result.ok ? "PASS" : "FAIL"} ${result.name} ${result.durationMs}ms ${result.detail.split("\n")[0]}`);
      if (!result.ok && process.env.SOAK_CONTINUE_ON_FAILURE !== "1") break;
    }
    if (results.some((result) => !result.ok) && process.env.SOAK_CONTINUE_ON_FAILURE !== "1") break;
  }

  const failed = results.filter((result) => !result.ok);
  const reportPath = join(DATA_DIR, "resilience-soak-report.json");
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(reportPath, JSON.stringify({
    runId: RUN_ID,
    provider: PROVIDER_KIND,
    cycles: CYCLES,
    results,
  }, null, 2), "utf-8");
  console.log(`[resilience-soak] report=${reportPath}`);
  console.log(`[resilience-soak] summary pass=${results.length - failed.length} fail=${failed.length}`);
  if (failed.length > 0) {
    for (const failure of failed) {
      console.error(`[resilience-soak] failure ${failure.name}\n${failure.detail}`);
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
