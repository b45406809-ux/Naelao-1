"use client";

/**
 * Business Wallet — every business auto-provisions an isolated Whop sub-merchant wallet the
 * moment it's created (no builder action, no OAuth, no personal bank/card details). Revenue from
 * Whop's own storefront/checkout and connected 3rd-party platforms settles here automatically;
 * this card is read-mostly (balance, recent activity, payout destinations/history) since the
 * assistant runs the wallet day-to-day — a builder mainly watches it and adds a payout
 * destination when they actually want to be paid.
 */

import { useCallback, useEffect, useState } from "react";
import {
  getBusinessWalletBalance,
  getBusinessWalletTransactions,
  getPayoutDestinations,
  addPayoutDestination,
  getPayoutRequests,
} from "@/lib/api";
import type { BusinessWalletBalance, WalletTransaction, PayoutDestination, PayoutRequest } from "@/lib/api";

const STATUS_CHIP: Record<BusinessWalletBalance["status"], { label: string; className: string }> = {
  active: { label: "Active", className: "bg-green-50 text-green-700 border-green-200" },
  pending: { label: "Provisioning", className: "bg-amber-50 text-amber-700 border-amber-200" },
  awaiting_kyc: { label: "Verification needed", className: "bg-amber-50 text-amber-700 border-amber-200" },
  error: { label: "Needs attention", className: "bg-red-50 text-red-700 border-red-200" },
  not_provisioned: { label: "Not provisioned yet", className: "bg-gray-50 text-gray-500 border-gray-200" },
};

function centsToDisplay(cents: number | undefined, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 }).format((cents ?? 0) / 100);
}

export default function PaymentsAccountCard({ spaceId }: { spaceId: string }) {
  const [balance, setBalance] = useState<BusinessWalletBalance | null>(null);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [destinations, setDestinations] = useState<PayoutDestination[]>([]);
  const [payouts, setPayouts] = useState<PayoutRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [destType, setDestType] = useState<PayoutDestination["type"]>("bank");
  const [destLabel, setDestLabel] = useState("");
  const [destDetails, setDestDetails] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [b, t, d, p] = await Promise.all([
        getBusinessWalletBalance(spaceId),
        getBusinessWalletTransactions(spaceId, 20),
        getPayoutDestinations(spaceId),
        getPayoutRequests(spaceId),
      ]);
      setBalance(b);
      setTransactions(t);
      setDestinations(d);
      setPayouts(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load wallet");
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleAddDestination() {
    if (!destLabel) return;
    setBusy(true);
    setError(null);
    try {
      let details: Record<string, unknown>;
      try {
        details = destDetails ? (JSON.parse(destDetails) as Record<string, unknown>) : {};
      } catch {
        details = { raw: destDetails };
      }
      await addPayoutDestination(spaceId, { type: destType, label: destLabel, details });
      setAddOpen(false);
      setDestLabel("");
      setDestDetails("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add payout destination");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return null;

  const chip = balance ? STATUS_CHIP[balance.status] : null;
  const currency = balance?.currency ?? "USD";

  return (
    <div>
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Business wallet</h2>
      <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2 text-sm">{error}</div>
        )}

        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-gray-500 mb-1">Wallet balance</p>
            <p className="text-2xl font-bold text-gray-900">{centsToDisplay(balance?.balance_cents, currency)}</p>
          </div>
          {chip && (
            <span className={`text-xs font-medium border rounded-full px-2.5 py-0.5 ${chip.className}`}>
              {chip.label}
            </span>
          )}
        </div>
        <p className="text-sm text-gray-500">
          This business&apos;s own Whop sub-merchant wallet — revenue from Whop&apos;s own storefront/checkout
          and any connected 3rd-party platform settles here automatically. Naelao never holds this
          money; Whop custodies it and handles payout compliance.
        </p>

        {balance?.status === "awaiting_kyc" && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-3 text-sm space-y-2">
            <p className="font-medium">One more step to enable payouts</p>
            <p>
              Your wallet can already receive revenue, but Whop requires a quick identity
              verification before it can send payouts.
              {balance.onboarding_url ? " Complete it here:" : " Check your email for a verification link from Whop, or ask them to resend it."}
            </p>
            {balance.onboarding_url && (
              <a
                href={balance.onboarding_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block text-sm font-medium bg-amber-600 hover:bg-amber-700 text-white rounded-lg px-3 py-1.5"
              >
                Complete verification
              </a>
            )}
          </div>
        )}

        {transactions.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Recent activity</p>
            <div className="divide-y divide-gray-100 border border-gray-100 rounded-lg overflow-hidden">
              {transactions.slice(0, 8).map((t, i) => (
                <div key={i} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="text-gray-700">{t.description ?? t.type}</span>
                  <span className={t.amount_cents >= 0 ? "text-green-700 font-medium" : "text-gray-600"}>
                    {t.amount_cents >= 0 ? "+" : ""}
                    {centsToDisplay(t.amount_cents, t.currency)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Payout destinations</p>
            {!addOpen && (
              <button
                onClick={() => setAddOpen(true)}
                className="text-xs font-medium text-brand-600 hover:text-brand-700"
              >
                + Add destination
              </button>
            )}
          </div>
          {destinations.length === 0 && !addOpen && (
            <p className="text-sm text-gray-400">No payout destination on file yet.</p>
          )}
          {destinations.map((d) => (
            <div key={d.id} className="flex items-center justify-between text-sm py-1.5">
              <span className="text-gray-700">{d.label} ({d.type})</span>
              <span className={`text-xs ${d.status === "verified" ? "text-green-600" : "text-amber-600"}`}>{d.status}</span>
            </div>
          ))}
          {addOpen && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-3 mt-2">
              <label className="block text-sm font-medium text-gray-700">
                Type
                <select
                  value={destType}
                  onChange={(e) => setDestType(e.target.value as PayoutDestination["type"])}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
                >
                  <option value="bank">Bank</option>
                  <option value="crypto">Crypto</option>
                  <option value="venmo">Venmo</option>
                  <option value="cashapp">CashApp</option>
                </select>
              </label>
              <label className="block text-sm font-medium text-gray-700">
                Label
                <input
                  value={destLabel}
                  onChange={(e) => setDestLabel(e.target.value)}
                  placeholder="e.g. Chase checking ...1234"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="block text-sm font-medium text-gray-700">
                Details (routing/account number, wallet address, handle — stored encrypted)
                <textarea
                  value={destDetails}
                  onChange={(e) => setDestDetails(e.target.value)}
                  rows={2}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
              <div className="flex gap-2">
                <button
                  onClick={() => void handleAddDestination()}
                  disabled={busy || !destLabel}
                  className="text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white rounded-lg px-4 py-2 disabled:opacity-50"
                >
                  Save destination
                </button>
                <button
                  onClick={() => setAddOpen(false)}
                  disabled={busy}
                  className="text-sm text-gray-500 hover:text-gray-700 px-3 py-2"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {payouts.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Payout history</p>
            <div className="divide-y divide-gray-100 border border-gray-100 rounded-lg overflow-hidden">
              {payouts.slice(0, 5).map((p) => (
                <div key={p.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="text-gray-700">{centsToDisplay(p.amount_cents, currency)}</span>
                  <span className="text-xs text-gray-500">{p.status}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
