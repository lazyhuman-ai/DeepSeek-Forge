import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import type { SessionEvent, ToolResult } from "../src/streams/event-types.js";
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
const DEFAULT_WAIT_MS = Number(process.env.RELEASE_E2E_WAIT_MS ?? "180000");
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
  api.onSessionEvent((sessionId, event) => {
    if (event.type !== "permission_request") return;
    const decision = autoResponses.get(sessionId) ?? "allow_once";
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

  return { api, registry, provider, dataDir: DATA_DIR, workspaceDir: WORKSPACE_DIR, autoResponses };
}

async function waitForSessionStatus(api: CoreAPI, sessionId: string, statuses: string[], timeoutMs = DEFAULT_WAIT_MS): Promise<void> {
  const started = now();
  while (now() - started < timeoutMs) {
    const status = api.getSession(sessionId)?.status;
    if (status && statuses.includes(status)) return;
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
  const agentTaskPass = events.find((event) => (
    event.type === "tool_result" &&
    event.toolName === "agent_task" &&
    event.isError !== true &&
    /VERDICT\s*:\s*PASS/i.test(String(event.result))
  ));
  assert(agentTaskPass, `agent_task verifier did not return VERDICT: PASS. Thread=${thread}`);
  const readyReview = events.find((event) => (
    event.type === "tool_result" &&
    event.toolName === "workspace_review" &&
    event.isError !== true &&
    /ready for final response/i.test(String(event.result))
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
      "The Python tests fail because src/pricing.py PriceCalculator.subtotal returns a comma-joined string instead of the numeric sum.",
      "You must call lsp_query to navigate this Python workspace, using the generic multi-language code index if TypeScript LSP is not available.",
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
  assert(called("lsp_query"), `Agent did not use lsp_query generic navigation. Thread=${thread}`);
  assert(events.some((event) => (
    event.type === "tool_result" &&
    event.toolName === "lsp_query" &&
    /generic (?:lexical )?code index|Generic code index/i.test(String(event.result))
  )), `lsp_query did not expose generic code index output. Thread=${thread}`);
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
    env: process.env,
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
    ["agent_python_code_index", () => scenarioAgentPythonCodeIndex(ctx)],
    ["agent_multifile_refactor", () => scenarioAgentMultiFileRefactor(ctx)],
    ["agent_frontend_workspace", () => scenarioAgentFrontendWorkspace(ctx)],
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
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
