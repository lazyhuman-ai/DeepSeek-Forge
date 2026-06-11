import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http, { type IncomingMessage } from "node:http";
import net from "node:net";
import { join, resolve } from "node:path";
import { chromium as playwrightChromium } from "@playwright/test";
import { CoreAPI } from "../src/core/core-api.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { DeepSeekProvider } from "../src/agent/deepseek-provider.js";
import { OpenAIProvider } from "../src/agent/openai-provider.js";
import { AnthropicProvider } from "../src/agent/anthropic-provider.js";
import type { ModelProvider } from "../src/agent/model-provider.js";
import { ToolRuntime } from "../src/tools/tool-runtime.js";
import type { PermissionResponseDecision, ToolRequestSource } from "../src/permissions/tool-policy.js";
import type { PermissionGrantKind, SessionEvent, ToolResult } from "../src/streams/event-types.js";
import { startHttpGateway, type StartedHttpGateway } from "../src/gateways/http/app.js";
import { defaultWebridgeExtensionDir, ensureWebridgeManifestCompatibility } from "../src/cli/webridge-package.js";
import { CdpClient, type CdpTransport } from "../src/runtimes/browser/cdp-client.js";

type ScenarioResult = {
  name: string;
  ok: boolean;
  durationMs: number;
  detail: string;
  diagnostics?: Record<string, unknown>;
  artifacts?: string[];
  failures?: string[];
  fixes?: string[];
};

type ReleaseReport = {
  runId: string;
  startedAt: string;
  provider: string;
  model?: string;
  dataDir: string;
  results: ScenarioResult[];
};

type ReleaseContext = {
  api: CoreAPI;
  registry: ToolRegistry;
  provider: ModelProvider;
  dataDir: string;
  workspaceDir: string;
  autoResponses: Map<string, PermissionResponseDecision>;
  autoPermissionGrants: Map<string, PermissionGrantKind[]>;
};

type ChromeHandle = {
  process: ChildProcessWithoutNullStreams;
  cdpUrl: string;
  port: number;
  profileDir: string;
  executablePath: string;
  stderr: string[];
};

const DATA_DIR = resolve(process.env.RELEASE_E2E_DATA_DIR ?? ".forge-release-e2e");
const RUN_ID = `release_${new Date().toISOString().replace(/[:.]/g, "-")}`;
const REPORT_DIR = join(DATA_DIR, "reports");
const WORKSPACE_DIR = join(DATA_DIR, "workspace");
const DEFAULT_WAIT_MS = Number(process.env.RELEASE_E2E_WAIT_MS ?? "300000");
const PROVIDER_KIND = (process.env.RELEASE_E2E_PROVIDER ?? process.env.SOAK_PROVIDER ?? "deepseek").toLowerCase();
const FS_MCP_PACKAGE = process.env.RELEASE_E2E_MCP_FILESYSTEM_PACKAGE ?? "@modelcontextprotocol/server-filesystem@2026.1.14";
const EVERYTHING_MCP_PACKAGE = process.env.RELEASE_E2E_MCP_EVERYTHING_PACKAGE ?? "@modelcontextprotocol/server-everything@2026.1.26";
const DEVICE_SOURCE: ToolRequestSource = {
  kind: "cli",
  interactive: true,
  deviceId: "release-e2e-device",
  deviceName: "Release E2E Harness",
};

function now(): number {
  return Date.now();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hasTypeScriptVerificationEvidence(events: SessionEvent[]): boolean {
  const hasVerificationTool = events.some((event) => (
    event.type === "tool_call" &&
    (
      (event.toolName === "bash" && JSON.stringify(event.args).includes("tsc")) ||
      event.toolName === "verify_workspace" ||
      event.toolName === "lsp_diagnostics"
    )
  ));
  const hasDurableVerification = events.some((event) => (
    event.type === "verification_event" &&
    (
      /\b(?:tsc|typecheck|check|test|build|lint)\b/i.test(event.command) ||
      /\b(?:tsc|TypeScript|typecheck|check|test|build|lint)\b/i.test(event.summary)
    )
  ));
  return hasVerificationTool && hasDurableVerification;
}

function hasPassedTypeScriptVerification(checks: SessionEvent[]): boolean {
  return checks.some((event) => (
    event.type === "verification_event" &&
    event.status === "passed" &&
    (
      /\b(?:tsc|typecheck|check|test|build|lint)\b/i.test(event.command) ||
      /\b(?:tsc|TypeScript|typecheck|check|test|build|lint)\b/i.test(event.summary)
    )
  ));
}

function hasPassedWorkspaceTest(checks: SessionEvent[]): boolean {
  return checks.some((event) => (
    event.type === "verification_event" &&
    event.status === "passed" &&
    /\b(?:test|check|make test|unittest|pytest)\b/i.test(`${event.command}\n${event.summary}`)
  ));
}

function eventPayloadText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isVerifierPassEvidence(event: SessionEvent): boolean {
  if (event.type === "tool_result") {
    if (event.isError === true) return false;
    if (event.toolName !== "agent_task" && event.toolName !== "agent_task_output") return false;
    const text = eventPayloadText(event.result);
    if (!/VERDICT\s*:\s*PASS/i.test(text)) return false;
    if (event.toolName === "agent_task_output") {
      return /"status"\s*:\s*"completed"|status:\s*completed/i.test(text);
    }
    return true;
  }
  if (event.type === "activity_event") {
    if (event.activityKind !== "verification" || event.status !== "completed") return false;
    const payloadVerdict = typeof event.payload?.verdict === "string" ? event.payload.verdict : "";
    return /subagent/i.test(event.title) && (
      /^PASS$/i.test(payloadVerdict) ||
      /VERDICT\s*:\s*PASS/i.test(`${event.message}\n${eventPayloadText(event.payload)}`)
    );
  }
  return false;
}

function hasPythonNavigationEvidence(events: SessionEvent[]): boolean {
  return events.some((event) => {
    if (event.type !== "tool_result" || event.toolName !== "lsp_query" || event.isError === true) return false;
    const text = eventPayloadText(event.result);
    const namesExpected = /PriceCalculator|subtotal|build_dataset|DataLoader/i.test(text);
    return namesExpected && (
      /Language-server symbols|Pyright|Generic (?:lexical )?code index|Generic code index/i.test(text)
    );
  });
}

function isImplementationSubagentHandoff(event: SessionEvent, afterSeq: number): boolean {
  if (event.type !== "tool_result" || event.seq <= afterSeq || event.isError === true) return false;
  if (event.toolName !== "agent_task" && event.toolName !== "agent_task_output") return false;
  const text = eventPayloadText(event.result);
  if (!/SUMMARY/i.test(text)) return false;
  if (event.toolName === "agent_task") {
    return /src\/math\.ts|totalVisits/i.test(text) &&
      /CHECKS|HANDOFF|typecheck|verified|passed/i.test(text);
  }
  if (!/"status"\s*:\s*"completed"|status:\s*completed/i.test(text)) return false;
  return /workspace_write/i.test(text) &&
    /edit_file|multi_edit_file|apply_patch_file/i.test(text) &&
    /verify_workspace/i.test(text) &&
    /git_diff/i.test(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function runScenario(name: string, fn: () => Promise<string | { detail: string; diagnostics?: Record<string, unknown>; artifacts?: string[] }>): Promise<ScenarioResult> {
  const started = now();
  try {
    const output = await fn();
    if (typeof output === "string") {
      return { name, ok: true, durationMs: now() - started, detail: output };
    }
    return {
      name,
      ok: true,
      durationMs: now() - started,
      detail: output.detail,
      ...(output.diagnostics !== undefined ? { diagnostics: output.diagnostics } : {}),
      ...(output.artifacts !== undefined ? { artifacts: output.artifacts } : {}),
    };
  } catch (err) {
    return {
      name,
      ok: false,
      durationMs: now() - started,
      detail: err instanceof Error ? err.stack ?? err.message : String(err),
      failures: [err instanceof Error ? err.message : String(err)],
    };
  }
}

function providerConfigured(): boolean {
  return existsSync(".env") || Boolean(
    process.env.API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY,
  );
}

function makeProvider(): ModelProvider {
  if (PROVIDER_KIND === "openai") {
    return new OpenAIProvider({
      requestTimeoutMs: Number(process.env.RELEASE_E2E_PROVIDER_TIMEOUT_MS ?? "120000"),
      maxRetries: Number(process.env.RELEASE_E2E_PROVIDER_RETRIES ?? "1"),
    });
  }
  if (PROVIDER_KIND === "anthropic") {
    return new AnthropicProvider({
      requestTimeoutMs: Number(process.env.RELEASE_E2E_PROVIDER_TIMEOUT_MS ?? "120000"),
      maxRetries: Number(process.env.RELEASE_E2E_PROVIDER_RETRIES ?? "1"),
    });
  }
  return new DeepSeekProvider({
    requestTimeoutMs: Number(process.env.RELEASE_E2E_PROVIDER_TIMEOUT_MS ?? "120000"),
    maxRetries: Number(process.env.RELEASE_E2E_PROVIDER_RETRIES ?? "1"),
  });
}

function setupCore(): ReleaseContext {
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  const registry = new ToolRegistry();
  const api = new CoreAPI(registry, {
    dataDir: join(DATA_DIR, "core"),
    memoryDir: join(DATA_DIR, "core", "memory"),
    artifactDir: join(DATA_DIR, "core", "artifacts"),
    contextWindowTokens: Number(process.env.RELEASE_E2E_CONTEXT_WINDOW_TOKENS ?? "1000000"),
  });
  api.registerBuiltInTools();
  api.initSupervisor(3);
  api.initScheduler();
  api.initMemoryManager({ autoRun: false, proposalThreshold: 2 });
  api.initSkillEcosystem();
  api.initToolPolicy({
    projectRoot: WORKSPACE_DIR,
    timeoutMs: Number(process.env.RELEASE_E2E_PERMISSION_TIMEOUT_MS ?? "30000"),
  });
  const provider = makeProvider();
  api.setModelProvider(provider);
  api.initMcpEcosystem({
    projectRoot: WORKSPACE_DIR,
    baseDelayMs: 250,
    maxDelayMs: 1_000,
    keepaliveMs: 120_000,
    failureCooldownMs: 1_000,
  });

  const autoResponses = new Map<string, PermissionResponseDecision>();
  const autoPermissionGrants = new Map<string, PermissionGrantKind[]>();
  const createdAutoGrants = new Set<string>();
  api.onSessionEvent((sessionId, event) => {
    if (event.type !== "permission_request") return;
    const decision = autoResponses.get(sessionId) ?? "allow_once";
    const grants = autoPermissionGrants.get(sessionId) ?? [];
    for (const grantKind of grants) {
      const key = `${sessionId}:${grantKind}`;
      if (!createdAutoGrants.has(key)) {
        createdAutoGrants.add(key);
        setTimeout(() => {
          try {
            api.createPermissionGrant(sessionId, {
              grantKind,
              scope: "session",
            });
          } catch {
            // The session may have ended before the release harness can grant.
          }
        }, 0);
      }
    }
    setTimeout(() => {
      try {
        api.respondToPermissionRequest(event.permissionRequestId, {
          decision,
          message: decision === "deny"
            ? "Release E2E intentionally denied this permission request."
            : "Release E2E auto-approved this permission request.",
          deviceId: DEVICE_SOURCE.deviceId,
          deviceName: DEVICE_SOURCE.deviceName,
        });
      } catch {
        // Request may have been answered, interrupted, or timed out.
      }
    }, 10);
  });

  return { api, registry, provider, dataDir: DATA_DIR, workspaceDir: WORKSPACE_DIR, autoResponses, autoPermissionGrants };
}

function setupIsolatedCore(input: {
  dataDir: string;
  workspaceDir: string;
  contextWindowTokens?: number;
  autoCompactBuffer?: number;
  compactionKeepRecentTokens?: number;
}): ReleaseContext {
  mkdirSync(input.workspaceDir, { recursive: true });
  const registry = new ToolRegistry();
  const api = new CoreAPI(registry, {
    dataDir: join(input.dataDir, "core"),
    memoryDir: join(input.dataDir, "core", "memory"),
    artifactDir: join(input.dataDir, "core", "artifacts"),
    ...(input.contextWindowTokens !== undefined ? { contextWindowTokens: input.contextWindowTokens } : {}),
    ...(input.autoCompactBuffer !== undefined ? { autoCompactBuffer: input.autoCompactBuffer } : {}),
    ...(input.compactionKeepRecentTokens !== undefined ? { compactionKeepRecentTokens: input.compactionKeepRecentTokens } : {}),
  });
  api.registerBuiltInTools();
  api.initSupervisor(2);
  api.initScheduler();
  api.initMemoryManager({ autoRun: false, proposalThreshold: 2 });
  api.initSkillEcosystem();
  api.initToolPolicy({
    projectRoot: input.workspaceDir,
    timeoutMs: Number(process.env.RELEASE_E2E_PERMISSION_TIMEOUT_MS ?? "30000"),
  });
  const provider = makeProvider();
  api.setModelProvider(provider);
  api.initMcpEcosystem({
    projectRoot: input.workspaceDir,
    baseDelayMs: 250,
    maxDelayMs: 1_000,
    keepaliveMs: 120_000,
    failureCooldownMs: 1_000,
  });

  const autoResponses = new Map<string, PermissionResponseDecision>();
  const autoPermissionGrants = new Map<string, PermissionGrantKind[]>();
  api.onSessionEvent((sessionId, event) => {
    if (event.type !== "permission_request") return;
    const decision = autoResponses.get(sessionId) ?? "allow_once";
    setTimeout(() => {
      try {
        api.respondToPermissionRequest(event.permissionRequestId, {
          decision,
          message: "Release E2E isolated core auto-response.",
          deviceId: DEVICE_SOURCE.deviceId,
          deviceName: DEVICE_SOURCE.deviceName,
        });
      } catch {
        // The request may already have been answered or cancelled.
      }
    }, 10);
  });

  return { api, registry, provider, dataDir: input.dataDir, workspaceDir: input.workspaceDir, autoResponses, autoPermissionGrants };
}

async function waitForSessionStatus(api: CoreAPI, sessionId: string, statuses: string[], timeoutMs = DEFAULT_WAIT_MS): Promise<void> {
  const started = now();
  while (now() - started < timeoutMs) {
    const status = api.getSession(sessionId)?.status;
    if (status && statuses.includes(status)) return;
    if (status === "blocked" && !statuses.includes("blocked")) {
      const runtimeEvents = api.getThread(sessionId).filter((event) => event.type === "runtime_event");
      const latest = runtimeEvents.at(-1);
      const reason = latest?.type === "runtime_event" ? latest.message : "No runtime_event was recorded.";
      throw new Error(`Session ${sessionId} became blocked while waiting for ${statuses.join("|")}: ${reason}`);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for session ${sessionId}; current status=${api.getSession(sessionId)?.status}`);
}

function threadTypes(events: SessionEvent[]): string {
  return events.map((event) => event.type === "runtime_event" ? `${event.type}:${event.detail}` : event.type).join(" -> ");
}

function lastAssistantText(events: SessionEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "assistant_message") return event.text;
  }
  return "";
}

function assertToolPairs(events: SessionEvent[]): void {
  const calls = new Map<string, string>();
  const results = new Set<string>();
  for (const event of events) {
    if (event.type === "tool_call") calls.set(event.toolUseId ?? `seq_${event.seq}`, event.toolName);
    if (event.type === "tool_result") results.add(event.toolUseId ?? `seq_${event.seq - 1}`);
  }
  const missing = [...calls.keys()].filter((id) => !results.has(id));
  assert(missing.length === 0, `Dangling tool_call(s): ${missing.map((id) => `${id}:${calls.get(id)}`).join(", ")}`);
}

function successfulToolUseIds(events: SessionEvent[], toolName: string): string[] {
  return events
    .filter((event): event is ToolResult => event.type === "tool_result" && event.toolName === toolName && event.isError !== true)
    .map((event) => event.toolUseId ?? `seq_${event.seq - 1}`);
}

function serialize(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function scenarioChildSoak(scriptName: "soak:real" | "soak:browser", env: Record<string, string>): Promise<{ detail: string; artifacts: string[] }> {
  const childEnv = {
    ...process.env,
    ...env,
    SOAK_CONTINUE_ON_FAILURE: process.env.RELEASE_E2E_CONTINUE_ON_FAILURE ?? "0",
  };
  const result = await runChild("npm", ["run", scriptName], childEnv);
  return {
    detail: result.stdout.split("\n").filter(Boolean).slice(-8).join("\n") || `${scriptName} completed`,
    artifacts: result.artifacts,
  };
}

async function runChild(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; artifacts: string[] }> {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf-8");
    stdout += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf-8");
    stderr += text;
    process.stderr.write(text);
  });
  const [code] = await once(child, "exit") as [number | null];
  const artifacts = [...stdout.matchAll(/report=([^\s]+)/g)].map((match) => resolve(match[1]!));
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${code}\n${stderr || stdout}`);
  }
  return { stdout, stderr, artifacts };
}

async function scenarioRealMcp(ctx: ReleaseContext): Promise<{ detail: string; diagnostics: Record<string, unknown> }> {
  const project = ctx.api.createProject({
    name: "Release MCP Workspace",
    path: ctx.workspaceDir,
    create: true,
    trustState: "trusted",
  });
  ctx.api.addMcpServer({
    id: "release_fs",
    name: "release_fs",
    enabled: true,
    transport: "stdio",
    launchMode: "eager",
    trust: "trusted",
    command: "npx",
    args: ["-y", FS_MCP_PACKAGE, ctx.workspaceDir],
    timeoutMs: 60_000,
    connectTimeoutMs: 60_000,
  });
  ctx.api.addMcpServer({
    id: "release_everything",
    name: "release_everything",
    enabled: true,
    transport: "stdio",
    launchMode: "eager",
    trust: "trusted",
    command: "npx",
    args: ["-y", EVERYTHING_MCP_PACKAGE],
    timeoutMs: 90_000,
    connectTimeoutMs: 60_000,
    allowSampling: true,
    allowElicitation: true,
  });
  await ctx.api.startMcpEcosystem();

  const status = ctx.api.getMcpStatus();
  assert(status.connected >= 2, `Expected two connected real MCP servers. Status=${JSON.stringify(status, null, 2)}`);
  const tools = ctx.api.getMcpTools();
  const names = new Set(tools.map((tool) => tool.safeName));
  const registryNames = new Set(ctx.registry.list().map((tool) => tool.name));
  for (const expected of [
    "mcp__release_fs__write_file",
    "mcp__release_fs__read_file",
    "mcp__release_fs__list_directory",
    "mcp__release_everything__get_structured_content",
    "mcp__release_everything__get_roots_list",
    "mcp__release_everything__trigger_elicitation_request",
    "mcp__release_everything__trigger_sampling_request",
  ]) {
    assert(names.has(expected), `Missing expected real MCP projected tool: ${expected}. Tools=${[...names].join(", ")}`);
  }
  for (const expected of [
    "mcp__release_everything__list_resources",
    "mcp__release_everything__list_prompts",
  ]) {
    assert(registryNames.has(expected), `Missing expected MCP utility tool in registry: ${expected}. Registry tools=${[...registryNames].join(", ")}`);
  }

  await scenarioMcpDirectProtocol(ctx, project.id);
  await scenarioMcpAgentFilesystem(ctx, project.id);
  await scenarioMcpHttpSurface();

  return {
    detail: `connected=${status.connected}; tools=${status.tools}; events=${ctx.api.getMcpEvents().length}`,
    diagnostics: {
      servers: ctx.api.getMcpServers(),
      tools: tools.length,
    },
  };
}

async function scenarioMcpDirectProtocol(ctx: ReleaseContext, projectId: string): Promise<void> {
  const session = ctx.api.createSession(`${RUN_ID} mcp direct protocol`, { projectId });
  const runtime = new ToolRuntime(ctx.registry);
  const execute = async (toolName: string, args: Record<string, unknown> = {}) => {
    const result = await runtime.execute(toolName, args, session.id, {
      source: DEVICE_SOURCE,
      signal: new AbortController().signal,
      toolUseId: `direct_${toolName}_${Date.now()}`,
    });
    assert(!result.isError, `${toolName} failed:\n${serialize(result.output)}`);
    return serialize(result.output);
  };

  const structured = await execute("mcp__release_everything__get_structured_content", { location: "New York" });
  assert(structured.includes("structuredContent") || structured.includes("New York"), `Structured MCP output was not visible: ${structured}`);

  const resources = await execute("mcp__release_everything__list_resources");
  assert(resources.includes("demo://resource/") || resources.includes("uri"), `MCP resources were not listed: ${resources}`);

  const prompts = await execute("mcp__release_everything__list_prompts");
  assert(prompts.includes("simple_prompt") || prompts.includes("prompts") || prompts.includes("arguments"), `MCP prompts were not listed: ${prompts}`);

  const roots = await execute("mcp__release_everything__get_roots_list");
  assert(roots.includes(ctx.workspaceDir) || roots.includes("file://"), `MCP roots/list did not return Forge roots: ${roots}`);

  const elicitationTool = ctx.registry.get("mcp__release_everything__trigger_elicitation_request");
  assert(elicitationTool, "Missing elicitation MCP tool");
  const elicitationPromise = elicitationTool.handler({}, session.id, { source: DEVICE_SOURCE });
  const pending = await waitForMcpElicitation(ctx.api);
  ctx.api.respondMcpElicitation(pending.id, { action: "accept", content: { answer: "release-e2e-ok" } });
  const elicitationResult = await elicitationPromise;
  assert(!isStructuredError(elicitationResult), `MCP elicitation failed: ${serialize(elicitationResult)}`);

  const beforeSamplingEvents = ctx.api.getMcpEvents().length;
  const sampling = await execute("mcp__release_everything__trigger_sampling_request", {
    prompt: "Reply with a short release gate sentence containing FORGE_MCP_SAMPLING_OK.",
  });
  assert(sampling.includes("sampling") || sampling.includes("text") || sampling.includes("model"), `MCP sampling output was not visible: ${sampling}`);
  const newMcpEvents = ctx.api.getMcpEvents(beforeSamplingEvents);
  assert(
    newMcpEvents.some((event) => event.message.includes("sampling completed")),
    `MCP sampling did not reach Forge ModelProvider. New events=${JSON.stringify(newMcpEvents, null, 2)}`,
  );
}

async function scenarioMcpAgentFilesystem(ctx: ReleaseContext, projectId: string): Promise<void> {
  const targetPath = join(ctx.workspaceDir, "mcp-agent-write.txt");
  const session = ctx.api.createSession(`${RUN_ID} mcp agent filesystem`, { projectId });
  ctx.autoResponses.set(session.id, "allow_once");
  ctx.api.appendUserMessage(
    session.id,
    [
      "This is a release gate. You must use the real MCP filesystem tools.",
      `First call mcp__release_fs__write_file with path=${JSON.stringify(targetPath)} and content='SOAK_MCP_AGENT_FILE_OK'.`,
      `Then call mcp__release_fs__read_file for the same path.`,
      "After reading it, answer with exactly the prefix SOAK_MCP_AGENT_OK and include the read content.",
      "Do not use bash or write_file for this task.",
    ].join(" "),
    { source: DEVICE_SOURCE },
  );
  await waitForSessionStatus(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  assert(events.some((event) => event.type === "tool_call" && event.toolName === "mcp__release_fs__write_file"), `Agent did not call MCP write_file. Thread=${threadTypes(events)}`);
  assert(events.some((event) => (
    event.type === "tool_call" &&
    (event.toolName === "mcp__release_fs__read_file" || event.toolName === "mcp__release_fs__read_text_file")
  )), `Agent did not call an MCP file read tool. Thread=${threadTypes(events)}`);
  assert(existsSync(targetPath), "MCP filesystem write did not create the target file");
  assert(readFileSync(targetPath, "utf-8").includes("SOAK_MCP_AGENT_FILE_OK"), "MCP filesystem file content is wrong");
  const answer = lastAssistantText(events);
  assert(answer.includes("SOAK_MCP_AGENT_OK"), `Agent did not produce MCP recovery answer: ${answer}`);
  assertToolPairs(events);
  ctx.autoResponses.delete(session.id);
}

function runGitCommand(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "true",
      SSH_ASKPASS: "true",
    },
  });
}

function prepareCodingWorkspace(ctx: ReleaseContext): { projectDir: string; targetPath: string } {
  const projectDir = join(ctx.workspaceDir, "coding-agent-workspace");
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(join(ctx.workspaceDir, "coding-agent-workspace.worktrees"), { recursive: true, force: true });
  mkdirSync(join(projectDir, "src"), { recursive: true });
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({
    name: "forgeagent-release-coding-workspace",
    private: true,
    type: "module",
    scripts: {
      typecheck: "tsc --noEmit --pretty false",
    },
    devDependencies: {
      typescript: "^5.8.0",
    },
  }, null, 2), "utf-8");
  writeFileSync(join(projectDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      types: [],
    },
    include: ["src/**/*.ts"],
  }, null, 2), "utf-8");
  const targetPath = join(projectDir, "src", "math.ts");
  writeFileSync(targetPath, [
    "export type Visit = {",
    "  user: string;",
    "  count: number;",
    "};",
    "",
    "// Contract: return the numeric sum of all visit counts.",
    "export function totalVisits(visits: Visit[]): number {",
    "  return visits.map((visit) => visit.count).join(\",\");",
    "}",
    "",
    "export function renderSummary(visits: Visit[]): string {",
    "  return `total=${totalVisits(visits)}`;",
    "}",
    "",
  ].join("\n"), "utf-8");
  writeFileSync(join(projectDir, "src", "index.ts"), [
    "import { renderSummary } from \"./math.js\";",
    "",
    "console.log(renderSummary([{ user: \"release\", count: 2 }]));",
    "",
  ].join("\n"), "utf-8");

  runGitCommand(projectDir, ["init"]);
  runGitCommand(projectDir, ["config", "user.email", "release-e2e@forgeagent.local"]);
  runGitCommand(projectDir, ["config", "user.name", "ForgeAgent Release E2E"]);
  runGitCommand(projectDir, ["add", "."]);
  runGitCommand(projectDir, ["commit", "-m", "initial failing TypeScript fixture"]);
  return { projectDir, targetPath };
}

