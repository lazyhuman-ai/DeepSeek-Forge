import type {
  PermissionGrantKind,
  PermissionRequestEvent,
  PermissionResponseEvent,
} from "../streams/event-types.js";
import type { ToolCapability, ToolDefinition } from "../tools/schemas.js";
import type { PathSandbox } from "../sandbox/path-sandbox.js";
import { getSensitivePathReason } from "../sandbox/path-sandbox.js";
import { isSafeWorkspaceVerificationCommand } from "../workspace/verification-commands.js";

export type ToolRequestSource = {
  kind: "http" | "repl" | "cli" | "trigger" | "system" | "unknown";
  interactive?: boolean;
  deviceId?: string;
  deviceKind?: string;
  deviceName?: string;
};

export type ToolPolicyDecisionKind = "allow" | "ask" | "deny";

export type ToolPolicyRule = {
  id: string;
  decision: ToolPolicyDecisionKind;
  reason: string;
  toolName?: string;
  capability?: ToolCapability;
  subjectIncludes?: string;
};

export type PermissionResponseDecision =
  | "allow_once"
  | "allow_session"
  | "deny";

export type PermissionResolutionDecision =
  | PermissionResponseDecision
  | "timeout"
  | "aborted"
  | "noninteractive";

export type PermissionRequestStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "aborted";

export type PublicPermissionRequest = {
  id: string;
  sessionId: string;
  branchId?: string;
  toolName: string;
  toolUseId?: string;
  action: string;
  subject: string;
  message: string;
  reason: string;
  options: PermissionResponseDecision[];
  status: PermissionRequestStatus;
  createdAt: string;
  expiresAt: string;
  source?: ToolRequestSource;
};

export type ToolPolicyInput = {
  sessionId: string;
  branchId?: string;
  toolUseId?: string;
  tool: ToolDefinition;
  args: Record<string, unknown>;
  source?: ToolRequestSource;
  pathSandbox?: PathSandbox;
};

export type ToolPolicyDecision = {
  decision: ToolPolicyDecisionKind;
  reason: string;
  action: string;
  subject: string;
};

export type ToolPermissionResult =
  | { allowed: true }
  | { allowed: false; message: string };

export type PermissionGrant = {
  grantId: string;
  sessionId: string;
  grantKind: PermissionGrantKind;
  scope: "session" | "project" | "branch";
  branchId?: string;
  createdAt: string;
  expiresAt?: string;
};

type PendingRequest = PublicPermissionRequest & {
  resolve: (decision: PermissionResolutionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export type PermissionBrokerOptions = {
  timeoutMs?: number;
  rules?: ToolPolicyRule[];
  nextSeq: () => number;
  now: () => string;
  appendSessionEvent: (
    sessionId: string,
    event: PermissionRequestEvent | PermissionResponseEvent,
  ) => void;
  appendSystemEvent?: (detail: string, message: string) => void;
};

const DEFAULT_TIMEOUT_MS = 60_000;

const HIGH_RISK_CAPABILITIES = new Set<ToolCapability>([
  "scheduler.write",
  "mcp.server.launch",
  "mcp.sampling",
  "mcp.elicitation",
]);

const READ_CAPABILITIES = new Set<ToolCapability>([
  "fs.read",
  "memory.read",
  "scheduler.read",
  "artifact.read",
  "user.prompt",
  "mcp.resource.read",
  "mcp.prompt.read",
  "extension.read",
]);

function capabilityAction(capabilities: ToolCapability[]): string {
  return capabilities.length > 0 ? capabilities.join(", ") : "tool.execute";
}

function firstString(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function firstStringArray(args: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = args[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }
  }
  return [];
}

function subjectFromArgs(toolName: string, args: Record<string, unknown>): string {
  const command = firstString(args, ["command"]);
  if (command) return `Command: ${command}`;
  const path = firstString(args, ["file_path", "path", "to_path", "from_path", "destination_path", "source_path", "new_path", "old_path"]);
  if (path) return `Path: ${path}`;
  const url = firstString(args, ["url"]);
  if (url) return `URL: ${url}`;
  const artifact = firstString(args, ["artifact_id"]);
  if (artifact) return `Artifact: ${artifact}`;
  return `Tool: ${toolName}`;
}

function pathFromArgs(args: Record<string, unknown>): string | null {
  return firstString(args, ["file_path", "path", "to_path", "destination_path", "new_path", "from_path", "source_path", "old_path"]);
}

function filesystemAccessForInput(capabilities: ToolCapability[]): "read" | "write" | null {
  if (capabilities.includes("fs.write")) return "write";
  if (capabilities.includes("fs.read")) return "read";
  return null;
}

function materializedSensitivePathReason(
  input: ToolPolicyInput,
  requestedPath: string,
  access: "read" | "write" | null,
): string | null {
  if (!access || !input.pathSandbox) return null;
  const resolved = input.pathSandbox.resolvePath(
    requestedPath,
    access,
    input.tool.name,
    access === "read" ? "fs.read" : "fs.write",
  );
  if (!resolved.ok) return null;
  return getSensitivePathReason(resolved.path);
}

function boolFromArgs(args: Record<string, unknown>, key: string): boolean | undefined {
  return typeof args[key] === "boolean" ? args[key] : undefined;
}

function installInputFromArgs(args: Record<string, unknown>): Record<string, unknown> {
  const raw = args.install_input ?? args.installInput;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : args;
}

function extensionInstallNeedsApproval(args: Record<string, unknown>): string | null {
  const input = installInputFromArgs(args);
  const kind = firstString(input, ["kind"]);
  const enable = boolFromArgs(input, "enable") === true;
  if ((kind === "mcp_server" || kind === "mcp_catalog") && enable) {
    return "Enabling an MCP server can launch a local process or connect to a remote service.";
  }
  return null;
}

function isPureFilesystemWrite(capabilities: ToolCapability[]): boolean {
  return capabilities.length === 1 && capabilities[0] === "fs.write";
}

type ShellToken =
  | { type: "word"; value: string }
  | { type: "op"; value: "&&" | ";" | "|" };

type ShellSecurityAst = {
  segments: string[][];
  operators: Array<"&&" | ";" | "|">;
};

type ShellSecurityParseResult =
  | { ok: true; ast: ShellSecurityAst }
  | { ok: false; reason: string };

const SAFE_BASH_COMMANDS = new Set([
  "pwd",
  "cd",
  "ls",
  "find",
  "fd",
  "tree",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "sort",
  "uniq",
  "cut",
  "date",
  "whoami",
  "uname",
  "true",
  "false",
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
  "ls-files",
  "grep",
  "blame",
  "remote",
]);

const FIND_WRITE_OPTIONS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fls",
  "-fprint",
  "-fprint0",
]);

