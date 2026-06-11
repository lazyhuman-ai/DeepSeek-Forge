import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolExecutionContext } from "../../agent/tool-executor.js";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_BYTES = 120_000;
const MAX_BYTES = 500_000;

async function git(projectRoot: string, args: string[], signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: projectRoot,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      signal,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "true",
        SSH_ASKPASS: "true",
      },
    });
    return stdout.trimEnd();
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string };
    const output = `${err.stdout ?? ""}${err.stderr ? `\n${err.stderr}` : ""}`.trim();
    if (output) return output;
    throw error;
  }
}

function clampMaxBytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_BYTES;
  return Math.min(Math.floor(value), MAX_BYTES);
}

function truncate(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.byteLength <= maxBytes) return text;
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n\n[git diff truncated: ${buffer.byteLength} bytes total, showing first ${maxBytes} bytes]`;
}

async function handler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  const projectRoot = context?.projectRoot ?? process.cwd();
  const includePatch = args.patch !== false;
  const includeUntracked = args.include_untracked !== false;
  const maxBytes = clampMaxBytes(args.max_bytes);
  try {
    const root = await git(projectRoot, ["rev-parse", "--show-toplevel"], context?.signal);
    const status = await git(root, ["status", "--short"], context?.signal);
    const stat = await git(root, ["diff", "--stat", "--find-renames"], context?.signal);
    const nameStatus = await git(root, ["diff", "--name-status", "--find-renames"], context?.signal);
    const untracked = includeUntracked
      ? await git(root, ["ls-files", "--others", "--exclude-standard"], context?.signal)
      : "";
    const patch = includePatch
      ? await git(root, ["diff", "--find-renames", "--no-ext-diff", "--unified=3"], context?.signal)
      : "";
    const changedCount = status.split(/\r?\n/).filter(Boolean).length;
    context?.workspaceActivity?.recordActivity({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      activityKind: "analysis",
      status: changedCount > 0 ? "info" : "completed",
      title: "Git workspace diff",
      message: changedCount > 0 ? `${changedCount} changed file(s)` : "Working tree is clean",
      payload: {
        root,
        changedCount,
      },
    });
    return truncate([
      `Git root: ${root}`,
      "",
      "Status:",
      status || "(clean)",
      "",
      "Changed files:",
      nameStatus || "(none)",
      "",
      includeUntracked ? "Untracked files:" : "",
      includeUntracked ? (untracked || "(none)") : "",
      "",
      "Diff stat:",
      stat || "(no tracked diff)",
      "",
      includePatch ? "Patch:" : "",
      includePatch ? (patch || "(no tracked patch)") : "",
    ].filter((part) => part !== "").join("\n"), maxBytes);
  } catch (error) {
    if (context?.signal?.aborted) return "Git diff aborted.";
    return {
      output: `Unable to inspect git diff in ${projectRoot}: ${(error as Error).message}`,
      isError: true,
    };
  }
}

export const gitDiffTool: ExecutableToolDefinition = buildTool({
  name: "git_diff",
  description: "Inspects current git status, changed files, diff stat, untracked files, and an optional bounded patch for workspace review.",
  params: {
    patch: {
      type: "boolean",
      description: "Include a bounded unified patch. Defaults to true.",
      optional: true,
    },
    include_untracked: {
      type: "boolean",
      description: "Include untracked file names. Defaults to true.",
      optional: true,
    },
    max_bytes: {
      type: "number",
      description: `Maximum bytes of git review output, capped at ${MAX_BYTES}.`,
      optional: true,
    },
  },
  handler,
  isConcurrencySafe: true,
  isReadOnly: true,
  capabilities: ["fs.read"],
});
