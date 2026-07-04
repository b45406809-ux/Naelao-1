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
    if (isSignedIn(spaceId)) {
      setSessionState(getProductSession(spaceId));
    }
    setIsHydrated(true);
  }, [spaceId]);

  const setSession = React.useCallback((next: ProductEndUser | null) => setSessionState(next), []);

  const signOutFn = React.useCallback(() => {
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