const PACKAGE_MANAGER_COMMANDS = new Set(["npm", "pnpm", "yarn", "bun"]);
const SAFE_PACKAGE_SCRIPTS = new Set(["typecheck", "check", "build", "lint", "format", "test"]);
const SAFE_COMMAND_ARG_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const MAX_SAFE_SHELL_COMMAND_CHARS = 8_000;
const MAX_SAFE_SHELL_SEGMENTS = 50;
const MAX_SAFE_SHELL_WORDS_PER_SEGMENT = 200;
type FlagArgKind = "none" | "number" | "string";

const GIT_DISPLAY_FLAGS: Record<string, FlagArgKind> = {
  "--stat": "none",
  "--shortstat": "none",
  "--numstat": "none",
  "--name-only": "none",
  "--name-status": "none",
  "--color": "none",
  "--no-color": "none",
  "--no-ext-diff": "none",
  "--patch": "none",
  "-p": "none",
  "-s": "none",
};

const GIT_SAFE_FLAGS: Record<string, Record<string, FlagArgKind>> = {
  status: {
    "--short": "none",
    "-s": "none",
    "--branch": "none",
    "-b": "none",
    "--porcelain": "none",
    "--porcelain=v1": "none",
    "--porcelain=v2": "none",
    "--ignored": "none",
    "--untracked-files": "string",
    "-u": "string",
  },
  diff: {
    ...GIT_DISPLAY_FLAGS,
    "--cached": "none",
    "--staged": "none",
    "--check": "none",
    "--summary": "none",
    "--word-diff": "none",
    "--word-diff-regex": "string",
    "--color-words": "none",
    "--ignore-space-at-eol": "none",
    "--ignore-space-change": "none",
    "--ignore-all-space": "none",
    "--ignore-blank-lines": "none",
    "--diff-filter": "string",
    "--find-renames": "none",
    "--find-copies": "none",
    "-M": "none",
    "-C": "none",
    "-B": "none",
    "-R": "none",
    "-S": "string",
    "-G": "string",
  },
  log: {
    ...GIT_DISPLAY_FLAGS,
    "--oneline": "none",
    "--graph": "none",
    "--decorate": "none",
    "--no-decorate": "none",
    "--abbrev-commit": "none",
    "--all": "none",
    "--branches": "none",
    "--tags": "none",
    "--remotes": "none",
    "--reverse": "none",
    "--first-parent": "none",
    "--merges": "none",
    "--no-merges": "none",
    "--max-count": "number",
    "-n": "number",
    "--skip": "number",
    "--since": "string",
    "--after": "string",
    "--until": "string",
    "--before": "string",
    "--author": "string",
    "--grep": "string",
    "--pretty": "string",
    "--format": "string",
    "--diff-filter": "string",
    "-S": "string",
    "-G": "string",
  },
  show: {
    ...GIT_DISPLAY_FLAGS,
    "--abbrev-commit": "none",
    "--word-diff": "none",
    "--word-diff-regex": "string",
    "--color-words": "none",
    "--pretty": "string",
    "--format": "string",
    "--first-parent": "none",
    "--raw": "none",
    "--quiet": "none",
  },
  branch: {
    "--all": "none",
    "-a": "none",
    "--remotes": "none",
    "-r": "none",
    "--list": "none",
    "-l": "none",
    "--verbose": "none",
    "-v": "none",
    "-vv": "none",
    "--show-current": "none",
    "--format": "string",
  },
  "rev-parse": {
    "--show-toplevel": "none",
    "--show-prefix": "none",
    "--show-cdup": "none",
    "--git-dir": "none",
    "--is-inside-work-tree": "none",
    "--abbrev-ref": "string",
    "--short": "none",
  },
  "ls-files": {
    "--cached": "none",
    "--deleted": "none",
    "--modified": "none",
    "--others": "none",
    "--exclude-standard": "none",
    "--stage": "none",
    "-s": "none",
  },
  grep: {
    "-n": "none",
    "-i": "none",
    "-I": "none",
    "-l": "none",
    "--line-number": "none",
    "--ignore-case": "none",
    "--files-with-matches": "none",
    "-e": "string",
  },
  blame: {
    "-L": "string",
    "--line-porcelain": "none",
    "--porcelain": "none",
    "--date": "string",
  },
  remote: {
    "-v": "none",
    "--verbose": "none",
  },
};

function tokenizeShellCommand(command: string): ShellToken[] | null {
  const tokens: ShellToken[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  const pushWord = (): void => {
    if (current) {
      tokens.push({ type: "word", value: current });
      current = "";
    }
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    const next = command[i + 1];

    if (!quote && (char === "\n" || char === "\r" || char === "`" || char === "<" || char === ">")) {
      return null;
    }
    if (!quote && char === "$" && next === "(") return null;
    if (!quote && char === "\\") {
      if (next === undefined) return null;
      current += next;
      i++;
      continue;
    }
    if (quote && char === quote) {
      quote = null;
      continue;
    }
    if (!quote && (char === "'" || char === "\"")) {
      quote = char;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      pushWord();
      continue;
    }
    if (!quote && char === "&") {
      if (next !== "&") return null;
      pushWord();
      tokens.push({ type: "op", value: "&&" });
      i++;
      continue;
    }
    if (!quote && char === "|") {
      if (next === "|") return null;
      pushWord();
      tokens.push({ type: "op", value: "|" });
      continue;
    }
    if (!quote && char === ";") {
      pushWord();
      tokens.push({ type: "op", value: ";" });
      continue;
    }

    current += char;
  }

  if (quote) return null;
  pushWord();
  return tokens.length > 0 ? tokens : null;
}

function splitShellSegments(tokens: ShellToken[]): ShellSecurityAst | null {
  const segments: string[][] = [];
  const operators: Array<"&&" | ";" | "|"> = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (token.type === "word") {
      current.push(token.value);
      continue;
    }
    if (current.length === 0) return null;
    segments.push(current);
    operators.push(token.value);
    current = [];
  }
  if (current.length === 0) return null;
  segments.push(current);
  return { segments, operators };
}

