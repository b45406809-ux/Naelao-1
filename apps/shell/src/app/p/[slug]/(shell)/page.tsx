"use client";

export const runtime = "edge";

// Home — a start-here page, not a chat window. Typing a line and pressing Enter mints a session
// and opens it, exactly like claude.com/new; recent conversations sit underneath so returning
// lands you back in your work rather than staring at an empty box.
//
// A session is still only created on a real submit — never from opening this page — which is what
// keeps the "nothing exists until the user actually does something" rule the business-first
// gating depends on.

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import { listSessions, startSession, getOnboarding, type SessionSummary } from "@/lib/api";
import { relativeTime } from "@/lib/relativeTime";

/** Openers that reflect what this assistant is actually for — running the business — rather than
 *  generic "ask me anything" filler. Every one is answerable from what it can already see. */
const STARTERS = [
  "How is my business doing right now?",
  "What should I work on first this week?",
  "Draft a message to my customers",
  "Find something I could be doing better",
];

export default function HomePage() {
  const product = useProduct();
  const router = useRouter();
  const { activeSpaceId, activeSpaceName, isBusinessSpace } = useActiveSpace();
  const { session } = useProductAuth();

  const [input, setInput] = React.useState("");
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [setupPending, setSetupPending] = React.useState(false);

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  React.useEffect(() => {
    if (!creds) return;
    listSessions(activeSpaceId, creds, 8).then(setSessions).catch(() => setSessions([]));
    // Unfinished setup is worth surfacing here rather than only on the business page: this is
    // where someone lands, and an assistant that hasn't been connected to anything yet will give
    // disappointing answers for reasons the user can't see.
    if (isBusinessSpace) {
      getOnboarding(activeSpaceId, creds)
        .then((o) => setSetupPending(o.status !== "complete" && o.prompts.some((p) => !p.satisfied)))
        .catch(() => setSetupPending(false));
    } else {
      setSetupPending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, session, isBusinessSpace]);

  async function start(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !creds || starting) return;
    setStarting(true);
    setError(null);
    try {
      // Title the session from its opening line — SpaceDO has no title column, so this rides in
      // metadata and is what makes the sidebar/recent list readable instead of a wall of ids.
      const created = await startSession(activeSpaceId, creds, trimmed.slice(0, 80));
      router.push(`/p/${product.slug}/sessions/${created.id}?q=${encodeURIComponent(trimmed)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start a conversation");
      setStarting(false);
    }
  }

  if (!session) return null;

  const greeting = isBusinessSpace && activeSpaceName ? activeSpaceName : product.product_name;

  return (
    <div className="home-view" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "48px 24px", gap: 0 }}>
      <div style={{ width: "100%", maxWidth: 680 }}>
        <h1 style={{ fontSize: 27, fontWeight: 650, margin: 0, textAlign: "center" }}>{greeting}</h1>
        <p style={{ fontSize: 14, color: "var(--text3)", marginTop: 8, textAlign: "center" }}>
          What do you want to get done?
        </p>

        {setupPending && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
              marginTop: 22,
              padding: "11px 14px",
              borderRadius: 10,
              background: "var(--accent-soft, #eef2ff)",
              border: "1px solid var(--accent, #5b52f0)",
              fontSize: 12.5,
            }}
          >
            <span>Setup isn&rsquo;t finished, so your assistant can&rsquo;t see your business yet.</span>
            <Link href={`/p/${product.slug}/spaces/${activeSpaceId}/onboarding`} style={{ color: "var(--accent)", fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>
              Finish setup →
            </Link>
          </div>
        )}

        <div className="input-container" style={{ marginTop: 26 }}>
          <div className="input-top">
            <textarea
              className="msg-input"
              placeholder="Ask your assistant anything…"
              value={input}
              disabled={starting}
              autoFocus
              rows={1}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void start(input);
                }
              }}
            />
            <button className="send-btn" type="button" disabled={starting || !input.trim()} onClick={() => void start(input)}>
              <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </button>
          </div>
        </div>

        {error && (
          <p role="alert" style={{ fontSize: 12.5, color: "#dc2626", marginTop: 12, textAlign: "center" }}>
            {error}
          </p>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16, justifyContent: "center" }}>
          {STARTERS.map((s) => (
            <button
              key={s}
              type="button"
              disabled={starting}
              onClick={() => void start(s)}
              style={{
                padding: "7px 13px",
                borderRadius: 999,
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text2)",
                fontSize: 12.5,
                cursor: starting ? "default" : "pointer",
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {sessions.length > 0 && (
          <div style={{ marginTop: 40 }}>
            <div className="section-label">Recent</div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              {sessions.map((s) => (
                <Link
                  key={s.id}
                  href={`/p/${product.slug}/sessions/${s.id}`}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 2px",
                    textDecoration: "none",
                    color: "var(--text1)",
                    fontSize: 13.5,
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.title ?? "Untitled conversation"}
                  </span>
                  <span style={{ color: "var(--text3)", fontSize: 12, whiteSpace: "nowrap" }}>{relativeTime(s.updated_at)}</span>
                </Link>
              ))}
            </div>
            <Link
              href={`/p/${product.slug}/sessions`}
              style={{ display: "inline-block", marginTop: 12, fontSize: 12.5, color: "var(--text3)", textDecoration: "none" }}
            >
              All sessions →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
