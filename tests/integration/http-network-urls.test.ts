import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { join } from "node:path";

let tailscalePrefs = {
  CorpDNS: true,
  RouteAll: true,
};

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (
      file: string,
      args: string[],
      optionsOrCallback: unknown,
      callbackMaybe?: unknown,
    ) => {
      const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : callbackMaybe;
      const done = callback as ((error: Error | null, stdout: string, stderr: string) => void) | undefined;
      queueMicrotask(() => {
        if (file !== "tailscale") {
          done?.(new Error("command not found"), "", "");
          return;
        }
        const command = args.join(" ");
        if (command === "status --json") {
          done?.(null, JSON.stringify({
            BackendState: "Running",
            TailscaleIPs: ["100.88.12.34", "fd7a:115c:a1e0::1234"],
            Health: [],
          }), "");
          return;
        }
        if (command === "debug prefs") {
          done?.(null, JSON.stringify(tailscalePrefs), "");
          return;
        }
        if (command === "set --accept-dns=false --accept-routes=false") {
          tailscalePrefs = { CorpDNS: false, RouteAll: false };
          done?.(null, "", "");
          return;
        }
        done?.(new Error(`unexpected tailscale command: ${command}`), "", "");
      });
      return {} as ReturnType<typeof actual.execFile>;
    },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    hostname: () => "Forge Test Mac",
    networkInterfaces: () => ({
      en0: [
        { address: "192.168.4.20", family: "IPv4", internal: false },
      ],
      proxyTun: [
        { address: "198.18.0.1", family: "IPv4", internal: false },
        { address: "169.254.10.20", family: "IPv4", internal: false },
      ],
      tailscale0: [
        { address: "100.88.12.34", family: "IPv4", internal: false },
        { address: "fd7a:115c:a1e0::1234", family: "IPv6", internal: false },
      ],
      lo0: [
        { address: "127.0.0.1", family: "IPv4", internal: true },
      ],
    }),
  };
});

const DATA_DIR = ".forge-test-http-network-urls";

type ResponseData = {
  status: number;
  data: unknown;
};

let baseUrl: string;
let server: http.Server;
let gateway: import("../../src/gateways/http/http-gateway.js").HttpGateway;
let authStore: import("../../src/auth/auth-store.js").AuthStore;
let originalRemoteUrls: string | undefined;

function request(method: string, path: string, options?: { body?: unknown; token?: string }): Promise<ResponseData> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyRaw = options?.body ? JSON.stringify(options.body) : undefined;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options?.token) headers.Authorization = `Bearer ${options.token}`;
    const req = http.request(url, { method, headers, timeout: 5000 }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode!, data: raw ? JSON.parse(raw) : null });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    if (bodyRaw) req.write(bodyRaw);
    req.end();
  });
}

async function pairDevice(): Promise<string> {
  const code = authStore.issuePairingCode();
  const paired = await request("POST", "/auth/pair", {
    body: { code: code.code, name: "Pixel 9", kind: "android" },
  });
  expect(paired.status).toBe(201);
  return (paired.data as { token: string }).token;
}

