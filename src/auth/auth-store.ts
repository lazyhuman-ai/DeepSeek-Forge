import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";

export type DeviceKind = "android" | "desktop" | "web" | "cli" | "unknown";
export type DeviceScope = "gateway:all";

export type Device = {
  id: string;
  name: string;
  kind: DeviceKind;
  tokenHash: string;
  scopes: DeviceScope[];
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
};

export type PublicDevice = Omit<Device, "tokenHash">;

export type PairingCode = {
  id: string;
  codeHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  createdByDeviceId?: string;
};

export type DeviceState = {
  deviceId: string;
  selectedProjectId?: string;
  selectedSessionId?: string;
  selectedBranchBySession?: Record<string, string>;
  sessionReadSeq: Record<string, number>;
  mutedSessionIds: string[];
  notificationSettings: {
    enabled: boolean;
    lastNotifiedSeq: number;
  };
  updatedAt: string;
};

export type PairingCodeIssue = {
  id: string;
  code: string;
  expiresAt: string;
};

export type DeviceIssue = {
  device: PublicDevice;
  token: string;
};

export type AuthenticatedRequestContext = {
  device: PublicDevice;
  authMethod: "bearer" | "stream_token" | "disabled";
};

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

type AuthStateFile = {
  devices: Device[];
  pairingCodes: PairingCode[];
  streamTokens: PairingCode[];
};

const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
const DEFAULT_STREAM_TTL_MS = 60 * 1000;
const DEFAULT_SCOPES: DeviceScope[] = ["gateway:all"];

function now(): string {
  return new Date().toISOString();
}

