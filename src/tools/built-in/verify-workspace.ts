import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ToolExecutionContext } from "../../agent/tool-executor.js";
import type { Diagnostic } from "../../streams/event-types.js";
import {
  detectWorkspaceVerificationCommands,
  isSafeWorkspaceVerificationCommand,
  type VerificationLevel,
} from "../../workspace/verification-commands.js";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";

const execPromise = promisify(exec);

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_COMMANDS = 5;
const MAX_OUTPUT_LENGTH = 20_000;

const TSC_DIAGNOSTIC_RE = /^(.*)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
const TSC_PRETTY_DIAGNOSTIC_RE = /^(.*):(\d+):(\d+)\s+-\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
const GENERIC_DIAGNOSTIC_RE = /^(.+\.(?:ts|tsx|js|jsx|py|go|rs|swift|java|kt|cs)):(\d+):(?:(\d+):)?\s+(?:(error|warning|note|info)[:\s-]+)?(.+)$/;

type CommandRun = {
  command: string;
  status: "passed" | "failed";
  exitCode?: number;
  output: string;
};

function outputSummary(output: string): string {
  const compact = output.replace(/\s+/g, " ").trim();
  if (!compact) return "(no output)";
  return compact.length <= 240 ? compact : `${compact.slice(0, 239).trim()}…`;
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) return output || "(no output)";
  return `[output truncated: ${output.length} chars, showing last ${MAX_OUTPUT_LENGTH}]\n${output.slice(-MAX_OUTPUT_LENGTH)}`;
}

function shellExitCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function parseVerificationDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = TSC_DIAGNOSTIC_RE.exec(line) ?? TSC_PRETTY_DIAGNOSTIC_RE.exec(line);
    if (match) {
      const filePath = match[1];
      const code = match[5];
      diagnostics.push({
        ...(filePath !== undefined ? { filePath } : {}),
        line: Number(match[2]),
        character: Number(match[3]),
        severity: match[4] === "warning" ? "warning" : "error",
        ...(code !== undefined ? { code } : {}),
        source: "verify-workspace",
        message: match[6] ?? "",
      });
      continue;
    }

    const generic = GENERIC_DIAGNOSTIC_RE.exec(line);
    if (!generic) continue;
    const filePath = generic[1];
    if (!filePath) continue;
    const severity = generic[4] === "warning"
      ? "warning"
      : generic[4] === "note" || generic[4] === "info"
        ? "info"
        : "error";
    diagnostics.push({
      filePath,
      line: Number(generic[2]),
      ...(generic[3] !== undefined ? { character: Number(generic[3]) } : {}),
      severity,
      source: "verify-workspace",
      message: generic[5] ?? "",
    });
  }
  return diagnostics;
}

function shouldRecordTypeScriptDiagnostics(command: string): boolean {
  return /\b(?:tsc|typecheck|pytest|mypy|pyright|ruff|cargo|go|swift|mvn|gradle|dotnet|make)\b/.test(command);
}

