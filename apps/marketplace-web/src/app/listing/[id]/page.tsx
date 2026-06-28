"use client";

// G-M07..M10: Listing detail — preview config, reviews, "Use this template" fork button

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { getListing, getReviews, forkListing, CATEGORY_LABELS, type ListingDetail, type Review, type Category } from "@/lib/api";

const DASHBOARD_URL = process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "https://app.naelao.com";
const AUTH_TOKEN_KEY = "naelao_builder_token";

function getStoredToken(): string | null {
  try { return localStorage.getItem(AUTH_TOKEN_KEY); } catch { return null; }
}

function StarRating({ rating }: { rating: number }) {
  return (
    <span className="flex gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <svg key={i} className={`w-4 h-4 ${i < Math.round(rating) ? "text-yellow-400" : "text-gray-200"}`} fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ))}
    </span>
  );
}

export default function ListingPage() {
  const { id } = useParams<{ id: string }>();
  const [listing, setListing] = useState<ListingDetail | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [forking, setForking] = useState(false);
  const [forked, setForked] = useState(false);
  const [forkError, setForkError] = useState("");
  const [showConfig, setShowConfig] = useState(false);

  useEffect(() => {
    setLoading(true);
    void Promise.all([getListing(id), getReviews(id)])
      .then(([l, r]) => { setListing(l); setReviews(r); })
      .catch(() => { /* ignore */ })
      .finally(() => setLoading(false));
  }, [id]);

  async function handleFork() {
    const token = getStoredToken();
    if (!token) {
      window.location.href = `${DASHBOARD_URL}/login?return_to=${encodeURIComponent(window.location.href)}`;
      return;
    }
    setForking(true);
    setForkError("");
    try {
      await forkListing(id, token);
      setForked(true);
    } catch (err) {
      setForkError(err instanceof Error ? err.message : "Failed to fork template.");
    } finally {
      setForking(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/2 mb-4" />
          <div className="h-4 bg-gray-100 rounded w-full mb-2" />
          <div className="h-4 bg-gray-100 rounded w-3/4" />
        </div>
      </div>
    );
  }

  if (!listing) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8 text-center text-gray-500">
        <p>Template not found.</p>
        <Link href="/" className="mt-3 inline-block text-sm text-brand-600 hover:underline">Back to Marketplace</Link>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-6">
        <Link href="/" className="hover:text-brand-700">Marketplace</Link>
        <span>/</span>
        <Link href={`/categories/${listing.category}`} className="hover:text-brand-700">
          {CATEGORY_LABELS[listing.category as Category] ?? listing.category}
        </Link>
        <span>/</span>
        <span className="text-gray-900 font-medium truncate">{listing.name}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main */}
        <div className="lg:col-span-2 space-y-6">
          <div>
            <div className="flex items-start gap-4 mb-4">
              <div className="w-14 h-14 rounded-2xl bg-brand-100 flex items-center justify-center flex-shrink-0">
                <svg className="w-7 h-7 text-brand-600" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                  <path fillRule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clipRule="evenodd" />
                </svg>
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">{listing.name}</h1>
                <p className="text-gray-500 text-sm mt-1">by {listing.author_name}</p>
                <div className="flex items-center gap-3 mt-2">
                  <StarRating rating={listing.avg_rating} />
                  <span className="text-sm text-gray-500">{listing.avg_rating.toFixed(1)} ({listing.rating_count} reviews)</span>
                </div>
              </div>
            </div>
            <p className="text-gray-600">{listing.description}</p>
            {listing.long_description && (
              <div className="mt-4 text-sm text-gray-600 leading-relaxed whitespace-pre-line">
                {listing.long_description}
              </div>
            )}
          </div>

          {/* Tags */}
          {listing.tags.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {listing.tags.map((tag) => (
                <span key={tag} className="text-xs bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full">{tag}</span>
              ))}
            </div>
          )}

          {/* Config preview */}
          {listing.preview_config && (
            <div className="bg-white rounded-xl border border-gray-200">
              <button onClick={() => setShowConfig(!showConfig)}
                className="w-full px-4 py-3 flex items-center justify-between text-sm font-medium text-gray-700 hover:bg-gray-50 rounded-xl">
                <span>Preview Configuration</span>
                <svg className={`w-4 h-4 transition-transform ${showConfig ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {showConfig && (
                <div className="border-t border-gray-200 p-4">
                  <pre className="text-xs text-gray-600 bg-gray-50 rounded-lg p-3 overflow-x-auto">
                    {JSON.stringify(listing.preview_config, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* Reviews */}
          <div>
            <h2 className="font-semibold text-gray-900 mb-4">Reviews ({reviews.length})</h2>
            {reviews.length === 0 ? (
              <p className="text-sm text-gray-400">No reviews yet.</p>
            ) : (
              <div className="space-y-4">
                {reviews.map((r) => (
                  <div key={r.id} className="bg-white rounded-xl border border-gray-200 p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <StarRating rating={r.rating} />
                        <span className="text-sm font-medium text-gray-700">{r.author_name}</span>
                      </div>
                      <span className="text-xs text-gray-400">{new Date(r.created_at).toLocaleDateString()}</span>
                    </div>
                    {r.body && <p className="text-sm text-gray-600">{r.body}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-200 p-5 sticky top-20">
            <div className="text-center mb-4">
              <p className="text-3xl font-bold text-gray-900">{listing.install_count.toLocaleString()}</p>
              <p className="text-sm text-gray-500">total uses</p>
            </div>
            <div className="text-xs text-gray-400 text-center mb-4 uppercase tracking-wide">
              {listing.pricing === "free" ? "Free template" : "Paid template"}
            </div>

            {forked ? (
              <div className="text-center">
                <p className="text-green-700 text-sm font-medium mb-3">Template added to your workspace!</p>
                <a href={`${DASHBOARD_URL}/dashboard/spacetypes`}
                  className="block w-full py-2.5 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 text-center transition-colors">
                  Open Dashboard →
                </a>
              </div>
            ) : (
              <>
                {forkError && <p className="text-xs text-red-600 mb-3 text-center">{forkError}</p>}
                <button onClick={() => void handleFork()} disabled={forking}
                  className="w-full py-2.5 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors">
                  {forking ? "Adding to workspace…" : "Use this template"}
                </button>
                <p className="text-xs text-gray-400 text-center mt-2">Requires a Naelao account</p>
              </>
            )}

            <div className="mt-4 pt-4 border-t border-gray-100 space-y-2 text-sm">
              <div className="flex justify-between text-gray-600">
                <span>Category</span>
                <Link href={`/categories/${listing.category}`} className="text-brand-600 hover:underline">
                  {CATEGORY_LABELS[listing.category as Category] ?? listing.category}
                </Link>
              </div>
              <div className="flex justify-between text-gray-600">
                <span>Published</span>
                <span>{new Date(listing.published_at).toLocaleDateString()}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
