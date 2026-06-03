import type { Session, SessionEvent } from "./types";

export type SessionIndicator = "none" | "spinner" | "unread" | "waiting" | "sleeping" | "blocked";

export function isAgentResultEvent(session: Pick<Session, "status">, event: SessionEvent): boolean {
  if (event.type === "assistant_message" || event.type === "permission_request") return true;
  return session.status === "blocked" && event.type === "runtime_event";
}

export function latestAgentResultSeq(
  session: Pick<Session, "status">,
  events: SessionEvent[],
): number {
  return events.reduce((max, event) => (
    isAgentResultEvent(session, event) ? Math.max(max, event.seq) : max
  ), 0);
}

export function sessionIndicator(session: Pick<Session, "status" | "unread"> | null): SessionIndicator {
  if (!session) return "none";
  if (session.status === "running") return "spinner";
  if (session.unread) return "unread";
  if (session.status === "blocked") return "blocked";
  if (session.status === "waiting_user") return "waiting";
  if (session.status === "sleeping") return "sleeping";
  return "none";
}
