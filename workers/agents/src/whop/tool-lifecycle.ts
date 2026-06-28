/**
 * Micro-tool lifecycle state machine (§02 / WG-01 / WG-29).
 *
 * The §02 non-negotiable is that the tool "must actually work — tested, real
 * functionality." The single property this state machine exists to enforce is:
 * a tool version can only be DEPLOYED from the `tested` state — i.e. nothing
 * reaches paying customers unless a build+test gate passed first. The container
 * (Tier 5) is just the executor that flips a version from `building` to `tested`
 * or `build_failed`; if no container is configured, a version simply never leaves
 * `building`, which is the safe outcome.
 *
 * Deliberately free of any `cloudflare:workers` import so it is unit-testable.
 */

export type ToolState =
  | "draft"          // code generated, not yet built
  | "building"       // handed to the container to build + run tests
  | "tested"         // build succeeded AND tests passed → deployable
  | "build_failed"   // build or tests failed → not deployable
  | "deploying"      // being deployed as its own Worker
  | "live"           // deployed and serving customers
  | "deploy_failed"; // deploy attempt failed

export type ToolEvent =
  | "start_build"
  | "build_passed"
  | "build_failed"
  | "start_deploy"
  | "deploy_succeeded"
  | "deploy_failed"
  | "revise"; // a new draft supersedes the current version

// Allowed transitions. Any (state,event) not listed is illegal → nextToolState null.
const TRANSITIONS: Record<ToolState, Partial<Record<ToolEvent, ToolState>>> = {
  draft:         { start_build: "building", revise: "draft" },
  building:      { build_passed: "tested", build_failed: "build_failed" },
  tested:        { start_deploy: "deploying", revise: "draft" }, // GATE: deploy only from tested
  build_failed:  { revise: "draft" },
  deploying:     { deploy_succeeded: "live", deploy_failed: "deploy_failed" },
  live:          { revise: "draft" }, // iterate: a new version starts as a fresh draft
  deploy_failed: { revise: "draft", start_deploy: "deploying" }, // retry deploy of a tested build
};

/** Returns the next state for a legal transition, or null if the event is illegal here. */
export function nextToolState(current: ToolState, event: ToolEvent): ToolState | null {
  return TRANSITIONS[current][event] ?? null;
}

/** The §02 gate: a version may only be deployed once it has passed build+test. */
export function canDeploy(state: ToolState): boolean {
  return state === "tested";
}

/** Terminal-ish states that need a human or a new revision to move forward. */
export function isStuck(state: ToolState): boolean {
  return state === "build_failed" || state === "deploy_failed";
}