function atomicWrite(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, filePath);
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function pairingCode(): string {
  return randomBytes(8).toString("hex");
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalHash(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function publicDevice(device: Device): PublicDevice {
  const { tokenHash: _tokenHash, ...rest } = device;
  return rest;
}

function normalizeDeviceKind(kind: unknown): DeviceKind {
  if (kind === "android" || kind === "desktop" || kind === "web" || kind === "cli") {
    return kind;
  }
  return "unknown";
}

function normalizeState(deviceId: string, state?: Partial<DeviceState>): DeviceState {
  const next: DeviceState = {
    deviceId,
    sessionReadSeq: {},
    mutedSessionIds: [],
    notificationSettings: {
      enabled: false,
      lastNotifiedSeq: 0,
    },
    updatedAt: now(),
  };
  if (typeof state?.selectedSessionId === "string" && state.selectedSessionId.length > 0) {
    next.selectedSessionId = state.selectedSessionId;
  }
  if (typeof state?.selectedProjectId === "string" && state.selectedProjectId.length > 0) {
    next.selectedProjectId = state.selectedProjectId;
  }
  if (state?.sessionReadSeq && typeof state.sessionReadSeq === "object") {
    for (const [sid, seq] of Object.entries(state.sessionReadSeq)) {
      if (typeof sid === "string" && typeof seq === "number" && Number.isFinite(seq) && seq >= 0) {
        next.sessionReadSeq[sid] = Math.floor(seq);
      }
    }
  }
  if (state?.selectedBranchBySession && typeof state.selectedBranchBySession === "object") {
    const selectedBranchBySession: Record<string, string> = {};
    for (const [sid, branchId] of Object.entries(state.selectedBranchBySession)) {
      if (
        typeof sid === "string" &&
        sid.length > 0 &&
        typeof branchId === "string" &&
        branchId.length > 0
      ) {
        selectedBranchBySession[sid] = branchId;
      }
    }
    if (Object.keys(selectedBranchBySession).length > 0) {
      next.selectedBranchBySession = selectedBranchBySession;
    }
  }
  if (Array.isArray(state?.mutedSessionIds)) {
    next.mutedSessionIds = [...new Set(
      state.mutedSessionIds.filter((sid): sid is string => typeof sid === "string" && sid.length > 0),
    )];
  }
  if (state?.notificationSettings && typeof state.notificationSettings === "object") {
    const settings = state.notificationSettings;
    next.notificationSettings = {
      enabled: settings.enabled === true,
      lastNotifiedSeq: typeof settings.lastNotifiedSeq === "number" &&
        Number.isFinite(settings.lastNotifiedSeq) &&
        settings.lastNotifiedSeq >= 0
        ? Math.floor(settings.lastNotifiedSeq)
        : 0,
    };
  }
  return next;
}

export class AuthStore {
  #baseDir: string;
  #authPath: string;
  #deviceStateDir: string;

  constructor(baseDir = ".forge/auth", options?: { deviceStateDir?: string }) {
    this.#baseDir = baseDir;
    this.#authPath = join(baseDir, "auth.json");
    this.#deviceStateDir = options?.deviceStateDir ?? join(dirname(baseDir), "device-state");
  }

  get baseDir(): string {
    return this.#baseDir;
  }

  issuePairingCode(options?: {
    ttlMs?: number;
    createdByDeviceId?: string;
  }): PairingCodeIssue {
    const state = this.#loadAuthState();
    const code = pairingCode();
    const createdAt = now();
    const expiresAt = new Date(Date.now() + (options?.ttlMs ?? DEFAULT_PAIRING_TTL_MS)).toISOString();
    const entry: PairingCode = {
      id: randomUUID(),
      codeHash: hashSecret(code),
      createdAt,
      expiresAt,
      ...(options?.createdByDeviceId ? { createdByDeviceId: options.createdByDeviceId } : {}),
    };
    state.pairingCodes.push(entry);
    this.#cleanupExpired(state);
    this.#saveAuthState(state);
    return { id: entry.id, code, expiresAt };
  }

  pairDevice(input: {
    code: string;
    name: string;
    kind?: DeviceKind;
  }): DeviceIssue {
    const state = this.#loadAuthState();
    this.#cleanupExpired(state);

    const codeHash = hashSecret(input.code);
    const pairing = state.pairingCodes.find((entry) => (
      !entry.usedAt &&
      new Date(entry.expiresAt).getTime() > Date.now() &&
      equalHash(entry.codeHash, codeHash)
    ));
    if (!pairing) {
      this.#saveAuthState(state);
      throw new AuthError("Invalid or expired pairing code.");
    }

    const rawToken = `fa_dev_${token(32)}`;
    const device: Device = {
      id: randomUUID(),
      name: input.name.trim() || "Unnamed device",
      kind: normalizeDeviceKind(input.kind),
      tokenHash: hashSecret(rawToken),
      scopes: [...DEFAULT_SCOPES],
      createdAt: now(),
    };
    pairing.usedAt = now();
    state.devices.push(device);
    this.#saveAuthState(state);
    this.#saveDeviceState(normalizeState(device.id));
    return { device: publicDevice(device), token: rawToken };
  }

  authenticateBearer(rawToken: string): PublicDevice | null {
    const state = this.#loadAuthState();
    const tokenHash = hashSecret(rawToken);
    const device = state.devices.find((entry) => (
      !entry.revokedAt && equalHash(entry.tokenHash, tokenHash)
    ));
    if (!device) return null;
    device.lastSeenAt = now();
    this.#saveAuthState(state);
    return publicDevice(device);
  }

  listDevices(): PublicDevice[] {
    return this.#loadAuthState().devices.map(publicDevice);
  }

  revokeDevice(deviceId: string): PublicDevice | null {
    const state = this.#loadAuthState();
    const device = state.devices.find((entry) => entry.id === deviceId);
    if (!device) return null;
    if (!device.revokedAt) {
      device.revokedAt = now();
      this.#saveAuthState(state);
    }
    return publicDevice(device);
  }

  issueStreamToken(deviceId: string, ttlMs = DEFAULT_STREAM_TTL_MS): PairingCodeIssue {
    const state = this.#loadAuthState();
    const device = state.devices.find((entry) => entry.id === deviceId && !entry.revokedAt);
    if (!device) throw new AuthError("Device is not active.");
    const code = token(24);
    const createdAt = now();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const entry: PairingCode = {
      id: randomUUID(),
      codeHash: hashSecret(code),
      createdAt,
      expiresAt,
      createdByDeviceId: deviceId,
    };
    state.streamTokens.push(entry);
    this.#cleanupExpired(state);
    this.#saveAuthState(state);
    return { id: entry.id, code, expiresAt };
  }

  consumeStreamToken(rawToken: string): PublicDevice | null {
    const state = this.#loadAuthState();
    this.#cleanupExpired(state);
    const tokenHash = hashSecret(rawToken);
    const entry = state.streamTokens.find((candidate) => (
      !candidate.usedAt &&
      new Date(candidate.expiresAt).getTime() > Date.now() &&
      equalHash(candidate.codeHash, tokenHash)
    ));
    if (!entry?.createdByDeviceId) {
      this.#saveAuthState(state);
      return null;
    }
    const device = state.devices.find((candidate) => (
      candidate.id === entry.createdByDeviceId && !candidate.revokedAt
    ));
    if (!device) {
      this.#saveAuthState(state);
      return null;
    }
    entry.usedAt = now();
    device.lastSeenAt = now();
    this.#saveAuthState(state);
    return publicDevice(device);
  }

  getDeviceState(deviceId: string): DeviceState {
    const filePath = this.#deviceStatePath(deviceId);
    return normalizeState(deviceId, readJson<Partial<DeviceState>>(filePath, { deviceId }));
  }

  patchDeviceState(deviceId: string, patch: Partial<DeviceState>): DeviceState {
    const current = this.getDeviceState(deviceId);
    const next: Partial<DeviceState> = {
      ...current,
      ...patch,
      deviceId,
      sessionReadSeq: patch.sessionReadSeq ?? current.sessionReadSeq,
      mutedSessionIds: patch.mutedSessionIds ?? current.mutedSessionIds,
      notificationSettings: patch.notificationSettings ?? current.notificationSettings,
    };
    const selectedBranchBySession = patch.selectedBranchBySession ?? current.selectedBranchBySession;
    if (selectedBranchBySession !== undefined) {
      next.selectedBranchBySession = selectedBranchBySession;
    }
    const normalized = normalizeState(deviceId, next);
    normalized.updatedAt = now();
    this.#saveDeviceState(normalized);
    return normalized;
  }

  status(): { pairedDevices: number; activeDevices: number; pendingPairingCodes: number } {
    const state = this.#loadAuthState();
    this.#cleanupExpired(state);
    this.#saveAuthState(state);
    return {
      pairedDevices: state.devices.length,
      activeDevices: state.devices.filter((device) => !device.revokedAt).length,
      pendingPairingCodes: state.pairingCodes.filter((code) => !code.usedAt).length,
    };
  }

  #loadAuthState(): AuthStateFile {
    const raw = readJson<Partial<AuthStateFile>>(this.#authPath, {});
    return {
      devices: Array.isArray(raw.devices) ? raw.devices : [],
      pairingCodes: Array.isArray(raw.pairingCodes) ? raw.pairingCodes : [],
      streamTokens: Array.isArray(raw.streamTokens) ? raw.streamTokens : [],
    };
  }

  #saveAuthState(state: AuthStateFile): void {
    atomicWrite(this.#authPath, JSON.stringify(state, null, 2));
  }

  #cleanupExpired(state: AuthStateFile): void {
    const nowMs = Date.now();
    state.pairingCodes = state.pairingCodes.filter((entry) => (
      !entry.usedAt && new Date(entry.expiresAt).getTime() > nowMs
    ));
    state.streamTokens = state.streamTokens.filter((entry) => (
      !entry.usedAt && new Date(entry.expiresAt).getTime() > nowMs
    ));
  }

  #deviceStatePath(deviceId: string): string {
    const safe = deviceId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.#deviceStateDir, `${safe}.json`);
  }

  #saveDeviceState(state: DeviceState): void {
    atomicWrite(this.#deviceStatePath(state.deviceId), JSON.stringify(state, null, 2));
  }

  clearDeviceState(deviceId: string): void {
    const filePath = this.#deviceStatePath(deviceId);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }
}
