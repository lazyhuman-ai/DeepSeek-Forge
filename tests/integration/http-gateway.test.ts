import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CoreAPI } from "../../src/core/core-api.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { HttpGateway } from "../../src/gateways/http/http-gateway.js";
import { createHttpServer } from "../../src/gateways/http/http-server.js";
import type {
  ModelProvider,
  ModelProviderMetadata,
  ModelResponse,
  ModelMessage,
} from "../../src/agent/model-provider.js";

function makeProvider(responses: ModelResponse[], metadata?: ModelProviderMetadata): ModelProvider {
  let i = 0;
  return {
    ...(metadata ? { getMetadata: () => metadata } : {}),
    generate: vi.fn().mockImplementation(async (_msgs: ModelMessage[]) => {
      const r = responses[i];
      if (!r) throw new Error(`Unexpected generate call #${i}`);
      i++;
      return r;
    }),
  };
}

let baseUrl: string;
let server: http.Server;
let api: CoreAPI;
let gateway: HttpGateway;

function request(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      url,
      {
        method,
        headers: { "Content-Type": "application/json" },
        timeout: 5000,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode!, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode!, data: raw });
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

describe("HTTP Gateway Integration", () => {
  beforeAll(async () => {
    const registry = new ToolRegistry();
    api = new CoreAPI(registry, { dataDir: ".forge-test-http-int" });
    api.registerBuiltInTools();
    api.initSupervisor(2);
    api.initScheduler();

    const provider = makeProvider([
      { text: "Hello from HTTP!", finishReason: "stop" },
      { text: "Thread response", finishReason: "stop" },
    ]);
    api.setModelProvider(provider);

    gateway = new HttpGateway(api);
    server = createHttpServer(api, gateway, { authMode: "disabled" });

    server.listen(0);
    await once(server, "listening");
    const addr = server.address() as { port: number };
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(() => {
    gateway.destroy();
    server.close();
  });

  it("POST /sessions creates a session and returns 201", async () => {
    const resp = await request("POST", "/sessions", { title: "http-test" });
    expect(resp.status).toBe(201);
    const session = resp.data as { id: string; status: string };
    expect(session.id).toBeDefined();
    expect(session.status).toBe("idle");
  });

  it("GET /sessions returns session list", async () => {
    const resp = await request("GET", "/sessions");
    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.data)).toBe(true);
    expect((resp.data as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("project endpoints create workspaces and scope sessions", async () => {
    const root = ".forge-test-http-int-workspaces";
    const workspace = join(root, "project-a");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });

    const createdProject = await request("POST", "/projects", {
      name: "HTTP Project",
      path: workspace,
      trustState: "trusted",
    });
    expect(createdProject.status).toBe(201);
    const project = createdProject.data as { id: string; path: string };
    expect(project.id).toBeDefined();

    const session = await request("POST", "/sessions", {
      title: "project scoped",
      projectId: project.id,
    });
    expect(session.status).toBe(201);
    expect((session.data as { projectId: string }).projectId).toBe(project.id);

    const scoped = await request("GET", `/projects/${project.id}/sessions`);
    expect(scoped.status).toBe(200);
    expect((scoped.data as Array<{ title: string }>).some((item) => item.title === "project scoped")).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });

  it("full non-blocking turn via HTTP", async () => {
    const create = await request("POST", "/sessions", { title: "full-turn" });
    expect(create.status).toBe(201);
    const sessionId = (create.data as { id: string }).id;

    const msg = await request("POST", `/sessions/${sessionId}/messages`, { text: "hello" });
    expect(msg.status).toBe(202);

    // Wait for turn to complete
    await new Promise((r) => setTimeout(r, 100));
  });

  it("GET /sessions/:id/thread returns events", async () => {
    const create = await request("POST", "/sessions", { title: "thread-test" });
    const sessionId = (create.data as { id: string }).id;

    await request("POST", `/sessions/${sessionId}/messages`, { text: "test" });
    await new Promise((r) => setTimeout(r, 100));

    const thread = await request("GET", `/sessions/${sessionId}/thread`);
    expect(thread.status).toBe(200);
    const events = thread.data as unknown[];
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect((events[0] as { type: string }).type).toBeDefined();
  });

  it("GET /sessions/:id/usage returns token and cache telemetry", async () => {
    api.setModelProvider(makeProvider([
      {
        text: "Usage response",
        finishReason: "stop",
        rawUsage: {
          input_tokens: 900,
          output_tokens: 100,
          total_tokens: 1000,
          cache_hit_tokens: 800,
          cache_miss_tokens: 100,
          reasoning_tokens: 25,
        },
      },
    ], {
      provider: "deepseek",
      model: "deepseek-test",
      contextWindowTokens: 1_000_000,
      requiresUsage: true,
      pricing: { cacheHit: 0.02, input: 1, output: 2, currency: "¥" },
    }));

    const create = await request("POST", "/sessions", { title: "usage-test" });
    const sessionId = (create.data as { id: string }).id;

    await request("POST", `/sessions/${sessionId}/messages`, { text: "usage" });
    await new Promise((r) => setTimeout(r, 100));

    const usage = await request("GET", `/sessions/${sessionId}/usage`);
    expect(usage.status).toBe(200);
    expect(usage.data).toMatchObject({
      sessionId,
      records: 1,
      contextUsedPercent: 0.09,
      cacheHitRateNow: (800 / 900) * 100,
      inputTokens: 900,
      outputTokens: 100,
      reasoningTokens: 25,
      estimated: false,
    });

    const records = await request("GET", `/sessions/${sessionId}/usage-records`);
    expect(records.status).toBe(200);
    expect(records.data).toMatchObject([
      {
        provider: "deepseek",
        model: "deepseek-test",
        contextUsedPercent: 0.09,
      },
    ]);

    const thread = await request("GET", `/sessions/${sessionId}/thread`);
    expect((thread.data as Array<{ type: string }>).some((event) => event.type === "usage_event")).toBe(true);
  });

  it("trigger CRUD endpoints work end-to-end", async () => {
    const create = await request("POST", "/sessions", { title: "trigger-test" });
    const sessionId = (create.data as { id: string }).id;

    // Create trigger
    const triggerResp = await request("POST", `/sessions/${sessionId}/triggers`, {
      schedule: "0 9 * * 1-5",
      prompt: "weekday morning task",
    });
    expect(triggerResp.status).toBe(201);
    const triggerId = (triggerResp.data as { id: string }).id;
    expect(triggerId).toBeDefined();

    // List triggers
    const list = await request("GET", `/sessions/${sessionId}/triggers`);
    expect(list.status).toBe(200);
    expect((list.data as unknown[]).length).toBe(1);

    // Delete trigger
    const del = await request("DELETE", `/sessions/${sessionId}/triggers/${triggerId}`);
    expect(del.status).toBe(200);

    // Verify deleted
    const listAfter = await request("GET", `/sessions/${sessionId}/triggers`);
    expect((listAfter.data as unknown[]).length).toBe(0);
  });

  it("DELETE /sessions/:id archives a session", async () => {
    const create = await request("POST", "/sessions", { title: "to-delete" });
    const sessionId = (create.data as { id: string }).id;

    const del = await request("DELETE", `/sessions/${sessionId}`);
    expect(del.status).toBe(200);

    const get = await request("GET", `/sessions/${sessionId}`);
    expect((get.data as { status: string }).status).toBe("archived");
  });

  it("returns 404 for non-existent session", async () => {
    const resp = await request("GET", "/sessions/nonexistent");
    expect(resp.status).toBe(404);
  });

  it("returns 404 for unknown route", async () => {
    const resp = await request("GET", "/unknown/path");
    expect(resp.status).toBe(404);
  });

  it("returns 400 for missing title on session create", async () => {
    const resp = await request("POST", "/sessions", {});
    expect(resp.status).toBe(400);
  });
});
