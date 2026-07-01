import { describe, it, expect } from "vitest";
import {
  matchesEvent,
  selectMatchingRules,
  evaluateCondition,
  buildFireParams,
} from "@naelao/events";
import type { TriggerRule, EventEnvelope } from "@naelao/events";

function makeRule(overrides: Partial<TriggerRule> = {}): TriggerRule {
  return {
    id: "rule-1",
    space_id: "space1",
    event_type: "thread.created",
    condition: { type: "always" },
    action: { type: "run_script", script_name: "noop" },
    enabled: true,
    priority: 0,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return { type: "thread.created", space_id: "space1", occurred_at: Date.now(), ...overrides };
}

describe("matchesEvent — structural scoping (event type + project boundary)", () => {
  it("matches when event_type and space_id agree and the rule is space-wide", () => {
    expect(matchesEvent(makeRule(), makeEvent())).toBe(true);
  });

  it("does not match a disabled rule", () => {
    expect(matchesEvent(makeRule({ enabled: false }), makeEvent())).toBe(false);
  });

  it("does not match a different event_type", () => {
    expect(matchesEvent(makeRule({ event_type: "project.created" }), makeEvent())).toBe(false);
  });

  it("does not match a different space (never cross-tenant)", () => {
    expect(matchesEvent(makeRule({ space_id: "space1" }), makeEvent({ space_id: "space2" }))).toBe(false);
  });

  it("a project-scoped rule only matches events in that EXACT project — never a different project", () => {
    const rule = makeRule({ project_id: "proj1" });
    expect(matchesEvent(rule, makeEvent({ project_id: "proj1" }))).toBe(true);
    expect(matchesEvent(rule, makeEvent({ project_id: "proj2" }))).toBe(false);
    expect(matchesEvent(rule, makeEvent({ project_id: undefined }))).toBe(false);
  });

  it("a space-wide rule (no project_id) matches events in ANY project of that space", () => {
    const rule = makeRule(); // no project_id
    expect(matchesEvent(rule, makeEvent({ project_id: "proj1" }))).toBe(true);
    expect(matchesEvent(rule, makeEvent({ project_id: "proj2" }))).toBe(true);
  });
});

describe("selectMatchingRules — priority ordering", () => {
  it("returns only structurally-matching rules, highest priority first", () => {
    const rules = [
      makeRule({ id: "low", priority: 1 }),
      makeRule({ id: "high", priority: 10 }),
      makeRule({ id: "wrong-type", event_type: "project.created" }),
      makeRule({ id: "disabled", enabled: false }),
    ];
    const selected = selectMatchingRules(rules, makeEvent());
    expect(selected.map((r) => r.id)).toEqual(["high", "low"]);
  });
});

describe("evaluateCondition", () => {
  it("'always' always matches with no target thread", () => {
    const result = evaluateCondition({ type: "always" }, {});
    expect(result).toEqual({ matched: true });
  });

  it("'last_active_thread_idle' does not match when there's no other thread", () => {
    const result = evaluateCondition({ type: "last_active_thread_idle", idle_minutes: 5 }, {});
    expect(result.matched).toBe(false);
  });

  it("'last_active_thread_idle' matches and returns the target when idle long enough", () => {
    const now = 1_000_000_000_000;
    const result = evaluateCondition(
      { type: "last_active_thread_idle", idle_minutes: 5 },
      { lastActiveOtherThread: { id: "thread-old", updated_at_ms: now - 10 * 60_000 }, now }
    );
    expect(result).toEqual({ matched: true, targetThreadId: "thread-old" });
  });

  it("'last_active_thread_idle' does not match when the other thread is still recent", () => {
    const now = 1_000_000_000_000;
    const result = evaluateCondition(
      { type: "last_active_thread_idle", idle_minutes: 5 },
      { lastActiveOtherThread: { id: "thread-fresh", updated_at_ms: now - 60_000 }, now }
    );
    expect(result.matched).toBe(false);
  });
});

describe("buildFireParams — the fired script always knows what triggered it", () => {
  it("targets the condition-resolved thread when there is one, over the event's own thread", () => {
    const params = buildFireParams(
      { type: "run_script", script_name: "compact", params: { extra: "static" } },
      makeEvent({ thread_id: "new-thread" }),
      { matched: true, targetThreadId: "idle-thread" }
    );
    expect(params).toMatchObject({ extra: "static", thread_id: "idle-thread", triggered_by_thread_id: "new-thread" });
  });

  it("falls back to the event's own thread when the condition resolved no target", () => {
    const params = buildFireParams(
      { type: "run_script", script_name: "noop" },
      makeEvent({ thread_id: "new-thread" }),
      { matched: true }
    );
    expect(params["thread_id"]).toBe("new-thread");
  });
});