function commandList(args: Record<string, unknown>): string[] {
  const raw = args.commands;
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function verificationLevel(value: unknown): VerificationLevel {
  return value === "standard" || value === "full" ? value : "quick";
}

async function runCommand(
  command: string,
  projectRoot: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<CommandRun> {
  try {
    const { stdout, stderr } = await execPromise(command, {
      cwd: projectRoot,
      shell: "/bin/bash",
      timeout,
      signal,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      command,
      status: "passed",
      exitCode: 0,
      output: truncateOutput([stdout, stderr].filter(Boolean).join("\n")),
    };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string; killed?: boolean };
    const output = [
      `Command failed: ${err.message}`,
      err.killed ? "(command was killed, likely due to timeout)" : "",
      err.stdout ?? "",
      err.stderr ?? "",
    ].filter(Boolean).join("\n");
    return {
      command,
      status: "failed",
      ...(shellExitCode(error) !== undefined ? { exitCode: shellExitCode(error)! } : {}),
      output: truncateOutput(output),
    };
  }
}

async function handler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  const projectRoot = context?.projectRoot ?? process.cwd();
  const level = verificationLevel(args.level);
  const timeout = Math.min(typeof args.timeout === "number" ? args.timeout : DEFAULT_TIMEOUT, MAX_TIMEOUT);
  const commands = commandList(args).length > 0
    ? commandList(args).slice(0, MAX_COMMANDS)
    : await detectWorkspaceVerificationCommands(projectRoot, level);

  if (commands.length === 0) {
    const message = [
      "Workspace verification could not find a safe project check to run automatically.",
      `Project: ${projectRoot}`,
      "Reason: no recognized package script or language-native test/check target was found.",
      "Recovery: Add a test/typecheck/check/build/lint script, or call bash with a specific verification command if the user approves it.",
    ].join("\n");
    context?.workspaceActivity?.recordVerification({
      sessionId,
      ...(context.branchId !== undefined ? { branchId: context.branchId } : {}),
      command: "verify_workspace:auto-detect",
      status: "failed",
      summary: "No safe verification command detected.",
    });
    return { output: message, isError: true };
  }

  const unsafe = commands.filter((command) => !isSafeWorkspaceVerificationCommand(command));
  if (unsafe.length > 0) {
    return {
      isError: true,
      output: [
        "Workspace verification refused to run unsafe command(s).",
        ...unsafe.map((command) => `Command: ${command}`),
        "Reason: verify_workspace only runs recognized test/typecheck/check/build/lint commands without shell expansion, redirection, pipes, or package installation.",
        "Recovery: Use bash and ask the user for approval if this command is genuinely required.",
      ].join("\n"),
    };
  }

  if (context?.signal?.aborted) return "Workspace verification aborted.";

  const results: CommandRun[] = [];
  for (const command of commands) {
    context?.workspaceActivity?.recordVerification({
      sessionId,
      ...(context.branchId !== undefined ? { branchId: context.branchId } : {}),
      command,
      status: "running",
      summary: "Verification command started.",
    });
    const result = await runCommand(command, projectRoot, timeout, context?.signal);
    results.push(result);
    if (shouldRecordTypeScriptDiagnostics(command)) {
      const diagnostics = parseVerificationDiagnostics(result.output);
      context?.workspaceActivity?.recordDiagnostics({
        sessionId,
        ...(context.branchId !== undefined ? { branchId: context.branchId } : {}),
        source: "verify-workspace",
        diagnostics,
        failed: result.status === "failed" && diagnostics.length === 0,
        message: diagnostics.length > 0
          ? `${diagnostics.length} diagnostic(s) parsed from ${command}`
          : result.status === "passed"
            ? `${command} diagnostics are clean`
            : `No structured diagnostics could be parsed from ${command}`,
      });
    }
    context?.workspaceActivity?.recordVerification({
      sessionId,
      ...(context.branchId !== undefined ? { branchId: context.branchId } : {}),
      command,
      status: result.status,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      summary: outputSummary(result.output),
    });
  }

  const failed = results.filter((result) => result.status === "failed");
  const lines = [
    `Workspace verification: ${failed.length === 0 ? "passed" : "failed"}`,
    `Project: ${projectRoot}`,
    "",
    ...results.flatMap((result) => [
      `## ${result.command}`,
      `Status: ${result.status}${result.exitCode !== undefined ? ` (exit ${result.exitCode})` : ""}`,
      "Output:",
      result.output,
      "",
    ]),
  ];

  const output = lines.join("\n").trim();
  return failed.length === 0 ? output : { output, isError: true };
}

export const verifyWorkspaceTool: ExecutableToolDefinition = buildTool({
  name: "verify_workspace",
  description: "Runs detected safe workspace verification commands such as test, typecheck, lint, build, check, cargo/go/python/swift/dotnet checks, or explicit safe commands. Records verification and diagnostic events for workspace review.",
  params: {
    commands: {
      type: "array",
      description: "Optional explicit safe verification commands. If omitted, ForgeAgent detects a quick project check from package.json.",
      items: {
        type: "string",
        description: "A safe verification command.",
      },
      optional: true,
    },
    level: {
      type: "string",
      description: "quick, standard, or full. Used only when commands are omitted. Defaults to quick.",
      optional: true,
    },
    timeout: {
      type: "number",
      description: `Per-command timeout in milliseconds (max ${MAX_TIMEOUT}ms).`,
      optional: true,
    },
  },
  handler,
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["process.exec", "fs.read"],
});
