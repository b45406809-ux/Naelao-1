"use client";

// Chat surface — ported from apps/portal/src/app/[spaceId]/page.tsx's proven SSE client
// (Three-Tier Platform Model, Phase 6), restyled onto the launchpad-6 mockup's markup/classes
// instead of Tailwind. Thread panel tabs beyond Stats are honest "coming soon" placeholders —
// Tools/Files/Artifacts need their own backend read surfaces this phase doesn't add.

import * as React from "react";
import {
  ApiError,
  getMessages,
  getStreamUrl,
  pollRun,
  sendMessage,
  startSession,
  type AgentRun,
  type Message,
} from "@/lib/api";
import type { SessionCredentials } from "@/lib/api";
import {
  getChatSessionId,
  storeChatSessionId,
  clearChatSessionId,
  getActiveRunId,
  storeActiveRunId,
  clearActiveRunId,
} from "@/lib/chatSession";
import { ContextUsageMeter } from "./ContextUsageMeter";
import { SubthreadPanel } from "./SubthreadPanel";

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_DURATION_MS = 60_000;

type ThreadPanelTab = "stats" | "assistant" | "tools" | "files" | "artifacts";

/** A display name for whoever produced a message, or null when it needs no label.
 *
 *  Deliberately silent for the Space Assistant and for the person typing: labelling every bubble
 *  in an ordinary two-party chat is clutter. The case this exists for is a thread where a named
 *  project agent has also spoken — there, "who said this" is real information. */
