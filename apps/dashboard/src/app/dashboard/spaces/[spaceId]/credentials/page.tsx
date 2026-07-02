"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { apiFetch } from "@/lib/api";

interface Credential {
  id: string;
  name: string;
  credential_type: string;
  label: string;
  created_at: string;
}

export default function CredentialsPage() {
  const params = useParams<{ spaceId: string }>();
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ name: "", credential_type: "api_key", secret_value: "", label: "" });
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => { void load(); }, [params.spaceId]);

  async function load() {
    setLoading(true);
    try {
      const data = await apiFetch<{ data: Credential[] }>(`/v1/spaces/${params.spaceId}/credentials`);
      setCredentials(data.data);
    } catch { /* ignore */ } finally { setLoading(false); }
  }

  async function create() {
    try {
      await apiFetch(`/v1/spaces/${params.spaceId}/credentials`, {
        method: "POST",
        body: JSON.stringify(form),
      });
      setShowNew(false);
      setForm({ name: "", credential_type: "api_key", secret_value: "", label: "" });
      await load();
    } catch { /* ignore */ }
  }

  async function del(id: string) {
    if (!confirm("Delete this credential?")) return;
    setDeleting(id);
    try {
      await apiFetch(`/v1/spaces/${params.spaceId}/credentials/${id}`, { method: "DELETE" });
      setCredentials((prev) => prev.filter((c) => c.id !== id));
    } catch { /* ignore */ } finally { setDeleting(null); }
  }

  const TYPES = ["api_key", "oauth2_token", "basic_auth", "hmac_secret", "jwt_secret"];

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Credentials</h1>
          <p className="text-gray-500 mt-1">Secrets for tool HTTP calls (AES-256-GCM encrypted at rest)</p>
        </div>
        <button onClick={() => setShowNew(true)} className="px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700">
          + Add Credential
        </button>
      </div>

      {showNew && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <h2 className="font-semibold text-gray-900 mb-4">New Credential</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name (identifier)</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. OPENWEATHER_API_KEY"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
              <select value={form.credential_type} onChange={(e) => setForm({ ...form, credential_type: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
                {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Label (display name)</label>
              <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder="OpenWeather API Key"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Secret Value</label>
              <input type="password" value={form.secret_value} onChange={(e) => setForm({ ...form, secret_value: e.target.value })}
                placeholder="sk-…"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
              <p className="text-xs text-gray-400 mt-1">Encrypted with AES-256-GCM before storage. Never retrieved in plaintext.</p>
            </div>
            <div className="flex gap-3">
              <button onClick={() => void create()} className="px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700">Save</button>
              <button onClick={() => setShowNew(false)} className="px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : credentials.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400">
          No credentials yet. Add one to enable tool authentication.
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Name</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Label</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Type</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Created</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {credentials.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">{c.name}</td>
                  <td className="px-4 py-3 text-gray-700">{c.label}</td>
                  <td className="px-4 py-3"><span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">{c.credential_type}</span></td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{new Date(c.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => void del(c.id)} disabled={deleting === c.id}
                      className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50">
                      {deleting === c.id ? "Deleting…" : "Delete"}
                    </button>
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
