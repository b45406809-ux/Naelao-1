"use client";

// Chat surface — ported from apps/portal/src/app/[spaceId]/page.tsx's proven SSE client
// (Three-Tier Platform Model, Phase 6), restyled onto the launchpad-6 mockup's markup/classes
// instead of Tailwind. Thread panel tabs beyond Stats are honest "coming soon" placeholders —
// Tools/Files/Artifacts need their own backend read surfaces this phase doesn't add.

import * as React from "react";
import {
  getMessages,
  getStreamUrl,
  pollRun,
  sendMessage,
  startSession,
  type AgentRun,
  type Message,
} from "@/lib/api";
import type { SessionCredentials } from "@/lib/api";
import { getChatSessionId, storeChatSessionId, clearChatSessionId } from "@/lib/chatSession";

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_DURATION_MS = 60_000;

type ThreadPanelTab = "stats" | "tools" | "files" | "artifacts";

export function Chat({
  spaceId,
  session,
  sessionKey = "home",
  title = "New thread",
  supportContact,
}: {
  spaceId: string;
  session: SessionCredentials;
  sessionKey?: string;
  title?: string;
  /** Support URL/mailto shown when an error indicates a credits/billing problem. */
  supportContact?: string | null;
}) {
  const [chatSessionId, setChatSessionId] = React.useState<string | null>(null);
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

  React.useEffect(() => {
    let cancelled = false;
    async function init() {
      setInitializing(true);
      setError(null);
      try {
        let sid = getChatSessionId(spaceId, sessionKey);
        if (!sid) {
          const started = await startSession(spaceId, session);
          sid = started.id;
          storeChatSessionId(spaceId, sid, sessionKey);
        }
        if (cancelled) return;
        setChatSessionId(sid);
        try {
          const existing = await getMessages(spaceId, sid, session);
          if (!cancelled) setMessages(existing);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("404") || msg.includes("not_found")) {
            clearChatSessionId(spaceId, sessionKey);
            const fresh = await startSession(spaceId, session);
            storeChatSessionId(spaceId, fresh.id, sessionKey);
            if (!cancelled) {
              setChatSessionId(fresh.id);
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
  }, [spaceId, sessionKey, session]);

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
          if (run.status === "completed" && run.final_answer) {
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
          setError(err instanceof Error ? err.message : "Polling failed");
        }
      }, POLL_INTERVAL_MS);
    },
    [spaceId, session, stopPolling]
  );

  const streamRun = React.useCallback(
    (sid: string, runId: string) => {
      if (typeof EventSource === "undefined") {
        pollUntilDone(sid, runId);
        return;
      }
      const url = getStreamUrl(spaceId, sid, runId, session);
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
    [spaceId, session, closeSSE, pollUntilDone]
  );

  const handleSubmit = React.useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading || !chatSessionId) return;
    setInput("");
    setError(null);
    setIsLoading(true);
    setStreamingContent("");
    const optimistic: Message = { id: `optimistic_${Date.now()}`, role: "user", content: trimmed, created_at: new Date().toISOString() };
    setMessages((prev) => [...prev, optimistic]);
    try {
      const { agentRunId } = await sendMessage(spaceId, chatSessionId, trimmed, session);
      streamRun(chatSessionId, agentRunId);
    } catch (err) {
      setIsLoading(false);
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setError(err instanceof Error ? err.message : "Failed to send message");
    }
  }, [input, isLoading, chatSessionId, spaceId, session, streamRun]);

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
                <div className={["bubble", m.role === "user" ? "user" : ""].filter(Boolean).join(" ")}>{m.content}</div>
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
                disabled={isLoading || !chatSessionId}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSubmit();
                  }
                }}
                rows={1}
              />
              <button className="send-btn" type="button" disabled={isLoading || !input.trim() || !chatSessionId} onClick={() => void handleSubmit()}>
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
            {(["stats", "tools", "files", "artifacts"] as ThreadPanelTab[]).map((tab) => (
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
              </>
            )}
            {panelTab !== "stats" && (
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
