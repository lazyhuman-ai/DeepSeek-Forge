import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreAPI } from "../src/core/core-api.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import type { ModelMessage, ModelProvider } from "../src/index.js";

const DATA_DIR = ".forge/test-core-skill-usage";

afterEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("Core skill usage events", () => {
  it("records skill_used when the agent reads an active skill file", async () => {
    const skillDir = join(DATA_DIR, "skills", "report-helper");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = resolve(join(skillDir, "SKILL.md"));
    writeFileSync(skillPath, [
      "---",
      "name: report-helper",
      "description: Write cited reports",
      "---",
      "",
      "# Report Helper",
      "",
      "Preserve source URLs.",
    ].join("\n"));

    const provider: ModelProvider = {
      generate: vi.fn().mockImplementation(async (_messages: ModelMessage[]) => {
        const call = (provider.generate as ReturnType<typeof vi.fn>).mock.calls.length;
        if (call === 1) {
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "read-skill",
                name: "read_file",
                args: { file_path: skillPath },
              },
            ],
          };
        }
        return { text: "I will follow the report-helper skill.", finishReason: "stop" };
      }),
    };

    const api = new CoreAPI(new ToolRegistry(), { dataDir: DATA_DIR });
    api.registerBuiltInTools();
    api.setModelProvider(provider);
    api.initSkillEcosystem({ autoRun: false });

    expect(api.getSkill("report-helper")?.status).toBe("active");

    const session = api.createSession("skill use");
    api.appendUserMessage(session.id, "Use the report helper", { dispatch: false });
    await api.runTurn(session.id);

    const events = api.getThread(session.id);
    const skillUsed = events.find((event) => event.type === "skill_used");
    expect(skillUsed?.type).toBe("skill_used");
    if (skillUsed?.type === "skill_used") {
      expect(skillUsed.skillName).toBe("report-helper");
      expect(skillUsed.filePath).toBe(skillPath);
      expect(skillUsed.message).toContain("report-helper");
    }
  });
});
