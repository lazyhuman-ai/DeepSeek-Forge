import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import { SkillStore } from "./skill-store.js";
import type { SkillManifest, SkillRenderContext } from "./types.js";

export type SkillFrontmatter = {
  name: string;
  description: string;
  version?: string;
  tags?: string[];
  allowedTools?: string[];
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  whenToUse?: string;
  paths?: string[];
  requires?: {
    os?: string[];
    bin?: string[];
    env?: Record<string, string>;
  };
};

export type SkillEntry = SkillFrontmatter & {
  location: string;
  directory: string;
  packageId?: string;
  trust?: SkillManifest["trust"];
  source?: SkillManifest["source"];
  status?: SkillManifest["status"];
};

export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

const MAX_SKILL_FILE_BYTES = 256 * 1024;

export class SkillCatalog {
  #sources: string[];
  #entries: SkillEntry[] = [];
  #store: SkillStore | undefined;

  constructor(sources?: string[], options?: { store?: SkillStore }) {
    this.#sources = sources ?? [pathResolve(".forge/skills")];
    this.#store = options?.store;
    this.scan();
  }

  static fromStore(store: SkillStore): SkillCatalog {
    return new SkillCatalog(undefined, { store });
  }

  scan(): SkillEntry[] {
    if (this.#store) {
      this.#store.rebuildIndex();
      this.#entries = this.#store.entries.map(entryFromManifest);
      return this.#entries;
    }

    const merged = new Map<string, SkillEntry>();

    for (const source of this.#sources) {
      const resolved = pathResolve(source);
      if (!existsSync(resolved)) continue;

      const found = this.#scanDir(resolved);
      // Later sources override earlier for same-named skills.
      for (const entry of found) {
        merged.set(entry.name, entry);
      }
    }

    this.#entries = [...merged.values()];
    return this.#entries;
  }

  formatPrompt(context?: SkillRenderContext): string {
    if (this.#store) return this.#store.formatPrompt(context);

    const visible = this.#entries.filter(
      (e) => !e.disableModelInvocation,
    );
    if (visible.length === 0) return "";

    const lines = [
      "",
      "The following skills provide specialized instructions for specific tasks.",
      "Use read_file (the Read tool) to load a skill's file when the task matches its description.",
      "When a skill file references a relative path, resolve it against the skill's directory.",
      "",
      "<available_skills>",
    ];
    for (const skill of visible) {
      lines.push("  <skill>");
      lines.push(`    <name>${this.#escapeXml(skill.name)}</name>`);
      if (skill.version) lines.push(`    <version>${this.#escapeXml(skill.version)}</version>`);
      if (skill.whenToUse) lines.push(`    <when_to_use>${this.#escapeXml(skill.whenToUse)}</when_to_use>`);
      lines.push(`    <description>${this.#escapeXml(skill.description)}</description>`);
      lines.push(`    <location>${this.#escapeXml(skill.location)}</location>`);
      lines.push("  </skill>");
    }
    lines.push("</available_skills>");
    return lines.join("\n");
  }

  getPromptInstructions(): string {
    if (this.#store) return this.#store.getPromptInstructions();
    return [
      "",
      "## Skills",
      "",
      "Before replying, scan <available_skills> <description> entries.",
      "- If exactly one skill clearly applies: use read_file (the Read tool) on its SKILL.md at <location>, then follow it.",
      "- If multiple could apply: choose the most specific one, then read and follow it.",
      "- If none clearly apply: do not read any SKILL.md.",
      "- When a skill references a relative path, resolve it against the skill directory.",
      "- Read reference files only when a specific step requires them.",
      "- Scripts in the skill directory should be executed with the Bash tool, not read into context.",
    ].join("\n");
  }

  validate(name: string): ValidationResult {
    const errors: string[] = [];

    const entry = this.#entries.find((e) => e.name === name);
    if (!entry) {
      return { valid: false, errors: [`Skill "${name}" not found`] };
    }

    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
      errors.push("Name must be kebab-case (e.g. 'code-review')");
    }
    if (name.length > 64) {
      errors.push("Name must be 64 characters or fewer");
    }

    if (!entry.description || entry.description.trim().length === 0) {
      errors.push("description is required");
    }

    if (entry.location.includes("..")) {
      errors.push("Location must not contain path traversal");
    }

    try {
      const filePath = pathResolve(entry.location);
      const stat = statSync(filePath);
      if (stat.size > MAX_SKILL_FILE_BYTES) {
        errors.push(`SKILL.md exceeds max size of ${MAX_SKILL_FILE_BYTES} bytes`);
      }
    } catch {
      errors.push("Cannot stat SKILL.md file");
    }

    if (entry.status === "invalid" || entry.status === "quarantined") {
      errors.push(`Skill is ${entry.status}`);
    }

    return { valid: errors.length === 0, errors };
  }

