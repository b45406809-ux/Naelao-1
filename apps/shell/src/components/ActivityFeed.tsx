"use client";

// The "currently doing X" / tool-call activity feed — Claude Code's own pattern applied to the
// script-native loop's real trace steps (observe/find/gate/reason/run/answer/give_up, see
// script-engine/loop.ts's TraceStep + NaelaoAgentDO's live-progress map). Two pieces:
//   - LiveActivityLine: a single live-updating line while a run is in flight ("Thinking…",
//     "Running script.find…"), fed by SSE "activity" events / poll live_steps.
//   - ActivitySummary: once the run completes, a collapsed "Thought and used 2 tools" bar under
//     the answer — expand to see the ordered step list, expand any step to inspect its detail
//     (tokens/duration/tier), and — for a reasoning-capable model with a level chosen — its own
//     captured chain-of-thought, rendered as a separate "Thoughts" block.

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

function stepLabel(step: LiveRunStep): string {
  switch (step.phase) {
    case "run":
      return step.name ? `Ran ${step.name}` : "Ran a tool";
    case "reason":
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

/** Live, single-line "currently doing X" indicator — the most recent checkpoint, updating as new
 *  ones arrive. Shown in place of (or alongside) the plain typing-dots indicator while loading. */
export function LiveActivityLine({ steps }: { steps: LiveRunStep[] }) {
  const last = steps[steps.length - 1];
  if (!last) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--text3)" }}>
      <span aria-hidden style={{ fontSize: 11 }}>{phaseIcon(last.phase)}</span>
      <span>{stepLabel(last)}…</span>
    </div>
  );
}

/** Collapsed-by-default summary of everything a completed run did. Renders nothing for a trivial
 *  answer-only turn (no tool use, no captured thinking) — a bar under every single message would
 *  be noise, not signal. */
export function ActivitySummary({ steps }: { steps: LiveRunStep[] }) {
  const [expanded, setExpanded] = React.useState(false);
  const [openStep, setOpenStep] = React.useState<number | null>(null);

  const toolSteps = steps.filter((s) => s.phase === "run");
  const hasThinking = steps.some((s) => !!s.thinking);
  if (toolSteps.length === 0 && !hasThinking) return null;

  const parts = [
    hasThinking ? "thought" : null,
    toolSteps.length > 0 ? `used ${toolSteps.length} tool${toolSteps.length === 1 ? "" : "s"}` : null,
  ].filter(Boolean) as string[];
  const summary = parts.length > 0 ? parts.join(" and ") : "worked on this";
  const summaryLabel = summary.charAt(0).toUpperCase() + summary.slice(1);

  return (
    <div style={{ margin: "4px 0 8px", maxWidth: 460 }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text3)",
          background: "transparent", border: "none", cursor: "pointer", padding: "2px 0",
        }}
      >
        <svg
          width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.5}
          style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
        >
          <path d="M4 2.5L8 6L4 9.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{summaryLabel}</span>
      </button>
      {expanded && (
        <div style={{ marginTop: 4, borderLeft: "2px solid var(--border)", paddingLeft: 10 }}>
          {steps.map((step, i) => {
            const inspectable = step.duration_ms !== undefined || step.tokens !== undefined || !!step.thinking || (!!step.detail && step.phase !== "reason");
            return (
              <div key={step.seq} style={{ marginBottom: 2 }}>
                <button
                  type="button"
                  onClick={() => inspectable && setOpenStep(openStep === i ? null : i)}
                  style={{
                    display: "flex", width: "100%", alignItems: "center", gap: 6, fontSize: 12,
                    color: "var(--text2)", background: "transparent", border: "none",
                    cursor: inspectable ? "pointer" : "default", padding: "3px 0", textAlign: "left",
                  }}
                >
                  <span aria-hidden>{phaseIcon(step.phase)}</span>
                  <span style={{ flex: 1 }}>{stepLabel(step)}</span>
                  {step.ok === false && <span style={{ color: "#dc2626", fontSize: 11 }}>failed</span>}
                  {inspectable && <span style={{ color: "var(--text3)", fontSize: 10.5 }}>{openStep === i ? "▲" : "▼"}</span>}
                </button>
                {openStep === i && inspectable && (
                  <div style={{ fontSize: 11.5, color: "var(--text3)", padding: "2px 0 6px 18px", lineHeight: 1.6 }}>
                    {step.detail && step.phase !== "reason" && <div>{step.detail}</div>}
                    {step.duration_ms !== undefined && <div>{step.duration_ms}ms</div>}
                    {!!step.tokens && step.tokens > 0 && <div>{step.tokens} tokens</div>}
                    {step.tier !== undefined && <div>Tier {step.tier}</div>}
                    {step.thinking && (
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
      )}
    </div>
  );
}
