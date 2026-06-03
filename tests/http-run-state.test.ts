import { afterEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  clearRunState,
  isProcessAlive,
  readRunState,
  runPidPath,
  runStatePath,
  writeRunState,
} from "../src/gateways/http/run-state.js";

const DATA_DIR = resolve("tests/tmp/http-run-state");

describe("HTTP gateway run state", () => {
  afterEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("writes, reads, and clears gateway process state", () => {
    const state = writeRunState(DATA_DIR, {
      pid: process.pid,
      host: "127.0.0.1",
      port: 3000,
      url: "http://127.0.0.1:3000",
      logPath: resolve(DATA_DIR, "run", "forgeagent.log"),
    });

    expect(existsSync(runStatePath(DATA_DIR))).toBe(true);
    expect(existsSync(runPidPath(DATA_DIR))).toBe(true);

    const read = readRunState(DATA_DIR);
    expect(read).toMatchObject({
      app: "ForgeAgent",
      pid: process.pid,
      host: "127.0.0.1",
      port: 3000,
      url: "http://127.0.0.1:3000",
      dataDir: DATA_DIR,
    });
    expect(read?.startedAt).toBe(state.startedAt);

    clearRunState(DATA_DIR);
    expect(readRunState(DATA_DIR)).toBeNull();
  });

  it("detects live and invalid pids", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
  });
});
