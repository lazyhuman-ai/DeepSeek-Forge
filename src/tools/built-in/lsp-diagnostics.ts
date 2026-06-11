import type { ToolExecutionContext } from "../../agent/tool-executor.js";
import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";
import { formatWorkspacePath, typeScriptWorkspace } from "../../workspace/typescript-service.js";
import type { Diagnostic } from "../../streams/event-types.js";
import { detectWorkspaceVerificationCommands } from "../../workspace/verification-commands.js";
import { workspaceLanguageServerManager, type LanguageId } from "../../workspace/language-server-manager.js";

function summarizeDiagnostics(projectRoot: string, diagnostics: Diagnostic[], sourceLabel = "Workspace language-server"): string {
  if (diagnostics.length === 0) return `${sourceLabel} diagnostics are clean.`;
  const shown = diagnostics.slice(0, 20).map((diagnostic) => {
    const location = diagnostic.filePath
      ? `${formatWorkspacePath(projectRoot, diagnostic.filePath)}${diagnostic.line ? `:${diagnostic.line}` : ""}${diagnostic.character ? `:${diagnostic.character}` : ""}`
      : "unknown";
    return `${location} ${diagnostic.code ?? ""} ${diagnostic.message}`.trim();
  });
  const suffix = diagnostics.length > shown.length ? `\n... ${diagnostics.length - shown.length} more diagnostic(s)` : "";
  return `${sourceLabel} reported ${diagnostics.length} diagnostic(s):\n${shown.join("\n")}${suffix}`;
}

