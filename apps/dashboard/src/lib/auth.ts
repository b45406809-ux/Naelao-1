// Auth utilities — pure token helpers (no "use client" — safe for both server and client imports)
// The AuthProvider/useAuth are in auth-provider.tsx

import type { NaelaoJwtClaims } from "@naelao/types";

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

export function isTokenExpired(claims: NaelaoJwtClaims): boolean {
  return Date.now() / 1000 > claims.exp;
}
