"use client";

// G-A01..A07, G-P-SSE, G-P-FB, G-P-I18N
// SSE streaming replaces polling; polling is the fallback if EventSource unavailable.
// Thumbs-up / thumbs-down per assistant message.
// Multi-language via navigator.language.

import { useEffect, useRef, useState, useCallback } from "react";
import {
  getMessages,
  getSpace,
  getStreamUrl,
  pollRun,
  sendMessage,
  startSession,
  submitFeedback,
  type AgentRun,
  type Message,
} from "@/lib/api";
import {
  clearSessionId,
  getOrCreateEndUserId,
  getSessionId,
  storeSessionId,
} from "@/lib/session";
import { getStrings } from "@/lib/i18n";

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_DURATION_MS = 60_000;

// ── Sub-components ────────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex items-end gap-2 mb-4">
      <BotAvatar />
      <div className="bubble-assistant flex items-center gap-0.5 py-3">
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </div>
    </div>
  );
}

function StreamingBubble({ content }: { content: string }) {
  return (
    <div className="flex items-end gap-2 mb-4">
      <BotAvatar />
      <div className="bubble-assistant cursor-blink whitespace-pre-wrap break-words">
        {content}
      </div>
    </div>
  );
}

function BotAvatar() {
  return (
    <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
      <svg className="w-4 h-4 text-indigo-600" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
        <path fillRule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clipRule="evenodd" />
      </svg>
    </div>
  );
}

interface FeedbackButtonsProps {
  messageId: string;
  spaceId: string;
  sessionId: string;
  t: ReturnType<typeof getStrings>;
}

function FeedbackButtons({ messageId, spaceId, sessionId, t }: FeedbackButtonsProps) {
  const [state, setState] = useState<"idle" | "up" | "down" | "done">("idle");

  async function handleFeedback(rating: "up" | "down") {
    if (state !== "idle") return;
    setState(rating);
    try {
      await submitFeedback(spaceId, sessionId, messageId, rating);
      setState("done");
    } catch {
      setState("idle");
    }
  }

  if (state === "done") {
    return <p className="text-xs text-gray-400 mt-1">{t.feedbackThanks}</p>;
  }

  return (
    <div className="flex gap-1 mt-1.5">
      <button
        onClick={() => void handleFeedback("up")}
        disabled={state !== "idle"}
        aria-label={t.thumbsUp}
        className={`text-gray-300 hover:text-green-500 transition-colors disabled:opacity-40 ${state === "up" ? "text-green-500" : ""}`}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5" />
        </svg>
      </button>
      <button
        onClick={() => void handleFeedback("down")}
        disabled={state !== "idle"}
        aria-label={t.thumbsDown}
        className={`text-gray-300 hover:text-red-500 transition-colors disabled:opacity-40 ${state === "down" ? "text-red-500" : ""}`}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14H5.236a2 2 0 01-1.789-2.894l3.5-7A2 2 0 018.736 3h4.018a2 2 0 01.485.06l3.76.94m-7 10v5a2 2 0 002 2h.095c.5 0 .905-.405.905-.904 0-.715.211-1.413.608-2.008L17 13V4m-7 10h2m5-10h2a2 2 0 012 2v6a2 2 0 01-2 2h-2.5" />
        </svg>
      </button>
    </div>
  );
}

interface MessageBubbleProps {
  message: Message;
  spaceId: string;
  sessionId: string;
  t: ReturnType<typeof getStrings>;
}

