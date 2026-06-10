import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ToolExecutionContext } from "../../agent/tool-executor.js";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { PathSandbox } from "../../sandbox/path-sandbox.js";

const execFileAsync = promisify(execFile);

function safeBranchName(value: string): string {
  return value.replace(/[^A-Za-z0-9._/-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "forge-work";
}

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "true",
  SSH_ASKPASS: "true",
};

async function git(projectRoot: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: projectRoot,
    timeout: 60_000,
    signal,
    env: GIT_ENV,
  });
  return stdout.trim();
}

async function ensureGitRepo(projectRoot: string, signal?: AbortSignal): Promise<string> {
  const root = await git(projectRoot, ["rev-parse", "--show-toplevel"], signal);
  return resolve(root);
}

async function validateBranchName(projectRoot: string, branch: string, signal?: AbortSignal): Promise<string | null> {
  if (branch.startsWith("-") || branch.includes("..") || branch.includes("@{") || branch.endsWith(".lock")) {
    return "Branch name contains a git-ref unsafe sequence.";
  }
  try {
    await git(projectRoot, ["check-ref-format", "--branch", branch], signal);
    return null;
  } catch {
    return `Invalid git branch name: ${branch}`;
  }
}

async function branchExists(projectRoot: string, branch: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await git(projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], signal);
    return true;
  } catch {
    return false;
  }
}

function existingGitWorktree(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isDirectory() && existsSync(join(path, ".git"));
  } catch {
    return false;
  }
}

type WorktreeRemovalCheck =
  | { ok: true }
  | { ok: false; reason: string; recovery: string; changedFiles?: string[] };

