import { existsSync, rmSync } from "node:fs";
import { CoreAPI } from "../src/core/core-api.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import type { ModelProvider, ModelMessage, ModelResponse } from "../src/agent/model-provider.js";

const DATA_DIR = ".forge-test-persistence";

function cleanup() {
  if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true });
}

function createMockProvider(): ModelProvider {
  let callCount = 0;
  return {
    async generate(
      _messages: ModelMessage[],
    ): Promise<ModelResponse> {
      callCount++;
      if (callCount === 1) {
        return {
          text: "First response",
          finishReason: "stop",
          rawUsage: { input_tokens: 50, output_tokens: 10 },
        };
      }
      return {
        text: "Second response",
        finishReason: "stop",
        rawUsage: { input_tokens: 100, output_tokens: 15 },
      };
    },
  };
}

async function main() {
  cleanup();

  // ——— First run: create session and populate ———
  console.log("=== First run: create & populate ===\n");

  const registry1 = new ToolRegistry();
  const api1 = new CoreAPI(registry1, { dataDir: DATA_DIR });
  api1.setModelProvider(createMockProvider());

  const session = api1.createSession("Persistence Test");
  console.log(`Created session: ${session.id} (${session.title})`);

  api1.appendUserMessage(session.id, "Hello, first message");
  await api1.runTurn(session.id);
  console.log(`After turn 1: status=${session.status}`);

  api1.appendUserMessage(session.id, "Second message");
  await api1.runTurn(session.id);
  console.log(`After turn 2: status=${session.status}`);

  // Flush all pending writes to disk
  api1.flush();
  console.log("Flushed to disk\n");

  // Verify thread events
  const thread1 = api1.getThread(session.id);
  console.log(`Thread events (first run): ${thread1.length}`);
  for (const e of thread1) {
    console.log(`  seq=${e.seq} type=${e.type}`);
  }

  // ——— Second run: reload from disk ———
  console.log("\n=== Second run: reload ===\n");

  const registry2 = new ToolRegistry();
  const api2 = new CoreAPI(registry2, { dataDir: DATA_DIR });
  api2.setModelProvider(createMockProvider());

  const loadedSessions = api2.loadSessions();
  console.log(`Loaded ${loadedSessions.length} session(s)`);

  if (loadedSessions.length !== 1) {
    console.error("FAIL: expected 1 loaded session");
    process.exit(1);
  }

  const loaded = loadedSessions[0]!;
  console.log(`Loaded session: ${loaded.id} (${loaded.title})`);
  console.log(`  status: ${loaded.status}, muted: ${loaded.muted}`);

  const thread2 = api2.getThread(loaded.id);
  console.log(`Thread events (reloaded): ${thread2.length}`);
  for (const e of thread2) {
    const text = "text" in e ? (e as { text: string }).text.slice(0, 60) : "";
    console.log(`  seq=${e.seq} type=${e.type} ${text}`);
  }

  // Verify
  let ok = true;
  if (loaded.id !== session.id) {
    console.error("FAIL: session ID mismatch");
    ok = false;
  }
  if (loaded.title !== session.title) {
    console.error("FAIL: session title mismatch");
    ok = false;
  }
  if (thread2.length !== thread1.length) {
    console.error(`FAIL: thread length mismatch (${thread1.length} vs ${thread2.length})`);
    ok = false;
  }
  for (let i = 0; i < thread1.length; i++) {
    if (thread1[i]!.type !== thread2[i]!.type) {
      console.error(`FAIL: event ${i} type mismatch: ${thread1[i]!.type} vs ${thread2[i]!.type}`);
      ok = false;
    }
    if (thread1[i]!.seq !== thread2[i]!.seq) {
      console.error(`FAIL: event ${i} seq mismatch: ${thread1[i]!.seq} vs ${thread2[i]!.seq}`);
      ok = false;
    }
  }

  api2.flush();
  cleanup();

  if (ok) {
    console.log("\n✓ All persistence checks passed");
  } else {
    console.log("\n✗ Some checks failed");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