function detectDangerousShellConstruct(command: string): string | null {
  if (/<<-?\s*\S+/.test(command)) {
    return "Shell heredoc input is not allowed by default policy because it can hide multi-line writes or script bodies.";
  }
  if (/[<>]\(/.test(command)) {
    return "Shell process substitution is not allowed by default policy because it can hide implicit pipes and file descriptors.";
  }
  if (/(^|[\s;&|])[^ \t\n;&|]*\([^)]*[.=@xrwRW]\)(?=$|[\s;&|])/.test(command)) {
    return "zsh glob qualifier syntax is not allowed by default policy because it can expand paths in non-obvious ways.";
  }
  if (/\b(?:zmodload|ztcp|zpty|sysopen|coproc)\b/.test(command)) {
    return "zsh low-level modules or coprocess primitives are not allowed by default policy.";
  }
  return null;
}

function parseForSecurity(command: string): ShellSecurityParseResult {
  // Parser-first shell AST-lite: this intentionally accepts only a small,
  // explainable shell subset and rejects dangerous zsh/bash constructs before
  // command allowlisting. It is not a general shell interpreter.
  const dangerous = detectDangerousShellConstruct(command);
  if (dangerous) return { ok: false, reason: dangerous };
  const tokens = tokenizeShellCommand(command);
  if (!tokens) {
    return {
      ok: false,
      reason: "Shell command uses unsupported syntax such as redirection, command substitution, unterminated quotes, or unsafe control operators.",
    };
  }
  const ast = splitShellSegments(tokens);
  if (!ast) {
    return {
      ok: false,
      reason: "Shell command could not be parsed into safe command segments.",
    };
  }
  return { ok: true, ast };
}

function hasBlockedShellExpansion(words: string[]): boolean {
  return words.some((word) => word.includes("$") || word.startsWith("~"));
}

function pathTokenAllowed(input: ToolPolicyInput, token: string): boolean {
  if (token.startsWith("-")) return true;
  if (getSensitivePathReason(token)) return false;
  if (!input.pathSandbox) return false;
  return input.pathSandbox.resolvePath(token, "read", input.tool.name, "process.exec").ok;
}

function commandPathsAllowed(input: ToolPolicyInput, words: string[]): boolean {
  return words.every((word) => pathTokenAllowed(input, word));
}

function flagValueAllowed(kind: FlagArgKind, value: string): boolean {
  if (hasBlockedShellExpansion([value])) return false;
  if (!SAFE_COMMAND_ARG_RE.test(value)) return false;
  if (kind === "number") return /^\d+$/.test(value);
  return true;
}

function gitFlagsAndArgsAllowed(
  input: ToolPolicyInput,
  subcommand: string,
  args: string[],
): boolean {
  const flagSpec = GIT_SAFE_FLAGS[subcommand] ?? {};
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    if (word === "--") {
      return commandPathsAllowed(input, args.slice(index + 1));
    }
    if (!word.startsWith("-")) {
      if (!pathTokenAllowed(input, word)) return false;
      continue;
    }
    const equalsIndex = word.indexOf("=");
    const flag = equalsIndex > -1 ? word.slice(0, equalsIndex) : word;
    const inlineValue = equalsIndex > -1 ? word.slice(equalsIndex + 1) : undefined;
    const kind = flagSpec[flag] ?? flagSpec[word];
    if (!kind) return false;
    if (kind === "none") {
      if (inlineValue !== undefined) return false;
      continue;
    }
    const value = inlineValue ?? args[index + 1];
    if (!value) return false;
    // Required-argument options must not consume another option-looking token.
    // This avoids getopt differentials such as `git diff -S -- --output=x`.
    if (inlineValue === undefined && value.startsWith("-")) return false;
    if (!flagValueAllowed(kind, value)) return false;
    if (inlineValue === undefined) index++;
  }
  return true;
}

function safeCommandArgs(words: string[]): boolean {
  return words.every((word) => word === "--" || SAFE_COMMAND_ARG_RE.test(word));
}

function safePackageManagerCommand(words: string[]): boolean {
  const command = words[0];
  if (!command || !PACKAGE_MANAGER_COMMANDS.has(command)) return false;
  if (words[1] === "test") return safeCommandArgs(words.slice(2));
  return words.length >= 3 &&
    words[1] === "run" &&
    SAFE_PACKAGE_SCRIPTS.has(words[2]!) &&
    safeCommandArgs(words.slice(3));
}

function safeNpxCommand(words: string[]): boolean {
  if (words[0] !== "npx") return false;
  const tscIndex = words[1] === "--no-install" ? 2 : 1;
  if (words[tscIndex] !== "tsc") return false;
  const args = words.slice(tscIndex + 1);
  if (!args.includes("--noEmit")) return false;
  const allowed = new Set(["--noEmit", "--pretty", "false", "true", "--pretty=false", "--pretty=true"]);
  return args.every((word) => allowed.has(word));
}

