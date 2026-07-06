// Authenticated account client for the Whop Businesses product (the user who logs
// in to run their own business). Separate from the anonymous space-portal client
// in api.ts. Talks to the router front door (/v1/*); the router authenticates the
// JWT and forwards to the agents worker.

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

const TOKEN_KEY = "naelao_token";
const USER_KEY = "naelao_user";

export interface AccountUser {
  id: string;
  email: string;
  role: string;
  plan_tier?: string;
}

// ── Token / user storage ──────────────────────────────────────────────────────
export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function getUser(): AccountUser | null {
  if (typeof window === "undefined") return null;
  try { const raw = localStorage.getItem(USER_KEY); return raw ? JSON.parse(raw) as AccountUser : null; } catch { return null; }
}
function store(token: string, user: AccountUser): void {
  try { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch { /* ignore */ }
}
export function logout(): void {
  try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch { /* ignore */ }
}
export function isAuthenticated(): boolean { return !!getToken(); }

// ── Core fetch ────────────────────────────────────────────────────────────────
async function call<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) };
  if (auth) {
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try { const b = await res.json() as { message?: string; error?: string }; message = b.message ?? b.error ?? message; } catch { /* default */ }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
export async function login(email: string, password: string): Promise<AccountUser> {
  const body = await call<{ data: { token: string; user: AccountUser } }>("/v1/auth/login", {
    method: "POST", body: JSON.stringify({ email, password }),
  }, false);
  store(body.data.token, body.data.user);
  return body.data.user;
}

export async function register(email: string, password: string): Promise<AccountUser> {
  const body = await call<{ data: { token: string; user: AccountUser } }>("/v1/auth/register", {
    method: "POST", body: JSON.stringify({ email, password }),
  }, false);
  store(body.data.token, body.data.user);
  return body.data.user;
}

// ── Catalog ───────────────────────────────────────────────────────────────────
export interface CatalogNiche { id: string; name: string; description: string; status: "live" | "coming_soon" }
export async function productCatalog(): Promise<{ niches: CatalogNiche[]; live_count: number; coming_soon_count: number }> {
  return call("/v1/catalog/product");
}

// The BusinessDO-backed "one business per user" functions that used to live here
// (onboardBusiness/businessStatus/runContentCycle/setPaused, calling /v1/business/:userId/*)
// were removed along with BusinessDO's retirement (legacy Whop-niche runtime).
