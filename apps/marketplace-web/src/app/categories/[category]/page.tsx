"use client";

export const runtime = "edge";

// G-M06: Category browsing page — filtered view of marketplace by category

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { listListings, CATEGORY_LABELS, type SpaceTypeListing, type Category, type SortBy } from "@/lib/api";

function ListingCard({ listing }: { listing: SpaceTypeListing }) {
  return (
    <Link href={`/listing/${listing.id}`} className="group bg-white rounded-xl border border-gray-200 p-5 hover:border-brand-300 hover:shadow-md transition-all block">
      <div className="w-10 h-10 rounded-xl bg-brand-100 flex items-center justify-center mb-3">
        <svg className="w-5 h-5 text-brand-600" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
          <path fillRule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clipRule="evenodd" />
        </svg>
      </div>
      <h3 className="font-semibold text-gray-900 mb-1 group-hover:text-brand-700 transition-colors">{listing.name}</h3>
      <p className="text-sm text-gray-500 mb-3 line-clamp-2">{listing.description}</p>
      <div className="flex items-center justify-between text-xs text-gray-400">
        <span>{listing.install_count.toLocaleString()} uses</span>
        <span>★ {listing.avg_rating.toFixed(1)}</span>
      </div>
    </Link>
  );
}

export default function CategoryPage() {
  const { category } = useParams<{ category: string }>();
  const label = CATEGORY_LABELS[category as Category] ?? category;
  const [listings, setListings] = useState<SpaceTypeListing[]>([]);
  const [sort, setSort] = useState<SortBy>("installs");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const PER_PAGE = 12;

  useEffect(() => {
    setLoading(true);
    void listListings({ category, sort, page, per_page: PER_PAGE })
      .then((r) => { setListings(r.data); setTotal(r.meta.total); })
      .catch(() => { /* ignore */ })
      .finally(() => setLoading(false));
  }, [category, sort, page]);

  const totalPages = Math.ceil(total / PER_PAGE);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-6">
        <Link href="/" className="hover:text-brand-700">Marketplace</Link>
        <span>/</span>
        <span className="text-gray-900 font-medium">{label}</span>
      </div>

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{label}</h1>
        <select value={sort} onChange={(e) => { setSort(e.target.value as SortBy); setPage(1); }}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white">
          <option value="installs">Most installed</option>
          <option value="rating">Top rated</option>
          <option value="newest">Newest</option>
        </select>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-200 p-5 animate-pulse">
              <div className="w-10 h-10 bg-gray-200 rounded-xl mb-3" />
              <div className="h-4 bg-gray-200 rounded mb-2 w-3/4" />
              <div className="h-3 bg-gray-100 rounded w-full" />
            </div>
          ))}
        </div>
      ) : listings.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <p className="text-sm">No templates in this category yet.</p>
          <Link href="/" className="mt-3 inline-block text-sm text-brand-600 hover:underline">Browse all templates</Link>
        </div>
      ) : (
        <>
          <p className="text-sm text-gray-500 mb-4">{total.toLocaleString()} template{total !== 1 ? "s" : ""}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {listings.map((l) => <ListingCard key={l.id} listing={l} />)}
          </div>
          {totalPages > 1 && (
            <div className="flex justify-center gap-2 mt-10">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40">
                Previous
              </button>
              <span className="px-4 py-2 text-sm text-gray-600">{page} / {totalPages}</span>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40">
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
