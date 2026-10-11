"use client";

export const runtime = "edge";

// Naelao -> Product -> Business -> Personal credential hierarchy (see workers/credentials'
// resolveCredential): this page manages this SPACE's own credentials. When spaceId is a
// product's ROOT space, a "Shared" credential created here IS the product-wide default every
// business under the product falls back to unless it has its own — no special product-tier UI
// needed, it's the same scope='space' row a business page would create for itself. When a
// connector has no credential at ANY tier, the relevant op automatically falls back to Naelao's
// own platform-held key (Composio/Pipedream/Tavily etc) and meters usage to this org — never a
// silent failure, but real, billed usage; see recordPlatformKeyUsage (workers/mcp-hub).
//
// Previously this page posted {name, credential_type, secret_value, label} and read `data.data`
// — neither matches the real worker (POST wants {name, value, scope, is_override,
// shared_with_user_ids}, GET returns {credentials: [...]}), so every create 400'd with "value is
// required" and the list silently rendered empty. Fixed here to the real contract.

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { apiFetch } from "@/lib/api";
import ByokKeysPanel from "@/components/ByokKeysPanel";

interface Credential {
  id: string;
  name: string;
  scope: "user" | "space";
  user_id: string | null;
  is_override: boolean;
  shared_with_user_ids: string[] | null;
  description: string | null;
  created_at: string;
}

type ShareMode = "everyone" | "selected";

