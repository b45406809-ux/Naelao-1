"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  isAuthenticated, getUser, logout,
  onboardBusiness, businessStatus, runContentCycle, setPaused,
  type BusinessStatus,
} from "@/lib/account";

export default function LaunchPage() {
  const router = useRouter();
  const [status, setStatus] = useState<BusinessStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Onboarding form
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("19");
  const [submitting, setSubmitting] = useState(false);
  const [cycleMsg, setCycleMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated()) { router.replace("/login"); return; }
    businessStatus()
      .then((s) => setStatus(s))
      .catch(() => setStatus(null)) // not onboarded yet → show form
      .finally(() => setLoading(false));
  }, [router]);

  async function onboard(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setSubmitting(true);
    try {
      await onboardBusiness({ product_name: name, product_description: description, price_usd: Number(price), billing_period: "monthly" });
      setStatus(await businessStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onboarding failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function triggerCycle() {
    setCycleMsg(null);
    try {
      const r = await runContentCycle({});
      setCycleMsg(`Content cycle started (${r.cycle_id.slice(0, 8)}…)`);
    } catch (err) {
      setCycleMsg(err instanceof Error ? err.message : "Failed to start cycle");
    }
  }

  async function togglePause() {
    if (!status) return;
    try {
      await setPaused(!status.paused);
      setStatus(await businessStatus());
    } catch (err) {
      setCycleMsg(err instanceof Error ? err.message : "Failed to update");
    }
  }

  if (loading) {
    return <main className="min-h-screen flex items-center justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" /></main>;
  }

  const user = getUser();

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-10">
      <div className="max-w-lg mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-gray-900">Your Whop business</h1>
          <button onClick={() => { logout(); router.replace("/login"); }} className="text-sm text-gray-500 hover:text-gray-700">Sign out</button>
        </div>
        <p className="text-sm text-gray-500 mb-6">{user?.email}</p>

        {status && status.whop_product_id ? (
          // ── Running business ──
          <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
            <Row label="Whop product" value={status.whop_product_id} mono />
            <Row label="Autonomy tier" value={String(status.autonomy_tier)} />
            <Row label="Agent status" value={status.paused ? "paused" : status.fiber_status} />
            <Row label="Scripts" value={String(status.script_count)} />
            <Row label="Cycles logged" value={String(status.outcome_count)} />
            {status.paused && (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                Paused — the agent will not run anything until you resume.
              </p>
            )}
            <div className="pt-3 border-t border-gray-100 flex items-center gap-2">
              <button onClick={triggerCycle} disabled={status.paused} className="bg-indigo-600 text-white text-sm font-semibold px-4 py-2 rounded-lg disabled:opacity-50">
                Generate a community post
              </button>
              <button onClick={togglePause} className={`text-sm font-semibold px-4 py-2 rounded-lg border ${status.paused ? "border-green-300 text-green-700" : "border-red-300 text-red-700"}`}>
                {status.paused ? "Resume agent" : "Pause agent"}
              </button>
            </div>
            {cycleMsg && <p className="text-sm text-gray-600 mt-2">{cycleMsg}</p>}
          </div>
        ) : (
          // ── Onboarding form ──
          <form onSubmit={onboard} className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
            <p className="text-sm text-gray-600">Launch the live niche: <strong>AI Micro-Tool + Community</strong>. Other Whop business types are coming soon.</p>
            <input required placeholder="Product name" value={name} onChange={(e) => setName(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            <textarea required placeholder="What does your micro-tool do?" value={description} onChange={(e) => setDescription(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" rows={3} />
            <label className="block text-sm text-gray-600">
              Monthly price (USD)
              <input type="number" min={1} required value={price} onChange={(e) => setPrice(e.target.value)} className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </label>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button type="submit" disabled={submitting} className="w-full bg-indigo-600 text-white text-sm font-semibold py-2 rounded-lg disabled:opacity-60">
              {submitting ? "Creating…" : "Launch business"}
            </button>
            <p className="text-xs text-gray-400">You&apos;ll connect Whop payouts/KYC separately — that step stays manual.</p>
          </form>
        )}
      </div>
    </main>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-gray-500">{label}</span>
      <span className={mono ? "font-mono text-gray-800" : "text-gray-800"}>{value}</span>
    </div>
  );
}
