"use client";

import { useEffect, useState } from "react";
import { listApiKeys, createApiKey, revokeApiKey } from "@/lib/api";
import type { ApiKey } from "@/lib/api";
import { MAX_API_KEY_EXPIRY_DAYS, parseApiKeyExpiryDays } from "@/lib/api-key-form";

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
  const [copyError, setCopyError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => { void load(); }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setKeys(await listApiKeys());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load API keys");
    } finally { setLoading(false); }
  }

  async function create() {
    if (creating) return;
    const name = form.name.trim();
    if (!name || name.length > 80 || form.scopes.length === 0) {
      setError("Enter a key name (up to 80 characters) and choose at least one scope.");
      return;
    }
    const expiresInDays = parseApiKeyExpiryDays(form.expires_in_days);
    if (expiresInDays === null) {
      setError(`Expiry must be a whole number from 1 to ${MAX_API_KEY_EXPIRY_DAYS}, or blank for no expiry.`);
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const data = await createApiKey(name, form.scopes, expiresInDays);
      setNewKey(data.key);
      setShowNew(false);
      setForm({ name: "", scopes: [], expires_in_days: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create API key");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    if (revoking) return;
    if (!confirm("Revoke this API key? This cannot be undone.")) return;
    setRevoking(id);
    setError(null);
    try {
      await revokeApiKey(id);
      setKeys((prev) => prev.filter((k) => k.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke API key");
    } finally {
      setRevoking(null);
    }
  }

  function toggleScope(scope: string) {
    setForm((prev) => ({
      ...prev,
      scopes: prev.scopes.includes(scope) ? prev.scopes.filter((s) => s !== scope) : [...prev.scopes, scope],
    }));
  }

  async function copy(text: string) {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError("Clipboard access failed. Select and copy the key manually.");
    }
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">API Keys</h1>
          <p className="text-gray-500 mt-1">Scoped programmatic access to the Naelao API</p>
        </div>
        <button disabled={newKey !== null || creating} onClick={() => setShowNew(true)} className="px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 disabled:opacity-50">
          + Create API Key
        </button>
      </div>

      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      {newKey && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-5 mb-6">
          <p className="text-sm font-semibold text-green-800 mb-2">API Key created — copy it now. It will not be shown again.</p>
          <div className="flex items-center gap-3">
            <code className="flex-1 bg-white border border-green-200 rounded px-3 py-2 text-sm font-mono text-gray-800 overflow-x-auto">{newKey}</code>
            <button onClick={() => void copy(newKey)} className="px-3 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700">
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          {copyError && <p role="alert" className="mt-2 text-sm text-red-700">{copyError}</p>}
          <button onClick={() => setNewKey(null)} className="mt-3 text-xs text-green-600 hover:underline">Dismiss</button>
        </div>
      )}

      {showNew && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <h2 className="font-semibold text-gray-900 mb-4">New API Key</h2>
          <div className="space-y-4">
            <div>
              <label htmlFor="api-key-name" className="block text-sm font-medium text-gray-700 mb-1">Key Name</label>
              <input id="api-key-name" maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
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
              <label htmlFor="api-key-expiry" className="block text-sm font-medium text-gray-700 mb-1">Expiry in days (optional, max {MAX_API_KEY_EXPIRY_DAYS})</label>
              <input id="api-key-expiry" type="number" min="1" max={MAX_API_KEY_EXPIRY_DAYS} step="1" value={form.expires_in_days} onChange={(e) => setForm({ ...form, expires_in_days: e.target.value })}
                placeholder="Leave blank for no expiry"
                className="w-48 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div className="flex gap-3">
              <button type="button" disabled={creating} onClick={() => void create()} className="px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 disabled:opacity-50">{creating ? "Creating…" : "Create"}</button>
              <button type="button" disabled={creating} onClick={() => setShowNew(false)} className="px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50 disabled:opacity-50">Cancel</button>
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
                    <button disabled={revoking !== null} onClick={() => void revoke(k.id)} className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50">{revoking === k.id ? "Revoking…" : "Revoke"}</button>
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