function safeGitCommand(input: ToolPolicyInput, words: string[]): boolean {
  const subcommand = words[1];
  if (!subcommand || !SAFE_GIT_SUBCOMMANDS.has(subcommand)) return false;
  const args = words.slice(2);
  if (subcommand === "branch") {
    const dangerousBranchFlags = new Set([
      "-d",
      "-D",
      "-m",
      "-M",
      "-c",
      "-C",
      "--delete",
      "--move",
      "--copy",
      "--set-upstream-to",
      "--unset-upstream",
      "--edit-description",
      "--track",
      "--no-track",
    ]);
    if (args.some((word) => dangerousBranchFlags.has(word) || word.startsWith("--set-upstream-to="))) {
      return false;
    }
    // `git branch name` creates a branch. Keep the default-safe branch surface
    // to read-only flags only; use dedicated worktree tools for branch changes.
    return gitFlagsAndArgsAllowed(input, subcommand, args);
  }
  return gitFlagsAndArgsAllowed(input, subcommand, args);
}

function safeSedCommand(input: ToolPolicyInput, words: string[]): boolean {
  if (words[0] !== "sed") return false;
  if (words[1] !== "-n") return false;
  const script = words[2];
  if (!script || !/^\d+(?:,\d+)?p$/.test(script)) return false;
  const paths = words.slice(3);
  return paths.length > 0 && commandPathsAllowed(input, paths);
}

function safeBashSegment(input: ToolPolicyInput, words: string[]): boolean {
  if (words.length === 0 || hasBlockedShellExpansion(words)) return false;
  if (isSafeWorkspaceVerificationCommand(words.join(" "))) return true;
  const command = words[0]!;
  if (command.includes("/")) return false;
  if (command === "echo") return true;
  if (safePackageManagerCommand(words) || safeNpxCommand(words)) return true;
  if (command === "git") return safeGitCommand(input, words);
  if (command === "sed") return safeSedCommand(input, words);
  if (!SAFE_BASH_COMMANDS.has(command)) return false;
  if (command === "find" && words.some((word) => FIND_WRITE_OPTIONS.has(word))) return false;
  if (command === "rg" && words.some((word) => word === "--pre" || word.startsWith("--pre="))) {
    return false;
  }
  return commandPathsAllowed(input, words.slice(1));
}

function safeBashCommandReason(input: ToolPolicyInput): string | null {
  if (input.tool.name !== "bash") return null;
  if (input.args.run_in_background === true) return null;
  const rawCommand = firstString(input.args, ["command"]);
  const command = rawCommand
    ?.trim()
    .replace(/\s+2>\s*&1\s*$/u, "")
    .replace(/\s+2>\s*\/dev\/null\s*$/u, "");
  if (!command) return null;
  if (command.length > MAX_SAFE_SHELL_COMMAND_CHARS) return null;
  const parsed = parseForSecurity(command);
  if (!parsed.ok) return null;
  const { segments } = parsed.ast;
  if (
    segments.length > MAX_SAFE_SHELL_SEGMENTS ||
    segments.some((segment) => segment.length > MAX_SAFE_SHELL_WORDS_PER_SEGMENT)
  ) {
    return null;
  }
  const effectiveSegments = (
    segments.length > 1 &&
    segments[0]?.length === 2 &&
    segments[0][0] === "cd" &&
    pathTokenAllowed(input, segments[0][1]!)
  )
    ? segments.slice(1)
    : segments;
  if (!effectiveSegments.every((segment) => safeBashSegment(input, segment))) return null;
  return "Read-only shell inspection commands inside the workspace are allowed by default policy.";
}

function unsafeBashParseReason(input: ToolPolicyInput): string | null {
  if (input.tool.name !== "bash") return null;
  const rawCommand = firstString(input.args, ["command"]);
  const command = rawCommand
    ?.trim()
    .replace(/\s+2>\s*&1\s*$/u, "")
    .replace(/\s+2>\s*\/dev\/null\s*$/u, "");
  if (!command) return null;
  const parsed = parseForSecurity(command);
  return parsed.ok ? null : parsed.reason;
}

function safeVerifyWorkspaceReason(input: ToolPolicyInput): string | null {
  if (input.tool.name !== "verify_workspace") return null;
  const commands = firstStringArray(input.args, ["commands"]);
  if (commands.length === 0) {
    return "Automatic workspace verification uses only detected safe test/typecheck/check/build/lint commands.";
  }
  if (commands.every(isSafeWorkspaceVerificationCommand)) {
    return "Safe workspace verification commands are allowed by default policy.";
  }
  return null;
}

function workspaceTaskAllowReason(input: ToolPolicyInput): string | null {
  if (input.tool.name === "agent_task") {
    const subagentType = firstString(input.args, ["subagent_type"]) ?? "verify";
    const toolMode = firstString(input.args, ["tool_mode"]) ?? (subagentType === "implement" ? "workspace_write" : "read_only");
    if (subagentType === "implement" || toolMode === "workspace_write") {
      return "Bounded implementation subagents are allowed to start by default; every nested workspace edit, command, worktree, and verification tool call still goes through PermissionBroker and PathSandbox.";
    }
    return "Read-only subagent coordination is allowed by default; any nested tool call still goes through normal permissions.";
  }
  if (input.tool.name === "agent_task_cancel") {
    return "Cancelling a ForgeAgent background subagent task is allowed by default.";
  }
  if (input.tool.name === "task_kill") {
    return "Stopping a ForgeAgent-managed background shell task is allowed by default.";
  }
  return null;
}

function readOnlyInPlanMode(input: ToolPolicyInput): boolean {
  if (input.tool.name !== "agent_task") return input.tool.isReadOnly === true;
  const subagentType = firstString(input.args, ["subagent_type"]);
  const toolMode = firstString(input.args, ["tool_mode"]);
  return subagentType !== "implement" && toolMode !== "workspace_write";
}

function bashPackageInstallReason(input: ToolPolicyInput): string | null {
  if (input.tool.name !== "bash") return null;
  const command = firstString(input.args, ["command"]);
  if (!command) return null;
  if (/\b(?:npm|pnpm|yarn|bun|pip|uv|brew)\s+(?:install|add|remove|uninstall|upgrade|update)\b/i.test(command)) {
    return "This shell command involves package installation or removal.";
  }
  return null;
}

