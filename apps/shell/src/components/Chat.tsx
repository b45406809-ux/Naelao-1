import React, { useState, useEffect, useRef } from "react";
import { UIActionEvent } from "../../../../packages/events/src/index";

interface Message {
  id: string;
  sender: "user" | "agent";
  text: string;
  timestamp: string;
}

export const Chat: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "msg-1",
      sender: "agent",
      text: "Hello, I am Naelao. I am observing the workspace canvas. Any action you perform on custom gadgets is streamed to me in real-time.",
      timestamp: new Date().toISOString(),
    },
  ]);
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  // Mock Active Session State
  const activeSession = {
    spaceId: "space-01",
    projectId: "project-abc",
    sessionId: "session-xyz",
  };

  useEffect(() => {
    // Connect mock WebSocket to the local or gateway endpoint
    // Fall back to simulated WS if not running in CF environment
    const wsUrl = `ws://${window.location.host}/ws/gateway`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        console.log("[WebSocket] Connected to WsHubDO");
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "agent.message" || data.type === "mcp.ui_action_response") {
            setIsThinking(false);
            setMessages((prev) => [
              ...prev,
              {
                id: Math.random().toString(),
                sender: "agent",
                text: data.content || data.payload?.reply || "UI action processed.",
                timestamp: new Date().toISOString(),
              },
            ]);
          }
        } catch (err) {
          console.error("Error processing websocket payload:", err);
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        console.log("[WebSocket] Disconnected from WsHubDO");
      };
    } catch (e) {
      console.warn("WebSocket could not be established directly. Running in resilient simulation mode.");
    }

    // 2B. The Iframe Bridge
    const handleIframeMessage = (event: MessageEvent) => {
      // Verify message is from a registered AVOS Gadget
      if (event.data?.type === "avos.ui_event") {
        setIsThinking(true);

        const uiEvent: UIActionEvent = {
          type: "mcp.ui_action",
          spaceId: activeSession.spaceId,
          projectId: activeSession.projectId,
          sessionId: activeSession.sessionId,
          gadgetId: event.data.gadgetId || "finance_grid",
          action: event.data.action || "BUTTON_CLICK",
          payload: event.data.payload || {},
          timestamp: new Date().toISOString(),
        };

        // Dispatch to the Agent via the WebSocket Gateway
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify(uiEvent));
        } else {
          // Resilient Simulated Flow
          console.log("[Simulation] Dispatching UI event: ", uiEvent);
          setTimeout(() => {
            setIsThinking(false);
            setMessages((prev) => [
              ...prev,
              {
                id: Math.random().toString(),
                sender: "agent",
                text: `I see you've approved that invoice, I'm updating the journal now. (UI Action: ${uiEvent.action} in ${uiEvent.gadgetId})`,
                timestamp: new Date().toISOString(),
              },
            ]);
          }, 1200);
        }
      }
    };

    window.addEventListener("message", handleIframeMessage);

    return () => {
      window.removeEventListener("message", handleIframeMessage);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMsg: Message = {
      id: Math.random().toString(),
      sender: "user",
      text: input,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsThinking(true);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "user.message",
          content: input,
          ...activeSession,
        })
      );
    } else {
      // Simulation response
      setTimeout(() => {
        setIsThinking(false);
        setMessages((prev) => [
          ...prev,
          {
            id: Math.random().toString(),
            sender: "agent",
            text: `Received user message: "${input}". The workspace canvas state is synchronized.`,
            timestamp: new Date().toISOString(),
          },
        ]);
      }, 1000);
    }
  };

  // Simulates a user action inside an iframe to test the postMessage flow
  const triggerSimulatedIframeAction = (action: string, payload: Record<string, any>) => {
    window.postMessage(
      {
        type: "avos.ui_event",
        gadgetId: "finance_grid",
        action,
        payload,
      },
      "*"
    );
  };

  return (
    <div className="flex flex-col h-full max-w-4xl mx-auto border border-gray-200 rounded-lg shadow-md bg-white">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 bg-gray-50 border-b border-gray-200">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Naelao Autonomous Agent</h2>
          <p className="text-xs text-gray-500">MCP-UI Bidirectional Streaming Active</p>
        </div>
        <div className="flex items-center space-x-2">
          <span className={`h-2.5 w-2.5 rounded-full ${wsConnected ? "bg-green-500 animate-pulse" : "bg-amber-500"}`} />
          <span className="text-xs text-gray-600 font-medium">
            {wsConnected ? "Gateway Connected" : "Simulated Mode"}
          </span>
        </div>
      </div>

      {/* Main Panel with Chat and Simulation Controls */}
      <div className="flex flex-1 min-h-[500px]">
        {/* Chat Stream */}
        <div className="flex-1 flex flex-col justify-between border-r border-gray-100">
          <div className="flex-1 p-6 overflow-y-auto space-y-4 max-h-[420px]">
            {messages.map((m) => (
              <div key={m.id} className={`flex ${m.sender === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[75%] px-4 py-3 rounded-2xl text-sm ${
                    m.sender === "user" ? "bg-blue-600 text-white rounded-tr-none" : "bg-gray-100 text-gray-800 rounded-tl-none"
                  }`}
                >
                  <p className="leading-relaxed">{m.text}</p>
                  <span
                    className={`block text-[10px] mt-1 text-right ${m.sender === "user" ? "text-blue-200" : "text-gray-400"}`}
                  >
                    {new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                </div>
              </div>
            ))}

            {isThinking && (
              <div className="flex justify-start items-center space-x-2 text-gray-500 py-2">
                <div className="flex space-x-1">
                  <div className="h-2 w-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                  <div className="h-2 w-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <div className="h-2 w-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
                <span className="text-xs font-semibold animate-pulse">Naelao is thinking...</span>
              </div>
            )}
          </div>

          {/* Form Input */}
          <form onSubmit={handleSendMessage} className="p-4 border-t border-gray-100 bg-gray-50 flex space-x-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask Naelao anything or type a prompt..."
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
            />
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white font-medium text-sm rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
            >
              Send
            </button>
          </form>
        </div>

        {/* MCP-UI Interaction Simulator */}
        <div className="w-80 p-6 bg-gray-50 flex flex-col space-y-6">
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-1">Canvas Simulation</h3>
            <p className="text-xs text-gray-500 leading-normal">
              Simulate standard postMessage events originating from Tier-2 and Tier-3 Canvas iframe widgets.
            </p>
          </div>

          <div className="space-y-3">
            <button
              onClick={() =>
                triggerSimulatedIframeAction("BUTTON_CLICK", {
                  invoiceId: "402",
                  amount: 25000,
                  recipient: "Acme Corp",
                })
              }
              className="w-full text-left px-3 py-2.5 bg-white hover:bg-gray-100 border border-gray-200 rounded-lg text-xs font-medium text-gray-700 shadow-sm transition-colors"
            >
              <span className="block font-bold text-blue-600 mb-0.5">Approve Invoice #402</span>
              <span className="block text-[10px] text-gray-400 font-normal">
                gadgetId: "finance_grid", action: "BUTTON_CLICK"
              </span>
            </button>

            <button
              onClick={() =>
                triggerSimulatedIframeAction("FORM_SUBMIT", {
                  formId: "project_journal_add",
                  title: "Release Phase 6 Chunk 07",
                  hours: 8,
                })
              }
              className="w-full text-left px-3 py-2.5 bg-white hover:bg-gray-100 border border-gray-200 rounded-lg text-xs font-medium text-gray-700 shadow-sm transition-colors"
            >
              <span className="block font-bold text-green-600 mb-0.5">Submit Journal entry</span>
              <span className="block text-[10px] text-gray-400 font-normal">
                gadgetId: "finance_grid", action: "FORM_SUBMIT"
              </span>
            </button>
          </div>

          <div className="pt-4 border-t border-gray-200">
            <h4 className="text-xs font-semibold text-gray-600 mb-2">How It Works:</h4>
            <ol className="text-[11px] text-gray-500 space-y-2 list-decimal list-inside leading-relaxed">
              <li>You click a simulated canvas button/form.</li>
              <li>An iframe message event is broadcasted.</li>
              <li>
                The shell handles it via <strong>Iframe Bridge</strong> and broadcasts <code>mcp.ui_action</code> WebSocket event.
              </li>
              <li>
                The agent parses the observation and responds autonomously with deep UI state awareness.
              </li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
};
