// G-M01..M10: Marketplace public API client

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export interface SpaceTypeListing {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  author_name: string;
  install_count: number;
  avg_rating: number;
  rating_count: number;
  published_at: string;
  preview_config?: Record<string, unknown>;
}

export interface ListingDetail extends SpaceTypeListing {
  long_description?: string;
  screenshots?: string[];
  pricing: "free" | "paid";
}

export interface Review {
  id: string;
  rating: number;
  body: string;
  author_name: string;
  created_at: string;
}

export const CATEGORIES = [
  "customer-support", "sales", "hr", "education",
  "productivity", "dev-tools", "marketing", "healthcare", "other",
] as const;

export type Category = typeof CATEGORIES[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  "customer-support": "Customer Support",
  "sales": "Sales",
  "hr": "HR & People",
  "education": "Education",
  "productivity": "Productivity",
  "dev-tools": "Developer Tools",
  "marketing": "Marketing",
  "healthcare": "Healthcare",
  "other": "Other",
};

export type SortBy = "installs" | "rating" | "newest";

interface MarketplaceResponse {
  data: SpaceTypeListing[];
  meta: { total: number; page: number; per_page: number };
}

async function mktFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { headers: { "Content-Type": "application/json" } });
  if (!res.ok) {
    let msg = `API error ${res.status}`;
    try { const b = await res.json() as { message?: string }; msg = b.message ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export async function listListings(opts: {
  category?: string;
  q?: string;
  sort?: SortBy;
  page?: number;
  per_page?: number;
}): Promise<MarketplaceResponse> {
  const p = new URLSearchParams();
  if (opts.category) p.set("category", opts.category);
  if (opts.q) p.set("q", opts.q);
  if (opts.sort) p.set("sort", opts.sort);
  if (opts.page) p.set("page", String(opts.page));
  if (opts.per_page) p.set("per_page", String(opts.per_page));
  return mktFetch<MarketplaceResponse>(`/v1/marketplace?${p.toString()}`);
}

export async function getListing(id: string): Promise<ListingDetail> {
  return mktFetch<ListingDetail>(`/v1/marketplace/${id}`);
}

export async function getReviews(id: string): Promise<Review[]> {
  const res = await mktFetch<{ data: Review[] }>(`/v1/marketplace/${id}/reviews`);
  return res.data;
}

export async function forkListing(id: string, authToken: string): Promise<{ space_type_id: string }> {
  const res = await fetch(`${API_URL}/v1/marketplace/${id}/fork`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${authToken}` },
  });
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try { const b = await res.json() as { message?: string }; msg = b.message ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<{ space_type_id: string }>;
}
