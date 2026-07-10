"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getBuilderProductWallet } from "@/lib/api";
import type { BuilderProductWallet } from "@/lib/api";

function centsToDisplay(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 }).format(cents / 100);
}

// F-WALLET-6: the builder's Wallet tab — the aggregate money-in view across this product's child
// businesses (gross, the Naelao cut, the builder's own cut, and the net settled to the businesses'
// wallets) plus the builder's own earned revenue share by currency.
export default function ProductWalletPage() {
  const params = useParams<{ productId: string }>();
  const [wallet, setWallet] = useState<BuilderProductWallet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        setWallet(await getBuilderProductWallet(params.productId));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load wallet");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [params.productId]);

  if (loading) return <div className="text-center py-12 text-gray-400">Loading…</div>;
  if (error) return <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3">{error}</div>;

  const b = wallet?.businesses;
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-1">
          Your businesses&apos; sales
        </h2>
        <p className="text-xs text-gray-400 mb-3">
          Every storefront/seat sale across this product&apos;s businesses. Each sale settles to the
          business&apos;s own wallet after two deductions — Naelao&apos;s platform fee and your
          configured builder share. {b?.order_count ?? 0} settled order(s).
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-500 mb-1">Gross sales</p>
            <p className="text-xl font-bold text-gray-900">{centsToDisplay(b?.gross_cents ?? 0)}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-500 mb-1">Naelao cut</p>
            <p className="text-xl font-bold text-gray-500">{centsToDisplay(b?.naelao_cut_cents ?? 0)}</p>
          </div>
          <div className="rounded-xl border border-brand-200 bg-brand-50 p-4">
            <p className="text-xs text-gray-500 mb-1">Your builder cut</p>
            <p className="text-xl font-bold text-brand-700">{centsToDisplay(b?.builder_cut_cents ?? 0)}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-500 mb-1">Net to businesses</p>
            <p className="text-xl font-bold text-gray-900">{centsToDisplay(b?.net_settled_cents ?? 0)}</p>
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-1">
          Your earned revenue share
        </h2>
        <p className="text-xs text-gray-400 mb-3">
          The builder share you&apos;ve earned across all this product&apos;s businesses (net of
          refunds), by currency. Withdraw via the Payouts flow.
        </p>
        {(wallet?.builder_revenue_share.length ?? 0) === 0 ? (
          <p className="text-sm text-gray-400">No builder revenue share earned yet.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {wallet!.builder_revenue_share.map((r) => (
              <div key={r.currency} className="rounded-xl border border-brand-200 bg-brand-50 p-4">
                <p className="text-xs text-gray-500 mb-1">{r.currency}</p>
                <p className="text-xl font-bold text-brand-700">{centsToDisplay(r.earned_cents, r.currency)}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
