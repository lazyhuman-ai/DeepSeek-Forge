import { describe, it, expect } from "vitest";
import { transition, validTransitions } from "../src/core/session-supervisor.js";
import type { SupervisorEvent } from "../src/streams/event-types.js";

function ev(kind: SupervisorEvent["kind"]): SupervisorEvent {
  return { kind } as SupervisorEvent;
}

describe("Session Supervisor — state machine", () => {
  describe("idle", () => {
    it("idle → running (user_message)", () => {
      expect(transition("idle", ev("user_message"))).toBe("running");
    });
    it("idle → running (trigger_fired)", () => {
      expect(transition("idle", ev("trigger_fired"))).toBe("running");
    });
    it("idle → sleeping (trigger_scheduled)", () => {
      expect(transition("idle", ev("trigger_scheduled"))).toBe("sleeping");
    });
    it("idle → idle (user_interrupt is no-op)", () => {
      expect(transition("idle", ev("user_interrupt"))).toBe("idle");
    });
    it("idle → archived (user_archive)", () => {
      expect(transition("idle", ev("user_archive"))).toBe("archived");
    });
    it("throws on illegal transition from idle", () => {
      expect(() => transition("idle", ev("turn_finished"))).toThrow("Illegal transition");
    });
  });

  describe("running", () => {
    it("running → idle (turn_finished)", () => {
      expect(transition("running", ev("turn_finished"))).toBe("idle");
    });
    it("running → waiting_user (agent_ask_user)", () => {
      expect(transition("running", ev("agent_ask_user"))).toBe("waiting_user");
    });
    it("running → sleeping (agent_schedule_sleep)", () => {
      expect(transition("running", ev("agent_schedule_sleep"))).toBe("sleeping");
    });
    it("running → blocked (runtime_failure)", () => {
      expect(transition("running", ev("runtime_failure"))).toBe("blocked");
    });
    it("running → idle (user_interrupt)", () => {
      expect(transition("running", ev("user_interrupt"))).toBe("idle");
    });
    it("throws on illegal transition from running (e.g., user_archive)", () => {
      expect(() => transition("running", ev("user_archive"))).toThrow("Illegal transition");
    });
  });

  describe("waiting_user", () => {
    it("waiting_user → running (user_reply)", () => {
      expect(transition("waiting_user", ev("user_reply"))).toBe("running");
    });
    it("waiting_user → idle (user_interrupt)", () => {
      expect(transition("waiting_user", ev("user_interrupt"))).toBe("idle");
    });
    it("waiting_user → archived (user_archive)", () => {
      expect(transition("waiting_user", ev("user_archive"))).toBe("archived");
    });
  });

  describe("sleeping", () => {
    it("sleeping → running (trigger_fired)", () => {
      expect(transition("sleeping", ev("trigger_fired"))).toBe("running");
    });
    it("sleeping → running (user_message — wake up early)", () => {
      expect(transition("sleeping", ev("user_message"))).toBe("running");
    });
    it("sleeping → idle (triggers_empty)", () => {
      expect(transition("sleeping", ev("triggers_empty"))).toBe("idle");
    });
    it("sleeping → idle (user_interrupt)", () => {
      expect(transition("sleeping", ev("user_interrupt"))).toBe("idle");
    });
    it("sleeping → archived (user_archive)", () => {
      expect(transition("sleeping", ev("user_archive"))).toBe("archived");
    });
  });

  describe("blocked", () => {
    it("blocked → running (runtime_recovered)", () => {
      expect(transition("blocked", ev("runtime_recovered"))).toBe("running");
    });
    it("blocked → running (user_retry)", () => {
      expect(transition("blocked", ev("user_retry"))).toBe("running");
    });
    it("blocked → idle (user_interrupt)", () => {
      expect(transition("blocked", ev("user_interrupt"))).toBe("idle");
    });
    it("blocked → archived (user_archive)", () => {
      expect(transition("blocked", ev("user_archive"))).toBe("archived");
    });
  });

  describe("archived", () => {
    it("archived accepts no transitions", () => {
      expect(validTransitions("archived")).toEqual([]);
      expect(() => transition("archived", ev("user_interrupt"))).toThrow();
    });
  });

  describe("validTransitions", () => {
    it("returns available transitions for a status", () => {
      const idleTrans = validTransitions("idle");
      expect(idleTrans).toContain("user_message");
      expect(idleTrans).toContain("trigger_fired");
      expect(idleTrans).toContain("trigger_scheduled");
      expect(idleTrans).toContain("user_interrupt");
      expect(idleTrans).toContain("user_archive");

      const sleepingTrans = validTransitions("sleeping");
      expect(sleepingTrans).toContain("triggers_empty");

      const blockedTrans = validTransitions("blocked");
      expect(blockedTrans).toContain("runtime_recovered");
      expect(blockedTrans).toContain("user_retry");
      expect(blockedTrans).toContain("user_interrupt");
      expect(blockedTrans).toContain("user_archive");
    });
  });
});
