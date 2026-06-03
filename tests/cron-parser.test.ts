import { describe, it, expect } from "vitest";
import {
  parseCronSchedule,
  validateSchedule,
  parseCronExpression,
} from "../src/core/cron-parser.js";

describe("CronParser — parseCronSchedule", () => {
  it("parses millisecond interval string", () => {
    const before = Date.now();
    const result = parseCronSchedule("60000");
    expect(result).not.toBeNull();
    // Should be roughly 60s from now
    expect(result!.nextFire).toBeGreaterThanOrEqual(before + 59000);
    expect(result!.nextFire).toBeLessThanOrEqual(before + 61000);
  });

  it("parses '5000' as 5 second interval", () => {
    const before = Date.now();
    const result = parseCronSchedule("5000");
    expect(result).not.toBeNull();
    expect(result!.nextFire).toBeGreaterThanOrEqual(before + 4900);
    expect(result!.nextFire).toBeLessThanOrEqual(before + 5100);
  });

  it("parses simple '* * * * *' (every minute)", () => {
    const before = Date.now();
    const result = parseCronSchedule("* * * * *");
    expect(result).not.toBeNull();
    // Next fire should be within the next 60s (at the start of the next minute)
    expect(result!.nextFire).toBeGreaterThan(before);
    expect(result!.nextFire).toBeLessThanOrEqual(before + 60000);
  });

  it("parses '*/5 * * * *' (every 5 minutes)", () => {
    const result = parseCronSchedule("*/5 * * * *");
    expect(result).not.toBeNull();
    // Should land on a multiple of 5 minutes
    const d = new Date(result!.nextFire);
    expect(d.getMinutes() % 5).toBe(0);
    expect(d.getSeconds()).toBe(0);
  });

  it("parses specific time '30 14 * * *' (2:30 PM daily)", () => {
    const result = parseCronSchedule("30 14 * * *");
    expect(result).not.toBeNull();
    const d = new Date(result!.nextFire);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
    // Tomorrow at 14:30 or today at 14:30 if it hasn't passed yet
    const now = new Date();
    if (now.getHours() > 14 || (now.getHours() === 14 && now.getMinutes() >= 30)) {
      // Should be tomorrow
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      expect(d.getDate()).toBe(tomorrow.getDate());
    } else {
      // Should be today
      expect(d.getDate()).toBe(now.getDate());
    }
  });

  it("parses weekday at 9am '0 9 * * 1-5'", () => {
    const result = parseCronSchedule("0 9 * * 1-5");
    expect(result).not.toBeNull();
    const d = new Date(result!.nextFire);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
    expect(d.getDay()).toBeGreaterThanOrEqual(1);
    expect(d.getDay()).toBeLessThanOrEqual(5);
  });

  it("parses with comma-separated hours '0 9,17 * * *'", () => {
    const result = parseCronSchedule("0 9,17 * * *");
    expect(result).not.toBeNull();
    const d = new Date(result!.nextFire);
    expect(d.getMinutes()).toBe(0);
    expect([9, 17]).toContain(d.getHours());
  });

  it("returns null for invalid cron expression", () => {
    expect(parseCronSchedule("not a cron")).toBeNull();
    expect(parseCronSchedule("")).toBeNull();
    expect(parseCronSchedule("* * *")).toBeNull(); // only 3 fields
    expect(parseCronSchedule("60 * * * *")).toBeNull(); // minute > 59
    expect(parseCronSchedule("* 24 * * *")).toBeNull(); // hour > 23
  });

  it("returns null for impossible schedule (no match in 2 years)", () => {
    // Feb 30 never exists
    expect(parseCronSchedule("* * 30 2 *")).toBeNull();
  });
});

describe("CronParser — validateSchedule", () => {
  it("returns null for valid ms interval", () => {
    expect(validateSchedule("60000")).toBeNull();
  });

  it("returns null for valid cron expression", () => {
    expect(validateSchedule("*/5 * * * *")).toBeNull();
    expect(validateSchedule("0 9 * * 1-5")).toBeNull();
  });

  it("returns error for empty schedule", () => {
    expect(validateSchedule("")).not.toBeNull();
    expect(validateSchedule("  ")).not.toBeNull();
  });

  it("returns error for zero or negative ms interval", () => {
    expect(validateSchedule("0")).not.toBeNull();
    expect(validateSchedule("-1000")).not.toBeNull();
  });

  it("returns error for wrong number of fields", () => {
    const err = validateSchedule("* * *");
    expect(err).not.toBeNull();
    expect(err!).toContain("5-field");
  });

  it("returns error for invalid field values", () => {
    const err = validateSchedule("60 * * * *");
    expect(err).not.toBeNull();
    expect(err!).toContain("minute");
  });

  it("returns error for impossible schedule", () => {
    const err = validateSchedule("* * 30 2 *");
    expect(err).not.toBeNull();
  });
});

describe("CronParser — parseCronExpression", () => {
  it("parses wildcard expression", () => {
    const fields = parseCronExpression("* * * * *");
    expect(fields).not.toBeNull();
    expect(fields![0]).toHaveLength(60); // minutes 0-59
    expect(fields![1]).toHaveLength(24); // hours 0-23
    expect(fields![2]).toHaveLength(31); // dom 1-31
    expect(fields![3]).toHaveLength(12); // months 1-12
    expect(fields![4]).toHaveLength(7);  // dow 0-6
  });

  it("parses '*/15 * * * *'", () => {
    const fields = parseCronExpression("*/15 * * * *");
    expect(fields).not.toBeNull();
    expect(fields![0]).toEqual([0, 15, 30, 45]);
  });

  it("parses '0 9 * * 1-5'", () => {
    const fields = parseCronExpression("0 9 * * 1-5");
    expect(fields).not.toBeNull();
    expect(fields![0]).toEqual([0]);
    expect(fields![1]).toEqual([9]);
    expect(fields![4]).toEqual([1, 2, 3, 4, 5]);
  });

  it("parses '0,30 9,17 1,15 * *'", () => {
    const fields = parseCronExpression("0,30 9,17 1,15 * *");
    expect(fields).not.toBeNull();
    expect(fields![0]).toEqual([0, 30]);
    expect(fields![1]).toEqual([9, 17]);
    expect(fields![2]).toEqual([1, 15]);
  });

  it("parses day-of-week names '0 9 * * mon,wed,fri'", () => {
    const fields = parseCronExpression("0 9 * * mon,wed,fri");
    expect(fields).not.toBeNull();
    expect(fields![4]).toEqual([1, 3, 5]);
  });

  it("returns null for invalid expressions", () => {
    expect(parseCronExpression("")).toBeNull();
    expect(parseCronExpression("a b c d e")).toBeNull();
    expect(parseCronExpression("* * * *")).toBeNull();
    expect(parseCronExpression("* * * * * *")).toBeNull();
  });
});
