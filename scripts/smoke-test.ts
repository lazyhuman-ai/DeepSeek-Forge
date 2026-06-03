// Smoke test: exercises the new concurrency + scheduler features end-to-end
import { CoreAPI } from "../src/core/core-api.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { AnthropicProvider } from "../src/agent/anthropic-provider.js";
import { Scheduler } from "../src/core/scheduler.js";

const DATA_DIR = ".forge-smoke";

async function main() {
  // Clean up from previous runs
  const { rmSync } = await import("node:fs");
  try { rmSync(DATA_DIR, { recursive: true }); } catch {}

  const registry = new ToolRegistry();
  const api = new CoreAPI(registry, { dataDir: DATA_DIR });
  api.registerBuiltInTools();

  // Set up model provider with real API
  const provider = new AnthropicProvider();
  api.setModelProvider(provider);

  // Initialize supervisor (concurrency) and scheduler (triggers)
  api.initSupervisor(2);
  api.initScheduler();

  console.log("=== 1. Session creation ===");
  const session = api.createSession("smoke-test");
  console.log(`Created: ${session.id.slice(0, 8)} [${session.status}]`);

  console.log("\n=== 2. Send message + dispatch turn ===");
  api.appendUserMessage(session.id, "Reply with just the word 'OK'.");
  console.log(`After append: [${api.getSession(session.id)!.status}]`);

  // Non-blocking dispatch
  api.dispatchTurn(session.id);
  console.log("Dispatched (non-blocking). Waiting for turn to complete...");

  // Poll for completion
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = api.getSession(session.id);
    if (s!.status === "idle" || s!.status === "waiting_user") {
      console.log(`Turn finished: [${s!.status}]`);
      break;
    }
    process.stdout.write(".");
  }

  // Show thread
  const thread = api.getThread(session.id);
  console.log(`\nThread events: ${thread.length}`);
  for (const e of thread) {
    const content = "text" in e ? (e as { text: string }).text.slice(0, 80)
      : "tool_call" in e ? `tool:${(e as { toolName: string }).toolName}`
      : e.type;
    console.log(`  #${e.seq} ${e.type}: ${content}`);
  }

  console.log("\n=== 3. Trigger CRUD ===");
  // Schedule a trigger via API
  const triggerId = crypto.randomUUID();
  api.scheduleTrigger({
    id: triggerId,
    sessionId: session.id,
    kind: "time",
    schedule: "60000", // every 60s
    payload: { prompt: "Say 'trigger fired'" },
    enabled: true,
    recurring: true,
  });
  console.log(`Scheduled: ${triggerId.slice(0, 8)}`);

  // List triggers
  const triggers = api.listTriggers(session.id);
  console.log(`Triggers for session: ${triggers.length}`);
  for (const t of triggers) {
    console.log(`  ${t.id.slice(0, 8)} kind=${t.kind} enabled=${t.enabled} recurring=${t.recurring} schedule=${t.schedule}`);
  }

  // List all
  const allTriggers = api.listAllTriggers();
  console.log(`All triggers: ${allTriggers.length}`);

  // Cancel (soft disable)
  api.cancelTrigger(triggerId);
  const afterCancel = api.listTriggers(session.id)[0];
  console.log(`After cancel — enabled: ${afterCancel?.enabled}`);

  // Delete (hard remove)
  api.deleteTrigger(triggerId);
  console.log(`After delete — count: ${api.listTriggers(session.id).length}`);

  console.log("\n=== 4. Persistence check ===");
  // Verify triggers.json was created
  const { existsSync, readFileSync } = await import("node:fs");
  const persistPath = `${DATA_DIR}/triggers.json`;
  if (existsSync(persistPath)) {
    const raw = readFileSync(persistPath, "utf-8");
    const persisted = JSON.parse(raw);
    console.log(`triggers.json exists with ${persisted.length} trigger(s)`);
  } else {
    console.log("triggers.json does not exist (expected after delete)");
  }

  // Create a trigger and check it persists
  const persistId = crypto.randomUUID();
  api.scheduleTrigger({
    id: persistId,
    sessionId: session.id,
    kind: "time",
    schedule: "3600000",
    payload: { prompt: "hourly check" },
    enabled: true,
    recurring: true,
  });
  api.flush();

  if (existsSync(persistPath)) {
    const raw = readFileSync(persistPath, "utf-8");
    const persisted = JSON.parse(raw);
    console.log(`After re-schedule: ${persisted.length} trigger(s) persisted`);
  }

  // Test loading from persisted file
  const loaded = Scheduler.loadFromFile(persistPath);
  console.log(`Load from file: ${loaded.length} trigger(s)`);

  console.log("\n=== 5. Cron tools (via tool registry) ===");
  const cronList = registry.get("cron_list");
  if (cronList?.handler) {
    const result = await cronList.handler({}, session.id);
    console.log(`cron_list: ${String(result.output)}`);
  }

  const cronCreate = registry.get("cron_create");
  if (cronCreate?.handler) {
    const result = await cronCreate.handler(
      { schedule: "300000", prompt: "every 5 min check", recurring: false },
      session.id,
    );
    console.log(`cron_create: ${String(result.output)}`);
  }

  const cronDelete = registry.get("cron_delete");
  if (cronDelete?.handler) {
    const triggers2 = api.listTriggers(session.id);
    if (triggers2.length > 0) {
      const result = await cronDelete.handler({ id: triggers2[0]!.id }, session.id);
      console.log(`cron_delete: ${String(result.output)}`);
    }
  }

  console.log("\n=== All smoke tests passed! ===");

  // Cleanup
  api.flush();
  try { rmSync(DATA_DIR, { recursive: true }); } catch {}
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
