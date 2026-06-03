import type { LinkInfo } from "../browser/browser-runtime.js";
import type {
  BrowserPageInfo,
  BrowserToolRuntime,
} from "../../tools/built-in/browser-shared.js";

export type WebridgeCommandKind =
  | "create_tab"
  | "close_tab"
  | "navigate"
  | "current_page"
  | "wait_for_selector"
  | "type_text"
  | "press_key"
  | "click"
  | "scroll"
  | "extract"
  | "extract_links"
  | "screenshot";

export type WebridgeClientInfo = {
  clientId: string;
  name: string;
  version?: string;
  userAgent?: string;
  connectedAt: string;
  lastSeenAt: string;
  lastHeartbeatAt?: string;
  extensionState?: string;
};

export type WebridgeHealthState = "online" | "stale" | "offline";

export type PublicWebridgeClientInfo = Omit<WebridgeClientInfo, "lastSeenAt"> & {
  lastSeenAt: string;
  pendingCommands: number;
  health: WebridgeHealthState;
  ageMs: number;
  hasLongPoll: boolean;
};

export type WebridgeHealth = {
  state: WebridgeHealthState;
  message: string;
  staleAfterMs: number;
  offlineAfterMs: number;
  clients: PublicWebridgeClientInfo[];
};

export type WebridgeCommand = {
  id: string;
  kind: WebridgeCommandKind;
  sessionId: string;
  tabId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type WebridgeCommandResult = {
  commandId: string;
  ok: boolean;
  output?: unknown;
  error?: string;
};

type PendingCommand = WebridgeCommand & {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PollWaiter = {
  clientId: string;
  resolve: (command: WebridgeCommand | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type WebridgeRuntimeOptions = {
  now?: () => string;
  commandTimeoutMs?: number;
  staleAfterMs?: number;
  offlineAfterMs?: number;
  healthCheckIntervalMs?: number;
  onHealthChange?: (state: WebridgeHealthState, message: string) => void;
};

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_TIMEOUT_MS = 25_000;
const DEFAULT_STALE_AFTER_MS = 45_000;
const DEFAULT_OFFLINE_AFTER_MS = 120_000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 5_000;

export class WebridgeRuntime implements BrowserToolRuntime {
  #clients = new Map<string, WebridgeClientInfo>();
  #queues = new Map<string, WebridgeCommand[]>();
  #pending = new Map<string, PendingCommand>();
  #waiters: PollWaiter[] = [];
  #sessionTabs = new Map<string, string>();
  #now: () => string;
  #commandTimeoutMs: number;
  #staleAfterMs: number;
  #offlineAfterMs: number;
  #onHealthChange: ((state: WebridgeHealthState, message: string) => void) | undefined;
  #healthTimer: ReturnType<typeof setInterval> | undefined;
  #lastHealthState: WebridgeHealthState = "offline";
  #closed = false;

  constructor(options?: WebridgeRuntimeOptions) {
    this.#now = options?.now ?? (() => new Date().toISOString());
    this.#commandTimeoutMs = options?.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#staleAfterMs = options?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.#offlineAfterMs = options?.offlineAfterMs ?? DEFAULT_OFFLINE_AFTER_MS;
    this.#onHealthChange = options?.onHealthChange;
    const intervalMs = options?.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    if (intervalMs > 0) {
      this.#healthTimer = setInterval(() => this.#emitHealthIfChanged(), intervalMs);
      this.#healthTimer.unref?.();
    }
  }

  registerClient(input?: {
    clientId?: string;
    name?: string;
    version?: string;
    userAgent?: string;
  }): WebridgeClientInfo {
    if (this.#closed) throw new Error("ForgeWebridge runtime is shutting down.");
    const clientId = input?.clientId && input.clientId.trim()
      ? input.clientId.trim()
      : crypto.randomUUID();
    const existing = this.#clients.get(clientId);
    const now = this.#now();
    const info: WebridgeClientInfo = {
      clientId,
      name: input?.name?.trim() || existing?.name || "ForgeWebridge",
      connectedAt: existing?.connectedAt ?? now,
      lastSeenAt: now,
      ...(existing?.lastHeartbeatAt ? { lastHeartbeatAt: existing.lastHeartbeatAt } : {}),
      ...(existing?.extensionState ? { extensionState: existing.extensionState } : {}),
      ...(input?.version ? { version: input.version } : existing?.version ? { version: existing.version } : {}),
      ...(input?.userAgent ? { userAgent: input.userAgent } : existing?.userAgent ? { userAgent: existing.userAgent } : {}),
    };
    this.#clients.set(clientId, info);
    this.#queues.set(clientId, this.#queues.get(clientId) ?? []);
    this.#emitHealthIfChanged();
    return info;
  }

  heartbeatClient(input: {
    clientId: string;
    name?: string;
    version?: string;
    userAgent?: string;
    extensionState?: string;
  }): WebridgeHealth {
    const client = this.registerClient(input);
    client.lastHeartbeatAt = this.#now();
    if (input.extensionState) client.extensionState = input.extensionState;
    this.#touch(client.clientId);
    return this.getHealth();
  }

  listClients(): PublicWebridgeClientInfo[] {
    return [...this.#clients.values()].map((client) => ({
      ...client,
      pendingCommands: this.#queues.get(client.clientId)?.length ?? 0,
      health: this.#clientHealth(client),
      ageMs: this.#clientAgeMs(client),
      hasLongPoll: this.#hasLongPoll(client.clientId),
    }));
  }

  getHealth(): WebridgeHealth {
    const clients = this.listClients();
    const state = this.#overallHealthFromClients(clients);
    return {
      state,
      message: this.#healthMessage(state, clients),
      staleAfterMs: this.#staleAfterMs,
      offlineAfterMs: this.#offlineAfterMs,
      clients,
    };
  }

  shutdown(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#healthTimer) {
      clearInterval(this.#healthTimer);
      this.#healthTimer = undefined;
    }

    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.#waiters = [];

    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("ForgeWebridge runtime is shutting down."));
    }
    this.#pending.clear();
    this.#queues.clear();
  }

  async pollCommand(
    clientId: string,
    timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  ): Promise<WebridgeCommand | null> {
    if (this.#closed) return null;
    if (!this.#clients.has(clientId)) {
      this.registerClient({ clientId, name: "ForgeWebridge" });
    }
    this.#touch(clientId);
    const queue = this.#queues.get(clientId) ?? [];
    const command = queue.shift();
    if (command) return command;

    return await new Promise<WebridgeCommand | null>((resolve) => {
      const waiter: PollWaiter = {
        clientId,
        resolve,
        timer: setTimeout(() => {
          this.#waiters = this.#waiters.filter((w) => w !== waiter);
          resolve(null);
        }, Math.max(1, timeoutMs)),
      };
      this.#waiters.push(waiter);
    });
  }

  submitResult(
    clientId: string,
    result: WebridgeCommandResult,
  ): void {
    this.#touch(clientId);
    const pending = this.#pending.get(result.commandId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(result.commandId);
    if (result.ok) {
      pending.resolve(result.output);
    } else {
      pending.reject(new Error(result.error || "ForgeWebridge command failed without an error message."));
    }
  }

  async createTab(sessionId: string): Promise<string> {
    const output = await this.#send(sessionId, "create_tab", {});
    const tabId = requireStringOutput(output, "tabId");
    this.#sessionTabs.set(sessionId, tabId);
    return tabId;
  }

  async closeTab(sessionId: string): Promise<void> {
    const tabId = this.#sessionTabs.get(sessionId);
    await this.#send(sessionId, "close_tab", {}, tabId);
    this.#sessionTabs.delete(sessionId);
  }

  async navigate(sessionId: string, url: string): Promise<void> {
    await this.#send(sessionId, "navigate", { url }, this.#requireTab(sessionId));
  }

  async click(sessionId: string, selector: string): Promise<void> {
    await this.#send(sessionId, "click", { selector }, this.#requireTab(sessionId));
  }

  async typeText(sessionId: string, selector: string, text: string): Promise<void> {
    await this.#send(sessionId, "type_text", { selector, text }, this.#requireTab(sessionId));
  }

  async pressKey(sessionId: string, key: string): Promise<void> {
    await this.#send(sessionId, "press_key", { key }, this.#requireTab(sessionId));
  }

  async scroll(sessionId: string, deltaY: number): Promise<void> {
    await this.#send(sessionId, "scroll", { deltaY }, this.#requireTab(sessionId));
  }

  async scrollToBottom(sessionId: string): Promise<void> {
    await this.#send(sessionId, "scroll", { toBottom: true }, this.#requireTab(sessionId));
  }

  async waitForSelector(
    sessionId: string,
    selector: string,
    timeoutMs?: number,
  ): Promise<boolean> {
    const output = await this.#send(
      sessionId,
      "wait_for_selector",
      { selector, timeoutMs },
      this.#requireTab(sessionId),
    );
    return Boolean(output);
  }

  async extract(sessionId: string, selector?: string): Promise<string> {
    const output = await this.#send(
      sessionId,
      "extract",
      selector ? { selector } : {},
      this.#requireTab(sessionId),
    );
    return typeof output === "string" ? output : JSON.stringify(output);
  }

  async extractLinks(sessionId: string, selector?: string): Promise<LinkInfo[]> {
    const output = await this.#send(
      sessionId,
      "extract_links",
      selector ? { selector } : {},
      this.#requireTab(sessionId),
    );
    if (!Array.isArray(output)) return [];
    return output
      .map((item): LinkInfo | null => {
        if (!item || typeof item !== "object") return null;
        const href = (item as { href?: unknown }).href;
        const text = (item as { text?: unknown }).text;
        return typeof href === "string"
          ? { href, text: typeof text === "string" ? text : "" }
          : null;
      })
      .filter((item): item is LinkInfo => item !== null);
  }

  async screenshot(sessionId: string): Promise<string> {
    const output = await this.#send(sessionId, "screenshot", {}, this.#requireTab(sessionId));
    return typeof output === "string" ? output : "";
  }

  async currentPage(sessionId: string): Promise<BrowserPageInfo> {
    const output = await this.#send(sessionId, "current_page", {}, this.#requireTab(sessionId));
    if (!output || typeof output !== "object") {
      return { title: "", url: "", textPreview: "" };
    }
    const value = output as Partial<BrowserPageInfo>;
    return {
      title: typeof value.title === "string" ? value.title : "",
      url: typeof value.url === "string" ? value.url : "",
      textPreview: typeof value.textPreview === "string" ? value.textPreview : "",
    };
  }

  #requireTab(sessionId: string): string {
    const tabId = this.#sessionTabs.get(sessionId);
    if (!tabId) {
      throw new Error(`No ForgeWebridge tab is attached for session ${sessionId}. Call browser_create_tab first.`);
    }
    return tabId;
  }

  async #send(
    sessionId: string,
    kind: WebridgeCommandKind,
    payload: Record<string, unknown>,
    tabId?: string,
  ): Promise<unknown> {
    if (this.#closed) {
      throw new Error("ForgeWebridge runtime is shutting down.");
    }
    const clientId = this.#selectClient();
    const command: WebridgeCommand = {
      id: crypto.randomUUID(),
      kind,
      sessionId,
      payload,
      createdAt: this.#now(),
      ...(tabId ? { tabId } : {}),
    };

    const queue = this.#queues.get(clientId) ?? [];
    this.#queues.set(clientId, queue);

    return await new Promise((resolve, reject) => {
      const pending: PendingCommand = {
        ...command,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#pending.delete(command.id);
          reject(new Error(
            `ForgeWebridge command timed out before the Chrome extension returned a result. Command: ${kind}. Recovery: confirm the ForgeWebridge extension is connected, the target tab is not blocked by login/CAPTCHA/risk-control UI, then retry.`,
          ));
        }, this.#commandTimeoutMs),
      };
      this.#pending.set(command.id, pending);
      queue.push(command);
      this.#notifyWaiter(clientId);
    });
  }

  #selectClient(): string {
    const clients = [...this.#clients.values()]
      .filter((client) => this.#clientHealth(client) !== "offline");
    if (clients.length === 0) {
      const known = this.listClients();
      const lastSeen = known
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
      throw new Error(
        [
          "ForgeWebridge Chrome extension is offline before browser command execution.",
          lastSeen
            ? `Last seen client: ${lastSeen.clientId} (${lastSeen.name}) at ${lastSeen.lastSeenAt}; ageMs=${lastSeen.ageMs}; health=${lastSeen.health}.`
            : "No ForgeWebridge Chrome extension client has registered in this gateway process.",
          "Recovery: keep Chrome open with the ForgeWebridge extension enabled. The extension should auto-pair and reconnect through the local ForgeAgent gateway; if it remains offline, refresh the extension from chrome://extensions and retry.",
          "Setup: run npm run http and load /Users/leileqi/plugins/forgewebridge/chrome-extension in Chrome. Manual pair codes are only a fallback.",
        ].join(" "),
      );
    }
    clients.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    return clients[0]!.clientId;
  }

  #touch(clientId: string): void {
    const info = this.#clients.get(clientId);
    if (!info) {
      throw new Error(`Unknown ForgeWebridge client: ${clientId}`);
    }
    info.lastSeenAt = this.#now();
    this.#emitHealthIfChanged();
  }

  #notifyWaiter(clientId: string): void {
    const queue = this.#queues.get(clientId);
    if (!queue || queue.length === 0) return;
    const index = this.#waiters.findIndex((waiter) => waiter.clientId === clientId);
    if (index === -1) return;
    const [waiter] = this.#waiters.splice(index, 1);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiter.resolve(queue.shift() ?? null);
  }

  #clientAgeMs(client: WebridgeClientInfo): number {
    const seen = Date.parse(client.lastSeenAt);
    const current = Date.parse(this.#now());
    if (!Number.isFinite(seen) || !Number.isFinite(current)) return Number.POSITIVE_INFINITY;
    return Math.max(0, current - seen);
  }

  #clientHealth(client: WebridgeClientInfo): WebridgeHealthState {
    if (this.#hasLongPoll(client.clientId)) return "online";
    const ageMs = this.#clientAgeMs(client);
    if (ageMs <= this.#staleAfterMs) return "online";
    if (ageMs <= this.#offlineAfterMs) return "stale";
    return "offline";
  }

  #hasLongPoll(clientId: string): boolean {
    return this.#waiters.some((waiter) => waiter.clientId === clientId);
  }

  #overallHealthFromClients(clients: PublicWebridgeClientInfo[]): WebridgeHealthState {
    if (clients.some((client) => client.health === "online")) return "online";
    if (clients.some((client) => client.health === "stale")) return "stale";
    return "offline";
  }

  #healthMessage(state: WebridgeHealthState, clients: PublicWebridgeClientInfo[]): string {
    if (state === "online") {
      const online = clients.filter((client) => client.health === "online").length;
      return `ForgeWebridge is online with ${online} Chrome extension client(s).`;
    }
    if (state === "stale") {
      const latest = clients.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
      return latest
        ? `ForgeWebridge is stale; latest client ${latest.clientId} was last seen at ${latest.lastSeenAt}.`
        : "ForgeWebridge is stale; no online Chrome extension client is currently long-polling.";
    }
    return clients.length > 0
      ? "ForgeWebridge is offline; all known Chrome extension clients exceeded the offline timeout."
      : "ForgeWebridge is offline; no Chrome extension client has registered yet.";
  }

  #emitHealthIfChanged(): void {
    if (!this.#onHealthChange) return;
    const health = this.getHealth();
    if (health.state === this.#lastHealthState) return;
    this.#lastHealthState = health.state;
    this.#onHealthChange(health.state, health.message);
  }
}

function requireStringOutput(output: unknown, field: string): string {
  if (output && typeof output === "object") {
    const value = (output as Record<string, unknown>)[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  throw new Error(`ForgeWebridge command returned invalid output; missing string field ${field}.`);
}