function destructiveShellDenyReason(input: ToolPolicyInput): string | null {
  if (input.tool.name !== "bash") return null;
  const command = firstString(input.args, ["command"])?.trim();
  if (!command) return null;
  const normalized = command.replace(/\s+/g, " ");
  if (/\brm\s+-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*\s+(?:\/|\/\*|~|~\/|\$HOME(?:\/|$))/.test(normalized)) {
    return "This command attempts a recursive forced delete of a system, home, or root path. ForgeAgent hard-denies this class of destructive command; use targeted workspace file tools or ask the user for a specific safe path.";
  }
  if (/\bgit\s+reset\s+--hard\b/i.test(normalized)) {
    return "This command can discard workspace changes without a reversible ForgeAgent checkpoint. ForgeAgent hard-denies git reset --hard; inspect git_diff and use targeted revert_file_change, exit_worktree keep/remove, or ask the user for a safer recovery plan.";
  }
  if (/\bgit\s+push\b[\s\S]*\s--force(?:-with-lease)?\b/i.test(normalized)) {
    return "This command force-pushes git history. ForgeAgent hard-denies force pushes from the workspace automation path.";
  }
  if (/\bgit\s+commit\b[\s\S]*\s--no-verify\b/i.test(normalized)) {
    return "This command skips commit hooks. ForgeAgent hard-denies --no-verify by default because it bypasses project validation.";
  }
  if (/\b(?:mkfs|diskutil\s+erase\w*|shutdown|reboot|halt|poweroff)\b/i.test(normalized)) {
    return "This command can erase disks or shut down the machine. ForgeAgent hard-denies system-destructive commands.";
  }
  if (/\bdd\b[\s\S]*\bof=\/dev\//i.test(normalized)) {
    return "This command writes raw bytes to a device path. ForgeAgent hard-denies raw device writes.";
  }
  if (/\bchmod\s+-R\s+777\s+(?:\/|~|~\/|\$HOME(?:\/|$))/i.test(normalized)) {
    return "This command recursively weakens permissions on a system or home path. ForgeAgent hard-denies broad permission changes.";
  }
  return null;
}

function decisionRank(decision: ToolPolicyDecisionKind): number {
  if (decision === "deny") return 3;
  if (decision === "ask") return 2;
  return 1;
}

function ruleMatches(
  rule: ToolPolicyRule,
  input: ToolPolicyInput,
  capabilities: ToolCapability[],
  subject: string,
): boolean {
  if (rule.toolName && rule.toolName !== input.tool.name) return false;
  if (rule.capability && !capabilities.includes(rule.capability)) return false;
  if (rule.subjectIncludes && !subject.includes(rule.subjectIncludes)) return false;
  return true;
}

function sessionAllowanceKey(input: ToolPolicyInput, action: string, subject: string): string {
  return `${input.sessionId}\u0000${input.tool.name}\u0000${action}\u0000${subject}`;
}

export class ToolPolicyManager {
  #rules: ToolPolicyRule[] = [];
  #sessionAllowances = new Set<string>();
  #dangerouslyAllowedSessions = new Set<string>();
  #planModeSessions = new Set<string>();
  #grants = new Map<string, PermissionGrant>();

  constructor(options?: { rules?: ToolPolicyRule[] }) {
    this.#rules = [...(options?.rules ?? [])];
  }

  addRule(rule: ToolPolicyRule): void {
    this.#rules.push(rule);
  }

  allowForSession(input: ToolPolicyInput, action: string, subject: string): void {
    this.#sessionAllowances.add(sessionAllowanceKey(input, action, subject));
  }

  setDangerouslyAllowAllTools(sessionId: string, enabled: boolean): void {
    if (enabled) {
      this.#dangerouslyAllowedSessions.add(sessionId);
    } else {
      this.#dangerouslyAllowedSessions.delete(sessionId);
    }
  }

  isDangerouslyAllowingAllTools(sessionId: string): boolean {
    return this.#dangerouslyAllowedSessions.has(sessionId);
  }

  setPlanMode(sessionId: string, enabled: boolean): void {
    if (enabled) {
      this.#planModeSessions.add(sessionId);
    } else {
      this.#planModeSessions.delete(sessionId);
    }
  }

  isPlanMode(sessionId: string): boolean {
    return this.#planModeSessions.has(sessionId);
  }

  createGrant(input: Omit<PermissionGrant, "grantId" | "createdAt"> & { grantId?: string; createdAt?: string }): PermissionGrant {
    const grant: PermissionGrant = {
      grantId: input.grantId ?? crypto.randomUUID(),
      sessionId: input.sessionId,
      grantKind: input.grantKind,
      scope: input.scope,
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      createdAt: input.createdAt ?? new Date().toISOString(),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };
    this.#grants.set(grant.grantId, grant);
    return grant;
  }

  revokeGrant(grantId: string): PermissionGrant | undefined {
    const grant = this.#grants.get(grantId);
    if (!grant) return undefined;
    this.#grants.delete(grantId);
    return grant;
  }

  listGrants(sessionId?: string): PermissionGrant[] {
    this.#expireOldGrants();
    return [...this.#grants.values()].filter((grant) => sessionId === undefined || grant.sessionId === sessionId);
  }

  #expireOldGrants(): void {
    const nowMs = Date.now();
    for (const [grantId, grant] of this.#grants) {
      if (grant.expiresAt && Date.parse(grant.expiresAt) <= nowMs) {
        this.#grants.delete(grantId);
      }
    }
  }

