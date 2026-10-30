"use client";

// Home — a start-here page, not a chat window. Typing a line and pressing Enter mints a session
// and opens it, exactly like claude.com/new; recent conversations sit underneath so returning
// lands you back in your work rather than staring at an empty box.
//
// A session is still only created on a real submit — never from opening this page — which is what
// keeps the "nothing exists until the user actually does something" rule the
// gating depends on.

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import { listSessions, startSession, type SessionSummary } from "@/lib/api";
import { relativeTime } from "@/lib/relativeTime";
import { ComposerDock } from "@/components/ComposerDock";
import { getPreferredModel, storePreferredModel, getPreferredEffort, storePreferredEffort } from "@/lib/modelPreference";
import { DEFAULT_WORKING_MODEL, nativeReasoningForEffort, isValidEffortLevel, type EffortLevel } from "@naelao/billing-core";

/** Openers for the active Space's work and projects, grounded in what the assistant can access. */
/** Recent conversations shown on Home. This is the landing page, so the list is the main way back
 *  into yesterday's work — eight was short enough to hide a conversation from one busy morning. */
const HOME_RECENT_SESSIONS = 20;

const STARTERS = [
  "What's happening in this Space right now?",
  "What should I work on first this week?",
  "Draft a message to my customers",
  "Find something I could be doing better",
];

/** Icon quick-chips (launchpad mockup's insertPrompt row) — PREFILL the input rather than send
 *  immediately, unlike the full-sentence STARTERS above. A real, distinct affordance (fill-then-
 *  edit) rather than a second row that does the same thing a different way. */
const QUICK_PROMPTS: Array<{ label: string; prompt: string; icon: React.ReactNode }> = [
  {
    label: "Run agent",
    prompt: "Run an agent to ",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor"><rect x="3" y="3" width="10" height="10" rx="2" /><path d="M6 6L10 8L6 10V6Z" /></svg>
    ),
  },
  {
    label: "Web search",
    prompt: "Search the web for ",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor"><circle cx="7" cy="7" r="4.5" /><line x1="10.5" y1="10.5" x2="14" y2="14" /></svg>
    ),
  },
  {
    label: "Help me write",
    prompt: "Help me write ",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor"><path d="M11 2L14 5L5 14H2V11L11 2Z" /></svg>
    ),
  },
  {
    label: "Analyze data",
    prompt: "Analyze this data: ",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor"><rect x="2" y="10" width="3" height="4" /><rect x="6.5" y="6" width="3" height="8" /><rect x="11" y="2" width="3" height="12" /></svg>
    ),
  },
];

