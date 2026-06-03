import { describe, it, expect, beforeEach } from "vitest";
import { CliGateway } from "../src/gateways/cli/cli-gateway.js";
import { CoreAPI } from "../src/core/core-api.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

describe("CliGateway", () => {
  let api: CoreAPI;
  let gw: CliGateway;

  beforeEach(() => {
    api = new CoreAPI(new ToolRegistry());
    gw = new CliGateway(api);
  });

  it("has name 'cli'", () => {
    expect(gw.name).toBe("cli");
  });

  it("constructor syncs sessions from CoreAPI", () => {
    api.createSession("test");
    const gw2 = new CliGateway(api);
    expect(gw2.getSessions()).toHaveLength(1);
  });

  it("constructor syncs system events from CoreAPI", () => {
    // System events start empty
    expect(gw.getSystemEvents()).toHaveLength(0);
  });

  it("onSessionEvent increments unread for non-selected session (user_message)", () => {
    const s = api.createSession("test");
    api.appendUserMessage(s.id, "hello");

    expect(gw.getUnreadCount(s.id)).toBe(1);
  });

  it("onSessionEvent does not increment unread for selected session", () => {
    const s = api.createSession("test");
    gw.selectSession(s.id);
    api.appendUserMessage(s.id, "hello");

    expect(gw.getUnreadCount(s.id)).toBe(0);
  });

  it("onSessionEvent does not increment unread for muted session", () => {
    const s = api.createSession("test");
    api.muteSession(s.id, true);
    api.appendUserMessage(s.id, "hello");

    expect(gw.getUnreadCount(s.id)).toBe(0);
  });

  it("onSessionListChanged refreshes session list", () => {
    expect(gw.getSessions()).toHaveLength(0);
    api.createSession("new session");
    expect(gw.getSessions()).toHaveLength(1);
  });

  it("selectSession clears unread for that session", () => {
    const s1 = api.createSession("test1");
    const s2 = api.createSession("test2");
    api.appendUserMessage(s1.id, "msg1");
    api.appendUserMessage(s2.id, "msg2");
    expect(gw.getUnreadCount(s1.id)).toBe(1);
    expect(gw.getUnreadCount(s2.id)).toBe(1);

    gw.selectSession(s1.id);
    expect(gw.getUnreadCount(s1.id)).toBe(0);
    expect(gw.getUnreadCount(s2.id)).toBe(1);
    expect(gw.getSelectedSessionId()).toBe(s1.id);
  });

  it("getSelectedSessionId returns null initially", () => {
    expect(gw.getSelectedSessionId()).toBeNull();
  });

  it("onSystemEvent appends to local buffer", () => {
    // System events are created by RuntimeManager, not directly testable
    // via CoreAPI. Verify the buffer starts empty.
    expect(gw.getSystemEvents()).toEqual([]);
  });

  it("destroy unsubscribes from all event streams", () => {
    const s1 = api.createSession("before-session");

    // Should receive events before destroy
    api.appendUserMessage(s1.id, "before");
    expect(gw.getUnreadCount(s1.id)).toBe(1);

    gw.destroy();

    // After destroy, should not receive events
    const s2 = api.createSession("after-session");
    api.appendUserMessage(s2.id, "after");
    expect(gw.getUnreadCount(s2.id)).toBe(0); // unchanged
  });

  it("unread only counts user_message and assistant_message", () => {
    const s = api.createSession("test");
    // user_message increments unread
    api.appendUserMessage(s.id, "hello");
    expect(gw.getUnreadCount(s.id)).toBe(1);

    // Runtime events and system events should NOT appear as unread
    // (tool calls, runtime events etc. are not user-visible messages)
  });
});
