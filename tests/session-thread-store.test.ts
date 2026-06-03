import { describe, it, expect } from "vitest";
import { SessionThreadStore } from "../src/streams/session-thread-store.js";
import type { UserMessage, AssistantMessage } from "../src/streams/event-types.js";

function makeMsg(sessionId: string, seq: number, text: string): UserMessage {
  return {
    type: "user_message",
    seq,
    timestamp: new Date().toISOString(),
    sessionId,
    text,
  };
}

function makeAssistant(sessionId: string, seq: number, text: string): AssistantMessage {
  return {
    type: "assistant_message",
    seq,
    timestamp: new Date().toISOString(),
    sessionId,
    text,
  };
}

describe("SessionThreadStore", () => {
  it("appends events to a new session", () => {
    const store = new SessionThreadStore();
    store.append("s1", makeMsg("s1", 1, "hello"));
    expect(store.getThread("s1")).toHaveLength(1);
  });

  it("appends events in order", () => {
    const store = new SessionThreadStore();
    store.append("s1", makeMsg("s1", 1, "first"));
    store.append("s1", makeAssistant("s1", 2, "second"));
    store.append("s1", makeMsg("s1", 3, "third"));

    const thread = store.getThread("s1");
    expect(thread).toHaveLength(3);
    expect(thread[0]!.seq).toBe(1);
    expect(thread[1]!.seq).toBe(2);
    expect(thread[2]!.seq).toBe(3);
  });

  it("isolates events per session", () => {
    const store = new SessionThreadStore();
    store.append("s1", makeMsg("s1", 1, "a"));
    store.append("s2", makeMsg("s2", 1, "b"));

    expect(store.getThread("s1")).toHaveLength(1);
    expect(store.getThread("s2")).toHaveLength(1);
    const s1Thread = store.getThread("s1");
    const s2Thread = store.getThread("s2");
    expect(s1Thread[0]!.type).toBe("user_message");
    expect(s2Thread[0]!.type).toBe("user_message");
    if (s1Thread[0]!.type === "user_message") expect(s1Thread[0]!.text).toBe("a");
    if (s2Thread[0]!.type === "user_message") expect(s2Thread[0]!.text).toBe("b");
  });

  it("returns empty array for unknown session", () => {
    const store = new SessionThreadStore();
    expect(store.getThread("nope")).toEqual([]);
  });

  it("replay returns same as getThread", () => {
    const store = new SessionThreadStore();
    store.append("s1", makeMsg("s1", 1, "x"));
    expect(store.replay("s1")).toEqual(store.getThread("s1"));
  });

  it("hasSession returns correct boolean", () => {
    const store = new SessionThreadStore();
    expect(store.hasSession("s1")).toBe(false);
    store.append("s1", makeMsg("s1", 1, "hi"));
    expect(store.hasSession("s1")).toBe(true);
  });

  it("thread is never mutated — append only", () => {
    const store = new SessionThreadStore();
    store.append("s1", makeMsg("s1", 1, "original"));

    const thread1 = store.getThread("s1");
    store.append("s1", makeMsg("s1", 2, "extra"));

    // Original reference should still only have 1 entry
    expect(thread1).toHaveLength(1);
  });
});
