import { createLogger } from "../../core/logger.js";
import { loadDotEnv } from "../../core/env.js";
import { clearRunState, runLogPath } from "./run-state.js";
import { startHttpGateway } from "./app.js";

const logger = createLogger("http-main");

async function main() {
  loadDotEnv();
  const dataDir = process.env.FORGE_DATA_DIR ?? ".forge";
  const started = await startHttpGateway({
    dataDir,
    logPath: runLogPath(dataDir),
  });

  logger.info(`DeepSeek-Forge HTTP gateway: ${started.url}`);
  logger.info(`SSE events: ${started.url}/events`);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down...");
    started.shutdown()
      .catch((err) => logger.error("HTTP gateway shutdown failed", err))
      .finally(() => {
        clearRunState(started.dataDir);
        process.exit(0);
      });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
