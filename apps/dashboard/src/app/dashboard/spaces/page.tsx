"use client";

import { FormEvent, useEffect, useState } from "react";
import { createSpace, listSpaces, type Space } from "@/lib/api";

export default function SpacesPage() {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    setLoading(true);
    try { setSpaces(await listSpaces()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load Spaces"); }
    finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setError("");
    setSaving(true);
    try {
      await createSpace({ name: name.trim(), ...(templateId.trim() ? { template_id: templateId.trim() } : {}) });
      setName("");
      setTemplateId("");
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create Space"); }
    finally { setSaving(false); }
  }

  return <div className="mx-auto max-w-5xl">
    <header className="mb-6"><p className="text-sm font-medium text-brand-700">NAELAO</p><h1 className="mt-1 text-2xl font-bold text-gray-900">Spaces</h1><p className="mt-2 text-sm text-gray-500">Create general work environments and optionally start from a Space Template.</p></header>
    {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
    <form onSubmit={submit} className="mb-6 grid gap-4 rounded-xl border border-gray-200 bg-white p-5 sm:grid-cols-2">
      <div><label htmlFor="space-name" className="mb-1 block text-sm font-medium text-gray-700">Space name</label><input id="space-name" required maxLength={120} value={name} onChange={event => setName(event.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="Research workspace" /></div>
      <div><label htmlFor="space-template" className="mb-1 block text-sm font-medium text-gray-700">Space Template ID (optional)</label><input id="space-template" maxLength={120} value={templateId} onChange={event => setTemplateId(event.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="Leave blank for a clean Space" /></div>
      <div className="flex items-end"><button type="submit" disabled={saving} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{saving ? "Creating…" : "Create Space"}</button></div>
    </form>
    <section className="rounded-xl border border-gray-200 bg-white p-5"><h2 className="font-semibold text-gray-900">Your Spaces</h2>
      {loading ? <p className="py-8 text-center text-sm text-gray-400">Loading…</p> : spaces.length === 0 ? <p className="py-8 text-center text-sm text-gray-500">No Spaces yet.</p> : <ul className="mt-3 divide-y divide-gray-100">{spaces.map(space => <li key={space.id} className="flex items-center justify-between gap-4 py-3"><span className="font-medium text-gray-900">{space.name}</span><span className="text-xs text-gray-500">{space.status}</span></li>)}</ul>}
    </section>
  </div>;
}