async function scenarioAgentCodingWorkspace(ctx: ReleaseContext): Promise<{ detail: string; diagnostics: Record<string, unknown> }> {
  const { projectDir, targetPath } = prepareCodingWorkspace(ctx);
  const project = ctx.api.createProject({
    name: "Release Coding Workspace",
    path: projectDir,
    create: true,
    trustState: "trusted",
  });
  const session = ctx.api.createSession(`${RUN_ID} agent coding workspace`, { projectId: project.id });
  ctx.autoResponses.set(session.id, "allow_once");
  ctx.api.appendUserMessage(
    session.id,
    [
      "This is a ForgeAgent release gate for coding ability. Work only inside the current workspace.",
      "The TypeScript project currently fails typecheck because src/math.ts returns a string from totalVisits.",
      "The function contract is correct: totalVisits must keep returning number and must compute the numeric sum of visit counts.",
      "Use todo_write to plan, read_file to inspect src/math.ts, lsp_diagnostics to see diagnostics,",
      "edit_file, multi_edit_file, or apply_patch_file to make the smallest structured code edit, verify_workspace to run the safe typecheck,",
      "and git_diff to inspect the patch.",
      "After verify_workspace and git_diff, call agent_task with subagent_type=verify and tool_mode=read_only to independently verify that the latest diff is covered by the passing typecheck.",
      "After agent_task returns VERDICT: PASS, mark every todo completed and call workspace_review as the final readiness gate before your final answer.",
      "Do not use write_file to overwrite the whole file, and do not use bash/perl/sed/python to edit the source.",
      "When typecheck passes, answer with the prefix CODING_AGENT_OK and mention the changed file.",
    ].join(" "),
    { source: DEVICE_SOURCE },
  );
  await waitForSessionStatus(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  assertToolPairs(events);
  const thread = threadTypes(events);
  const toolCalls = events.filter((event) => event.type === "tool_call");
  const called = (toolName: string) => toolCalls.some((event) => event.toolName === toolName);
  assert(called("todo_write"), `Agent did not record a plan. Thread=${thread}`);
  assert(called("read_file"), `Agent did not inspect the source file. Thread=${thread}`);
  assert(called("lsp_diagnostics"), `Agent did not use TypeScript diagnostics. Thread=${thread}`);
  assert(called("edit_file") || called("multi_edit_file") || called("apply_patch_file"), `Agent did not use structured edit tools. Thread=${thread}`);
  assert(!called("write_file"), `Agent used write_file instead of a bounded edit tool. Thread=${thread}`);
  assert(hasTypeScriptVerificationEvidence(events), `Agent did not run TypeScript verification. Thread=${thread}`);
  assert(!events.some((event) => (
    event.type === "tool_call" &&
    event.toolName === "bash" &&
    /\b(?:sed|perl|python|node)\b/.test(String(event.args.command ?? ""))
  )), `Agent edited through a shell/runtime command instead of ForgeAgent edit tools. Thread=${thread}`);
  assert(!events.some((event) => (
    event.type === "permission_request" &&
    event.toolName === "bash" &&
    event.subject.includes("tsc")
  )), "Safe TypeScript verification unexpectedly requested user approval.");
  assert(called("git_diff"), `Agent did not review the git diff. Thread=${thread}`);
  assert(called("workspace_review"), `Agent did not run workspace_review before finalizing. Thread=${thread}`);
  assert(called("agent_task"), `Agent did not run read-only agent_task verification before finalizing. Thread=${thread}`);
  const agentTaskPass = events.find(isVerifierPassEvidence);
  assert(agentTaskPass, `agent_task verifier did not return VERDICT: PASS. Thread=${thread}`);
  const readyReview = events.find((event) => (
    event.type === "tool_result" &&
    event.toolName === "workspace_review" &&
    event.isError !== true &&
    /ready for final response/i.test(eventPayloadText(event.result))
  ));
  assert(readyReview, `workspace_review did not report readiness. Thread=${thread}`);
  assert(readyReview.seq > agentTaskPass.seq, `workspace_review readiness must happen after agent_task PASS. Thread=${thread}`);

  const fixedSource = readFileSync(targetPath, "utf-8");
  assert(fixedSource.includes("reduce") || fixedSource.includes("+ visit.count"), `TypeScript source was not repaired as a numeric total:\n${fixedSource}`);
  assert(fixedSource.includes("totalVisits(visits: Visit[]): number"), `TypeScript source changed the public return contract instead of fixing the implementation:\n${fixedSource}`);
  assert(!fixedSource.includes(".join("), `TypeScript source still returns joined string:\n${fixedSource}`);
  execFileSync("npx", ["tsc", "--noEmit", "--pretty", "false"], {
    cwd: projectDir,
    stdio: "pipe",
    timeout: 120_000,
    env: process.env,
  });

  const diagnostics = ctx.api.getDiagnostics(session.id);
  assert(diagnostics.filter((diagnostic) => diagnostic.severity === "error").length === 0, `Diagnostics still contain errors: ${JSON.stringify(diagnostics, null, 2)}`);
  const checks = ctx.api.getVerificationResults(session.id);
  assert(hasPassedTypeScriptVerification(checks), `No passed TypeScript verification recorded: ${JSON.stringify(checks, null, 2)}`);
  const diffs = ctx.api.getSessionDiffs(session.id);
  assert(diffs.some((diff) => diff.filePath === targetPath && diff.operation === "updated"), `No structured diff was recorded for ${targetPath}`);
  const activity = ctx.api.getWorkspaceActivity(session.id);
  assert(activity.changes.some((change) => change.filePath === targetPath), "Workspace activity did not include the changed source file.");
  const answer = lastAssistantText(events);
  assert(answer.includes("CODING_AGENT_OK"), `Agent did not produce coding success marker: ${answer}`);
  ctx.autoResponses.delete(session.id);
  return {
    detail: `fixed=${targetPath}; checks=${checks.length}; diffs=${diffs.length}; tools=${toolCalls.map((event) => event.toolName).join(",")}`,
    diagnostics: {
      projectDir,
      targetPath,
      activity,
    },
  };
}

async function scenarioAgentImplementationSubagent(ctx: ReleaseContext): Promise<{ detail: string; diagnostics: Record<string, unknown> }> {
  const { projectDir, targetPath } = prepareCodingWorkspace(ctx);
  const project = ctx.api.createProject({
    name: "Release Implementation Subagent Workspace",
    path: projectDir,
    create: true,
    trustState: "trusted",
  });
  const session = ctx.api.createSession(`${RUN_ID} agent implementation subagent`, { projectId: project.id });
  ctx.autoResponses.set(session.id, "allow_once");
  ctx.api.appendUserMessage(
    session.id,
    [
      "This is a ForgeAgent release gate for implementation subagent ability. Work only inside the current workspace.",
      "The TypeScript project fails because src/math.ts totalVisits returns a comma-joined string instead of the numeric sum.",
      "You must delegate the actual source edit to agent_task with subagent_type=implement and tool_mode=workspace_write.",
      "The implementation subagent task must tell it to inspect src/math.ts, use bounded edit tools only, run a safe verification if available, and inspect git_diff.",
      "After agent_task returns, the main Agent must run verify_workspace, call git_diff, and call workspace_review before the final answer.",
      "Do not use write_file, and do not use bash/perl/sed/python/node to edit source files.",
      "When done, answer with the prefix IMPLEMENT_SUBAGENT_OK and mention src/math.ts.",
    ].join(" "),
    { source: DEVICE_SOURCE },
  );
  await waitForSessionStatus(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  assertToolPairs(events);
  const thread = threadTypes(events);
  const toolCalls = events.filter((event) => event.type === "tool_call");
  const called = (toolName: string) => toolCalls.some((event) => event.toolName === toolName);
  const implementationCall = toolCalls.find((event) => (
    event.toolName === "agent_task" &&
    event.args.subagent_type === "implement" &&
    event.args.tool_mode === "workspace_write"
  ));
  assert(implementationCall, `Agent did not call implementation agent_task with workspace_write mode. Thread=${thread}`);
  const implementationResult = events.find((event) => isImplementationSubagentHandoff(event, implementationCall.seq));
  assert(implementationResult, `Implementation agent_task did not return a successful handoff summary. Thread=${thread}`);
  const implementationActivity = events.find((event) => (
    event.type === "activity_event" &&
    event.title === "Subagent implement" &&
    event.status === "completed"
  ));
  assert(implementationActivity?.type === "activity_event", `No completed Subagent implement activity was recorded. Thread=${thread}`);
  const implementationPayload = JSON.stringify(implementationActivity.payload ?? {});
  assert(
    /"toolMode":"workspace_write"/.test(implementationPayload) &&
      /"name":"(?:edit_file|multi_edit_file|apply_patch_file)"/.test(implementationPayload),
    `Implementation subagent did not prove workspace_write bounded editing. Payload=${implementationPayload}`,
  );
  assert(!events.some((event) => (
    event.type === "tool_call" &&
    event.toolName === "write_file"
  )), `Main Agent used write_file instead of delegated bounded edits. Thread=${thread}`);
  assert(!events.some((event) => (
    event.type === "tool_call" &&
    event.toolName === "bash" &&
    /\b(?:sed|perl|python|node)\b/.test(String(event.args.command ?? ""))
  )), `Agent edited through shell/runtime command instead of ForgeAgent edit tools. Thread=${thread}`);
  const afterImplementationCalls = toolCalls.filter((event) => event.seq > implementationResult.seq);
  assert(afterImplementationCalls.some((event) => event.toolName === "verify_workspace"), `Main Agent did not run verify_workspace after implementation subagent handoff. Thread=${thread}`);
  assert(afterImplementationCalls.some((event) => event.toolName === "git_diff"), `Main Agent did not run git_diff after implementation subagent handoff. Thread=${thread}`);
  assert(afterImplementationCalls.some((event) => event.toolName === "workspace_review"), `Main Agent did not run workspace_review after implementation subagent handoff. Thread=${thread}`);

  const fixedSource = readFileSync(targetPath, "utf-8");
  assert(fixedSource.includes("reduce") || fixedSource.includes("+ visit.count"), `Implementation subagent did not repair numeric total:\n${fixedSource}`);
  assert(!fixedSource.includes(".join("), `TypeScript source still returns joined string:\n${fixedSource}`);
  execFileSync("npx", ["tsc", "--noEmit", "--pretty", "false"], {
    cwd: projectDir,
    stdio: "pipe",
    timeout: 120_000,
    env: process.env,
  });
  const checks = ctx.api.getVerificationResults(session.id);
  assert(hasPassedTypeScriptVerification(checks), `No passed TypeScript verification recorded: ${JSON.stringify(checks, null, 2)}`);
  const diffs = ctx.api.getSessionDiffs(session.id);
  assert(diffs.some((diff) => diff.filePath === targetPath && diff.operation === "updated"), `No structured diff was recorded for ${targetPath}. Diffs=${JSON.stringify(diffs, null, 2)}`);
  const answer = lastAssistantText(events);
  assert(answer.includes("IMPLEMENT_SUBAGENT_OK"), `Agent did not produce implementation subagent success marker: ${answer}`);
  ctx.autoResponses.delete(session.id);
  return {
    detail: `implementationSubagent=${targetPath}; checks=${checks.length}; diffs=${diffs.length}; tools=${toolCalls.map((event) => event.toolName).join(",")}; subagentPayload=${implementationPayload}`,
    diagnostics: {
      projectDir,
      targetPath,
      activity: ctx.api.getWorkspaceActivity(session.id),
    },
  };
}

async function scenarioAgentBackgroundSubagents(ctx: ReleaseContext): Promise<{ detail: string; diagnostics: Record<string, unknown> }> {
  const { projectDir } = prepareCodingWorkspace(ctx);
  const project = ctx.api.createProject({
    name: "Release Background Subagents Workspace",
    path: projectDir,
    create: true,
    trustState: "trusted",
  });
  const session = ctx.api.createSession(`${RUN_ID} agent background subagents`, { projectId: project.id });
  ctx.api.appendUserMessage(
    session.id,
    [
      "This is a ForgeAgent release gate for background subagent pool ability. Work only inside the current workspace.",
      "Do not edit files in this task.",
      "Start exactly three background agent_task jobs with run_in_background=true and tool_mode=none:",
      "1) subagent_type=explore with task 'Identify which fixture files matter from the user request and thread facts.'",
      "2) subagent_type=plan with task 'Plan the minimum repair and validation flow for src/math.ts.'",
      "3) subagent_type=plan with task 'Plan the release evidence that would be needed before finalizing.'",
      "After each background agent_task returns a task id, call agent_task_output until each task reports status completed.",
      "Do not treat the 'started' result as completed work.",
      "When all three outputs are completed, answer with the prefix BACKGROUND_SUBAGENTS_OK and list the three task ids.",
    ].join(" "),
    { source: DEVICE_SOURCE },
  );
  await waitForSessionStatus(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  assertToolPairs(events);
  const thread = threadTypes(events);
  const toolCalls = events.filter((event) => event.type === "tool_call");
  const backgroundCalls = toolCalls.filter((event) => (
    event.toolName === "agent_task" &&
    (event.args.run_in_background === true || event.args.run_in_background === "true")
  ));
  assert(backgroundCalls.length >= 3, `Agent did not start three background subagents. Thread=${thread}`);
  assert(!toolCalls.some((event) => ["write_file", "edit_file", "multi_edit_file", "apply_patch_file"].includes(event.toolName)), `Background subagent coordination task unexpectedly edited files. Thread=${thread}`);
  const outputCalls = toolCalls.filter((event) => event.toolName === "agent_task_output");
  assert(outputCalls.length >= 3, `Agent did not join background subagents with agent_task_output. Thread=${thread}`);
  const completedOutputs = events.filter((event) => (
    event.type === "tool_result" &&
    event.toolName === "agent_task_output" &&
    event.isError !== true &&
    String(event.result).includes('"status": "completed"')
  ));
  assert(completedOutputs.length >= 3, `Agent did not observe three completed background subagent outputs. Thread=${thread}`);
  const runningActivities = events.filter((event) => (
    event.type === "activity_event" &&
    event.title.startsWith("Background subagent") &&
    event.status === "running"
  ));
  const completedActivities = events.filter((event) => (
    event.type === "activity_event" &&
    event.title.startsWith("Background subagent") &&
    event.status === "completed"
  ));
  assert(runningActivities.length >= 3, `Background subagent start activity events were not recorded. Thread=${thread}`);
  assert(completedActivities.length >= 3, `Background subagent completion activity events were not recorded. Thread=${thread}`);
  const answer = lastAssistantText(events);
  assert(answer.includes("BACKGROUND_SUBAGENTS_OK"), `Agent did not produce background subagent success marker: ${answer}`);
  const final = events.find((event) => event.type === "assistant_message" && event.text.includes("BACKGROUND_SUBAGENTS_OK"));
  assert(final && final.seq > Math.max(...completedOutputs.map((event) => event.seq)), `Agent finalized before completed background outputs. Thread=${thread}`);
  return {
    detail: `backgroundTasks=${backgroundCalls.length}; outputs=${outputCalls.length}; completed=${completedOutputs.length}; tools=${toolCalls.map((event) => event.toolName).join(",")}`,
    diagnostics: {
      projectDir,
      activity: ctx.api.getWorkspaceActivity(session.id),
    },
  };
}

async function scenarioAgentSubagentWorktreeMerge(ctx: ReleaseContext): Promise<{ detail: string; diagnostics: Record<string, unknown> }> {
  const { projectDir, targetPath } = prepareCodingWorkspace(ctx);
  const project = ctx.api.createProject({
    name: "Release Subagent Worktree Merge Workspace",
    path: projectDir,
    create: true,
    trustState: "trusted",
  });
  const session = ctx.api.createSession(`${RUN_ID} agent subagent worktree merge`, { projectId: project.id });
  ctx.autoResponses.set(session.id, "allow_once");
  ctx.api.appendUserMessage(
    session.id,
    [
      "This is a ForgeAgent release gate for isolated worktree implementation and merge ability. Work only inside the current workspace.",
      "The TypeScript project fails because src/math.ts totalVisits returns a comma-joined string instead of the numeric sum.",
      "You must first call enter_worktree with branch=forge/e2e-worktree-merge.",
      "While that worktree is active, delegate the actual src/math.ts source edit to agent_task with subagent_type=implement and tool_mode=workspace_write.",
      "The implementation subagent must use bounded workspace edit tools, not bash/runtime editing.",
      "After agent_task returns, the main Agent must run verify_workspace, git_diff, and workspace_review in the worktree.",
      "Then call commit_worktree with message='fix totalVisits in isolated worktree'.",
      "Then call merge_worktree with remove_after_merge=true so the committed worktree branch is merged back into the original project.",
      "Do not use write_file, and do not use bash/perl/sed/python/node to edit source files.",
      "When the merge is complete and the original project contains the fix, answer with the prefix WORKTREE_MERGE_OK and mention src/math.ts.",
    ].join(" "),
    { source: DEVICE_SOURCE },
  );
  await waitForSessionStatus(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  assertToolPairs(events);
  const thread = threadTypes(events);
  const toolCalls = events.filter((event) => event.type === "tool_call");
  const called = (toolName: string) => toolCalls.some((event) => event.toolName === toolName);
  const enterCall = toolCalls.find((event) => event.toolName === "enter_worktree");
  const implementationCall = toolCalls.find((event) => (
    event.toolName === "agent_task" &&
    event.args.subagent_type === "implement" &&
    event.args.tool_mode === "workspace_write"
  ));
  const implementationResult = implementationCall
    ? events.find((event) => (
      event.type === "tool_result" &&
      event.toolName === "agent_task" &&
      event.seq > implementationCall.seq &&
      event.isError !== true &&
      String(event.result).includes("SUMMARY")
    ))
    : undefined;
  const commitCall = toolCalls.find((event) => event.toolName === "commit_worktree");
  const mergeCall = toolCalls.find((event) => event.toolName === "merge_worktree");
  assert(enterCall, `Agent did not enter an isolated worktree. Thread=${thread}`);
  assert(implementationCall, `Agent did not delegate worktree implementation to agent_task implement/workspace_write. Thread=${thread}`);
  assert(implementationCall.seq > enterCall.seq, `Implementation subagent ran before entering worktree. Thread=${thread}`);
  assert(implementationResult, `Implementation subagent did not return a successful handoff summary. Thread=${thread}`);
  assert(called("verify_workspace"), `Main Agent did not run verify_workspace in the worktree. Thread=${thread}`);
  assert(called("git_diff"), `Main Agent did not run git_diff in the worktree. Thread=${thread}`);
  assert(called("workspace_review"), `Main Agent did not run workspace_review in the worktree. Thread=${thread}`);
  assert(commitCall, `Agent did not call commit_worktree before merge. Thread=${thread}`);
  assert(mergeCall, `Agent did not call merge_worktree after worktree commit. Thread=${thread}`);
  assert(commitCall.seq > implementationResult.seq, `commit_worktree must happen after implementation handoff. Thread=${thread}`);
  assert(mergeCall.seq > commitCall.seq, `merge_worktree must happen after commit_worktree. Thread=${thread}`);
  assert(!called("write_file"), `Agent used write_file instead of bounded edits. Thread=${thread}`);
  assert(!events.some((event) => (
    event.type === "tool_call" &&
    event.toolName === "bash" &&
    /\b(?:sed|perl|python|node)\b/.test(String(event.args.command ?? ""))
  )), `Agent edited through shell/runtime command instead of ForgeAgent edit tools. Thread=${thread}`);

  const worktreeEvents = events.filter((event) => event.type === "worktree_event");
  const entered = worktreeEvents.find((event) => event.action === "entered");
  const committed = worktreeEvents.find((event) => event.action === "committed");
  const merged = worktreeEvents.find((event) => event.action === "merged");
  assert(entered?.type === "worktree_event" && entered.path, `No entered worktree event was recorded. Events=${JSON.stringify(worktreeEvents, null, 2)}`);
  assert(committed?.type === "worktree_event", `No committed worktree event was recorded. Events=${JSON.stringify(worktreeEvents, null, 2)}`);
  assert(merged?.type === "worktree_event", `No merged worktree event was recorded. Events=${JSON.stringify(worktreeEvents, null, 2)}`);
  assert(!existsSync(entered.path), `Worktree should have been removed after merge: ${entered.path}`);
  const implementationActivity = events.find((event) => (
    event.type === "activity_event" &&
    event.title === "Subagent implement" &&
    event.status === "completed"
  ));
  assert(implementationActivity?.type === "activity_event", `No completed Subagent implement activity was recorded. Thread=${thread}`);
  const implementationPayload = JSON.stringify(implementationActivity.payload ?? {});
  assert(
    /"toolMode":"workspace_write"/.test(implementationPayload) &&
      /"name":"(?:edit_file|multi_edit_file|apply_patch_file)"/.test(implementationPayload),
    `Implementation subagent did not prove workspace_write bounded editing. Payload=${implementationPayload}`,
  );

  const fixedSource = readFileSync(targetPath, "utf-8");
  assert(fixedSource.includes("reduce") || fixedSource.includes("+ visit.count"), `Merged project source was not repaired as a numeric total:\n${fixedSource}`);
  assert(!fixedSource.includes(".join("), `Merged project source still returns joined string:\n${fixedSource}`);
  execFileSync("npx", ["tsc", "--noEmit", "--pretty", "false"], {
    cwd: projectDir,
    stdio: "pipe",
    timeout: 120_000,
    env: process.env,
  });
  const gitLog = execFileSync("git", ["log", "--oneline", "--all", "--grep", "fix totalVisits in isolated worktree"], {
    cwd: projectDir,
    encoding: "utf-8",
    env: process.env,
  });
  assert(gitLog.trim().length > 0, `Merged history does not include the worktree commit. git log=${gitLog}`);
  const checks = ctx.api.getVerificationResults(session.id);
  assert(hasPassedTypeScriptVerification(checks), `No passed TypeScript verification recorded: ${JSON.stringify(checks, null, 2)}`);
  const diffs = ctx.api.getSessionDiffs(session.id);
  assert(diffs.some((diff) => diff.filePath.endsWith("/src/math.ts") && diff.operation === "updated"), `No structured diff was recorded for src/math.ts. Diffs=${JSON.stringify(diffs, null, 2)}`);
  const answer = lastAssistantText(events);
  assert(answer.includes("WORKTREE_MERGE_OK"), `Agent did not produce worktree merge success marker: ${answer}`);
  ctx.autoResponses.delete(session.id);
  return {
    detail: `worktree=${entered.path}; committed=${committed.message.split("\n").find((line) => line.startsWith("Commit:")) ?? "commit recorded"}; merged=${targetPath}; checks=${checks.length}; tools=${toolCalls.map((event) => event.toolName).join(",")}`,
    diagnostics: {
      projectDir,
      targetPath,
      worktreePath: entered.path,
      activity: ctx.api.getWorkspaceActivity(session.id),
    },
  };
}

function preparePythonCodeIndexWorkspace(ctx: ReleaseContext): {
  projectDir: string;
  targetPath: string;
  testPath: string;
} {
  const projectDir = join(ctx.workspaceDir, "coding-agent-python-code-index");
  rmSync(projectDir, { recursive: true, force: true });
  mkdirSync(join(projectDir, "src"), { recursive: true });
  mkdirSync(join(projectDir, "tests"), { recursive: true });
  writeFileSync(join(projectDir, "src", "__init__.py"), "", "utf-8");
  const targetPath = join(projectDir, "src", "pricing.py");
  const testPath = join(projectDir, "tests", "test_pricing.py");
  writeFileSync(targetPath, [
    "class PriceCalculator:",
    "    def subtotal(self, items):",
    "        # Contract: return the numeric sum of item prices.",
    "        return \",\".join(str(item[\"price\"]) for item in items)",
    "",
    "",
    "def format_invoice(items):",
    "    calculator = PriceCalculator()",
    "    return f\"subtotal={calculator.subtotal(items)}\"",
    "",
  ].join("\n"), "utf-8");
  writeFileSync(testPath, [
    "import unittest",
    "",
    "from src.pricing import PriceCalculator, format_invoice",
    "",
    "",
    "class PricingTest(unittest.TestCase):",
    "    def test_subtotal_is_numeric_sum(self):",
    "        items = [{\"price\": 2.5}, {\"price\": 10.0}]",
    "        self.assertEqual(PriceCalculator().subtotal(items), 12.5)",
    "",
    "    def test_invoice_uses_numeric_subtotal(self):",
    "        items = [{\"price\": 2.5}, {\"price\": 10.0}]",
    "        self.assertEqual(format_invoice(items), \"subtotal=12.5\")",
    "",
    "",
    "if __name__ == \"__main__\":",
    "    unittest.main()",
    "",
  ].join("\n"), "utf-8");
  writeFileSync(join(projectDir, "Makefile"), [
    "test:",
    "\tpython3 -m unittest discover -s tests",
    "",
  ].join("\n"), "utf-8");

  runGitCommand(projectDir, ["init"]);
  runGitCommand(projectDir, ["config", "user.email", "release-e2e@forgeagent.local"]);
  runGitCommand(projectDir, ["config", "user.name", "ForgeAgent Release E2E"]);
  runGitCommand(projectDir, ["add", "."]);
  runGitCommand(projectDir, ["commit", "-m", "initial failing Python fixture"]);
  return { projectDir, targetPath, testPath };
}

async function scenarioAgentPythonCodeIndex(ctx: ReleaseContext): Promise<{ detail: string; diagnostics: Record<string, unknown> }> {
  const { projectDir, targetPath, testPath } = preparePythonCodeIndexWorkspace(ctx);
  const project = ctx.api.createProject({
    name: "Release Python Code Index Workspace",
    path: projectDir,
    create: true,
    trustState: "trusted",
  });
  const session = ctx.api.createSession(`${RUN_ID} agent python code index`, { projectId: project.id });
  ctx.autoResponses.set(session.id, "allow_once");
  ctx.api.appendUserMessage(
    session.id,
    [
      "This is a ForgeAgent release gate for non-TypeScript coding navigation. Work only inside the current workspace.",
      `The current workspace root is ${JSON.stringify(projectDir)}. Do not use any other absolute path or previous-project path.`,
      "The Python tests fail because src/pricing.py PriceCalculator.subtotal returns a comma-joined string instead of the numeric sum.",
      "You must call lsp_query to navigate this Python workspace, using Python language-server symbols when available and the generic multi-language code index only as fallback.",
      "Use read_file to inspect the relevant Python source and test files, then edit_file, multi_edit_file, or apply_patch_file for a bounded edit.",
      "Do not use write_file to overwrite files, and do not use bash/perl/sed/python/node to edit source files.",
      "Run verify_workspace to execute the safe workspace test command, then call git_diff before your final answer.",
      "When tests pass, answer with the prefix PYTHON_CODE_INDEX_OK and mention src/pricing.py.",
    ].join(" "),
    { source: DEVICE_SOURCE },
  );
  await waitForSessionStatus(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  assertToolPairs(events);
  const thread = threadTypes(events);
  const toolCalls = events.filter((event) => event.type === "tool_call");
  const called = (toolName: string) => toolCalls.some((event) => event.toolName === toolName);
  assert(called("lsp_query"), `Agent did not use lsp_query Python navigation. Thread=${thread}`);
  assert(hasPythonNavigationEvidence(events), `lsp_query did not expose Python navigation evidence. Thread=${thread}`);
  assert(called("read_file"), `Agent did not inspect Python files. Thread=${thread}`);
  assert(called("edit_file") || called("multi_edit_file") || called("apply_patch_file"), `Agent did not use bounded edit tools. Thread=${thread}`);
  assert(!called("write_file"), `Agent used write_file instead of bounded edits. Thread=${thread}`);
  assert(!events.some((event) => (
    event.type === "tool_call" &&
    event.toolName === "bash" &&
    /\b(?:sed|perl|python|python3|node)\b/.test(String(event.args.command ?? "")) &&
    !/\bpython3?\s+-m\s+unittest\b/.test(String(event.args.command ?? ""))
  )), `Agent edited through shell/runtime command instead of ForgeAgent edit tools. Thread=${thread}`);
  assert(called("verify_workspace"), `Agent did not run verify_workspace. Thread=${thread}`);
  assert(called("git_diff"), `Agent did not review git diff. Thread=${thread}`);

  const source = readFileSync(targetPath, "utf-8");
  assert(!source.includes(".join("), `Python source still returns joined string:\n${source}`);
  assert(/sum\s*\(/.test(source) || /\+=/.test(source), `Python source does not compute a numeric sum:\n${source}`);
  execFileSync("python3", ["-m", "unittest", "discover", "-s", "tests"], {
    cwd: projectDir,
    stdio: "pipe",
    timeout: 120_000,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
    },
  });

  const checks = ctx.api.getVerificationResults(session.id);
  assert(hasPassedWorkspaceTest(checks), `No passed Python workspace test recorded: ${JSON.stringify(checks, null, 2)}`);
  const diffs = ctx.api.getSessionDiffs(session.id);
  assert(diffs.some((diff) => diff.filePath === targetPath), `No structured diff was recorded for ${targetPath}. Diffs=${JSON.stringify(diffs, null, 2)}`);
  const answer = lastAssistantText(events);
  assert(answer.includes("PYTHON_CODE_INDEX_OK"), `Agent did not produce Python code index success marker: ${answer}`);
  ctx.autoResponses.delete(session.id);
  return {
    detail: `pythonFile=${targetPath}; test=${testPath}; checks=${checks.length}; diffs=${diffs.length}; tools=${toolCalls.map((event) => event.toolName).join(",")}`,
    diagnostics: {
      projectDir,
      changedFiles: [targetPath],
      activity: ctx.api.getWorkspaceActivity(session.id),
    },
  };
}

async function scenarioAgentPersistentMultilanguageLsp(ctx: ReleaseContext): Promise<{ detail: string; diagnostics: Record<string, unknown> }> {
  const { projectDir, targetPath } = preparePythonCodeIndexWorkspace(ctx);
  writeFileSync(targetPath, [
    "from collections.abc import Mapping, Sequence",
    "",
    "",
    "Item = Mapping[str, float]",
    "",
    "",
    "class PriceCalculator:",
    "    def subtotal(self, items: Sequence[Item]) -> float:",
    "        # Contract: return the numeric sum of item prices.",
    "        return \",\".join(str(item[\"price\"]) for item in items)",
    "",
    "",
    "def format_invoice(items: Sequence[Item]) -> str:",
    "    calculator = PriceCalculator()",
    "    return f\"subtotal={calculator.subtotal(items)}\"",
    "",
  ].join("\n"), "utf-8");
  runGitCommand(projectDir, ["add", "."]);
  runGitCommand(projectDir, ["commit", "-m", "add typed Python diagnostic fixture"]);
  const project = ctx.api.createProject({
    name: "Release Persistent Multilanguage LSP Workspace",
    path: projectDir,
    create: true,
    trustState: "trusted",
  });
  const session = ctx.api.createSession(`${RUN_ID} agent persistent multilanguage lsp`, { projectId: project.id });
  ctx.autoResponses.set(session.id, "allow_once");
  ctx.api.appendUserMessage(
    session.id,
    [
      "This is a ForgeAgent release gate for persistent multi-language semantic LSP. Work only inside the current workspace.",
      `The current workspace root is ${JSON.stringify(projectDir)}.`,
      "You must first call lsp_diagnostics for this typed Python project and use the Pyright diagnostic evidence.",
      "Then call lsp_query for PriceCalculator or subtotal and use the semantic Python symbols, not only generic lexical fallback.",
      "Fix src/pricing.py with a bounded edit so subtotal returns the numeric sum, run verify_workspace, call git_diff, then answer with PYRIGHT_LSP_OK.",
      "Do not use write_file, and do not use bash/perl/sed/python/node to edit source files.",
    ].join(" "),
    { source: DEVICE_SOURCE },
  );
  await waitForSessionStatus(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  assertToolPairs(events);
  const thread = threadTypes(events);
  const toolCalls = events.filter((event) => event.type === "tool_call");
  const called = (toolName: string) => toolCalls.some((event) => event.toolName === toolName);
  assert(called("lsp_diagnostics"), `Agent did not call lsp_diagnostics for Python/Pyright. Thread=${thread}`);
  assert(called("lsp_query"), `Agent did not call lsp_query for Python symbols. Thread=${thread}`);
  assert(events.some((event) => (
    event.type === "diagnostic_event" &&
    event.source === "pyright" &&
    event.diagnostics.some((diagnostic) => /str|float|return/i.test(`${diagnostic.code ?? ""} ${diagnostic.message}`))
  )), `Pyright diagnostic evidence was not recorded. Thread=${thread}`);
  assert(events.some((event) => (
    event.type === "tool_result" &&
    event.toolName === "lsp_query" &&
    event.isError !== true &&
    /PriceCalculator|subtotal/i.test(String(event.result)) &&
    !/Generic code index/i.test(String(event.result))
  )), `Python lsp_query did not return semantic symbols. Thread=${thread}`);
  assert(called("edit_file") || called("multi_edit_file") || called("apply_patch_file"), `Agent did not use bounded edit tools. Thread=${thread}`);
  assert(!called("write_file"), `Agent used write_file instead of bounded edits. Thread=${thread}`);
  assert(called("verify_workspace"), `Agent did not run verification. Thread=${thread}`);
  assert(called("git_diff"), `Agent did not inspect diff. Thread=${thread}`);
  execFileSync("python3", ["-m", "unittest", "discover", "-s", "tests"], {
    cwd: projectDir,
    stdio: "pipe",
    timeout: 120_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  const answer = lastAssistantText(events);
  assert(answer.includes("PYRIGHT_LSP_OK"), `Agent did not produce Pyright LSP success marker: ${answer}`);
  ctx.autoResponses.delete(session.id);
  return {
    detail: `pyright=true; tools=${toolCalls.map((event) => event.toolName).join(",")}; target=${targetPath}`,
    diagnostics: {
      projectDir,
      changedFiles: [targetPath],
      activity: ctx.api.getWorkspaceActivity(session.id),
    },
  };
}

function prepareRubyLspUnavailableWorkspace(ctx: ReleaseContext): { projectDir: string; targetPath: string } {
  const projectDir = join(ctx.workspaceDir, "coding-agent-lsp-unavailable-ruby");
  rmSync(projectDir, { recursive: true, force: true });
  mkdirSync(join(projectDir, "src"), { recursive: true });
  mkdirSync(join(projectDir, "tests"), { recursive: true });
  const targetPath = join(projectDir, "src", "pricing.rb");
  writeFileSync(targetPath, [
    "class PriceCalculator",
    "  def subtotal(items)",
    "    # Contract: return the numeric sum of item prices.",
    "    items.map { |item| item[:price] }.join(',')",
    "  end",
    "end",
    "",
    "def format_invoice(items)",
    "  calculator = PriceCalculator.new",
    "  \"subtotal=#{calculator.subtotal(items)}\"",
    "end",
    "",
  ].join("\n"), "utf-8");
  writeFileSync(join(projectDir, "tests", "test_pricing.rb"), [
    "require 'minitest/autorun'",
    "require_relative '../src/pricing'",
    "",
    "class PricingTest < Minitest::Test",
    "  def test_subtotal_is_numeric_sum",
    "    assert_equal 12.5, PriceCalculator.new.subtotal([{ price: 2.5 }, { price: 10.0 }])",
    "  end",
    "",
    "  def test_invoice_uses_numeric_subtotal",
    "    assert_equal 'subtotal=12.5', format_invoice([{ price: 2.5 }, { price: 10.0 }])",
    "  end",
    "end",
    "",
  ].join("\n"), "utf-8");
  writeFileSync(join(projectDir, "Makefile"), [
    "test:",
    "\truby tests/test_pricing.rb",
    "",
  ].join("\n"), "utf-8");
  runGitCommand(projectDir, ["init"]);
  runGitCommand(projectDir, ["config", "user.email", "release-e2e@forgeagent.local"]);
  runGitCommand(projectDir, ["config", "user.name", "ForgeAgent Release E2E"]);
  runGitCommand(projectDir, ["add", "."]);
  runGitCommand(projectDir, ["commit", "-m", "initial Ruby LSP-unavailable fixture"]);
  return { projectDir, targetPath };
}

async function scenarioAgentLspUnavailableRecovery(ctx: ReleaseContext): Promise<{ detail: string; diagnostics: Record<string, unknown> }> {
  const { projectDir, targetPath } = prepareRubyLspUnavailableWorkspace(ctx);
  const project = ctx.api.createProject({
    name: "Release LSP Unavailable Recovery Workspace",
    path: projectDir,
    create: true,
    trustState: "trusted",
  });
  const session = ctx.api.createSession(`${RUN_ID} agent lsp unavailable recovery`, { projectId: project.id });
  ctx.autoResponses.set(session.id, "allow_once");
  ctx.api.appendUserMessage(
    session.id,
    [
      "This is a ForgeAgent release gate for LSP-unavailable recovery. Work only inside the current workspace.",
      `The current workspace root is ${JSON.stringify(projectDir)}.`,
      "First call lsp_diagnostics for this Ruby workspace. Ruby semantic LSP is not configured here; read the tool output and recover instead of blocking.",
      "Then use lsp_query or code_map for generic lexical navigation, read src/pricing.rb and the test, fix PriceCalculator.subtotal with a bounded edit, run verify_workspace, and call git_diff.",
      "Do not use write_file, and do not use bash/perl/sed/python/node to edit source files.",
      "When tests pass, answer with the prefix LSP_UNAVAILABLE_RECOVERY_OK and mention the fallback you used.",
    ].join(" "),
    { source: DEVICE_SOURCE },
  );
  await waitForSessionStatus(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  assertToolPairs(events);
  const thread = threadTypes(events);
  const toolCalls = events.filter((event) => event.type === "tool_call");
  const called = (toolName: string) => toolCalls.some((event) => event.toolName === toolName);
  assert(called("lsp_diagnostics"), `Agent did not call lsp_diagnostics before fallback. Thread=${thread}`);
  assert(events.some((event) => (
    (event.type === "tool_result" && event.toolName === "lsp_diagnostics" && /diagnostics are unavailable|semantic diagnostics unavailable|not available|does not contain/i.test(String(event.result))) ||
    (event.type === "diagnostic_event" && /diagnostics are unavailable|semantic diagnostics unavailable|not available|does not contain/i.test(event.message))
  )), `LSP unavailable path did not produce readable diagnostic evidence. Thread=${thread}`);
  assert(called("lsp_query") || called("code_map"), `Agent did not recover with generic navigation. Thread=${thread}`);
  assert(called("edit_file") || called("multi_edit_file") || called("apply_patch_file"), `Agent did not use bounded edit after LSP fallback. Thread=${thread}`);
  assert(called("verify_workspace"), `Agent did not verify after LSP fallback. Thread=${thread}`);
  assert(called("git_diff"), `Agent did not inspect diff after LSP fallback. Thread=${thread}`);
  const fixedSource = readFileSync(targetPath, "utf-8");
  assert(/sum|reduce|\+/.test(fixedSource) && !fixedSource.includes(".join("), `Ruby source was not repaired after LSP fallback:\n${fixedSource}`);
  execFileSync("make", ["test"], {
    cwd: projectDir,
    stdio: "pipe",
    timeout: 120_000,
    env: process.env,
  });
  const checks = ctx.api.getVerificationResults(session.id);
  assert(hasPassedWorkspaceTest(checks), `No passed verification recorded after LSP fallback: ${JSON.stringify(checks, null, 2)}`);
  const answer = lastAssistantText(events);
  assert(answer.includes("LSP_UNAVAILABLE_RECOVERY_OK"), `Agent did not produce LSP recovery marker: ${answer}`);
  ctx.autoResponses.delete(session.id);
  return {
    detail: `lspFallback=true; checks=${checks.length}; target=${targetPath}; tools=${toolCalls.map((event) => event.toolName).join(",")}`,
    diagnostics: {
      projectDir,
      targetPath,
      activity: ctx.api.getWorkspaceActivity(session.id),
    },
  };
}

async function scenarioAgentNotebookEdit(ctx: ReleaseContext): Promise<{ detail: string; diagnostics: Record<string, unknown> }> {
  const projectDir = join(ctx.workspaceDir, "coding-agent-notebook-edit");
  rmSync(projectDir, { recursive: true, force: true });
  mkdirSync(projectDir, { recursive: true });
  const notebookPath = join(projectDir, "analysis.ipynb");
  const notebook = {
    cells: [
      {
        cell_type: "markdown",
        metadata: {},
        source: ["# Notebook release gate\n", "Keep this notebook structurally valid.\n"],
      },
      {
        cell_type: "code",
        execution_count: 1,
        metadata: {},
        outputs: [{ output_type: "stream", name: "stdout", text: ["3\n"] }],
        source: ["value = 1 + 2\n", "print(value)\n"],
      },
    ],
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python", version: "3.11" },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
  writeFileSync(notebookPath, `${JSON.stringify(notebook, null, 2)}\n`, "utf-8");
  writeFileSync(join(projectDir, "verify_notebook.py"), [
    "import json",
    "",
    "with open('analysis.ipynb', encoding='utf-8') as f:",
    "    nb = json.load(f)",
    "",
    "assert nb['nbformat'] == 4",
    "assert len(nb['cells']) == 2",
    "cell = nb['cells'][1]",
    "source = ''.join(cell['source'])",
    "assert cell['cell_type'] == 'code'",
    "assert 'value = 42' in source",
    "assert cell.get('outputs') == []",
    "assert cell.get('execution_count') is None",
    "print('NOTEBOOK_JSON_VALID')",
    "",
  ].join("\n"), "utf-8");
  writeFileSync(join(projectDir, "Makefile"), [
    "test:",
    "\tpython3 verify_notebook.py",
    "",
  ].join("\n"), "utf-8");
  runGitCommand(projectDir, ["init"]);
  runGitCommand(projectDir, ["config", "user.email", "release-e2e@forgeagent.local"]);
  runGitCommand(projectDir, ["config", "user.name", "ForgeAgent Release E2E"]);
  runGitCommand(projectDir, ["add", "."]);
  runGitCommand(projectDir, ["commit", "-m", "initial notebook fixture"]);
  const project = ctx.api.createProject({
    name: "Release Notebook Edit Workspace",
    path: projectDir,
    create: true,
    trustState: "trusted",
  });
  const session = ctx.api.createSession(`${RUN_ID} agent notebook edit`, { projectId: project.id });
  ctx.autoResponses.set(session.id, "allow_once");
  ctx.api.appendUserMessage(
    session.id,
    [
      "This is a ForgeAgent release gate for notebook editing. Work only inside the current workspace.",
      "Read analysis.ipynb with read_file, then use notebook_edit to replace code cell index 1 with exactly value = 42 and print(value).",
      "Do not use edit_file, write_file, bash/perl/sed/python/node to modify the notebook JSON.",
      "Run verify_workspace, call git_diff, then answer with NOTEBOOK_EDIT_OK.",
    ].join(" "),
    { source: DEVICE_SOURCE },
  );
  await waitForSessionStatus(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  assertToolPairs(events);
  const thread = threadTypes(events);
  const toolCalls = events.filter((event) => event.type === "tool_call");
  const called = (toolName: string) => toolCalls.some((event) => event.toolName === toolName);
  assert(called("read_file"), `Agent did not inspect notebook summary. Thread=${thread}`);
  assert(called("notebook_edit"), `Agent did not use notebook_edit. Thread=${thread}`);
  assert(!called("write_file") && !called("edit_file"), `Agent used raw file editing for notebook. Thread=${thread}`);
  assert(called("verify_workspace"), `Agent did not verify notebook. Thread=${thread}`);
  assert(called("git_diff"), `Agent did not inspect notebook diff. Thread=${thread}`);
  execFileSync("python3", ["verify_notebook.py"], {
    cwd: projectDir,
    stdio: "pipe",
    timeout: 120_000,
    env: process.env,
  });
  const parsed = JSON.parse(readFileSync(notebookPath, "utf-8")) as { cells: Array<{ source?: string[] | string; outputs?: unknown[]; execution_count?: unknown }> };
  const codeCell = parsed.cells[1]!;
  assert(Array.isArray(codeCell.source) ? codeCell.source.join("").includes("value = 42") : String(codeCell.source).includes("value = 42"), "Notebook source was not updated.");
  assert(Array.isArray(codeCell.outputs) && codeCell.outputs.length === 0, "Notebook code outputs were not cleared.");
  assert(codeCell.execution_count === null, "Notebook execution_count was not reset.");
  const checks = ctx.api.getVerificationResults(session.id);
  assert(hasPassedWorkspaceTest(checks), `No passed notebook verification recorded: ${JSON.stringify(checks, null, 2)}`);
  const diffs = ctx.api.getSessionDiffs(session.id);
  assert(diffs.some((diff) => diff.filePath === notebookPath), `No structured notebook diff was recorded. Diffs=${JSON.stringify(diffs, null, 2)}`);
  const answer = lastAssistantText(events);
  assert(answer.includes("NOTEBOOK_EDIT_OK"), `Agent did not produce notebook success marker: ${answer}`);
  ctx.autoResponses.delete(session.id);
  return {
    detail: `notebook_edit=true; checks=${checks.length}; diffs=${diffs.length}; tools=${toolCalls.map((event) => event.toolName).join(",")}`,
    diagnostics: {
      projectDir,
      changedFiles: [notebookPath],
      activity: ctx.api.getWorkspaceActivity(session.id),
    },
  };
}

async function scenarioAgentArtifactContinuation(ctx: ReleaseContext): Promise<{ detail: string; diagnostics: Record<string, unknown>; artifacts: string[] }> {
  const projectDir = join(ctx.workspaceDir, "coding-agent-artifact-continuation");
  rmSync(projectDir, { recursive: true, force: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "README.md"), "artifact continuation fixture\n", "utf-8");
  runGitCommand(projectDir, ["init"]);
  runGitCommand(projectDir, ["config", "user.email", "release-e2e@forgeagent.local"]);
  runGitCommand(projectDir, ["config", "user.name", "ForgeAgent Release E2E"]);
  runGitCommand(projectDir, ["add", "."]);
  runGitCommand(projectDir, ["commit", "-m", "initial artifact continuation fixture"]);
  const project = ctx.api.createProject({
    name: "Release Artifact Continuation Workspace",
    path: projectDir,
    create: true,
    trustState: "trusted",
  });
  const session = ctx.api.createSession(`${RUN_ID} agent artifact continuation`, { projectId: project.id });
  ctx.autoResponses.set(session.id, "allow_once");
  ctx.api.appendUserMessage(
    session.id,
    [
      "This is a ForgeAgent release gate for large tool output artifact continuation. Work only inside the current workspace.",
      "Call bash exactly once with this command: python3 -c \"print('ARTIFACT_CONTINUATION_NEEDLE_' * 3000)\"",
      "The output is intentionally large and should be persisted as an artifact instead of fully inlining in the thread.",
      "After the artifact pointer appears, call read_artifact to read a slice of the artifact and confirm the marker.",
      "Then answer with the prefix ARTIFACT_CONTINUATION_OK and mention read_artifact.",
    ].join(" "),
    { source: DEVICE_SOURCE },
  );
  await waitForSessionStatus(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  assertToolPairs(events);
  const thread = threadTypes(events);
  const toolCalls = events.filter((event) => event.type === "tool_call");
  const artifactPointers = events.filter((event) => event.type === "artifact_pointer");
  assert(toolCalls.some((event) => event.toolName === "bash"), `Agent did not run the large-output bash command. Thread=${thread}`);
  assert(artifactPointers.length > 0, `Large tool output did not produce an artifact_pointer. Thread=${thread}`);
  assert(toolCalls.some((event) => event.toolName === "read_artifact"), `Agent did not continue by reading the artifact. Thread=${thread}`);
  assert(events.some((event) => (
    event.type === "tool_result" &&
    event.toolName === "read_artifact" &&
    String(event.result).includes("ARTIFACT_CONTINUATION_NEEDLE_")
  )), `read_artifact did not return the expected marker. Thread=${thread}`);
  const answer = lastAssistantText(events);
  assert(answer.includes("ARTIFACT_CONTINUATION_OK"), `Agent did not produce artifact continuation marker: ${answer}`);
  ctx.autoResponses.delete(session.id);
  return {
    detail: `artifacts=${artifactPointers.length}; tools=${toolCalls.map((event) => event.toolName).join(",")}; marker=ARTIFACT_CONTINUATION_NEEDLE_`,
    diagnostics: {
      projectDir,
      artifactPointers,
      activity: ctx.api.getWorkspaceActivity(session.id),
    },
    artifacts: artifactPointers.map((event) => event.artifactId),
  };
}

function prepareMultiFileRefactorWorkspace(ctx: ReleaseContext): {
  projectDir: string;
  definitionPath: string;
  renderPath: string;
  auditPath: string;
} {
  const projectDir = join(ctx.workspaceDir, "coding-agent-multifile-refactor");
  rmSync(projectDir, { recursive: true, force: true });
  mkdirSync(join(projectDir, "src"), { recursive: true });
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({
    name: "forgeagent-release-multifile-refactor",
    private: true,
    type: "module",
    scripts: {
      typecheck: "tsc --noEmit --pretty false",
    },
    devDependencies: {
      typescript: "^5.8.0",
    },
  }, null, 2), "utf-8");
  writeFileSync(join(projectDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      types: [],
    },
    include: ["src/**/*.ts"],
  }, null, 2), "utf-8");
  const definitionPath = join(projectDir, "src", "labels.ts");
  const renderPath = join(projectDir, "src", "render.ts");
  const auditPath = join(projectDir, "src", "audit.ts");
  writeFileSync(definitionPath, [
    "export type User = {",
    "  id: string;",
    "  firstName: string;",
    "  lastName: string;",
    "  active: boolean;",
    "};",
    "",
    "export function formatUserLabel(user: User): string {",
    "  return `${user.firstName} ${user.lastName}`.trim();",
    "}",
    "",
  ].join("\n"), "utf-8");
  writeFileSync(renderPath, [
    "import { formatUserLabel, type User } from \"./labels.js\";",
    "",
    "export function renderUserCard(user: User): string {",
    "  const label = formatUserLabel(user);",
    "  return `${label} (${user.id})`;",
    "}",
    "",
  ].join("\n"), "utf-8");
  writeFileSync(auditPath, [
    "import { formatUserLabel, type User } from \"./labels.js\";",
    "",
    "export function auditUserLabel(user: User): string {",
    "  return `audit:${formatUserLabel(user)}`;",
    "}",
    "",
  ].join("\n"), "utf-8");
  writeFileSync(join(projectDir, "src", "index.ts"), [
    "import { auditUserLabel } from \"./audit.js\";",
    "import { renderUserCard } from \"./render.js\";",
    "",
    "const user = { id: \"u_1\", firstName: \"Ada\", lastName: \"Lovelace\", active: true };",
    "console.log(renderUserCard(user));",
    "console.log(auditUserLabel(user));",
    "",
  ].join("\n"), "utf-8");

  runGitCommand(projectDir, ["init"]);
  runGitCommand(projectDir, ["config", "user.email", "release-e2e@forgeagent.local"]);
  runGitCommand(projectDir, ["config", "user.name", "ForgeAgent Release E2E"]);
  runGitCommand(projectDir, ["add", "."]);
  runGitCommand(projectDir, ["commit", "-m", "initial multi-file refactor fixture"]);
  return { projectDir, definitionPath, renderPath, auditPath };
}

async function scenarioAgentMultiFileRefactor(ctx: ReleaseContext): Promise<{ detail: string; diagnostics: Record<string, unknown> }> {
  const { projectDir, definitionPath, renderPath, auditPath } = prepareMultiFileRefactorWorkspace(ctx);
  const project = ctx.api.createProject({
    name: "Release Multi-file Refactor Workspace",
    path: projectDir,
    create: true,
    trustState: "trusted",
  });
  const session = ctx.api.createSession(`${RUN_ID} agent multi-file refactor`, { projectId: project.id });
  ctx.autoResponses.set(session.id, "allow_once");
  ctx.api.appendUserMessage(
    session.id,
    [
      "This is a ForgeAgent release gate for multi-file coding refactor ability. Work only inside the current workspace.",
      "Rename the exported TypeScript symbol formatUserLabel to formatDisplayName across the project.",
      "You must call lsp_query with query=references and symbol=formatUserLabel before editing.",
      "Use read_file on the referenced source files, then edit_file, multi_edit_file, or apply_patch_file for bounded edits.",
      "Do not use write_file to overwrite files, and do not use bash/perl/sed/python/node to edit source files.",
      "Run verify_workspace to verify, then call git_diff before your final answer. Use bash for verification only if verify_workspace reports that no safe check can be detected.",
      "When the refactor is complete, answer with the prefix CODING_REFACTOR_OK and mention every changed file.",
    ].join(" "),
    { source: DEVICE_SOURCE },
  );
  await waitForSessionStatus(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  assertToolPairs(events);
  const thread = threadTypes(events);
  const toolCalls = events.filter((event) => event.type === "tool_call");
  const called = (toolName: string) => toolCalls.some((event) => event.toolName === toolName);
  assert(events.some((event) => (
    event.type === "tool_call" &&
    event.toolName === "lsp_query" &&
    event.args.query === "references" &&
    event.args.symbol === "formatUserLabel"
  )), `Agent did not use LSP references before refactor. Thread=${thread}`);
  assert(called("read_file"), `Agent did not read referenced files. Thread=${thread}`);
  assert(called("edit_file") || called("multi_edit_file") || called("apply_patch_file"), `Agent did not use bounded edit tools. Thread=${thread}`);
  assert(!called("write_file"), `Agent used write_file instead of bounded edits. Thread=${thread}`);
  assert(!events.some((event) => (
    event.type === "tool_call" &&
    event.toolName === "bash" &&
    /\b(?:sed|perl|python|node)\b/.test(String(event.args.command ?? ""))
  )), `Agent edited through shell/runtime command instead of ForgeAgent edit tools. Thread=${thread}`);
  assert(hasTypeScriptVerificationEvidence(events), `Agent did not run TypeScript verification. Thread=${thread}`);
  assert(!events.some((event) => (
    event.type === "permission_request" &&
    event.toolName === "bash" &&
    event.subject.includes("tsc")
  )), "Safe TypeScript verification unexpectedly requested user approval.");
  assert(called("git_diff"), `Agent did not review git diff. Thread=${thread}`);

  const refactoredFiles = [definitionPath, renderPath, auditPath];
  for (const filePath of refactoredFiles) {
    const source = readFileSync(filePath, "utf-8");
    assert(source.includes("formatDisplayName"), `Missing renamed symbol in ${filePath}:\n${source}`);
    assert(!source.includes("formatUserLabel"), `Old symbol remains in ${filePath}:\n${source}`);
  }
  execFileSync("npx", ["tsc", "--noEmit", "--pretty", "false"], {
    cwd: projectDir,
    stdio: "pipe",
    timeout: 120_000,
    env: process.env,
  });

  const diagnostics = ctx.api.getDiagnostics(session.id);
  assert(diagnostics.filter((diagnostic) => diagnostic.severity === "error").length === 0, `Diagnostics still contain errors: ${JSON.stringify(diagnostics, null, 2)}`);
  const checks = ctx.api.getVerificationResults(session.id);
  assert(hasPassedTypeScriptVerification(checks), `No passed TypeScript verification recorded: ${JSON.stringify(checks, null, 2)}`);
  const diffs = ctx.api.getSessionDiffs(session.id);
  const changed = new Set(diffs.map((diff) => diff.filePath));
  for (const filePath of refactoredFiles) {
    assert(changed.has(filePath), `No structured diff recorded for ${filePath}. Diffs=${JSON.stringify(diffs, null, 2)}`);
  }
  const answer = lastAssistantText(events);
  assert(answer.includes("CODING_REFACTOR_OK"), `Agent did not produce refactor success marker: ${answer}`);
  ctx.autoResponses.delete(session.id);
  return {
    detail: `refactored=${refactoredFiles.length}; checks=${checks.length}; diffs=${diffs.length}; tools=${toolCalls.map((event) => event.toolName).join(",")}`,
    diagnostics: {
      projectDir,
      changedFiles: refactoredFiles,
      activity: ctx.api.getWorkspaceActivity(session.id),
    },
  };
}

function prepareFrontendWorkspace(ctx: ReleaseContext): {
  projectDir: string;
  indexPath: string;
  stylePath: string;
  mainPath: string;
} {
  const projectDir = join(ctx.workspaceDir, "coding-agent-frontend-workspace");
  rmSync(projectDir, { recursive: true, force: true });
  mkdirSync(join(projectDir, "src"), { recursive: true });
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({
    name: "forgeagent-release-frontend-workspace",
    private: true,
    type: "module",
    scripts: {
      typecheck: "tsc --noEmit --pretty false",
    },
    devDependencies: {
      typescript: "^5.8.0",
    },
  }, null, 2), "utf-8");
  writeFileSync(join(projectDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      lib: ["ES2022", "DOM"],
      types: [],
    },
    include: ["src/**/*.ts"],
  }, null, 2), "utf-8");
  const indexPath = join(projectDir, "index.html");
  const stylePath = join(projectDir, "src", "styles.css");
  const mainPath = join(projectDir, "src", "main.ts");
  writeFileSync(indexPath, [
    "<!doctype html>",
    "<html lang=\"en\">",
    "  <head>",
    "    <meta charset=\"UTF-8\" />",
    "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />",
    "    <title>ForgeAgent Frontend Fixture</title>",
    "    <link rel=\"stylesheet\" href=\"./src/styles.css\" />",
    "  </head>",
    "  <body>",
    "    <main class=\"console-card\">",
    "      <p class=\"eyebrow\">Local agent workspace</p>",
    "      <h1 id=\"console-title\">ForgeAgent Setup</h1>",
    "      <p id=\"console-copy\">Waiting for setup.</p>",
    "      <span id=\"status-pill\" class=\"status-pill\" data-state=\"offline\">Offline</span>",
    "      <button id=\"primary-action\" type=\"button\">Start</button>",
    "    </main>",
    "    <script type=\"module\" src=\"./src/main.ts\"></script>",
    "  </body>",
    "</html>",
    "",
  ].join("\n"), "utf-8");
  writeFileSync(stylePath, [
    ":root {",
    "  color: #37352f;",
    "  background: #fbfbfa;",
    "  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif;",
    "}",
    "",
    "body {",
    "  min-height: 100vh;",
    "  margin: 0;",
    "  display: grid;",
    "  place-items: center;",
    "}",
    "",
    ".console-card {",
    "  width: min(560px, calc(100vw - 48px));",
    "  border: 1px solid #dedbd5;",
    "  padding: 32px;",
    "  background: #ffffff;",
    "}",
    "",
    ".eyebrow {",
    "  color: #787774;",
    "  text-transform: uppercase;",
    "  letter-spacing: 0.08em;",
    "}",
    "",
    ".status-pill {",
    "  display: inline-flex;",
    "  align-items: center;",
    "  border: 1px solid #d0ccc3;",
    "  padding: 6px 10px;",
    "  color: #787774;",
    "}",
    "",
  ].join("\n"), "utf-8");
  writeFileSync(mainPath, [
    "type ConsoleState = \"offline\" | \"online\";",
    "",
    "const status = document.querySelector<HTMLSpanElement>(\"#status-pill\");",
    "const button = document.querySelector<HTMLButtonElement>(\"#primary-action\");",
    "",
    "export function setConsoleState(next: ConsoleState): void {",
    "  if (!status || !button) return;",
    "  status.dataset.state = next;",
    "  status.textContent = next === \"online\" ? \"Online\" : \"Offline\";",
    "  button.textContent = next === \"online\" ? \"Open workspace\" : \"Start\";",
    "}",
    "",
    "setConsoleState(\"offline\");",
    "",
  ].join("\n"), "utf-8");

  runGitCommand(projectDir, ["init"]);
  runGitCommand(projectDir, ["config", "user.email", "release-e2e@forgeagent.local"]);
  runGitCommand(projectDir, ["config", "user.name", "ForgeAgent Release E2E"]);
  runGitCommand(projectDir, ["add", "."]);
  runGitCommand(projectDir, ["commit", "-m", "initial frontend fixture"]);
  return { projectDir, indexPath, stylePath, mainPath };
}

function serveStaticWorkspace(root: string): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const fullPath = resolve(root, relativePath);
    if (!fullPath.startsWith(resolve(root))) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (!existsSync(fullPath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const type = fullPath.endsWith(".css")
      ? "text/css"
      : fullPath.endsWith(".ts")
        ? "text/javascript"
        : "text/html";
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
    res.end(readFileSync(fullPath));
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        server.close();
        reject(new Error("Could not allocate frontend static server port."));
        return;
      }
      resolvePromise({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function scenarioAgentFrontendWorkspace(ctx: ReleaseContext): Promise<{ detail: string; diagnostics: Record<string, unknown> }> {
  const { projectDir, indexPath, stylePath, mainPath } = prepareFrontendWorkspace(ctx);
  const project = ctx.api.createProject({
    name: "Release Frontend Workspace",
    path: projectDir,
    create: true,
    trustState: "trusted",
  });
  const session = ctx.api.createSession(`${RUN_ID} agent frontend workspace`, { projectId: project.id });
  ctx.autoResponses.set(session.id, "allow_once");
  ctx.api.appendUserMessage(
    session.id,
    [
      "This is a ForgeAgent release gate for frontend coding ability. Work only inside the current workspace.",
      "Update the local console UI so that the visible h1 element with id=\"console-title\" shows exactly 'ForgeAgent Console Ready',",
      "the paragraph with id=\"console-copy\" keeps that id and says 'Your local DeepSeek workspace is connected and ready.',",
      "and the status pill starts as Online with data-state=\"online\".",
      "Update src/main.ts so setConsoleState initializes the page online by default, and update src/styles.css so the online status pill is green (#1f7a4d) with a light green background (#edf7f1).",
      "Use todo_write, read_file, bounded edit tools, verify_workspace, and git_diff. Use bash for verification only if verify_workspace reports that no safe check can be detected.",
      "Do not use write_file to overwrite files, and do not use bash/perl/sed/python/node to edit source files.",
      "When done, answer with exactly the prefix FRONTEND_AGENT_OK and mention index.html, src/main.ts, and src/styles.css.",
    ].join(" "),
    { source: DEVICE_SOURCE },
  );
  await waitForSessionStatus(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  assertToolPairs(events);
  const thread = threadTypes(events);
  const toolCalls = events.filter((event) => event.type === "tool_call");
  const called = (toolName: string) => toolCalls.some((event) => event.toolName === toolName);
  assert(called("todo_write"), `Agent did not record frontend plan. Thread=${thread}`);
  assert(called("read_file"), `Agent did not inspect frontend files. Thread=${thread}`);
  assert(called("edit_file") || called("multi_edit_file") || called("apply_patch_file"), `Agent did not use bounded edit tools. Thread=${thread}`);
  const successfulWriteFiles = successfulToolUseIds(events, "write_file");
  assert(successfulWriteFiles.length === 0, `Agent successfully used write_file instead of bounded edits: ${successfulWriteFiles.join(", ")}. Thread=${thread}`);
  assert(!events.some((event) => (
    event.type === "tool_call" &&
    event.toolName === "bash" &&
    /\b(?:sed|perl|python|node)\b/.test(String(event.args.command ?? ""))
  )), `Agent edited through shell/runtime command instead of ForgeAgent edit tools. Thread=${thread}`);
  assert(hasTypeScriptVerificationEvidence(events), `Agent did not run TypeScript verification. Thread=${thread}`);
  assert(!events.some((event) => (
    event.type === "permission_request" &&
    event.toolName === "bash" &&
    event.subject.includes("tsc")
  )), "Safe frontend TypeScript verification unexpectedly requested user approval.");
  assert(called("git_diff"), `Agent did not review frontend git diff. Thread=${thread}`);

  const html = readFileSync(indexPath, "utf-8");
  const css = readFileSync(stylePath, "utf-8");
  const main = readFileSync(mainPath, "utf-8");
  assert(/<h1\s+id="console-title">ForgeAgent Console Ready<\/h1>/.test(html), `Visible HTML h1 was not updated:\n${html}`);
  assert(/<p\s+id="console-copy">Your local DeepSeek workspace is connected and ready\.<\/p>/.test(html), `Visible HTML copy id/text was not preserved:\n${html}`);
  assert(html.includes("Your local DeepSeek workspace is connected and ready."), `HTML copy was not updated:\n${html}`);
  assert(html.includes("data-state=\"online\""), `HTML status state was not set online:\n${html}`);
  assert(main.includes("setConsoleState(\"online\")"), `main.ts does not initialize online:\n${main}`);
  assert(css.includes("#1f7a4d") && css.includes("#edf7f1"), `CSS online status colors missing:\n${css}`);
  execFileSync("npx", ["tsc", "--noEmit", "--pretty", "false"], {
    cwd: projectDir,
    stdio: "pipe",
    timeout: 120_000,
    env: process.env,
  });

  const staticServer = await serveStaticWorkspace(projectDir);
  const browser = await playwrightChromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(staticServer.url, { waitUntil: "networkidle" });
    await page.waitForSelector("#status-pill[data-state='online']");
    const title = await page.locator("#console-title").innerText();
    const copy = await page.locator("#console-copy").innerText();
    const statusText = await page.locator("#status-pill").innerText();
    const styles = await page.locator("#status-pill").evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        color: computed.color,
        backgroundColor: computed.backgroundColor,
      };
    });
    assert(title === "ForgeAgent Console Ready", `Rendered title mismatch: ${title}`);
    assert(copy === "Your local DeepSeek workspace is connected and ready.", `Rendered copy mismatch: ${copy}`);
    assert(statusText === "Online", `Rendered status mismatch: ${statusText}`);
    assert(styles.color === "rgb(31, 122, 77)", `Rendered online color mismatch: ${JSON.stringify(styles)}`);
    assert(styles.backgroundColor === "rgb(237, 247, 241)", `Rendered online background mismatch: ${JSON.stringify(styles)}`);
  } finally {
    await browser.close().catch(() => undefined);
    await stopPageServer(staticServer.server);
  }

  const checks = ctx.api.getVerificationResults(session.id);
  const diffs = ctx.api.getSessionDiffs(session.id);
  for (const filePath of [indexPath, stylePath, mainPath]) {
    assert(diffs.some((diff) => diff.filePath === filePath), `No structured diff recorded for ${filePath}. Diffs=${JSON.stringify(diffs, null, 2)}`);
  }
  const answer = lastAssistantText(events);
  assert(answer.includes("FRONTEND_AGENT_OK"), `Agent did not produce frontend success marker: ${answer}`);
  ctx.autoResponses.delete(session.id);
  return {
    detail: `frontendFiles=3; checks=${checks.length}; diffs=${diffs.length}; tools=${toolCalls.map((event) => event.toolName).join(",")}`,
    diagnostics: {
      projectDir,
      changedFiles: [indexPath, stylePath, mainPath],
      activity: ctx.api.getWorkspaceActivity(session.id),
    },
  };
}

function preparePackageInstallWorkspace(ctx: ReleaseContext): { projectDir: string } {
  const projectDir = join(ctx.workspaceDir, "coding-agent-package-install");
  rmSync(projectDir, { recursive: true, force: true });
  mkdirSync(join(projectDir, "src"), { recursive: true });
  mkdirSync(join(projectDir, "fixtures", "forge-local-one"), { recursive: true });
  mkdirSync(join(projectDir, "fixtures", "forge-local-two"), { recursive: true });
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({
    name: "forgeagent-release-package-install",
    private: true,
    scripts: {
      test: "node src/index.cjs",
    },
  }, null, 2), "utf-8");
  writeFileSync(join(projectDir, "src", "index.cjs"), [
    "const one = require('forge-local-one');",
    "const two = require('forge-local-two');",
    "if (one() !== 'one' || two() !== 'two') {",
    "  throw new Error(`unexpected packages: ${one()} ${two()}`);",
    "}",
    "console.log('PACKAGE_INSTALL_FIXTURE_OK');",
    "",
  ].join("\n"), "utf-8");
  writeFileSync(join(projectDir, "fixtures", "forge-local-one", "package.json"), JSON.stringify({
    name: "forge-local-one",
    version: "1.0.0",
    main: "index.cjs",
  }, null, 2), "utf-8");
  writeFileSync(join(projectDir, "fixtures", "forge-local-one", "index.cjs"), "module.exports = () => 'one';\n", "utf-8");
  writeFileSync(join(projectDir, "fixtures", "forge-local-two", "package.json"), JSON.stringify({
    name: "forge-local-two",
    version: "1.0.0",
    main: "index.cjs",
  }, null, 2), "utf-8");
  writeFileSync(join(projectDir, "fixtures", "forge-local-two", "index.cjs"), "module.exports = () => 'two';\n", "utf-8");
  runGitCommand(projectDir, ["init"]);
  runGitCommand(projectDir, ["config", "user.email", "release-e2e@forgeagent.local"]);
  runGitCommand(projectDir, ["config", "user.name", "ForgeAgent Release E2E"]);
  runGitCommand(projectDir, ["add", "."]);
  runGitCommand(projectDir, ["commit", "-m", "initial package install fixture"]);
  return { projectDir };
}

async function scenarioAgentPackageInstallPermission(ctx: ReleaseContext): Promise<{ detail: string; diagnostics: Record<string, unknown> }> {
  const { projectDir } = preparePackageInstallWorkspace(ctx);
  const project = ctx.api.createProject({
    name: "Release Package Install Permission Workspace",
    path: projectDir,
    create: true,
    trustState: "trusted",
  });
  const session = ctx.api.createSession(`${RUN_ID} agent package install permission`, { projectId: project.id });
  ctx.autoResponses.set(session.id, "allow_once");
  ctx.autoPermissionGrants.set(session.id, ["package_install"]);
  ctx.api.appendUserMessage(
    session.id,
    [
      "This is a ForgeAgent release gate for package-install permission grouping. Work only inside the current workspace.",
      `The current workspace root is ${JSON.stringify(projectDir)}.`,
      "The test command fails until two local packages are installed from ./fixtures.",
      "You must run exactly two separate bash install commands:",
      "1. npm install ./fixtures/forge-local-one --no-audit --no-fund",
      "2. npm install ./fixtures/forge-local-two --no-audit --no-fund",
      "The first install should trigger one package-install approval; the session package_install grant then allows the second install without another approval.",
      "After both installs, run verify_workspace and git_diff, then answer with the prefix PACKAGE_INSTALL_OK.",
      "Do not edit files and do not combine the two npm install commands.",
    ].join(" "),
    { source: DEVICE_SOURCE },
  );
  await waitForSessionStatus(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  assertToolPairs(events);
  const thread = threadTypes(events);
  const toolCalls = events.filter((event) => event.type === "tool_call");
  const installCalls = toolCalls.filter((event) => (
    event.toolName === "bash" &&
    /(?:^|&&\s*)npm install \.\/fixtures\/forge-local-(?:one|two) --no-audit --no-fund$/.test(String(event.args.command ?? "").trim())
  ));
  assert(installCalls.length >= 2, `Agent did not run two separate local npm install commands. Thread=${thread}`);
  const permissionRequests = events.filter((event) => event.type === "permission_request");
  const installPermissionRequests = permissionRequests.filter((event) => (
    event.toolName === "bash" &&
    event.subject.includes("npm install")
  ));
  assert(installPermissionRequests.length === 1, `Package install should ask exactly once after grant; got ${installPermissionRequests.length}. Events=${JSON.stringify(permissionRequests, null, 2)}`);
  assert(events.some((event) => (
    event.type === "permission_grant_event" &&
    event.grantKind === "package_install" &&
    event.action === "created"
  )), `No package_install permission grant event was recorded. Thread=${thread}`);
  assert(toolCalls.some((event) => event.toolName === "verify_workspace"), `Agent did not verify after package installation. Thread=${thread}`);
  assert(toolCalls.some((event) => event.toolName === "git_diff"), `Agent did not inspect git diff after package installation. Thread=${thread}`);
  execFileSync("npm", ["test", "--", "--silent"], {
    cwd: projectDir,
    stdio: "pipe",
    timeout: 120_000,
    env: process.env,
  });
  const checks = ctx.api.getVerificationResults(session.id);
  assert(hasPassedWorkspaceTest(checks), `No passed package install verification recorded: ${JSON.stringify(checks, null, 2)}`);
  const answer = lastAssistantText(events);
  assert(answer.includes("PACKAGE_INSTALL_OK"), `Agent did not produce package install success marker: ${answer}`);
  ctx.autoResponses.delete(session.id);
  ctx.autoPermissionGrants.delete(session.id);
  return {
    detail: `installRequests=${installPermissionRequests.length}; installs=${installCalls.length}; grants=package_install; checks=${checks.length}; tools=${toolCalls.map((event) => event.toolName).join(",")}`,
    diagnostics: {
      projectDir,
      permissionRequests,
      activity: ctx.api.getWorkspaceActivity(session.id),
    },
  };
}

async function scenarioAgentDynamicSkillUse(ctx: ReleaseContext): Promise<{ detail: string; diagnostics: Record<string, unknown> }> {
  const projectDir = join(ctx.workspaceDir, "coding-agent-dynamic-skill");
  rmSync(projectDir, { recursive: true, force: true });
  mkdirSync(join(projectDir, "src"), { recursive: true });
  writeFileSync(join(projectDir, "src", "review-target.ts"), [
    "export function parseCount(input: string): number {",
    "  return Number.parseInt(input);",
    "}",
    "",
  ].join("\n"), "utf-8");
  runGitCommand(projectDir, ["init"]);
  runGitCommand(projectDir, ["config", "user.email", "release-e2e@forgeagent.local"]);
  runGitCommand(projectDir, ["config", "user.name", "ForgeAgent Release E2E"]);
  runGitCommand(projectDir, ["add", "."]);
  runGitCommand(projectDir, ["commit", "-m", "initial dynamic skill fixture"]);
  const project = ctx.api.createProject({
    name: "Release Dynamic Skill Use Workspace",
    path: projectDir,
    create: true,
    trustState: "trusted",
  });
  const session = ctx.api.createSession(`${RUN_ID} agent dynamic skill use`, { projectId: project.id });
  ctx.autoResponses.set(session.id, "allow_once");
  ctx.api.appendUserMessage(
    session.id,
    [
      "This is a ForgeAgent release gate for dynamic extension skill install and use.",
      `The current workspace root is ${JSON.stringify(projectDir)}.`,
      "Install and enable the curated code-reviewer skill using extension_search, extension_install, and extension_enable.",
      "After the skill is installed, use read_file to read the installed SKILL.md instead of relying on memory.",
      "Then apply that skill guidance to review src/review-target.ts. Do not edit files.",
      "Your final answer must start with DYNAMIC_SKILL_OK and mention one concrete review finding.",
    ].join(" "),
    { source: DEVICE_SOURCE },
  );
  await waitForSessionStatus(ctx.api, session.id, ["idle"], 420_000);
  const events = ctx.api.getThread(session.id);
  assertToolPairs(events);
  const thread = threadTypes(events);
  const toolCalls = events.filter((event) => event.type === "tool_call");
  const called = (toolName: string) => toolCalls.some((event) => event.toolName === toolName);
  assert(called("extension_search"), `Agent did not search extensions. Thread=${thread}`);
  assert(called("extension_install"), `Agent did not install a skill extension. Thread=${thread}`);
  const installedActive = events.some((event) => (
    event.type === "tool_result" &&
    event.toolName === "extension_install" &&
    event.isError !== true &&
    /status:\s*active|enabled/i.test(String(event.result))
  ));
  assert(called("extension_enable") || installedActive, `Agent did not enable the installed skill or receive an active install result. Thread=${thread}`);
  assert(called("read_file"), `Agent did not read the installed SKILL.md. Thread=${thread}`);
  assert(events.some((event) => (
    event.type === "skill_used" &&
    /code-reviewer/i.test(event.skillName) &&
    /SKILL\.md$/i.test(event.filePath)
  )), `Reading the installed skill did not record skill_used. Thread=${thread}`);
  assert(events.some((event) => (
    event.type === "tool_result" &&
    event.toolName === "extension_install" &&
    event.isError !== true &&
    /skill_location|code-reviewer/i.test(String(event.result))
  )), `Skill install result did not expose installed package location. Thread=${thread}`);
  const answer = lastAssistantText(events);
  assert(answer.includes("DYNAMIC_SKILL_OK"), `Agent did not produce dynamic skill success marker: ${answer}`);
  ctx.autoResponses.delete(session.id);
  return {
    detail: `dynamicSkill=code-reviewer; enabled=${called("extension_enable") ? "extension_enable" : "install_active"}; tools=${toolCalls.map((event) => event.toolName).join(",")}`,
    diagnostics: {
      projectDir,
      skillEvents: events.filter((event) => event.type === "skill_used" || event.type === "skill_event"),
      activity: ctx.api.getWorkspaceActivity(session.id),
    },
  };
}

async function scenarioAgentDestructiveCommandDenied(ctx: ReleaseContext): Promise<{ detail: string; diagnostics: Record<string, unknown> }> {
  const projectDir = join(ctx.workspaceDir, "coding-agent-destructive-deny");
  rmSync(projectDir, { recursive: true, force: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "README.md"), "destructive command policy fixture\n", "utf-8");
  runGitCommand(projectDir, ["init"]);
  runGitCommand(projectDir, ["config", "user.email", "release-e2e@forgeagent.local"]);
  runGitCommand(projectDir, ["config", "user.name", "ForgeAgent Release E2E"]);
  runGitCommand(projectDir, ["add", "."]);
  runGitCommand(projectDir, ["commit", "-m", "initial destructive deny fixture"]);
  const project = ctx.api.createProject({
    name: "Release Destructive Command Deny Workspace",
    path: projectDir,
    create: true,
    trustState: "trusted",
  });
  const session = ctx.api.createSession(`${RUN_ID} agent destructive command denied`, { projectId: project.id });
  ctx.api.appendUserMessage(
    session.id,
    [
      "This is a ForgeAgent release gate for destructive command denial. Work only inside the current workspace.",
      "Call the bash tool exactly once with command rm -rf / . This is a policy test; ToolPolicy must deny before execution.",
      "After the tool_result error comes back, do not retry the command. Read the error text and recover by answering with the prefix DESTRUCTIVE_DENIED_OK.",
      "Your answer must mention that the command was denied before execution and did not block the session.",
    ].join(" "),
    { source: DEVICE_SOURCE },
  );
  await waitForSessionStatus(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  assertToolPairs(events);
  const thread = threadTypes(events);
  const bashCall = events.find((event) => (
    event.type === "tool_call" &&
    event.toolName === "bash" &&
    String(event.args.command ?? "").trim() === "rm -rf /"
  ));
  assert(bashCall, `Agent did not call the destructive command test. Thread=${thread}`);
  const denied = events.find((event) => (
    event.type === "tool_result" &&
    event.toolName === "bash" &&
    event.isError === true &&
    String(event.result).includes("recursive forced delete")
  ));
  assert(denied, `Destructive bash command did not return a concrete denial tool_result. Thread=${thread}`);
  assert(!events.some((event) => event.type === "permission_request"), `Hard-denied command should not ask for approval. Thread=${thread}`);
  assert(!events.some((event) => event.type === "runtime_event" && event.detail === "failed"), `Destructive tool denial should not block the session. Thread=${thread}`);
  const answer = lastAssistantText(events);
  assert(answer.includes("DESTRUCTIVE_DENIED_OK"), `Agent did not recover after destructive denial: ${answer}`);
  return {
    detail: `deniedTool=bash; permissionRequests=0; answer=${answer.slice(0, 120)}`,
    diagnostics: {
      projectDir,
      deniedResult: denied.type === "tool_result" ? denied.result : "",
      activity: ctx.api.getWorkspaceActivity(session.id),
    },
  };
}

async function scenarioAgentCompactionCodingContinuity(): Promise<{ detail: string; diagnostics: Record<string, unknown> }> {
  const isolatedDir = join(DATA_DIR, "compaction-coding-continuity");
  const isolatedWorkspace = join(isolatedDir, "workspace");
  rmSync(isolatedDir, { recursive: true, force: true });
  const seed = setupIsolatedCore({
    dataDir: isolatedDir,
    workspaceDir: isolatedWorkspace,
    contextWindowTokens: 20_000,
    autoCompactBuffer: 7_000,
    compactionKeepRecentTokens: 80,
  });
  let sessionId = "";
  let projectDir = "";
  let targetPath = "";
  try {
    const prepared = prepareCodingWorkspace(seed);
    projectDir = prepared.projectDir;
    targetPath = prepared.targetPath;
    const project = seed.api.createProject({
      name: "Release Compaction Coding Continuity Workspace",
      path: projectDir,
      create: true,
      trustState: "trusted",
    });
    const session = seed.api.createSession(`${RUN_ID} agent compaction coding continuity`, { projectId: project.id });
    sessionId = session.id;
    const longHistory = Array.from({ length: 80 }, (_, index) => (
      `Historical coding note ${index}: the workspace activity model must preserve plans, diffs, checks, artifacts, permissions, and current task priority.`
    )).join("\n");
    seed.api.appendUserMessage(
      session.id,
      [
        "This is old history for a ForgeAgent release gate. It should be compacted when the next turn exceeds the context threshold.",
        longHistory,
      ].join("\n\n"),
      { source: DEVICE_SOURCE, dispatch: false },
    );
  } finally {
    await seed.api.shutdown({ waitMs: 500 }).catch(() => undefined);
  }

  const threadPath = join(isolatedDir, "core", "sessions", sessionId, "thread.jsonl");
  const lines = readFileSync(threadPath, "utf-8").trimEnd().split("\n");
  const seeded = lines.map((line, index) => {
    if (index !== 0) return line;
    const meta = JSON.parse(line) as Record<string, unknown>;
    meta.status = "idle";
    return JSON.stringify(meta);
  });
  seeded.push(JSON.stringify({
    type: "assistant_message",
    seq: 2,
    timestamp: new Date().toISOString(),
    sessionId,
    branchId: "main",
    text: "Acknowledged the old workspace context. Future turns should prioritize the latest user message over compacted history.",
  }));
  writeFileSync(threadPath, `${seeded.join("\n")}\n`, "utf-8");

  const compactionCtx = setupIsolatedCore({
    dataDir: isolatedDir,
    workspaceDir: isolatedWorkspace,
    contextWindowTokens: 20_000,
    autoCompactBuffer: 7_000,
    compactionKeepRecentTokens: 80,
  });
  try {
    compactionCtx.api.loadSessions();
    compactionCtx.api.appendUserMessage(
      sessionId,
      [
        "Compact the old workspace history now.",
        "Do not change files in this turn.",
        "Answer only that the context is ready for the next coding task.",
      ].join(" "),
      { source: DEVICE_SOURCE },
    );
    await waitForSessionStatus(compactionCtx.api, sessionId, ["idle"], 600_000);
    const preEvents = compactionCtx.api.getThread(sessionId);
    assert(
      preEvents.some((event) => event.type === "compaction_block"),
      `Pre-task compaction did not occur. Thread=${threadTypes(preEvents)}`,
    );
    assert(
      preEvents.some((event) => event.type === "context_usage_event" && event.reason === "post_compaction"),
      `Pre-task post-compaction context estimate was not recorded. Thread=${threadTypes(preEvents)}`,
    );
  } finally {
    await compactionCtx.api.shutdown({ waitMs: 1_000 }).catch(() => undefined);
  }

  const ctx = setupIsolatedCore({
    dataDir: isolatedDir,
    workspaceDir: isolatedWorkspace,
    contextWindowTokens: 100_000,
    autoCompactBuffer: 10_000,
    compactionKeepRecentTokens: 20_000,
  });
  try {
    ctx.api.loadSessions();
    ctx.autoResponses.set(sessionId, "allow_once");
    ctx.api.appendUserMessage(
      sessionId,
      [
        "This is the current task and must remain more important than the compacted old history.",
        "Fix src/math.ts so totalVisits returns the numeric sum instead of a string.",
        "Use todo_write, lsp_diagnostics, bounded edit tools, verify_workspace, git_diff, and workspace_review.",
        "Your final answer must start with COMPACTION_CODING_OK.",
      ].join(" "),
      { source: DEVICE_SOURCE },
    );
    await waitForSessionStatus(ctx.api, sessionId, ["idle"], 600_000);
    const events = ctx.api.getThread(sessionId);
    assertToolPairs(events);
    const thread = threadTypes(events);
    const compactionBlocks = events.filter((event) => event.type === "compaction_block");
    const compactedText = compactionBlocks.map((event) => event.summary).join("\n");
    assert(compactionBlocks.length > 0, `Compaction did not occur. Thread=${thread}`);
    assert(events.some((event) => event.type === "context_usage_event" && event.reason === "post_compaction"), `Post-compaction context estimate was not recorded. Thread=${thread}`);
    const toolCalls = events.filter((event) => event.type === "tool_call");
    const lastCompactionIndex = events.reduce((latest, event, index) => event.type === "compaction_block" ? index : latest, -1);
    const postCompactionEvents = lastCompactionIndex >= 0 ? events.slice(lastCompactionIndex + 1) : [];
    const postCompactionToolCalls = postCompactionEvents.filter((event) => event.type === "tool_call");
    assert(
      postCompactionToolCalls.some((event) => event.toolName === "workspace_review" || event.toolName === "verify_workspace"),
      `Agent did not continue the coding loop with real tools after compaction. Post-compaction events=${postCompactionEvents.map((event) => event.type).join(",")}`,
    );
    assert(
      postCompactionEvents.some((event) => (
        event.type === "tool_result" &&
        event.toolName === "workspace_review" &&
        event.isError !== true
      )),
      `Agent did not produce a passing workspace_review after compaction. Post-compaction events=${postCompactionEvents.map((event) => event.type).join(",")}`,
    );
    for (const marker of ["workspace activity model", "plans", "diffs", "checks", "artifacts", "permissions", "current task priority"]) {
      assert(compactedText.includes(marker), `Compaction summary did not preserve ${marker}. Summary=${compactedText.slice(0, 2000)}`);
    }
    for (const toolName of ["todo_write", "lsp_diagnostics", "verify_workspace", "git_diff", "workspace_review"]) {
      assert(
        postCompactionToolCalls.some((event) => event.toolName === toolName),
        `Agent did not use ${toolName} after compaction. Post-compaction tools=${postCompactionToolCalls.map((event) => event.toolName).join(",")}`,
      );
    }
    execFileSync("npx", ["tsc", "--noEmit", "--pretty", "false"], {
      cwd: projectDir,
      stdio: "pipe",
      timeout: 120_000,
      env: process.env,
    });
    const answer = lastAssistantText(events);
    assert(answer.includes("COMPACTION_CODING_OK"), `Agent did not finish the compacted coding task: ${answer}`);
    return {
      detail: `compaction=true; summaryPreserved=workspace-activity; liveTools=${toolCalls.map((event) => event.toolName).join(",")}; postCompactionTools=${postCompactionToolCalls.map((event) => event.toolName).join(",")}; target=${targetPath}`,
      diagnostics: {
        projectDir,
        activity: ctx.api.getWorkspaceActivity(sessionId),
        compactions: compactionBlocks.length,
        compactionSummary: compactedText.slice(0, 2_000),
      },
    };
  } finally {
    await ctx.api.shutdown({ waitMs: 1_000 }).catch(() => undefined);
  }
}

function appendDanglingToolCallToThread(dataDir: string, sessionId: string): void {
  const filePath = join(dataDir, "core", "sessions", sessionId, "thread.jsonl");
  const lines = readFileSync(filePath, "utf-8").trimEnd().split("\n");
  const updated = lines.map((line, index) => {
    if (index !== 0) return line;
    const meta = JSON.parse(line) as Record<string, unknown>;
    meta.status = "running";
    return JSON.stringify(meta);
  });
  const toolCall = {
    type: "tool_call",
    seq: 999,
    timestamp: new Date().toISOString(),
    sessionId,
    branchId: "main",
    toolName: "read_file",
    args: { file_path: "src/math.ts" },
    toolUseId: "restart_dangling_read_file",
  };
  writeFileSync(filePath, `${updated.join("\n")}\n`, "utf-8");
  appendFileSync(filePath, `${JSON.stringify(toolCall)}\n`, "utf-8");
}

async function scenarioAgentRestartCodingContinuity(): Promise<{ detail: string; diagnostics: Record<string, unknown> }> {
  const isolatedDir = join(DATA_DIR, "restart-coding-continuity");
  const isolatedWorkspace = join(isolatedDir, "workspace");
  rmSync(isolatedDir, { recursive: true, force: true });
  const first = setupIsolatedCore({ dataDir: isolatedDir, workspaceDir: isolatedWorkspace });
  let sessionId = "";
  let projectDir = "";
  let targetPath = "";
  try {
    const prepared = prepareCodingWorkspace(first);
    projectDir = prepared.projectDir;
    targetPath = prepared.targetPath;
    const project = first.api.createProject({
      name: "Release Restart Coding Continuity Workspace",
      path: projectDir,
      create: true,
      trustState: "trusted",
    });
    const session = first.api.createSession(`${RUN_ID} agent restart coding continuity`, { projectId: project.id });
    sessionId = session.id;
    first.api.appendUserMessage(
      session.id,
      [
        "This is a ForgeAgent release gate for process restart continuity. Work only inside the current workspace.",
        "After restart retry, fix src/math.ts so totalVisits returns a numeric sum. Use bounded edit tools, verify_workspace, git_diff, and answer with RESTART_CONTINUITY_OK.",
      ].join(" "),
      { source: DEVICE_SOURCE, dispatch: false },
    );
  } finally {
    await first.api.shutdown({ waitMs: 500 }).catch(() => undefined);
  }
  appendDanglingToolCallToThread(isolatedDir, sessionId);

  const second = setupIsolatedCore({ dataDir: isolatedDir, workspaceDir: isolatedWorkspace });
  try {
    second.api.loadSessions();
    const startupReport = await second.api.rehydrateAfterStartup();
    assert(startupReport.startupBlockedSessions.includes(sessionId), `Restart did not block interrupted running session: ${JSON.stringify(startupReport, null, 2)}`);
    const blockedThread = second.api.getThread(sessionId);
    assert(blockedThread.some((event) => (
      event.type === "tool_result" &&
      event.toolUseId === "restart_dangling_read_file" &&
      event.isError === true &&
      String(event.result).includes("Process restarted before this tool completed.")
    )), `Restart did not repair dangling tool_call. Thread=${threadTypes(blockedThread)}`);
    assert(second.api.getSession(sessionId)?.status === "blocked", `Session should be blocked after restart repair, got ${second.api.getSession(sessionId)?.status}`);
    second.autoResponses.set(sessionId, "allow_once");
    second.api.retryBlockedSession(sessionId);
    await waitForSessionStatus(second.api, sessionId, ["idle"], 420_000);
    const events = second.api.getThread(sessionId);
    assertToolPairs(events);
    const toolCalls = events.filter((event) => event.type === "tool_call");
    const called = (toolName: string) => toolCalls.some((event) => event.toolName === toolName);
    assert(called("verify_workspace"), `Agent did not verify after restart retry. Thread=${threadTypes(events)}`);
    assert(called("git_diff"), `Agent did not inspect diff after restart retry. Thread=${threadTypes(events)}`);
    execFileSync("npx", ["tsc", "--noEmit", "--pretty", "false"], {
      cwd: projectDir,
      stdio: "pipe",
      timeout: 120_000,
      env: process.env,
    });
    const answer = lastAssistantText(events);
    assert(answer.includes("RESTART_CONTINUITY_OK"), `Agent did not finish after restart retry: ${answer}`);
    return {
      detail: `restartRepaired=true; startupBlocked=true; target=${targetPath}; tools=${toolCalls.map((event) => event.toolName).join(",")}`,
      diagnostics: {
        projectDir,
        startupReport,
        activity: second.api.getWorkspaceActivity(sessionId),
      },
    };
  } finally {
    await second.api.shutdown({ waitMs: 1_000 }).catch(() => undefined);
  }
}

async function scenarioUiReviewWorkActivity(): Promise<{ detail: string; diagnostics: Record<string, unknown> }> {
  const isolatedDir = join(DATA_DIR, "ui-review-work-activity");
  const isolatedWorkspace = join(isolatedDir, "workspace");
  rmSync(isolatedDir, { recursive: true, force: true });
  const ctx = setupIsolatedCore({ dataDir: isolatedDir, workspaceDir: isolatedWorkspace });
  let sessionId = "";
  try {
    const projectDir = join(isolatedWorkspace, "ui-review-project");
    mkdirSync(projectDir, { recursive: true });
    const project = ctx.api.createProject({
      name: "Release UI Review Work Activity",
      path: projectDir,
      create: true,
      trustState: "trusted",
    });
    const session = ctx.api.createSession("UI Review Work Activity", { projectId: project.id });
    sessionId = session.id;
    ctx.api.appendUserMessage(sessionId, "Seed UI review activity facts.", { source: DEVICE_SOURCE, dispatch: false });
  } finally {
    await ctx.api.shutdown({ waitMs: 500 }).catch(() => undefined);
  }

  const threadPath = join(isolatedDir, "core", "sessions", sessionId, "thread.jsonl");
  const lines = readFileSync(threadPath, "utf-8").trimEnd().split("\n");
  const fixedMeta = lines.map((line, index) => {
    if (index !== 0) return line;
    const meta = JSON.parse(line) as Record<string, unknown>;
    meta.status = "idle";
    return JSON.stringify(meta);
  });
  const timestamp = new Date().toISOString();
  const events: SessionEvent[] = [
    { type: "todo_event", seq: 1001, timestamp, sessionId, branchId: "main", message: "Plan updated.", items: [{ id: "todo_ui", content: "Verify Review Work panel", status: "in_progress" }] },
    { type: "diff_event", seq: 1002, timestamp, sessionId, branchId: "main", filePath: join(isolatedWorkspace, "ui-review-project", "src", "app.ts"), operation: "updated", additions: 3, deletions: 1, summary: "Updated app state handling." },
    { type: "diagnostic_event", seq: 1003, timestamp, sessionId, branchId: "main", source: "release-ui", status: "issues", message: "1 diagnostic for UI review gate.", diagnostics: [{ filePath: "src/app.ts", line: 4, severity: "warning", message: "Synthetic warning", source: "release-ui" }] },
    { type: "verification_event", seq: 1004, timestamp, sessionId, branchId: "main", command: "npm test", status: "passed", exitCode: 0, summary: "Synthetic check passed." },
    { type: "shell_task_event", seq: 1005, timestamp, sessionId, branchId: "main", taskId: "task_ui_review", action: "completed", command: "npm run dev", status: "completed", message: "Background preview completed.", outputPreview: "ready" },
    { type: "artifact_pointer", seq: 1006, timestamp, sessionId, branchId: "main", artifactId: "artifact_ui_review", mimeType: "text/html", sizeBytes: 2048 },
    { type: "permission_grant_event", seq: 1007, timestamp, sessionId, branchId: "main", grantId: "grant_ui_review", grantKind: "workspace_edits", action: "created", scope: "session", message: "Workspace edits allowed for this session." },
    { type: "activity_event", seq: 1008, timestamp, sessionId, branchId: "main", activityKind: "verification", status: "completed", title: "Workspace review", message: "Review work gate ready.", payload: { ready: true, issues: [], nextActions: ["Ship"] } },
  ];
  writeFileSync(threadPath, `${fixedMeta.join("\n")}\n${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf-8");

  const uiDir = resolve("web", "dist");
  const uiIndex = join(uiDir, "index.html");
  const uiSourceMtime = Math.max(
    statSync(resolve("web", "src", "App.tsx")).mtimeMs,
    statSync(resolve("web", "src", "types.ts")).mtimeMs,
    statSync(resolve("web", "src", "styles.css")).mtimeMs,
  );
  if (!existsSync(uiIndex) || statSync(uiIndex).mtimeMs < uiSourceMtime) {
    execFileSync("npm", ["run", "product:build"], { stdio: "pipe", timeout: 180_000, env: process.env });
  }
  const loaded = setupIsolatedCore({ dataDir: isolatedDir, workspaceDir: isolatedWorkspace });
  loaded.api.loadSessions();
  const gateway = new (await import("../src/gateways/http/http-gateway.js")).HttpGateway(loaded.api);
  const { createHttpServer } = await import("../src/gateways/http/http-server.js");
  const server = createHttpServer(loaded.api, gateway, { authMode: "disabled", enableUi: true, uiDir });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  assert(addr && typeof addr === "object", "UI Review Work test did not obtain a port");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const browser = await playwrightChromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.locator(".project-switcher select").selectOption({ label: "Release UI Review Work Activity" });
    await page.locator(".session-list .session-select", { hasText: "UI Review Work Activity" }).click();
    const activityRail = page.getByRole("button", { name: /^Activity · 1 changes$/ });
    await activityRail.waitFor({ timeout: 15_000 });
    await activityRail.click();
    await page.waitForSelector(".status-drawer");
    const text = await page.locator(".status-drawer").innerText();
    for (const expected of ["Open todos", "Changed files", "Diagnostics", "Checks", "Tasks", "Artifacts", "Permission grants", "Workspace review"]) {
      assert(text.includes(expected), `Review Work drawer missing ${expected}. Drawer text:\n${text}`);
    }
    return {
      detail: `uiReviewWork=true; session=${sessionId}; url=${baseUrl}`,
      diagnostics: {
        drawerText: text.slice(0, 1_500),
        activity: loaded.api.getWorkspaceActivity(sessionId),
      },
    };
  } finally {
    await browser.close().catch(() => undefined);
    gateway.destroy();
    server.close();
    await once(server, "close").catch(() => undefined);
    await loaded.api.shutdown({ waitMs: 500 }).catch(() => undefined);
  }
}

async function scenarioMcpHttpSurface(): Promise<void> {
  const registry = new ToolRegistry();
  const api = new CoreAPI(registry, {
    dataDir: join(DATA_DIR, "http-mcp"),
    memoryDir: join(DATA_DIR, "http-mcp", "memory"),
    artifactDir: join(DATA_DIR, "http-mcp", "artifacts"),
  });
  api.registerBuiltInTools();
  api.initSupervisor(1);
  api.initScheduler();
  api.initToolPolicy({ projectRoot: WORKSPACE_DIR });
  api.setModelProvider(makeProvider());
  api.initMcpEcosystem({ projectRoot: WORKSPACE_DIR, baseDelayMs: 250, maxDelayMs: 1_000 });
  const gateway = new (await import("../src/gateways/http/http-gateway.js")).HttpGateway(api);
  const { createHttpServer } = await import("../src/gateways/http/http-server.js");
  const server = createHttpServer(api, gateway, { authMode: "disabled", enableUi: false });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  assert(addr && typeof addr === "object", "HTTP MCP surface test did not obtain a port");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    const added = await jsonRequest(baseUrl, "POST", "/mcp/servers", {
      id: "http_release_everything",
      name: "http_release_everything",
      enabled: true,
      transport: "stdio",
      launchMode: "eager",
      trust: "trusted",
      command: "npx",
      args: ["-y", EVERYTHING_MCP_PACKAGE],
      timeoutMs: 60_000,
      connectTimeoutMs: 60_000,
    });
    assert(added.status === 201, `HTTP add MCP failed: ${added.status} ${JSON.stringify(added.body)}`);
    await api.startMcpEcosystem();
    const tools = await jsonRequest(baseUrl, "GET", "/mcp/tools");
    assert(tools.status === 200, `HTTP list MCP tools failed: ${tools.status}`);
    assert(JSON.stringify(tools.body).includes("mcp__http_release_everything__echo"), `HTTP MCP tools missing real external tool: ${JSON.stringify(tools.body).slice(0, 2000)}`);
    const events = await jsonRequest(baseUrl, "GET", "/mcp/events?afterSeq=0");
    assert(events.status === 200, `HTTP MCP events failed: ${events.status}`);
  } finally {
    gateway.destroy();
    server.close();
    await once(server, "close").catch(() => undefined);
    await api.shutdown({ waitMs: 500 }).catch(() => undefined);
  }
}

function isStructuredError(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { isError?: unknown }).isError === true;
}

async function waitForMcpElicitation(api: CoreAPI, timeoutMs = 30_000) {
  const started = now();
  while (now() - started < timeoutMs) {
    const pending = api.getMcpElicitationRequests()[0];
    if (pending) return pending;
    await sleep(100);
  }
  throw new Error("Timed out waiting for MCP elicitation request");
}

async function jsonRequest(baseUrl: string, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolvePromise, reject) => {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (raw !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(new URL(path, baseUrl), { method, headers, timeout: DEFAULT_WAIT_MS }, (res: IncomingMessage) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk.toString("utf-8"); });
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

async function scenarioRealWebridge(): Promise<{ detail: string; diagnostics: Record<string, unknown> }> {
  const existingBaseUrl = process.env.RELEASE_WEBRIDGE_EXISTING_BASE_URL ?? "http://127.0.0.1:3000";
  if (await existingWebridgeOnline(existingBaseUrl)) {
    return await scenarioExistingWebridgeGateway(existingBaseUrl);
  }

  const extensionSourceDir = resolve(process.env.RELEASE_WEBRIDGE_EXTENSION_DIR ?? defaultWebridgeExtensionDir());
  assert(existsSync(join(extensionSourceDir, "manifest.json")), `ForgeWebridge extension manifest not found: ${extensionSourceDir}`);
  const port = Number(process.env.RELEASE_WEBRIDGE_PORT ?? await freePort());
  const started = await startHttpGateway({
    host: "127.0.0.1",
    port,
    dataDir: join(DATA_DIR, "webridge-gateway"),
    writeRunState: false,
    httpOptions: {
      enableUi: false,
      authMode: "enabled",
    },
  });
  const extensionDir = prepareWebridgeExtensionForRelease(extensionSourceDir, started.url);
  const chrome = await startChromeWithExtension("webridge", extensionDir);
  const pageServer = await startLocalPageServer();

  try {
    await wakeWebridgeExtension(chrome, extensionDir);
    const runtime = started.api.getWebridgeRuntime();
    assert(runtime, "ForgeWebridge runtime is not registered in gateway");
    try {
      await waitForWebridgeOnline(started, 60_000);
    } catch (err) {
      const extensionDiagnostics = await readWebridgeExtensionDiagnostics(chrome, extensionDir).catch((diagErr) => ({
        error: diagErr instanceof Error ? diagErr.message : String(diagErr),
      }));
      throw new Error([
        err instanceof Error ? err.message : String(err),
        `Extension diagnostics: ${JSON.stringify(extensionDiagnostics, null, 2)}`,
      ].join("\n"));
    }

    const sessionId = `release_webridge_${Date.now()}`;
    await runtime.createTab(sessionId);
    await runtime.navigate(sessionId, `${pageServer.url}/`);
    assert(await runtime.waitForSelector(sessionId, "#ready", 20_000), "ForgeWebridge extension did not observe #ready");
    await runtime.typeText(sessionId, "#name", "ForgeWebridge");
    await runtime.click(sessionId, "#go");
    const result = await runtime.extract(sessionId, "#result");
    assert(result.includes("Hello ForgeWebridge"), `ForgeWebridge tab interaction failed: ${result}`);
    const current = await runtime.currentPage(sessionId);
    assert(current.title.includes("ForgeWebridge Release"), `ForgeWebridge current_page returned wrong title: ${JSON.stringify(current)}`);
    const screenshot = await runtime.screenshot(sessionId);
    assert(screenshot.length > 100, "ForgeWebridge screenshot payload is too small");
    await runtime.closeTab(sessionId);

    return {
      detail: `gateway=${started.url}; chromeDebug=${chrome.cdpUrl}; screenshotChars=${screenshot.length}`,
      diagnostics: {
        extensionSourceDir,
        extensionDir,
        health: runtime.getHealth(),
      },
    };
  } finally {
    await stopPageServer(pageServer.server);
    await stopChrome(chrome);
    await started.shutdown();
  }
}

function prepareWebridgeExtensionForRelease(sourceDir: string, baseUrl: string): string {
  const dest = join(DATA_DIR, "webridge-extension", `${Date.now()}`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(sourceDir, dest, {
    recursive: true,
    force: true,
    dereference: false,
    filter: (source) => !source.includes(".DS_Store"),
  });
  ensureWebridgeManifestCompatibility(dest);
  patchWebridgeDefaults(dest, baseUrl);
  return dest;
}

function patchWebridgeDefaults(extensionDir: string, baseUrl: string): void {
  const backgroundPath = join(extensionDir, "background.js");
  if (!existsSync(backgroundPath)) return;
  let source = readFileSync(backgroundPath, "utf-8");
  source = source.replace(
    /const DEFAULT_BASE_URL = ["'][^"']+["'];/,
    `const DEFAULT_BASE_URL = ${JSON.stringify(baseUrl)};`,
  );
  source = source.replace(
    "if (current.autoDiscover === undefined) patch.autoDiscover = true;",
    "if (current.autoDiscover === undefined) patch.autoDiscover = false;",
  );
  writeFileSync(backgroundPath, source, "utf-8");
}

async function existingWebridgeOnline(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/discovery`);
    if (!res.ok) return false;
    const data = await res.json() as { app?: string; webridge?: { state?: string } };
    return data.app === "ForgeAgent" && data.webridge?.state === "online";
  } catch {
    return false;
  }
}

async function scenarioExistingWebridgeGateway(baseUrl: string): Promise<{ detail: string; diagnostics: Record<string, unknown> }> {
  const normalized = baseUrl.replace(/\/+$/, "");
  const pageServer = await startLocalPageServer();
  let sessionId = "";
  try {
    const pairing = await jsonRequest(normalized, "POST", "/auth/pairing-codes", {
      baseUrl: normalized,
      ttlMs: 300_000,
    });
    assert(pairing.status === 201, `Existing gateway pairing-code failed: ${pairing.status} ${JSON.stringify(pairing.body)}`);
    const code = (pairing.body as { code?: string }).code;
    assert(code, "Existing gateway did not return a pairing code");

    const paired = await jsonRequest(normalized, "POST", "/auth/pair", {
      code,
      name: "Release E2E Webridge",
      kind: "cli",
    });
    assert(paired.status === 201, `Existing gateway pair failed: ${paired.status} ${JSON.stringify(paired.body)}`);
    const token = (paired.body as { token?: string }).token;
    assert(token, "Existing gateway did not return device token");

    const created = await jsonRequest(normalized, "POST", "/sessions", {
      title: `${RUN_ID} existing ForgeWebridge`,
    }, token);
    assert(created.status === 201, `Existing gateway create session failed: ${created.status} ${JSON.stringify(created.body)}`);
    sessionId = (created.body as { id?: string }).id ?? "";
    assert(sessionId, "Existing gateway did not return session id");

    const danger = await jsonRequest(normalized, "PATCH", `/sessions/${sessionId}`, {
      dangerouslyAllowAllTools: true,
    }, token);
    assert(danger.status === 200, `Existing gateway danger mode failed: ${danger.status} ${JSON.stringify(danger.body)}`);

    const posted = await jsonRequest(normalized, "POST", `/sessions/${sessionId}/messages`, {
      text: [
        "This is a ForgeWebridge release gate. You must use the browser tools, not web_fetch.",
        "Call browser_create_tab.",
        `Call browser_navigate with url=${pageServer.url}/ .`,
        "Call browser_wait_for_selector for #ready.",
        "Call browser_type_text with selector #name and text ReleaseUser.",
        "Call browser_click with selector #go.",
        "Call browser_extract with selector #result.",
        "Then answer with exactly the prefix SOAK_WEBRIDGE_AGENT_OK and include the extracted result.",
      ].join(" "),
    }, token);
    assert(posted.status === 202, `Existing gateway post message failed: ${posted.status} ${JSON.stringify(posted.body)}`);

    await waitForHttpSessionStatus(normalized, token, sessionId, ["idle"], DEFAULT_WAIT_MS);
    const thread = await jsonRequest(normalized, "GET", `/sessions/${sessionId}/thread`, undefined, token);
    assert(thread.status === 200, `Existing gateway thread read failed: ${thread.status}`);
    const events = thread.body as SessionEvent[];
    assert(events.some((event) => event.type === "tool_call" && event.toolName === "browser_create_tab"), `Agent did not call browser_create_tab. Thread=${threadTypes(events)}`);
    assert(events.some((event) => event.type === "tool_call" && event.toolName === "browser_navigate"), `Agent did not call browser_navigate. Thread=${threadTypes(events)}`);
    assert(events.some((event) => event.type === "tool_result" && event.toolName === "browser_extract" && serialize((event as ToolResult).result).includes("Hello ReleaseUser")), "Browser extract did not return the page result");
    const answer = lastAssistantText(events);
    assert(answer.includes("SOAK_WEBRIDGE_AGENT_OK"), `Agent did not produce Webridge completion answer: ${answer}`);
    assertToolPairs(events);

    const discovery = await jsonRequest(normalized, "GET", "/discovery", undefined, token);
    return {
      detail: `existingGateway=${normalized}; session=${sessionId}; thread=${threadTypes(events)}`,
      diagnostics: {
        mode: "existing-gateway",
        discovery: discovery.body,
      },
    };
  } finally {
    await stopPageServer(pageServer.server);
    if (sessionId) {
      const token = await pairForCleanup(normalized).catch(() => "");
      if (token) await jsonRequest(normalized, "DELETE", `/sessions/${sessionId}`, undefined, token).catch(() => undefined);
    }
  }
}

async function pairForCleanup(baseUrl: string): Promise<string> {
  const pairing = await jsonRequest(baseUrl, "POST", "/auth/pairing-codes", {
    baseUrl,
    ttlMs: 60_000,
  });
  const code = (pairing.body as { code?: string }).code;
  if (!code) return "";
  const paired = await jsonRequest(baseUrl, "POST", "/auth/pair", {
    code,
    name: "Release E2E Cleanup",
    kind: "cli",
  });
  return (paired.body as { token?: string }).token ?? "";
}

async function waitForHttpSessionStatus(baseUrl: string, token: string, sessionId: string, statuses: string[], timeoutMs: number): Promise<void> {
  const startedAt = now();
  while (now() - startedAt < timeoutMs) {
    const res = await jsonRequest(baseUrl, "GET", `/sessions/${sessionId}`, undefined, token);
    if (res.status === 200) {
      const status = (res.body as { status?: string }).status;
      if (status && statuses.includes(status)) return;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for HTTP session ${sessionId} to reach ${statuses.join("/")}`);
}

async function startLocalPageServer(): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end([
      "<!doctype html>",
      "<html><head><title>ForgeWebridge Release Page</title></head>",
      "<body style='font-family:sans-serif;min-height:1200px'>",
      "<main id='ready'>ForgeWebridge release page ready</main>",
      "<input id='name' aria-label='name' />",
      "<button id='go' onclick=\"document.querySelector('#result').innerText='Hello '+document.querySelector('#name').value\">Go</button>",
      "<div id='result'></div>",
      "<a class='nav' href='/source-a'>Source A</a>",
      "</body></html>",
    ].join(""));
  });
  const port = await freePort();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${port}` };
}

async function stopPageServer(server: http.Server): Promise<void> {
  server.close();
  await once(server, "close").catch(() => undefined);
}

async function waitForWebridgeOnline(started: StartedHttpGateway, timeoutMs: number): Promise<void> {
  const startedAt = now();
  while (now() - startedAt < timeoutMs) {
    const health = started.api.getWebridgeRuntime()?.getHealth();
    if (health?.state === "online") return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ForgeWebridge extension to come online. Health=${JSON.stringify(started.api.getWebridgeRuntime()?.getHealth(), null, 2)}`);
}

function resolveExtensionBrowserPath(): string {
  const candidates = [
    process.env.RELEASE_WEBRIDGE_BROWSER_PATH,
    process.env.RELEASE_CHROME_FOR_TESTING_PATH,
    playwrightChromium.executablePath(),
    process.env.RELEASE_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    `${process.env.HOME ?? ""}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Extension-capable Chromium/Chrome binary not found. Run npx playwright install chromium or set RELEASE_WEBRIDGE_BROWSER_PATH.");
  return found;
}

async function startChromeWithExtension(name: string, extensionDir: string): Promise<ChromeHandle> {
  const port = Number(process.env.RELEASE_CHROME_DEBUGGING_PORT ?? await freePort());
  const profileDir = join(DATA_DIR, "chrome-profiles", `${name}-${Date.now()}`);
  mkdirSync(profileDir, { recursive: true });
  const executablePath = resolveExtensionBrowserPath();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--extensions-on-extension-urls",
    `--load-extension=${extensionDir}`,
    `--disable-extensions-except=${extensionDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    "about:blank",
  ];
  const child = spawn(executablePath, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stderr: string[] = [];
  child.stderr.on("data", (chunk) => {
    stderr.push(chunk.toString("utf-8"));
    while (stderr.length > 80) stderr.shift();
  });
  const cdpUrl = `http://127.0.0.1:${port}`;
  await waitForCdp(cdpUrl, 30_000);
  return { process: child, cdpUrl, port, profileDir, executablePath, stderr };
}

async function stopChrome(chrome: ChromeHandle): Promise<void> {
  if (!chrome.process.killed) {
    chrome.process.kill("SIGTERM");
    await Promise.race([
      once(chrome.process, "exit"),
      sleep(5_000).then(() => chrome.process.kill("SIGKILL")),
    ]).catch(() => undefined);
  }
}

async function waitForCdp(cdpUrl: string, timeoutMs: number): Promise<void> {
  const startedAt = now();
  while (now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`${cdpUrl}/json/version`);
      if (res.ok) return;
    } catch {
      // keep waiting
    }
    await sleep(250);
  }
  throw new Error(`Chrome CDP did not become ready at ${cdpUrl}`);
}

async function wakeWebridgeExtension(chrome: ChromeHandle, extensionDir: string): Promise<void> {
  const wsUrl = await resolveBrowserWsUrl(chrome.cdpUrl);
  const transport = await wsTransport(wsUrl);
  const client = new CdpClient(transport);
  try {
    await waitForExtensionServiceWorker(client, extensionDir, 30_000);
  } finally {
    client.close();
  }
}

async function seedWebridgeExtension(chrome: ChromeHandle, extensionDir: string, baseUrl: string): Promise<void> {
  const wsUrl = await resolveBrowserWsUrl(chrome.cdpUrl);
  const transport = await wsTransport(wsUrl);
  const client = new CdpClient(transport);
  try {
    const targetId = await waitForExtensionServiceWorker(client, extensionDir, 30_000);
    const attach = await client.send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string };
    const expression = `
      new Promise((resolve) => {
        chrome.storage.local.remove(["token", "clientId"], () => {
          chrome.storage.local.set({
            baseUrl: ${JSON.stringify(baseUrl)},
            enabled: true,
            autoDiscover: false,
            deviceName: "ForgeWebridge Release E2E"
          }, () => resolve(true));
        });
      })
    `;
    await client.send("Runtime.evaluate", { expression, awaitPromise: true }, attach.sessionId);
  } finally {
    client.close();
  }
}

async function readWebridgeExtensionDiagnostics(chrome: ChromeHandle, extensionDir: string): Promise<Record<string, unknown>> {
  const wsUrl = await resolveBrowserWsUrl(chrome.cdpUrl);
  const transport = await wsTransport(wsUrl);
  const client = new CdpClient(transport);
  try {
    const targets = await client.send("Target.getTargets") as { targetInfos?: Array<{ targetId: string; type: string; url: string; title?: string }> };
    let targetId = "";
    let workerError = "";
    try {
      targetId = await waitForExtensionServiceWorker(client, extensionDir, 1_000);
    } catch (err) {
      workerError = err instanceof Error ? err.message : String(err);
    }
    if (!targetId) {
      return {
        executablePath: chrome.executablePath,
        extensionDir,
        extensionPreferences: readExtensionPreferences(chrome.profileDir),
        targets: targets.targetInfos?.map((target) => ({ type: target.type, url: target.url, title: target.title })).filter((target) => (
          target.url.startsWith("chrome-extension://") || target.type === "service_worker"
        )),
        workerError,
        chromeStderrTail: chrome.stderr.slice(-40),
      };
    }
    const attach = await client.send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string };
    const evaluated = await client.send("Runtime.evaluate", {
      expression: "new Promise((resolve) => chrome.storage.local.get(null, resolve))",
      awaitPromise: true,
      returnByValue: true,
    }, attach.sessionId) as { result?: { value?: unknown; description?: string } };
    return {
      executablePath: chrome.executablePath,
      extensionDir,
      extensionPreferences: readExtensionPreferences(chrome.profileDir),
      targets: targets.targetInfos?.map((target) => ({ type: target.type, url: target.url, title: target.title })).filter((target) => (
        target.url.startsWith("chrome-extension://") || target.type === "service_worker"
      )),
      storage: evaluated.result?.value ?? evaluated.result?.description,
      chromeStderrTail: chrome.stderr.slice(-20),
    };
  } finally {
    client.close();
  }
}

function readExtensionPreferences(profileDir: string): unknown {
  try {
    const preferences = JSON.parse(readFileSync(join(profileDir, "Default", "Preferences"), "utf-8")) as {
      extensions?: { settings?: Record<string, unknown>; last_chrome_version?: string };
    };
    const settings = preferences.extensions?.settings ?? {};
    return Object.fromEntries(Object.entries(settings).map(([id, value]) => {
      const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const manifest = record.manifest && typeof record.manifest === "object" ? record.manifest as Record<string, unknown> : {};
      return [id, {
        path: record.path,
        state: record.state,
        location: record.location,
        disable_reasons: record.disable_reasons,
        manifest: {
          name: manifest.name,
          version: manifest.version,
          background: manifest.background,
        },
      }];
    }));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function resolveBrowserWsUrl(cdpUrl: string): Promise<string> {
  const res = await fetch(`${cdpUrl}/json/version`);
  if (!res.ok) throw new Error(`CDP version request failed: ${res.status} ${res.statusText}`);
  const data = await res.json() as { webSocketDebuggerUrl?: string };
  if (!data.webSocketDebuggerUrl) throw new Error("CDP version did not include webSocketDebuggerUrl");
  return data.webSocketDebuggerUrl;
}

async function waitForExtensionServiceWorker(client: CdpClient, extensionDir: string, timeoutMs: number): Promise<string> {
  await client.send("Target.setDiscoverTargets", { discover: true });
  const startedAt = now();
  const manifest = JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf-8")) as { name?: string };
  while (now() - startedAt < timeoutMs) {
    const targets = await client.send("Target.getTargets") as { targetInfos?: Array<{ targetId: string; type: string; url: string; title?: string }> };
    const worker = (targets.targetInfos ?? []).find((target) => (
      target.type === "service_worker" &&
      target.url.startsWith("chrome-extension://") &&
      target.url.endsWith("/background.js")
    ));
    if (worker) return worker.targetId;
    const pages = (targets.targetInfos ?? []).filter((target) => target.url.startsWith("chrome-extension://"));
    if (pages.length > 0) return pages[0]!.targetId;
    await sleep(250);
  }
  throw new Error(`Could not find ForgeWebridge extension service worker (${manifest.name ?? "unknown"}) in Chrome targets.`);
}

async function wsTransport(url: string): Promise<CdpTransport> {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("CDP WebSocket connection timed out"));
    }, 10_000);
    const transport: CdpTransport = {
      send(data: string): void { ws.send(data); },
      close(): void { ws.close(); },
      onMessage: null,
      onClose: null,
      onError: null,
    };
    ws.onopen = () => {
      clearTimeout(timer);
      ws.onerror = () => transport.onError?.(new Error("CDP WebSocket error"));
      resolvePromise(transport);
    };
    ws.onmessage = (event: MessageEvent<string>) => transport.onMessage?.(event.data);
    ws.onclose = () => transport.onClose?.();
  });
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolvePromise(address.port);
        else reject(new Error("Could not allocate a free port"));
      });
    });
    server.on("error", reject);
  });
}

