import { resolve } from "node:path";
import type { ToolExecutionContext } from "../../agent/tool-executor.js";
import type { PathSandbox, SandboxAccess } from "../../sandbox/path-sandbox.js";

export type ToolPathContext = Pick<
  ToolExecutionContext,
  "pathSandbox" | "workspaceActivity" | "workspaceHooks" | "branchId" | "readFileStateScope" | "projectRoot" | "signal"
> & {
  pathSandbox?: PathSandbox;
};

export type ToolPathResult =
  | { ok: true; path: string }
  | { ok: false; output: string; isError: true };

export function resolveToolPath(
  args: Record<string, unknown>,
  context: ToolPathContext | undefined,
  options: {
    argName: string;
    access: SandboxAccess;
    toolName: string;
    action: string;
  },
): ToolPathResult {
  const raw = args[options.argName];
  if (typeof raw !== "string" || !raw.trim()) {
    return {
      ok: false,
      output: [
        "Tool path argument is missing or empty.",
        `Tool: ${options.toolName}`,
        `Requested action: ${options.action}`,
        `Argument: ${options.argName}`,
        "Recovery: provide one explicit path inside the current project workspace.",
      ].join("\n"),
      isError: true,
    };
  }
  const requested = raw.trim();
  const resolved = context?.pathSandbox?.resolvePath(
    requested,
    options.access,
    options.toolName,
    options.action,
  );
  if (resolved && !resolved.ok) {
    return { ok: false, output: resolved.message, isError: true };
  }
  return { ok: true, path: resolved?.path ?? resolve(context?.projectRoot ?? process.cwd(), requested) };
}
