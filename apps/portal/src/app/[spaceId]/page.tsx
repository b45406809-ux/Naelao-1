"use client";

// Main end-user chat page for a Space.
// G-A01: Session creation, G-A02: Message history, G-A03: Message send + agent run,
// G-A05: Agent run polling, G-A06: Space branding, G-A07: Ephemeral session storage

import { useEffect, useRef, useState, useCallback } from "react";
import {
  getMessages,
  getSpace,
  pollRun,
  sendMessage,
  startSession,
  type AgentRun,
  type Message,
} from "@/lib/api";
import {
  clearSessionId,
  getOrCreateEndUserId,
  getSessionId,
  storeSessionId,
} from "@/lib/session";

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_DURATION_MS = 60_000;

// ── Sub-components ────────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex items-end gap-2 mb-4">
      <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
        <svg
          className="w-4 h-4 text-indigo-600"
          fill="currentColor"
          viewBox="0 0 20 20"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z"
            clipRule="evenodd"
          />
        </svg>
      </div>
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
      <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
        <svg
          className="w-4 h-4 text-indigo-600"
          fill="currentColor"
          viewBox="0 0 20 20"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z"
            clipRule="evenodd"
          />
        </svg>
      </div>
      <div className="bubble-assistant cursor-blink whitespace-pre-wrap break-words">
        {content}
      </div>
    </div>
  );
}

interface MessageBubbleProps {
  message: Message;
}

