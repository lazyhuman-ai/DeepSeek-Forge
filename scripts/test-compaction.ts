import { existsSync, rmSync } from "node:fs";
import { CoreAPI } from "../src/core/core-api.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import type { ModelProvider, ModelMessage, ModelResponse } from "../src/agent/model-provider.js";
import type { ToolDefinition } from "../src/tools/schemas.js";
import type { CompactionBlock } from "../src/streams/event-types.js";

const DATA_DIR = ".forge-test-compaction";

function cleanup() {
  if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true });
}

// Returns low-usage stop responses for the first N calls,
// then a high-usage tool_calls response to trigger compaction,
// then a stop response.
function createHighUsageProvider(triggerAfterCalls: number): ModelProvider {
  let callCount = 0;
  return {
    async generate(
      _messages: ModelMessage[],
      _tools?: ToolDefinition[],
    ): Promise<ModelResponse> {
      callCount++;
      if (callCount <= triggerAfterCalls) {
        return {
          text: `Response ${callCount} — building up context with some padding to make the token count seem realistic`,
          finishReason: "stop",
          rawUsage: { input_tokens: 5_000 * callCount, output_tokens: 30 },
        };
      }
      if (callCount === triggerAfterCalls + 1) {
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "tc_1", name: "echo", args: { message: "trigger compaction" } }],
          rawUsage: { input_tokens: 95_000, output_tokens: 50 },
        };
      }
      return {
        text: "Final response after compaction",
        finishReason: "stop",
        rawUsage: { input_tokens: 20_000, output_tokens: 20 },
      };
    },
  };
}

async function main() {
  cleanup();

  const registry = new ToolRegistry();
  registry.register({
    name: "echo",
    description: "Echo a message",
    params: { message: { type: "string", description: "Message to echo" } },
    handler: async (args) => ({ output: `Echo: ${args.message}`, isError: false }),
    isConcurrencySafe: true,
    isReadOnly: true,
  });

  const api = new CoreAPI(registry, { dataDir: DATA_DIR });

  // Build up context with several turns before triggering compaction.
  // Each turn adds 2 events (user_message + assistant_message).
  // After 3 turns we have 6 events, then the 4th turn triggers compaction.
  const provider = createHighUsageProvider(3);
  api.setModelProvider(provider);

  const session = api.createSession("Compaction Test");

  // Turn 1-3: low usage, build up events
  for (let t = 1; t <= 3; t++) {
    api.appendUserMessage(session.id, `Message ${t}`);
    await api.runTurn(session.id);
    console.log(`Turn ${t} complete, events: ${api.getThread(session.id).length}`);
  }

  // Turn 4: should trigger compaction (high token usage)
  console.log("\n=== Turn 4: triggering compaction ===\n");
  api.appendUserMessage(session.id, "Message 4 — this one triggers compaction");
  await api.runTurn(session.id);

  const thread = api.getThread(session.id);
  console.log(`\nFinal thread events: ${thread.length}`);
  for (const e of thread) {
    if (e.type === "compaction_block") {
      const cb = e as CompactionBlock;
      console.log(`  COMPACTION: seq=${e.seq} covers #${cb.coversEvents[0]}–#${cb.coversEvents[1]}, summary: ${cb.summary}`);
    } else {
      const text = "text" in e ? (e as { text: string }).text.slice(0, 60) : "";
      console.log(`  seq=${e.seq} type=${e.type} ${text}`);
    }
  }

  const compactionBlocks = thread.filter((e) => e.type === "compaction_block");
  if (compactionBlocks.length > 0) {
    console.log(`\n✓ Compaction triggered: ${compactionBlocks.length} block(s)`);
  } else {
    console.log("\n✗ No compaction block found");
    process.exit(1);
  }

  api.flush();
  cleanup();
  console.log("\n✓ Compaction test completed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
