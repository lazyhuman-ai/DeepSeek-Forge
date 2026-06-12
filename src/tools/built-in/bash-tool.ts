import { randomUUID } from "node:crypto";
import { exec, execSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import type { ToolExecutionContext } from "../../agent/tool-executor.js";
import type { Diagnostic } from "../../streams/event-types.js";
import { isSafeWorkspaceVerificationCommand } from "../../workspace/verification-commands.js";
import {
  appendShellTaskOutput,
  createShellTask,
  finishShellTask,
  markShellTaskStalled,
  snapshotShellTask,
} from "./shell-task-store.js";

const execPromise = promisify(exec);

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT_LENGTH = 120_000;
const DEFAULT_STALL_THRESHOLD_MS = 45_000;
const DEFAULT_AUTO_BACKGROUND_AFTER_MS = 15_000;
const STALL_TAIL_CHARS = 1_200;
const PROMPT_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\(yes\/no\)/i,
  /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\?\s*$/i,
  /Press (?:any key|Enter)/i,
  /Continue\?/i,
  /Overwrite\?/i,
  /(?:password|passphrase|token|otp|verification code)\s*:\s*$/i,
];

type BoundedCommandOutput = {
  display: string;
  diagnostic: string;
};

function truncateOutput(stdout: string, stderr: string): string {
  let result = "";
  if (stdout) {
    if (stdout.length > MAX_OUTPUT_LENGTH) {
      result += `[large stdout: ${stdout.length} chars; complete stdout follows and may be artifactized by DeepSeek-Forge]\n`;
      result += stdout;
    } else {
      result += stdout;
    }
  }
  if (stderr) {
    if (result) result += "\n";
    if (stderr.length > MAX_OUTPUT_LENGTH) {
      result += `[large stderr: ${stderr.length} chars; complete stderr follows and may be artifactized by DeepSeek-Forge]\n`;
      result += stderr;
    } else {
      result += stderr;
    }
  }
  return result || "(no output)";
}

function boundedCommandOutput(stdout: string, stderr = ""): BoundedCommandOutput {
  return {
    display: truncateOutput(stdout, stderr),
    diagnostic: [stdout, stderr].filter(Boolean).join("\n"),
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function seatbeltAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execSync("command -v sandbox-exec", {
      stdio: "ignore",
      shell: "/bin/bash",
      timeout: 1000,
    });
    return true;
  } catch {
    return false;
  }
}

function buildSeatbeltProfile(writeRoots: string[]): string {
  const writeRules = writeRoots
    .map((root) => `  (subpath ${JSON.stringify(root)})`)
    .join("\n");
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow network*)",
    "(allow file-read*)",
    "(allow file-write*",
    writeRules || "  (literal \"/dev/null\")",
    "  (literal \"/dev/null\")",
    "  (subpath \"/dev/fd\")",
    ")",
  ].join("\n");
}

function buildSandboxedCommand(
  command: string,
  context: ToolExecutionContext | undefined,
): { command: string; error?: string } {
  if (!context?.pathSandbox || context.bashSandboxMode === "disabled") {
    return { command };
  }

  const mode = context.bashSandboxMode ?? "best_effort";
  if (!seatbeltAvailable()) {
    if (mode === "enforce") {
      return {
        command,
        error: [
          "Tool sandbox blocked process execution.",
          "Tool: bash",
          "Requested action: process.exec",
          `Command: ${command}`,
          "Reason: Bash sandbox enforcement is unavailable on this platform or sandbox-exec is not installed.",
          "Recovery: Use dedicated read_file/write_file/edit_file tools, or ask the user to run this command in an environment with bash sandbox support.",
        ].join("\n"),
      };
    }
    return { command };
  }

  const profile = buildSeatbeltProfile(context.pathSandbox.allowedRoots("write"));
  return {
    command: `sandbox-exec -p ${shellQuote(profile)} /bin/bash -lc ${shellQuote(command)}`,
  };
}

