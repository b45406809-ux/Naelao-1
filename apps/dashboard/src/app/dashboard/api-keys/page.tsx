"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

const ALL_SCOPES = [
  "spaces:read", "spaces:write",
  "sessions:read", "sessions:write",
  "kb:read", "kb:write",
  "agents:read", "agents:write",
  "analytics:read",
  "billing:read",
];

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ name: "", scopes: [] as string[], expires_in_days: "" });
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => { void load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await apiFetch<{ data: ApiKey[] }>("/v1/api-keys");
      setKeys(data.data);
    } catch { /* ignore */ } finally { setLoading(false); }
  }

  async function create() {
    if (!form.name || form.scopes.length === 0) return;
    try {
      const body: Record<string, unknown> = { name: form.name, scopes: form.scopes };
      if (form.expires_in_days) body["expires_in_days"] = parseInt(form.expires_in_days, 10);
      const data = await apiFetch<{ key: string }>("/v1/api-keys", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setNewKey(data.key);
      setShowNew(false);
      setForm({ name: "", scopes: [], expires_in_days: "" });
      await load();
    } catch { /* ignore */ }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this API key? This cannot be undone.")) return;
    try {
      await apiFetch(`/v1/api-keys/${id}`, { method: "DELETE" });
      setKeys((prev) => prev.filter((k) => k.id !== id));
    } catch { /* ignore */ }
  }

  function toggleScope(scope: string) {
    setForm((prev) => ({
      ...prev,
      scopes: prev.scopes.includes(scope) ? prev.scopes.filter((s) => s !== scope) : [...prev.scopes, scope],
    }));
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">API Keys</h1>
          <p className="text-gray-500 mt-1">Scoped programmatic access to the Naelao API</p>
        </div>
        <button onClick={() => setShowNew(true)} className="px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700">
          + Create API Key
        </button>
      </div>

      {newKey && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-5 mb-6">
          <p className="text-sm font-semibold text-green-800 mb-2">API Key created — copy it now. It will not be shown again.</p>
          <div className="flex items-center gap-3">
            <code className="flex-1 bg-white border border-green-200 rounded px-3 py-2 text-sm font-mono text-gray-800 overflow-x-auto">{newKey}</code>
            <button onClick={() => void copy(newKey)} className="px-3 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700">
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <button onClick={() => setNewKey(null)} className="mt-3 text-xs text-green-600 hover:underline">Dismiss</button>
        </div>
      )}

      {showNew && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <h2 className="font-semibold text-gray-900 mb-4">New API Key</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Key Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Production Backend"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Scopes</label>
              <div className="grid grid-cols-2 gap-2">
                {ALL_SCOPES.map((scope) => (
                  <label key={scope} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                    <input type="checkbox" checked={form.scopes.includes(scope)} onChange={() => toggleScope(scope)}
                      className="rounded border-gray-300 text-brand-600 focus:ring-brand-500" />
                    <code className="text-xs">{scope}</code>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Expiry (days, optional)</label>
              <input type="number" min="1" max="365" value={form.expires_in_days} onChange={(e) => setForm({ ...form, expires_in_days: e.target.value })}
                placeholder="Leave blank for no expiry"
                className="w-48 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div className="flex gap-3">
              <button onClick={() => void create()} className="px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700">Create</button>
              <button onClick={() => setShowNew(false)} className="px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : keys.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400">No API keys yet.</div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Name</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Key</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Scopes</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Last Used</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Expires</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {keys.map((k) => (
                <tr key={k.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{k.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">{k.key_prefix}…</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {k.scopes.map((s) => <span key={s} className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">{s}</span>)}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : "Never"}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{k.expires_at ? new Date(k.expires_at).toLocaleDateString() : "Never"}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => void revoke(k.id)} className="text-xs text-red-500 hover:text-red-700">Revoke</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