  #hasGrant(input: ToolPolicyInput, grantKind: PermissionGrantKind): boolean {
    this.#expireOldGrants();
    for (const grant of this.#grants.values()) {
      if (grant.sessionId !== input.sessionId) continue;
      if (grant.grantKind !== grantKind) continue;
      if (grant.scope === "branch" && grant.branchId !== input.branchId) continue;
      return true;
    }
    return false;
  }

  evaluate(input: ToolPolicyInput): ToolPolicyDecision {
    const capabilities = input.tool.capabilities ?? [];
    const action = capabilityAction(capabilities);
    const subject = subjectFromArgs(input.tool.name, input.args);
    const requestedPath = pathFromArgs(input.args);

    if (this.#planModeSessions.has(input.sessionId)) {
      const planModeAllowed = readOnlyInPlanMode(input) ||
        input.tool.name === "todo_write" ||
        input.tool.name === "ask_user" ||
        input.tool.name === "enter_plan_mode" ||
        input.tool.name === "exit_plan_mode";
      if (!planModeAllowed) {
        return {
          decision: "deny",
          action,
          subject,
          reason: "Plan mode is active. The agent may inspect, search, read, update the plan, or ask the user, but it cannot modify files, run commands, launch runtimes, or change persistent state until it exits plan mode.",
        };
      }
    }

    const matched = this.#rules
      .filter((rule) => ruleMatches(rule, input, capabilities, subject))
      .sort((a, b) => decisionRank(b.decision) - decisionRank(a.decision))[0];
    if (matched?.decision === "deny") {
      return {
        decision: matched.decision,
        action,
        subject,
        reason: matched.reason,
      };
    }

    const destructiveShellReason = destructiveShellDenyReason(input);
    if (destructiveShellReason) {
      return {
        decision: "deny",
        action,
        subject,
        reason: destructiveShellReason,
      };
    }

    const sensitivePathReason = requestedPath
      ? getSensitivePathReason(requestedPath)
        ?? materializedSensitivePathReason(input, requestedPath, filesystemAccessForInput(capabilities))
      : null;
    if (sensitivePathReason) {
      return {
        decision: "ask",
        action,
        subject,
        reason: sensitivePathReason,
      };
    }

    if (this.#sessionAllowances.has(sessionAllowanceKey(input, action, subject))) {
      return {
        decision: "allow",
        action,
        subject,
        reason: "This exact tool request was approved for the current session.",
      };
    }

    if (
      (input.tool.name === "write_file" ||
        input.tool.name === "edit_file" ||
        input.tool.name === "multi_edit_file" ||
        input.tool.name === "apply_patch_file" ||
        input.tool.name === "move_file" ||
        input.tool.name === "delete_file" ||
        input.tool.name === "revert_file_change") &&
      this.#hasGrant(input, "workspace_edits") &&
      requestedPath &&
      input.pathSandbox?.resolvePath(requestedPath, "write", input.tool.name, "fs.write").ok
    ) {
      return {
        decision: "allow",
        action,
        subject,
        reason: "Workspace edit autopilot is enabled for this session; sandbox checks still apply.",
      };
    }

    const safeBashReason = safeBashCommandReason(input);
    if (safeBashReason && this.#hasGrant(input, "safe_commands")) {
      return {
        decision: "allow",
        action,
        subject,
        reason: "Safe command autopilot is enabled for this session.",
      };
    }

    const safeVerifyReason = safeVerifyWorkspaceReason(input);
    if (safeVerifyReason && this.#hasGrant(input, "safe_commands")) {
      return {
        decision: "allow",
        action,
        subject,
        reason: "Safe command autopilot is enabled for this session.",
      };
    }

    const workspaceTaskReason = workspaceTaskAllowReason(input);
    if (workspaceTaskReason) {
      return {
        decision: "allow",
        action,
        subject,
        reason: workspaceTaskReason,
      };
    }

    const packageInstallReason = bashPackageInstallReason(input);
    if (packageInstallReason && this.#hasGrant(input, "package_install")) {
      return {
        decision: "allow",
        action,
        subject,
        reason: "Package install permission grant is enabled for this session.",
      };
    }

    if (this.#dangerouslyAllowedSessions.has(input.sessionId)) {
      return {
        decision: "allow",
        action,
        subject,
        reason: "Dangerous free mode is enabled for this session; approval prompts are bypassed.",
      };
    }

    if (matched) {
      return {
        decision: matched.decision,
        action,
        subject,
        reason: matched.reason,
      };
    }

    if (requestedPath) {
      if (isPureFilesystemWrite(capabilities) && input.pathSandbox) {
        const resolved = input.pathSandbox.resolvePath(
          requestedPath,
          "write",
          input.tool.name,
          "fs.write",
        );
        if (resolved.ok) {
          return {
            decision: "allow",
            action,
            subject,
            reason: "Filesystem writes inside the allowed workspace roots are allowed by default policy.",
          };
        }
      }
    }

    if (safeBashReason) {
      return {
        decision: "allow",
        action,
        subject,
        reason: safeBashReason,
      };
    }

    const unsafeShellReason = unsafeBashParseReason(input);
    if (unsafeShellReason) {
      return {
        decision: "ask",
        action,
        subject,
        reason: unsafeShellReason,
      };
    }

    if (safeVerifyReason) {
      return {
        decision: "allow",
        action,
        subject,
        reason: safeVerifyReason,
      };
    }

    if (packageInstallReason) {
      return {
        decision: "ask",
        action,
        subject,
        reason: packageInstallReason,
      };
    }

    if (input.tool.name === "extension_install") {
      const reason = extensionInstallNeedsApproval(input.args);
      if (reason) {
        return {
          decision: "ask",
          action,
          subject,
          reason,
        };
      }
      return {
        decision: "allow",
        action,
        subject,
        reason: "Extension installation is allowed by default when it does not immediately enable a risky runtime.",
      };
    }

    if (input.tool.name === "extension_enable") {
      const kind = firstString(input.args, ["kind"]);
      if (kind === "skill") {
        return {
          decision: "allow",
          action,
          subject,
          reason: "Enabling an installed skill is allowed by default; any scripts or tools it suggests still run through normal permissions and sandbox.",
        };
      }
      return {
        decision: "ask",
        action,
        subject,
        reason: "Enabling this extension can launch or connect runtime capability and should be confirmed.",
      };
    }

    if (
      input.tool.isReadOnly === true &&
      capabilities.every((capability) => READ_CAPABILITIES.has(capability) || capability === "network.http")
    ) {
      return {
        decision: "allow",
        action,
        subject,
        reason: "Read-only tool request is allowed by default policy.",
      };
    }

    if (
      input.tool.name === "write_file" ||
      input.tool.name === "edit_file" ||
      input.tool.name === "multi_edit_file" ||
      input.tool.name === "apply_patch_file" ||
      input.tool.name === "move_file" ||
      input.tool.name === "delete_file" ||
      input.tool.name === "revert_file_change"
    ) {
      if (requestedPath && input.pathSandbox) {
        const resolved = input.pathSandbox.resolvePath(
          requestedPath,
          "write",
          input.tool.name,
          "fs.write",
        );
        if (!resolved.ok) {
          return {
            decision: "ask",
            action,
            subject,
            reason: resolved.message,
          };
        }
      }
      return {
        decision: "allow",
        action,
        subject,
        reason: "Workspace file edits are allowed by default; PathSandbox still blocks paths outside allowed roots or sensitive files.",
      };
    }

    if (capabilities.includes("runtime.browser")) {
      return {
        decision: "allow",
        action,
        subject,
        reason: "Visible browser automation is allowed by default. The agent must ask the user before submitting forms, paying, posting, deleting, or changing account settings.",
      };
    }

    if (capabilities.includes("memory.write")) {
      return {
        decision: "allow",
        action,
        subject,
        reason: "Memory writes are allowed by default and remain visible through memory tools and diagnostics.",
      };
    }

    if (capabilities.includes("mcp.tool") && input.tool.isReadOnly !== true) {
      return {
        decision: "ask",
        action,
        subject,
        reason: "This MCP tool is not marked read-only by the server.",
      };
    }

    if (capabilities.some((capability) => HIGH_RISK_CAPABILITIES.has(capability))) {
      return {
        decision: "ask",
        action,
        subject,
        reason: "This request changes persistent automation, launches external capability, or invokes a high-risk MCP feature.",
      };
    }

    if (
      capabilities.length === 0 ||
      capabilities.every((capability) => READ_CAPABILITIES.has(capability))
    ) {
      return {
        decision: "allow",
        action,
        subject,
        reason: "Read-only tool request is allowed by default policy.",
      };
    }

    return {
      decision: "ask",
      action,
      subject,
      reason: "This tool request is not covered by an allow policy and requires user approval.",
    };
  }
}