function unwrapLeadingCd(command: string): string {
  const trimmed = command.trim();
  const match = /^cd\s+(?:"[^"]+"|'[^']+'|[^\s;&|]+)\s*&&\s*(.+)$/s.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

function normalizeVerificationCommand(command: string): string {
  return unwrapLeadingCd(command)
    .replace(/\s+2>\s*&1\s*$/u, "")
    .replace(/\s+2>\s*\/dev\/null\s*$/u, "")
    .trim();
}

function verificationCommand(command: string): boolean {
  const normalized = normalizeVerificationCommand(command);
  return isSafeWorkspaceVerificationCommand(normalized);
}

function outputSummary(output: string): string {
  const compact = output.replace(/\s+/g, " ").trim();
  if (!compact) return "(no output)";
  return compact.length <= 240 ? compact : `${compact.slice(0, 239).trim()}…`;
}

function safeSessionId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "session";
}

function shellTaskRoot(context: ToolExecutionContext | undefined, sessionId: string): string {
  const dataDir = context?.dataDir ?? join(context?.projectRoot ?? process.cwd(), ".forge");
  return join(dataDir, "shell-tasks", safeSessionId(sessionId));
}

function shellTaskStatePath(context: ToolExecutionContext | undefined, sessionId: string, taskId: string): string {
  return join(shellTaskRoot(context, sessionId), `${taskId}.json`);
}

function shellTaskOutputPath(context: ToolExecutionContext | undefined, sessionId: string, taskId: string): string {
  return join(shellTaskRoot(context, sessionId), `${taskId}.txt`);
}

function stallThresholdMs(): number {
  const raw = Number(process.env.FORGE_SHELL_STALL_MS);
  if (Number.isFinite(raw) && raw >= 100) return raw;
  return DEFAULT_STALL_THRESHOLD_MS;
}

function autoBackgroundAfterMs(args: Record<string, unknown>): number {
  if (args.auto_background_after_ms === false) return 0;
  if (typeof args.auto_background_after_ms === "number") {
    const value = Math.floor(args.auto_background_after_ms);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_AUTO_BACKGROUND_AFTER_MS;
  }
  const raw = Number(process.env.FORGE_SHELL_AUTO_BACKGROUND_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return DEFAULT_AUTO_BACKGROUND_AFTER_MS;
}

function looksLikePrompt(output: string): boolean {
  const tail = output.slice(-STALL_TAIL_CHARS);
  const lastLine = tail.trimEnd().split(/\r?\n/).pop() ?? "";
  return PROMPT_PATTERNS.some((pattern) => pattern.test(lastLine));
}

function startStallWatchdog(input: {
  taskId: string;
  sessionId: string;
  branchId?: string;
  command: string;
  description?: string;
  context?: ToolExecutionContext;
}): () => void {
  const threshold = stallThresholdMs();
  let lastLength = 0;
  let lastGrowth = Date.now();
  let notified = false;
  const interval = setInterval(() => {
    const task = snapshotShellTask(input.taskId);
    if (!task || task.status !== "running") {
      clearInterval(interval);
      return;
    }
    if (task.output.length > lastLength) {
      lastLength = task.output.length;
      lastGrowth = Date.now();
      return;
    }
    if (notified || Date.now() - lastGrowth < threshold || !looksLikePrompt(task.output)) return;
    notified = true;
    const warning = [
      `Background command appears to be waiting for interactive input: ${input.description ?? input.command}`,
      "Reason: output stopped changing and the latest output looks like a prompt.",
      "Recovery: use task_kill to stop this task, then rerun the command with a non-interactive flag, piped input, or ask_user for the missing information.",
    ].join("\n");
    const snapshot = markShellTaskStalled(input.taskId, warning);
    input.context?.workspaceActivity?.recordShellTask({
      sessionId: input.sessionId,
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      taskId: input.taskId,
      action: "output",
      command: input.command,
      status: "running",
      message: warning,
      ...(snapshot?.output ? { outputPreview: outputSummary(snapshot.output) } : {}),
    });
  }, Math.min(5_000, Math.max(100, Math.floor(threshold / 3))));
  interval.unref();
  return () => clearInterval(interval);
}

const TSC_DIAGNOSTIC_RE = /^(.*)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
const TSC_PRETTY_DIAGNOSTIC_RE = /^(.*):(\d+):(\d+)\s+-\s+(error|warning)\s+(TS\d+):\s+(.*)$/;

type WorkspaceChangeSnapshot = {
  root: string;
  raw: string;
  files: Set<string>;
};

function parseGitStatusFiles(raw: string): Set<string> {
  const files = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const pathPart = line.slice(3).trim();
    if (!pathPart) continue;
    const renameParts = pathPart.split(" -> ");
    for (const part of renameParts) {
      const cleaned = part.replace(/^"|"$/g, "");
      if (cleaned) files.add(cleaned);
    }
  }
  return files;
}

