import type { SessionEvent } from "./types";

export type RenderEvent = SessionEvent | {
  type: "assistant_stream";
  seq: number;
  timestamp: string;
  text: string;
};

export function buildRenderEvents(events: SessionEvent[]): RenderEvent[] {
  const rendered: RenderEvent[] = [];
  let stream: Extract<RenderEvent, { type: "assistant_stream" }> | null = null;

  for (const event of events) {
    if (event.type === "assistant_delta") {
      if (!stream) {
        stream = {
          type: "assistant_stream",
          seq: event.seq,
          timestamp: event.timestamp,
          text: event.text,
        };
      } else {
        stream = {
          seq: event.seq,
          type: "assistant_stream",
          timestamp: event.timestamp,
          text: stream.text + event.text,
        };
      }
      continue;
    }

    if (event.type === "assistant_message") {
      stream = null;
      rendered.push(event);
      continue;
    }

    if (stream) {
      rendered.push(stream);
      stream = null;
    }
    rendered.push(event);
  }

  if (stream) rendered.push(stream);
  return rendered;
}
