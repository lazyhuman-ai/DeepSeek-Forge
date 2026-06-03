import { CoreAPI } from "../../core/core-api.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { DeepSeekProvider } from "../../agent/deepseek-provider.js";
import { ReplGateway } from "./repl-gateway.js";
import { createLogger } from "../../core/logger.js";
import { BrowserRuntime } from "../../runtimes/browser/browser-runtime.js";
import { loadDotEnv } from "../../core/env.js";

const logger = createLogger("repl-main");

async function main() {
  loadDotEnv();
  const dataDir = process.env.FORGE_DATA_DIR ?? ".forge";
  const registry = new ToolRegistry();
  const api = new CoreAPI(registry, { dataDir });
  api.ensureProjectForPath(process.cwd(), { current: true });
  api.registerBuiltInTools();
  api.initSupervisor();
  api.initScheduler();
  api.initMemoryManager();
  api.initSkillEcosystem();
  await initBrowserRuntimeFromEnv(api);

  const provider = new DeepSeekProvider();
  api.setModelProvider(provider);
  api.initToolPolicy();
  api.initMcpEcosystem();

  const loaded = api.loadSessions();
  if (loaded.length > 0) {
    logger.info(`Loaded ${loaded.length} existing session(s).`);
  }
  const rehydrated = await api.rehydrateAfterStartup();
  if (rehydrated.requeuedSessions.length > 0) {
    logger.info(`Requeued ${rehydrated.requeuedSessions.length} running session(s) after startup.`);
  }
  if (rehydrated.startupBlockedSessions.length > 0) {
    logger.info(`Blocked ${rehydrated.startupBlockedSessions.length} interrupted running session(s) after startup.`);
  }

  const repl = new ReplGateway(api);
  repl.start();
}

async function initBrowserRuntimeFromEnv(api: CoreAPI): Promise<void> {
  const cdpUrl = process.env.FORGE_BROWSER_CDP_URL;
  if (!cdpUrl) return;
  const runtimeName = process.env.FORGE_BROWSER_RUNTIME_NAME ?? "chrome";
  api.initRuntimeManager();
  api.registerBrowserRuntime(runtimeName, new BrowserRuntime({
    cdpUrl,
    autoReconnect: process.env.FORGE_BROWSER_AUTO_RECONNECT !== "0",
  }));
  await api.startRuntimes();
  logger.info(`Browser runtime registered: ${runtimeName} (${cdpUrl})`);
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
