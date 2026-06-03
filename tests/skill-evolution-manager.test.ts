import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreAPI } from "../src/core/core-api.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import type { ModelMessage, ModelProvider, ToolDefinition } from "../src/index.js";

const DATA_DIR = ".forge/test-skill-evolution-manager";

afterEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("SkillEvolutionManager", () => {
  it("extracts a proposal after a turn and auto-enables a clean generated skill", async () => {
    const calls: Array<{ messages: ModelMessage[]; tools?: ToolDefinition[] | undefined }> = [];
    const provider: ModelProvider = {
      generate: vi.fn().mockImplementation(async (messages: ModelMessage[], tools?: ToolDefinition[]) => {
        calls.push({ messages, tools });
        if (calls.length === 1) {
          return { text: "Turn done", finishReason: "stop" };
        }
        if (calls.length === 2) {
          return {
            text: JSON.stringify({
              proposals: [
                {
                  action: "create",
                  name: "browser-reporting",
                  title: "Browser reporting workflow",
                  description: "Summarize browser research with cited sources",
                  whenToUse: "Use when turning browser research into a cited report.",
                  tags: ["browser", "report"],
                  paths: ["reports/**"],
                  skillMd: "# Browser Reporting\n\nRead source pages, preserve URLs, and write concise cited reports.",
                  sourceSeqs: [1, 2],
                },
              ],
            }),
            finishReason: "stop",
          };
        }
        return {
          text: JSON.stringify({ pass: true, reason: "Reusable, safe, and actionable." }),
          finishReason: "stop",
        };
      }),
    };

    const api = new CoreAPI(new ToolRegistry(), { dataDir: DATA_DIR });
    api.setModelProvider(provider);
    api.initSkillEcosystem({ autoRun: false, proposalThreshold: 1 });

    const session = api.createSession("skill evolution");
    api.appendUserMessage(session.id, "We repeatedly need cited browser reports", { dispatch: false });
    await api.runTurn(session.id);

    expect(api.getSession(session.id)!.status).toBe("idle");
    expect(api.getSkillEvolutionStatus()?.queuedExtractions).toBe(1);

    const report = await api.runSkillMaintenance({ consolidate: true });

    expect(report.extractedProposals).toBe(1);
    expect(report.applied).toBe(1);
    expect(calls[1]!.tools).toBeUndefined();
    expect(calls[2]!.tools).toBeUndefined();
    expect(api.getSkill("browser-reporting")).toMatchObject({
      name: "browser-reporting",
      status: "active",
      trust: "generated",
    });
    expect(api.getSkillEvents().map((event) => event.action)).toEqual(
      expect.arrayContaining(["proposal_created", "proposal_applied"]),
    );
  });

  it("degrades on malformed extractor output without blocking the foreground session", async () => {
    const provider: ModelProvider = {
      generate: vi.fn()
        .mockResolvedValueOnce({ text: "Turn done", finishReason: "stop" })
        .mockResolvedValueOnce({ text: "not json", finishReason: "stop" }),
    };

    const api = new CoreAPI(new ToolRegistry(), { dataDir: DATA_DIR });
    api.setModelProvider(provider);
    api.initSkillEcosystem({ autoRun: false, baseDelayMs: 10_000, jitterMs: 0 });

    const session = api.createSession("skill failure");
    api.appendUserMessage(session.id, "Extract a skill maybe", { dispatch: false });
    await api.runTurn(session.id);

    const report = await api.runSkillMaintenance();

    expect(report.error).toContain("Unexpected token");
    expect(api.getSession(session.id)!.status).toBe("idle");
    expect(api.getSkillEvolutionStatus()?.state).toBe("degraded");
    expect(api.getThread(session.id).some((event) =>
      event.type === "runtime_event" && event.runtimeKind === "skill" && event.detail === "degraded"
    )).toBe(true);
    expect(api.getSystemEvents().some((event) => event.detail === "skill_degraded")).toBe(true);
  });
});
