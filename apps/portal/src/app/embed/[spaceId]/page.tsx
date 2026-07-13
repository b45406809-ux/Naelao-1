'use client';

export const runtime = "edge";

import { useParams } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import { startSession, sendMessage, pollRun, getMessages } from "@/lib/api";
import type { Message } from "@/lib/api";
import { getSessionId, storeSessionId, getOrCreateEndUserId } from "@/lib/session";

export default function EmbedChatPage() {
  const params = useParams<{ spaceId: string }>();
  const spaceId = params.spaceId;

  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!spaceId) return;
    let stored = getSessionId(spaceId);
    if (stored) {
      setSessionId(stored);
      getMessages(spaceId, stored)
        .then(setMessages)
        .catch(() => setMessages([]));
    } else {
      const endUserId = getOrCreateEndUserId();
      startSession(spaceId, endUserId)
        .then((s) => {
          storeSessionId(spaceId, s.id);
          setSessionId(s.id);
        })
        .catch(() => setError("Failed to start session"));
    }
  }, [spaceId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  async function handleSend() {
    if (!input.trim() || !sessionId || isLoading) return;
    const text = input.trim();
    setInput("");
    setError(null);

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);

    try {
      const { agentRunId } = await sendMessage(spaceId, sessionId, text);
      let elapsed = 0;
      while (elapsed < 60_000) {
        await new Promise((r) => setTimeout(r, 1500));
        elapsed += 1500;
        const run = await pollRun(spaceId, sessionId, agentRunId);
        if (run.status !== "running") {
          if (run.status === "completed" && run.final_answer) {
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: run.final_answer!,
                created_at: new Date().toISOString(),
              },
            ]);
          } else {
            setError(run.error ?? "Agent failed");
          }
          break;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="flex flex-col h-screen bg-white">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.filter((m) => m.role === "user" || m.role === "assistant").map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={
                msg.role === "user"
                  ? "bg-indigo-600 text-white rounded-2xl rounded-br-sm px-3 py-2 text-sm max-w-xs"
                  : "bg-gray-100 text-gray-900 rounded-2xl rounded-bl-sm px-3 py-2 text-sm max-w-xs"
              }
            >
              {msg.content}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 text-gray-500 rounded-2xl rounded-bl-sm px-3 py-2 text-sm">
              <span className="animate-pulse">···</span>
            </div>
          </div>
        )}
        {error && <p className="text-center text-xs text-red-500">{error}</p>}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-200 p-2 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSend(); } }}
          placeholder="Type a message…"
          disabled={!sessionId || isLoading}
          className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-50"
        />
        <button
          onClick={() => void handleSend()}
          disabled={!input.trim() || !sessionId || isLoading}
          className="bg-indigo-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
