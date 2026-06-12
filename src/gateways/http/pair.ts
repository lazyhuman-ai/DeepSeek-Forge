import { join } from "node:path";
import { AuthStore } from "../../auth/auth-store.js";

function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(name);
  if (idx !== -1) return argv[idx + 1];
  const prefix = `${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function usage(): void {
  console.log(`Usage: npm run pair -- --name "Pixel 9" [--base-url http://127.0.0.1:3000] [--data-dir .forge]`);
}

function pairingUrl(baseUrl: string, code: string): string {
  return `forgeagent://pair?baseUrl=${encodeURIComponent(baseUrl)}&code=${encodeURIComponent(code)}`;
}

function main(): void {
  if (hasFlag("--help") || hasFlag("-h")) {
    usage();
    return;
  }

  const name = argValue("--name");
  if (!name) {
    usage();
    process.exitCode = 1;
    return;
  }

  const baseUrl = argValue("--base-url") ?? "http://127.0.0.1:3000";
  const dataDir = argValue("--data-dir") ?? process.env.FORGE_DATA_DIR ?? ".forge";
  const store = new AuthStore(join(dataDir, "auth"));
  const issued = store.issuePairingCode();

  console.log("DeepSeek-Forge pairing code created.");
  console.log(`Device name: ${name}`);
  console.log(`Code: ${issued.code}`);
  console.log(`Expires at: ${issued.expiresAt}`);
  console.log(`Pairing URL: ${pairingUrl(baseUrl, issued.code)}`);
}

main();
