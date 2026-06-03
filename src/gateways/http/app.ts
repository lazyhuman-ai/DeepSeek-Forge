import type { Server } from "node:http";
import { CoreAPI } from "../../core/core-api.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { DeepSeekProvider } from "../../agent/deepseek-provider.js";
import { BrowserRuntime } from "../../runtimes/browser/browser-runtime.js";
import { createLogger } from "../../core/logger.js";
import { HttpGateway } from "./http-gateway.js";
import { createHttpServer, httpOptionsFromEnv, type HttpServerOptions } from "./http-server.js";
import { runLogPath, writeRunState } from "./run-state.js";
import { ProviderConfigStore, deepSeekOptionsFromConfig } from "../../config/provider-config-store.js";

export const DEFAULT_HTTP_PORT = 3000;
export const DEFAULT_HTTP_HOST = "127.0.0.1";

export type StartedHttpGateway = {
  api: CoreAPI;
  gateway: HttpGateway;
  server: Server;
  host: string;
  port: number;
  url: string;
  dataDir: string;
  requeuedSessions: string[];
  startupBlockedSessions: string[];
  shutdown: () => Promise<void>;
};

export type StartHttpGatewayOptions = {
  host?: string;
  port?: number;
  dataDir?: string;
  writeRunState?: boolean;
  logPath?: string;
  httpOptions?: HttpServerOptions;
};

const logger = createLogger("http-app");

export async function startHttpGateway(options?: StartHttpGatewayOptions): Promise<StartedHttpGateway> {
  const port = options?.port ?? parseInt(process.env.HTTP_PORT ?? String(DEFAULT_HTTP_PORT), 10);
  const host = options?.host ?? process.env.HTTP_HOST ?? DEFAULT_HTTP_HOST;
  const dataDir = options?.dataDir ?? process.env.FORGE_DATA_DIR ?? ".forge";

  const registry = new ToolRegistry();
  const api = new CoreAPI(registry, { dataDir });
  api.ensureDefaultProject();
  api.registerBuiltInTools();
  api.initSupervisor();
  api.initScheduler();
  api.initMemoryManager();
  api.initSkillEcosystem();
  api.initToolPolicy();
  await initBrowserRuntimeFromEnv(api);
  initWebridgeRuntimeFromEnv(api);

  const providerConfigStore = new ProviderConfigStore(`${dataDir}/config`);
  const applyProviderConfig = () => {
    api.setModelProvider(new DeepSeekProvider(deepSeekOptionsFromConfig(providerConfigStore.getEffectiveConfig())));
  };
  applyProviderConfig();
  api.initMcpEcosystem({ baseUrl: `http://${host}:${port}` });

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

  const gateway = new HttpGateway(api);
  const baseHttpOptions = httpOptionsFromEnv(dataDir);
  const server = createHttpServer(api, gateway, {
    ...baseHttpOptions,
    ...options?.httpOptions,
    enableUi: options?.httpOptions?.enableUi ?? true,
    uiDir: options?.httpOptions?.uiDir ?? `${process.cwd()}/web/dist`,
    providerConfigStore: options?.httpOptions?.providerConfigStore ?? providerConfigStore,
    applyProviderConfig: options?.httpOptions?.applyProviderConfig ?? (() => applyProviderConfig()),
    discovery: {
      host,
      port,
      dataDir,
    },
  });

  await listen(server, port, host);
  const url = `http://${host}:${port}`;

  if (options?.writeRunState !== false) {
    writeRunState(dataDir, {
      pid: process.pid,
      host,
      port,
      url,
      logPath: options?.logPath ?? runLogPath(dataDir),
    });
  }

  return {
    api,
    gateway,
    server,
    host,
    port,
    url,
    dataDir,
    requeuedSessions: rehydrated.requeuedSessions,
    startupBlockedSessions: rehydrated.startupBlockedSessions,
    shutdown: async () => {
      gateway.destroy();
      await api.shutdown();
      await closeServer(server);
    },
  };
}

function initWebridgeRuntimeFromEnv(api: CoreAPI): void {
  if (process.env.FORGE_WEBRIDGE_ENABLED === "0") return;
  const runtimeName = process.env.FORGE_WEBRIDGE_RUNTIME_NAME ?? "webridge";
  api.initWebridgeRuntime({
    name: runtimeName,
    ...(process.env.FORGE_WEBRIDGE_COMMAND_TIMEOUT_MS
      ? { commandTimeoutMs: Math.max(1, parseInt(process.env.FORGE_WEBRIDGE_COMMAND_TIMEOUT_MS, 10)) }
      : {}),
    ...(process.env.FORGE_WEBRIDGE_STALE_AFTER_MS
      ? { staleAfterMs: Math.max(1, parseInt(process.env.FORGE_WEBRIDGE_STALE_AFTER_MS, 10)) }
      : {}),
    ...(process.env.FORGE_WEBRIDGE_OFFLINE_AFTER_MS
      ? { offlineAfterMs: Math.max(1, parseInt(process.env.FORGE_WEBRIDGE_OFFLINE_AFTER_MS, 10)) }
      : {}),
    ...(process.env.FORGE_WEBRIDGE_HEALTH_CHECK_INTERVAL_MS
      ? { healthCheckIntervalMs: Math.max(0, parseInt(process.env.FORGE_WEBRIDGE_HEALTH_CHECK_INTERVAL_MS, 10)) }
      : {}),
  });
  logger.info(`ForgeWebridge runtime registered: ${runtimeName}`);
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

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      if (err) reject(err);
      else resolve();
    });
  });
}