async function checkWorktreeCanBeRemoved(path: string, signal?: AbortSignal): Promise<WorktreeRemovalCheck> {
  if (!existsSync(path)) {
    return {
      ok: false,
      reason: `Worktree path does not exist: ${path}`,
      recovery: "Use keep=true to record that the worktree is no longer available, or provide the correct worktree path.",
    };
  }
  try {
    const inside = await git(path, ["rev-parse", "--is-inside-work-tree"], signal);
    if (inside !== "true") {
      return {
        ok: false,
        reason: `Path is not a git worktree: ${path}`,
        recovery: "Use keep=true if this path should be preserved, or provide a valid ForgeAgent worktree path.",
      };
    }
    const topLevel = resolve(await git(path, ["rev-parse", "--show-toplevel"], signal));
    if (topLevel !== resolve(path)) {
      return {
        ok: false,
        reason: `Path is inside git repository ${topLevel}, but it is not the worktree root: ${path}`,
        recovery: "Provide the exact worktree root path, or use keep=true to preserve this directory.",
      };
    }
    const porcelain = await git(path, ["status", "--porcelain"], signal);
    const changedFiles = porcelain
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (changedFiles.length > 0) {
      return {
        ok: false,
        reason: `Worktree has ${changedFiles.length} uncommitted or untracked file(s).`,
        recovery: "Review the changes, run git_diff if needed, then call exit_worktree with keep=true to preserve the worktree or discard_changes=true only after the user explicitly agrees to lose these changes.",
        changedFiles: changedFiles.slice(0, 20),
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `Could not verify worktree state for ${path}: ${error instanceof Error ? error.message : String(error)}`,
      recovery: "ForgeAgent refuses to remove an unverified worktree. Use keep=true to preserve it, or fix the git worktree state and retry.",
    };
  }
}

async function enterHandler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  const projectRoot = context?.projectRoot ?? process.cwd();
  const branch = safeBranchName(typeof args.branch === "string" ? args.branch : `forge/${sessionId.slice(0, 8)}`);
  const worktreePath = resolve(
    typeof args.path === "string" && args.path.trim()
      ? args.path
      : join(dirname(projectRoot), `${basename(projectRoot)}.worktrees`, branch.replace(/\//g, "_")),
  );
  try {
    const repoRoot = await ensureGitRepo(projectRoot, context?.signal);
    const branchError = await validateBranchName(repoRoot, branch, context?.signal);
    if (branchError) return { output: branchError, isError: true };
    if (resolve(worktreePath) === repoRoot || resolve(worktreePath).startsWith(join(repoRoot, ".git"))) {
      return { output: "Worktree path cannot be the main repository root or inside .git.", isError: true };
    }
    if (existingGitWorktree(worktreePath)) {
      context?.workspaceActivity?.recordWorktree({
        sessionId,
        ...(context?.branchId !== undefined ? { branchId: context.branchId } : {}),
        action: "entered",
        path: worktreePath,
        branch,
        message: `Worktree resumed: ${worktreePath} (${branch})`,
      });
      if (context) {
        context.projectRoot = worktreePath;
        context.pathSandbox = new PathSandbox({ projectRoot: worktreePath });
      }
      return `Worktree resumed: ${worktreePath}\nBranch: ${branch}`;
    }
    mkdirSync(dirname(worktreePath), { recursive: true });
    const addArgs = await branchExists(repoRoot, branch, context?.signal)
      ? ["worktree", "add", worktreePath, branch]
      : ["worktree", "add", "-b", branch, worktreePath, "HEAD"];
    await git(repoRoot, addArgs, context?.signal);
    context?.workspaceActivity?.recordWorktree({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context.branchId } : {}),
      action: "entered",
      path: worktreePath,
      branch,
      message: `Worktree created: ${worktreePath} (${branch})`,
    });
    if (context) {
      context.projectRoot = worktreePath;
      context.pathSandbox = new PathSandbox({ projectRoot: worktreePath });
    }
    return `Worktree created: ${worktreePath}\nBranch: ${branch}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context?.workspaceActivity?.recordWorktree({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context.branchId } : {}),
      action: "failed",
      path: worktreePath,
      branch,
      message,
    });
    return { output: `Failed to create worktree: ${message}`, isError: true };
  }
}

async function exitHandler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  const path = typeof args.path === "string" ? resolve(args.path) : "";
  if (!path) return { output: "path is required.", isError: true };
  const keep = args.keep === true;
  const discardChanges = args.discard_changes === true;
  try {
    if (!keep && existsSync(path)) {
      const removalCheck = await checkWorktreeCanBeRemoved(path, context?.signal);
      if (!removalCheck.ok && !discardChanges) {
        const output = [
          "Refusing to remove worktree because ForgeAgent cannot prove it is safe.",
          `Path: ${path}`,
          `Reason: ${removalCheck.reason}`,
          removalCheck.changedFiles?.length ? "Changed files:" : "",
          ...(removalCheck.changedFiles ?? []).map((file) => `- ${file}`),
          `Recovery: ${removalCheck.recovery}`,
        ].filter(Boolean).join("\n");
        context?.workspaceActivity?.recordWorktree({
          sessionId,
          ...(context?.branchId !== undefined ? { branchId: context.branchId } : {}),
          action: "failed",
          path,
          message: output,
        });
        return { output, isError: true };
      }
      await git(context?.projectRoot ?? process.cwd(), ["worktree", "remove", ...(discardChanges ? ["--force"] : []), path], context?.signal);
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    }
    context?.workspaceActivity?.recordWorktree({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context.branchId } : {}),
      action: keep ? "kept" : "removed",
      path,
      message: keep ? `Worktree kept: ${path}` : `Worktree removed: ${path}`,
    });
    return keep ? `Worktree kept: ${path}` : `Worktree removed: ${path}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context?.workspaceActivity?.recordWorktree({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context.branchId } : {}),
      action: "failed",
      path,
      message,
    });
    return { output: `Failed to exit worktree: ${message}`, isError: true };
  }
}

export const enterWorktreeTool: ExecutableToolDefinition = buildTool({
  name: "enter_worktree",
  description: "Creates and records a git worktree for isolated workspace changes. This does not create a separate coding runtime.",
  params: {
    branch: { type: "string", description: "Branch name for the worktree.", optional: true },
    path: { type: "string", description: "Optional absolute worktree path.", optional: true },
  },
  handler: enterHandler,
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["process.exec", "fs.write"],
});

export const exitWorktreeTool: ExecutableToolDefinition = buildTool({
  name: "exit_worktree",
  description: "Records and optionally removes a git worktree created for workspace work. Removal is fail-closed: dirty or unverifiable worktrees are kept unless discard_changes is explicitly true.",
  params: {
    path: { type: "string", description: "Absolute path to the worktree." },
    keep: { type: "boolean", description: "Keep the worktree instead of removing it.", optional: true },
    discard_changes: { type: "boolean", description: "Explicitly discard uncommitted or untracked worktree changes when removing. Use only after user confirmation.", optional: true },
  },
  handler: exitHandler,
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["process.exec", "fs.write"],
});
