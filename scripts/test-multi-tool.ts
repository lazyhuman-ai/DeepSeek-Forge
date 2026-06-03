import { AnthropicProvider } from "../src/agent/anthropic-provider.js";
import { webSearchTool } from "../src/tools/built-in/web-search.js";

const BASE_URL = process.env.BASE_URL ?? "https://api.deepseek.com";
const API_KEY = process.env.API_KEY ?? "";
const MODEL = process.env.LLM_MODEL ?? "deepseek-v4-pro";

const provider = new AnthropicProvider({
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  model: MODEL,
});

// Dummy tools — we won't actually execute them, just observe tool calls
const dumbTools = [
  {
    name: "get_weather",
    description: "Get current weather for a city",
    params: {
      city: { type: "string", description: "City name" },
    },
    handler: async () => ({}),
  },
  {
    name: "get_time",
    description: "Get current time for a city",
    params: {
      city: { type: "string", description: "City name" },
    },
    handler: async () => ({}),
  },
  {
    name: "calculator",
    description: "Evaluate a math expression",
    params: {
      expression: { type: "string", description: "Math expression" },
    },
    handler: async () => ({}),
  },
];

async function testMultiToolCalls() {
  console.log("=== Test: Multiple tool_use blocks in one response ===\n");
  console.log("Prompt: 'What's the weather AND time in Tokyo? Use the tools.'\n");

  const response = await provider.generate(
    [
      {
        role: "user",
        content:
          "What's the weather AND time in Tokyo right now? You MUST use both the get_weather and get_time tools.",
      },
    ],
    dumbTools,
  );

  console.log(`finishReason: ${response.finishReason}`);
  console.log(`text: ${response.text?.slice(0, 200) ?? "(none)"}`);
  console.log(`toolCalls count: ${response.toolCalls?.length ?? 0}`);
  if (response.toolCalls) {
    for (const tc of response.toolCalls) {
      console.log(`  - ${tc.name}(${JSON.stringify(tc.args)})`);
    }
  }

  // Show raw content blocks
  if (response.rawContent) {
    console.log(`\nRaw content blocks (${response.rawContent.length}):`);
    for (const block of response.rawContent) {
      const b = block as Record<string, unknown>;
      console.log(`  type=${b.type}${b.name ? " name=" + b.name : ""}${b.id ? " id=" + b.id : ""}`);
    }
  }

  console.log();
  return response;
}

async function testMixedServerClient() {
  console.log("=== Test: Web search + client-side tool in one turn ===\n");
  console.log("Prompt: Search Bitcoin price, then calculate something with it.\n");

  const response = await provider.generate(
    [
      {
        role: "user",
        content:
          "Search the web for the current Bitcoin price, then use the calculator tool to compute what 2.5 Bitcoins are worth in USD. You MUST use both tools.",
      },
    ],
    [dumbTools[2]!, webSearchTool], // calculator + web_search as regular tool
  );

  console.log(`finishReason: ${response.finishReason}`);
  console.log(`text: ${response.text?.slice(0, 300) ?? "(none)"}`);
  console.log(`toolCalls count: ${response.toolCalls?.length ?? 0}`);
  if (response.toolCalls) {
    for (const tc of response.toolCalls) {
      console.log(`  - ${tc.name}(${JSON.stringify(tc.args)})`);
    }
  }

  if (response.rawContent) {
    console.log(`\nRaw content blocks (${response.rawContent.length}):`);
    for (const block of response.rawContent) {
      const b = block as Record<string, unknown>;
      console.log(`  type=${b.type}${b.name ? " name=" + b.name : ""}${b.id ? " id=" + b.id : ""}`);
    }
  }

  console.log();
  return response;
}

async function testMultiToolWithTurn2(turn1: Awaited<ReturnType<typeof provider.generate>>) {
  if (!turn1.toolCalls || turn1.toolCalls.length < 2) {
    console.log("  (skipping turn 2 — less than 2 tool calls in turn 1)\n");
    return;
  }

  console.log("=== Turn 2: Send tool results back ===\n");

  // Build messages with anthropicContent preservation
  const messages: Array<Record<string, unknown>> = [
    {
      role: "user",
      content:
        "What's the weather AND time in Tokyo right now? You MUST use both the get_weather and get_time tools.",
    },
  ];

  // Simulate what AgentLoop + buildContext now produces:
  // - First ToolCall carries anthropicContent (the full response content blocks)
  // - Subsequent ToolCalls have NO anthropicContent
  // - ToolResults carry the real Anthropic tool_use_id
  for (let i = 0; i < turn1.toolCalls.length; i++) {
    const tc = turn1.toolCalls[i]!;
    console.log(`  Adding ToolCall ${i + 1}/${turn1.toolCalls.length}: ${tc.name}(${JSON.stringify(tc.args)})`);

    messages.push({
      role: "assistant",
      content: i === 0 ? (turn1.text ?? "") : "",
      tool_calls: [{ id: tc.id, name: tc.name, args: tc.args }],
      anthropicContent: i === 0 ? turn1.rawContent : undefined,  // only first call
    });

    messages.push({
      role: "tool",
      content: tc.name === "get_weather"
        ? "Tokyo: 22°C, partly cloudy, humidity 65%"
        : "Tokyo: 3:45 PM JST",
      tool_call_id: tc.id,  // real Anthropic ID
    });
  }

  console.log(`\n  Total messages in turn 2: ${messages.length}`);

  try {
    const turn2 = await provider.generate(
      messages as Parameters<typeof provider.generate>[0],
      dumbTools,
    );
    console.log(`\n  Turn 2 finishReason: ${turn2.finishReason}`);
    console.log(`  Turn 2 text: ${turn2.text?.slice(0, 400) ?? "(none)"}`);
  } catch (err) {
    console.log(`\n  Turn 2 ERROR: ${(err as Error).message.slice(0, 300)}`);
  }
  console.log();
}

async function main() {
  try {
    // Test 1: Multiple tool calls
    const turn1Multi = await testMultiToolCalls();
    await testMultiToolWithTurn2(turn1Multi);

    // Test 2: Mixed server-side + client-side
    await testMixedServerClient();
  } catch (err) {
    console.error("Test failed:", err);
  }
}

main();
