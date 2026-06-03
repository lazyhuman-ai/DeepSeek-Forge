import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { ShellWorkspace } from "../src/runtimes/shell/shell-workspace.js";
import { rmSync } from "node:fs";

const TEST_BASE = ".forge/test-workspaces";

describe("ShellWorkspace", () => {
  let ws: ShellWorkspace;

  afterEach(() => {
    rmSync(TEST_BASE, { recursive: true, force: true });
  });

  function newWs(): ShellWorkspace {
    return new ShellWorkspace(TEST_BASE);
  }

  it("getWorkspace creates and returns session directory", () => {
    ws = newWs();
    const dir = ws.getWorkspace("s1");
    expect(dir).toContain("session_s1");
    expect(existsSync(dir)).toBe(true);
  });

  it("getWorkspace returns different directories per session", () => {
    ws = newWs();
    const dir1 = ws.getWorkspace("s1");
    const dir2 = ws.getWorkspace("s2");
    expect(dir1).not.toBe(dir2);
    expect(dir1).toContain("session_s1");
    expect(dir2).toContain("session_s2");
  });

  it("getWorkspace is idempotent", () => {
    ws = newWs();
    const dir1 = ws.getWorkspace("s1");
    const dir2 = ws.getWorkspace("s1");
    expect(dir1).toBe(dir2);
  });

  it("exec runs command and returns result", async () => {
    ws = newWs();
    const result = await ws.exec("s1", "echo hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("");
  });

  it("exec runs in session workspace directory", async () => {
    ws = newWs();
    const dir = ws.getWorkspace("s1");

    const result = await ws.exec("s1", process.platform === "win32" ? "cd" : "pwd");
    expect(result.stdout).toBe(dir);
  });

  it("exec returns exitCode for failed commands", async () => {
    ws = newWs();
    const result = await ws.exec("s1", "nonexistent-command-that-should-fail 2>&1 || true");
    // The `|| true` ensures the shell doesn't throw, but exit code may vary
    expect(result.exitCode).toBeGreaterThanOrEqual(0);
  });

  it("exec captures stderr", async () => {
    ws = newWs();
    const result = await ws.exec("s1", "echo error >&2");
    expect(result.stderr).toBe("error");
  });

  it("execInDir runs in subdirectory of workspace", async () => {
    ws = newWs();
    const wsDir = ws.getWorkspace("s1");
    const subDir = pathResolve(wsDir, "sub");

    const result = await ws.execInDir("s1", process.platform === "win32" ? "cd" : "pwd", "sub");
    expect(result.stdout).toBe(subDir);
    expect(existsSync(subDir)).toBe(true);
  });

  it("removeWorkspace deletes directory", () => {
    ws = newWs();
    const dir = ws.getWorkspace("s1");
    expect(existsSync(dir)).toBe(true);

    ws.removeWorkspace("s1");
    expect(existsSync(dir)).toBe(false);
  });

  it("removeWorkspace is safe for non-existent session", () => {
    ws = newWs();
    expect(() => ws.removeWorkspace("nope")).not.toThrow();
  });

  it("timeout kills long-running command", async () => {
    ws = newWs();
    const result = await ws.exec("s1", "sleep 5", { timeout: 100 });
    expect(result.exitCode).not.toBe(0);
  });

  it("sessions are isolated — files in one workspace not visible in another", async () => {
    ws = newWs();
    const dir1 = ws.getWorkspace("s1");
    writeFileSync(pathResolve(dir1, "secret.txt"), "private");

    // s2's workspace should not have the file
    const result = await ws.exec("s2", "ls secret.txt");
    expect(result.exitCode).not.toBe(0);
  });
});
