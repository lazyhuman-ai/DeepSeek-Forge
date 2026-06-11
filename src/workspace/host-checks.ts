import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isSafeWorkspaceVerificationCommand } from "./verification-commands.js";

export type HostVerifyCheck = {
  command: string;
  source: string;
  line: number;
};

const HOST_CHECK_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "REASONIX.md",
  "FORGE.md",
  ".forge/host-checks.md",
];

function stripInlineCode(value: string): string {
  return value.trim().replace(/^`+|`+$/g, "").trim();
}

export function extractProjectHostChecks(projectRoot: string): HostVerifyCheck[] {
  const checks: HostVerifyCheck[] = [];
  const seen = new Set<string>();
  for (const rel of HOST_CHECK_FILES) {
    const path = join(projectRoot, rel);
    if (!existsSync(path)) continue;
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const match = /^\s*(?:[-*]\s*)?verify\s*:\s*(.+)$/i.exec(lines[i] ?? "");
      if (!match?.[1]) continue;
      const command = stripInlineCode(match[1]);
      if (!isSafeWorkspaceVerificationCommand(command)) continue;
      const key = command.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      checks.push({ command, source: rel, line: i + 1 });
    }
  }
  return checks;
}
