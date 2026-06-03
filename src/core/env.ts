import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadDotEnv(path = ".env"): void {
  const file = resolve(path);
  if (!existsSync(file)) return;
  const content = readFileSync(file, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    if (process.env[key] !== undefined) continue;
    process.env[key] = parseEnvValue(match[2] ?? "");
  }
}

export const loadEnv = loadDotEnv;

function parseEnvValue(raw: string): string {
  const value = raw.trim();
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  const hash = value.indexOf("#");
  return (hash === -1 ? value : value.slice(0, hash)).trim();
}
