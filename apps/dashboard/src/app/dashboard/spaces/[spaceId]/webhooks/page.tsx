"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { apiFetch } from "@/lib/api";

interface WebhookSub {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  created_at: string;
}

const ALL_EVENTS = [
  "session.started", "session.ended",
  "message.sent", "message.received",
  "agent.run.completed", "agent.run.failed",
  "space.updated",
];

export default function WebhooksPage() {
  const params = useParams<{ spaceId: string }>();
  const [subs, setSubs] = useState<WebhookSub[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ url: "", events: [] as string[] });

  useEffect(() => { void load(); }, [params.spaceId]);

  async function load() {
    setLoading(true);
    try {
      const data = await apiFetch<{ data: WebhookSub[] }>(`/v1/spaces/${params.spaceId}/webhooks`);
      setSubs(data.data);
    } catch { /* ignore */ } finally { setLoading(false); }
  }

  async function create() {
    if (!form.url || form.events.length === 0) return;
    try {
      await apiFetch(`/v1/spaces/${params.spaceId}/webhooks`, {
        method: "POST",
        body: JSON.stringify({ url: form.url, events: form.events }),
      });
      setShowNew(false);
      setForm({ url: "", events: [] });
      await load();
    } catch { /* ignore */ }
  }

  async function toggle(id: string, enabled: boolean) {
    try {
      await apiFetch(`/v1/spaces/${params.spaceId}/webhooks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
      setSubs((prev) => prev.map((s) => s.id === id ? { ...s, enabled } : s));
    } catch { /* ignore */ }
  }

  async function del(id: string) {
    if (!confirm("Delete this webhook?")) return;
    try {
      await apiFetch(`/v1/spaces/${params.spaceId}/webhooks/${id}`, { method: "DELETE" });
      setSubs((prev) => prev.filter((s) => s.id !== id));
    } catch { /* ignore */ }
  }

  function toggleEvent(evt: string) {
    setForm((prev) => ({
      ...prev,
      events: prev.events.includes(evt) ? prev.events.filter((e) => e !== evt) : [...prev.events, evt],
    }));
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Webhooks</h1>
          <p className="text-gray-500 mt-1">Outbound event notifications (HMAC-SHA256 signed)</p>
        </div>
        <button onClick={() => setShowNew(true)} className="px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700">
          + Add Webhook
        </button>
      </div>

      {showNew && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <h2 className="font-semibold text-gray-900 mb-4">New Webhook</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Endpoint URL</label>
              <input type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="https://example.com/webhook"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Events to subscribe to</label>
              <div className="grid grid-cols-2 gap-2">
                {ALL_EVENTS.map((evt) => (
                  <label key={evt} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                    <input type="checkbox" checked={form.events.includes(evt)} onChange={() => toggleEvent(evt)}
                      className="rounded border-gray-300 text-brand-600 focus:ring-brand-500" />
                    {evt}
                  </label>
                ))}
              </div>
            </div>
            <p className="text-xs text-gray-400">Requests are signed with <code className="bg-gray-100 px-1 rounded">X-Naelao-Signature: t=timestamp,v1=hmac</code></p>
            <div className="flex gap-3">
              <button onClick={() => void create()} className="px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700">Create</button>
              <button onClick={() => setShowNew(false)} className="px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : subs.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400">No webhooks yet.</div>
      ) : (
        <div className="space-y-3">
          {subs.map((sub) => (
            <div key={sub.id} className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-mono text-sm text-gray-800 break-all">{sub.url}</p>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {sub.events.map((e) => (
                      <span key={e} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">{e}</span>
                    ))}
                  </div>
                  <p className="text-xs text-gray-400 mt-1">Created {new Date(sub.created_at).toLocaleDateString()}</p>
                </div>
                <div className="flex items-center gap-3 ml-4">
                  <button onClick={() => void toggle(sub.id, !sub.enabled)}
                    className={`text-xs font-medium px-2 py-1 rounded ${sub.enabled ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                    {sub.enabled ? "Active" : "Paused"}
                  </button>
                  <button onClick={() => void del(sub.id)} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
