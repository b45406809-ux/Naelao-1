"use client";

// G-M01..M05: Marketplace home — search, category filter, sort, paginated listing grid

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { listListings, CATEGORIES, CATEGORY_LABELS, type SpaceTypeListing, type SortBy, type Category } from "@/lib/api";

const SORT_OPTIONS: { label: string; value: SortBy }[] = [
  { label: "Most installed", value: "installs" },
  { label: "Top rated", value: "rating" },
  { label: "Newest", value: "newest" },
];

function StarRating({ rating, count }: { rating: number; count: number }) {
  const stars = Math.round(rating);
  return (
    <span className="flex items-center gap-1 text-xs text-gray-500">
      {Array.from({ length: 5 }).map((_, i) => (
        <svg key={i} className={`w-3 h-3 ${i < stars ? "text-yellow-400" : "text-gray-300"}`} fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ))}
      <span>({count})</span>
    </span>
  );
}

function ListingCard({ listing }: { listing: SpaceTypeListing }) {
  return (
    <Link href={`/listing/${listing.id}`} className="group bg-white rounded-xl border border-gray-200 p-5 hover:border-brand-300 hover:shadow-md transition-all block">
      <div className="flex items-start justify-between mb-3">
        <div className="w-10 h-10 rounded-xl bg-brand-100 flex items-center justify-center flex-shrink-0">
          <svg className="w-5 h-5 text-brand-600" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
            <path fillRule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clipRule="evenodd" />
          </svg>
        </div>
        <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
          {CATEGORY_LABELS[listing.category as Category] ?? listing.category}
        </span>
      </div>
      <h3 className="font-semibold text-gray-900 mb-1 group-hover:text-brand-700 transition-colors">{listing.name}</h3>
      <p className="text-sm text-gray-500 mb-3 line-clamp-2">{listing.description}</p>
      <div className="flex items-center justify-between">
        <StarRating rating={listing.avg_rating} count={listing.rating_count} />
        <span className="text-xs text-gray-400">{listing.install_count.toLocaleString()} uses</span>
      </div>
      <p className="text-xs text-gray-400 mt-2">by {listing.author_name}</p>
    </Link>
  );
}

export default function MarketplacePage() {
  const [listings, setListings] = useState<SpaceTypeListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<string>("");
  const [sort, setSort] = useState<SortBy>("installs");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const PER_PAGE = 12;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const opts: Parameters<typeof listListings>[0] = { sort, page, per_page: PER_PAGE };
      if (q) opts.q = q;
      if (category) opts.category = category;
      const res = await listListings(opts);
      setListings(res.data);
      setTotal(res.meta.total);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [q, category, sort, page]);

  useEffect(() => { void load(); }, [load]);

  const totalPages = Math.ceil(total / PER_PAGE);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* Hero */}
      <div className="text-center mb-10">
        <h1 className="text-4xl font-bold text-gray-900 mb-3">Discover AI Agent Templates</h1>
        <p className="text-lg text-gray-500 max-w-2xl mx-auto">Browse, preview, and fork space templates built by the community. Use any template in seconds.</p>
      </div>

      {/* Search + filters */}
      <div className="flex flex-wrap gap-3 mb-8 items-center">
        <div className="flex-1 min-w-[200px] relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="search"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
            placeholder="Search templates…"
            className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white">
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
        </select>
        <select value={sort} onChange={(e) => { setSort(e.target.value as SortBy); setPage(1); }}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white">
          {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {/* Category chips */}
      <div className="flex flex-wrap gap-2 mb-6">
        <button onClick={() => { setCategory(""); setPage(1); }}
          className={`text-xs px-3 py-1 rounded-full border transition-colors ${category === "" ? "bg-brand-600 text-white border-brand-600" : "bg-white text-gray-600 border-gray-200 hover:border-brand-400"}`}>
          All
        </button>
        {CATEGORIES.map((c) => (
          <button key={c} onClick={() => { setCategory(c); setPage(1); }}
            className={`text-xs px-3 py-1 rounded-full border transition-colors ${category === c ? "bg-brand-600 text-white border-brand-600" : "bg-white text-gray-600 border-gray-200 hover:border-brand-400"}`}>
            {CATEGORY_LABELS[c]}
          </button>
        ))}
      </div>

      {/* Grid */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-200 p-5 animate-pulse">
              <div className="w-10 h-10 bg-gray-200 rounded-xl mb-3" />
              <div className="h-4 bg-gray-200 rounded mb-2 w-3/4" />
              <div className="h-3 bg-gray-100 rounded mb-1 w-full" />
              <div className="h-3 bg-gray-100 rounded w-2/3" />
            </div>
          ))}
        </div>
      ) : listings.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <svg className="w-12 h-12 mx-auto mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm">No templates found. Try a different search or category.</p>
        </div>
      ) : (
        <>
          <p className="text-sm text-gray-500 mb-4">{total.toLocaleString()} template{total !== 1 ? "s" : ""}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {listings.map((l) => <ListingCard key={l.id} listing={l} />)}
          </div>
          {/* Pagination */}
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
