import { describe, expect, it } from "vitest";
import { buildRenderEvents } from "../web/src/render-events.js";
import type { SessionEvent } from "../web/src/types.js";

const timestamp = "2026-06-02T00:00:00.000Z";

describe("web app render event projection", () => {
  it("merges assistant deltas into one transient streaming message", () => {
    const events: SessionEvent[] = [
      { type: "user_message", seq: 1, timestamp, text: "hello" },
      { type: "assistant_delta", seq: 2, timestamp, text: "Hel" },
      { type: "assistant_delta", seq: 3, timestamp, text: "lo" },
    ];

    const rendered = buildRenderEvents(events);

    expect(rendered).toHaveLength(2);
    expect(rendered[1]).toMatchObject({
      type: "assistant_stream",
      seq: 3,
      text: "Hello",
    });
  });

  it("replaces transient assistant deltas when the durable assistant message arrives", () => {
    const events: SessionEvent[] = [
      { type: "assistant_delta", seq: 10, timestamp, text: "Draft" },
      { type: "assistant_delta", seq: 11, timestamp, text: " text" },
      { type: "assistant_message", seq: 12, timestamp, text: "Final text" },
    ];

    const rendered = buildRenderEvents(events);

    expect(rendered).toEqual([
      { type: "assistant_message", seq: 12, timestamp, text: "Final text" },
    ]);
  });

  it("does not duplicate a stream before the final assistant message", () => {
    const events: SessionEvent[] = [
      { type: "assistant_delta", seq: 1, timestamp, text: "draft" },
      { type: "assistant_message", seq: 2, timestamp, text: "final" },
      { type: "runtime_event", seq: 3, timestamp, runtimeKind: "core", detail: "recovered", message: "ok" },
    ];

    const rendered = buildRenderEvents(events);

    expect(rendered.map((event) => event.type)).toEqual(["assistant_message", "runtime_event"]);
    expect(rendered).not.toContainEqual(expect.objectContaining({ type: "assistant_stream" }));
  });
});
