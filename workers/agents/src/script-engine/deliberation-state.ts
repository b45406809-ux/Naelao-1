/** Explicit state machine for consult deliberation.
 *
 * A consultation round is a protocol boundary, not an incidental loop counter: after two
 * completed rounds the planner must stop and obtain human direction rather than spend a third
 * round attempting to resolve a disagreement without new authority.
 */

export type DeliberationStatus = "OPEN" | "BLOCKED_AWAITING_HUMAN";

export interface DeliberationState {
  round: 0 | 1 | 2;
  status: DeliberationStatus;
}

export function initialDeliberationState(): DeliberationState {
  return { round: 0, status: "OPEN" };
}

/** Restore the durable round carried by a suspended/interrupted run after DO hibernation. */
export function restoreDeliberationState(round: number | undefined): DeliberationState {
  if (round === undefined || !Number.isFinite(round)) return initialDeliberationState();
  return { round: Math.max(0, Math.min(2, Math.trunc(round))) as 0 | 1 | 2, status: "OPEN" };
}

export function beginConsultation(state: DeliberationState):
  | { accepted: true; state: DeliberationState }
  | { accepted: false; state: DeliberationState; reason: "two_round_horizon" } {
  if (state.status === "BLOCKED_AWAITING_HUMAN" || state.round >= 2) {
    return { accepted: false, state: { round: 2, status: "BLOCKED_AWAITING_HUMAN" }, reason: "two_round_horizon" };
  }
  const round = (state.round + 1) as 1 | 2;
  return { accepted: true, state: { round, status: "OPEN" } };
}