async function workspaceChangeSnapshot(
  context: ToolExecutionContext | undefined,
): Promise<WorkspaceChangeSnapshot | null> {
  const cwd = context?.projectRoot ?? process.cwd();
  try {
    const rootResult = await execPromise("git rev-parse --show-toplevel", {
      cwd,
      shell: "/bin/bash",
      timeout: 5_000,
      signal: context?.signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const root = rootResult.stdout.trim();
    if (!root) return null;
    const status = await execPromise("git status --porcelain=v1", {
      cwd: root,
      shell: "/bin/bash",
      timeout: 5_000,
      signal: context?.signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return {
      root,
      raw: status.stdout,
      files: parseGitStatusFiles(status.stdout),
    };
  } catch {
    return null;
  }
}

async function recordShellWorkspaceChanges(input: {
  before: WorkspaceChangeSnapshot | null;
  sessionId: string;
  branchId?: string;
  command: string;
  context?: ToolExecutionContext;
}): Promise<void> {
  if (!input.before || input.context?.signal?.aborted) return;
  const after = await workspaceChangeSnapshot(input.context);
  if (!after || after.root !== input.before.root || after.raw === input.before.raw) return;
  const files = new Set([...input.before.files, ...after.files]);
  input.context?.workspaceActivity?.recordActivity({
    sessionId: input.sessionId,
    ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
    activityKind: "change",
    status: "completed",
    title: "Shell command changed workspace",
    message: `Command changed git status for ${files.size} file(s): ${input.command}`,
    payload: {
      root: after.root,
      command: input.command,
      beforeDirtyFiles: input.before.files.size,
      afterDirtyFiles: after.files.size,
      files: [...files].slice(0, 80),
      truncated: files.size > 80,
    },
  });
}

function parseVerificationDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = TSC_DIAGNOSTIC_RE.exec(line) ?? TSC_PRETTY_DIAGNOSTIC_RE.exec(line);
    if (!match) continue;
    const filePath = match[1];
    const code = match[5];
    diagnostics.push({
      ...(filePath !== undefined ? { filePath } : {}),
      line: Number(match[2]),
      character: Number(match[3]),
      severity: match[4] === "warning" ? "warning" : "error",
      ...(code !== undefined ? { code } : {}),
      source: "bash-verification",
      message: match[6] ?? "",
    });
  }
  return diagnostics;
}

function shouldRecordTypeScriptDiagnostics(command: string): boolean {
  const normalized = normalizeVerificationCommand(command);
  return /\btsc\b/.test(normalized) || /\btypecheck\b/.test(normalized);
}

function shellExitCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function nonErrorExitExplanation(command: string, exitCode: number | undefined): string | null {
  if (exitCode !== 1) return null;
  const normalized = normalizeVerificationCommand(command);
  if (/^(?:grep|rg)(?:\s|$)/.test(normalized)) {
    return "Exit code 1 means no matches were found for this search command; the command itself ran successfully.";
  }
  if (/^git\s+diff\s+--(?:quiet|exit-code)(?:\s|$)/.test(normalized)) {
    return "Exit code 1 means git found differences; the command itself ran successfully.";
  }
  if (/^(?:diff|cmp)(?:\s|$)/.test(normalized)) {
    return "Exit code 1 means the compared inputs differ; the command itself ran successfully.";
  }
  return null;
}

function recordBashVerification(input: {
  sessionId: string;
  branchId?: string;
  command: string;
  status: "passed" | "failed";
  exitCode?: number;
  output: string;
  context?: ToolExecutionContext;
}): void {
  if (!verificationCommand(input.command)) return;
  if (shouldRecordTypeScriptDiagnostics(input.command)) {
    const diagnostics = parseVerificationDiagnostics(input.output);
    input.context?.workspaceActivity?.recordDiagnostics({
      sessionId: input.sessionId,
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      source: "bash-verification",
      diagnostics,
      failed: input.status === "failed" && diagnostics.length === 0,
      message: diagnostics.length > 0
        ? `${diagnostics.length} diagnostic(s) parsed from ${input.command}`
        : input.status === "passed"
          ? `${input.command} diagnostics are clean`
          : `No structured diagnostics could be parsed from ${input.command}`,
    });
  }
  input.context?.workspaceActivity?.recordVerification({
    sessionId: input.sessionId,
    ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
    command: input.command,
    status: input.status,
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    summary: outputSummary(input.output),
  });
}

function appendBoundedOutput(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > 10 * 1024 * 1024 ? next.slice(-(10 * 1024 * 1024)) : next;
}

function killChildProcessGroup(child: ReturnType<typeof spawn>): void {
  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall back to killing the child directly below.
    }
  }
  child.kill("SIGTERM");
}

