import { CoreAPI, OpenAIProvider, ToolRegistry } from "../src/index.js";

function makeReadTool(registry: ToolRegistry) {
  registry.register({
    name: "read_file",
    description: "Read the contents of a file at the given path",
    params: {
      path: { type: "string", description: "Path to the file to read" },
    },
    handler: async (args) => {
      const fs = await import("node:fs");
      const path = args.path as string;
      if (!fs.existsSync(path)) {
        return `Error: file not found: ${path}`;
      }
      return fs.readFileSync(path, "utf-8");
    },
  });
}

async function main() {
  const registry = new ToolRegistry();
  makeReadTool(registry);

  const api = new CoreAPI(registry);

  const provider = new OpenAIProvider();
  api.setModelProvider(provider);

  const session = api.createSession("Manual test");
  api.appendUserMessage(session.id, "Read the file package.json and tell me what dependencies this project uses.");

  console.log(`Session: ${session.id}`);
  console.log("Running turn...");

  try {
    const result = await api.runTurn(session.id);

    const thread = api.getThread(session.id);
    for (const event of thread) {
      if (event.type === "assistant_message") {
        console.log(`\nAssistant: ${event.text}`);
      } else if (event.type === "tool_call") {
        console.log(`\nTool call: ${event.toolName}(${JSON.stringify(event.args)})`);
      } else if (event.type === "tool_result") {
        const preview = typeof event.result === "string"
          ? event.result.slice(0, 200)
          : JSON.stringify(event.result).slice(0, 200);
        console.log(`Tool result (${event.isError ? "error" : "ok"}): ${preview}...`);
      }
    }

    console.log(`\nStatus: ${result.status}, Outcome: completed`);
  } catch (err) {
    console.error("Turn error:", err);
  }
}

main();
