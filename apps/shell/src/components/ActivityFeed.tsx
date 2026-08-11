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
function RevealText({
  text,
  animate,
  revealFrom,
}: {
  text: string;
  animate?: boolean | undefined;
  /** Text the viewer has ALREADY watched appear, in a different component instance. The growing-
   *  text logic below only extends a reveal within one mounted instance — across a remount the
   *  state is gone, so a bubble that re-mounts with the same text restarts it from empty and
   *  re-types something the viewer just finished reading. That remount is exactly what happens
   *  when a streaming run finalizes (the live block unmounts, the persisted message mounts), and
   *  it is the visible "snap". Seeding `shown` with what was already on screen makes the
   *  finalized bubble pick up where the live one left off — instantly if it was fully revealed,
   *  or continuing the remainder if the stream was cut short. */
  revealFrom?: string | undefined;
}) {
  const [shown, setShown] = React.useState(() => {
    if (!animate) return text;
    return revealFrom && text.startsWith(revealFrom) ? revealFrom : "";
  });

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
      // A model that streamed a status or a message and then failed to repeat it on the final
      // chunk should not have its own words disappear the instant the step finishes.
      const narration = s.narration ?? prev.step.narration;
      const message = s.message ?? prev.step.message;
      merged[merged.length - 1] = {
        step: { ...s, ...(narration ? { narration } : {}), ...(message ? { message } : {}) },
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
 * One item in the grouped rendering: a standalone loop-bookkeeping row (observe/find/gate), a real
 * MESSAGE the model wrote to the person, or a SEGMENT of consecutive tool-call activity.
 *
 * This is Claude Code's own shape, and it depends on the model writing two different things per
 * action (see reasoner.ts's DOING_PARAM / SAY_PARAM):
 *
 *   message ("I'll check whether p1 already has a thread")
 *   ├─ 3 tools · 1 thought        ← one collapsible; inside it the per-action status line
 *   message ("There was no thread, so I'm creating one and greeting the agent")
 *   └─ 2 tools
 *   …then the final answer, rendered as the message bubble by the caller.
 *
 * A `message` is permanent and breaks the segment — it is the model deciding this is a moment
 * worth telling the person about. A `narration` is the per-action STATUS and is overridden by the
 * next action's own within the same segment, because fifteen "let me check…" lines stacked up is
 * exactly the wall of noise this replaced: nobody scrolls back to read a status.
 */
type ToolRow = { step: LiveRunStep; active: boolean; idx: number };
type ThoughtRow = { step: LiveRunStep; idx: number };
type Grouped =
  | { kind: "plain"; step: LiveRunStep; active: boolean; idx: number }
  | { kind: "message"; text: string; active: boolean; idx: number }
  | {
      kind: "segment";
      narration?: string;
      narrationActive: boolean;
      tools: ToolRow[];
      thoughts: ThoughtRow[];
      anyActive: boolean;
      startIdx: number;
    };

function groupSteps(merged: { step: LiveRunStep; active: boolean }[]): Grouped[] {
  const out: Grouped[] = [];
  let current: Extract<Grouped, { kind: "segment" }> | null = null;
  const closeSegment = () => {
    if (current && (current.tools.length > 0 || current.thoughts.length > 0 || current.narration)) out.push(current);
    current = null;
  };
  merged.forEach(({ step, active }, idx) => {
    if (step.phase === "observe" || step.phase === "find") {
      closeSegment();
      out.push({ kind: "plain", step, active, idx });
      return;
    }
    // Two different things share the "gate" phase. The once-per-run "chose an approach" gate
    // (e.g. "Chose approach: L3") has no `name` — it's a standalone line before any segment
    // starts. A per-ACTION gate (`name` set: the run was parked pending approval, or skipped
    // because the step budget ran out) is treated below as a row INSIDE the current segment,
    // not here — closing the segment on it, as this used to, orphaned the narration that
    // described that exact action ("Reading the report…") with no table underneath it at all,
    // since the action never got a "run" trace entry to sit in one.
    if (step.phase === "gate" && !step.name) {
      closeSegment();
      out.push({ kind: "plain", step, active, idx });
      return;
    }
    if (step.phase === "answer" || step.phase === "give_up") {
      // Terminal for this segment — the reply/give-up text is rendered by the caller (the
      // message bubble / error banner), not as a row here.
      closeSegment();
      return;
    }
    // A real message comes BEFORE the action it introduces: the model writes both on the same
    // turn, and the message is its orientation for what it is about to do. So it closes whatever
    // run of tool calls preceded it and the following action starts a fresh one.
    if (step.message) {
      closeSegment();
      out.push({ kind: "message", text: step.message, active, idx });
    }
    if (!current) current = { kind: "segment", narrationActive: false, tools: [], thoughts: [], anyActive: false, startIdx: idx };
    if (step.narration) {
      current.narration = step.narration; // latest wins — a status, not a log
      current.narrationActive = active;
    }
    if (step.phase === "reason" && step.thinking) current.thoughts.push({ step, idx });
    // A per-action gate row (parked / skipped) goes in the table alongside real tool calls — the
    // model committed to this action and it was recorded, it just didn't get to run.
    if (step.phase === "run" || (step.phase === "gate" && step.name)) current.tools.push({ step, active, idx });
    if (active) current.anyActive = true;
  });
  closeSegment();
  return out;
}

function segmentHeader(seg: Extract<Grouped, { kind: "segment" }>): string {
  const runRows = seg.tools.filter((t) => t.step.phase !== "gate");
  const gateRows = seg.tools.filter((t) => t.step.phase === "gate");
  const activeTools = runRows.filter((t) => t.active).length;
  const doneTools = runRows.length - activeTools;
  const totalTools = runRows.length;
  let toolPart: string | null = null;
  if (activeTools > 0 && doneTools === 0) {
    toolPart = `${activeTools} tool${activeTools === 1 ? "" : "s"} running`;
  } else if (totalTools > 0) {
    toolPart = `${totalTools} tool${totalTools === 1 ? "" : "s"}`;
  }
  const thoughtPart = seg.thoughts.length > 0 ? `${seg.thoughts.length} thought${seg.thoughts.length === 1 ? "" : "s"}` : null;
  // Parked/skipped actions (see groupSteps) count separately — nothing actually ran for them,
  // so folding them into "N tools" would overstate what happened.
  const gatePart = gateRows.length > 0 ? `${gateRows.length} waiting` : null;
  return [toolPart, thoughtPart, gatePart].filter(Boolean).join(" · ") || (seg.anyActive ? "Thinking" : "Working");
}

function pendingRowLabel(detail: string | undefined): string {
  switch (detail) {
    case "deferred_pending_approval":
    case "awaiting_approval":
      return "waiting for approval";
    case "skipped_final_step":
      return "skipped — ran out of time";
    default:
      return "paused";
  }
}

function ToolRowView({
  row, isOpen, onToggle,
}: { row: ToolRow; isOpen: boolean; onToggle: () => void }) {
  const { step, active } = row;
  // A parked/skipped action (see groupSteps) — the model committed to it and it was recorded,
  // it just never actually ran. Rendered distinctly (amber "waiting"/"skipped", never the red
  // "failed" a genuinely-attempted-and-errored tool call gets) so this doesn't read as a bug.
  const pending = step.phase === "gate";
  const failed = !pending && step.ok === false;
  let paramsText: string | null = null;
  if (step.params !== undefined) {
    try {
      paramsText = typeof step.params === "string" ? step.params : JSON.stringify(step.params, null, 2);
    } catch {
      paramsText = null;
    }
  }
  const expandable = !!paramsText || !!step.output || !!step.detail || step.duration_ms !== undefined;
  return (
    <div style={{ borderTop: "1px solid var(--border, #e5e7eb)" }}>
      <button
        type="button"
        onClick={() => expandable && onToggle()}
        style={{
          display: "flex", width: "100%", alignItems: "center", gap: 6, fontSize: 12,
          color: active ? "var(--text2)" : "var(--text3)", background: "transparent", border: "none",
          cursor: expandable ? "pointer" : "default", padding: "5px 8px", textAlign: "left",
        }}
      >
        <span style={{ flex: 1, fontFamily: "var(--font-mono, monospace)" }}>
          {step.name ?? "tool"}
          {active && <span className="activity-ellipsis">…</span>}
        </span>
        {!pending && step.duration_ms !== undefined && <span style={{ fontSize: 10.5 }}>{step.duration_ms}ms</span>}
        {pending && <span style={{ color: "#b45309", fontSize: 11 }}>{pendingRowLabel(step.detail)}</span>}
        {failed && <span style={{ color: "#dc2626", fontSize: 11 }}>failed</span>}
        {expandable && <span style={{ color: "var(--text3)", fontSize: 10 }}>{isOpen ? "▲" : "▼"}</span>}
      </button>
      {isOpen && expandable && (
        <div style={{ fontSize: 11.5, color: "var(--text3)", padding: "0 8px 8px", lineHeight: 1.6 }}>
          {paramsText && (
            <div style={{ marginBottom: 4 }}>
              <div style={{ fontWeight: 600, color: "var(--text2)", marginBottom: 2 }}>Command</div>
              <pre style={{ margin: 0, padding: 8, background: "var(--surface2)", borderRadius: 8, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 11 }}>
                {paramsText}
              </pre>
            </div>
          )}
          {(step.output || (failed && step.detail)) && (
            <div style={{ marginBottom: 4 }}>
              <div style={{ fontWeight: 600, color: failed ? "#dc2626" : "var(--text2)", marginBottom: 2 }}>
                {failed ? "Error" : "Result"}
              </div>
              <pre style={{ margin: 0, padding: 8, background: "var(--surface2)", borderRadius: 8, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 11 }}>
                {failed ? step.detail : step.output}
              </pre>
            </div>
          )}
          {!!step.tokens && step.tokens > 0 && <div>{step.tokens} tokens</div>}
          {step.tier !== undefined && <div>Tier {step.tier}</div>}
        </div>
      )}
    </div>
  );
}

function ThoughtRowView({ row, isOpen, onToggle }: { row: ThoughtRow; isOpen: boolean; onToggle: () => void }) {
  return (
    <div style={{ borderTop: "1px solid var(--border, #e5e7eb)" }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: "flex", width: "100%", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text3)",
          background: "transparent", border: "none", cursor: "pointer", padding: "5px 8px", textAlign: "left",
        }}
      >
        <span style={{ flex: 1 }}>Thought</span>
        <span style={{ color: "var(--text3)", fontSize: 10 }}>{isOpen ? "▲" : "▼"}</span>
      </button>
      {isOpen && (
        <div style={{ padding: "0 8px 8px" }}>
          <div style={{ padding: 8, background: "var(--surface2)", borderRadius: 8, whiteSpace: "pre-wrap", fontSize: 11.5, color: "var(--text3)", lineHeight: 1.6 }}>
            {row.step.thinking}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The full sequence, live or persisted — replaces the old LiveActivityLine (single line) and
 * ActivitySummary (collapsed-after-the-fact) with one renderer. `animate` gates the client-side
 * reveal effect on freshly-arriving narration/thinking text (never on a persisted/reloaded run).
 * Renders nothing for a trivial answer-only turn (no tool use, no thinking, no narration, nothing
 * in flight) — a row under every single message would be noise, not signal.
 */
export function ActivitySequence({ steps, animate, live }: { steps: LiveRunStep[]; animate?: boolean | undefined; live?: boolean | undefined }) {
  const merged = React.useMemo(() => mergeSteps(steps), [steps]);
  const grouped = React.useMemo(() => groupSteps(merged), [merged]);
  // Segment collapsibles the person opened by hand — a segment also renders open automatically
  // while it's still in flight, without needing an entry here (see the `isOpen` computation
  // below), so this only has to track "opened on purpose" and "manually closed after finishing".
  const [openSegments, setOpenSegments] = React.useState<Set<number>>(new Set());
  const [closedLiveSegments, setClosedLiveSegments] = React.useState<Set<number>>(new Set());
  const [openRows, setOpenRows] = React.useState<Set<string>>(new Set());
  const toggleRow = React.useCallback((key: string) => {
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const toolCount = grouped.reduce((n, g) => (g.kind === "segment" ? n + g.tools.filter((t) => !t.active).length : n), 0);
  const thoughtCount = grouped.reduce((n, g) => (g.kind === "segment" ? n + g.thoughts.length : n), 0);
  const anyActive = merged.some((m) => m.active);
  const anyNarration = grouped.some((g) => g.kind === "message" || (g.kind === "segment" && !!g.narration));

  if (grouped.length === 0) return null;
  // A live run shows SOMETHING for every step it takes — even a lone "Observed current state"
  // in the first instant — because the person is actively waiting and any real feedback beats a
  // blank row. A persisted/reloaded run hides entirely when there's nothing worth reading (no
  // tool use, no thinking, no narration) — a row under every single trivial Q&A would be noise.
  if (!live && !anyActive && toolCount === 0 && thoughtCount === 0 && !anyNarration) return null;

  return (
    <div style={{ margin: "2px 0 8px", maxWidth: 520 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {grouped.map((g, gi) => {
          if (g.kind === "plain") {
            return (
              <div key={`plain-${g.idx}`} style={{ fontSize: 12, color: g.active ? "var(--text2)" : "var(--text3)" }}>
                {stepLabel(g.step, g.active)}
                {g.active && <span className="activity-ellipsis">…</span>}
              </div>
            );
          }
          // A real message the model wrote to the person, mid-run. Rendered at full weight, in
          // normal prose — this is the agent talking, and it should read exactly like the final
          // answer does, not like the dim status lines around it.
          if (g.kind === "message") {
            return (
              <div
                key={`msg-${g.idx}`}
                style={{ fontSize: 14, color: "var(--text1)", lineHeight: 1.6, whiteSpace: "pre-wrap", padding: "4px 0 2px" }}
              >
                <RevealText text={g.text} animate={animate && g.active} />
              </div>
            );
          }
          const rows = [...g.tools.map((t) => ({ type: "tool" as const, idx: t.idx, row: t })), ...g.thoughts.map((t) => ({ type: "thought" as const, idx: t.idx, row: t }))]
            .sort((a, b) => a.idx - b.idx);
          const isOpen = !closedLiveSegments.has(gi) && (g.anyActive || openSegments.has(gi));
          return (
            <div key={`seg-${g.startIdx}`}>
              {/* The status for whatever action is happening RIGHT NOW — overridden by the next
                  one rather than stacked, because it describes a moment, not the conversation.
                  Italic and dim so it reads as a status line and never competes with a real
                  message above it. */}
              {g.narration && (
                <div style={{ fontSize: 12, color: "var(--text3)", fontStyle: "italic", padding: "0 0 4px", lineHeight: 1.5 }}>
                  <RevealText text={g.narration} animate={animate && g.narrationActive} />
                </div>
              )}
              {rows.length > 0 && (
                <div style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, overflow: "hidden" }}>
                  <button
                    type="button"
                    onClick={() => {
                      if (isOpen) {
                        setClosedLiveSegments((prev) => new Set(prev).add(gi));
                        setOpenSegments((prev) => { const n = new Set(prev); n.delete(gi); return n; });
                      } else {
                        setOpenSegments((prev) => new Set(prev).add(gi));
                        setClosedLiveSegments((prev) => { const n = new Set(prev); n.delete(gi); return n; });
                      }
                    }}
                    style={{
                      display: "flex", width: "100%", alignItems: "center", gap: 6, fontSize: 11.5,
                      color: "var(--text3)", background: "var(--surface2)", border: "none", cursor: "pointer",
                      padding: "5px 8px", textAlign: "left",
                    }}
                  >
                    <span style={{ flex: 1 }}>
                      {segmentHeader(g)}
                      {g.anyActive && <span className="activity-ellipsis">…</span>}
                    </span>
                    <span style={{ fontSize: 10 }}>{isOpen ? "▲" : "▼"}</span>
                  </button>
                  {/* One-column table of every tool call this segment has made so far, plus any
                      thoughts the model had along the way — Claude Code's own table-of-tool-calls
                      view rather than a per-tool-call standalone row. */}
                  {isOpen && (
                    <div>
                      {rows.map(({ type, idx, row }) => {
                        const key = `${gi}-${idx}`;
                        if (type === "tool") {
                          return (
                            <ToolRowView
                              key={key}
                              row={row as ToolRow}
                              isOpen={openRows.has(key)}
                              onToggle={() => toggleRow(key)}
                            />
                          );
                        }
                        return (
                          <ThoughtRowView
                            key={key}
                            row={row as ThoughtRow}
                            isOpen={openRows.has(key)}
                            onToggle={() => toggleRow(key)}
                          />
                        );
                      })}
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
