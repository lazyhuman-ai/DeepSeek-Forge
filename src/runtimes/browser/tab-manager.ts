export type TargetInfo = {
  targetId: string;
  cdpSessionId: string;
};

export type TabEntry = {
  tabId: string;
  targetInfo: TargetInfo | null;
};

export type TabAttachmentChange = {
  kind: "attached" | "detached" | "reattached";
  sessionId: string;
  tabId: string;
  targetInfo: TargetInfo | null;
  previousTabId?: string;
  previousTargetInfo?: TargetInfo | null;
};

type AttachmentListener = (change: TabAttachmentChange) => void;

export class TabManager {
  #tabs = new Map<string, TabEntry>();
  #listeners = new Set<AttachmentListener>();

  attach(
    sessionId: string,
    tabId: string,
    targetInfo?: TargetInfo,
  ): void {
    const previous = this.#tabs.get(sessionId);
    const entry = { tabId, targetInfo: targetInfo ?? null };
    this.#tabs.set(sessionId, entry);

    const change: TabAttachmentChange = {
      kind: previous ? "reattached" : "attached",
      sessionId,
      tabId,
      targetInfo: entry.targetInfo,
    };
    if (previous) {
      change.previousTabId = previous.tabId;
      change.previousTargetInfo = previous.targetInfo;
    }
    this.#emit(change);
  }

  restore(sessionId: string, entry: TabEntry): void {
    this.#tabs.set(sessionId, {
      tabId: entry.tabId,
      targetInfo: entry.targetInfo,
    });
  }

  forget(sessionId: string): void {
    this.#tabs.delete(sessionId);
  }

  detach(sessionId: string): void {
    const previous = this.#tabs.get(sessionId);
    if (!previous) return;
    this.#tabs.delete(sessionId);
    this.#emit({
      kind: "detached",
      sessionId,
      tabId: previous.tabId,
      targetInfo: previous.targetInfo,
    });
  }

  getTab(sessionId: string): string | undefined {
    return this.#tabs.get(sessionId)?.tabId;
  }

  getTargetInfo(sessionId: string): TargetInfo | null {
    return this.#tabs.get(sessionId)?.targetInfo ?? null;
  }

  getSessions(): string[] {
    return [...this.#tabs.keys()];
  }

  list(): ReadonlyMap<string, string> {
    const result = new Map<string, string>();
    for (const [sessionId, entry] of this.#tabs) {
      result.set(sessionId, entry.tabId);
    }
    return result;
  }

  listEntries(): ReadonlyMap<string, TabEntry> {
    return new Map(this.#tabs);
  }

  closeAll(): void {
    for (const sessionId of [...this.#tabs.keys()]) {
      this.detach(sessionId);
    }
  }

  onAttachmentChange(cb: AttachmentListener): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  #emit(change: TabAttachmentChange): void {
    for (const listener of this.#listeners) {
      listener(change);
    }
  }
}
