import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import type { ToolExecutionContext } from "../../agent/tool-executor.js";
import { typeScriptWorkspace } from "../../workspace/typescript-service.js";

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);

export function maybeRecordPassiveTypeScriptDiagnostics(input: {
  sessionId: string;
  filePath: string;
  context?: ToolExecutionContext | undefined;
}): void {
  const projectRoot = input.context?.projectRoot;
  if (!projectRoot) return;
  if (!TS_EXTENSIONS.has(extname(input.filePath).toLowerCase())) return;
  if (!existsSync(join(projectRoot, "tsconfig.json"))) return;

  try {
    const diagnostics = typeScriptWorkspace(projectRoot).diagnostics();
    input.context?.workspaceActivity?.recordDiagnostics({
      sessionId: input.sessionId,
      ...(input.context?.branchId !== undefined ? { branchId: input.context?.branchId } : {}),
      source: "typescript-language-service",
      diagnostics,
      message: diagnostics.length === 0
        ? "Passive TypeScript diagnostics are clean after edit"
        : `Passive TypeScript diagnostics reported ${diagnostics.length} issue(s) after edit`,
    });
  } catch (error) {
    input.context?.workspaceActivity?.recordDiagnostics({
      sessionId: input.sessionId,
      ...(input.context?.branchId !== undefined ? { branchId: input.context?.branchId } : {}),
      source: "typescript-language-service",
      diagnostics: [],
      failed: true,
      message: `Passive TypeScript diagnostics failed after edit: ${(error as Error).message}`,
    });
  }
}
