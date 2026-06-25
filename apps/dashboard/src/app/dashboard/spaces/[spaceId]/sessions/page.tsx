"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { getApiBase, getAuthHeader } from "@/lib/api";

interface LiveSession {
  id: string;
  end_user_id: string;
  status: string;
  created_at: string;
  message_count?: number;
}

export default function LiveSessionsPage() {
  const params = useParams<{ spaceId: string }>();
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const wsBase = getApiBase().replace(/^https?/, "wss");
    const url = `${wsBase}/v1/spaces/${params.spaceId}/sessions/live?${new URLSearchParams({ Authorization: getAuthHeader() })}`;

    const connect = () => {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onerror = () => setError("Connection failed — retrying...");
      ws.onclose = () => {
        setConnected(false);
        setTimeout(connect, 3000);
      };
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data as string) as { type: string; session?: LiveSession; sessions?: LiveSession[] };
          if (msg.type === "snapshot" && msg.sessions) {
            setSessions(msg.sessions);
          } else if (msg.type === "session_updated" && msg.session) {
            setSessions((prev) => {
              const idx = prev.findIndex((s) => s.id === msg.session!.id);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = msg.session!;
                return next;
              }
              return [msg.session!, ...prev];
            });
          } else if (msg.type === "session_ended" && msg.session) {
            setSessions((prev) => prev.filter((s) => s.id !== msg.session!.id));
          }
        } catch { /* ignore bad frames */ }
      };
    };

    connect();
    return () => {
      wsRef.current?.close();
    };
  }, [params.spaceId]);

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Live Sessions</h1>
          <p className="text-gray-500 mt-1">Real-time session monitoring via WebSocket</p>
        </div>
        <span className={`text-xs font-medium px-3 py-1 rounded-full ${connected ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
          {connected ? "Connected" : "Connecting..."}
        </span>
      </div>

      {error && (
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-700 rounded-lg px-4 py-3 mb-4 text-sm">{error}</div>
      )}

      {sessions.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400">
          <p>No active sessions right now</p>
          <p className="text-xs mt-1">Sessions appear here as users connect</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Session ID</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">User</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Status</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Messages</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Started</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sessions.map((s) => (
                <tr key={s.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">{s.id.slice(0, 8)}…</td>
                  <td className="px-4 py-3 text-gray-700">{s.end_user_id}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${s.status === "active" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                      {s.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-700">{s.message_count ?? 0}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{new Date(s.created_at).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
