import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type VerificationLevel = "quick" | "standard" | "full";

const SAFE_SCRIPT_NAMES = new Set(["test", "typecheck", "check", "build", "lint", "format"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const SAFE_ARG = "[A-Za-z0-9_@%+=:,./-]+";

function pathExists(path: string): boolean {
  return existsSync(path);
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function hasFileWithExtension(projectRoot: string, extension: string): boolean {
  try {
    return readdirSync(projectRoot, { withFileTypes: true }).some((entry) =>
      entry.isFile() && entry.name.toLowerCase().endsWith(extension)
    );
  } catch {
    return false;
  }
}

function packageManager(projectRoot: string): "npm" | "pnpm" | "yarn" | "bun" {
  if (pathExists(join(projectRoot, "bun.lock")) || pathExists(join(projectRoot, "bun.lockb"))) return "bun";
  if (pathExists(join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (pathExists(join(projectRoot, "yarn.lock"))) return "yarn";
  return "npm";
}

function packageScriptCommand(pm: "npm" | "pnpm" | "yarn" | "bun", script: string): string {
  if (script === "test") {
    if (pm === "bun") return "bun test";
    if (pm === "yarn") return "yarn test";
    return `${pm} test`;
  }
  return `${pm} run ${script}`;
}

function commandLimit(level: VerificationLevel): number {
  if (level === "full") return 5;
  if (level === "standard") return 3;
  return 1;
}

function hasUnsafeShellSyntax(command: string): boolean {
  return /[`$<>|;&\n\r]/.test(command);
}

function safePackageCommand(command: string): boolean {
  const pm = `(?:${[...PACKAGE_MANAGERS].join("|")})`;
  const args = `(?:\\s+--\\s+${SAFE_ARG}(?:\\s+${SAFE_ARG})*)?`;
  if (new RegExp(`^${pm}\\s+test${args}$`).test(command)) return true;
  const scriptMatch = new RegExp(`^${pm}\\s+run\\s+([A-Za-z0-9:_-]+)${args}$`).exec(command);
  return Boolean(scriptMatch?.[1] && SAFE_SCRIPT_NAMES.has(scriptMatch[1]));
}

function safeTypeScriptCommand(command: string): boolean {
  const flags = `(?:\\s+(?:--noEmit|--pretty|--pretty=false|--pretty=true|false|true))*`;
  return new RegExp(`^(?:npx\\s+(?:--no-install\\s+)?tsc|\\./node_modules/\\.bin/tsc)${flags}$`).test(command) &&
    /\s--noEmit(?:\s|$)/.test(command);
}

function safePythonCommand(command: string): boolean {
  const targetArgs = `(?:\\s+${SAFE_ARG}){0,8}`;
  return new RegExp(`^(?:python|python3)\\s+-m\\s+(?:pytest|mypy|pyright)${targetArgs}$`).test(command) ||
    new RegExp(`^(?:python|python3)\\s+-m\\s+unittest(?:\\s+discover)?${targetArgs}$`).test(command) ||
    new RegExp(`^(?:python|python3)\\s+-m\\s+ruff\\s+check${targetArgs}$`).test(command) ||
    new RegExp(`^uv\\s+run\\s+(?:pytest|mypy|pyright)${targetArgs}$`).test(command) ||
    new RegExp(`^uv\\s+run\\s+ruff\\s+check${targetArgs}$`).test(command);
}

function safeCargoCommand(command: string): boolean {
  const cargoFlags = "(?:\\s+--(?:workspace|all|all-targets|all-features|no-default-features|locked|offline|quiet|tests|bins|examples|lib|release))*";
  return new RegExp(`^cargo\\s+(?:check|test|clippy)${cargoFlags}$`).test(command);
}

function safeGoCommand(command: string): boolean {
  return /^go\s+(?:test|vet)(?:\s+\.\/\.\.\.)?(?:\s+-[A-Za-z0-9_=./-]+)*$/.test(command);
}

function safeJvmCommand(command: string): boolean {
  return /^(?:mvn|mvnw|\.\/mvnw)\s+(?:-q\s+)?(?:test|verify|package)(?:\s+-[A-Za-z0-9_=./-]+)*$/.test(command) ||
    /^\.\/gradlew\s+(?:test|check|build)(?:\s+--[A-Za-z0-9_=./-]+)*$/.test(command) ||
    /^gradle\s+(?:test|check|build)(?:\s+--[A-Za-z0-9_=./-]+)*$/.test(command);
}

function safeOtherBuildCommand(command: string): boolean {
  return /^swift\s+(?:test|build)(?:\s+--[A-Za-z0-9_=./-]+)*$/.test(command) ||
    /^dotnet\s+(?:test|build)(?:\s+--[A-Za-z0-9_=./-]+)*$/.test(command) ||
    /^make\s+(?:test|check|build|lint)$/.test(command);
}

export function isSafeWorkspaceVerificationCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || hasUnsafeShellSyntax(trimmed)) return false;
  return safePackageCommand(trimmed) ||
    safeTypeScriptCommand(trimmed) ||
    safePythonCommand(trimmed) ||
    safeCargoCommand(trimmed) ||
    safeGoCommand(trimmed) ||
    safeJvmCommand(trimmed) ||
    safeOtherBuildCommand(trimmed);
}

function addPackageCommands(projectRoot: string, level: VerificationLevel, commands: string[]): void {
  const parsed = readJson(join(projectRoot, "package.json"));
  const scripts = parsed?.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    if (pathExists(join(projectRoot, "tsconfig.json")) && pathExists(join(projectRoot, "node_modules", ".bin", "tsc"))) {
      commands.push("./node_modules/.bin/tsc --noEmit --pretty=false");
    }
    return;
  }

  const wanted = level === "full"
    ? ["typecheck", "test", "lint", "build", "check"]
    : level === "standard"
      ? ["typecheck", "test", "lint"]
      : ["typecheck", "test"];
  const pm = packageManager(projectRoot);
  for (const script of wanted) {
    if (typeof (scripts as Record<string, unknown>)[script] === "string") {
      commands.push(packageScriptCommand(pm, script));
    }
    if (commands.length >= commandLimit(level)) return;
  }
  if (commands.length === 0 && pathExists(join(projectRoot, "tsconfig.json")) && pathExists(join(projectRoot, "node_modules", ".bin", "tsc"))) {
    commands.push("./node_modules/.bin/tsc --noEmit --pretty=false");
  }
}

function addPythonCommands(projectRoot: string, level: VerificationLevel, commands: string[]): void {
  const pyproject = readText(join(projectRoot, "pyproject.toml"));
  const hasPythonProject = pyproject ||
    pathExists(join(projectRoot, "setup.py")) ||
    pathExists(join(projectRoot, "setup.cfg")) ||
    pathExists(join(projectRoot, "pytest.ini")) ||
    pathExists(join(projectRoot, "tox.ini"));
  if (!hasPythonProject) return;

  if (pathExists(join(projectRoot, "tests")) || pathExists(join(projectRoot, "pytest.ini")) || /\bpytest\b/.test(pyproject)) {
    commands.push("python -m pytest");
  }
  if (level !== "quick" && /\b(?:tool\.ruff|ruff)\b/.test(pyproject)) {
    commands.push("python -m ruff check .");
  }
  if (level === "full" && /\b(?:tool\.mypy|mypy)\b/.test(pyproject)) {
    commands.push("python -m mypy .");
  }
}

function addMakeCommand(projectRoot: string, commands: string[]): void {
  const makefile = readText(join(projectRoot, "Makefile")) || readText(join(projectRoot, "makefile"));
  if (/^test\s*:/m.test(makefile)) commands.push("make test");
  else if (/^check\s*:/m.test(makefile)) commands.push("make check");
}

export async function detectWorkspaceVerificationCommands(
  projectRoot: string,
  level: VerificationLevel = "quick",
): Promise<string[]> {
  const commands: string[] = [];
  const limit = commandLimit(level);
  const add = (command: string): void => {
    if (commands.length < limit && isSafeWorkspaceVerificationCommand(command) && !commands.includes(command)) {
      commands.push(command);
    }
  };

  addPackageCommands(projectRoot, level, commands);
  if (commands.length >= limit) return commands;

  if (pathExists(join(projectRoot, "Cargo.toml"))) add(level === "quick" ? "cargo check" : "cargo test");
  if (pathExists(join(projectRoot, "go.mod"))) add("go test ./...");
  addPythonCommands(projectRoot, level, commands);
  if (pathExists(join(projectRoot, "Package.swift"))) add("swift test");
  if (pathExists(join(projectRoot, "pom.xml"))) add(pathExists(join(projectRoot, "mvnw")) ? "./mvnw test" : "mvn test");
  if (pathExists(join(projectRoot, "gradlew"))) add("./gradlew test");
  else if (pathExists(join(projectRoot, "build.gradle")) || pathExists(join(projectRoot, "build.gradle.kts"))) add("gradle test");
  if (pathExists(join(projectRoot, "global.json")) || hasFileWithExtension(projectRoot, ".sln") || hasFileWithExtension(projectRoot, ".csproj")) add("dotnet test");
  addMakeCommand(projectRoot, commands);

  return commands.slice(0, limit);
}
