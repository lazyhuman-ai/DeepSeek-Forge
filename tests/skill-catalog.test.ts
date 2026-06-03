import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import { SkillCatalog } from "../src/skills/skill-catalog.js";

const TEST_BASE = ".forge/test-skills";

function makeSkill(
  dir: string,
  name: string,
  frontmatter: Record<string, unknown>,
  body = "# Skill Body\n\nSome instructions here.\n",
): void {
  const skillDir = pathJoin(TEST_BASE, dir);
  mkdirSync(skillDir, { recursive: true });

  const fmLines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      fmLines.push(`${key}:`);
      for (const item of value) {
        fmLines.push(`  - ${item}`);
      }
    } else if (typeof value === "object" && value !== null) {
      fmLines.push(`${key}:`);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        fmLines.push(`  ${k}: ${v}`);
      }
    } else {
      fmLines.push(`${key}: ${value}`);
    }
  }
  fmLines.push("---");
  fmLines.push("");
  fmLines.push(body);

  writeFileSync(pathJoin(skillDir, "SKILL.md"), fmLines.join("\n"));
}

describe("SkillCatalog", () => {
  afterEach(() => {
    rmSync(TEST_BASE, { recursive: true, force: true });
  });

  it("scan discovers SKILL.md files and parses frontmatter", () => {
    makeSkill("code-review", "code-review", {
      name: "code-review",
      description: "Review code for security issues",
      version: "1.0.0",
      tags: ["review", "security"],
    });

    const catalog = new SkillCatalog([TEST_BASE]);
    const entries = catalog.scan();

    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("code-review");
    expect(entries[0]!.description).toBe("Review code for security issues");
    expect(entries[0]!.version).toBe("1.0.0");
    expect(entries[0]!.tags).toEqual(["review", "security"]);
    expect(entries[0]!.location).toContain("code-review/SKILL.md");
    expect(entries[0]!.directory).toContain("code-review");
  });

  it("scan returns empty for empty directory", () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const catalog = new SkillCatalog([TEST_BASE]);
    expect(catalog.scan()).toHaveLength(0);
  });

  it("scan skips directories without SKILL.md", () => {
    const dir = pathJoin(TEST_BASE, "empty-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(pathJoin(dir, "readme.txt"), "not a skill");

    const catalog = new SkillCatalog([TEST_BASE]);
    expect(catalog.scan()).toHaveLength(0);
  });

  it("formatPrompt produces XML", () => {
    makeSkill("pdf", "pdf", {
      name: "pdf",
      description: "Extract text from PDF files",
    });

    const catalog = new SkillCatalog([TEST_BASE]);
    const prompt = catalog.formatPrompt();

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("</available_skills>");
    expect(prompt).toContain("<name>pdf</name>");
    expect(prompt).toContain("<description>Extract text from PDF files</description>");
    expect(prompt).toContain("<location>");
  });

  it("formatPrompt excludes skills with disableModelInvocation", () => {
    makeSkill("visible", "visible", {
      name: "visible",
      description: "Always shown",
    });
    makeSkill("hidden", "hidden", {
      name: "hidden",
      description: "Manual only",
      disableModelInvocation: true,
    });

    const catalog = new SkillCatalog([TEST_BASE]);
    const prompt = catalog.formatPrompt();

    expect(prompt).toContain("visible");
    expect(prompt).not.toContain("hidden");
  });

  it("formatPrompt returns empty string when no visible skills", () => {
    makeSkill("hidden", "hidden", {
      name: "hidden",
      description: "Manual only",
      disableModelInvocation: true,
    });

    const catalog = new SkillCatalog([TEST_BASE]);
    expect(catalog.formatPrompt()).toBe("");
  });

  it("getPromptInstructions returns behavioral rules", () => {
    const catalog = new SkillCatalog([TEST_BASE]);
    const instructions = catalog.getPromptInstructions();

    expect(instructions).toContain("available_skills");
    expect(instructions).toContain("Read tool");
    expect(instructions).toContain("Bash tool");
  });

  it("validate catches missing name in kebab-case", () => {
    makeSkill("BadName", "BadName", {
      name: "BadName",
      description: "Has uppercase",
    });

    const catalog = new SkillCatalog([TEST_BASE]);
    const result = catalog.validate("BadName");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("kebab-case"))).toBe(true);
  });

  it("validate passes valid skill", () => {
    makeSkill("valid-skill", "valid-skill", {
      name: "valid-skill",
      description: "A properly formed skill",
    });

    const catalog = new SkillCatalog([TEST_BASE]);
    const result = catalog.validate("valid-skill");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("validate fails for non-existent skill", () => {
    const catalog = new SkillCatalog([TEST_BASE]);
    const result = catalog.validate("nope");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("not found");
  });

  it("later source overrides same-named skill", () => {
    const base2 = pathJoin(TEST_BASE, "src2");
    makeSkill("shared", "shared", {
      name: "shared",
      description: "Original description",
    });
    // Create second source with same skill name but different description
    const sharedDir = pathJoin(base2, "shared");
    mkdirSync(sharedDir, { recursive: true });
    writeFileSync(
      pathJoin(sharedDir, "SKILL.md"),
      [
        "---",
        "name: shared",
        "description: Overridden description",
        "---",
        "",
        "# Overridden",
      ].join("\n"),
    );

    const catalog = new SkillCatalog([TEST_BASE, base2]);
    const entries = catalog.scan();

    expect(entries).toHaveLength(1);
    expect(entries[0]!.description).toBe("Overridden description");
  });

  it("refresh picks up new skills", () => {
    const catalog = new SkillCatalog([TEST_BASE]);
    expect(catalog.scan()).toHaveLength(0);

    // Add a skill after initial scan
    makeSkill("new-one", "new-one", {
      name: "new-one",
      description: "Just added",
    });

    catalog.refresh();
    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]!.name).toBe("new-one");
  });

  it("scans multiple skills", () => {
    makeSkill("skill-a", "skill-a", { name: "skill-a", description: "First skill" });
    makeSkill("skill-b", "skill-b", { name: "skill-b", description: "Second skill" });
    makeSkill("skill-c", "skill-c", { name: "skill-c", description: "Third skill" });

    const catalog = new SkillCatalog([TEST_BASE]);
    expect(catalog.scan()).toHaveLength(3);
  });

  it("parses boolean frontmatter values", () => {
    makeSkill("bool-test", "bool-test", {
      name: "bool-test",
      description: "Testing booleans",
      disableModelInvocation: true,
      userInvocable: false,
    });

    const catalog = new SkillCatalog([TEST_BASE]);
    const entries = catalog.scan();
    expect(entries[0]!.disableModelInvocation).toBe(true);
    expect(entries[0]!.userInvocable).toBe(false);
  });

  it("XML escapes special characters", () => {
    makeSkill("escape-test", "escape-test", {
      name: "escape-test",
      description: 'Use when <tag> & "quoted" works',
    });

    const catalog = new SkillCatalog([TEST_BASE]);
    const prompt = catalog.formatPrompt();

    expect(prompt).toContain("&lt;tag&gt;");
    expect(prompt).toContain("&amp;");
    expect(prompt).toContain("&quot;quoted&quot;");
  });
});