async function runForegroundWithAutoBackground(input: {
  command: string;
  sandboxedCommand: string;
  effectiveTimeout: number;
  autoBackgroundAfterMs: number;
  description?: string;
  sessionId: string;
  context?: ToolExecutionContext;
}): Promise<unknown> {
  const beforeWorkspace = await workspaceChangeSnapshot(input.context);
  return await new Promise<unknown>((resolvePromise) => {
    let foregroundOutput = "";
    let taskId: string | undefined;
    let timedOut = false;
    let stopStallWatchdog: (() => void) | undefined;
    let resolved = false;
    const resolveOnce = (value: unknown): void => {
      if (resolved) return;
      resolved = true;
      resolvePromise(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/bin/bash", ["-lc", input.sandboxedCommand], {
        cwd: input.context?.projectRoot ?? process.cwd(),
        signal: input.context?.signal,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolveOnce({
        output: `Command failed to start: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      });
      return;
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      const timeoutMessage = `\n(command was killed after timeout ${input.effectiveTimeout}ms)`;
      if (taskId) appendShellTaskOutput(taskId, timeoutMessage);
      else foregroundOutput = appendBoundedOutput(foregroundOutput, timeoutMessage);
      killChildProcessGroup(child);
    }, input.effectiveTimeout);
    timeoutTimer.unref();

    const moveToBackground = (): void => {
      if (taskId || resolved) return;
      taskId = `task_${randomUUID().slice(0, 8)}`;
      createShellTask({
        taskId,
        sessionId: input.sessionId,
        ...(input.context?.branchId !== undefined ? { branchId: input.context?.branchId } : {}),
        command: input.command,
        ...(input.description !== undefined ? { description: input.description } : {}),
        outputFile: shellTaskOutputPath(input.context, input.sessionId, taskId),
        stateFile: shellTaskStatePath(input.context, input.sessionId, taskId),
        child,
      });
      if (foregroundOutput) appendShellTaskOutput(taskId, foregroundOutput);
      input.context?.workspaceActivity?.recordShellTask({
        sessionId: input.sessionId,
        ...(input.context?.branchId !== undefined ? { branchId: input.context?.branchId } : {}),
        taskId,
        action: "started",
        command: input.command,
        status: "running",
        message: `Foreground command moved to background after ${input.autoBackgroundAfterMs}ms: ${input.description ?? input.command}`,
        ...(foregroundOutput ? { outputPreview: outputSummary(foregroundOutput) } : {}),
      });
      stopStallWatchdog = startStallWatchdog({
        taskId,
        sessionId: input.sessionId,
        ...(input.context?.branchId !== undefined ? { branchId: input.context?.branchId } : {}),
        command: input.command,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.context !== undefined ? { context: input.context } : {}),
      });
      resolveOnce([
        `Command is still running and was moved to the background after ${input.autoBackgroundAfterMs}ms: ${input.description ?? input.command}`,
        `Task: ${taskId}`,
        `Output file: ${shellTaskOutputPath(input.context, input.sessionId, taskId)}`,
        "Use task_output with this task_id to inspect progress, or task_kill to stop it.",
      ].join("\n"));
    };

    const autoTimer = setTimeout(moveToBackground, input.autoBackgroundAfterMs);
    autoTimer.unref();

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      if (taskId) appendShellTaskOutput(taskId, text);
      else foregroundOutput = appendBoundedOutput(foregroundOutput, text);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      if (taskId) appendShellTaskOutput(taskId, text);
      else foregroundOutput = appendBoundedOutput(foregroundOutput, text);
    });

    child.on("error", (error) => {
      clearTimeout(autoTimer);
      clearTimeout(timeoutTimer);
      stopStallWatchdog?.();
      void recordShellWorkspaceChanges({
        before: beforeWorkspace,
        sessionId: input.sessionId,
        ...(input.context?.branchId !== undefined ? { branchId: input.context?.branchId } : {}),
        command: input.command,
        ...(input.context !== undefined ? { context: input.context } : {}),
      });
      if (taskId) {
        appendShellTaskOutput(taskId, `\n${error.message}`);
        const snapshot = finishShellTask(taskId, "failed");
        recordBashVerification({
          sessionId: input.sessionId,
          ...(input.context?.branchId !== undefined ? { branchId: input.context?.branchId } : {}),
          command: input.command,
          status: "failed",
          output: snapshot?.output ?? error.message,
          ...(input.context !== undefined ? { context: input.context } : {}),
        });
        input.context?.workspaceActivity?.recordShellTask({
          sessionId: input.sessionId,
          ...(input.context?.branchId !== undefined ? { branchId: input.context?.branchId } : {}),
          taskId,
          action: "failed",
          command: input.command,
          status: "failed",
          message: `Background command failed: ${error.message}`,
          ...(snapshot?.output ? { outputPreview: outputSummary(snapshot.output) } : {}),
        });
        return;
      }
      resolveOnce({ output: `Command failed: ${error.message}`, isError: true });
    });

    child.on("exit", (code, signal) => {
      clearTimeout(autoTimer);
      clearTimeout(timeoutTimer);
      stopStallWatchdog?.();
      void recordShellWorkspaceChanges({
        before: beforeWorkspace,
        sessionId: input.sessionId,
        ...(input.context?.branchId !== undefined ? { branchId: input.context?.branchId } : {}),
        command: input.command,
        ...(input.context !== undefined ? { context: input.context } : {}),
      });
      if (taskId) {
        const status = timedOut ? "failed" : signal === "SIGTERM" ? "killed" : code === 0 ? "completed" : "failed";
        const snapshot = finishShellTask(taskId, status, code ?? undefined);
        if (status === "completed" || status === "failed") {
          recordBashVerification({
            sessionId: input.sessionId,
            ...(input.context?.branchId !== undefined ? { branchId: input.context?.branchId } : {}),
            command: input.command,
            status: status === "completed" ? "passed" : "failed",
            ...(code !== null ? { exitCode: code } : {}),
            output: snapshot?.output ?? "",
            ...(input.context !== undefined ? { context: input.context } : {}),
          });
        }
        input.context?.workspaceActivity?.recordShellTask({
          sessionId: input.sessionId,
          ...(input.context?.branchId !== undefined ? { branchId: input.context?.branchId } : {}),
          taskId,
          action: status === "completed" ? "completed" : status,
          command: input.command,
          status,
          message: timedOut
            ? `Background command failed after timeout: ${input.description ?? input.command}`
            : `Background command ${status}: ${input.description ?? input.command}`,
          ...(snapshot?.output ? { outputPreview: outputSummary(snapshot.output) } : {}),
          ...(code !== null ? { exitCode: code } : {}),
        });
        return;
      }

      const output = boundedCommandOutput(foregroundOutput, "");
      const exitCode = code ?? undefined;
      if (timedOut || signal) {
        recordBashVerification({
          sessionId: input.sessionId,
          ...(input.context?.branchId !== undefined ? { branchId: input.context?.branchId } : {}),
          command: input.command,
          status: "failed",
          ...(exitCode !== undefined ? { exitCode } : {}),
          output: output.diagnostic,
          ...(input.context !== undefined ? { context: input.context } : {}),
        });
        resolveOnce({
          output: `Command failed: command was ${timedOut ? "killed after timeout" : `terminated by signal ${signal}`}.\n${output.display}`,
          isError: true,
        });
        return;
      }
      if (code === 0) {
        recordBashVerification({
          sessionId: input.sessionId,
          ...(input.context?.branchId !== undefined ? { branchId: input.context?.branchId } : {}),
          command: input.command,
          status: "passed",
          exitCode: 0,
          output: output.diagnostic,
          ...(input.context !== undefined ? { context: input.context } : {}),
        });
        resolveOnce(output.display);
        return;
      }
      const semantic = nonErrorExitExplanation(input.command, exitCode);
      if (semantic && !verificationCommand(input.command)) {
        resolveOnce(`${semantic}\n${output.display}`);
        return;
      }
      if (verificationCommand(input.command)) {
        recordBashVerification({
          sessionId: input.sessionId,
          ...(input.context?.branchId !== undefined ? { branchId: input.context?.branchId } : {}),
          command: input.command,
          status: "failed",
          ...(exitCode !== undefined ? { exitCode } : {}),
          output: output.diagnostic,
          ...(input.context !== undefined ? { context: input.context } : {}),
        });
      }
      resolveOnce({
        output: `Command failed: exit code ${code ?? "unknown"}.\n${output.display}`,
        isError: true,
      });
    });
  });
}

async function handler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  const command = args.command as string;
  const timeout = (args.timeout as number) ?? DEFAULT_TIMEOUT;
  const description = args.description as string | undefined;
  const runInBackground = (args.run_in_background as boolean) ?? false;

  const effectiveTimeout = Math.min(timeout, MAX_TIMEOUT);

  if (context?.signal?.aborted) {
    return "Command aborted.";
  }

  const sandboxed = buildSandboxedCommand(command, context);
  if (sandboxed.error) return { output: sandboxed.error, isError: true };

  if (runInBackground) {
    const taskId = `task_${randomUUID().slice(0, 8)}`;
    const beforeWorkspace = await workspaceChangeSnapshot(context);
    const child = spawn("/bin/bash", ["-lc", sandboxed.command], {
      cwd: context?.projectRoot ?? process.cwd(),
      signal: context?.signal,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      appendShellTaskOutput(taskId, `\n(command was killed after timeout ${effectiveTimeout}ms)`);
      if (typeof child.pid === "number") {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      } else {
        child.kill("SIGTERM");
      }
    }, effectiveTimeout);
    timeoutTimer.unref();

    createShellTask({
      taskId,
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      command,
      ...(description !== undefined ? { description } : {}),
      outputFile: shellTaskOutputPath(context, sessionId, taskId),
      stateFile: shellTaskStatePath(context, sessionId, taskId),
      child,
    });
    context?.workspaceActivity?.recordShellTask({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      taskId,
      action: "started",
      command,
      status: "running",
      message: `Background command started: ${description ?? command}`,
    });
    const stopStallWatchdog = startStallWatchdog({
      taskId,
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      command,
      ...(description !== undefined ? { description } : {}),
      ...(context !== undefined ? { context } : {}),
    });

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      appendShellTaskOutput(taskId, text);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      appendShellTaskOutput(taskId, text);
    });
    child.on("error", (error) => {
      clearTimeout(timeoutTimer);
      stopStallWatchdog();
      void recordShellWorkspaceChanges({
        before: beforeWorkspace,
        sessionId,
        ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
        command,
        ...(context !== undefined ? { context } : {}),
      });
      appendShellTaskOutput(taskId, `\n${error.message}`);
      const snapshot = finishShellTask(taskId, "failed");
      recordBashVerification({
        sessionId,
        ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
        command,
        status: "failed",
        output: snapshot?.output ?? error.message,
        ...(context !== undefined ? { context } : {}),
      });
      context?.workspaceActivity?.recordShellTask({
        sessionId,
        ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
        taskId,
        action: "failed",
        command,
        status: "failed",
        message: `Background command failed: ${error.message}`,
        ...(snapshot?.output ? { outputPreview: outputSummary(snapshot.output) } : {}),
      });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeoutTimer);
      stopStallWatchdog();
      void recordShellWorkspaceChanges({
        before: beforeWorkspace,
        sessionId,
        ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
        command,
        ...(context !== undefined ? { context } : {}),
      });
      const status = timedOut ? "failed" : signal === "SIGTERM" ? "killed" : code === 0 ? "completed" : "failed";
      const snapshot = finishShellTask(taskId, status, code ?? undefined);
      if (status === "completed" || status === "failed") {
        recordBashVerification({
          sessionId,
          ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
          command,
          status: status === "completed" ? "passed" : "failed",
          ...(code !== null ? { exitCode: code } : {}),
          output: snapshot?.output ?? "",
          ...(context !== undefined ? { context } : {}),
        });
      }
      context?.workspaceActivity?.recordShellTask({
        sessionId,
        ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
        taskId,
        action: status === "completed" ? "completed" : status,
        command,
        status,
        message: timedOut
          ? `Background command failed after timeout: ${description ?? command}`
          : `Background command ${status}: ${description ?? command}`,
        ...(snapshot?.output ? { outputPreview: outputSummary(snapshot.output) } : {}),
        ...(code !== null ? { exitCode: code } : {}),
      });
    });

    return [
      `Command started in background: ${description ?? command}`,
      `Task: ${taskId}`,
      `Output file: ${shellTaskOutputPath(context, sessionId, taskId)}`,
      "Use task_output with task_id to read output, or task_kill to stop it.",
    ].join("\n");
  }

  const autoBackgroundMs = autoBackgroundAfterMs(args);
  if (autoBackgroundMs > 0) {
    return await runForegroundWithAutoBackground({
      command,
      sandboxedCommand: sandboxed.command,
      effectiveTimeout,
      autoBackgroundAfterMs: autoBackgroundMs,
      ...(description !== undefined ? { description } : {}),
      sessionId,
      ...(context !== undefined ? { context } : {}),
    });
  }

  const beforeWorkspace = await workspaceChangeSnapshot(context);
  try {
    const { stdout, stderr } = await execPromise(sandboxed.command, {
      cwd: context?.projectRoot ?? process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
      timeout: effectiveTimeout,
      shell: "/bin/bash",
      signal: context?.signal,
    });

    const output = boundedCommandOutput(stdout, stderr);
    recordBashVerification({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      command,
      status: "passed",
      exitCode: 0,
      output: output.diagnostic,
      ...(context !== undefined ? { context } : {}),
    });
    await recordShellWorkspaceChanges({
      before: beforeWorkspace,
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      command,
      ...(context !== undefined ? { context } : {}),
    });
    return output.display;
  } catch (error: unknown) {
    const err = error as Error & { stdout?: string; stderr?: string; killed?: boolean };
    if (err.name === "AbortError" || context?.signal?.aborted) {
      return "Command aborted.";
    }
    const semantic = nonErrorExitExplanation(command, shellExitCode(error));
    if (semantic && !verificationCommand(command)) {
      const output = boundedCommandOutput(err.stdout ?? "", err.stderr ?? "");
      return `${semantic}\n${output.display}`;
    }
    let message = `Command failed: ${err.message}`;
    if (err.killed) {
      message += "\n(command was killed, likely due to timeout)";
    }
    if (err.stdout || err.stderr) {
      message += "\n" + boundedCommandOutput(err.stdout ?? "", err.stderr ?? "").display;
    }
    if (verificationCommand(command)) {
      const diagnosticOutput = [
        `Command failed: ${err.message}`,
        err.killed ? "(command was killed, likely due to timeout)" : "",
        err.stdout ?? "",
        err.stderr ?? "",
      ].filter(Boolean).join("\n");
      recordBashVerification({
        sessionId,
        ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
        command,
        status: "failed",
        ...(shellExitCode(error) !== undefined ? { exitCode: shellExitCode(error)! } : {}),
        output: diagnosticOutput,
        ...(context !== undefined ? { context } : {}),
      });
    }
    await recordShellWorkspaceChanges({
      before: beforeWorkspace,
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      command,
      ...(context !== undefined ? { context } : {}),
    });
    return { output: message, isError: true };
  }
}

export const bashTool: ExecutableToolDefinition = buildTool({
  name: "bash",
  description: `Executes a given bash command and returns its output.

The working directory persists between commands, but shell state does not.

Usage:
- Use the read_file tool (not cat), write_file/edit_file (not sed/awk), glob (not find), grep (not grep/rg) when dedicated tools exist.
- Always quote file paths that contain spaces.
- Use absolute paths where possible.
- For long-running commands, set run_in_background to true and use glob/grep/bash to check results later.
- NEVER use git reset --hard, git push --force, or skip hooks (--no-verify) unless the user explicitly requests them.
- Prefer creating new commits over amending existing ones.`,
  params: {
    command: {
      type: "string",
      description: "The bash command to execute",
    },
    timeout: {
      type: "number",
      description: `Optional timeout in milliseconds (max ${MAX_TIMEOUT}ms)`,
      optional: true,
    },
    description: {
      type: "string",
      description: "Clear, concise description of what this command does",
      optional: true,
    },
    run_in_background: {
      type: "boolean",
      description: "Set to true to run this command in the background",
      optional: true,
    },
    auto_background_after_ms: {
      type: "number",
      description: `Move a foreground command to a background shell task if it is still running after this many milliseconds. Set to 0 to disable for this call. Defaults to ${DEFAULT_AUTO_BACKGROUND_AFTER_MS}ms.`,
      optional: true,
    },
  },
  handler,
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["process.exec", "fs.read", "fs.write"],
});
