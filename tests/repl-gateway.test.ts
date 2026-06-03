import { describe, expect, it } from "vitest";
import { parseScheduleCommandArg } from "../src/gateways/repl/repl-gateway.js";

describe("ReplGateway helpers", () => {
  it("parses millisecond interval schedules", () => {
    expect(parseScheduleCommandArg("60000 check status")).toEqual({
      schedule: "60000",
      prompt: "check status",
    });
  });

  it("parses 5-field cron schedules", () => {
    expect(parseScheduleCommandArg("0 9 * * 1-5 weekday morning task")).toEqual({
      schedule: "0 9 * * 1-5",
      prompt: "weekday morning task",
    });
  });

  it("rejects incomplete schedule commands", () => {
    expect(parseScheduleCommandArg("0 9 * *")).toBeNull();
  });
});
