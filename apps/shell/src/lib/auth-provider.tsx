"use client";

// Product Shell auth — deliberately built with an `isHydrated` tri-state from day one. The
// dashboard's builder AuthProvider initializes token/claims to null and only reads localStorage
// in a post-mount effect, so the FIRST render of any protected route sees isAuthenticated=false
// and can redirect to /login before the real session is ever read. Never repeat that here: no
// consumer of this context may redirect on isAuthenticated until isHydrated is true.

import * as React from "react";
import { getProductSession, isSignedIn, logOut, type ProductEndUser } from "./productAccount";

export interface ProductAuthContextValue {
  spaceId: string;
  session: ProductEndUser | null;
  isHydrated: boolean;
  isAuthenticated: boolean;
  setSession: (session: ProductEndUser | null) => void;
  signOut: () => void;
}

const ProductAuthContext = React.createContext<ProductAuthContextValue | null>(null);

export function ProductAuthProvider({
  spaceId,
  children,
}: {
  spaceId: string;
  children: React.ReactNode;
}) {
  const [session, setSessionState] = React.useState<ProductEndUser | null>(null);
  const [isHydrated, setIsHydrated] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setSessionState(null); setIsHydrated(false);
    if (isSignedIn(spaceId)) {
      setSessionState(getProductSession(spaceId));
      setIsHydrated(true);
    } else {
      const api = "/api/naelao";
      void fetch(`${api}/v1/desk-drop/session?productId=${encodeURIComponent(spaceId)}`, { credentials: "include" })
        .then(async res => res.ok ? await res.json() as ProductEndUser : null)
        .then(next => { if (!cancelled) setSessionState(next); })
        .catch(() => {})
        .finally(() => { if (!cancelled) setIsHydrated(true); });
    }
    return () => { cancelled = true; };
  }, [spaceId]);

  const setSession = React.useCallback((next: ProductEndUser | null) => setSessionState(next), []);

  const signOutFn = React.useCallback(() => {
    const api = "/api/naelao";
    void fetch(`${api}/v1/desk-drop/logout`, { method: "POST", credentials: "include" });
    logOut(spaceId);
    setSessionState(null);
  }, [spaceId]);

  const value: ProductAuthContextValue = {
    spaceId,
    session,
    isHydrated,
    isAuthenticated: session !== null,
    setSession,
    signOut: signOutFn,
  };

  return <ProductAuthContext.Provider value={value}>{children}</ProductAuthContext.Provider>;
}

export function useProductAuth(): ProductAuthContextValue {
  const ctx = React.useContext(ProductAuthContext);
  if (!ctx) throw new Error("useProductAuth must be used within a ProductAuthProvider");
  return ctx;
}

/**
 * The session in the shape every api.ts call takes — and, crucially, a STABLE object.
 *
 * This exists because of a real, live bug. Pages were each writing
 * `const creds = session ? { sessionToken: ..., endUserId: ... } : null` in the render body and
 * then listing `creds` in a data-loading effect's dependency array. That literal is a new object
 * on every render, so: the effect fires a batch of fetches → the first one resolves and calls a
 * setState → the re-render mints a new `creds` → the deps "changed" → React runs the effect's
 * cleanup, which flips the batch's `cancelled` flag, discarding every result still in flight →
 * the effect fires a fresh batch. Forever.
 *
 * The visible damage: a page that hammers the API in a loop, panels that stay empty even though
 * their request returned 200, and a "Loading…" that never clears because each new batch resets it.
 * Confirmed against production — every endpoint the Dashboard showed as unreadable answered 200
 * when called directly from that same page.
 *
 * Memoised on the primitive fields, so the identity only changes when the session really does.
 */
export function useSessionCredentials(): { sessionToken: string; endUserId: string } | null {
  const { session } = useProductAuth();
  const token = session?.session_token;
  const endUserId = session?.end_user_id;
  return React.useMemo(
    () => (token && endUserId ? { sessionToken: token, endUserId } : null),
    [token, endUserId]
  );
}
