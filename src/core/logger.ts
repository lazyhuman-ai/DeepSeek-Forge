// ── Simple structured logger — zero dependencies ──

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function normalizeLevel(raw: string | undefined): LogLevel {
  if (raw && raw in LEVEL_ORDER) return raw as LogLevel;
  return "info";
}

let currentLevel: LogLevel = normalizeLevel(process.env.LOG_LEVEL);

export function setLogLevel(level: LogLevel): void {
  currentLevel = normalizeLevel(level);
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export interface Logger {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

export function createLogger(module: string): Logger {
  const log = (level: LogLevel, message: string, ...args: unknown[]): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
    const prefix = `[${level.toUpperCase()}] [${module}]`;
    const fn =
      level === "error" ? console.error
      : level === "warn" ? console.warn
      : console.log;
    if (args.length > 0) {
      fn(prefix, message, ...args);
    } else {
      fn(prefix, message);
    }
  };

  return {
    debug: (msg, ...args) => log("debug", msg, ...args),
    info: (msg, ...args) => log("info", msg, ...args),
    warn: (msg, ...args) => log("warn", msg, ...args),
    error: (msg, ...args) => log("error", msg, ...args),
  };
}
