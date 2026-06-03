export type RuntimeStatus =
  | "offline"
  | "starting"
  | "online"
  | "degraded"
  | "recovering"
  | "failed";

export type RuntimeStateEvent =
  | "start"
  | "connected"
  | "disconnect"
  | "healthcheck_failed"
  | "recover_success"
  | "recover_failed";

const transitions: Record<RuntimeStatus, Record<string, RuntimeStatus>> = {
  offline: {
    start: "starting",
  },
  starting: {
    connected: "online",
    recover_failed: "failed",
  },
  online: {
    healthcheck_failed: "degraded",
    disconnect: "offline",
  },
  degraded: {
    healthcheck_failed: "recovering",
    connected: "online",
  },
  recovering: {
    recover_success: "online",
    recover_failed: "failed",
  },
  failed: {
    start: "recovering",
  },
};

export function transitionRuntime(
  current: RuntimeStatus,
  event: RuntimeStateEvent,
): RuntimeStatus {
  const next = transitions[current]?.[event];
  if (next === undefined) {
    throw new Error(
      `Illegal runtime transition: ${current} → ${event}`,
    );
  }
  return next;
}

export function validRuntimeTransitions(
  status: RuntimeStatus,
): ReadonlyArray<string> {
  return Object.keys(transitions[status] ?? {});
}