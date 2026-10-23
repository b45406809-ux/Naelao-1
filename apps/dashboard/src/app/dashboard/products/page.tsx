"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { listBuilderProductsPage } from "@/lib/api";
import type { BuilderProductPage, BuilderProductSummary } from "@/lib/api";
import { productShellDisplay } from "@/lib/product-url";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  provisioning: "bg-blue-100 text-blue-700",
  paused: "bg-yellow-100 text-yellow-700",
  suspended: "bg-red-100 text-red-700",
  deleted: "bg-gray-100 text-gray-500",
};

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? "bg-gray-100 text-gray-500";
  return (
    <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium capitalize ${color}`}>
      {status}
    </span>
  );
}

export default function ProductsPage() {
  const [products, setProducts] = useState<BuilderProductSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState<BuilderProductPage | null>(null);
  const loadRevision = useRef(0);

  async function load(requestedPage = page) {
    const revision = ++loadRevision.current;
    setLoading(true);
    setError(null);
    try {
      const result = await listBuilderProductsPage(requestedPage);
      if (revision !== loadRevision.current) return;
      setProducts(result.data);
      setPageInfo(result);
      setPage(result.page);
    } catch (err) {
      if (revision !== loadRevision.current) return;
      setError(err instanceof Error ? err.message : "Failed to load products");
    } finally {
      if (revision === loadRevision.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load(1);
    return () => { loadRevision.current++; };
  }, []);

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Products</h1>
          <p className="text-gray-500 mt-1">
            The customer-facing businesses you&apos;ve launched on Naelao.
          </p>
        </div>
        <Link
          href="/dashboard/products/new"
          className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 transition-colors"
        >
          + New Product
        </Link>
      </div>

      {loading && <div className="text-center py-12 text-gray-400">Loading...</div>}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 mb-6">
          {error}
          <button type="button" onClick={() => void load()} className="ml-3 text-sm underline">
            Retry
          </button>
        </div>
      )}

      {!loading && !error && pageInfo?.product_count === 0 && (
        <div className="bg-white rounded-xl border border-dashed border-gray-300 p-12 text-center">
          <p className="text-gray-500 mb-4">No products yet.</p>
          <Link
            href="/dashboard/products/new"
            className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 transition-colors"
          >
            Launch your first product
          </Link>
        </div>
      )}

      {!loading && !error && products.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <caption className="sr-only">Products</caption>
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th scope="col" className="text-left px-6 py-3 font-semibold text-gray-600">Name</th>
                <th scope="col" className="text-left px-6 py-3 font-semibold text-gray-600">Domain</th>
                <th scope="col" className="text-left px-6 py-3 font-semibold text-gray-600">Status</th>
                <th scope="col" className="text-left px-6 py-3 font-semibold text-gray-600">Created</th>
                <th scope="col" className="text-right px-6 py-3 font-semibold text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {products.map((p) => (
                <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4 font-medium text-gray-900">{p.name}</td>
                  <td className="px-6 py-4 text-gray-500">
                    {productShellDisplay(p.product_slug) ?? "—"}
                  </td>
                  <td className="px-6 py-4">
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="px-6 py-4 text-gray-500">
                    {new Date(p.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Link
                      href={`/dashboard/products/${encodeURIComponent(p.id)}`}
                      className="text-brand-600 hover:underline text-xs font-medium"
                    >
                      Manage
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {pageInfo && pageInfo.page_count > 1 && (
            <nav aria-label="Product pages" className="px-6 py-4 border-t border-gray-100 flex items-center justify-between gap-4">
              <span className="text-xs text-gray-500" aria-live="polite">
                Showing {(pageInfo.page - 1) * pageInfo.page_size + 1}–{Math.min(pageInfo.page * pageInfo.page_size, pageInfo.product_count)} of {pageInfo.product_count}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void load(pageInfo.page - 1)}
                  disabled={loading || pageInfo.page <= 1}
                  className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg disabled:opacity-50"
                >
                  Previous
                </button>
                <span className="text-xs text-gray-500" aria-label={`Page ${pageInfo.page} of ${pageInfo.page_count}`}>
                  {pageInfo.page} / {pageInfo.page_count}
                </span>
                <button
                  type="button"
                  onClick={() => void load(pageInfo.page + 1)}
                  disabled={loading || pageInfo.page >= pageInfo.page_count}
                  className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </nav>
          )}
        </div>
      )}
    </div>
  );
}
