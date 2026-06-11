import type { ToolExecutionContext } from "../../agent/tool-executor.js";

export async function notifyWorkspaceFileTouched(
  sessionId: string,
  filePath: string,
  context: ToolExecutionContext | undefined,
  reason: "read" | "search" | "edit",
): Promise<void> {
  try {
    await context?.workspaceHooks?.onFileTouched?.({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      filePath,
      reason,
    });
  } catch (error) {
    context?.workspaceActivity?.recordActivity({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      activityKind: "failure",
      status: "failed",
      title: "Workspace file touch hook failed",
      message: error instanceof Error ? error.message : String(error),
      payload: { filePath, reason },
    });
  }
}

export async function notifyWorkspaceFileChanged(
  sessionId: string,
  input: {
    filePath: string;
    beforeContent: string | null;
    afterContent: string;
    operation: "created" | "updated" | "deleted";
  },
  context: ToolExecutionContext | undefined,
): Promise<void> {
  try {
    await context?.workspaceHooks?.onFileChanged?.({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      ...input,
    });
  } catch (error) {
    context?.workspaceActivity?.recordActivity({
      sessionId,
      ...(context?.branchId !== undefined ? { branchId: context?.branchId } : {}),
      activityKind: "failure",
      status: "failed",
      title: "Workspace file change hook failed",
      message: error instanceof Error ? error.message : String(error),
      payload: { filePath: input.filePath, operation: input.operation },
    });
  }
}
