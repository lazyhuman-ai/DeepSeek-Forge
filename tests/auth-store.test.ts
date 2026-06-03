import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AuthError, AuthStore } from "../src/auth/auth-store.js";

const BASE = ".forge/test-auth-store";

describe("AuthStore", () => {
  beforeEach(() => {
    rmSync(BASE, { recursive: true, force: true });
  });

  it("pairs a device and persists only token/code hashes", () => {
    const store = new AuthStore(join(BASE, "auth"));
    const pairing = store.issuePairingCode();
    const issued = store.pairDevice({
      code: pairing.code,
      name: "Pixel 9",
      kind: "android",
    });

    expect(issued.device.id).toBeDefined();
    expect(issued.device.kind).toBe("android");
    expect(issued.token).toMatch(/^fa_dev_/);
    expect(store.authenticateBearer(issued.token)?.id).toBe(issued.device.id);

    const raw = readFileSync(join(BASE, "auth", "auth.json"), "utf-8");
    expect(raw).not.toContain(issued.token);
    expect(raw).not.toContain(pairing.code);
    expect(raw).toContain("tokenHash");
    expect(raw).toContain("codeHash");
  });

  it("rejects expired, invalid, and reused pairing codes", () => {
    const store = new AuthStore(join(BASE, "auth"));
    const expired = store.issuePairingCode({ ttlMs: -1 });

    expect(() => store.pairDevice({ code: expired.code, name: "Expired" })).toThrow(AuthError);
    expect(() => store.pairDevice({ code: "wrong", name: "Wrong" })).toThrow(AuthError);

    const valid = store.issuePairingCode();
    store.pairDevice({ code: valid.code, name: "First" });
    expect(() => store.pairDevice({ code: valid.code, name: "Second" })).toThrow(AuthError);
  });

  it("revokes devices", () => {
    const store = new AuthStore(join(BASE, "auth"));
    const pairing = store.issuePairingCode();
    const issued = store.pairDevice({ code: pairing.code, name: "Desktop", kind: "desktop" });

    expect(store.authenticateBearer(issued.token)?.id).toBe(issued.device.id);
    const revoked = store.revokeDevice(issued.device.id);
    expect(revoked?.revokedAt).toBeDefined();
    expect(store.authenticateBearer(issued.token)).toBeNull();
  });

  it("stores device state separately per device", () => {
    const store = new AuthStore(join(BASE, "auth"));
    const oneCode = store.issuePairingCode();
    const twoCode = store.issuePairingCode();
    const one = store.pairDevice({ code: oneCode.code, name: "Phone" });
    const two = store.pairDevice({ code: twoCode.code, name: "Tablet" });

    store.patchDeviceState(one.device.id, {
      selectedSessionId: "s1",
      sessionReadSeq: { s1: 42.8 },
      mutedSessionIds: ["s2", "s2"],
      notificationSettings: { enabled: true, lastNotifiedSeq: 99.9 },
    });

    expect(store.getDeviceState(one.device.id)).toMatchObject({
      selectedSessionId: "s1",
      sessionReadSeq: { s1: 42 },
      mutedSessionIds: ["s2"],
      notificationSettings: { enabled: true, lastNotifiedSeq: 99 },
    });
    expect(store.getDeviceState(two.device.id).selectedSessionId).toBeUndefined();
    expect(store.getDeviceState(two.device.id).notificationSettings).toEqual({
      enabled: false,
      lastNotifiedSeq: 0,
    });
    expect(existsSync(join(BASE, "device-state", `${one.device.id}.json`))).toBe(true);
  });

  it("uses one-shot stream tokens", () => {
    const store = new AuthStore(join(BASE, "auth"));
    const pairing = store.issuePairingCode();
    const issued = store.pairDevice({ code: pairing.code, name: "Web", kind: "web" });
    const stream = store.issueStreamToken(issued.device.id);

    expect(store.consumeStreamToken(stream.code)?.id).toBe(issued.device.id);
    expect(store.consumeStreamToken(stream.code)).toBeNull();
  });
});