async function handler(
  args: Record<string, unknown>,
  sessionId: string,
  context?: ToolExecutionContext,
): Promise<unknown> {
  const projectRoot = context?.projectRoot ?? process.cwd();
  const manager = workspaceLanguageServerManager(projectRoot);
  const command = "workspace-language-server";
  try {
    if (context?.signal?.aborted) return "Diagnostics aborted.";
    const workspace = typeScriptWorkspace(projectRoot);
    if (workspace.fileNames().length === 0) {
      const pythonDiagnostics = manager.diagnosticsForLanguageProject("python");
      if (pythonDiagnostics) {
        context?.workspaceActivity?.recordDiagnostics({
          sessionId,
          ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
          source: "pyright",
          diagnostics: pythonDiagnostics,
        });
        context?.workspaceActivity?.recordVerification({
          sessionId,
          ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
          command: "pyright --outputjson",
          status: pythonDiagnostics.some((diagnostic) => diagnostic.severity === "error") ? "failed" : "passed",
          summary: pythonDiagnostics.length === 0 ? "Pyright diagnostics clean" : `${pythonDiagnostics.length} pyright diagnostic(s)`,
        });
        return pythonDiagnostics.some((diagnostic) => diagnostic.severity === "error")
          ? { output: summarizeDiagnostics(projectRoot, pythonDiagnostics, "Pyright language-server"), isError: true }
          : summarizeDiagnostics(projectRoot, pythonDiagnostics, "Pyright language-server");
      }
      const lspLanguages: LanguageId[] = ["rust", "go", "java", "swift", "kotlin", "cpp"];
      const lspResults = [];
      for (const language of lspLanguages) {
        if (context?.signal?.aborted) return "Diagnostics aborted.";
        const result = await manager.diagnosticsForLspProject(language);
        if (result) lspResults.push({ language, result });
      }
      if (lspResults.length > 0) {
        const diagnostics = lspResults.flatMap(({ result }) => result.diagnostics);
        const missing = lspResults.filter(({ result }) => result.receivedFiles === 0);
        const source = lspResults.map(({ language, result }) => `${language}:${result.source}`).join(", ");
        const message = missing.length > 0
          ? [
            "Language-server diagnostics could not complete.",
            ...missing.map(({ language, result }) => `${language}: opened ${result.openedFiles} file(s), but ${result.source} did not publish diagnostics before the timeout.`),
            "Recovery: make sure the workspace dependencies and language server are initialized, then retry lsp_diagnostics or run the language-native check with verify_workspace.",
          ].join("\n")
          : summarizeDiagnostics(projectRoot, diagnostics, `Language-server (${source})`);
        context?.workspaceActivity?.recordDiagnostics({
          sessionId,
          ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
          source,
          diagnostics,
          ...(missing.length > 0 ? { failed: true, message } : {}),
        });
        context?.workspaceActivity?.recordVerification({
          sessionId,
          ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
          command: `lsp diagnostics (${source})`,
          status: missing.length > 0 || diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "failed" : "passed",
          summary: missing.length > 0
            ? "Language server did not publish diagnostics before timeout"
            : diagnostics.length === 0
              ? "Language-server diagnostics clean"
              : `${diagnostics.length} language-server diagnostic(s)`,
        });
        return missing.length > 0 || diagnostics.some((diagnostic) => diagnostic.severity === "error")
          ? { output: message, isError: true }
          : message;
      }
      const detectedCommands = await detectWorkspaceVerificationCommands(projectRoot, "quick");
      const languageHints = (["python", "rust", "go", "java", "swift", "kotlin", "cpp"] as LanguageId[])
        .map((language) => manager.statusForLanguage(language).message)
        .join("\n");
      const recovery = detectedCommands.length > 0
        ? [
          "Detected safe workspace verification command(s):",
          ...detectedCommands.map((cmd) => `- ${cmd}`),
          "Recovery: call verify_workspace to run the detected language-native check(s), or use a language-specific MCP/tool if the project needs deeper semantic navigation.",
        ].join("\n")
        : "Recovery: add a safe test/typecheck/check target, call verify_workspace after configuring one, or use a language-specific MCP/tool for this project.";
      const message = [
        "TypeScript/JavaScript diagnostics are not available because this workspace has no TypeScript/JavaScript source files.",
        "Language server availability:",
        languageHints,
        recovery,
      ].join("\n");
      context?.workspaceActivity?.recordDiagnostics({
        sessionId,
        ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
        source: "workspace-language-server",
        diagnostics: [],
        failed: true,
        message,
      });
      return { output: message, isError: true };
    }
    const diagnostics = manager.diagnosticsForProject();
    context?.workspaceActivity?.recordDiagnostics({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      source: "workspace-language-server",
      diagnostics,
    });
    const hasErrors = diagnostics.some((diagnostic) => diagnostic.severity === "error");
    context?.workspaceActivity?.recordVerification({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      command,
      status: hasErrors ? "failed" : "passed",
      exitCode: hasErrors ? 1 : 0,
      summary: diagnostics.length === 0 ? "Workspace language diagnostics clean" : `${diagnostics.length} diagnostic(s)`,
    });
    return hasErrors
      ? { output: summarizeDiagnostics(projectRoot, diagnostics), isError: true }
      : summarizeDiagnostics(projectRoot, diagnostics);
  } catch (error) {
    if (context?.signal?.aborted) return "Diagnostics aborted.";
    const err = error as Error;
    const diagnostics: Diagnostic[] = [];
    context?.workspaceActivity?.recordDiagnostics({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      source: "workspace-language-server",
      diagnostics,
      failed: true,
      message: `Workspace language server diagnostics failed: ${err.message}`,
    });
    context?.workspaceActivity?.recordVerification({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      command,
      status: "failed",
      summary: err.message,
    });
    return {
      output: `Workspace language server diagnostics failed: ${err.message}`,
      isError: true,
    };
  }
}

export const lspDiagnosticsTool: ExecutableToolDefinition = buildTool({
  name: "lsp_diagnostics",
  description: "Runs workspace language-server diagnostics and records structured diagnostic/check events. TypeScript/JavaScript use ForgeAgent's semantic service; Python uses pyright when available; Rust/Go/Java/Swift/Kotlin/C++ use their language server when available and report a clear timeout/error if diagnostics could not be published.",
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
