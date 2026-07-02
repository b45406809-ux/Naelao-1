// Unit tests for @naelao/analytics-schema (G-AE01..AE05)
import { describe, it, expect } from "vitest";
import {
  buildAeDataPoint,
  sessionStartedEvent,
  messageEvent,
  agentRunEvent,
} from "../../../packages/analytics-schema/src/index.js";

describe("AE slot layout (G-AE01)", () => {
  it("buildAeDataPoint returns exactly 20 blobs, 20 doubles, 1 index", () => {
    const event = sessionStartedEvent({
      tenant_id: "t1",
      space_id: "sp1",
      session_id: "ses1",
      environment: "staging",
      service: "spaces",
    });
    const slots = buildAeDataPoint(event);
    expect(slots.blobs).toHaveLength(20);
    expect(slots.doubles).toHaveLength(20);
    expect(slots.indexes).toHaveLength(1);
  });

  it("index[0] is always tenant_id for fast tenant scoping", () => {
    const event = sessionStartedEvent({
      tenant_id: "tenant-abc",
      space_id: "sp1",
      session_id: "ses1",
      environment: "production",
      service: "spaces",
    });
    const slots = buildAeDataPoint(event);
    expect(slots.indexes[0]).toBe("tenant-abc");
  });

  it("b1 = event_type, b2 = tenant_id, b3 = space_id, b4 = session_id", () => {
    const event = sessionStartedEvent({
      tenant_id: "t-xyz",
      space_id: "sp-xyz",
      session_id: "ses-xyz",
      environment: "production",
      service: "spaces",
    });
    const slots = buildAeDataPoint(event);
    expect(slots.blobs[0]).toBe("session.started");
    expect(slots.blobs[1]).toBe("t-xyz");
    expect(slots.blobs[2]).toBe("sp-xyz");
    expect(slots.blobs[3]).toBe("ses-xyz");
  });

  it("missing optional fields default to empty string / zero", () => {
    const event = sessionStartedEvent({
      tenant_id: "t1",
      space_id: "sp1",
      session_id: "ses1",
      environment: "staging",
      service: "spaces",
    });
    const slots = buildAeDataPoint(event);
    expect(slots.blobs[4]).toBe(""); // user_id empty
    expect(slots.blobs[7]).toBe(""); // trace_id empty
    expect(slots.blobs[8]).toBe(""); // error_code empty
    expect(slots.doubles[0]).toBe(0); // duration_ms
    expect(slots.doubles[1]).toBe(0); // token_count
  });
});

describe("sessionStartedEvent constructor (G-AE02)", () => {
  it("creates session.started event", () => {
    const event = sessionStartedEvent({
      tenant_id: "t1",
      space_id: "sp1",
      session_id: "ses1",
      environment: "production",
      service: "spaces",
    });
    expect(event.event_type).toBe("session.started");
    expect(event.tenant_id).toBe("t1");
  });

  it("includes optional user_id and trace_id when provided", () => {
    const event = sessionStartedEvent({
      tenant_id: "t1",
      space_id: "sp1",
      session_id: "ses1",
      user_id: "user-123",
      trace_id: "trace-abc",
      environment: "production",
      service: "spaces",
    });
    expect(event.user_id).toBe("user-123");
    expect(event.trace_id).toBe("trace-abc");
  });
});

describe("messageEvent constructor (G-AE03)", () => {
  it("maps 'sent' direction to message.sent event_type", () => {
    const event = messageEvent({
      tenant_id: "t1",
      space_id: "sp1",
      session_id: "ses1",
      direction: "sent",
      environment: "production",
      service: "spaces",
    });
    expect(event.event_type).toBe("message.sent");
  });

  it("maps 'received' direction to message.received event_type", () => {
    const event = messageEvent({
      tenant_id: "t1",
      space_id: "sp1",
      session_id: "ses1",
      direction: "received",
      token_count: 500,
      cost_usd_micro: 150,
      environment: "production",
      service: "spaces",
    });
    expect(event.event_type).toBe("message.received");
    expect(event.token_count).toBe(500);
    expect(event.cost_usd_micro).toBe(150);
  });
});

describe("agentRunEvent constructor (G-AE04)", () => {
  it("maps status=started to agent.run.started", () => {
    const event = agentRunEvent({
      tenant_id: "t1",
      space_id: "sp1",
      session_id: "ses1",
      run_id: "run-1",
      status: "started",
      environment: "production",
      service: "agents",
    });
    expect(event.event_type).toBe("agent.run.started");
  });

  it("maps status=completed to agent.run.completed with duration", () => {
    const event = agentRunEvent({
      tenant_id: "t1",
      space_id: "sp1",
      session_id: "ses1",
      run_id: "run-1",
      status: "completed",
      duration_ms: 1234,
      token_count: 800,
      cost_usd_micro: 240,
      environment: "production",
      service: "agents",
    });
    expect(event.event_type).toBe("agent.run.completed");
    expect(event.duration_ms).toBe(1234);
  });

  it("maps status=failed with error_code", () => {
    const event = agentRunEvent({
      tenant_id: "t1",
      space_id: "sp1",
      session_id: "ses1",
      run_id: "run-1",
      status: "failed",
      error_code: "context_limit",
      environment: "production",
      service: "agents",
    });
    expect(event.event_type).toBe("agent.run.failed");
    expect(event.error_code).toBe("context_limit");
    const slots = buildAeDataPoint(event);
    expect(slots.blobs[8]).toBe("context_limit");
  });
});
