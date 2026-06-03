import http from "node:http";
import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CoreAPI } from "../../src/core/core-api.js";
import { createHttpServer } from "../../src/gateways/http/http-server.js";
import { HttpGateway } from "../../src/gateways/http/http-gateway.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

const DATA_DIR = ".forge-test-http-skills";

let baseUrl: string;
let server: http.Server;
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
            resolve({ status: res.statusCode!, data: raw ? JSON.parse(raw) : null });
          } catch {
            resolve({ status: res.statusCode!, data: raw });
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

describe("HTTP skill ecosystem endpoints", () => {
  beforeAll(async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    const skillDir = join(DATA_DIR, "skills", "http-helper");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), [
      "---",
      "name: http-helper",
      "description: Exercise HTTP skill endpoints",
      "---",
      "",
      "# HTTP Helper",
    ].join("\n"));

    const api = new CoreAPI(new ToolRegistry(), { dataDir: DATA_DIR });
    api.initSkillEcosystem({ autoRun: false });
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
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("lists, fetches, disables, enables, and replays skill events", async () => {
    const list = await request("GET", "/skills");
    expect(list.status).toBe(200);
    expect((list.data as { skills: Array<{ name: string }> }).skills.some((skill) => skill.name === "http-helper")).toBe(true);

    const detail = await request("GET", "/skills/http-helper");
    expect(detail.status).toBe(200);
    expect(detail.data).toMatchObject({ name: "http-helper", status: "active" });

    const disabled = await request("POST", "/skills/http-helper/disable", { reason: "test" });
    expect(disabled.status).toBe(200);
    expect(disabled.data).toMatchObject({ status: "disabled" });

    const enabled = await request("POST", "/skills/http-helper/enable");
    expect(enabled.status).toBe(200);
    expect(enabled.data).toMatchObject({ status: "active" });

    const events = await request("GET", "/skill-events?afterSeq=0");
    expect(events.status).toBe(200);
    expect((events.data as Array<{ action: string }>).map((event) => event.action)).toEqual(
      expect.arrayContaining(["disabled", "enabled"]),
    );
  });
});
