import { CoreAPI } from "../src/core/core-api.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { AnthropicProvider } from "../src/agent/anthropic-provider.js";

const DATA_DIR = ".forge-e2e-test";

async function main() {
  const { existsSync, rmSync } = await import("node:fs");
  if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true });

  const registry = new ToolRegistry();
  const api = new CoreAPI(registry, { dataDir: DATA_DIR });
  api.registerBuiltInTools();

  const provider = new AnthropicProvider();
  api.setModelProvider(provider);

  const session = api.createSession("e2e test");
  console.log(`Session: ${session.id}`);

  // Turn 1: web search (produces thinking blocks from DeepSeek)
  console.log("\n=== Turn 1: web search ===");
  api.appendUserMessage(session.id, "Search the web: what time is it in Beijing right now?");

  try {
    await api.runTurn(session.id);
    console.log(`Turn 1 complete, status: ${session.status}`);

    const thread1 = api.getThread(session.id);
    console.log(`Events: ${thread1.length}`);
    for (const e of thread1) {
      if (e.type === "assistant_message") {
        console.log(`  assistant: ${e.text.slice(0, 150)}...`);
      } else if (e.type === "tool_call") {
        console.log(`  tool_call: ${e.toolName}`);
      }
    }
  } catch (err) {
    console.error("Turn 1 FAILED:", err);
    process.exit(1);
  }

  // Turn 2: use bash tool (previous thinking blocks must be echoed back)
  console.log("\n=== Turn 2: bash tool ===");
  api.appendUserMessage(session.id, "Now use bash to run `date` and tell me the time on this computer.");

  try {
    await api.runTurn(session.id);
    console.log(`Turn 2 complete, status: ${session.status}`);

    const thread2 = api.getThread(session.id);
    console.log(`Events: ${thread2.length}`);
    for (const e of thread2) {
      if (e.type === "assistant_message") {
        console.log(`  assistant: ${e.text.slice(0, 200)}...`);
      } else if (e.type === "tool_call") {
        console.log(`  tool_call: ${e.toolName}(${JSON.stringify(e.args).slice(0, 80)})`);
      } else if (e.type === "tool_result") {
        console.log(`  tool_result: ${e.toolName} -> ${String(e.result).slice(0, 100)}`);
      }
    }
  } catch (err) {
    console.error("Turn 2 FAILED:", err);
    process.exit(1);
  }

  api.flush();
  if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true });
  console.log("\n✓ E2E test passed — both turns completed successfully");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
