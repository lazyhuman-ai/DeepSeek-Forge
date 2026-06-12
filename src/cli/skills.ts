#!/usr/bin/env node
import { resolve } from "node:path";
import { loadDotEnv } from "../core/env.js";
import { SkillStore } from "../skills/skill-store.js";

type CliOptions = {
  dataDir: string;
  json: boolean;
  name?: string;
  version?: string;
  sourceId?: string;
  registryUrl?: string;
  publicKey?: string;
  trustUnsigned: boolean;
  force: boolean;
  reason?: string;
};

async function main(): Promise<void> {
  loadDotEnv();
  const args = process.argv.slice(2);
  const command = args[0] && !args[0].startsWith("-") ? args[0] : "list";
  const options = parseOptions(command === args[0] ? args.slice(1) : args);
  const store = new SkillStore({ rootDir: resolve(options.dataDir, "skills") });

  switch (command) {
    case "list":
    case "search":
      listCommand(store, options, command === "search" ? options.name : undefined);
      return;
    case "install":
      await installCommand(store, options);
      return;
    case "update":
      await installCommand(store, { ...options, force: true });
      return;
    case "audit":
      auditCommand(store, options);
      return;
    case "enable":
      requireName(options, "enable");
      output(store.enable(options.name!, options.version), options);
      return;
    case "disable":
      requireName(options, "disable");
      output(store.disable(options.name!, options.reason), options);
      return;
    case "rollback":
      requireName(options, "rollback");
      output(store.rollback(options.name!), options);
      return;
    case "sources":
      sourcesCommand(store, options);
      return;
    case "doctor":
      doctorCommand(store, options);
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      throw new Error(`Unknown skills command: ${command}`);
  }
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    dataDir: process.env.FORGE_DATA_DIR ?? ".forge",
    json: false,
    trustUnsigned: false,
    force: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "--data-dir":
        options.dataDir = requireValue(args, ++i, arg);
        break;
      case "--json":
        options.json = true;
        break;
      case "--name":
        options.name = requireValue(args, ++i, arg);
        break;
      case "--version":
        options.version = requireValue(args, ++i, arg);
        break;
      case "--source":
      case "--source-id":
        options.sourceId = requireValue(args, ++i, arg);
        break;
      case "--registry-url":
      case "--url":
        options.registryUrl = requireValue(args, ++i, arg);
        break;
      case "--public-key":
        options.publicKey = requireValue(args, ++i, arg);
        break;
      case "--trust-unsigned":
        options.trustUnsigned = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--reason":
        options.reason = requireValue(args, ++i, arg);
        break;
      default:
        if (!options.name && !arg.startsWith("-")) {
          options.name = arg;
        } else {
          throw new Error(`Unknown option: ${arg}`);
        }
    }
  }
  return options;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("-")) throw new Error(`Missing value for ${option}.`);
  return value;
}

function requireName(options: CliOptions, command: string): void {
  if (!options.name) throw new Error(`skills ${command} requires a skill name.`);
}

function listCommand(store: SkillStore, options: CliOptions, query?: string): void {
  const normalized = query?.toLowerCase();
  const skills = store.list({ includeInactive: true })
    .filter((skill) => {
      if (!normalized) return true;
      return [
        skill.name,
        skill.description,
        skill.whenToUse ?? "",
        ...(skill.tags ?? []),
      ].join(" ").toLowerCase().includes(normalized);
    });
  if (options.json) {
    output(skills, options);
    return;
  }
  if (skills.length === 0) {
    console.log("No skills found.");
    return;
  }
  for (const skill of skills) {
    console.log(`${skill.name}@${skill.version} [${skill.status}] ${skill.trust}/${skill.source}`);
    console.log(`  ${skill.description}`);
    console.log(`  ${skill.location}`);
  }
}

async function installCommand(store: SkillStore, options: CliOptions): Promise<void> {
  requireName(options, "install");
  const result = await store.install({
    name: options.name!,
    ...(options.version ? { version: options.version } : {}),
    ...(options.sourceId ? { sourceId: options.sourceId } : {}),
    ...(options.registryUrl ? { registryUrl: options.registryUrl } : {}),
    ...(options.trustUnsigned ? { trustUnsigned: true } : {}),
    ...(options.force ? { force: true } : {}),
  });
  output(result, options);
}

function auditCommand(store: SkillStore, options: CliOptions): void {
  store.rebuildIndex();
  const skills = options.name
    ? store.list({ includeInactive: true }).filter((skill) => skill.name === options.name)
    : store.list({ includeInactive: true });
  output({
    checked: skills.length,
    invalid: skills.filter((skill) => skill.status === "invalid").length,
    quarantined: skills.filter((skill) => skill.status === "quarantined").length,
    skills,
  }, options);
}

function sourcesCommand(store: SkillStore, options: CliOptions): void {
  if (options.registryUrl && options.name) {
    const source = store.addSource({
      name: options.name,
      url: options.registryUrl,
      ...(options.publicKey ? { publicKey: options.publicKey } : {}),
      ...(options.trustUnsigned ? { trustUnsigned: true } : {}),
    });
    output(source, options);
    return;
  }
  output(store.listSources(), options);
}

function doctorCommand(store: SkillStore, options: CliOptions): void {
  const status = store.getStatus();
  if (options.json) {
    output(status, options);
    return;
  }
  console.log("DeepSeek-Forge skills doctor");
  console.log(`Root: ${store.rootDir}`);
  console.log(`Manifest: ${status.manifestPath}`);
  console.log(`Active: ${status.active}`);
  console.log(`Disabled: ${status.disabled}`);
  console.log(`Invalid: ${status.invalid}`);
  console.log(`Quarantined: ${status.quarantined}`);
  console.log(`Generated: ${status.generated}`);
  console.log(`Sources: ${status.sources}`);
  console.log(`Prompt truncated: ${status.promptTruncated ? "yes" : "no"}`);
  if (status.lastEvent) console.log(`Last event: ${status.lastEvent.action} - ${status.lastEvent.message}`);
}

function output(value: unknown, options: CliOptions): void {
  if (options.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (typeof value === "object" && value !== null && "name" in value && "location" in value) {
    const skill = value as { name: string; version?: string; status?: string; location?: string; description?: string };
    console.log(`${skill.name}${skill.version ? `@${skill.version}` : ""} [${skill.status ?? "unknown"}]`);
    if (skill.description) console.log(skill.description);
    if (skill.location) console.log(skill.location);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
  console.log(`Usage:
  npm run skills -- list [--json]
  npm run skills -- search <query>
  npm run skills -- install <name> [--source <id>] [--version <version>] [--registry-url <url>] [--trust-unsigned] [--force]
  npm run skills -- update <name> [--source <id>]
  npm run skills -- enable <name> [--version <version>]
  npm run skills -- disable <name> [--reason <text>]
  npm run skills -- rollback <name>
  npm run skills -- sources
  npm run skills -- sources --name <source-name> --registry-url <url> [--public-key <pem>] [--trust-unsigned]
  npm run skills -- audit [name]
  npm run skills -- doctor
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
