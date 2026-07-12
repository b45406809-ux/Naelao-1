"use client";

/**
 * Wallet Connect — the product's OWN payment account. Two rails:
 *  - Stripe: "Connect with Stripe" redirects to Stripe-HOSTED onboarding (a fresh, isolated
 *    Express business account — never the builder's personal account; Naelao never sees bank
 *    details). On return we poll status: the connection activates only when Stripe reports
 *    charges_enabled.
 *  - Lemon Squeezy: guided BYO (LS has no OAuth) — paste an API key from their own dedicated
 *    LS store, pick the store, done. The key is stored encrypted in the credentials vault.
 */

import { useCallback, useEffect, useState } from "react";
import {
  connectLemonSqueezyWallet,
  connectStripeWallet,
  disconnectWallet,
  getPaymentConnection,
} from "@/lib/api";
import type { LsStoreOption, PaymentConnection } from "@/lib/api";

const STATUS_CHIP: Record<PaymentConnection["status"], { label: string; className: string }> = {
  pending: { label: "Pending onboarding", className: "bg-amber-50 text-amber-700 border-amber-200" },
  active: { label: "Active", className: "bg-green-50 text-green-700 border-green-200" },
  error: { label: "Needs attention", className: "bg-red-50 text-red-700 border-red-200" },
  disabled: { label: "Disconnected", className: "bg-gray-50 text-gray-500 border-gray-200" },
};

