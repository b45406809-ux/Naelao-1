// End-user auth client, scoped to ONE product (spaceId) — ported from
// apps/portal/src/lib/productAccount.ts (Three-Tier Platform Model, Phase 6). A person could be
// signed into several different builder products in the same browser, so session state is keyed
// per spaceId, never global.

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export interface ProductEndUser {
  end_user_id: string;
  session_token: string;
  expires_at: string;
  /** Email verification is required before a new account can sign in. */
  email_verification_required?: boolean;
}

function storageKey(spaceId: string): string {
  return `naelao_product_session:${spaceId}`;
}

export function getProductSession(spaceId: string): ProductEndUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(storageKey(spaceId));
    return raw ? (JSON.parse(raw) as ProductEndUser) : null;
  } catch {
    return null;
  }
}

function storeProductSession(spaceId: string, session: ProductEndUser): void {
  try {
    localStorage.setItem(storageKey(spaceId), JSON.stringify(session));
  } catch {
    /* ignore */
  }
}

export function clearProductSession(spaceId: string): void {
  try {
    localStorage.removeItem(storageKey(spaceId));
  } catch {
    /* ignore */
  }
}

export function isSignedIn(spaceId: string): boolean {
  const session = getProductSession(spaceId);
  if (!session) return false;
  return new Date(session.expires_at) > new Date();
}

async function call<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const b = (await res.json()) as { message?: string; error_code?: string };
      message = b.message ?? b.error_code ?? message;
    } catch {
      /* use default message */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export async function signUp(
  spaceId: string,
  email: string,
  password: string,
  displayName?: string
): Promise<ProductEndUser> {
  const session = await call<ProductEndUser>(`/v1/spaces/${spaceId}/end-users/signup`, {
    email,
    password,
    ...(displayName ? { display_name: displayName } : {}),
  });
  storeProductSession(spaceId, session);
  return session;
}

export async function logIn(spaceId: string, email: string, password: string): Promise<ProductEndUser> {
  const session = await call<ProductEndUser>(`/v1/spaces/${spaceId}/end-users/login`, { email, password });
  storeProductSession(spaceId, session);
  return session;
}

export async function requestWhatsAppLogin(spaceId: string, phone: string): Promise<{ ok: boolean; message: string }> {
  return call(`/v1/spaces/${spaceId}/end-users/request-whatsapp-login`, { phone });
}

export async function verifyWhatsAppLogin(
  spaceId: string,
  input: { phone?: string; code?: string; token?: string }
): Promise<ProductEndUser> {
  const session = await call<ProductEndUser>(`/v1/spaces/${spaceId}/end-users/verify-whatsapp-login`, input);
  storeProductSession(spaceId, session);
  return session;
}

export function logOut(spaceId: string): void {
  clearProductSession(spaceId);
}

/** Redeems a verification token — either from the emailed link's ?token= or pasted in by hand
 *  (the fallback path when the email couldn't carry a clickable link, or a link goes stale). */
export async function verifyEmail(spaceId: string, token: string): Promise<{ ok: boolean; message: string }> {
  return call(`/v1/spaces/${spaceId}/end-users/verify-email`, { token });
}

/** Always resolves with the same generic response whether or not the account exists/is already
 *  verified — mirrors the backend's own "never reveal account existence" contract. */
export async function resendVerification(spaceId: string, email: string): Promise<{ ok: boolean; message: string }> {
  return call(`/v1/spaces/${spaceId}/end-users/resend-verification`, { email });
}
