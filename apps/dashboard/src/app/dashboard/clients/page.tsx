"use client";

import { useEffect, useState } from "react";
import { getResellerClients } from "@/lib/api";
import type { ResellerClient, ResellerClientsResponse } from "@/lib/api";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  inactive: "bg-gray-100 text-gray-500",
  suspended: "bg-red-100 text-red-700",
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_COLORS[status] ?? "bg-gray-100 text-gray-500";
  return (
    <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium capitalize ${cls}`}>
      {status}
    </span>
  );
}

function centsToDisplay(cents: number): string {
  const dollars = cents / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(dollars);
}

function BillingSummary({
  billing,
  period,
}: {
  billing: ResellerClientsResponse["billing"];
  period: string;
}) {
  const cards = [
    { label: "Retail Revenue", value: centsToDisplay(billing.retail), muted: false },
    { label: "Wholesale Cost", value: centsToDisplay(billing.wholesale), muted: true },
    { label: "Net Margin", value: centsToDisplay(billing.margin), muted: false, highlight: true },
    { label: "Billing Events", value: String(billing.events), muted: true },
  ];

  return (
    <div className="mb-6">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
        {period} · Billing Summary
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {cards.map((card) => (
          <div
            key={card.label}
            className={`rounded-xl border p-4 ${
              card.highlight
                ? "border-brand-200 bg-brand-50"
                : "border-gray-200 bg-white"
            }`}
          >
            <p className="text-xs text-gray-500 mb-1">{card.label}</p>
            <p
              className={`text-xl font-bold ${
                card.highlight ? "text-brand-700" : card.muted ? "text-gray-500" : "text-gray-900"
              }`}
            >
              {card.value}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ClientRow({ client }: { client: ResellerClient }) {
  const joined = new Date(client.created_at).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const shortId = client.child_tenant_id.slice(0, 8);

  return (
    <tr className="hover:bg-gray-50 transition-colors">
      <td className="px-6 py-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-brand-100 flex items-center justify-center flex-shrink-0">
            <span className="text-xs font-bold text-brand-700">
              {shortId[0]?.toUpperCase() ?? "?"}
            </span>
          </div>
          <div>
            <p className="text-sm font-medium text-gray-900 font-mono">{shortId}…</p>
            <p className="text-xs text-gray-400 font-mono">
              owner: {client.child_owner_user_id.slice(0, 8)}…
            </p>
          </div>
        </div>
      </td>
      <td className="px-6 py-4 text-sm text-gray-700 text-center">
        {client.space_count}
      </td>
      <td className="px-6 py-4">
        <StatusBadge status={client.status} />
      </td>
      <td className="px-6 py-4 text-sm text-gray-500">{joined}</td>
    </tr>
  );
}

export default function ClientsPage() {
  const [data, setData] = useState<ResellerClientsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await getResellerClients();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load clients");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Client Portfolio</h1>
        <p className="text-gray-500 mt-1">
          Businesses created under your reseller program
        </p>
      </div>

      {loading && (
        <div className="text-center py-12 text-gray-400">Loading…</div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 mb-6 flex items-center justify-between">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="text-sm underline ml-4 flex-shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && data && (
        <>
          <BillingSummary billing={data.billing} period={data.current_period} />

          {data.clients.length === 0 ? (
            <div className="bg-white rounded-xl border border-dashed border-gray-300 p-12 text-center">
              <p className="text-gray-500 text-sm">No clients yet.</p>
              <p className="text-gray-400 text-xs mt-1">
                Clients appear here when users sign up through your product&apos;s
                public portal.
              </p>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                <p className="text-sm font-semibold text-gray-700">
                  {data.client_count} client{data.client_count !== 1 ? "s" : ""}
                </p>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    <th className="text-left px-6 py-3 font-semibold text-gray-600">
                      Tenant
                    </th>
                    <th className="text-center px-6 py-3 font-semibold text-gray-600">
                      Spaces
                    </th>
                    <th className="text-left px-6 py-3 font-semibold text-gray-600">
                      Status
                    </th>
                    <th className="text-left px-6 py-3 font-semibold text-gray-600">
                      Joined
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.clients.map((client) => (
                    <ClientRow key={client.child_tenant_id} client={client} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
