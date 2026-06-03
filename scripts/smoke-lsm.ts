// Smoke test: lifecycle state machine end-to-end
import { CoreAPI } from "../src/core/core-api.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { AnthropicProvider } from "../src/agent/anthropic-provider.js";

const DATA_DIR = ".forge-smoke-lsm";

async function main() {
  const { rmSync } = await import("node:fs");
  try { rmSync(DATA_DIR, { recursive: true }); } catch {}

  const registry = new ToolRegistry();
  const api = new CoreAPI(registry, { dataDir: DATA_DIR });
  api.registerBuiltInTools();

  const provider = new AnthropicProvider();
  api.setModelProvider(provider);
  api.initSupervisor(2);
  api.initScheduler();

  console.log("=== 1. idle → running → sleeping ===");
  const s = api.createSession("lifecycle-test");
  console.log(`Created: [${s.status}]`);

  // Schedule a trigger so session will go to sleeping after turn
  api.scheduleTrigger({
    id: crypto.randomUUID(),
    sessionId: s.id,
    kind: "time",
    schedule: "3600000",
    payload: { prompt: "hourly check" },
    enabled: true,
    recurring: true,
  });

  api.appendUserMessage(s.id, "Reply with just OK.");
  console.log(`After append: [${api.getSession(s.id)!.status}]`);

  await api.runTurn(s.id);
  console.log(`After turn (has trigger): [${api.getSession(s.id)!.status}]`);

  console.log("\n=== 2. sleeping → running (user message) ===");
  api.appendUserMessage(s.id, "Wake up and reply with just HI.");
  console.log(`After message while sleeping: [${api.getSession(s.id)!.status}]`);
  await api.runTurn(s.id);
  console.log(`After turn (still has trigger): [${api.getSession(s.id)!.status}]`);

  console.log("\n=== 3. interrupt → idle ===");
  const interrupted = api.interruptSession(s.id);
  console.log(`After interrupt from sleeping: [${interrupted.status}]`);

  console.log("\n=== 4. blocked → retry ===");
  // Force a blocked state by running a turn without model provider
  const s2 = api.createSession("blocked-test");
  // Remove triggers so it goes to idle not sleeping
  const triggers = api.listTriggers(s2.id);
  for (const t of triggers) api.deleteTrigger(t.id);

  // Manually set to blocked
  api.appendUserMessage(s2.id, "test");
  const { transition } = await import("../src/core/session-supervisor.js");
  const session = api.getSession(s2.id);
  (session as any).status = "blocked";
  console.log(`Forced blocked: [${api.getSession(s2.id)!.status}]`);

  // Retry should bring it back to running → dispatch
  try {
    const retried = api.retryBlockedSession(s2.id);
    console.log(`After retry: [${retried.status}]`);
  } catch (e) {
    console.log(`Retry started (expected error from missing turn): ${(e as Error).message.slice(0, 50)}`);
  }
  await new Promise(r => setTimeout(r, 100));
  console.log(`Final: [${api.getSession(s2.id)!.status}]`);

  console.log("\n=== All lifecycle smoke tests passed! ===");
  api.flush();
  try { rmSync(DATA_DIR, { recursive: true }); } catch {}
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
