import type {
  RuntimeAttachmentPayload,
  RuntimeEvent,
  SystemEvent,
} from "../streams/event-types.js";
import { SessionThreadStore } from "../streams/session-thread-store.js";
import { transition } from "./session-supervisor.js";
import type { Session } from "../streams/event-types.js";
import { BrowserRuntime } from "../runtimes/browser/browser-runtime.js";
import type { RuntimeStatus } from "../runtimes/runtime-status.js";
import type { TabAttachmentChange, TabManager } from "../runtimes/browser/tab-manager.js";
import type { NotificationHub } from "./notification-hub.js";
import type { SystemStreamStore } from "../streams/system-stream-store.js";

export type RuntimeEntry = {
  name: string;
  runtime: BrowserRuntime;
};

export type RuntimeRehydrateReport = {
  attachmentsRestored: number;
  attachmentsFailed: number;
  runtimeBlockedSessions: number;
  recoveredSessions: string[];
};

type RuntimeAttachmentSnapshot = {
  runtimeName: string;
  sessionId: string;
  tabId: string;
  targetInfo: RuntimeAttachmentPayload["targetInfo"];
};

const STATUS_TO_DETAIL: Record<string, RuntimeEvent["detail"]> = {
  offline: "disconnected",
  starting: "connected",
  online: "connected",
  degraded: "degraded",
  recovering: "recovered",
  failed: "failed",
};

export class RuntimeManager {
  #runtimes = new Map<string, BrowserRuntime>();
  #threadStore: SessionThreadStore;
  #sessions: Map<string, Session>;
  #pollInterval = 30_000;
  #intervals = new Map<string, ReturnType<typeof setInterval>>();
  #attachmentUnsubscribers = new Map<string, () => void>();
  #runtimeBlockedSessions = new Map<string, Set<string>>();
  #notificationHub: NotificationHub;
  #systemStreamStore: SystemStreamStore;
  #nextSeq: () => number;
  #now: () => string;
  #onRecovered: ((sessionId: string) => void) | undefined;
  #onBlocked: ((sessionId: string) => void) | undefined;

  constructor(
    threadStore: SessionThreadStore,
    sessions: Map<string, Session>,
    notificationHub: NotificationHub,
    systemStreamStore: SystemStreamStore,
    nextSeq: () => number,
    now: () => string,
    options?: {
      onRecovered?: (sessionId: string) => void;
      onBlocked?: (sessionId: string) => void;
    },
  ) {
    this.#threadStore = threadStore;
    this.#sessions = sessions;
    this.#notificationHub = notificationHub;
    this.#systemStreamStore = systemStreamStore;
    this.#nextSeq = nextSeq;
    this.#now = now;
    this.#onRecovered = options?.onRecovered;
    this.#onBlocked = options?.onBlocked;
  }