function authorLabel(m: Message): string | null {
  if (m.author_type !== "agent" || !m.author_id) return null;
  return m.author_id
    .replace(/^launchpad-/, "")
    .replace(/-v\d+$/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function Chat({
  spaceId,
  session,
  sessionKey = "home",
  title = "New thread",
  supportContact,
  sessionId,
  initialMessage,
  threadId,
}: {
  spaceId: string;
  session: SessionCredentials;
  sessionKey?: string;
  title?: string;
  /** Support URL/mailto shown when an error indicates a credits/billing problem. */
  supportContact?: string | null;
  /** An explicit, already-created session (the /sessions/:id route). When given, this is the
   *  session — the sessionStorage cache is bypassed entirely, so opening a specific conversation
   *  by URL can never resurrect a different one the tab happened to have cached. */
  sessionId?: string;
  /** Sent once, automatically, on mount. Home mints a session from the user's opening line and
   *  hands it over here rather than duplicating the whole chat surface on the landing page. */
  initialMessage?: string;
  /** The structural project-thread id (SpaceDO `threads`), when this Chat renders a project
   *  thread rather than the top-level assistant session. Only threads have an "Assistant" tab —
   *  a Home/assistant session has no separate agent to consult, so there's no second lane to
   *  show (§A1.18 thread model: "this is fine in assistant sessions"). */
  threadId?: string;
}) {
  const [chatSessionId, setChatSessionId] = React.useState<string | null>(sessionId ?? null);
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [input, setInput] = React.useState("");
  const [isLoading, setIsLoading] = React.useState(false);
  const [streamingContent, setStreamingContent] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [initializing, setInitializing] = React.useState(true);
  const [panelOpen, setPanelOpen] = React.useState(true);
  const [panelTab, setPanelTab] = React.useState<ThreadPanelTab>("stats");
  const [lastRun, setLastRun] = React.useState<AgentRun | null>(null);

  const endRef = React.useRef<HTMLDivElement>(null);
  const sseRef = React.useRef<EventSource | null>(null);
  const pollTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const pollDeadlineRef = React.useRef(0);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  // Like Claude's own "new chat" — no session is minted just from landing here. A cached session
  // id (an earlier message already sent in this browser tab) resumes its history; otherwise the
  // composer sits empty and ready, and a session is only created lazily in handleSubmit on the
  // first actual send. This also means Home/a fresh thread never writes a session row purely from
  // being opened — matching the "nothing gets created until the user actually does something"
  // rule the business-first gating in the shell layout depends on.
  React.useEffect(() => {
    let cancelled = false;
    async function init() {
      setInitializing(true);
      setError(null);
      try {
        const sid = sessionId ?? getChatSessionId(spaceId, sessionKey);
        if (!sid) {
          if (!cancelled) {
            setChatSessionId(null);
            setMessages([]);
          }
          return;
        }
        try {
          const existing = await getMessages(spaceId, sid, session);
          if (!cancelled) {
            setChatSessionId(sid);
            setMessages(existing);
          }
        } catch (err) {
          // A stale/invalid cached id (e.g. from a previous bug, or the session genuinely aged
          // out) — drop it and land empty rather than surface a raw error; the next send mints a
          // fresh one exactly like the first-ever visit would.
          if (err instanceof ApiError && err.status === 404 && !sessionId) {
            clearChatSessionId(spaceId, sessionKey);
            if (!cancelled) {
              setChatSessionId(null);
              setMessages([]);
            }
          } else {
            throw err;
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to connect");
      } finally {
        if (!cancelled) setInitializing(false);
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, [spaceId, sessionKey, session, sessionId]);

  React.useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      sseRef.current?.close();
    };
  }, []);

  const stopPolling = React.useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const closeSSE = React.useCallback(() => {
    sseRef.current?.close();
    sseRef.current = null;
  }, []);

  const pollUntilDone = React.useCallback(
    (sid: string, runId: string) => {
      pollDeadlineRef.current = Date.now() + MAX_POLL_DURATION_MS;
      pollTimerRef.current = setInterval(async () => {
        if (Date.now() > pollDeadlineRef.current) {
          stopPolling();
          setIsLoading(false);
          setStreamingContent("");
          setError("Timed out waiting for a response");
          return;
        }
        try {
          const run = await pollRun(spaceId, sid, runId, session);
          setLastRun(run);
          if (run.status === "running") {
            if (run.final_answer) setStreamingContent(run.final_answer);
            return;
          }
          stopPolling();
          setStreamingContent("");
          setIsLoading(false);
          clearActiveRunId(spaceId, sessionKey);
          // awaiting_approval is grouped with completed on purpose: both have something real to
          // say. Without it this status matched no branch at all, so the reply simply vanished —
          // the user saw the spinner stop and nothing appear, with no way to know the agent was
          // waiting on them.
          if ((run.status === "completed" || run.status === "awaiting_approval") && run.final_answer) {
            setMessages((prev) => [
              ...prev,
              { id: `msg_${Date.now()}`, role: "assistant", content: run.final_answer!, created_at: new Date().toISOString() },
            ]);
          } else if (run.status === "failed" || run.status === "cancelled") {
            setError(run.error ?? "The agent run failed");
          }
        } catch (err) {
          stopPolling();
          setStreamingContent("");
          setIsLoading(false);
          clearActiveRunId(spaceId, sessionKey);
          setError(err instanceof Error ? err.message : "Polling failed");
        }
      }, POLL_INTERVAL_MS);
    },
    [spaceId, session, stopPolling]
  );

  const streamRun = React.useCallback(
    // F-17: this must be async — it awaits getStreamUrl (which mints a short-lived stream ticket
    // rather than putting the raw nps_ session token in the EventSource URL). Callers fire it and
    // don't await (starting a stream is fire-and-forget), so the Promise return is intentional.
    async (sid: string, runId: string) => {
      if (typeof EventSource === "undefined") {
        pollUntilDone(sid, runId);
        return;
      }
      const url = await getStreamUrl(spaceId, sid, runId, session);
      const es = new EventSource(url);
      sseRef.current = es;
      let accumulated = "";

      es.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data) as { type: string; content?: string; run_id?: string; message?: string };
          if (data.type === "delta" && data.content) {
            accumulated += data.content;
            setStreamingContent(accumulated);
          } else if (data.type === "done") {
            closeSSE();
            setStreamingContent("");
            setIsLoading(false);
            clearActiveRunId(spaceId, sessionKey);
            setLastRun({ id: data.run_id ?? runId, status: "completed", final_answer: accumulated });
            if (accumulated) {
              setMessages((prev) => [
                ...prev,
                { id: data.run_id ?? `msg_${Date.now()}`, role: "assistant", content: accumulated, created_at: new Date().toISOString() },
              ]);
            }
          } else if (data.type === "error") {
            closeSSE();
            setStreamingContent("");
            setIsLoading(false);
            clearActiveRunId(spaceId, sessionKey);
            setError(data.message ?? "The agent run failed");
          }
        } catch {
          // malformed SSE chunk — ignore
        }
      };

      es.onerror = () => {
        closeSSE();
        if (accumulated === "") {
          pollUntilDone(sid, runId);
        } else {
          setStreamingContent("");
          setIsLoading(false);
        }
      };
    },
    [spaceId, sessionKey, session, closeSSE, pollUntilDone]
  );

  // §A1.27: reattach to an in-flight run on mount (a reload, or a remount from navigating away
  // and back within the same tab) instead of only showing history with no sign a run is still
  // going. Runs once chatSessionId is resolved (i.e. init() above has finished).
  React.useEffect(() => {
    if (!chatSessionId) return;
    const activeRunId = getActiveRunId(spaceId, sessionKey);
    if (!activeRunId) return;
    let cancelled = false;
    (async () => {
      try {
        const run = await pollRun(spaceId, chatSessionId, activeRunId, session);
        if (cancelled) return;
        if (run.status === "running") {
          setIsLoading(true);
          void streamRun(chatSessionId, activeRunId);
        } else {
          // Already resolved while we were away — history (fetched above) already reflects it.
          clearActiveRunId(spaceId, sessionKey);
        }
      } catch {
        // Can't confirm the run's state — leave it be rather than guess; the next send will
        // overwrite the stored id regardless.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- streamRun/session intentionally
    // excluded: this should only re-run when the session actually changes, not on every render
    // streamRun/session identity happens to change.
  }, [chatSessionId, spaceId, sessionKey]);

  const send = React.useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;
    setError(null);
    setIsLoading(true);
    setStreamingContent("");
    const optimistic: Message = { id: `optimistic_${Date.now()}`, role: "user", content: trimmed, created_at: new Date().toISOString() };
    setMessages((prev) => [...prev, optimistic]);
    try {
      // Lazy session creation: the very first send in a fresh thread/Home mints the session here,
      // not on mount — mirrors Claude's own "/new" behavior and means a session only ever exists
      // once there's a real message to attach it to.
      let sid = chatSessionId;
      if (!sid) {
        const started = await startSession(spaceId, session);
        sid = started.id;
        storeChatSessionId(spaceId, sid, sessionKey);
        setChatSessionId(sid);
      }
      const { agentRunId } = await sendMessage(spaceId, sid, trimmed, session);
      storeActiveRunId(spaceId, agentRunId, sessionKey);
      streamRun(sid, agentRunId);
    } catch (err) {
      setIsLoading(false);
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setError(err instanceof Error ? err.message : "Failed to send message");
    }
  }, [isLoading, chatSessionId, spaceId, sessionKey, session, streamRun]);

  const handleSubmit = React.useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setInput("");
    await send(trimmed);
  }, [input, send]);

  // Home hands its opening line over here rather than duplicating the chat surface on the landing
  // page. Guarded by a ref, not just the empty-history check: React 18 StrictMode double-invokes
  // effects in development, and "send the user's first message twice" is not a dev-only annoyance
  // — it would bill two real agent runs.
  const initialSentRef = React.useRef(false);
  React.useEffect(() => {
    if (!initialMessage || initializing || initialSentRef.current) return;
    if (messages.length > 0) return;
    initialSentRef.current = true;
    void send(initialMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once when the surface is ready.
  }, [initialMessage, initializing]);

  if (initializing) {
    return (
      <div className="home-view">
        <span style={{ color: "var(--text3)", fontSize: 13 }}>Connecting…</span>
      </div>
    );
  }

  return (
    <div className="chat-layout">
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div className="topbar">
          <div className="topbar-left">
            <span className="chat-title">{title}</span>
          </div>
          <div className="topbar-actions">
            <button className="icon-btn" type="button" onClick={() => setPanelOpen((v) => !v)} title="Toggle panel">
              <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor">
                <rect x="2" y="2" width="12" height="12" rx="2" />
                <line x1="10" y1="2" x2="10" y2="14" />
              </svg>
            </button>
          </div>
        </div>

        <div className="chat-area">
          {messages
            .filter((m) => m.role !== "system" && m.role !== "tool")
            .map((m) => (
              <div key={m.id} className={["msg-row", m.role === "user" ? "user" : ""].filter(Boolean).join(" ")}>
                {m.role !== "user" && (
                  <div className="ai-icon">
                    <svg viewBox="0 0 14 14">
                      <path d="M7 1L12.5 4.25V10.75L7 14L1.5 10.75V4.25L7 1Z" />
                    </svg>
                  </div>
                )}
                <div style={{ minWidth: 0 }}>
                  {/* Only for a NAMED agent. The Space Assistant is the default voice of this
                      surface and labelling every one of its replies is noise; a project agent
                      speaking in the same thread is the case worth distinguishing. */}
                  {authorLabel(m) && (
                    <div style={{ fontSize: 11.5, color: "var(--text3)", marginBottom: 3, fontWeight: 600 }}>
                      {authorLabel(m)}
                    </div>
                  )}
                  <div className={["bubble", m.role === "user" ? "user" : ""].filter(Boolean).join(" ")}>{m.content}</div>
                </div>
              </div>
            ))}

          {isLoading && streamingContent && (
            <div className="msg-row">
              <div className="ai-icon">
                <svg viewBox="0 0 14 14">
                  <path d="M7 1L12.5 4.25V10.75L7 14L1.5 10.75V4.25L7 1Z" />
                </svg>
              </div>
              <div className="bubble">{streamingContent}</div>
            </div>
          )}
          {isLoading && !streamingContent && (
            <div className="msg-row">
              <div className="ai-icon">
                <svg viewBox="0 0 14 14">
                  <path d="M7 1L12.5 4.25V10.75L7 14L1.5 10.75V4.25L7 1Z" />
                </svg>
              </div>
              <div className="bubble typing-indicator">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </div>
            </div>
          )}
          {error && (
            <div className="msg-row">
              <div className="bubble" style={{ color: "#dc2626" }}>
                {error}
                {/* Show support contact for billing/credit errors so a stuck user always has
                    a path to a human — driven by manifest.legal.support_contact. */}
                {supportContact && (error.includes("credit") || error.includes("subscri") || error.includes("quota") || error.includes("402")) && (
                  <span style={{ display: "block", marginTop: 6, fontSize: "0.85em" }}>
                    Need help?{" "}
                    <a href={supportContact} style={{ color: "#dc2626", textDecoration: "underline" }}>
                      Contact support
                    </a>
                  </span>
                )}
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        <div className="chat-input-area">
          <div className="input-container">
            <div className="input-top">
              <textarea
                className="msg-input"
                placeholder="Message…"
                value={input}
                disabled={isLoading}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSubmit();
                  }
                }}
                rows={1}
              />
              {/* No chatSessionId gate here — a fresh thread/Home has none yet by design
                  (lazy creation), and the input must stay usable so the first send can mint one. */}
              <button className="send-btn" type="button" disabled={isLoading || !input.trim()} onClick={() => void handleSubmit()}>
                <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              </button>
            </div>
          </div>
          <p className="disclaimer">AI-generated responses may be inaccurate.</p>
        </div>
      </div>

      {panelOpen && (
        <div className="thread-panel">
          <div className="tp-header">
            <span className="tp-header-title">Thread</span>
          </div>
          <div className="tp-tabs">
            {(["stats", ...(threadId ? (["assistant"] as ThreadPanelTab[]) : []), "tools", "files", "artifacts"] as ThreadPanelTab[]).map((tab) => (
              <button
                key={tab}
                type="button"
                className={["tp-tab", panelTab === tab ? "active" : ""].filter(Boolean).join(" ")}
                onClick={() => setPanelTab(tab)}
              >
                {tab[0]!.toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>
          <div className="tp-body">
            {panelTab === "assistant" && threadId && (
              <SubthreadPanel spaceId={spaceId} threadId={threadId} session={session} />
            )}
            {panelTab === "stats" && (
              <>
                <div className="tp-stat">
                  <span className="tp-stat-label">Session</span>
                  <span className="tp-stat-val">{chatSessionId?.slice(0, 8) ?? "—"}</span>
                </div>
                <div className="tp-stat">
                  <span className="tp-stat-label">Messages</span>
                  <span className="tp-stat-val">{messages.length}</span>
                </div>
                <div className="tp-stat">
                  <span className="tp-stat-label">Last run</span>
                  <span className={["tp-stat-val", lastRun?.status === "completed" ? "green" : lastRun?.status === "failed" ? "amber" : ""].filter(Boolean).join(" ")}>
                    {lastRun?.status ?? "—"}
                  </span>
                </div>
                <ContextUsageMeter
                  spaceId={spaceId}
                  sessionId={chatSessionId}
                  session={session}
                  refreshKey={messages.length}
                />
              </>
            )}
            {panelTab !== "stats" && panelTab !== "assistant" && (
              <div className="tp-section" style={{ textTransform: "none", color: "var(--text3)" }}>
                Coming soon.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
