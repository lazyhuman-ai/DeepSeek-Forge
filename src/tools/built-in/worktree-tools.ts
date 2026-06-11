import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, symlinkSync } from "node:fs";
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

const SHAREABLE_WORKTREE_DIRS = [
  "node_modules",
  ".pnpm-store",
  ".yarn/cache",
  ".venv",
  "venv",
  ".gradle",
  ".m2",
  ".swiftpm",
  ".build",
];

const PRIMARY_BRANCH_NAMES = new Set(["main", "master", "trunk", "develop", "development", "dev"]);

async function git(
  projectRoot: string,
  args: string[],
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = GIT_ENV,
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: projectRoot,
    timeout: 60_000,
    signal,
    env,
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

function linkShareableWorktreeDirs(repoRoot: string, worktreePath: string): string[] {
  const linked: string[] = [];
  const resolvedRepo = resolve(repoRoot);
  const resolvedWorktree = resolve(worktreePath);
  for (const relative of SHAREABLE_WORKTREE_DIRS) {
    const source = resolve(resolvedRepo, relative);
    const target = resolve(resolvedWorktree, relative);
    if (!source.startsWith(`${resolvedRepo}/`) || !target.startsWith(`${resolvedWorktree}/`)) continue;
    if (!existsSync(source) || existsSync(target)) continue;
    try {
      const sourceStat = statSync(source);
      if (!sourceStat.isDirectory()) continue;
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(source, target, "dir");
      linked.push(relative);
    } catch {
      // Dependency sharing is a performance optimization only. Worktree correctness must not depend on it.
    }
  }
  return linked;
}

type WorktreeListEntry = {
  path: string;
  branch?: string;
  bare?: boolean;
};

function parseWorktreeList(output: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: resolve(line.slice("worktree ".length).trim()) };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line === "bare") {
      current.bare = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

async function currentBranch(projectRoot: string, signal?: AbortSignal): Promise<string> {
  return git(projectRoot, ["branch", "--show-current"], signal);
}

async function worktreeStatus(projectRoot: string, signal?: AbortSignal): Promise<string[]> {
  const status = await git(projectRoot, ["status", "--porcelain"], signal);
  return status.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function gitConfig(projectRoot: string, key: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const value = await git(projectRoot, ["config", "--get", key], signal);
    return value.trim() || null;
  } catch {
    return null;
  }
}

async function commitEnv(projectRoot: string, signal?: AbortSignal): Promise<NodeJS.ProcessEnv> {
  const userName = await gitConfig(projectRoot, "user.name", signal);
  const userEmail = await gitConfig(projectRoot, "user.email", signal);
  if (userName && userEmail) return GIT_ENV;
  return {
    ...GIT_ENV,
    GIT_AUTHOR_NAME: userName ?? "ForgeAgent",
    GIT_AUTHOR_EMAIL: userEmail ?? "forgeagent@local",
    GIT_COMMITTER_NAME: userName ?? "ForgeAgent",
    GIT_COMMITTER_EMAIL: userEmail ?? "forgeagent@local",
  };
}

async function mainWorktreeFor(path: string, signal?: AbortSignal): Promise<string | null> {
  const list = parseWorktreeList(await git(path, ["worktree", "list", "--porcelain"], signal));
  const resolvedPath = resolve(path);
  const candidates = list.filter((entry) => !entry.bare && resolve(entry.path) !== resolvedPath);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!.path;

  const primaryCandidates = candidates.filter((entry) => entry.branch && PRIMARY_BRANCH_NAMES.has(entry.branch));
  if (primaryCandidates.length === 1) return primaryCandidates[0]!.path;
  return null;
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
        ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
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
    const linkedDirs = linkShareableWorktreeDirs(repoRoot, worktreePath);
    const createdMessage = [
      `Worktree created: ${worktreePath} (${branch})`,
      linkedDirs.length > 0 ? `Shared dependency/cache directories: ${linkedDirs.join(", ")}` : "",
    ].filter(Boolean).join("\n");
    context?.workspaceActivity?.recordWorktree({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      action: "entered",
      path: worktreePath,
      branch,
      message: createdMessage,
    });
    if (context) {
      context.projectRoot = worktreePath;
      context.pathSandbox = new PathSandbox({ projectRoot: worktreePath });
    }
    return [`Worktree created: ${worktreePath}`, `Branch: ${branch}`, linkedDirs.length > 0 ? `Shared dependency/cache directories: ${linkedDirs.join(", ")}` : ""].filter(Boolean).join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context?.workspaceActivity?.recordWorktree({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
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
          ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
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
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      action: keep ? "kept" : "removed",
      path,
      message: keep ? `Worktree kept: ${path}` : `Worktree removed: ${path}`,
    });
    return keep ? `Worktree kept: ${path}` : `Worktree removed: ${path}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context?.workspaceActivity?.recordWorktree({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      action: "failed",
      path,
      message,
    });
    return { output: `Failed to exit worktree: ${message}`, isError: true };
  }
}

async function mergeHandler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  const path = typeof args.path === "string" ? resolve(args.path) : resolve(context?.projectRoot ?? process.cwd());
  const targetPathArg = typeof args.target_path === "string" ? resolve(args.target_path) : undefined;
  const removeAfterMerge = args.remove_after_merge === true;
  if (!path) return { output: "path is required.", isError: true };
  try {
    const inside = await git(path, ["rev-parse", "--is-inside-work-tree"], context?.signal);
    if (inside !== "true") {
      return { output: `Path is not a git worktree: ${path}`, isError: true };
    }
    const branch = await currentBranch(path, context?.signal);
    if (!branch) {
      return { output: `Worktree has no current branch and cannot be merged automatically: ${path}`, isError: true };
    }
    if (!targetPathArg && PRIMARY_BRANCH_NAMES.has(branch)) {
      return {
        output: [
          "Refusing to infer merge target from a primary branch worktree.",
          `Worktree: ${path}`,
          `Branch: ${branch}`,
          "Recovery: pass path with the feature worktree to merge, or pass target_path explicitly if you really intend this merge.",
        ].join("\n"),
        isError: true,
      };
    }
    const dirty = await worktreeStatus(path, context?.signal);
    if (dirty.length > 0) {
      return {
        output: [
          "Cannot merge worktree with uncommitted or untracked changes.",
          `Worktree: ${path}`,
          `Branch: ${branch}`,
          "Changed files:",
          ...dirty.slice(0, 30).map((file) => `- ${file}`),
          "Recovery: commit the worktree changes, or use git_diff/review first and decide whether to keep or discard the worktree.",
        ].join("\n"),
        isError: true,
      };
    }
    const targetPath = targetPathArg ?? await mainWorktreeFor(path, context?.signal);
    if (!targetPath) {
      return {
        output: [
          "Cannot infer a unique target worktree to merge into.",
          `Worktree: ${path}`,
          "Recovery: pass target_path with the main repository path. ForgeAgent refuses to guess when multiple worktrees exist.",
        ].join("\n"),
        isError: true,
      };
    }
    const targetDirty = await worktreeStatus(targetPath, context?.signal);
    if (targetDirty.length > 0) {
      return {
        output: [
          "Cannot merge into a dirty target worktree.",
          `Target: ${targetPath}`,
          "Changed files:",
          ...targetDirty.slice(0, 30).map((file) => `- ${file}`),
          "Recovery: commit, stash, or clean the target worktree before merging.",
        ].join("\n"),
        isError: true,
      };
    }
    const targetBranch = typeof args.target_branch === "string" && args.target_branch.trim()
      ? args.target_branch.trim()
      : await currentBranch(targetPath, context?.signal);
    if (targetBranch) {
      await git(targetPath, ["checkout", targetBranch], context?.signal);
    }
    const output = await git(targetPath, ["merge", "--no-ff", "--no-edit", branch], context?.signal);
    if (removeAfterMerge) {
      await git(targetPath, ["worktree", "remove", path], context?.signal);
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    }
    const message = [
      "Worktree merged.",
      `Source: ${path}`,
      `Branch: ${branch}`,
      `Target: ${targetPath}${targetBranch ? ` (${targetBranch})` : ""}`,
      removeAfterMerge ? "Source worktree removed after merge." : "Source worktree kept after merge.",
      output ? `\nGit output:\n${output}` : "",
    ].filter(Boolean).join("\n");
    context?.workspaceActivity?.recordWorktree({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      action: "merged",
      path,
      branch,
      message,
    });
    return message;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context?.workspaceActivity?.recordWorktree({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      action: "failed",
      path,
      message,
    });
    return { output: `Failed to merge worktree: ${message}`, isError: true };
  }
}

async function commitHandler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  const path = typeof args.path === "string" ? resolve(args.path) : resolve(context?.projectRoot ?? process.cwd());
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!message) return { output: "message is required.", isError: true };
  try {
    const inside = await git(path, ["rev-parse", "--is-inside-work-tree"], context?.signal);
    if (inside !== "true") {
      return { output: `Path is not a git worktree: ${path}`, isError: true };
    }
    const topLevel = resolve(await git(path, ["rev-parse", "--show-toplevel"], context?.signal));
    if (topLevel !== path) {
      return {
        output: [
          "Refusing to commit from a nested path.",
          `Requested path: ${path}`,
          `Git root: ${topLevel}`,
          "Recovery: call commit_worktree from the worktree root or pass the worktree root path.",
        ].join("\n"),
        isError: true,
      };
    }
    const changed = await worktreeStatus(path, context?.signal);
    if (changed.length === 0) {
      return {
        output: [
          "Cannot commit worktree because there are no changes.",
          `Worktree: ${path}`,
          "Recovery: make workspace changes first, or skip commit_worktree and continue with review.",
        ].join("\n"),
        isError: true,
      };
    }
    await git(path, ["add", "-A"], context?.signal);
    const env = await commitEnv(path, context?.signal);
    const output = await git(path, ["commit", "-m", message], context?.signal, env);
    const hash = await git(path, ["rev-parse", "--short", "HEAD"], context?.signal);
    const branch = await currentBranch(path, context?.signal);
    const summary = [
      "Worktree committed.",
      `Worktree: ${path}`,
      branch ? `Branch: ${branch}` : "",
      `Commit: ${hash}`,
      `Message: ${message}`,
      "Changed files:",
      ...changed.slice(0, 40).map((file) => `- ${file}`),
      output ? `\nGit output:\n${output}` : "",
    ].filter(Boolean).join("\n");
    context?.workspaceActivity?.recordWorktree({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      action: "committed",
      path,
      branch,
      message: summary,
    });
    return summary;
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    context?.workspaceActivity?.recordWorktree({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      action: "failed",
      path,
      message: messageText,
    });
    return { output: `Failed to commit worktree: ${messageText}`, isError: true };
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

export const mergeWorktreeTool: ExecutableToolDefinition = buildTool({
  name: "merge_worktree",
  description: "Merges a clean, committed ForgeAgent worktree branch back into a target worktree. It refuses dirty source or target worktrees and records durable worktree evidence.",
  params: {
    path: { type: "string", description: "Absolute source worktree path. Defaults to the active project/worktree root.", optional: true },
    target_path: { type: "string", description: "Absolute target repository path. Defaults to another worktree from git worktree list.", optional: true },
    target_branch: { type: "string", description: "Target branch to checkout before merging. Defaults to the target worktree current branch.", optional: true },
    remove_after_merge: { type: "boolean", description: "Remove the source worktree after a successful merge. Defaults to false.", optional: true },
  },
  handler: mergeHandler,
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["process.exec", "fs.write"],
});

export const commitWorktreeTool: ExecutableToolDefinition = buildTool({
  name: "commit_worktree",
  description: "Stages and commits all changes in the active ForgeAgent worktree, then records durable worktree evidence for later merge/review.",
  params: {
    path: { type: "string", description: "Absolute worktree path. Defaults to the active project/worktree root.", optional: true },
    message: { type: "string", description: "Commit message for the worktree changes." },
  },
  handler: commitHandler,
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["process.exec", "fs.write"],
});
