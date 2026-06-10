import type { ToolExecutionContext } from "../../agent/tool-executor.js";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { formatWorkspacePath, typeScriptWorkspace } from "../../workspace/typescript-service.js";
import type { Diagnostic } from "../../streams/event-types.js";
import { detectWorkspaceVerificationCommands } from "../../workspace/verification-commands.js";

function summarizeDiagnostics(projectRoot: string, diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return "TypeScript language-service diagnostics are clean.";
  const shown = diagnostics.slice(0, 20).map((diagnostic) => {
    const location = diagnostic.filePath
      ? `${formatWorkspacePath(projectRoot, diagnostic.filePath)}${diagnostic.line ? `:${diagnostic.line}` : ""}${diagnostic.character ? `:${diagnostic.character}` : ""}`
      : "unknown";
    return `${location} ${diagnostic.code ?? ""} ${diagnostic.message}`.trim();
  });
  const suffix = diagnostics.length > shown.length ? `\n... ${diagnostics.length - shown.length} more diagnostic(s)` : "";
  return `TypeScript language service reported ${diagnostics.length} diagnostic(s):\n${shown.join("\n")}${suffix}`;
}

async function handler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  const projectRoot = context?.projectRoot ?? process.cwd();
  const command = "typescript-language-service";
  try {
    if (context?.signal?.aborted) return "Diagnostics aborted.";
    const workspace = typeScriptWorkspace(projectRoot);
    if (workspace.fileNames().length === 0) {
      const detectedCommands = await detectWorkspaceVerificationCommands(projectRoot, "quick");
      const recovery = detectedCommands.length > 0
        ? [
          "Detected safe workspace verification command(s):",
          ...detectedCommands.map((cmd) => `- ${cmd}`),
          "Recovery: call verify_workspace to run the detected language-native check(s), or use a language-specific MCP/tool if the project needs deeper semantic navigation.",
        ].join("\n")
        : "Recovery: add a safe test/typecheck/check target, call verify_workspace after configuring one, or use a language-specific MCP/tool for this project.";
      const message = [
        "TypeScript language-service diagnostics are not available because this workspace has no TypeScript/JavaScript source files.",
        recovery,
      ].join("\n");
      context?.workspaceActivity?.recordDiagnostics({
        sessionId,
        ...(context.branchId !== undefined ? { branchId: context.branchId } : {}),
        source: "typescript-language-service",
        diagnostics: [],
        failed: true,
        message,
      });
      return { output: message, isError: true };
    }
    const diagnostics = workspace.diagnostics();
    context?.workspaceActivity?.recordDiagnostics({
      sessionId,
      ...(context.branchId !== undefined ? { branchId: context.branchId } : {}),
      source: "typescript-language-service",
      diagnostics,
    });
    context?.workspaceActivity?.recordVerification({
      sessionId,
      ...(context.branchId !== undefined ? { branchId: context.branchId } : {}),
      command,
      status: "passed",
      exitCode: 0,
      summary: diagnostics.length === 0 ? "TypeScript language service clean" : `${diagnostics.length} diagnostic(s)`,
    });
    return diagnostics.some((diagnostic) => diagnostic.severity === "error")
      ? { output: summarizeDiagnostics(projectRoot, diagnostics), isError: true }
      : summarizeDiagnostics(projectRoot, diagnostics);
  } catch (error) {
    if (context?.signal?.aborted) return "Diagnostics aborted.";
    const err = error as Error;
    const diagnostics: Diagnostic[] = [];
    context?.workspaceActivity?.recordDiagnostics({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context.branchId } : {}),
      source: "typescript-language-service",
      diagnostics,
      failed: true,
      message: `TypeScript language service failed: ${err.message}`,
    });
    context?.workspaceActivity?.recordVerification({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context.branchId } : {}),
      command,
      status: "failed",
      summary: err.message,
    });
    return {
      output: `TypeScript language service failed: ${err.message}`,
      isError: true,
    };
  }
}

export const lspDiagnosticsTool: ExecutableToolDefinition = buildTool({
  name: "lsp_diagnostics",
  description: "Runs TypeScript/JavaScript language-service diagnostics for the current workspace and records structured diagnostic/check events. For non-TS/JS projects, reports detected safe verify_workspace commands instead of pretending an LSP is available.",
  params: {
    command: {
      type: "string",
      description: "Deprecated. Diagnostics use ForgeAgent's TypeScript language service adapter.",
      optional: true,
    },
  },
  handler,
  isConcurrencySafe: false,
  isReadOnly: true,
  capabilities: ["fs.read"],
});
