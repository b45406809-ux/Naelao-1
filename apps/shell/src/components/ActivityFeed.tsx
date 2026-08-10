"use client";

// The activity sequence — Claude Code's own "thinking → tool call → reply → tool call → … →
// final answer" pattern, applied to the script-native loop's real trace steps (observe/find/gate/
// reason/run/answer/give_up, see script-engine/loop.ts's TraceStep + NaelaoAgentDO's live-progress
// map). Previously this was two separate, weaker pieces: a single-line "currently doing X"
// indicator while live (only ever showing the MOST RECENT step, nothing before it) and a collapsed
// "Thought and used 2 tools" bar rendered AFTER the final answer once the run was done — neither
// showed the actual order things happened in, and neither could show the model TALKING mid-run
// (only its final answer). ActivitySequence replaces both with one component that renders every
// step as its own row, in the order it really happened, live or after the fact — the SAME renderer
// either way, so what you watch happen and what you see on reload/re-fetch are the same shape.
//
// Two kinds of model-authored text are rendered differently on purpose:
//   - `thinking` (a reasoning-capable model's own chain-of-thought) stays collapsed by default —
//     internal reasoning, not something written to be read, exactly like Claude Code's own
//     collapsible thinking blocks.
//   - `narration` (prose the model wrote ALONGSIDE a tool call, e.g. "I'll check the order list
//     first") is rendered as an always-visible reply line right where it happened — this is the
//     real "the agent talks to me, but it's not the final answer" content the model actually wrote,
//     not fabricated: `reasoner.ts` captures it directly from the provider response, it was just
//     discarded before this pass.

import * as React from "react";
import type { LiveRunStep } from "@/lib/api";

function phaseIcon(phase: string): string {
  switch (phase) {
    case "observe": return "👁";
    case "find": return "🔍";
    case "gate": return "🚦";
    case "reason": return "🧠";
    case "run": return "🔧";
    case "answer": return "✅";
    case "give_up": return "⚠️";
    default: return "•";
  }
}

function stepLabel(step: LiveRunStep, active: boolean): string {
  switch (step.phase) {
    case "run":
      return step.name ? `${active ? "Running" : "Ran"} ${step.name}` : active ? "Running a tool" : "Ran a tool";
    case "reason":
      if (active) return "Thinking";
      if (step.detail === "run") return "Decided to use a tool";
      if (step.detail === "answer") return "Composed an answer";
      if (step.detail === "distill") return "Wrote a new reusable script";
      if (step.detail === "patch") return "Repaired a script";
      return "Thinking";
    case "observe":
      return "Observed current state";
    case "find":
      return "Searched for a matching capability";
    case "gate":
      return step.detail ? `Chose approach: ${step.detail}` : "Chose an approach";
    case "answer":
      return "Composed a final answer";
    case "give_up":
      return step.detail ? `Gave up: ${step.detail}` : "Gave up";
    default:
      return step.detail ?? step.phase;
  }
}

/**
 * Reveals `text` progressively when `animate` is true (a client-side typing effect — NOT real
 * token-by-token generation streaming, which would need the backend to relay deltas as the model
 * actually generates them; that's a separate, larger, documented follow-up). When `animate` is
 * false, or once fully revealed, just renders the text. Growing text (a longer string that starts
 * with what's already shown) extends the reveal instead of restarting it; a text that ISN'T an
 * extension of what's shown (a genuinely different message) resets and reveals fresh.
 */
