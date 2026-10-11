import { describe, expect, it } from "vitest";
import { beginConsultation, initialDeliberationState, restoreDeliberationState } from "./deliberation-state.js";

describe("consult deliberation state machine", () => {
  it("allows exactly two rounds", () => {
    const first = beginConsultation(initialDeliberationState());
    expect(first).toMatchObject({ accepted: true, state: { round: 1, status: "OPEN" } });
    const second = beginConsultation(first.state);
    expect(second).toMatchObject({ accepted: true, state: { round: 2, status: "OPEN" } });
  });

  it("blocks a third round and remains terminal", () => {
    const second = beginConsultation(beginConsultation(initialDeliberationState()).state).state;
    const blocked = beginConsultation(second);
    expect(blocked).toEqual({ accepted: false, state: { round: 2, status: "BLOCKED_AWAITING_HUMAN" }, reason: "two_round_horizon" });
    expect(beginConsultation(blocked.state)).toEqual(blocked);
  });

  it("restores a persisted round without reopening the two-round horizon", () => {
    const restored = restoreDeliberationState(2);
    expect(restored).toEqual({ round: 2, status: "OPEN" });
    expect(beginConsultation(restored)).toEqual({
      accepted: false,
      state: { round: 2, status: "BLOCKED_AWAITING_HUMAN" },
      reason: "two_round_horizon",
    });
    expect(restoreDeliberationState(99)).toEqual({ round: 2, status: "OPEN" });
  });
});
