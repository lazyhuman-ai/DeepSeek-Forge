import { resolve } from "node:path";
import type { PathSandbox, SandboxAccess } from "../../sandbox/path-sandbox.js";

export type ToolPathContext = {
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
  const requested = resolve(String(args[options.argName] ?? ""));
  const resolved = context?.pathSandbox?.resolvePath(
    requested,
    options.access,
    options.toolName,
    options.action,
  );
  if (resolved && !resolved.ok) {
    return { ok: false, output: resolved.message, isError: true };
  }
  return { ok: true, path: resolved?.path ?? requested };
}
