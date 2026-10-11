"use client";

import { useCallback, useEffect, useState } from "react";
import {
  addByokKey,
  getByokStatus,
  removeByokKey,
  selectByokKey,
  type ByokProviderStatus,
} from "@/lib/api";

const PROVIDERS = [
  { id: "google-ai-studio", label: "Google AI Studio / Gemini", hint: "aistudio.google.com → API keys" },
  { id: "groq", label: "Groq", hint: "console.groq.com → API Keys" },
] as const;

export default function ByokKeysPanel({ spaceId }: { spaceId: string }) {
  const [providers, setProviders] = useState<ByokProviderStatus[]>([]);
  const [provider, setProvider] = useState<string>(PROVIDERS[0].id);
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setProviders(await getByokStatus(spaceId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load model provider keys.");
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function add() {
    if (!key.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await addByokKey(spaceId, provider, key, label);
      setKey("");
      setLabel("");
      await refresh();
      setNotice("Key added and selected as the preferred key. Additional keys for this provider remain available for automatic failover.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save provider key.");
    } finally {
      setBusy(false);
    }
  }

  async function select(providerId: string, keyId: string) {
    setBusy(true);
    setError(null);
    try {
      await selectByokKey(spaceId, providerId, keyId);
      await refresh();
      setNotice("Preferred key updated. It will be tried first on the next run.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to select provider key.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(providerId: string, keyId: string) {
    setBusy(true);
    setError(null);
    try {
      await removeByokKey(spaceId, providerId, keyId);
      await refresh();
      setNotice("Provider key removed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove provider key.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">AI provider keys</h2>
      <p className="text-sm text-gray-500 mt-2">
        Add multiple keys for the same provider. The preferred key is tried first; an authentication,
        rate-limit, or provider outage automatically tries the next key for that run.
      </p>

      <div className="grid gap-3 sm:grid-cols-[180px_1fr_180px_auto] mt-4 items-end">
        <label className="text-sm text-gray-700">
          <span className="block text-xs text-gray-500 mb-1">Provider</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
            {PROVIDERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <label className="text-sm text-gray-700">
          <span className="block text-xs text-gray-500 mb-1">API key</span>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste a new key" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" autoComplete="off" />
        </label>
        <label className="text-sm text-gray-700">
          <span className="block text-xs text-gray-500 mb-1">Label (optional)</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Production" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" autoComplete="off" />
        </label>
        <button onClick={() => void add()} disabled={busy || !key.trim()} className="px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 disabled:opacity-50">
          {busy ? "Saving…" : "Add key"}
        </button>
      </div>

      {loading ? <p className="text-sm text-gray-400 mt-4">Loading provider keys…</p> : (
        <div className="mt-5 space-y-3">
          {providers.map((item) => {
            const providerInfo = PROVIDERS.find((p) => p.id === item.provider);
            return (
              <div key={item.provider} className="border border-gray-200 rounded-lg p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-gray-800">{providerInfo?.label ?? item.provider}</div>
                    <div className="text-xs text-gray-400">{item.keys.length ? `${item.keys.length} key${item.keys.length === 1 ? "" : "s"} configured` : `No key configured${providerInfo ? ` · ${providerInfo.hint}` : ""}`}</div>
                  </div>
                </div>
                {item.keys.length > 0 && <div className="mt-2 space-y-2">
                  {item.keys.map((entry) => (
                    <div key={entry.id} className="flex items-center justify-between gap-3 bg-gray-50 rounded-md px-3 py-2">
                      <span className="text-sm text-gray-700 truncate">{entry.label}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        {entry.active ? <span className="text-xs text-green-700 font-medium">Preferred</span> : <button onClick={() => void select(item.provider, entry.id)} disabled={busy} className="text-xs text-brand-600 hover:underline disabled:opacity-50">Use first</button>}
                        <button onClick={() => void remove(item.provider, entry.id)} disabled={busy} className="text-xs text-red-600 hover:underline disabled:opacity-50">Remove</button>
                      </div>
                    </div>
                  ))}
                </div>}
              </div>
            );
          })}
        </div>
      )}
      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
      {notice && <p className="text-sm text-gray-500 mt-3">{notice}</p>}
      <p className="text-xs text-gray-400 mt-4">Keys are encrypted in the space vault and never shown again. Owner/admin access is required.</p>
    </div>
  );
}
