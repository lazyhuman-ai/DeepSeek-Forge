import type { SessionEvent } from "./types";

export type NativeNotification = {
  title: string;
  body: string;
  tag: string;
};

const MAX_BODY = 180;

export function isNativeNotificationEvent(event: SessionEvent): boolean {
  if (event.type === "assistant_message") return true;
  if (event.type === "permission_request") return true;
  if (event.type === "mcp_elicitation_request") return true;
  if (event.type === "runtime_event") {
    return event.detail.toLowerCase().includes("blocked") ||
      event.message.toLowerCase().startsWith("session blocked");
  }
  return false;
}

export function nativeNotificationForEvent(
  sessionId: string,
  event: SessionEvent,
): NativeNotification | null {
  if (!isNativeNotificationEvent(event)) return null;
  switch (event.type) {
    case "permission_request":
      return {
        title: "ForgeAgent needs approval",
        body: truncate(event.message || `${event.toolName} needs approval.`),
        tag: `forgeagent:${sessionId}:${event.seq}`,
      };
    case "mcp_elicitation_request":
      return {
        title: "ForgeAgent needs input",
        body: truncate(event.message),
        tag: `forgeagent:${sessionId}:${event.seq}`,
      };
    case "assistant_message":
      return {
        title: "ForgeAgent replied",
        body: truncate(stripMarkup(event.text)),
        tag: `forgeagent:${sessionId}:${event.seq}`,
      };
    case "runtime_event":
      return {
        title: "Session blocked",
        body: truncate(event.message),
        tag: `forgeagent:${sessionId}:${event.seq}`,
      };
    default:
      return null;
  }
}

function stripMarkup(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#*_`~>\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_BODY) return clean;
  return `${clean.slice(0, MAX_BODY - 1)}…`;
}
