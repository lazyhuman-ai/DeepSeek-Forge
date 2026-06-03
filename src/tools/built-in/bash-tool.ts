import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import type { ToolExecutionContext } from "../../agent/tool-executor.js";

const execPromise = promisify(exec);

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT_LENGTH = 30_000;

function truncateOutput(stdout: string, stderr: string): string {
  let result = "";
  if (stdout) {
    if (stdout.length > MAX_OUTPUT_LENGTH) {
      result += `[stdout truncated: ${stdout.length} chars, showing last ${MAX_OUTPUT_LENGTH}]\n`;
      result += stdout.slice(-MAX_OUTPUT_LENGTH);
    } else {
      result += stdout;
    }
  }
  if (stderr) {
    if (result) result += "\n";
    if (stderr.length > MAX_OUTPUT_LENGTH) {
      result += `[stderr truncated: ${stderr.length} chars, showing last ${MAX_OUTPUT_LENGTH}]\n`;
      result += stderr.slice(-MAX_OUTPUT_LENGTH);
    } else {
      result += stderr;
    }
  }
  return result || "(no output)";
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

async function handler(
  args: Record<string, unknown>,
  _sessionId: string,
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
    const child = exec(sandboxed.command, {
      cwd: context?.projectRoot ?? process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
      timeout: effectiveTimeout,
      signal: context?.signal,
    });

    child.on("error", () => {
      // silently ignore detached errors
    });

    return `Command started in background: ${description ?? command}`;
  }

  try {
    const { stdout, stderr } = await execPromise(sandboxed.command, {
      cwd: context?.projectRoot ?? process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
      timeout: effectiveTimeout,
      shell: "/bin/bash",
      signal: context?.signal,
    });

    return truncateOutput(stdout, stderr);
  } catch (error: unknown) {
    const err = error as Error & { stdout?: string; stderr?: string; killed?: boolean };
    if (err.name === "AbortError" || context?.signal?.aborted) {
      return "Command aborted.";
    }
    let message = `Command failed: ${err.message}`;
    if (err.killed) {
      message += "\n(command was killed, likely due to timeout)";
    }
    if (err.stdout || err.stderr) {
      message += "\n" + truncateOutput(err.stdout ?? "", err.stderr ?? "");
    }
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
  },
  handler,
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["process.exec", "fs.read", "fs.write"],
});
