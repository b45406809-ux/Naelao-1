"use client";

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { NaelaoJwtClaims } from "@naelao/types";
import { getBillingSubscription, login as apiLogin, register as apiRegister } from "./api";
import {
  storeToken,
  clearToken,
  getStoredToken,
  decodeTokenClaims,
  isTokenExpired,
} from "./auth";

// ── AuthContext ───────────────────────────────────────────────────────────────

export interface AuthContextValue {
  token: string | null;
  claims: NaelaoJwtClaims | null;
  planTier: string | null;
  login(email: string, password: string): Promise<void>;
  register(email: string, password: string, orgName?: string): Promise<void>;
  logout(): void;
  isAuthenticated: boolean;
  /** False until localStorage has been read on mount. A hard reload of any nested route must
   *  gate its redirect-to-login on this — otherwise the child route's own effect (which fires
   *  BEFORE this provider's own hydration effect, since React runs effects child-first within a
   *  single mount commit) sees the default `isAuthenticated: false` and bounces to /login even
   *  when a valid token exists in storage. This was a real, reproducible bug on every nested
   *  nested /dashboard/* route before this field existed. */
  isHydrated: boolean;
}

export const AuthContext = createContext<AuthContextValue>({
  token: null,
  claims: null,
  planTier: null,
  login: async () => {},
  register: async () => {},
  logout: () => {},
  isAuthenticated: false,
  isHydrated: false,
});

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [token, setToken] = useState<string | null>(null);
  const [claims, setClaims] = useState<NaelaoJwtClaims | null>(null);
  const [planTier, setPlanTier] = useState<string | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);

  // Initialize from localStorage on mount
  useEffect(() => {
    const stored = getStoredToken();
    if (stored) {
      const decoded = decodeTokenClaims(stored);
      if (decoded && !isTokenExpired(decoded)) {
        setToken(stored);
        setClaims(decoded);
      } else {
        // Token expired — clear it
        clearToken();
      }
    }
    setIsHydrated(true);
  }, []);

  // Plan tier is mutable subscription state, so re-read the server-authoritative value after
  // hydration instead of inferring it from the JWT (which intentionally carries no plan claim).
  useEffect(() => {
    if (!token) {
      setPlanTier(null);
      return;
    }
    let active = true;
    void getBillingSubscription()
      .then((subscription) => {
        if (active) setPlanTier(subscription.plan_tier);
      })
      .catch(() => {
        // Keep the plan returned by login/register when a refresh request is temporarily offline.
      });
    return () => { active = false; };
  }, [token]);

  // Auto-logout when token expires
  useEffect(() => {
    if (!claims) return;
    const expiresAt = claims.exp * 1000;
    const msUntilExpiry = expiresAt - Date.now();
    if (msUntilExpiry <= 0) {
      logout();
      return;
    }
    const timer = setTimeout(() => {
      logout();
    }, msUntilExpiry);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claims]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await apiLogin(email, password);
    const decoded = decodeTokenClaims(res.token);
    if (!decoded || isTokenExpired(decoded)) throw new Error("Authentication service returned an invalid token");
    storeToken(res.token);
    setToken(res.token);
    setClaims(decoded);
    setPlanTier(res.user.plan_tier);
  }, []);

  const register = useCallback(
    async (email: string, password: string, orgName?: string) => {
      const res = await apiRegister(email, password, orgName);
      const decoded = decodeTokenClaims(res.token);
      if (!decoded || isTokenExpired(decoded)) throw new Error("Authentication service returned an invalid token");
      storeToken(res.token);
      setToken(res.token);
      setClaims(decoded);
      setPlanTier(res.user.plan_tier);
    },
    []
  );

  const logout = useCallback(() => {
    clearToken();
    setToken(null);
    setClaims(null);
    setPlanTier(null);
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
  }, []);

  const value: AuthContextValue = {
    token,
    claims,
    planTier,
    login,
    register,
    logout,
    isAuthenticated: token !== null && claims !== null,
    isHydrated,
  };

  return React.createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
