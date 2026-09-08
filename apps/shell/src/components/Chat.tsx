import React, { useState, useEffect, useRef } from "react";
import { GenerativeWidget } from "./ui/GenerativeWidget";
import type { DynamicUiWidget } from "@avos/types";

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  uiWidget?: DynamicUiWidget;
}

export function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "1",
      role: "assistant",
      content: "Hello! I am your Naelao Proactive Agent. I can stream interactive widgets right into our conversation.",
      uiWidget: {
        type: "dynamic_ui",
        component: "BookingSlotPicker",
        props: { title: "Schedule Initial Consultation", slots: ["10:00 AM", "01:00 PM", "03:30 PM"] },
        callbackId: "cb_consultation_123",
      },
    },
  ]);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const handleUiAction = (event: Event) => {
      const customEvent = event as CustomEvent;
      const { callbackId, action, data } = customEvent.detail;
      
      // Append user confirmation message back into chat stream
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: "user",
          content: `[UI Action Submitted] ${action} (${callbackId}): ${JSON.stringify(data)}`,
        },
        {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: `Received your selection for ${action}. Processing request...`,
        },
      ]);
    };

    window.addEventListener("mcp:ui_action", handleUiAction);
    return () => window.removeEventListener("mcp:ui_action", handleUiAction);
  }, []);

  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      content: input,
    };

    setMessages((prev) => [...prev, userMsg]);
    const currentInput = input;
    setInput("");

    // Simulate agent response with generative widget based on prompt
    setTimeout(() => {
      let widget: DynamicUiWidget | undefined;
      if (currentInput.toLowerCase().includes("card") || currentInput.toLowerCase().includes("confirm")) {
        widget = {
          type: "dynamic_ui",
          component: "ActionCard",
          props: { title: "Confirm Deployment", description: "Deploy workspace to production cluster?", confirmText: "Deploy Now" },
          callbackId: `cb_deploy_${Date.now()}`,
        };
      } else if (currentInput.toLowerCase().includes("decision")) {
        widget = {
          type: "dynamic_ui",
          component: "DecisionTable",
          props: { options: [{ id: "tier1", label: "Standard Tier ($10)" }, { id: "tier2", label: "Enterprise Tier ($50)" }] },
          callbackId: `cb_decision_${Date.now()}`,
        };
      }

      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 2).toString(),
          role: "assistant",
          content: widget ? "Here is the interactive widget you requested:" : `Processed your query: "${currentInput}"`,
          uiWidget: widget,
        },
      ]);
    }, 750);
  };

  return (
    <div className="flex flex-col h-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Naelao Agent Session (MCP-UI Enabled)</h3>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm ${
                msg.role === "user"
                  ? "bg-blue-600 text-white rounded-br-sm"
                  : "bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100 rounded-bl-sm shadow-sm"
              }`}
            >
              <p className="whitespace-pre-wrap">{msg.content}</p>
            </div>
            {msg.uiWidget && (
              <div className="mt-2">
                <GenerativeWidget widget={msg.uiWidget} />
              </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={sendMessage} className="p-3 border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask Naelao (try 'card', 'decision', or booking)..."
          className="flex-1 bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-xl px-4 py-2.5 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="submit"
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
        >
          Send
        </button>
      </form>
    </div>
  );
}
export default Chat;
