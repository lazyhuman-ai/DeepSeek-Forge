import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { CoreAPI } from "../../src/core/core-api.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { HttpGateway } from "../../src/gateways/http/http-gateway.js";
import { createHttpServer } from "../../src/gateways/http/http-server.js";

let server: http.Server;
let baseUrl: string;
let api: CoreAPI;
let gateway: HttpGateway;

function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      url,
      {
        method,
        headers: { "Content-Type": "application/json" },
        timeout: 5_000,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: raw });
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

describe("ForgeWebridge HTTP routes", () => {
  beforeAll(async () => {
    api = new CoreAPI(new ToolRegistry(), { dataDir: ".forge-test-webridge-http" });
    api.initWebridgeRuntime({ commandTimeoutMs: 1_000 });
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

  it("lets the extension register, poll a command, and submit the result", async () => {
    const registered = await request("POST", "/webridge/register", {
      name: "ForgeWebridge Test",
      version: "0.1.0",
    });
    expect(registered.status).toBe(201);
    const clientId = (registered.data as { clientId: string }).clientId;
    expect(clientId).toBeTruthy();

    const runtime = api.getWebridgeRuntime();
    expect(runtime).not.toBeNull();
    const createPromise = runtime!.createTab("s1");

    const polled = await request("GET", `/webridge/commands?clientId=${clientId}&timeoutMs=100`);
    expect(polled.status).toBe(200);
    const command = (polled.data as { command: { id: string; kind: string } }).command;
    expect(command.kind).toBe("create_tab");

    const submitted = await request("POST", "/webridge/results", {
      clientId,
      commandId: command.id,
      ok: true,
      output: { tabId: "tab-http" },
    });
    expect(submitted.status).toBe(200);
    await expect(createPromise).resolves.toBe("tab-http");
  });

  it("reports connected clients", async () => {
    const status = await request("GET", "/webridge/status");
    expect(status.status).toBe(200);
    const data = status.data as { state: string; health: { state: string }; clients: Array<{ clientId: string; health: string }> };
    expect(data.state).toBe("online");
    expect(data.health.state).toBe("online");
    const clients = data.clients;
    expect(clients.length).toBeGreaterThanOrEqual(1);
    expect(clients[0]!.health).toBe("online");
  });

  it("reports Webridge capability through unauthenticated discovery", async () => {
    const discovery = await request("GET", "/discovery");
    expect(discovery.status).toBe(200);
    expect(discovery.data).toMatchObject({
      app: "ForgeAgent",
      capabilities: {
        forgeWebridge: true,
        loopbackAutoPair: true,
      },
      webridge: {
        enabled: true,
      },
    });
  });

  it("accepts extension heartbeat and returns runtime health", async () => {
    const heartbeat = await request("POST", "/webridge/heartbeat", {
      clientId: "heartbeat-client",
      name: "ForgeWebridge Test",
      version: "0.2.0",
      state: "polling",
    });

    expect(heartbeat.status).toBe(200);
    const data = heartbeat.data as { ok: boolean; health: { state: string; clients: Array<{ clientId: string; extensionState?: string }> } };
    expect(data.ok).toBe(true);
    expect(data.health.state).toBe("online");
    expect(data.health.clients).toContainEqual(expect.objectContaining({
      clientId: "heartbeat-client",
      extensionState: "polling",
    }));
  });
});