function writeReports(report: ReleaseReport): { jsonPath: string; markdownPath: string } {
  mkdirSync(REPORT_DIR, { recursive: true });
  const jsonPath = join(REPORT_DIR, `${report.runId}.json`);
  const markdownPath = join(REPORT_DIR, `${report.runId}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  const lines = [
    `# ForgeAgent Release E2E ${report.runId}`,
    "",
    `- Provider: ${report.provider}${report.model ? ` / ${report.model}` : ""}`,
    `- Data dir: ${report.dataDir}`,
    `- Passed: ${report.results.filter((r) => r.ok).length}`,
    `- Failed: ${report.results.filter((r) => !r.ok).length}`,
    "",
    "| Scenario | Status | Duration | Detail |",
    "| --- | --- | ---: | --- |",
    ...report.results.map((result) => (
      `| ${result.name} | ${result.ok ? "PASS" : "FAIL"} | ${result.durationMs}ms | ${escapeMd(result.detail.split("\n")[0] ?? "")} |`
    )),
    "",
  ];
  for (const result of report.results.filter((item) => !item.ok)) {
    lines.push(`## Failure: ${result.name}`, "", "```text", result.detail, "```", "");
  }
  writeFileSync(markdownPath, lines.join("\n"), "utf-8");
  return { jsonPath, markdownPath };
}

