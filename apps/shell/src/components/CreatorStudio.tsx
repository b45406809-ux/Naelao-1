"use client";

import { useState, useEffect } from "react";
import {
  getCreatorStudio,
  publishTemplateVersionUpdate,
  type CreatorStudioData,
  type SessionCredentials,
} from "../lib/api";

interface CreatorStudioProps {
  productSpaceId: string;
  session: SessionCredentials;
}

export function CreatorStudio({ productSpaceId, session }: CreatorStudioProps) {
  const [data, setData] = useState<CreatorStudioData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Push Update modal
  const [updatingListingId, setUpdatingListingId] = useState<string | null>(null);
  const [updateVersion, setUpdateVersion] = useState("1.1.0");
  const [releaseNotes, setReleaseNotes] = useState("Updated agent system prompts and added new task DAG workflows.");
  const [broadcasting, setBroadcasting] = useState(false);

  useEffect(() => {
    loadStudioData();
  }, [productSpaceId]);

  async function loadStudioData() {
    setLoading(true);
    setError(null);
    try {
      const res = await getCreatorStudio(productSpaceId, session);
      setData(res);
    } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      setError(err?.message || "Failed to load creator studio data.");
    } finally {
      setLoading(false);
    }
  }

  async function handleBroadcastUpdate() {
    if (!updatingListingId) return;
    setBroadcasting(true);
    try {
      await publishTemplateVersionUpdate(
        updatingListingId,
        { version: updateVersion, releaseNotes },
        session
      );
      alert(`Version ${updateVersion} successfully broadcasted to all licensees!`);
      setUpdatingListingId(null);
      loadStudioData();
    } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      alert(err?.message || "Failed to broadcast version update.");
    } finally {
      setBroadcasting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-4 text-sm text-rose-700 dark:text-rose-300">
        {error || "Unable to load Creator Studio analytics."}
      </div>
    );
  }

  const { metrics, listings, recent_activity } = data;

  return (
    <div id="creator-studio-view" className="space-y-6">
      {/* Metrics Row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Monthly Recurring Earnings */}
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Monthly Creator MRR
          </div>
          <div className="mt-2 text-2xl font-black text-emerald-600 dark:text-emerald-400">
            ${(metrics.monthly_creator_earnings_cents / 100).toFixed(2)}
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">
            80% creator net share from active subscriptions
          </div>
        </div>

        {/* Active Licensees */}
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Active Licensees
          </div>
          <div className="mt-2 text-2xl font-black text-zinc-900 dark:text-zinc-100">
            {metrics.active_licensees}
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">
            Companies running your studio blueprints
          </div>
        </div>

        {/* Lifetime Earnings */}
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Lifetime Net Payouts
          </div>
          <div className="mt-2 text-2xl font-black text-zinc-900 dark:text-zinc-100">
            ${(metrics.lifetime_creator_earnings_cents / 100).toFixed(2)}
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">
            Settled via automated builder revenue rails
          </div>
        </div>

        {/* Conversion Rate & Quality */}
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Avg Rating & Conversion
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-black text-zinc-900 dark:text-zinc-100">
              ★ {metrics.average_rating.toFixed(1)}
            </span>
            <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
              {metrics.conversion_rate_pct}% Conv
            </span>
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">
            Based on marketplace discovery traffic
          </div>
        </div>
      </div>

      {/* Published Blueprints Table */}
      <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-100 pb-4 dark:border-zinc-800">
          <div>
            <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
              Your Published Blueprints & Studios
            </h3>
            <p className="text-xs text-zinc-500">
              Manage versions, pricing, and broadcast security/prompt updates to active licensees.
            </p>
          </div>
        </div>

        {listings.length === 0 ? (
          <div className="p-8 text-center text-xs text-zinc-500">
            You have not exported any workspace blueprints yet. Click "Export as Template" in any studio to publish!
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-zinc-100 text-zinc-400 dark:border-zinc-800">
                  <th className="pb-3 font-semibold">TEMPLATE NAME</th>
                  <th className="pb-3 font-semibold">CATEGORY</th>
                  <th className="pb-3 font-semibold">PRICING</th>
                  <th className="pb-3 font-semibold">LICENSEES</th>
                  <th className="pb-3 font-semibold">SAFETY AUDIT</th>
                  <th className="pb-3 font-semibold">VERSION</th>
                  <th className="pb-3 text-right font-semibold">ACTIONS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {listings.map((l) => (
                  <tr key={l.id} className="text-zinc-800 dark:text-zinc-200">
                    <td className="py-3 font-bold">{l.name}</td>
                    <td className="py-3">
                      <span className="rounded bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold dark:bg-zinc-800">
                        {l.category}
                      </span>
                    </td>
                    <td className="py-3 font-medium">
                      {l.pricing_model === "free"
                        ? "Free"
                        : l.pricing_model === "recurring_monthly"
                        ? `$${(l.price_cents / 100).toFixed(2)}/mo`
                        : l.pricing_model === "gmv_royalty"
                        ? `${(l.royalty_share_bps / 100).toFixed(1)}% Royalty`
                        : `$${(l.price_cents / 100).toFixed(2)}`}
                    </td>
                    <td className="py-3 font-bold">{l.active_licensees_count}</td>
                    <td className="py-3">
                      <span className="inline-flex items-center gap-1 font-semibold text-emerald-600 dark:text-emerald-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        {l.safety_score}% Passed
                      </span>
                    </td>
                    <td className="py-3">v{l.version}</td>
                    <td className="py-3 text-right">
                      <button
                        onClick={() => {
                          setUpdatingListingId(l.id);
                          setUpdateVersion(`1.${Number(l.version.split(".")[1] || 0) + 1}.0`);
                        }}
                        className="rounded-lg bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-800 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                      >
                        Push Update
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent Payout & Royalty Activity Feed */}
      <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
          Live Royalty & Payout Feed
        </h3>
        <p className="text-xs text-zinc-500">
          Real-time settlement stream from template sales and monthly recurring licenses.
        </p>

        {recent_activity.length === 0 ? (
          <div className="p-6 text-center text-xs text-zinc-500">
            No sales recorded yet. Your revenue will appear here automatically upon first license!
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {recent_activity.map((act) => (
              <div
                key={act.id}
                className="flex items-center justify-between rounded-xl border border-zinc-100 bg-zinc-50/50 p-3 text-xs dark:border-zinc-800/60 dark:bg-zinc-800/30"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/10 font-bold text-emerald-600 dark:text-emerald-400">
                    $
                  </span>
                  <div>
                    <div className="font-semibold text-zinc-900 dark:text-zinc-100">
                      {act.title}
                    </div>
                    <div className="text-[10px] text-zinc-400">
                      Gross: ${(act.gross_cents / 100).toFixed(2)} • Net: ${(act.amount_cents / 100).toFixed(2)} (80% Take)
                    </div>
                  </div>
                </div>
                <div className="text-[10px] text-zinc-400">
                  {new Date(act.created_at).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Push Version Update Modal */}
      {updatingListingId && (
        <div id="push-update-modal-overlay" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div id="push-update-modal" className="relative w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                Broadcast Blueprint Version Update
              </h3>
              <button
                onClick={() => setUpdatingListingId(null)}
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  New Version Tag
                </label>
                <input
                  type="text"
                  value={updateVersion}
                  onChange={(e) => setUpdateVersion(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-900 focus:outline-none dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-100"
                  placeholder="e.g. 1.2.0"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  Release Notes
                </label>
                <textarea
                  rows={3}
                  value={releaseNotes}
                  onChange={(e) => setReleaseNotes(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-900 focus:outline-none dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-100"
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setUpdatingListingId(null)}
                disabled={broadcasting}
                className="rounded-xl border border-zinc-200 px-4 py-2 text-xs font-semibold text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
              >
                Cancel
              </button>
              <button
                onClick={handleBroadcastUpdate}
                disabled={broadcasting}
                className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {broadcasting ? "Broadcasting..." : "Broadcast to Licensees"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