export default function CredentialsPage() {
  const params = useParams<{ spaceId: string }>();
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    value: "",
    description: "",
    scope: "space" as "user" | "space",
    isOverride: false,
    shareMode: "everyone" as ShareMode,
    selectedUserIds: "",
  });
  const [deleting, setDeleting] = useState<string | null>(null);
  const [savingShare, setSavingShare] = useState<string | null>(null);

  useEffect(() => { void load(); }, [params.spaceId]);

  async function load() {
    setLoading(true);
    try {
      const data = await apiFetch<{ credentials: Credential[] }>(`/v1/spaces/${params.spaceId}/credentials`);
      setCredentials(data.credentials);
    } catch { /* ignore */ } finally { setLoading(false); }
  }

  async function create() {
    setError(null);
    if (!form.name.trim() || !form.value.trim()) {
      setError("Name and value are required.");
      return;
    }
    setSaving(true);
    try {
      const sharedWithUserIds =
        form.scope === "space" && !form.isOverride && form.shareMode === "selected"
          ? form.selectedUserIds.split(",").map((s) => s.trim()).filter(Boolean)
          : null;
      await apiFetch(`/v1/spaces/${params.spaceId}/credentials`, {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          value: form.value,
          description: form.description || undefined,
          scope: form.scope,
          is_override: form.scope === "space" ? form.isOverride : undefined,
          shared_with_user_ids: sharedWithUserIds,
        }),
      });
      setShowNew(false);
      setForm({ name: "", value: "", description: "", scope: "space", isOverride: false, shareMode: "everyone", selectedUserIds: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save credential.");
    } finally {
      setSaving(false);
    }
  }

  async function del(id: string) {
    if (!confirm("Delete this credential? Anything currently falling back to it will move to the next tier.")) return;
    setDeleting(id);
    try {
      await apiFetch(`/v1/spaces/${params.spaceId}/credentials/${id}`, { method: "DELETE" });
      setCredentials((prev) => prev.filter((c) => c.id !== id));
    } catch { /* ignore */ } finally { setDeleting(null); }
  }

  async function updateSharing(cred: Credential, shareMode: ShareMode, userIds: string) {
    setSavingShare(cred.id);
    try {
      const sharedWithUserIds = shareMode === "everyone" ? null : userIds.split(",").map((s) => s.trim()).filter(Boolean);
      await apiFetch(`/v1/spaces/${params.spaceId}/credentials/${cred.id}`, {
        method: "PATCH",
        body: JSON.stringify({ shared_with_user_ids: sharedWithUserIds }),
      });
      await load();
    } catch { /* ignore */ } finally { setSavingShare(null); }
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Credentials</h1>
          <p className="text-gray-500 mt-1">
            Secrets for tool/connector auth (AES-256-GCM encrypted at rest). A "Shared" credential
            here is used by every member of this space unless they have their own personal one —
            and if this space is a product&rsquo;s root, it&rsquo;s the product-wide default every
            business under it falls back to. No credential at any tier falls back automatically to
            Naelao&rsquo;s own key where one exists, billed to this org.
          </p>
        </div>
        <button onClick={() => setShowNew(true)} className="px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 whitespace-nowrap">
          + Add Credential
        </button>
      </div>

      <div className="mb-6">
        <ByokKeysPanel spaceId={params.spaceId} />
      </div>

      {showNew && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <h2 className="font-semibold text-gray-900 mb-4">New Credential</h2>
          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name (identifier)</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. gmail or gmail::work for a named slot"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500" />
              <p className="text-xs text-gray-400 mt-1">Use a ::slot suffix to hold more than one credential for the same connector (e.g. gmail::personal vs gmail::work).</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Who is this for?</label>
              <select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as "user" | "space" })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
                <option value="space">Shared (this space&rsquo;s default for everyone, unless overridden below)</option>
                <option value="user">Just me (my own personal credential)</option>
              </select>
            </div>
            {form.scope === "space" && (
              <>
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={form.isOverride} onChange={(e) => setForm({ ...form, isOverride: e.target.checked })} />
                  Force this for everyone (overrides any member&rsquo;s own personal credential of the same name)
                </label>
                {!form.isOverride && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Share with</label>
                    <select value={form.shareMode} onChange={(e) => setForm({ ...form, shareMode: e.target.value as ShareMode })}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
                      <option value="everyone">Everyone in this space</option>
                      <option value="selected">Selected members only</option>
                    </select>
                    {form.shareMode === "selected" && (
                      <input value={form.selectedUserIds} onChange={(e) => setForm({ ...form, selectedUserIds: e.target.value })}
                        placeholder="user ids, comma-separated"
                        className="w-full mt-2 border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500" />
                    )}
                  </div>
                )}
              </>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="OpenWeather API key"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Value</label>
              <input type="password" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })}
                placeholder="sk-…"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
              <p className="text-xs text-gray-400 mt-1">Encrypted with AES-256-GCM before storage. Never retrieved in plaintext by this dashboard.</p>
            </div>
            <div className="flex gap-3">
              <button onClick={() => void create()} disabled={saving} className="px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 disabled:opacity-50">
                {saving ? "Saving…" : "Save"}
              </button>
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
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Scope</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Sharing</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Created</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {credentials.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50 align-top">
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">{c.name}</td>
                  <td className="px-4 py-3">
                    <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                      {c.scope === "user" ? "Personal" : c.is_override ? "Shared (forced)" : "Shared"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {c.scope !== "space" || c.is_override ? (
                      <span className="text-gray-400 text-xs">—</span>
                    ) : (
                      <SharingControl
                        credential={c}
                        saving={savingShare === c.id}
                        onSave={(mode, ids) => void updateSharing(c, mode, ids)}
                      />
                    )}
                  </td>
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

function SharingControl({
  credential, saving, onSave,
}: { credential: Credential; saving: boolean; onSave: (mode: ShareMode, ids: string) => void }) {
  const [mode, setMode] = useState<ShareMode>(credential.shared_with_user_ids ? "selected" : "everyone");
  const [ids, setIds] = useState((credential.shared_with_user_ids ?? []).join(", "));
  const dirty = mode !== (credential.shared_with_user_ids ? "selected" : "everyone") || ids !== (credential.shared_with_user_ids ?? []).join(", ");

  return (
    <div className="flex flex-col gap-1">
      <select value={mode} onChange={(e) => setMode(e.target.value as ShareMode)}
        className="border border-gray-300 rounded px-2 py-1 text-xs">
        <option value="everyone">Everyone</option>
        <option value="selected">Selected members</option>
      </select>
      {mode === "selected" && (
        <input value={ids} onChange={(e) => setIds(e.target.value)} placeholder="user ids, comma-separated"
          className="border border-gray-300 rounded px-2 py-1 text-xs font-mono" />
      )}
      {dirty && (
        <button onClick={() => onSave(mode, ids)} disabled={saving} className="text-xs text-brand-600 hover:text-brand-700 disabled:opacity-50 self-start">
          {saving ? "Saving…" : "Save"}
        </button>
      )}
    </div>
  );
}
