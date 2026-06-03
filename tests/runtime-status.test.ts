import { describe, it, expect } from "vitest";
import {
  transitionRuntime,
  validRuntimeTransitions,
  type RuntimeStatus,
  type RuntimeStateEvent,
} from "../src/runtimes/runtime-status.js";

function ev(event: RuntimeStateEvent): RuntimeStateEvent {
  return event;
}

describe("Runtime status state machine", () => {
  describe("offline", () => {
    it("offline → starting (start)", () => {
      expect(transitionRuntime("offline", ev("start"))).toBe("starting");
    });

    it("throws on illegal transition", () => {
      expect(() => transitionRuntime("offline", ev("connected"))).toThrow("Illegal runtime transition");
    });
  });

  describe("starting", () => {
    it("starting → online (connected)", () => {
      expect(transitionRuntime("starting", ev("connected"))).toBe("online");
    });

    it("starting → failed (recover_failed)", () => {
      expect(transitionRuntime("starting", ev("recover_failed"))).toBe("failed");
    });
  });

  describe("online", () => {
    it("online → degraded (healthcheck_failed)", () => {
      expect(transitionRuntime("online", ev("healthcheck_failed"))).toBe("degraded");
    });

    it("online → offline (disconnect)", () => {
      expect(transitionRuntime("online", ev("disconnect"))).toBe("offline");
    });

    it("throws on illegal transition from online", () => {
      expect(() => transitionRuntime("online", ev("recover_failed"))).toThrow("Illegal runtime transition");
    });
  });

  describe("degraded", () => {
    it("degraded → recovering (healthcheck_failed)", () => {
      expect(transitionRuntime("degraded", ev("healthcheck_failed"))).toBe("recovering");
    });

    it("degraded → online (connected)", () => {
      expect(transitionRuntime("degraded", ev("connected"))).toBe("online");
    });
  });

  describe("recovering", () => {
    it("recovering → online (recover_success)", () => {
      expect(transitionRuntime("recovering", ev("recover_success"))).toBe("online");
    });

    it("recovering → failed (recover_failed)", () => {
      expect(transitionRuntime("recovering", ev("recover_failed"))).toBe("failed");
    });
  });

  describe("failed", () => {
    it("failed → recovering (start)", () => {
      expect(transitionRuntime("failed", ev("start"))).toBe("recovering");
    });

    it("throws on illegal transition from failed", () => {
      expect(() => transitionRuntime("failed", ev("connected"))).toThrow("Illegal runtime transition");
    });
  });

  describe("validRuntimeTransitions", () => {
    it("returns available transitions for a status", () => {
      const t = validRuntimeTransitions("online");
      expect(t).toContain("healthcheck_failed");
      expect(t).toContain("disconnect");
    });

    it("returns empty for failed — only start is available", () => {
      const t = validRuntimeTransitions("failed");
      expect(t).toEqual(["start"]);
    });
  });

  describe("full lifecycle", () => {
    it("offline → starting → online → degraded → recovering → online", () => {
      let s: RuntimeStatus = "offline";
      s = transitionRuntime(s, ev("start"));
      expect(s).toBe("starting");
      s = transitionRuntime(s, ev("connected"));
      expect(s).toBe("online");
      s = transitionRuntime(s, ev("healthcheck_failed"));
      expect(s).toBe("degraded");
      s = transitionRuntime(s, ev("healthcheck_failed"));
      expect(s).toBe("recovering");
      s = transitionRuntime(s, ev("recover_success"));
      expect(s).toBe("online");
    });

    it("offline → starting → failed → recovering → failed", () => {
      let s: RuntimeStatus = "offline";
      s = transitionRuntime(s, ev("start"));
      expect(s).toBe("starting");
      s = transitionRuntime(s, ev("recover_failed"));
      expect(s).toBe("failed");
      s = transitionRuntime(s, ev("start"));
      expect(s).toBe("recovering");
      s = transitionRuntime(s, ev("recover_failed"));
      expect(s).toBe("failed");
    });
  });
});