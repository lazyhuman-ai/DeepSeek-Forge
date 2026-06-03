import { describe, it, expect, vi } from "vitest";
import { NotificationHub } from "../src/core/notification-hub.js";
import type { SessionEvent, SystemEvent } from "../src/streams/event-types.js";

function makeSessionEvent(seq: number): SessionEvent {
  return {
    type: "user_message",
    seq,
    timestamp: new Date().toISOString(),
    sessionId: "s1",
    text: "hello",
  };
}

function makeSystemEvent(seq: number): SystemEvent {
  return {
    seq,
    timestamp: new Date().toISOString(),
    category: "runtime_lifecycle",
    detail: "degraded",
    message: "Runtime chrome: degraded",
  };
}

describe("NotificationHub", () => {
  it("onSessionEvent receives emitted events", () => {
    const hub = new NotificationHub();
    const received: Array<{ sid: string; evt: SessionEvent }> = [];

    hub.onSessionEvent((sid, evt) => received.push({ sid, evt }));
    const event = makeSessionEvent(1);
    hub.emitSessionEvent("s1", event);

    expect(received).toHaveLength(1);
    expect(received[0]!.sid).toBe("s1");
    expect(received[0]!.evt).toBe(event);
  });

  it("onSystemEvent receives emitted events", () => {
    const hub = new NotificationHub();
    const received: SystemEvent[] = [];

    hub.onSystemEvent((evt) => received.push(evt));
    const event = makeSystemEvent(1);
    hub.emitSystemEvent(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
  });

  it("onSessionListChanged fires on emit", () => {
    const hub = new NotificationHub();
    let count = 0;

    hub.onSessionListChanged(() => count++);
    hub.emitSessionListChanged();
    hub.emitSessionListChanged();

    expect(count).toBe(2);
  });

  it("unsubscribe stops receiving events", () => {
    const hub = new NotificationHub();
    const received: SessionEvent[] = [];

    const unsub = hub.onSessionEvent((_sid, evt) => received.push(evt));
    hub.emitSessionEvent("s1", makeSessionEvent(1));
    expect(received).toHaveLength(1);

    unsub();
    hub.emitSessionEvent("s1", makeSessionEvent(2));
    expect(received).toHaveLength(1);
  });

  it("multiple subscribers all receive events", () => {
    const hub = new NotificationHub();
    let a = 0;
    let b = 0;

    hub.onSessionListChanged(() => a++);
    hub.onSessionListChanged(() => b++);
    hub.emitSessionListChanged();

    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it("callback error does not crash other subscribers", () => {
    const hub = new NotificationHub();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let secondCalled = false;
    hub.onSessionEvent(() => {
      throw new Error("boom");
    });
    hub.onSessionEvent(() => {
      secondCalled = true;
    });

    hub.emitSessionEvent("s1", makeSessionEvent(1));

    expect(secondCalled).toBe(true);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("events from different sessions are routed with correct sessionId", () => {
    const hub = new NotificationHub();
    const sessions: string[] = [];

    hub.onSessionEvent((sid) => sessions.push(sid));
    hub.emitSessionEvent("session-a", makeSessionEvent(1));
    hub.emitSessionEvent("session-b", makeSessionEvent(2));

    expect(sessions).toEqual(["session-a", "session-b"]);
  });
});
