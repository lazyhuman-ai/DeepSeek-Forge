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

async function testBasicText() {
  console.log("=== Test 1: Basic text generation (no tools) ===\n");

  const response = await provider.generate([
    { role: "user", content: "Say hello in exactly 3 words." },
  ]);

  console.log(`finishReason: ${response.finishReason}`);
  console.log(`text: ${response.text}`);
  console.log(`toolCalls: ${response.toolCalls ? response.toolCalls.length : 0}`);
  console.log();
}

async function testWebSearch() {
  console.log("=== Test 2: Web search (server-side tool) ===\n");

  const response = await provider.generate(
    [
      {
        role: "user",
        content:
          "What is the current Bitcoin price in USD? Just give me the approximate price right now.",
      },
    ],
    [webSearchTool],
  );

  console.log(`finishReason: ${response.finishReason}`);
  console.log(`text: ${response.text.slice(0, 500)}`);
  console.log(`toolCalls: ${response.toolCalls ? response.toolCalls.length : 0}`);
  console.log();
}

async function testClientToolCalling() {
  console.log("=== Test 3: Client-side tool calling ===\n");

  // Turn 1: Ask something that requires a tool
  const turn1 = await provider.generate(
    [
      {
        role: "user",
        content: "If I have $100 and buy 3 items at $25 each, how much do I have left? Use the calculator tool.",
      },
    ],
    [
      {
        name: "calculator",
        description: "Evaluate a mathematical expression",
        params: {
          expression: {
            type: "string",
            description: "The math expression to evaluate",
          },
        },
        handler: async () => ({}),
      },
    ],
  );

  console.log(`Turn 1 finishReason: ${turn1.finishReason}`);
  console.log(`Turn 1 text: ${turn1.text?.slice(0, 200) ?? "(none)"}`);

  if (turn1.toolCalls && turn1.toolCalls.length > 0) {
    console.log(`Turn 1 toolCalls: ${turn1.toolCalls.length}`);
    for (const tc of turn1.toolCalls) {
      console.log(`  - ${tc.name}(${JSON.stringify(tc.args)})`);
    }

    // Build messages for turn 2
    const messages = [
      {
        role: "user" as const,
        content: "If I have $100 and buy 3 items at $25 each, how much do I have left? Use the calculator tool.",
      },
      {
        role: "assistant" as const,
        content: turn1.text ?? "",
        tool_calls: turn1.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          args: tc.args,
        })),
        anthropicContent: turn1.rawContent,
      },
      {
        role: "tool" as const,
        content: "25",
        tool_call_id: turn1.toolCalls[0].id,
      },
    ];

    if (turn1.reasoningContent) {
      messages[1].reasoning_content = turn1.reasoningContent;
    }

    const turn2 = await provider.generate(messages);

    console.log(`\nTurn 2 finishReason: ${turn2.finishReason}`);
    console.log(`Turn 2 text: ${turn2.text?.slice(0, 500) ?? "(none)"}`);
  }
  console.log();
}

async function main() {
  try {
    await testBasicText();
    await testWebSearch();
    await testClientToolCalling();
    console.log("All tests complete.");
  } catch (err) {
    console.error("Test failed:", err);
  }
}

main();