export default function PaymentsAccountCard({ spaceId }: { spaceId: string }) {
  const [connection, setConnection] = useState<PaymentConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // LS guided flow state
  const [lsOpen, setLsOpen] = useState(false);
  const [lsApiKey, setLsApiKey] = useState("");
  const [lsStores, setLsStores] = useState<LsStoreOption[] | null>(null);
  const [lsStoreId, setLsStoreId] = useState("");

  // Disconnect confirm
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setConnection(await getPaymentConnection(spaceId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load payment connection");
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While Stripe onboarding is pending, the GET route live-polls Stripe and flips the
  // connection active on charges_enabled — re-fetch every 5s so a builder returning from the
  // hosted flow sees the status flip without a manual reload.
  useEffect(() => {
    if (connection?.provider !== "stripe" || connection.status !== "pending") return;
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [connection, refresh]);

  async function handleConnectStripe() {
    setBusy(true);
    setError(null);
    try {
      const { onboarding_url } = await connectStripeWallet(spaceId, window.location.href);
      window.location.href = onboarding_url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stripe connect failed");
      setBusy(false);
    }
  }

  async function handleLsSubmit() {
    setBusy(true);
    setError(null);
    try {
      if (!lsStores) {
        // Step 1 — verify the key, get the store list (nothing persisted yet).
        const res = await connectLemonSqueezyWallet(spaceId, lsApiKey);
        const stores = res.stores ?? [];
        const first = stores[0];
        if (!first) {
          setError("This API key has no stores — create a dedicated store in Lemon Squeezy first");
        } else {
          setLsStores(stores);
          setLsStoreId(first.id);
        }
      } else {
        // Step 2 — finalize with the chosen store.
        await connectLemonSqueezyWallet(spaceId, lsApiKey, lsStoreId);
        setLsOpen(false);
        setLsApiKey("");
        setLsStores(null);
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lemon Squeezy connect failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setBusy(true);
    setError(null);
    try {
      await disconnectWallet(spaceId);
      setConfirmDisconnect(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Disconnect failed");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return null;

  const chip = connection ? STATUS_CHIP[connection.status] : null;

  return (
    <div>
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Payments account</h2>
      <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2 text-sm">{error}</div>
        )}

        {connection ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span className="font-semibold text-gray-900">
                {connection.provider === "stripe" ? "Stripe" : "Lemon Squeezy"}
                {connection.details.store_name ? ` — ${connection.details.store_name}` : ""}
              </span>
              {chip && (
                <span className={`text-xs font-medium border rounded-full px-2.5 py-0.5 ${chip.className}`}>
                  {chip.label}
                </span>
              )}
            </div>
            <p className="text-sm text-gray-500">
              {connection.provider === "stripe"
                ? connection.status === "active"
                  ? "Sales are charged directly on your own Stripe business account; Stripe pays out to your bank. Naelao's platform fee is collected automatically per sale."
                  : "Finish Stripe's hosted onboarding to start accepting payments. This page updates automatically once Stripe verifies your details."
                : "Sales check out on your own Lemon Squeezy store — revenue settles with Lemon Squeezy directly to you. Naelao's platform fee is invoiced separately."}
            </p>
            {connection.provider === "lemon_squeezy" && !connection.details.webhook_created && (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                Order-sync webhook could not be created on your store — orders will not appear in
                Naelao until you disconnect and reconnect.
              </p>
            )}
            <div className="flex gap-3">
              {connection.provider === "stripe" && connection.status === "pending" && (
                <button
                  onClick={() => void handleConnectStripe()}
                  disabled={busy}
                  className="text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white rounded-lg px-4 py-2 disabled:opacity-50"
                >
                  Resume Stripe onboarding
                </button>
              )}
              {!confirmDisconnect ? (
                <button
                  onClick={() => setConfirmDisconnect(true)}
                  disabled={busy}
                  className="text-sm font-medium text-red-600 hover:text-red-700 border border-red-200 rounded-lg px-4 py-2 disabled:opacity-50"
                >
                  Disconnect
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-600">New sales fall back to Naelao&apos;s checkout. Disconnect?</span>
                  <button
                    onClick={() => void handleDisconnect()}
                    disabled={busy}
                    className="text-sm font-medium bg-red-600 hover:bg-red-700 text-white rounded-lg px-3 py-1.5 disabled:opacity-50"
                  >
                    Yes, disconnect
                  </button>
                  <button
                    onClick={() => setConfirmDisconnect(false)}
                    disabled={busy}
                    className="text-sm text-gray-500 hover:text-gray-700 px-2 py-1.5"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-gray-500">
              Connect your own payment account so product revenue settles directly with you — a
              fresh, isolated business account, never your personal one. Without a connection,
              sales run through Naelao&apos;s checkout and settle to your product wallet.
            </p>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="rounded-lg border border-gray-200 p-4 space-y-2">
                <p className="font-semibold text-gray-900">Stripe</p>
                <p className="text-xs text-gray-500">
                  Creates a new Stripe business account for this product. Stripe collects your
                  details on their own hosted page — Naelao never sees them.
                </p>
                <button
                  onClick={() => void handleConnectStripe()}
                  disabled={busy}
                  className="text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white rounded-lg px-4 py-2 disabled:opacity-50"
                >
                  Connect with Stripe
                </button>
              </div>
              <div className="rounded-lg border border-gray-200 p-4 space-y-2">
                <p className="font-semibold text-gray-900">Lemon Squeezy</p>
                <p className="text-xs text-gray-500">
                  Bring your own dedicated Lemon Squeezy store — paste an API key, pick the
                  store. The key is stored encrypted.
                </p>
                <button
                  onClick={() => setLsOpen(true)}
                  disabled={busy}
                  className="text-sm font-medium border border-gray-300 hover:bg-gray-50 text-gray-700 rounded-lg px-4 py-2 disabled:opacity-50"
                >
                  Connect Lemon Squeezy
                </button>
              </div>
            </div>

            {lsOpen && (
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-3">
                {!lsStores ? (
                  <>
                    <label className="block text-sm font-medium text-gray-700">
                      Lemon Squeezy API key
                      <input
                        type="password"
                        value={lsApiKey}
                        onChange={(e) => setLsApiKey(e.target.value)}
                        placeholder="lsq_api_..."
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                      />
                    </label>
                    <p className="text-xs text-gray-500">
                      Create one in your Lemon Squeezy dashboard → Settings → API. Use a store
                      dedicated to this product, not a personal one.
                    </p>
                  </>
                ) : (
                  <label className="block text-sm font-medium text-gray-700">
                    Pick the store to connect
                    <select
                      value={lsStoreId}
                      onChange={(e) => setLsStoreId(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
                    >
                      {lsStores.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => void handleLsSubmit()}
                    disabled={busy || (!lsStores && !lsApiKey)}
                    className="text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white rounded-lg px-4 py-2 disabled:opacity-50"
                  >
                    {lsStores ? "Connect store" : "Verify key"}
                  </button>
                  <button
                    onClick={() => {
                      setLsOpen(false);
                      setLsStores(null);
                      setLsApiKey("");
                    }}
                    disabled={busy}
                    className="text-sm text-gray-500 hover:text-gray-700 px-3 py-2"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
