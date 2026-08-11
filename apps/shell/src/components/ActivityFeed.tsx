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
 * One item in the grouped rendering: either a standalone loop-bookkeeping row (observe/find/gate
 * — not a tool call, no narration) or a SEGMENT of consecutive reason/run activity.
 *
 * A segment is Claude Code's own "the agent talks to me, then runs a tool, then runs another"
 * pattern. Every reasoning turn inside the segment can carry its OWN `say` — a real message the
 * model wrote at that moment, not filler — and each one is kept and rendered in order as a small
 * progress trail, not just the most recent overriding the rest. Discarding everything but the
 * last narration was the actual bug: a long tool-call chain read as silent "tool call after tool
 * call" with nothing telling you what was happening in between, even though the model had been
 * talking the whole time — the messages existed in the trace, they were just being thrown away
 * on the way to the screen. The most recent one is still the visually prominent line (it's what's
 * happening RIGHT NOW); earlier ones render smaller/dimmer above it, like a running log. Every
 * tool call the model has made without yet replying to the user collapses into ONE running
 * summary below the trail. A segment ends the moment the model actually answers (or gives up) —
 * that reply is the message's own bubble, rendered outside this component, not a row here — so
 * the NEXT tool call after an answer starts a genuinely new, separate segment.
 */
type ToolRow = { step: LiveRunStep; active: boolean; idx: number };
type ThoughtRow = { step: LiveRunStep; idx: number };
type NarrationEntry = { text: string; active: boolean; idx: number };
type Grouped =
  | { kind: "plain"; step: LiveRunStep; active: boolean; idx: number }
  | { kind: "segment"; narrations: NarrationEntry[]; tools: ToolRow[]; thoughts: ThoughtRow[]; anyActive: boolean; startIdx: number };

function groupSteps(merged: { step: LiveRunStep; active: boolean }[]): Grouped[] {
  const out: Grouped[] = [];
  let current: Extract<Grouped, { kind: "segment" }> | null = null;
  const closeSegment = () => {
    if (current && (current.tools.length > 0 || current.thoughts.length > 0 || current.narrations.length > 0)) out.push(current);
    current = null;
  };
  merged.forEach(({ step, active }, idx) => {
    if (step.phase === "observe" || step.phase === "find" || step.phase === "gate") {
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
    if (!current) current = { kind: "segment", narrations: [], tools: [], thoughts: [], anyActive: false, startIdx: idx };
    if (step.narration) current.narrations.push({ text: step.narration, active, idx });
    if (step.phase === "reason" && step.thinking) current.thoughts.push({ step, idx });
    if (step.phase === "run") current.tools.push({ step, active, idx });
    if (active) current.anyActive = true;
  });
  closeSegment();
  return out;
}

function segmentHeader(seg: Extract<Grouped, { kind: "segment" }>): string {
  const activeTools = seg.tools.filter((t) => t.active).length;
  const doneTools = seg.tools.length - activeTools;
  const totalTools = seg.tools.length;
  let toolPart: string | null = null;
  if (activeTools > 0 && doneTools === 0) {
    toolPart = `${activeTools} tool${activeTools === 1 ? "" : "s"} running`;
  } else if (totalTools > 0) {
    toolPart = `${totalTools} tool${totalTools === 1 ? "" : "s"}`;
  }
  const thoughtPart = seg.thoughts.length > 0 ? `${seg.thoughts.length} thought${seg.thoughts.length === 1 ? "" : "s"}` : null;
  return [toolPart, thoughtPart].filter(Boolean).join(" · ") || (seg.anyActive ? "Thinking" : "Working");
}

function ToolRowView({
  row, isOpen, onToggle,
}: { row: ToolRow; isOpen: boolean; onToggle: () => void }) {
  const { step, active } = row;
  const failed = step.ok === false;
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
        {step.duration_ms !== undefined && <span style={{ fontSize: 10.5 }}>{step.duration_ms}ms</span>}
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
  const anyNarration = grouped.some((g) => g.kind === "segment" && g.narrations.length > 0);

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
          const rows = [...g.tools.map((t) => ({ type: "tool" as const, idx: t.idx, row: t })), ...g.thoughts.map((t) => ({ type: "thought" as const, idx: t.idx, row: t }))]
            .sort((a, b) => a.idx - b.idx);
          const isOpen = !closedLiveSegments.has(gi) && (g.anyActive || openSegments.has(gi));
          return (
            <div key={`seg-${g.startIdx}`}>
              {/* The full progress trail for this segment — every message the model actually
                  wrote while working, in the order it wrote them, not just the last one. Earlier
                  entries render smaller and dimmer (already-happened context, never animated —
                  they've already been read); the most recent one keeps the original prominent
                  style and is what reveals live, since it's what's happening right now. */}
              {g.narrations.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "0 0 4px" }}>
                  {g.narrations.slice(0, -1).map((n) => (
                    <div key={n.idx} style={{ fontSize: 11.5, color: "var(--text3)", fontStyle: "italic", lineHeight: 1.5 }}>
                      {n.text}
                    </div>
                  ))}
                  {(() => {
                    const last = g.narrations[g.narrations.length - 1]!;
                    return (
                      <div style={{ fontSize: 13, color: "var(--text1)", fontStyle: "italic", lineHeight: 1.5 }}>
                        <RevealText text={last.text} animate={animate && last.active} />
                      </div>
                    );
                  })()}
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
