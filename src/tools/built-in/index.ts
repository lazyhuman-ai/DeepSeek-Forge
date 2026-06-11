import type { ToolRegistry } from "../tool-registry.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit-file.js";
import { bashTool } from "./bash-tool.js";
import { enterPlanModeTool, exitPlanModeTool } from "./plan-mode.js";
import { todoWriteTool } from "./todo-write.js";
import { completeStepTool } from "./complete-step.js";
import { multiEditFileTool } from "./multi-edit-file.js";
import { applyPatchFileTool } from "./apply-patch-file.js";
import { notebookEditTool } from "./notebook-edit.js";
import { revertFileChangeTool } from "./edit-checkpoint.js";
import { lspDiagnosticsTool } from "./lsp-diagnostics.js";
import { lspQueryTool } from "./lsp-query.js";
import { taskOutputTool } from "./task-output.js";
import { taskKillTool } from "./task-kill.js";
import { commitWorktreeTool, enterWorktreeTool, exitWorktreeTool, mergeWorktreeTool } from "./worktree-tools.js";
import { gitDiffTool } from "./git-diff.js";
import { workspaceReviewTool } from "./workspace-review.js";
import { agentTaskCancelTool, agentTaskOutputTool, agentTaskTool } from "./agent-task.js";
import { verifyWorkspaceTool } from "./verify-workspace.js";
import { moveFileTool } from "./move-file.js";
import { deleteFileTool } from "./delete-file.js";
import { codeMapTool } from "./code-map.js";
import { dependencyGraphTool } from "./dependency-graph.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { fileSearchTool } from "./file-search.js";
import { webFetchTool } from "./web-fetch.js";
import { webSearchTool } from "./web-search.js";
import { memoryAddTool } from "./memory-add.js";
import { memorySearchTool } from "./memory-search.js";
import { memoryGetTool } from "./memory-get.js";
import { cronCreateTool } from "./cron-create.js";
import { cronListTool } from "./cron-list.js";
import { cronDeleteTool } from "./cron-delete.js";
import { askUserTool } from "./ask-user.js";
import { readArtifactTool } from "./read-artifact.js";
import { browserTools } from "./browser-tools.js";
import { extensionTools } from "./extension-tools.js";

export const builtInTools = [
  askUserTool,
  readArtifactTool,
  ...extensionTools,
  ...browserTools,
  readFileTool,
  writeFileTool,
  editFileTool,
  enterPlanModeTool,
  exitPlanModeTool,
  multiEditFileTool,
  applyPatchFileTool,
  notebookEditTool,
  moveFileTool,
  deleteFileTool,
  revertFileChangeTool,
  completeStepTool,
  todoWriteTool,
  lspDiagnosticsTool,
  lspQueryTool,
  bashTool,
  taskOutputTool,
  taskKillTool,
  enterWorktreeTool,
  commitWorktreeTool,
  exitWorktreeTool,
  mergeWorktreeTool,
  gitDiffTool,
  verifyWorkspaceTool,
  workspaceReviewTool,
  agentTaskTool,
  agentTaskOutputTool,
  agentTaskCancelTool,
  codeMapTool,
  dependencyGraphTool,
  fileSearchTool,
  globTool,
  grepTool,
  webFetchTool,
  webSearchTool,
  memoryAddTool,
  memorySearchTool,
  memoryGetTool,
  cronCreateTool,
  cronListTool,
  cronDeleteTool,
];

export function registerBuiltInTools(registry: ToolRegistry): void {
  for (const tool of builtInTools) {
    registry.register(tool);
  }
}
