import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ShellTaskSnapshot = {
  taskId: string;
  sessionId: string;
  branchId?: string;
  command: string;
  description?: string;
  status: "running" | "completed" | "failed" | "killed";
  exitCode?: number;
  output: string;
  outputFile?: string;
  stateFile?: string;
  startedAt: string;
  endedAt?: string;
  stallWarning?: string;
};

type ShellTaskHandle = ShellTaskSnapshot & {
  child: ChildProcess;
};

const tasks = new Map<string, ShellTaskHandle>();
const MAX_BUFFER = 200_000;

export function createShellTask(input: {
  taskId: string;
  sessionId: string;
  branchId?: string;
  command: string;
  description?: string;
  outputFile?: string;
  stateFile?: string;
  child: ChildProcess;
}): ShellTaskSnapshot {
  const task: ShellTaskHandle = {
    taskId: input.taskId,
    sessionId: input.sessionId,
    ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
    command: input.command,
    ...(input.description !== undefined ? { description: input.description } : {}),
    status: "running",
    output: "",
    ...(input.outputFile !== undefined ? { outputFile: input.outputFile } : {}),
    ...(input.stateFile !== undefined ? { stateFile: input.stateFile } : {}),
    startedAt: new Date().toISOString(),
    child: input.child,
  };
  tasks.set(input.taskId, task);
  persistShellTask(task);
  return snapshotShellTask(input.taskId)!;
}

export function appendShellTaskOutput(taskId: string, chunk: string): void {
  const task = tasks.get(taskId);
  if (!task || !chunk) return;
  task.output += chunk;
  if (task.output.length > MAX_BUFFER) {
    task.output = task.output.slice(-MAX_BUFFER);
  }
  persistShellTask(task);
}

export function markShellTaskStalled(taskId: string, warning: string): ShellTaskSnapshot | undefined {
  const task = tasks.get(taskId);
  if (!task || task.status !== "running") return undefined;
  task.stallWarning = warning;
  persistShellTask(task);
  return snapshotShellTask(taskId);
}

export function finishShellTask(
  taskId: string,
  status: "completed" | "failed" | "killed",
  exitCode?: number,
): ShellTaskSnapshot | undefined {
  const task = tasks.get(taskId);
  if (!task) return undefined;
  task.status = status;
  if (exitCode !== undefined) task.exitCode = exitCode;
  task.endedAt = new Date().toISOString();
  persistShellTask(task);
  return snapshotShellTask(taskId);
}

export function snapshotShellTask(taskId: string): ShellTaskSnapshot | undefined {
  const task = tasks.get(taskId);
  if (!task) return undefined;
  const { child: _child, ...snapshot } = task;
  return { ...snapshot };
}

export function listShellTaskSnapshots(sessionId?: string): ShellTaskSnapshot[] {
  return [...tasks.values()]
    .filter((task) => sessionId === undefined || task.sessionId === sessionId)
    .map((task) => {
      const { child: _child, ...snapshot } = task;
      return { ...snapshot };
    });
}

export function killShellTask(taskId: string): ShellTaskSnapshot | undefined {
  const task = tasks.get(taskId);
  if (!task) return undefined;
  if (task.status === "running") {
    if (typeof task.child.pid === "number") {
      try {
        process.kill(-task.child.pid, "SIGTERM");
      } catch {
        task.child.kill("SIGTERM");
      }
    } else {
      task.child.kill("SIGTERM");
    }
    return finishShellTask(taskId, "killed");
  }
  return snapshotShellTask(taskId);
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

function publicSnapshot(task: ShellTaskHandle): ShellTaskSnapshot {
  const { child: _child, ...snapshot } = task;
  return { ...snapshot };
}

function persistShellTask(task: ShellTaskHandle): void {
  try {
    if (task.outputFile) writeAtomic(task.outputFile, task.output);
    if (task.stateFile) writeAtomic(task.stateFile, JSON.stringify(publicSnapshot(task), null, 2));
  } catch {
    // Shell task persistence should not mask the command result. The durable thread still records task events.
  }
}

export function loadShellTaskFromFile(stateFile: string): ShellTaskSnapshot | undefined {
  if (!existsSync(stateFile)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf-8")) as ShellTaskSnapshot;
    if (parsed.outputFile && existsSync(parsed.outputFile)) {
      parsed.output = readFileSync(parsed.outputFile, "utf-8");
    }
    return parsed;
  } catch {
    return undefined;
  }
}