  registerRuntime(name: string, runtime: BrowserRuntime): void {
    this.#runtimes.set(name, runtime);

    runtime.onStatusChange((status) => {
      this.#onStatusChange(name, runtime, status);
    });
    this.#attachmentUnsubscribers.get(name)?.();
    this.#attachmentUnsubscribers.set(
      name,
      runtime.tabs.onAttachmentChange((change) => {
        this.#recordAttachmentChange(name, change);
      }),
    );
  }

  async startAll(): Promise<void> {
    for (const [name, runtime] of this.#runtimes) {
      await runtime.connect();
      this.#startHealthPoll(name, runtime);
    }
  }

  async rehydrateFromThreads(): Promise<RuntimeRehydrateReport> {
    const latestAttachments = new Map<string, RuntimeAttachmentSnapshot | null>();
    this.#runtimeBlockedSessions.clear();

    for (const session of this.#sessions.values()) {
      for (const event of this.#threadStore.getThread(session.id)) {
        if (event.type !== "runtime_event") continue;
        const payload = event.payload;
        if (payload?.kind === "attachment") {
          const key = `${event.runtimeKind}\0${event.sessionId}`;
          if (event.detail === "detached") {
            latestAttachments.set(key, null);
          } else {
            latestAttachments.set(key, {
              runtimeName: event.runtimeKind,
              sessionId: event.sessionId,
              tabId: payload.tabId,
              targetInfo: payload.targetInfo,
            });
          }
        } else if (payload?.kind === "runtime_block" && payload.blockedSession) {
          let blocked = this.#runtimeBlockedSessions.get(event.runtimeKind);
          if (!blocked) {
            blocked = new Set();
            this.#runtimeBlockedSessions.set(event.runtimeKind, blocked);
          }
          blocked.add(event.sessionId);
        } else if (payload?.kind === "runtime_recovered" && payload.recoveredSession) {
          this.#runtimeBlockedSessions.get(event.runtimeKind)?.delete(event.sessionId);
        }
      }
    }

    const report: RuntimeRehydrateReport = {
      attachmentsRestored: 0,
      attachmentsFailed: 0,
      runtimeBlockedSessions: 0,
      recoveredSessions: [],
    };

    for (const snapshot of latestAttachments.values()) {
      if (!snapshot) continue;
      const runtime = this.#runtimes.get(snapshot.runtimeName);
      if (!runtime) continue;
      const restored = await runtime.restoreAttachment(
        snapshot.sessionId,
        snapshot.tabId,
        snapshot.targetInfo,
      );
      if (restored) {
        report.attachmentsRestored++;
      } else {
        report.attachmentsFailed++;
        this.#recordAttachmentRestoreFailure(snapshot);
      }
    }

    for (const blocked of this.#runtimeBlockedSessions.values()) {
      report.runtimeBlockedSessions += blocked.size;
    }

    for (const [runtimeName, runtime] of this.#runtimes) {
      if (runtime.status !== "online") continue;
      const recovered = this.#recoverAffectedSessions(runtimeName, runtime.tabs);
      report.recoveredSessions.push(...recovered);
    }

    return report;
  }

  getStatus(name: string): RuntimeStatus | undefined {
    return this.#runtimes.get(name)?.status;
  }

  listRuntimes(): RuntimeEntry[] {
    return [...this.#runtimes.entries()].map(([name, runtime]) => ({
      name,
      runtime,
    }));
  }

  stop(): void {
    for (const [, interval] of this.#intervals) {
      clearInterval(interval);
    }
    this.#intervals.clear();
    for (const [, unsubscribe] of this.#attachmentUnsubscribers) {
      unsubscribe();
    }
    this.#attachmentUnsubscribers.clear();
    for (const [, runtime] of this.#runtimes) {
      runtime.stopReconnect();
    }
  }

  #startHealthPoll(name: string, runtime: BrowserRuntime): void {
    const id = setInterval(async () => {
      const healthy = await runtime.healthCheck();
      if (!healthy) {
        await runtime.simulateFailure();
      }
    }, this.#pollInterval);
    this.#intervals.set(name, id);
  }

  #onStatusChange(
    name: string,
    runtime: BrowserRuntime,
    status: RuntimeStatus,
  ): void {
    switch (status) {
      case "degraded":
      case "offline":
      case "failed":
        this.#blockAffectedSessions(name, runtime.tabs, STATUS_TO_DETAIL[status] ?? "failed");
        break;
      case "online":
        this.#recoverAffectedSessions(name, runtime.tabs);
        break;
    }
  }

  #blockAffectedSessions(
    runtimeName: string,
    tabs: TabManager,
    detail: RuntimeEvent["detail"],
  ): void {
    for (const sessionId of tabs.getSessions()) {
      const session = this.#sessions.get(sessionId);
      const shouldBlock = session?.status === "running";
      if (shouldBlock) {
        this.#onBlocked?.(sessionId);
      }

      const event: RuntimeEvent = {
        type: "runtime_event",
        seq: this.#nextSeq(),
        timestamp: this.#now(),
        sessionId,
        runtimeKind: runtimeName,
        detail,
        message: `Runtime ${runtimeName} is ${detail}`,
        payload: {
          kind: "runtime_block",
          blockedSession: shouldBlock,
        },
      };
      this.#threadStore.append(sessionId, event);

      const sysEvent: SystemEvent = {
        seq: this.#nextSeq(),
        timestamp: this.#now(),
        category: "runtime_lifecycle",
        detail,
        message: `Runtime ${runtimeName}: ${detail}`,
      };
      this.#systemStreamStore.append(sysEvent);
      this.#notificationHub.emitSessionEvent(sessionId, event);
      this.#notificationHub.emitSystemEvent(sysEvent);

      if (session && shouldBlock) {
        session.status = transition(session.status, { kind: "runtime_failure" });
        session.updatedAt = this.#now();
        this.#threadStore.writeSessionMeta(session.id, session);
        let blocked = this.#runtimeBlockedSessions.get(runtimeName);
        if (!blocked) {
          blocked = new Set();
          this.#runtimeBlockedSessions.set(runtimeName, blocked);
        }
        blocked.add(sessionId);
        this.#notificationHub.emitSessionListChanged();
      }
    }
  }

  #recordAttachmentChange(
    runtimeName: string,
    change: TabAttachmentChange,
  ): void {
    const target = change.targetInfo?.targetId
      ? ` targetId=${change.targetInfo.targetId}`
      : "";
    const previous = change.previousTabId
      ? ` previousTabId=${change.previousTabId}`
      : "";
    const message = `Runtime ${runtimeName} ${change.kind} session ${change.sessionId} to tab ${change.tabId}${target}${previous}`;
    const payload: RuntimeAttachmentPayload = {
      kind: "attachment",
      tabId: change.tabId,
      targetInfo: change.targetInfo,
    };
    if (change.previousTabId !== undefined) {
      payload.previousTabId = change.previousTabId;
    }
    if (change.previousTargetInfo !== undefined) {
      payload.previousTargetInfo = change.previousTargetInfo;
    }

    const event: RuntimeEvent = {
      type: "runtime_event",
      seq: this.#nextSeq(),
      timestamp: this.#now(),
      sessionId: change.sessionId,
      runtimeKind: runtimeName,
      detail: change.kind,
      message,
      payload,
    };
    this.#threadStore.append(change.sessionId, event);

    const sysEvent: SystemEvent = {
      seq: this.#nextSeq(),
      timestamp: this.#now(),
      category: "runtime_lifecycle",
      detail: change.kind,
      message,
    };
    this.#systemStreamStore.append(sysEvent);
    this.#notificationHub.emitSessionEvent(change.sessionId, event);
    this.#notificationHub.emitSystemEvent(sysEvent);
  }

  #recoverAffectedSessions(
    runtimeName: string,
    tabs: TabManager,
  ): string[] {
    const recoveredSessions: string[] = [];
    const blocked = this.#runtimeBlockedSessions.get(runtimeName);
    const sessionIds = new Set([
      ...tabs.getSessions(),
      ...(blocked ? [...blocked] : []),
    ]);

    for (const sessionId of sessionIds) {
      const session = this.#sessions.get(sessionId);
      const shouldRecover =
        session?.status === "blocked" &&
        (this.#runtimeBlockedSessions.get(runtimeName)?.has(sessionId) ?? false);

      const event: RuntimeEvent = {
        type: "runtime_event",
        seq: this.#nextSeq(),
        timestamp: this.#now(),
        sessionId,
        runtimeKind: runtimeName,
        detail: "recovered",
        message: `Runtime ${runtimeName} recovered`,
        payload: {
          kind: "runtime_recovered",
          recoveredSession: shouldRecover,
        },
      };
      this.#threadStore.append(sessionId, event);

      const sysEvent: SystemEvent = {
        seq: this.#nextSeq(),
        timestamp: this.#now(),
        category: "runtime_lifecycle",
        detail: "recovered",
        message: `Runtime ${runtimeName} recovered`,
      };
      this.#systemStreamStore.append(sysEvent);
      this.#notificationHub.emitSessionEvent(sessionId, event);
      this.#notificationHub.emitSystemEvent(sysEvent);

      if (session && shouldRecover) {
        session.status = transition(session.status, { kind: "runtime_recovered" });
        session.updatedAt = this.#now();
        this.#threadStore.writeSessionMeta(session.id, session);
        this.#runtimeBlockedSessions.get(runtimeName)?.delete(sessionId);
        this.#notificationHub.emitSessionListChanged();
        this.#onRecovered?.(sessionId);
        recoveredSessions.push(sessionId);
      }
    }
    return recoveredSessions;
  }

  #recordAttachmentRestoreFailure(snapshot: RuntimeAttachmentSnapshot): void {
    const message = `Runtime ${snapshot.runtimeName} could not restore session ${snapshot.sessionId} attachment to tab ${snapshot.tabId}. The previous browser target may no longer exist.`;
    const event: RuntimeEvent = {
      type: "runtime_event",
      seq: this.#nextSeq(),
      timestamp: this.#now(),
      sessionId: snapshot.sessionId,
      runtimeKind: snapshot.runtimeName,
      detail: "failed",
      message,
      payload: {
        kind: "attachment",
        tabId: snapshot.tabId,
        targetInfo: snapshot.targetInfo,
      },
    };
    this.#threadStore.append(snapshot.sessionId, event);

    const sysEvent: SystemEvent = {
      seq: this.#nextSeq(),
      timestamp: this.#now(),
      category: "runtime_lifecycle",
      detail: "failed",
      message,
    };
    this.#systemStreamStore.append(sysEvent);
    this.#notificationHub.emitSessionEvent(snapshot.sessionId, event);
    this.#notificationHub.emitSystemEvent(sysEvent);
  }
}