describe("HTTP network URLs", () => {
  beforeEach(async () => {
    tailscalePrefs = { CorpDNS: true, RouteAll: true };
    originalRemoteUrls = process.env.FORGE_REMOTE_URLS;
    process.env.FORGE_REMOTE_URLS = "https://forge.example.test, http://100.120.10.9:3000/";
    rmSync(DATA_DIR, { recursive: true, force: true });

    const [{ CoreAPI }, { ToolRegistry }, { AuthStore }, { HttpGateway }, { createHttpServer }] = await Promise.all([
      import("../../src/core/core-api.js"),
      import("../../src/tools/tool-registry.js"),
      import("../../src/auth/auth-store.js"),
      import("../../src/gateways/http/http-gateway.js"),
      import("../../src/gateways/http/http-server.js"),
    ]);
    const api = new CoreAPI(new ToolRegistry(), { dataDir: DATA_DIR });
    authStore = new AuthStore(join(DATA_DIR, "auth"));
    gateway = new HttpGateway(api);
    server = createHttpServer(api, gateway, {
      authStore,
      discovery: { dataDir: DATA_DIR, port: 31337 },
    });
    server.listen(0);
    await once(server, "listening");
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    if (originalRemoteUrls === undefined) {
      delete process.env.FORGE_REMOTE_URLS;
    } else {
      process.env.FORGE_REMOTE_URLS = originalRemoteUrls;
    }
    gateway.destroy();
    server.close();
    await once(server, "close").catch(() => undefined);
  });

  it("returns LAN, Tailscale, and configured remote URLs while preserving legacy fields", async () => {
    const token = await pairDevice();
    const response = await request("GET", "/network-urls", { token });
    expect(response.status).toBe(200);
    const data = response.data as {
      localUrl: string;
      lanUrls: string[];
      tailnetUrls: string[];
      remoteUrls: string[];
      recommendedRemoteUrl: string;
      preferredUrl: string;
      remoteAccessStatus: string;
      networkUrls: { preferredUrl: string; tailnetUrls: string[] };
    };
    expect(data.localUrl).toBe("http://127.0.0.1:31337");
    expect(data.lanUrls).toContain("http://192.168.4.20:31337");
    expect(data.lanUrls).not.toContain("http://198.18.0.1:31337");
    expect(data.lanUrls).not.toContain("http://169.254.10.20:31337");
    expect(data.tailnetUrls).toContain("http://100.88.12.34:31337");
    expect(data.tailnetUrls).toContain("http://[fd7a:115c:a1e0::1234]:31337");
    expect(data.remoteUrls).toEqual(["https://forge.example.test", "http://100.120.10.9:3000"]);
    expect(data.recommendedRemoteUrl).toBe("http://100.88.12.34:31337");
    expect(data.preferredUrl).toBe(data.recommendedRemoteUrl);
    expect(data.remoteAccessStatus).toBe("tailscale_ready");
    expect(data.networkUrls.preferredUrl).toBe(data.preferredUrl);
    expect(data.networkUrls.tailnetUrls).toEqual(data.tailnetUrls);
  });

  it("includes expanded endpoint metadata in the pairing response", async () => {
    const code = authStore.issuePairingCode();
    const response = await request("POST", "/auth/pair", {
      body: { code: code.code, name: "Pixel 9", kind: "android" },
    });
    expect(response.status).toBe(201);
    const data = response.data as {
      networkUrls: { recommendedRemoteUrl: string; remoteAccessStatus: string };
    };
    expect(data.networkUrls.recommendedRemoteUrl).toBe("http://100.88.12.34:31337");
    expect(data.networkUrls.remoteAccessStatus).toBe("tailscale_ready");
  });

  it("does not publish LAN or Tailscale URLs when the gateway is bound to loopback", async () => {
    gateway.destroy();
    server.close();
    await once(server, "close").catch(() => undefined);

    const [{ CoreAPI }, { ToolRegistry }, { AuthStore }, { HttpGateway }, { createHttpServer }] = await Promise.all([
      import("../../src/core/core-api.js"),
      import("../../src/tools/tool-registry.js"),
      import("../../src/auth/auth-store.js"),
      import("../../src/gateways/http/http-gateway.js"),
      import("../../src/gateways/http/http-server.js"),
    ]);
    rmSync(DATA_DIR, { recursive: true, force: true });
    const api = new CoreAPI(new ToolRegistry(), { dataDir: DATA_DIR });
    authStore = new AuthStore(join(DATA_DIR, "auth"));
    gateway = new HttpGateway(api);
    server = createHttpServer(api, gateway, {
      authStore,
      discovery: { dataDir: DATA_DIR, host: "127.0.0.1", port: 31337 },
    });
    server.listen(0);
    await once(server, "listening");
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const token = await pairDevice();
    const response = await request("GET", "/network-urls", { token });
    expect(response.status).toBe(200);
    const data = response.data as {
      localUrl: string;
      lanUrls: string[];
      tailnetUrls: string[];
      remoteUrls: string[];
      preferredUrl: string;
      remoteAccessStatus: string;
    };
    expect(data.localUrl).toBe("http://127.0.0.1:31337");
    expect(data.lanUrls).toEqual([]);
    expect(data.tailnetUrls).toEqual([]);
    expect(data.remoteUrls).toEqual(["https://forge.example.test", "http://100.120.10.9:3000"]);
    expect(data.preferredUrl).toBe("https://forge.example.test");
    expect(data.remoteAccessStatus).toBe("custom_remote_ready");
  });

  it("reports and optimizes Tailscale DNS/route takeover from the remote access endpoint", async () => {
    const token = await pairDevice();
    const before = await request("GET", "/remote-access", { token });
    expect(before.status).toBe(200);
    const beforeData = before.data as {
      tailscale: {
        installed: boolean;
        running: boolean;
        needsOptimization: boolean;
        optimized: boolean;
        prefs: { acceptDns?: boolean; acceptRoutes?: boolean };
      };
    };
    expect(beforeData.tailscale.installed).toBe(true);
    expect(beforeData.tailscale.running).toBe(true);
    expect(beforeData.tailscale.needsOptimization).toBe(true);
    expect(beforeData.tailscale.optimized).toBe(false);
    expect(beforeData.tailscale.prefs.acceptDns).toBe(true);
    expect(beforeData.tailscale.prefs.acceptRoutes).toBe(true);

    const after = await request("POST", "/remote-access/tailscale/optimize", { token });
    expect(after.status).toBe(200);
    const afterData = after.data as {
      tailscale: {
        needsOptimization: boolean;
        optimized: boolean;
        prefs: { acceptDns?: boolean; acceptRoutes?: boolean };
      };
    };
    expect(afterData.tailscale.needsOptimization).toBe(false);
    expect(afterData.tailscale.optimized).toBe(true);
    expect(afterData.tailscale.prefs.acceptDns).toBe(false);
    expect(afterData.tailscale.prefs.acceptRoutes).toBe(false);
  });
});
