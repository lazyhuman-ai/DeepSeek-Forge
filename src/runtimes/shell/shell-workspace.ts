import { exec as cpExec } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

const execAsync = promisify(cpExec);

export type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export class ShellWorkspace {
  #baseDir: string;
  #workspaces = new Set<string>();

  constructor(baseDir = ".forge/workspaces") {
    this.#baseDir = pathResolve(baseDir);
  }

  getWorkspace(sessionId: string): string {
    const dir = pathResolve(this.#baseDir, `session_${sessionId}`);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.#workspaces.add(sessionId);
    return dir;
  }

  async exec(
    sessionId: string,
    command: string,
    options?: { timeout?: number },
  ): Promise<ShellResult> {
    const cwd = this.getWorkspace(sessionId);
    return this.#run(command, cwd, options?.timeout);
  }

  async execInDir(
    sessionId: string,
    command: string,
    subdir: string,
    options?: { timeout?: number },
  ): Promise<ShellResult> {
    const workspace = this.getWorkspace(sessionId);
    const cwd = pathResolve(workspace, subdir);
    if (!existsSync(cwd)) {
      mkdirSync(cwd, { recursive: true });
    }
    return this.#run(command, cwd, options?.timeout);
  }

  removeWorkspace(sessionId: string): void {
    const dir = pathResolve(this.#baseDir, `session_${sessionId}`);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
    this.#workspaces.delete(sessionId);
  }

  async #run(
    command: string,
    cwd: string,
    timeout = 30_000,
  ): Promise<ShellResult> {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout,
        maxBuffer: 1024 * 1024, // 1MB
      });
      return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
      return {
        stdout: (e.stdout ?? "").trimEnd(),
        stderr: (e.stderr ?? "").trimEnd(),
        exitCode: e.code ?? 1,
      };
    }
  }
}