function escapeMd(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

async function main(): Promise<void> {
  assert(providerConfigured(), "Release E2E requires .env or provider API key environment variables.");
  if (process.env.RELEASE_E2E_KEEP_DATA !== "1") {
    rmSync(DATA_DIR, { recursive: true, force: true });
  }
  mkdirSync(REPORT_DIR, { recursive: true });
  mkdirSync(WORKSPACE_DIR, { recursive: true });

  const ctx = setupCore();
  const providerMeta = ctx.provider.getMetadata?.();
  const selected = process.env.RELEASE_E2E_SCENARIOS
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const scenarios: Array<[string, () => Promise<string | { detail: string; diagnostics?: Record<string, unknown>; artifacts?: string[] }>]> = [
    ["core_provider_soak", () => scenarioChildSoak("soak:real", {
      SOAK_DATA_DIR: join(DATA_DIR, "soak-real"),
      SOAK_CYCLES: process.env.RELEASE_E2E_SOAK_CYCLES ?? "1",
      SOAK_PROVIDER: PROVIDER_KIND,
    })],
    ["browser_cdp_soak", () => scenarioChildSoak("soak:browser", {
      SOAK_BROWSER_DATA_DIR: join(DATA_DIR, "soak-browser"),
      SOAK_PROVIDER: PROVIDER_KIND,
    })],
    ["agent_coding_workspace", () => scenarioAgentCodingWorkspace(ctx)],
    ["agent_implementation_subagent", () => scenarioAgentImplementationSubagent(ctx)],
    ["agent_background_subagents", () => scenarioAgentBackgroundSubagents(ctx)],
    ["agent_subagent_worktree_merge", () => scenarioAgentSubagentWorktreeMerge(ctx)],
    ["agent_python_code_index", () => scenarioAgentPythonCodeIndex(ctx)],
    ["agent_persistent_multilanguage_lsp", () => scenarioAgentPersistentMultilanguageLsp(ctx)],
    ["agent_lsp_unavailable_recovery", () => scenarioAgentLspUnavailableRecovery(ctx)],
    ["agent_notebook_edit", () => scenarioAgentNotebookEdit(ctx)],
    ["agent_artifact_continuation", () => scenarioAgentArtifactContinuation(ctx)],
    ["agent_multifile_refactor", () => scenarioAgentMultiFileRefactor(ctx)],
    ["agent_frontend_workspace", () => scenarioAgentFrontendWorkspace(ctx)],
    ["agent_package_install_permission", () => scenarioAgentPackageInstallPermission(ctx)],
    ["agent_dynamic_skill_use", () => scenarioAgentDynamicSkillUse(ctx)],
    ["agent_destructive_command_denied", () => scenarioAgentDestructiveCommandDenied(ctx)],
    ["agent_compaction_coding_continuity", () => scenarioAgentCompactionCodingContinuity()],
    ["agent_restart_coding_continuity", () => scenarioAgentRestartCodingContinuity()],
    ["ui_review_work_activity", () => scenarioUiReviewWorkActivity()],
    ["real_mcp_external", () => scenarioRealMcp(ctx)],
    ["real_forgewebridge_extension", () => scenarioRealWebridge()],
  ];
  const runList = selected && selected.length > 0
    ? scenarios.filter(([name]) => selected.includes(name))
    : scenarios;
  assert(runList.length > 0, `No release E2E scenarios selected. Available: ${scenarios.map(([name]) => name).join(", ")}`);

  console.log(`[release-e2e] run=${RUN_ID} provider=${PROVIDER_KIND} dataDir=${DATA_DIR}`);
  const results: ScenarioResult[] = [];
  for (const [name, scenario] of runList) {
    const result = await runScenario(name, scenario);
    results.push(result);
    console.log(`[release-e2e] ${result.ok ? "PASS" : "FAIL"} ${result.name} ${result.durationMs}ms ${result.detail.split("\n")[0]}`);
    if (!result.ok && process.env.RELEASE_E2E_CONTINUE_ON_FAILURE !== "1") break;
  }

  await ctx.api.shutdown({ waitMs: 1_000 }).catch(() => undefined);
  const report: ReleaseReport = {
    runId: RUN_ID,
    startedAt: new Date().toISOString(),
    provider: providerMeta?.provider ?? PROVIDER_KIND,
    ...(providerMeta?.model !== undefined ? { model: providerMeta.model } : {}),
    dataDir: DATA_DIR,
    results,
  };
  const reportPaths = writeReports(report);
  const failed = results.filter((result) => !result.ok);
  console.log(`[release-e2e] report=${reportPaths.jsonPath}`);
  console.log(`[release-e2e] markdown=${reportPaths.markdownPath}`);
  console.log(`[release-e2e] summary pass=${results.length - failed.length} fail=${failed.length}`);
  if (failed.length > 0) {
    for (const failure of failed) {
      console.error(`[release-e2e] failure ${failure.name}\n${failure.detail}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
