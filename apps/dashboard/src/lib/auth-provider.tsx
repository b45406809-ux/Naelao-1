"use client";

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { NaelaoJwtClaims } from "@naelao/types";
import { login as apiLogin } from "./api";
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
  login(email: string, password: string): Promise<void>;
  logout(): void;
  isAuthenticated: boolean;
}

export const AuthContext = createContext<AuthContextValue>({
  token: null,
  claims: null,
  login: async () => {},
  logout: () => {},
  isAuthenticated: false,
});

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [token, setToken] = useState<string | null>(null);
  const [claims, setClaims] = useState<NaelaoJwtClaims | null>(null);

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
  }, []);

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
    storeToken(res.token);
    setToken(res.token);
    setClaims(decoded);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setToken(null);
    setClaims(null);
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
  }, []);

  const value: AuthContextValue = {
    token,
    claims,
    login,
    logout,
    isAuthenticated: token !== null && claims !== null,
  };

  return React.createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