function MessageBubble({ message, spaceId, sessionId, t }: MessageBubbleProps) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end mb-4">
        <div className="bubble-user whitespace-pre-wrap break-words">{message.content}</div>
      </div>
    );
  }

  return (
    <div className="flex items-end gap-2 mb-4">
      <BotAvatar />
      <div>
        <div className="bubble-assistant whitespace-pre-wrap break-words">{message.content}</div>
        <FeedbackButtons messageId={message.id} spaceId={spaceId} sessionId={sessionId} t={t} />
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

interface ChatPageProps {
  params: { spaceId: string };
}

export default function ChatPage({ params }: ChatPageProps) {
  const { spaceId } = params;
  const t = getStrings();

  const [spaceName, setSpaceName] = useState<string>("Naelao Space");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState("");
  const [initError, setInitError] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollDeadlineRef = useRef<number>(0);
  const sseRef = useRef<EventSource | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent, isLoading]);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      setIsInitializing(true);
      setInitError(null);
      try {
        try {
          const space = await getSpace(spaceId);
          if (!cancelled) setSpaceName(space.name ?? "Naelao Space");
        } catch { /* non-fatal */ }

        const endUserId = getOrCreateEndUserId();
        let sid = getSessionId(spaceId);

        if (!sid) {
          const session = await startSession(spaceId, endUserId);
          sid = session.id;
          storeSessionId(spaceId, sid);
        }

        if (cancelled) return;
        setSessionId(sid);

        try {
          const existing = await getMessages(spaceId, sid);
          if (!cancelled) setMessages(existing);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("404") || msg.includes("not found")) {
            clearSessionId(spaceId);
            const newSession = await startSession(spaceId, endUserId);
            storeSessionId(spaceId, newSession.id);
            if (!cancelled) { setSessionId(newSession.id); setMessages([]); }
          } else {
            throw err;
          }
        }
      } catch (err) {
        if (!cancelled) setInitError(err instanceof Error ? err.message : "Failed to connect to Space.");
      } finally {
        if (!cancelled) setIsInitializing(false);
      }
    }

    void init();
    return () => { cancelled = true; };
  }, [spaceId]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      sseRef.current?.close();
    };
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
  }, []);

  const closeSSE = useCallback(() => {
    sseRef.current?.close();
    sseRef.current = null;
  }, []);

  // SSE-based streaming — G-P-SSE
  const streamRun = useCallback(
    (sid: string, runId: string) => {
      const url = getStreamUrl(spaceId, sid, runId);

      // Check EventSource availability (may not exist in some embedded envs)
      if (typeof EventSource === "undefined") {
        pollUntilDone(sid, runId);
        return;
      }

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
            if (accumulated) {
              setMessages((prev) => [...prev, {
                id: data.run_id ?? `msg_${Date.now()}`,
                role: "assistant",
                content: accumulated,
                created_at: new Date().toISOString(),
              }]);
            }
          } else if (data.type === "error") {
            closeSSE();
            setStreamingContent("");
            setIsLoading(false);
            setError(data.message ?? t.errorRetry);
          }
        } catch { /* malformed SSE chunk — ignore */ }
      };

      es.onerror = () => {
        closeSSE();
        // Fall back to polling if SSE connection drops
        if (accumulated === "") {
          pollUntilDone(sid, runId);
        } else {
          setStreamingContent("");
          setIsLoading(false);
        }
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spaceId, closeSSE, t.errorRetry]
  );

  const pollUntilDone = useCallback(
    (sid: string, runId: string) => {
      pollDeadlineRef.current = Date.now() + MAX_POLL_DURATION_MS;

      pollTimerRef.current = setInterval(async () => {
        if (Date.now() > pollDeadlineRef.current) {
          stopPolling();
          setIsLoading(false);
          setStreamingContent("");
          setError(t.errorRetry);
          return;
        }

        try {
          const run: AgentRun = await pollRun(spaceId, sid, runId);

          if (run.status === "running") {
            if (run.final_answer) setStreamingContent(run.final_answer);
            return;
          }

          stopPolling();
          setStreamingContent("");
          setIsLoading(false);

          if (run.status === "completed" && run.final_answer) {
            setMessages((prev) => [...prev, {
              id: `msg_${Date.now()}`,
              role: "assistant",
              content: run.final_answer!,
              created_at: new Date().toISOString(),
            }]);
          } else if (run.status === "failed" || run.status === "cancelled") {
            setError(run.error ?? t.errorRetry);
          }
        } catch (err) {
          stopPolling();
          setStreamingContent("");
          setIsLoading(false);
          setError(err instanceof Error ? err.message : t.errorRetry);
        }
      }, POLL_INTERVAL_MS);
    },
    [spaceId, stopPolling, t.errorRetry]
  );

  const handleSubmit = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading || !sessionId) return;

    setInput("");
    setError(null);
    setIsLoading(true);
    setStreamingContent("");

    const optimisticMsg: Message = {
      id: `optimistic_${Date.now()}`,
      role: "user",
      content: trimmed,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticMsg]);

    try {
      const { agentRunId } = await sendMessage(spaceId, sessionId, trimmed);
      streamRun(sessionId, agentRunId);
    } catch (err) {
      setIsLoading(false);
      setMessages((prev) => prev.filter((m) => m.id !== optimisticMsg.id));
      setError(err instanceof Error ? err.message : "Failed to send message.");
    }
  }, [input, isLoading, sessionId, spaceId, streamRun]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInput(e.target.value);
      const el = e.target;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    },
    []
  );

  // ── Render ────────────────────────────────────────────────────────────────

  if (isInitializing) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="inline-flex items-center gap-2 text-gray-500">
          <svg className="animate-spin w-5 h-5 text-indigo-500" fill="none" viewBox="0 0 24 24" aria-hidden="true">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          <span className="text-sm">{t.connecting}</span>
        </div>
      </div>
    );
  }

  if (initError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="max-w-md w-full text-center">
          <div className="w-12 h-12 bg-red-100 rounded-xl flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">{t.unableToConnect}</h2>
          <p className="text-sm text-gray-500 mb-4">{initError}</p>
          <button type="button" onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
            {t.tryAgain}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <header className="flex-shrink-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3 shadow-sm">
        <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center flex-shrink-0">
          <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
            <path fillRule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clipRule="evenodd" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold text-gray-900 truncate">{spaceName}</h1>
          <p className="text-xs text-gray-400">{t.poweredBy}</p>
        </div>
        {isLoading && (
          <svg className="animate-spin w-4 h-4 text-indigo-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" aria-hidden="true">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
        )}
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-6">
        <div className="max-w-2xl mx-auto">
          {messages.length === 0 && !isLoading && (
            <div className="text-center py-16 text-gray-400">
              <svg className="w-10 h-10 mx-auto mb-3 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <p className="text-sm">{t.startConversation}</p>
            </div>
          )}

          {messages
            .filter((m) => m.role !== "system" && m.role !== "tool")
            .map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                spaceId={spaceId}
                sessionId={sessionId ?? ""}
                t={t}
              />
            ))}

          {isLoading && streamingContent ? (
            <StreamingBubble content={streamingContent} />
          ) : isLoading ? (
            <TypingIndicator />
          ) : null}

          {error && (
            <div className="flex items-start gap-2 mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
              <svg className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-500" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-600" aria-label={t.dismiss}>
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </main>

      <footer className="flex-shrink-0 bg-white border-t border-gray-200 px-4 py-3 shadow-sm">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={t.sendPlaceholder}
              disabled={isLoading || !sessionId}
              rows={1}
              className="flex-1 resize-none rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              style={{ minHeight: "42px", maxHeight: "160px" }}
              aria-label={t.sendPlaceholder}
            />
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={isLoading || !input.trim() || !sessionId}
              className="flex-shrink-0 w-10 h-10 bg-indigo-600 text-white rounded-xl flex items-center justify-center hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
              aria-label={t.sendButton}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </button>
          </div>
          <p className="mt-1.5 text-xs text-gray-400 text-center">{t.aiDisclaimer}</p>
        </div>
      </footer>
    </div>
  );
}