  refresh(): void {
    this.scan();
  }

  get entries(): SkillEntry[] {
    return this.#entries;
  }

  get store(): SkillStore | undefined {
    return this.#store;
  }

  #scanDir(dir: string): SkillEntry[] {
    const results: SkillEntry[] = [];
    if (!existsSync(dir)) return results;

    for (const entry of readdirSync(dir)) {
      const fullPath = pathJoin(dir, entry);
      if (!statSync(fullPath).isDirectory()) continue;

      const skillMdPath = pathJoin(fullPath, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;

      try {
        const raw = readFileSync(skillMdPath, "utf-8");
        const frontmatter = this.#parseFrontmatter(raw);
        if (!frontmatter || !frontmatter.name || !frontmatter.description) {
          continue;
        }

        const stat = statSync(skillMdPath);
        if (stat.size > MAX_SKILL_FILE_BYTES) continue;

        if (!this.#checkRequires(frontmatter.requires)) continue;

        results.push({
          ...frontmatter,
          name: frontmatter.name,
          description: frontmatter.description,
          location: skillMdPath,
          directory: fullPath,
        });
      } catch {
        // Skip unreadable skills.
      }
    }

    return results;
  }

  #parseFrontmatter(raw: string): SkillFrontmatter | null {
    const trimmed = raw.trimStart();
    if (!trimmed.startsWith("---")) return null;

    const endIdx = trimmed.indexOf("---", 3);
    if (endIdx === -1) return null;

    const fmBlock = trimmed.slice(3, endIdx);
    const result: Record<string, unknown> = {};

    const lines = fmBlock.split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      const keyMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
      if (!keyMatch) {
        i++;
        continue;
      }

      const key = normalizeKey(keyMatch[1]!);
      const value = keyMatch[2]!.trim();

      if (value === "" || value === "|" || value === ">-") {
        const nextLine = lines[i + 1];
        if (nextLine && nextLine.trimStart().startsWith("-")) {
          const arr: string[] = [];
          i++;
          while (i < lines.length && lines[i]!.trimStart().startsWith("-")) {
            arr.push(lines[i]!.trimStart().slice(1).trim());
            i++;
          }
          result[key] = arr;
          continue;
        }
      }

      if (value === "true") result[key] = true;
      else if (value === "false") result[key] = false;
      else result[key] = value;
      i++;
    }

    return result as unknown as SkillFrontmatter;
  }

  #checkRequires(
    req: SkillFrontmatter["requires"],
  ): boolean {
    if (!req) return true;

    if (req.os && Array.isArray(req.os)) {
      const current = process.platform;
      const ok = req.os.some((os) => {
        if (os === "macos") return current === "darwin";
        if (os === "windows") return current === "win32";
        return os === current;
      });
      if (!ok) return false;
    }

    if (req.env && typeof req.env === "object") {
      for (const [key, expected] of Object.entries(req.env)) {
        if (process.env[key] !== expected) return false;
      }
    }

    return true;
  }

  #escapeXml(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }
}

function entryFromManifest(manifest: SkillManifest): SkillEntry {
  const entry: SkillEntry = {
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    location: manifest.location,
    directory: manifest.directory,
    packageId: manifest.packageId,
    trust: manifest.trust,
    source: manifest.source,
    status: manifest.status,
  };
  if (manifest.tags !== undefined) entry.tags = manifest.tags;
  if (manifest.allowedTools !== undefined) entry.allowedTools = manifest.allowedTools;
  if (manifest.disableModelInvocation !== undefined) entry.disableModelInvocation = manifest.disableModelInvocation;
  if (manifest.userInvocable !== undefined) entry.userInvocable = manifest.userInvocable;
  if (manifest.whenToUse !== undefined) entry.whenToUse = manifest.whenToUse;
  if (manifest.paths !== undefined) entry.paths = manifest.paths;
  if (manifest.requires !== undefined) entry.requires = manifest.requires;
  return entry;
}

function normalizeKey(key: string): string {
  switch (key) {
    case "allowed-tools":
      return "allowedTools";
    case "disable-model-invocation":
      return "disableModelInvocation";
    case "user-invocable":
      return "userInvocable";
    case "when_to_use":
    case "when-to-use":
      return "whenToUse";
    default:
      return key;
  }
}