export default function HomePage() {
  const product = useProduct();
  const router = useRouter();
  const { activeSpaceId, activeSpaceName, isChildSpace } = useActiveSpace();
  const { session } = useProductAuth();

  const [input, setInput] = React.useState("");
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // The model choice made here is the same per-space preference the chat itself reads, so picking
  // one before the first message carries straight into the session it mints.
  const [dockModel, setDockModel] = React.useState<string>(() => getPreferredModel(activeSpaceId) ?? DEFAULT_WORKING_MODEL);
  const [dockEffort, setDockEffort] = React.useState<EffortLevel>(() => {
    const model = getPreferredModel(activeSpaceId) ?? DEFAULT_WORKING_MODEL;
    const stored = getPreferredEffort(activeSpaceId, model);
    return stored && isValidEffortLevel(model, stored) ? (stored as EffortLevel) : "low";
  });
  const dockReasoning = React.useMemo(() => nativeReasoningForEffort(dockModel, dockEffort), [dockModel, dockEffort]);
  const [dockNotice, setDockNotice] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  function insertPrompt(prompt: string) {
    setInput(prompt);
    inputRef.current?.focus();
  }

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  React.useEffect(() => {
    if (!creds) return;
    listSessions(activeSpaceId, creds, HOME_RECENT_SESSIONS).then(setSessions).catch(() => setSessions([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, session]);

  async function start(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !creds || starting) return;
    setStarting(true);
    setError(null);
    try {
      // Title the session from its opening line — SpaceDO has no title column, so this rides in
      // metadata and is what makes the sidebar/recent list readable instead of a wall of ids.
      const created = await startSession(activeSpaceId, creds, trimmed.slice(0, 80));
      window.dispatchEvent(new CustomEvent("naelao:session-created", { detail: { spaceId: activeSpaceId, sessionId: created.id } }));
      router.push(`/p/${product.slug}/sessions/${created.id}?q=${encodeURIComponent(trimmed)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start a conversation");
      setStarting(false);
    }
  }

  if (!session) return null;

  const greeting = isChildSpace && activeSpaceName ? activeSpaceName : product.product_name;

  // Layout comes from `.home-view` (packages/ui/src/styles.css), which centres via auto-margin
  // pseudo-elements so the content starts at the TOP once it is taller than the viewport rather
  // than overflowing past the start edge where it cannot be scrolled to. These properties used to
  // be repeated inline — and an inline `justifyContent: "center"` beats any stylesheet rule, which
  // is why the heading was cut off on a phone (measured live: computed justify-content stayed
  // `center` even after the stylesheet said otherwise). The inline padding likewise overrode the
  // mobile padding in the media query.
  return (
    <div className="home-view" style={{ gap: 0 }}>
      <button
        type="button"
        className="home-mobile-menu-btn"
        aria-label="Open menu"
        title="Open menu"
        onClick={() => window.dispatchEvent(new CustomEvent("naelao:toggle-mobile-nav"))}
      >
        <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor">
          <line x1="2" y1="4" x2="14" y2="4" />
          <line x1="2" y1="8" x2="14" y2="8" />
          <line x1="2" y1="12" x2="14" y2="12" />
        </svg>
      </button>
      <div style={{ width: "100%", maxWidth: 680 }}>
        <h1 style={{ fontSize: 27, fontWeight: 650, margin: 0, textAlign: "center" }}>{greeting}</h1>
        <p style={{ fontSize: 14, color: "var(--text3)", marginTop: 8, textAlign: "center" }}>
          What do you want to get done?
        </p>

        {creds && (
          <div style={{ marginTop: 26, width: "100%", display: "flex", justifyContent: "center" }}>
            <ComposerDock
              spaceId={activeSpaceId}
              session={creds}
              model={dockModel}
              reasoningLevel={dockReasoning}
              onModelChange={(m) => {
                setDockModel(m);
                storePreferredModel(activeSpaceId, m);
                const stored = getPreferredEffort(activeSpaceId, m);
                setDockEffort(stored && isValidEffortLevel(m, stored) ? (stored as EffortLevel) : "low");
              }}
              effort={dockEffort}
              onEffortChange={(effort) => {
                setDockEffort(effort);
                storePreferredEffort(activeSpaceId, dockModel, effort);
              }}
              spaceName={activeSpaceName ?? undefined}
              isChildSpace={isChildSpace}
              onNotice={(msg) => {
                setDockNotice(msg);
                window.setTimeout(() => setDockNotice((cur) => (cur === msg ? null : cur)), 4000);
              }}
              onUseTip={(text) => insertPrompt(text)}
              onDictation={(text) => setInput((current) => `${current}${current && !/\s$/.test(current) ? " " : ""}${text}`)}
            >
              <div className="input-container">
                <div className="input-top">
                  <textarea
                    ref={inputRef}
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
            </ComposerDock>
          </div>
        )}
        {dockNotice && (
          <p style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 8, textAlign: "center" }}>{dockNotice}</p>
        )}

        {error && (
          <p role="alert" style={{ fontSize: 12.5, color: "#dc2626", marginTop: 12, textAlign: "center" }}>
            {error}
          </p>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14, justifyContent: "center" }}>
          {QUICK_PROMPTS.map((q) => (
            <button
              key={q.label}
              type="button"
              disabled={starting}
              onClick={() => insertPrompt(q.prompt)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 12px",
                borderRadius: 999,
                border: "1px solid var(--border)",
                background: "var(--surface2)",
                color: "var(--text2)",
                fontSize: 12,
                cursor: starting ? "default" : "pointer",
              }}
            >
              <span style={{ width: 13, height: 13, display: "flex" }}>{q.icon}</span>
              {q.label}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10, justifyContent: "center" }}>
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
