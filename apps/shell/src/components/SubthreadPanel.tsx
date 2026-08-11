"use client";

// The assistant<->agent consult lane for a project thread (§A1.18 thread model). A project
// thread is the person and whichever agent is working — two visible parties. When the assistant
// needs to talk TO that agent directly (a handoff, a status check), that exchange runs in its own
// subthread rather than being mixed into the visible transcript, where nobody could tell who a
// message was actually addressed to. Collapsed by default (this whole tab is opt-in — you only
// see it if you click "Assistant"), expandable per-subthread so the raw exchange is never truly
// hidden, just not in your way.

import * as React from "react";
import { getMessages, listSubthreads, type Message, type SessionCredentials, type ThreadSummary } from "@/lib/api";

function authorLabel(m: Message): string {
  if (m.author_type === "assistant") return "Assistant";
  if (m.author_type === "agent" && m.author_id) {
    return m.author_id.replace(/^launchpad-/, "").replace(/-v\d+$/, "").replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return m.role === "user" ? "Assistant" : "Agent";
}

/** A DOM id shared between the sidebar's list entry and the inline card the same consult produces
 *  in the main thread transcript — what lets clicking one scroll to and briefly highlight the
 *  other. */
export function consultAnchorId(threadId: string): string {
  return `consult-${threadId}`;
}

/** Scrolls to and briefly highlights an inline consult card in the main transcript — the sidebar's
 *  own "click to jump to where this happened" affordance, since the sidebar list otherwise has no
 *  connection back to the exact turn a consult occurred at. */
function scrollToConsultCard(threadId: string) {
  const el = document.getElementById(consultAnchorId(threadId));
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("consult-highlight");
  window.setTimeout(() => el.classList.remove("consult-highlight"), 1600);
}

// Exported so Chat.tsx can render the SAME expandable card inline in the main transcript, at the
// exact turn where a consult happened (item 79) — not just here in the separate "Assistant" tab,
// which still lists every subthread for a thread regardless of whether it's tied to one message.
// `inline` distinguishes the two call sites: only the SIDEBAR copy (inline=false, the default)
// offers "jump to where this happened in the transcript" — the inline card IS that spot, jumping
// to itself would be a no-op.
export function SubthreadEntry({
  spaceId, thread, session, inline = false,
}: { spaceId: string; thread: ThreadSummary; session: SessionCredentials; inline?: boolean }) {
  const [expanded, setExpanded] = React.useState(false);
  const [messages, setMessages] = React.useState<Message[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && messages === null && thread.session_id) {
      setLoading(true);
      try {
        setMessages(await getMessages(spaceId, thread.session_id, session));
        setFailed(false);
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <div
      id={inline ? consultAnchorId(thread.id) : undefined}
      style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, marginBottom: 8, overflow: "hidden" }}
    >
      <div style={{ display: "flex", alignItems: "center" }}>
        <button
          type="button"
          onClick={() => void toggle()}
          style={{
            flex: 1, display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "8px 10px", background: "transparent", border: "none", cursor: "pointer", fontSize: 13,
          }}
        >
          <span>{thread.title ?? "Consult"}</span>
          <span style={{ color: "var(--text3)" }}>{expanded ? "−" : "+"}</span>
        </button>
        {/* Sidebar-only: jump to the exact turn in the transcript this consult happened at — the
            inline card itself doesn't need a link back to itself. */}
        {!inline && (
          <button
            type="button"
            onClick={() => scrollToConsultCard(thread.id)}
            title="Jump to where this happened"
            style={{ padding: "8px 10px", background: "transparent", border: "none", cursor: "pointer", color: "var(--text3)", fontSize: 12 }}
          >
            ↗
          </button>
        )}
      </div>
      {expanded && (
        <div style={{ padding: "0 10px 10px", fontSize: 12 }}>
          {loading ? (
            <p style={{ color: "var(--text3)" }}>Loading…</p>
          ) : failed ? (
            <p style={{ color: "#dc2626" }}>Couldn&rsquo;t load this exchange.</p>
          ) : !thread.session_id ? (
            <p style={{ color: "var(--text3)" }}>No messages yet.</p>
          ) : (
            (messages ?? []).map((m) => (
              <div key={m.id} style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 600, color: "var(--text3)" }}>{authorLabel(m)}</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function SubthreadPanel({ spaceId, threadId, session }: { spaceId: string; threadId: string; session: SessionCredentials }) {
  const [threads, setThreads] = React.useState<ThreadSummary[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    listSubthreads(spaceId, threadId, session)
      .then((data) => { if (!cancelled) setThreads(data); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
    };
  }, [spaceId, threadId, session]);

  if (failed) {
    return <div className="tp-section" style={{ textTransform: "none", color: "#dc2626" }}>Couldn&rsquo;t load.</div>;
  }
  if (threads === null) {
    return <div className="tp-section" style={{ textTransform: "none", color: "var(--text3)" }}>Loading…</div>;
  }
  if (threads.length === 0) {
    return (
      <div className="tp-section" style={{ textTransform: "none", color: "var(--text3)" }}>
        Nothing yet. Shows up here if the assistant consults an agent about this thread.
      </div>
    );
  }
  return (
    // Scrollable: a busy project can accumulate more consults than fit the sidebar's fixed height.
    <div style={{ maxHeight: 480, overflowY: "auto" }}>
      {threads.map((t) => (
        <SubthreadEntry key={t.id} spaceId={spaceId} thread={t} session={session} />
      ))}
    </div>
  );
}
