import { CoreAPI } from "../core/core-api.js";
import { loadDotEnv } from "../core/env.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import type { McpLaunchMode, McpServerConfig, McpTransportKind, McpTrust } from "../mcp/types.js";

type ParsedArgs = {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "doctor", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const item = rest[i]!;
    if (!item.startsWith("--")) {
      positionals.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command, positionals, flags };
}

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function flagBool(flags: Record<string, string | boolean>, key: string): boolean | undefined {
  const value = flags[key];
  return typeof value === "boolean" ? value : undefined;
}

function flagNumber(flags: Record<string, string | boolean>, key: string): number | undefined {
  const value = flagString(flags, key);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function csv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function jsonRecord(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (typeof val === "string") result[key] = val;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function transport(value: string | undefined): McpTransportKind | undefined {
  if (!value) return undefined;
  if (value === "stdio" || value === "streamable-http" || value === "sse") return value;
  throw new Error(`Invalid transport: ${value}`);
}

function launchMode(value: string | undefined): McpLaunchMode | undefined {
  if (!value) return undefined;
  if (value === "eager" || value === "background" || value === "lazy") return value;
  throw new Error(`Invalid launch mode: ${value}`);
}

function trust(value: string | undefined): McpTrust | undefined {
  if (!value) return undefined;
  if (value === "trusted" || value === "untrusted" || value === "quarantined") return value;
  throw new Error(`Invalid trust: ${value}`);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): void {
  process.stdout.write(`DeepSeek-Forge MCP CLI

Usage:
  npm run mcp -- doctor
  npm run mcp -- list
  npm run mcp -- tools
  npm run mcp -- add --name filesystem --transport stdio --command npx --args "-y,@modelcontextprotocol/server-filesystem,."
  npm run mcp -- enable <serverId>
  npm run mcp -- disable <serverId>
  npm run mcp -- retry <serverId>
  npm run mcp -- auth <serverId>
  npm run mcp -- remove <serverId>
  npm run mcp -- catalog
  npm run mcp -- install <catalogId>
  npm run mcp -- import

Flags:
  --data-dir .forge
  --name <name>
  --transport stdio|streamable-http|sse
  --command <cmd>
  --args comma,separated,args
  --url <url>
  --cwd <path>
  --env '{"KEY":"value"}'
  --headers '{"Authorization":"Bearer ..."}'
  --launch eager|background|lazy
  --trust trusted|untrusted|quarantined
  --enabled
  --allow-sampling
  --allow-elicitation
`);
}

function createApi(dataDir: string): CoreAPI {
  const registry = new ToolRegistry();
  const api = new CoreAPI(registry, { dataDir });
  api.ensureProjectForPath(process.cwd(), { current: true });
  api.registerBuiltInTools();
  api.initToolPolicy();
  api.initMcpEcosystem();
  return api;
}

function serverInput(flags: Record<string, string | boolean>): Omit<McpServerConfig, "id"> {
  const name = flagString(flags, "name");
  if (!name) throw new Error("Missing --name.");
  const input: Omit<McpServerConfig, "id"> = {
    name,
    enabled: flagBool(flags, "enabled") ?? false,
    transport: transport(flagString(flags, "transport")) ?? "stdio",
    launchMode: launchMode(flagString(flags, "launch")) ?? "lazy",
    trust: trust(flagString(flags, "trust")) ?? "untrusted",
  };
  const args = csv(flagString(flags, "args"));
  const env = jsonRecord(flagString(flags, "env"));
  const headers = jsonRecord(flagString(flags, "headers"));
  const roots = csv(flagString(flags, "roots"));
  const timeoutMs = flagNumber(flags, "timeout-ms");
  const connectTimeoutMs = flagNumber(flags, "connect-timeout-ms");
  const command = flagString(flags, "command");
  const cwd = flagString(flags, "cwd");
  const url = flagString(flags, "url");
  if (command) input.command = command;
  if (args) input.args = args;
  if (cwd) input.cwd = cwd;
  if (env) input.env = env;
  if (url) input.url = url;
  if (headers) input.headers = headers;
  if (roots) input.roots = roots;
  if (timeoutMs !== undefined) input.timeoutMs = timeoutMs;
  if (connectTimeoutMs !== undefined) input.connectTimeoutMs = connectTimeoutMs;
  const allowSampling = flagBool(flags, "allow-sampling");
  const allowElicitation = flagBool(flags, "allow-elicitation");
  if (allowSampling !== undefined) input.allowSampling = allowSampling;
  if (allowElicitation !== undefined) input.allowElicitation = allowElicitation;
  return input;
}

async function main(): Promise<void> {
  loadDotEnv();
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") {
    usage();
    return;
  }

  const dataDir = flagString(parsed.flags, "data-dir") ?? process.env.FORGE_DATA_DIR ?? ".forge";
  const api = createApi(dataDir);

  switch (parsed.command) {
    case "doctor":
    case "status": {
      await api.startMcpEcosystem();
      print(api.getMcpStatus());
      return;
    }
    case "list": {
      await api.startMcpEcosystem();
      print(api.getMcpServers());
      return;
    }
    case "tools": {
      await api.startMcpEcosystem();
      print(api.getMcpTools());
      return;
    }
    case "events": {
      print(api.getMcpEvents(flagNumber(parsed.flags, "after-seq") ?? 0));
      return;
    }
    case "add": {
      print(api.addMcpServer(serverInput(parsed.flags)));
      return;
    }
    case "enable": {
      print(await api.enableMcpServer(parsed.positionals[0] ?? ""));
      return;
    }
    case "disable": {
      print(await api.disableMcpServer(parsed.positionals[0] ?? ""));
      return;
    }
    case "retry":
    case "connect": {
      print(await api.retryMcpServer(parsed.positionals[0] ?? ""));
      return;
    }
    case "auth": {
      print(await api.startMcpOAuth(parsed.positionals[0] ?? ""));
      return;
    }
    case "remove": {
      print({ removed: await api.removeMcpServer(parsed.positionals[0] ?? "") });
      return;
    }
    case "catalog": {
      print(api.getMcpCatalog());
      return;
    }
    case "install": {
      print(await api.installMcpCatalogEntry(parsed.positionals[0] ?? ""));
      return;
    }
    case "import": {
      api.initMcpEcosystem();
      print(api.getMcpServers());
      return;
    }
    default:
      usage();
      throw new Error(`Unknown MCP command: ${parsed.command}`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
