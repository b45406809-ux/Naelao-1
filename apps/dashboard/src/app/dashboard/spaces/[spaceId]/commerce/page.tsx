"use client";

// Launchpad commerce console (spec §11). Surfaces the manifest's Revenue / Products / Orders
// sidebar items in one page. Products are CRUD; orders + revenue are read-only rollups
// written by the Lemon Squeezy webhook. Money-in flows only through Naelao's store, so the
// fee column here is the platform cut already captured on each order.

import { useEffect, useState, FormEvent } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  listProducts, createProduct, updateProduct, deleteProduct,
  listOrders, getRevenue,
} from "@/lib/api";
import type { Product, Order, RevenueSummary } from "@/lib/api";

function money(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 }).format(cents / 100);
}

const PRODUCT_STATUS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-600",
  published: "bg-green-100 text-green-700",
  archived: "bg-gray-100 text-gray-400",
};
const ORDER_STATUS: Record<string, string> = {
  paid: "bg-blue-100 text-blue-700",
  fulfilling: "bg-yellow-100 text-yellow-700",
  fulfilled: "bg-green-100 text-green-700",
  refunded: "bg-gray-100 text-gray-500",
  failed: "bg-red-100 text-red-700",
};

function Badge({ map, status }: { map: Record<string, string>; status: string }) {
  return <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium capitalize ${map[status] ?? "bg-gray-100 text-gray-500"}`}>{status}</span>;
}

function RevenueCards({ rev }: { rev: RevenueSummary }) {
  const cards = [
    { label: "Gross Revenue", value: money(rev.gross_cents, rev.currency), highlight: false },
    { label: "Platform Fee", value: money(rev.fee_cents, rev.currency), highlight: false, muted: true },
    { label: "Net to You", value: money(rev.net_cents, rev.currency), highlight: true },
    { label: "Orders", value: String(rev.order_count), muted: true },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
      {cards.map((c) => (
        <div key={c.label} className={`rounded-xl border p-4 ${c.highlight ? "border-brand-200 bg-brand-50" : "border-gray-200 bg-white"}`}>
          <p className="text-xs text-gray-500 mb-1">{c.label}</p>
          <p className={`text-xl font-bold ${c.highlight ? "text-brand-700" : c.muted ? "text-gray-500" : "text-gray-900"}`}>{c.value}</p>
        </div>
      ))}
    </div>
  );
}

function NewProductForm({ spaceId, onCreated }: { spaceId: string; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError("Name is required"); return; }
    setBusy(true); setError(null);
    try {
      await createProduct(spaceId, { name: name.trim(), price_cents: Math.round(parseFloat(price || "0") * 100) });
      setName(""); setPrice("");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create product");
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3 bg-white border border-gray-200 rounded-xl p-4 mb-4">
      <div className="flex-1 min-w-[180px]">
        <label className="block text-xs font-medium text-gray-600 mb-1">Product name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pro Course"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 outline-none" />
      </div>
      <div className="w-32">
        <label className="block text-xs font-medium text-gray-600 mb-1">Price (USD)</label>
        <input value={price} onChange={(e) => setPrice(e.target.value)} type="number" min="0" step="0.01" placeholder="0.00"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 outline-none" />
      </div>
      <button type="submit" disabled={busy}
        className="px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-brand-300 text-white text-sm font-semibold rounded-lg">
        {busy ? "Adding…" : "+ Add product"}
      </button>
      {error && <p className="w-full text-sm text-red-600">{error}</p>}
    </form>
  );
}

export default function CommercePage() {
  const params = useParams<{ spaceId: string }>();
  const spaceId = params.spaceId;
  const [tab, setTab] = useState<"products" | "orders">("products");
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [revenue, setRevenue] = useState<RevenueSummary | null>(null);
  const [currency, setCurrency] = useState("USD");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const [p, o, r] = await Promise.all([listProducts(spaceId), listOrders(spaceId), getRevenue(spaceId)]);
      setProducts(p.data); setCurrency(p.currency);
      setOrders(o.data); setRevenue(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load commerce data");
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [spaceId]);

  async function togglePublish(p: Product) {
    await updateProduct(spaceId, p.id, { status: p.status === "published" ? "draft" : "published" });
    void load();
  }
  async function remove(p: Product) {
    await deleteProduct(spaceId, p.id);
    void load();
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <Link href="/dashboard/spaces" className="text-sm text-brand-600 hover:underline">← Spaces</Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-1">Commerce</h1>
        <p className="text-gray-500 mt-1">Products, orders, and revenue for this Launchpad.</p>
      </div>

      {loading && <div className="text-center py-12 text-gray-400">Loading…</div>}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 mb-6 flex items-center justify-between">
          <span>{error}</span>
          <button type="button" onClick={() => void load()} className="text-sm underline">Retry</button>
        </div>
      )}

      {!loading && !error && (
        <>
          {revenue && <RevenueCards rev={revenue} />}

          <div className="flex gap-2 mb-4 border-b border-gray-200">
            {(["products", "orders"] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTab(t)}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px capitalize ${
                  tab === t ? "border-brand-600 text-brand-700" : "border-transparent text-gray-500 hover:text-gray-800"
                }`}>
                {t}
              </button>
            ))}
          </div>

          {tab === "products" && (
            <>
              <NewProductForm spaceId={spaceId} onCreated={load} />
              {products.length === 0 ? (
                <p className="text-sm text-gray-400 py-8 text-center">No products yet. Add one above, or ask your assistant to create one.</p>
              ) : (
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-gray-200 bg-gray-50">
                      <th className="text-left px-6 py-3 font-semibold text-gray-600">Product</th>
                      <th className="text-left px-6 py-3 font-semibold text-gray-600">Price</th>
                      <th className="text-left px-6 py-3 font-semibold text-gray-600">Status</th>
                      <th className="text-right px-6 py-3 font-semibold text-gray-600">Actions</th>
                    </tr></thead>
                    <tbody className="divide-y divide-gray-100">
                      {products.map((p) => (
                        <tr key={p.id} className="hover:bg-gray-50">
                          <td className="px-6 py-4">
                            <p className="font-medium text-gray-900">{p.name}</p>
                            {p.description && <p className="text-xs text-gray-400 truncate max-w-xs">{p.description}</p>}
                          </td>
                          <td className="px-6 py-4 text-gray-700">{money(p.price_cents, p.currency)}</td>
                          <td className="px-6 py-4"><Badge map={PRODUCT_STATUS} status={p.status} /></td>
                          <td className="px-6 py-4 text-right">
                            <div className="inline-flex items-center gap-3">
                              <button type="button" onClick={() => void togglePublish(p)}
                                className="text-brand-600 hover:underline text-xs font-medium">
                                {p.status === "published" ? "Unpublish" : "Publish"}
                              </button>
                              <button type="button" onClick={() => void remove(p)} className="text-gray-400 hover:text-red-600 text-xs">Archive</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {tab === "orders" && (
            orders.length === 0 ? (
              <p className="text-sm text-gray-400 py-8 text-center">No orders yet.</p>
            ) : (
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-gray-200 bg-gray-50">
                    <th className="text-left px-6 py-3 font-semibold text-gray-600">Product</th>
                    <th className="text-left px-6 py-3 font-semibold text-gray-600">Customer</th>
                    <th className="text-left px-6 py-3 font-semibold text-gray-600">Gross</th>
                    <th className="text-left px-6 py-3 font-semibold text-gray-600">Fee</th>
                    <th className="text-left px-6 py-3 font-semibold text-gray-600">Net</th>
                    <th className="text-left px-6 py-3 font-semibold text-gray-600">Status</th>
                    <th className="text-left px-6 py-3 font-semibold text-gray-600">Date</th>
                  </tr></thead>
                  <tbody className="divide-y divide-gray-100">
                    {orders.map((o) => (
                      <tr key={o.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 text-gray-900">{o.product_name ?? "—"}</td>
                        <td className="px-6 py-4 text-gray-500">{o.customer_email ?? "—"}</td>
                        <td className="px-6 py-4 text-gray-700">{money(o.gross_cents, o.currency)}</td>
                        <td className="px-6 py-4 text-gray-400">{money(o.fee_cents, o.currency)}</td>
                        <td className="px-6 py-4 font-medium text-gray-900">{money(o.net_cents, o.currency)}</td>
                        <td className="px-6 py-4"><Badge map={ORDER_STATUS} status={o.status} /></td>
                        <td className="px-6 py-4 text-gray-500">{new Date(o.created_at).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}
