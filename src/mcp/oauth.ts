import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

type OAuthState = {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discovery?: OAuthDiscoveryState;
  authorizationUrl?: string;
  updatedAt?: string;
};

function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, filePath);
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

export class McpOAuthStore {
  #rootDir: string;

  constructor(rootDir: string) {
    this.#rootDir = rootDir;
    mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  }

  statePath(serverId: string): string {
    return join(this.#rootDir, `${serverId}.json`);
  }

  get(serverId: string): OAuthState {
    return readJson<OAuthState>(this.statePath(serverId), {});
  }

  update(serverId: string, patch: Partial<OAuthState>): OAuthState {
    const next = { ...this.get(serverId), ...patch, updatedAt: new Date().toISOString() };
    atomicWriteJson(this.statePath(serverId), next);
    return next;
  }

  clear(serverId: string, scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") {
      atomicWriteJson(this.statePath(serverId), {});
      return;
    }
    const state = this.get(serverId);
    if (scope === "client") delete state.clientInformation;
    if (scope === "tokens") delete state.tokens;
    if (scope === "verifier") delete state.codeVerifier;
    if (scope === "discovery") delete state.discovery;
    atomicWriteJson(this.statePath(serverId), state);
  }
}

export class ForgeMcpOAuthProvider implements OAuthClientProvider {
  #store: McpOAuthStore;
  #serverId: string;
  #redirectUrl: string;

  constructor(options: { store: McpOAuthStore; serverId: string; redirectUrl: string }) {
    this.#store = options.store;
    this.#serverId = options.serverId;
    this.#redirectUrl = options.redirectUrl;
  }

  get redirectUrl(): string {
    return this.#redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "ForgeAgent MCP Client",
      client_uri: "http://localhost",
      redirect_uris: [this.#redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return crypto.randomBytes(16).toString("hex");
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.#store.get(this.#serverId).clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.#store.update(this.#serverId, { clientInformation });
  }

  tokens(): OAuthTokens | undefined {
    return this.#store.get(this.#serverId).tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.#store.update(this.#serverId, { tokens });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.#store.update(this.#serverId, { authorizationUrl: authorizationUrl.toString() });
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.#store.update(this.#serverId, { codeVerifier });
  }

  codeVerifier(): string {
    const verifier = this.#store.get(this.#serverId).codeVerifier;
    if (!verifier) throw new Error(`Missing OAuth code verifier for MCP server ${this.#serverId}`);
    return verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.#store.update(this.#serverId, { discovery: state });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#store.get(this.#serverId).discovery;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    this.#store.clear(this.#serverId, scope);
  }
}
