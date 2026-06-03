import { readFileSync, existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

function loadEnv(): void {
  const envPath = pathResolve(".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnv();

const BASE_URL = process.env.BASE_URL ?? "https://api.deepseek.com";
const API_KEY = process.env.API_KEY ?? "";
const MODEL = process.env.LLM_MODEL ?? "deepseek-v4-pro";

async function send(messages: unknown[], tools?: unknown[]) {
  const body: Record<string, unknown> = { model: MODEL, messages };
  if (tools) body.tools = tools;

  const resp = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json() as {
    choices?: Array<{
      message: {
        role: string;
        content?: string | null;
        reasoning_content?: string;
        tool_calls?: Array<{
          id: string;
          function: { name: string; arguments: string };
        }>;
      };
      finish_reason: string;
    }>;
    error?: { message: string };
  };

  if (data.error) {
    console.log(`  ERROR: ${data.error.message}`);
    return null;
  }
  return data.choices?.[0] ?? null;
}

async function main() {
  const searchTool = {
    type: "function",
    function: {
      name: "search",
      description: "Searches for information related to query and displays topn results.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
          topn: { type: "integer", default: 10 },
          source: { type: "string", default: "web" },
        },
        required: ["query"],
      },
    },
  };

  console.log("=== Turn 1: Ask about Bitcoin price with search tool ===\n");
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: "What is the current Bitcoin price in USD right now?" },
  ];

  const turn1 = await send(messages, [searchTool]);
  if (!turn1) return;

  console.log(`finish_reason: ${turn1.finish_reason}`);

  if (turn1.message.tool_calls) {
    console.log("Tool calls:");
    for (const tc of turn1.message.tool_calls) {
      console.log(`  ${tc.function.name}: ${tc.function.arguments}`);
    }

    // Add assistant message — MUST include reasoning_content for DeepSeek thinking mode
    const assistantMsg: Record<string, unknown> = {
      role: "assistant",
      content: turn1.message.content,
      tool_calls: turn1.message.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: tc.function,
      })),
    };
    if (turn1.message.reasoning_content) {
      assistantMsg.reasoning_content = turn1.message.reasoning_content;
      console.log(`  (has reasoning_content: ${turn1.message.reasoning_content.length} chars)`);
    }
    messages.push(assistantMsg);

    // Turn 2: Send a placeholder result
    console.log("\n=== Turn 2: Send placeholder tool result ===");
    const messages2 = [
      ...messages,
      {
        role: "tool",
        tool_call_id: turn1.message.tool_calls[0]!.id,
        content: "[search results placeholder — testing whether API handles search server-side or expects us to]",
      },
    ];
    const turn2 = await send(messages2, [searchTool]);
    if (turn2) {
      console.log(`finish_reason: ${turn2.finish_reason}`);
      console.log(`content: ${turn2.message.content?.slice(0, 500)}`);
    }
  }
}

main().catch(console.error);
