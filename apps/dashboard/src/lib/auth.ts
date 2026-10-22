// Auth utilities — pure token helpers (no "use client" — safe for both server and client imports)
// The AuthProvider/useAuth are in auth-provider.tsx

import type { NaelaoJwtClaims } from "@naelao/types";

// ── Token storage ─────────────────────────────────────────────────────────────

export const TOKEN_KEY = "naelao_token";

export function storeToken(token: string): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // Keep the current in-memory session usable when browser storage is disabled.
    }
  }
}

export function clearToken(): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(TOKEN_KEY);
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
  }
}

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
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
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
    const json = atob(base64);
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const claims = value as Partial<NaelaoJwtClaims>;
    const roles = ["owner", "admin", "editor", "viewer", "product_end_user", "agent"];
    if (
      typeof claims.sub !== "string" || !claims.sub ||
      typeof claims.tid !== "string" || !claims.tid ||
      typeof claims.email !== "string" ||
      typeof claims.role !== "string" || !roles.includes(claims.role) ||
      !Array.isArray(claims.scopes) || !claims.scopes.every((scope) => typeof scope === "string") ||
      typeof claims.iat !== "number" || !Number.isFinite(claims.iat) ||
      typeof claims.exp !== "number" || !Number.isFinite(claims.exp) ||
      typeof claims.jti !== "string" || !claims.jti ||
      (claims.tv !== undefined && (typeof claims.tv !== "number" || !Number.isFinite(claims.tv)))
    ) return null;
    return claims as NaelaoJwtClaims;
  } catch {
    return null;
  }
}

export function isTokenExpired(claims: NaelaoJwtClaims): boolean {
  return !Number.isFinite(claims.exp) || Date.now() / 1000 >= claims.exp;
}
