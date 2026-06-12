import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { buildSystemPrompt } from "../src/agent/system-prompt-builder.js";
import { SkillCatalog } from "../src/skills/skill-catalog.js";
import { MemoryStore } from "../src/memory/memory-store.js";

const SKILL_DIR = ".forge/test-prompt-skills";
const MEMORY_DIR = ".forge/test-prompt-memory";

describe("buildSystemPrompt", () => {
  afterEach(() => {
    rmSync(SKILL_DIR, { recursive: true, force: true });
    rmSync(MEMORY_DIR, { recursive: true, force: true });
  });

  it("returns base agent instructions when no catalog or memory", () => {
    const prompt = buildSystemPrompt({ sessionId: "s1" });

    expect(prompt).toContain("DeepSeek-Forge");
    expect(prompt).toContain("access to tools");
    expect(prompt).toContain("Response rendering:");
    expect(prompt).toContain("sanitized inline/block HTML");
    expect(prompt).toContain("explicitly asks to show, render, preview, or include HTML in the conversation");
    expect(prompt).not.toContain("<available_skills>");
    expect(prompt).not.toContain("<relevant_memory>");
    expect(prompt).not.toContain("<memory_manifest>");
  });

  it("includes skills XML when catalog has visible skills", () => {
    const dir = pathJoin(SKILL_DIR, "code-review");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      pathJoin(dir, "SKILL.md"),
      [
        "---",
        "name: code-review",
        "description: Review code for security issues",
        "---",
        "",
        "# Code Review Skill",
      ].join("\n"),
    );

    const catalog = new SkillCatalog([SKILL_DIR]);
    const prompt = buildSystemPrompt({ skillCatalog: catalog, sessionId: "s1" });

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("code-review");
    expect(prompt).toContain("Review code for security issues");
    expect(prompt).toContain("Read tool");
  });

  it("excludes skills block when all skills are model-disabled", () => {
    const dir = pathJoin(SKILL_DIR, "hidden-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      pathJoin(dir, "SKILL.md"),
      [
        "---",
        "name: hidden-skill",
        "description: Manual only",
        "disableModelInvocation: true",
        "---",
        "",
        "# Hidden",
      ].join("\n"),
    );

    const catalog = new SkillCatalog([SKILL_DIR]);
    const prompt = buildSystemPrompt({ skillCatalog: catalog, sessionId: "s1" });

    expect(prompt).not.toContain("<available_skills>");
  });

  it("includes memory policy and manifest, not full non-instruction memory bodies", () => {
    mkdirSync(MEMORY_DIR, { recursive: true });
    const store = new MemoryStore(MEMORY_DIR);
    store.store({
      sessionId: "s1",
      kind: "fact",
      title: "Python preference",
      content: "User prefers Python for one-off scripts",
      tags: ["language"],
    });
    store.store({
      sessionId: "s1",
      kind: "episode",
      title: "Auth debug episode",
      content: "Debugged auth bug last week with a specific stack trace",
      tags: ["debug"],
    });

    const prompt = buildSystemPrompt({ memoryStore: store, sessionId: "s1" });

    expect(prompt).toContain("Long-term memory:");
    expect(prompt).toContain("<memory_manifest>");
    expect(prompt).toContain("Python preference");
    expect(prompt).toContain("Auth debug episode");
    expect(prompt).not.toContain("User prefers Python for one-off scripts");
    expect(prompt).not.toContain("specific stack trace");
  });

  it("directly injects instruction memories only", () => {
    mkdirSync(MEMORY_DIR, { recursive: true });
    const store = new MemoryStore(MEMORY_DIR);
    store.store({
      sessionId: "s1",
      type: "instruction",
      title: "Language rule",
      content: "Always answer this project in Chinese.",
      tags: [],
    });
    store.store({
      sessionId: "s2",
      type: "project",
      title: "Project fact",
      content: "Project fact body should require memory_get.",
      tags: [],
    });

    const prompt = buildSystemPrompt({ memoryStore: store, sessionId: "s1" });

    expect(prompt).toContain("<memory_instructions>");
    expect(prompt).toContain("Always answer this project in Chinese.");
    expect(prompt).toContain("Project fact");
    expect(prompt).not.toContain("Project fact body should require memory_get.");
  });

  it("excludes legacy relevant_memory block even when memories exist", () => {
    mkdirSync(MEMORY_DIR, { recursive: true });
    const store = new MemoryStore(MEMORY_DIR);
    store.store({
      sessionId: "other-session",
      kind: "fact",
      content: "Not for s1",
      tags: [],
    });

    const prompt = buildSystemPrompt({ memoryStore: store, sessionId: "s1" });

    expect(prompt).not.toContain("<relevant_memory>");
    expect(prompt).toContain("<memory_manifest>");
  });

  it("combines skills and memory in correct order", () => {
    const skillDir = pathJoin(SKILL_DIR, "test");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      pathJoin(skillDir, "SKILL.md"),
      [
        "---",
        "name: test",
        "description: A test skill",
        "---",
        "",
        "# Test Skill",
      ].join("\n"),
    );

    mkdirSync(MEMORY_DIR, { recursive: true });
    const memoryStore = new MemoryStore(MEMORY_DIR);
    memoryStore.store({
      sessionId: "s1",
      kind: "fact",
      content: "Memory entry",
      tags: [],
    });

    const catalog = new SkillCatalog([SKILL_DIR]);
    const prompt = buildSystemPrompt({
      skillCatalog: catalog,
      memoryStore,
      sessionId: "s1",
    });

    const skillsIdx = prompt.indexOf("<available_skills>");
    const memoryIdx = prompt.indexOf("Long-term memory:");
    const agentIdx = prompt.indexOf("DeepSeek-Forge");

    // Agent identity first, then skills, then memory
    expect(agentIdx).toBeLessThan(skillsIdx);
    expect(skillsIdx).toBeLessThan(memoryIdx);
  });
});
