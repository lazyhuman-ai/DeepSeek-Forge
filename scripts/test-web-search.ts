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

console.log(`Testing web search on: ${BASE_URL}`);
console.log(`Model: ${MODEL}\n`);

async function testWebSearch() {
  // Test 1: Try with a "search" tool (DeepSeek V3.1-Terminus built-in style)
  console.log("=== Test 1: Built-in 'search' tool ===");
  await runTest("search", {
    type: "function",
    function: {
      name: "search",
      description: "Searches for information related to query and displays topn results.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
          topn: { type: "integer", default: 10, description: "Number of results" },
          source: { type: "string", default: "web", description: "Search source" },
        },
        required: ["query"],
      },
    },
  });

  // Test 2: Try with Anthropic-style web_search tool
  console.log("\n=== Test 2: Anthropic-style 'web_search_20250305' tool ===");
  await runTest("web_search_20250305", {
    type: "web_search_20250305",
    name: "web_search",
    description: "Search the web",
  });

  // Test 3: No tools (control — just ask for current info)
  console.log("\n=== Test 3: No tools (control) ===");
  await runTest(null, null);
}

async function runTest(toolName: string | null, toolDef: unknown) {
  const tools = toolDef ? [toolDef] : undefined;

  const body: Record<string, unknown> = {
    model: MODEL,
    messages: [
      {
        role: "user",
        content: "What is the current Bitcoin price? Just give me the approximate price in USD right now.",
      },
    ],
  };

  if (tools) {
    body.tools = tools;
  }

  console.log("Sending request...");
  const start = Date.now();
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
        tool_calls?: Array<{
          id: string;
          function: { name: string; arguments: string };
        }>;
      };
      finish_reason: string;
    }>;
    error?: { message: string };
  };

  const elapsed = Date.now() - start;

  if (data.error) {
    console.log(`  ERROR (${elapsed}ms): ${data.error.message}`);
    return;
  }

  const choice = data.choices?.[0];
  if (!choice) {
    console.log(`  No choices in response (${elapsed}ms)`);
    console.log(`  Raw: ${JSON.stringify(data).slice(0, 300)}`);
    return;
  }

  console.log(`  finish_reason: ${choice.finish_reason} (${elapsed}ms)`);

  if (choice.finish_reason === "tool_calls" && choice.message.tool_calls) {
    console.log(`  TOOL CALLS DETECTED:`);
    for (const tc of choice.message.tool_calls) {
      console.log(`    - ${tc.function.name}(${tc.function.arguments.slice(0, 200)})`);
    }
  } else {
    const content = choice.message.content ?? "";
    console.log(`  Model answered directly: ${content.slice(0, 300)}`);
  }
}

async function main() {
  try {
    await testWebSearch();
    console.log("\nDone.");
  } catch (err) {
    console.error("Fatal error:", err);
  }
}

main();
