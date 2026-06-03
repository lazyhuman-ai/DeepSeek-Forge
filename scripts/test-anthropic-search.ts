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

const BASE_URL = (process.env.BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, "");
const API_KEY = process.env.API_KEY ?? "";
const MODEL = process.env.LLM_MODEL ?? "deepseek-v4-pro";

async function testEndpoint(endpoint: string, label: string) {
  console.log(`\n=== ${label} ===`);
  console.log(`POST ${endpoint}`);

  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: 1024,
    messages: [
      { role: "user", content: "What is the current Bitcoin price in USD? Just give me the approximate price." },
    ],
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
      },
    ],
  };

  try {
    const start = Date.now();
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    const elapsed = Date.now() - start;
    const text = await resp.text();

    console.log(`  Status: ${resp.status} (${elapsed}ms)`);

    if (resp.ok) {
      const data = JSON.parse(text);
      // Look for server-side web search results
      const content = data.content ?? [];
      for (const block of content) {
        if (block.type === "server_tool_use" || block.type === "web_search_tool_result") {
          console.log(`  SERVER-SIDE SEARCH DETECTED: type=${block.type}`);
          console.log(`  ${JSON.stringify(block).slice(0, 500)}`);
        } else if (block.type === "text") {
          console.log(`  text: ${block.text?.slice(0, 300)}`);
        } else {
          console.log(`  block type: ${block.type}`);
        }
      }
      if (data.stop_reason) console.log(`  stop_reason: ${data.stop_reason}`);
    } else {
      console.log(`  Response: ${text.slice(0, 500)}`);
    }
  } catch (err) {
    console.log(`  Error: ${(err as Error).message}`);
  }
}

async function main() {
  // Test 1: Anthropic Messages API format
  await testEndpoint(`${BASE_URL}/anthropic/v1/messages`, "Anthropic endpoint (/anthropic/v1/messages)");

  // Test 2: Maybe just /anthropic
  await testEndpoint(`${BASE_URL}/anthropic`, "Anthropic endpoint (/anthropic)");

  // Test 3: OpenAI endpoint with Anthropic-style tool (for comparison)
  console.log(`\n=== OpenAI endpoint with Anthropic tool (for comparison) ===`);
  console.log(`POST ${BASE_URL}/v1/chat/completions`);
  const resp = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "What is the current Bitcoin price?" }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  const text = await resp.text();
  console.log(`  Status: ${resp.status}`);
  console.log(`  ${text.slice(0, 400)}`);
}

main().catch(console.error);
