import http from "node:http";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CoreAPI } from "../../src/core/core-api.js";
import { createHttpServer } from "../../src/gateways/http/http-server.js";
import { HttpGateway } from "../../src/gateways/http/http-gateway.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

const DATA_DIR = ".forge-test-http-mcp";

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

describe("HTTP MCP endpoints", () => {
  beforeAll(async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    const api = new CoreAPI(new ToolRegistry(), { dataDir: DATA_DIR });
    api.registerBuiltInTools();
    api.initMcpEcosystem({ rootDir: `${DATA_DIR}/mcp` });
    await api.startMcpEcosystem();
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

  it("adds, lists, enables, disables, and replays MCP events", async () => {
    const created = await request("POST", "/mcp/servers", {
      name: "Lazy Missing",
      transport: "stdio",
      command: process.execPath,
      args: ["missing.mjs"],
      trust: "trusted",
      launchMode: "lazy",
      enabled: false,
    });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ name: "Lazy Missing", transport: "stdio" });
    const serverId = (created.data as { id: string }).id;

    const enabled = await request("POST", `/mcp/servers/${serverId}/enable`);
    expect(enabled.status).toBe(200);
    expect(enabled.data).toMatchObject({ id: serverId, enabled: true });

    const list = await request("GET", "/mcp/servers");
    expect(list.status).toBe(200);
    expect(list.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: serverId })]));

    const tools = await request("GET", "/mcp/tools");
    expect(tools.status).toBe(200);
    expect(tools.data).toEqual(expect.arrayContaining([expect.objectContaining({
      serverId,
      originalName: "connect",
    })]));

    const disabled = await request("POST", `/mcp/servers/${serverId}/disable`);
    expect(disabled.status).toBe(200);

    const events = await request("GET", "/mcp/events?afterSeq=0");
    expect(events.status).toBe(200);
    expect((events.data as Array<{ message: string }>).map((event) => event.message).join("\n")).toContain("Lazy Missing");
  });
});
