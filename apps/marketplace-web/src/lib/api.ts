// G-M01..M10: Marketplace public API client

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export interface SpaceTypeListing {
  id: string;
  space_type_id: string;
  name: string;
  description: string;
  category: string;
  pricing: "free" | "paid";
  pricing_model: "freemium_tiered" | "fixed_license";
  price_cents: number;
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
}

export interface MarketplaceLicenseStatus {
  listing_id: string;
  licensed: boolean;
  forked: boolean;
  status: "available" | "license_required" | "forked";
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
  return mktFetch<ListingDetail>(`/v1/marketplace/${encodeURIComponent(id)}`);
}

export async function getReviews(id: string): Promise<Review[]> {
  const res = await mktFetch<{ data: Review[] }>(`/v1/marketplace/${encodeURIComponent(id)}/reviews`);
  return res.data;
}

export async function forkListing(id: string, authToken: string): Promise<{ space_type_id: string }> {
  const res = await fetch(`${API_URL}/v1/marketplace/${encodeURIComponent(id)}/fork`, {
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

export async function getLicenseStatus(id: string, authToken: string): Promise<MarketplaceLicenseStatus> {
  const res = await fetch(`${API_URL}/v1/marketplace/${encodeURIComponent(id)}/license-status`, {
    headers: { "Authorization": `Bearer ${authToken}` }, cache: "no-store",
  });
  if (!res.ok) throw new Error(`License status unavailable (${res.status})`);
  return res.json() as Promise<MarketplaceLicenseStatus>;
}

export async function startLicenseCheckout(id: string, authToken: string): Promise<{ checkout_url: string; price_cents: number; currency: "USD" }> {
  const res = await fetch(`${API_URL}/v1/marketplace/${encodeURIComponent(id)}/license-checkout`, {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${authToken}` }, body: "{}",
  });
  if (!res.ok) {
    let message = `Checkout unavailable (${res.status})`;
    try { const body = await res.json() as { error_code?: string }; message = body.error_code ?? message; } catch { /* keep status */ }
    throw new Error(message);
  }
  return res.json() as Promise<{ checkout_url: string; price_cents: number; currency: "USD" }>;
}