function RevealText({ text, animate }: { text: string; animate?: boolean | undefined }) {
  const [shown, setShown] = React.useState(animate ? "" : text);

  React.useEffect(() => {
    if (!animate) {
      setShown(text);
      return;
    }
    let i = text.startsWith(shown) ? shown.length : 0;
    if (i === 0) setShown("");
    if (i >= text.length) return; // already fully shown (e.g. a re-render with the same text)
    // Cap the reveal at ~120 ticks regardless of length, so a long answer doesn't take forever.
    const perTick = Math.max(2, Math.ceil(text.length / 120));
    const id = setInterval(() => {
      i = Math.min(text.length, i + perTick);
      setShown(text.slice(0, i));
      if (i >= text.length) clearInterval(id);
    }, 16);
    return () => clearInterval(id);
    // `shown` deliberately excluded — it's read once per `text` change to find the reveal's
    // starting point, not a dependency the effect should restart on (that would fight its own
    // setState calls).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, animate]);

  return <>{shown}</>;
}

/** One live-progress checkpoint fires TWICE for a "reason"/"run" step — once right before it
 *  starts (name/detail set, no duration_ms/tokens yet) and once when it completes (the same
 *  phase+name, now with duration_ms/tokens/ok) — see loop.ts's `onProgress` doc. In between, a
 *  reasoning step is UPDATED IN PLACE as the model writes (`partial`), so the growing sentence
 *  arrives as one row rather than one row per fragment. Persisted trace steps carry only the
 *  completed half, so this is a no-op pass-through for them; for a live feed it collapses each
 *  start(/partials)+complete run into ONE row and marks whichever step is still only half-arrived
 *  as `active` (currently in flight). */
function mergeSteps(raw: LiveRunStep[]): { step: LiveRunStep; active: boolean }[] {
  const merged: { step: LiveRunStep; active: boolean }[] = [];
  for (const s of raw) {
    const prev = merged[merged.length - 1];
    const completesPrev =
      prev?.active &&
      prev.step.phase === s.phase &&
      (s.phase !== "run" || prev.step.name === s.name) &&
      prev.step.duration_ms === undefined &&
      s.duration_ms !== undefined;
    if (completesPrev) {
      // Carry forward text the in-flight row had accumulated but the completed one didn't report.
      // A model that streamed a mid-run reply and then failed to repeat it on the final chunk
      // should not have its own words disappear the instant the step finishes.
      const narration = s.narration ?? prev.step.narration;
      merged[merged.length - 1] = {
        step: narration ? { ...s, narration } : s,
        active: false,
      };
    } else {
      const active = s.partial === true || (s.duration_ms === undefined && (s.phase === "reason" || s.phase === "run"));
      merged.push({ step: s, active });
    }
  }
  return merged;
}

/**
 * The full sequence, live or persisted — replaces the old LiveActivityLine (single line) and
 * ActivitySummary (collapsed-after-the-fact) with one renderer. `animate` gates the client-side
 * reveal effect on freshly-arriving narration/thinking text (never on a persisted/reloaded run).
 * Renders nothing for a trivial answer-only turn (no tool use, no thinking, no narration, nothing
 * in flight) — a row under every single message would be noise, not signal.
 */
export function ActivitySequence({ steps, animate, live }: { steps: LiveRunStep[]; animate?: boolean | undefined; live?: boolean | undefined }) {
  const [openStep, setOpenStep] = React.useState<number | null>(null);
  const merged = React.useMemo(() => mergeSteps(steps), [steps]);

  const toolCount = merged.filter((m) => m.step.phase === "run" && !m.active).length;
  const thoughtCount = merged.filter((m) => m.step.phase === "reason" && !!m.step.thinking).length;
  const anyActive = merged.some((m) => m.active);

  if (merged.length === 0) return null;
  // A live run shows SOMETHING for every step it takes — even a lone "Observed current state"
  // in the first instant — because the person is actively waiting and any real feedback beats a
  // blank row. A persisted/reloaded run hides entirely when there's nothing worth reading (no
  // tool use, no thinking, no narration) — a row under every single trivial Q&A would be noise.
  if (!live && !anyActive && toolCount === 0 && thoughtCount === 0 && !merged.some((m) => m.step.narration)) return null;

  return (
    <div style={{ margin: "2px 0 8px", maxWidth: 520 }}>
      {/* A compact running tally once there's more than one thing to summarize — "3 tool calls,
          1 thought" — the same aggregate Claude Code shows while several tool calls stack up.
          Purely informational; the rows below already show everything this restates. */}
      {toolCount + thoughtCount > 1 && (
        <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 3 }}>
          {[
            toolCount > 0 ? `${toolCount} tool call${toolCount === 1 ? "" : "s"}` : null,
            thoughtCount > 0 ? `${thoughtCount} thought${thoughtCount === 1 ? "" : "s"}` : null,
          ].filter(Boolean).join(" · ")}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {merged.map(({ step, active }, i) => {
          const hasNarration = !!step.narration;
          const hasThinking = !!step.thinking;
          const inspectable = step.duration_ms !== undefined || step.tokens !== undefined || (!!step.detail && step.phase !== "reason");
          const expandable = hasThinking || inspectable;
          const isOpen = openStep === i;
          return (
            <div key={`${step.seq}-${step.phase}-${step.name ?? ""}`}>
              <button
                type="button"
                onClick={() => expandable && setOpenStep(isOpen ? null : i)}
                style={{
                  display: "flex", width: "100%", alignItems: "center", gap: 6, fontSize: 12,
                  color: active ? "var(--text2)" : "var(--text3)", background: "transparent", border: "none",
                  cursor: expandable ? "pointer" : "default", padding: "2px 0", textAlign: "left",
                }}
              >
                <span aria-hidden style={{ fontSize: 11, opacity: active ? 1 : 0.75 }}>{phaseIcon(step.phase)}</span>
                <span style={{ flex: 1 }}>
                  {stepLabel(step, active)}
                  {active && <span className="activity-ellipsis">…</span>}
                </span>
                {step.ok === false && <span style={{ color: "#dc2626", fontSize: 11 }}>failed</span>}
                {expandable && <span style={{ color: "var(--text3)", fontSize: 10 }}>{isOpen ? "▲" : "▼"}</span>}
              </button>
              {/* Narration — a real reply the model wrote, always visible where it happened, never
                  collapsed (it was written to be read, unlike thinking). */}
              {hasNarration && (
                <div style={{ fontSize: 13, color: "var(--text1)", padding: "2px 0 4px 19px", lineHeight: 1.5 }}>
                  {/* Animated while a run is live INCLUDING mid-write: the text really is arriving
                      progressively from the server, and RevealText extends rather than restarts
                      when it grows, so this smooths the gap between polls instead of stuttering. */}
                  <RevealText text={step.narration!} animate={animate} />
                </div>
              )}
              {isOpen && expandable && (
                <div style={{ fontSize: 11.5, color: "var(--text3)", padding: "2px 0 6px 19px", lineHeight: 1.6 }}>
                  {step.detail && step.phase !== "reason" && <div>{step.detail}</div>}
                  {step.duration_ms !== undefined && <div>{step.duration_ms}ms</div>}
                  {!!step.tokens && step.tokens > 0 && <div>{step.tokens} tokens</div>}
                  {step.tier !== undefined && <div>Tier {step.tier}</div>}
                  {hasThinking && (
                    <div>
                      <div style={{ marginTop: 4, marginBottom: 2, fontWeight: 600, color: "var(--text2)" }}>Thoughts</div>
                      <div style={{ padding: 8, background: "var(--surface2)", borderRadius: 8, whiteSpace: "pre-wrap" }}>
                        {step.thinking}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export { RevealText };