export class PermissionBroker {
  #policy: ToolPolicyManager;
  #timeoutMs: number;
  #nextSeq: () => number;
  #now: () => string;
  #appendSessionEvent: PermissionBrokerOptions["appendSessionEvent"];
  #appendSystemEvent: PermissionBrokerOptions["appendSystemEvent"];
  #pending = new Map<string, PendingRequest>();

  constructor(options: PermissionBrokerOptions) {
    this.#policy = new ToolPolicyManager(
      options.rules !== undefined ? { rules: options.rules } : undefined,
    );
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#nextSeq = options.nextSeq;
    this.#now = options.now;
    this.#appendSessionEvent = options.appendSessionEvent;
    this.#appendSystemEvent = options.appendSystemEvent;
  }

  get policy(): ToolPolicyManager {
    return this.#policy;
  }

  getPendingRequests(): PublicPermissionRequest[] {
    return [...this.#pending.values()].map((request) => this.#publicRequest(request));
  }

  setDangerouslyAllowAllTools(sessionId: string, enabled: boolean): void {
    this.#policy.setDangerouslyAllowAllTools(sessionId, enabled);
  }

  isDangerouslyAllowingAllTools(sessionId: string): boolean {
    return this.#policy.isDangerouslyAllowingAllTools(sessionId);
  }

  setPlanMode(sessionId: string, enabled: boolean): void {
    this.#policy.setPlanMode(sessionId, enabled);
  }

  isPlanMode(sessionId: string): boolean {
    return this.#policy.isPlanMode(sessionId);
  }

  createPermissionGrant(
    input: Omit<PermissionGrant, "grantId" | "createdAt"> & { grantId?: string; createdAt?: string },
  ): PermissionGrant {
    return this.#policy.createGrant(input);
  }

  revokePermissionGrant(grantId: string): PermissionGrant | undefined {
    return this.#policy.revokeGrant(grantId);
  }

  listPermissionGrants(sessionId?: string): PermissionGrant[] {
    return this.#policy.listGrants(sessionId);
  }

  approvePendingRequestsForSession(
    sessionId: string,
    response: {
      message?: string;
      deviceId?: string;
      deviceName?: string;
    } = {},
  ): PublicPermissionRequest[] {
    const pending = [...this.#pending.values()].filter((request) => request.sessionId === sessionId);
    for (const request of pending) {
      this.#resolveRequest(
        request.id,
        "allow_session",
        response.message ?? "Permission approved by dangerous free mode.",
        response.deviceId,
        response.deviceName,
      );
    }
    return pending.map((request) => ({
      ...this.#publicRequest(request),
      status: "approved" as const,
    }));
  }

  abortAll(message = "Permission request aborted by Core shutdown."): void {
    for (const requestId of [...this.#pending.keys()]) {
      this.#resolveRequest(requestId, "aborted", message);
    }
  }

  async authorize(
    input: ToolPolicyInput,
    signal?: AbortSignal,
  ): Promise<ToolPermissionResult> {
    const decision = this.#policy.evaluate(input);
    if (decision.decision === "allow") return { allowed: true };
    if (decision.decision === "deny") {
      return {
        allowed: false,
        message: buildPermissionDeniedMessage(input.tool.name, decision, decision.reason),
      };
    }

    const request = this.#createRequest(input, decision, signal);
    this.#appendRequestEvent(request);

    const interactive = input.source?.interactive === true;
    if (!interactive) {
      const resolution: PermissionResolutionDecision = "noninteractive";
      this.#resolveRequest(request.id, resolution, "This turn has no interactive approval channel.");
      return {
        allowed: false,
        message: buildPermissionDeniedMessage(
          input.tool.name,
          decision,
          "This action requires user approval, but this turn has no interactive approval channel.",
        ),
      };
    }

    const resolution = await new Promise<PermissionResolutionDecision>((resolve) => {
      request.resolve = resolve;
      if (signal) {
        const onAbort = (): void => {
          this.#resolveRequest(request.id, "aborted", "Permission request aborted by turn interrupt.");
        };
        request.onAbort = onAbort;
        request.signal = signal;
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    if (resolution === "allow_once") return { allowed: true };
    if (resolution === "allow_session") {
      this.#policy.allowForSession(input, decision.action, decision.subject);
      return { allowed: true };
    }

    const reason = resolution === "timeout"
      ? "The approval request timed out."
      : resolution === "aborted"
        ? "The approval request was aborted."
        : "The approval request was denied.";
    return {
      allowed: false,
      message: buildPermissionDeniedMessage(input.tool.name, decision, reason),
    };
  }

  respondToPermissionRequest(
    requestId: string,
    response: {
      decision: PermissionResponseDecision;
      message?: string;
      deviceId?: string;
      deviceName?: string;
    },
  ): PublicPermissionRequest {
    const pending = this.#pending.get(requestId);
    if (!pending) throw new Error(`Permission request is not pending: ${requestId}`);
    const message = response.message ?? (
      response.decision === "deny"
        ? "Permission denied by user."
        : "Permission approved by user."
    );
    this.#resolveRequest(
      requestId,
      response.decision,
      message,
      response.deviceId,
      response.deviceName,
    );
    return {
      ...this.#publicRequest(pending),
      status: response.decision === "deny" ? "denied" : "approved",
    };
  }

  #createRequest(
    input: ToolPolicyInput,
    decision: ToolPolicyDecision,
    signal: AbortSignal | undefined,
  ): PendingRequest {
    const id = crypto.randomUUID();
    const createdAt = this.#now();
    const expiresAt = new Date(Date.parse(createdAt) + this.#timeoutMs).toISOString();
    const request: PendingRequest = {
      id,
      sessionId: input.sessionId,
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      toolName: input.tool.name,
      action: decision.action,
      subject: decision.subject,
      message: buildPermissionRequestMessage(input.tool.name, decision),
      reason: decision.reason,
      options: ["allow_once", "allow_session", "deny"],
      status: "pending",
      createdAt,
      expiresAt,
      resolve: () => undefined,
      timer: setTimeout(() => {
        this.#resolveRequest(id, "timeout", "Permission request timed out.");
      }, this.#timeoutMs),
    };
    if (input.toolUseId !== undefined) request.toolUseId = input.toolUseId;
    if (input.branchId !== undefined) request.branchId = input.branchId;
    if (input.source !== undefined) request.source = input.source;
    if (signal !== undefined) request.signal = signal;
    this.#pending.set(id, request);
    return request;
  }

  #appendRequestEvent(request: PendingRequest): void {
    const event: PermissionRequestEvent = {
      type: "permission_request",
      seq: this.#nextSeq(),
      timestamp: this.#now(),
      sessionId: request.sessionId,
      ...(request.branchId !== undefined ? { branchId: request.branchId } : {}),
      permissionRequestId: request.id,
      toolName: request.toolName,
      action: request.action,
      subject: request.subject,
      message: request.message,
      reason: request.reason,
      options: request.options,
      status: "pending",
      expiresAt: request.expiresAt,
    };
    if (request.toolUseId !== undefined) event.toolUseId = request.toolUseId;
    if (request.source !== undefined) event.source = request.source;
    this.#appendSessionEvent(request.sessionId, event);
    this.#appendSystemEvent?.("permission_request", `${request.sessionId}: ${request.message}`);
  }

  #resolveRequest(
    requestId: string,
    decision: PermissionResolutionDecision,
    message: string,
    deviceId?: string,
    deviceName?: string,
  ): void {
    const request = this.#pending.get(requestId);
    if (!request) return;
    clearTimeout(request.timer);
    if (request.signal && request.onAbort) {
      request.signal.removeEventListener("abort", request.onAbort);
    }
    this.#pending.delete(requestId);

    const status: PermissionRequestStatus =
      decision === "allow_once" || decision === "allow_session"
        ? "approved"
        : decision === "timeout"
          ? "expired"
          : decision === "aborted"
            ? "aborted"
            : "denied";

    const event: PermissionResponseEvent = {
      type: "permission_response",
      seq: this.#nextSeq(),
      timestamp: this.#now(),
      sessionId: request.sessionId,
      ...(request.branchId !== undefined ? { branchId: request.branchId } : {}),
      permissionRequestId: request.id,
      toolName: request.toolName,
      action: request.action,
      subject: request.subject,
      decision,
      status,
      message,
    };
    if (request.toolUseId !== undefined) event.toolUseId = request.toolUseId;
    if (deviceId !== undefined) event.deviceId = deviceId;
    if (deviceName !== undefined) event.deviceName = deviceName;
    this.#appendSessionEvent(request.sessionId, event);
    this.#appendSystemEvent?.("permission_response", `${request.sessionId}: ${message}`);
    request.resolve(decision);
  }

  #publicRequest(request: PendingRequest): PublicPermissionRequest {
    const publicRequest: PublicPermissionRequest = {
      id: request.id,
      sessionId: request.sessionId,
      toolName: request.toolName,
      action: request.action,
      subject: request.subject,
      message: request.message,
      reason: request.reason,
      options: [...request.options],
      status: request.status,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
    };
    if (request.toolUseId !== undefined) publicRequest.toolUseId = request.toolUseId;
    if (request.branchId !== undefined) publicRequest.branchId = request.branchId;
    if (request.source !== undefined) publicRequest.source = request.source;
    return publicRequest;
  }
}

function buildPermissionRequestMessage(
  toolName: string,
  decision: ToolPolicyDecision,
): string {
  return [
    "Tool permission required before execution.",
    `Tool: ${toolName}`,
    `Requested action: ${decision.action}`,
    decision.subject,
    `Reason: ${decision.reason}`,
  ].join("\n");
}

export function buildPermissionDeniedMessage(
  toolName: string,
  decision: ToolPolicyDecision,
  reason: string,
): string {
  return [
    "Tool permission denied before execution.",
    `Tool: ${toolName}`,
    `Requested action: ${decision.action}`,
    decision.subject,
    `Reason: ${reason}`,
    "Recovery: Ask the user for approval, choose a less privileged tool or command, or operate inside the allowed workspace.",
  ].join("\n");
}
