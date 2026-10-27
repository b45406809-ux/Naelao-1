import { describe, expect, it } from "vitest";
import { validateWidgetHostEvent, widgetSubscriptionAllows } from "./widget-events.js";

const event = { version: 1, id: "event-1", type: "workspace.file.created", spaceId: "space-1", projectId: "project-1", conversationId: "conversation-1", occurredAt: "2026-10-27T00:00:00Z", data: { path: "src/app.ts" } };
describe("extension widget event contract", () => {
  it("validates host events and limits subscription to the granted scope and type", () => {
    const parsed = validateWidgetHostEvent(event);
    expect(widgetSubscriptionAllows(parsed, { spaceId: "space-1", projectId: "project-1", allowedEvents: ["workspace.file.created"] })).toBe(true);
    expect(widgetSubscriptionAllows(parsed, { spaceId: "other", allowedEvents: ["workspace.file.created"] })).toBe(false);
    expect(widgetSubscriptionAllows(parsed, { spaceId: "space-1", projectId: "other", allowedEvents: ["workspace.file.created"] })).toBe(false);
    expect(widgetSubscriptionAllows(parsed, { spaceId: "space-1", allowedEvents: ["worker.completed"] })).toBe(false);
  });
  it("rejects unknown event types, nested data and unauthorized extra fields", () => {
    expect(() => validateWidgetHostEvent({ ...event, type: "arbitrary.event" })).toThrow();
    expect(() => validateWidgetHostEvent({ ...event, data: { nested: { secret: true } } })).toThrow();
    expect(() => validateWidgetHostEvent({ ...event, arbitrary: true })).toThrow();
    expect(() => validateWidgetHostEvent({ ...event, data: { value: "x".repeat(2001) } })).toThrow();
  });
});