function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end mb-4">
        <div className="bubble-user whitespace-pre-wrap break-words">
          {message.content}
        </div>
      </div>
    );
  }

  // assistant / system / tool
  return (
    <div className="flex items-end gap-2 mb-4">
      <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
        <svg
          className="w-4 h-4 text-indigo-600"
          fill="currentColor"
          viewBox="0 0 20 20"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z"
            clipRule="evenodd"
          />
        </svg>
      </div>
      <div className="bubble-assistant whitespace-pre-wrap break-words">
        {message.content}
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

  // Auto-scroll to bottom whenever messages or streaming content change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent, isLoading]);

  // Initialize: load space metadata + get or create session
  useEffect(() => {
    let cancelled = false;

    async function init() {
      setIsInitializing(true);
      setInitError(null);

      try {
        // Load space name (best-effort — don't fail chat if this errors)
        try {
          const space = await getSpace(spaceId);
          if (!cancelled) setSpaceName(space.name ?? "Naelao Space");
        } catch {
          // Non-fatal — use default name
        }

        const endUserId = getOrCreateEndUserId();

        // Check for existing session in sessionStorage
        let sid = getSessionId(spaceId);

        if (!sid) {
          // Create new session
          const session = await startSession(spaceId, endUserId);
          sid = session.id;
          storeSessionId(spaceId, sid);
        }

        if (cancelled) return;
        setSessionId(sid);

        // Load existing messages
        try {
          const existing = await getMessages(spaceId, sid);
          if (!cancelled) setMessages(existing);
        } catch (err) {
          // If session is stale (404), create a fresh one
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("404") || message.includes("not found")) {
            clearSessionId(spaceId);
            const newSession = await startSession(spaceId, endUserId);
            storeSessionId(spaceId, newSession.id);
            if (!cancelled) {
              setSessionId(newSession.id);
              setMessages([]);
            }
          } else {
            throw err;
          }
        }
      } catch (err) {
        if (!cancelled) {
          setInitError(
            err instanceof Error ? err.message : "Failed to connect to Space."
          );
        }
      } finally {
        if (!cancelled) setIsInitializing(false);
      }
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  // Clear polling on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  // Stop polling helper
  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // Handle agent run polling until completion or timeout
  const pollUntilDone = useCallback(
    (sid: string, runId: string) => {
      pollDeadlineRef.current = Date.now() + MAX_POLL_DURATION_MS;

      pollTimerRef.current = setInterval(async () => {
        if (Date.now() > pollDeadlineRef.current) {
          stopPolling();
          setIsLoading(false);
          setStreamingContent("");
          setError("The agent took too long to respond. Please try again.");
          return;
        }

        try {
          const run: AgentRun = await pollRun(spaceId, sid, runId);

          if (run.status === "running") {
            // Still running — if there's partial content, show it
            if (run.final_answer) {
              setStreamingContent(run.final_answer);
            }
            return;
          }

          // Terminal state
          stopPolling();
          setStreamingContent("");
          setIsLoading(false);

          if (run.status === "completed" && run.final_answer) {
            const assistantMsg: Message = {
              id: `msg_${Date.now()}`,
              role: "assistant",
              content: run.final_answer,
              created_at: new Date().toISOString(),
            };
            setMessages((prev) => [...prev, assistantMsg]);
          } else if (run.status === "failed" || run.status === "cancelled") {
            setError(
              run.error ?? "The agent encountered an error. Please try again."
            );
          }
        } catch (err) {
          stopPolling();
          setStreamingContent("");
          setIsLoading(false);
          setError(
            err instanceof Error ? err.message : "Failed to get agent response."
          );
        }
      }, POLL_INTERVAL_MS);
    },
    [spaceId, stopPolling]
  );

  // Submit handler
  const handleSubmit = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading || !sessionId) return;

    setInput("");
    setError(null);
    setIsLoading(true);
    setStreamingContent("");

    // Optimistic user message
    const optimisticMsg: Message = {
      id: `optimistic_${Date.now()}`,
      role: "user",
      content: trimmed,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticMsg]);

    try {
      const { agentRunId } = await sendMessage(spaceId, sessionId, trimmed);
      // Start polling for agent response
      pollUntilDone(sessionId, agentRunId);
    } catch (err) {
      setIsLoading(false);
      setMessages((prev) => prev.filter((m) => m.id !== optimisticMsg.id));
      setError(
        err instanceof Error ? err.message : "Failed to send message."
      );
    }
  }, [input, isLoading, sessionId, spaceId, pollUntilDone]);

  // Handle Enter key (Shift+Enter = newline, Enter = submit)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit]
  );

  // Auto-resize textarea
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInput(e.target.value);
      // Reset height to auto then set to scrollHeight
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
        <div className="text-center">
          <div className="inline-flex items-center gap-2 text-gray-500">
            <svg
              className="animate-spin w-5 h-5 text-indigo-500"
              fill="none"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
              />
            </svg>
            <span className="text-sm">Connecting to Space...</span>
          </div>
        </div>
      </div>
    );
  }

  if (initError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="max-w-md w-full text-center">
          <div className="w-12 h-12 bg-red-100 rounded-xl flex items-center justify-center mx-auto mb-4">
            <svg
              className="w-6 h-6 text-red-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">
            Unable to connect
          </h2>
          <p className="text-sm text-gray-500 mb-4">{initError}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Top bar */}
      <header className="flex-shrink-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3 shadow-sm">
        <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center flex-shrink-0">
          <svg
            className="w-4 h-4 text-white"
            fill="currentColor"
            viewBox="0 0 20 20"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z"
              clipRule="evenodd"
            />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold text-gray-900 truncate">
            {spaceName}
          </h1>
          <p className="text-xs text-gray-400">Powered by Naelao</p>
        </div>
        {isLoading && (
          <div className="flex-shrink-0">
            <svg
              className="animate-spin w-4 h-4 text-indigo-500"
              fill="none"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
              />
            </svg>
          </div>
        )}
      </header>

      {/* Messages */}
      <main className="flex-1 overflow-y-auto px-4 py-6">
        <div className="max-w-2xl mx-auto">
          {messages.length === 0 && !isLoading && (
            <div className="text-center py-16 text-gray-400">
              <svg
                className="w-10 h-10 mx-auto mb-3 text-gray-300"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                />
              </svg>
              <p className="text-sm">
                Send a message to start the conversation.
              </p>
            </div>
          )}

          {messages
            .filter((m) => m.role !== "system" && m.role !== "tool")
            .map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}

          {/* Streaming / loading indicator */}
          {isLoading && streamingContent ? (
            <StreamingBubble content={streamingContent} />
          ) : isLoading ? (
            <TypingIndicator />
          ) : null}

          {/* Error banner */}
          {error && (
            <div className="flex items-start gap-2 mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
              <svg
                className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-500"
                fill="currentColor"
                viewBox="0 0 20 20"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                  clipRule="evenodd"
                />
              </svg>
              <span>{error}</span>
              <button
                type="button"
                onClick={() => setError(null)}
                className="ml-auto text-red-400 hover:text-red-600"
                aria-label="Dismiss error"
              >
                <svg
                  className="w-4 h-4"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </div>
          )}

          {/* Scroll anchor */}
          <div ref={messagesEndRef} />
        </div>
      </main>

      {/* Input bar */}
      <footer className="flex-shrink-0 bg-white border-t border-gray-200 px-4 py-3 shadow-sm">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
              disabled={isLoading || !sessionId}
              rows={1}
              className="flex-1 resize-none rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              style={{ minHeight: "42px", maxHeight: "160px" }}
              aria-label="Message input"
            />
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={isLoading || !input.trim() || !sessionId}
              className="flex-shrink-0 w-10 h-10 bg-indigo-600 text-white rounded-xl flex items-center justify-center hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
              aria-label="Send message"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                />
              </svg>
            </button>
          </div>
          <p className="mt-1.5 text-xs text-gray-400 text-center">
            Responses are AI-generated and may not always be accurate.
          </p>
        </div>
      </footer>
    </div>
  );
}
