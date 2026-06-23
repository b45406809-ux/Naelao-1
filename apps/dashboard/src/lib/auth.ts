"use client";

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { NaelaoJwtClaims } from "@naelao/types";
import { login as apiLogin } from "./api";

// ── Token storage ─────────────────────────────────────────────────────────────

export const TOKEN_KEY = "naelao_token";

export function storeToken(token: string): void {
  if (typeof window !== "undefined") {
    localStorage.setItem(TOKEN_KEY, token);
  }
}

export function clearToken(): void {
  if (typeof window !== "undefined") {
    localStorage.removeItem(TOKEN_KEY);
  }
}

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

// ── JWT decode (no verification — UI display only) ───────────────────────────

export function decodeTokenClaims(token: string): NaelaoJwtClaims | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    if (!payload) return null;
    // base64url → base64
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(base64);
    return JSON.parse(json) as NaelaoJwtClaims;
  } catch {
    return null;
  }
}

function isTokenExpired(claims: NaelaoJwtClaims): boolean {
  return Date.now() / 1000 > claims.exp;
}

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

  // Check expiry periodically
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
    // Navigate to login — use window.location for simplicity (avoids router dep in lib)
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
