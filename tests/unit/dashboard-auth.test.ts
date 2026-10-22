import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearToken,
  decodeTokenClaims,
  getStoredToken,
  isTokenExpired,
  storeToken,
} from "../../apps/dashboard/src/lib/auth";

function tokenWithPayload(payload: unknown): string {
  const encoded = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `header.${encoded}.signature`;
}

const validClaims = {
  sub: "user-1",
  tid: "tenant-1",
  email: "builder@example.test",
  role: "owner",
  scopes: ["api:access"],
  iat: 1_800_000_000,
  exp: 1_900_000_000,
  jti: "token-1",
  tv: 0,
};

afterEach(() => vi.unstubAllGlobals());

describe("dashboard token display helpers", () => {
  it("decodes structurally valid claims without treating decode as signature verification", () => {
    expect(decodeTokenClaims(tokenWithPayload(validClaims))).toMatchObject(validClaims);
  });

  it.each([
    null,
    [],
    { ...validClaims, exp: "never" },
    { ...validClaims, exp: Number.POSITIVE_INFINITY },
    { ...validClaims, role: "superuser" },
    { ...validClaims, scopes: ["api:access", 7] },
    { ...validClaims, sub: "" },
  ])("rejects malformed display claims", (payload) => {
    expect(decodeTokenClaims(tokenWithPayload(payload))).toBeNull();
  });

  it("treats non-finite and elapsed expirations as expired", () => {
    expect(isTokenExpired({ ...validClaims, exp: Number.NaN })).toBe(true);
    expect(isTokenExpired({ ...validClaims, exp: Date.now() / 1000 - 1 })).toBe(true);
    expect(isTokenExpired({ ...validClaims, exp: Date.now() / 1000 + 60 })).toBe(false);
  });

  it("does not crash when localStorage operations are denied", () => {
    const denied = () => { throw new Error("storage disabled"); };
    vi.stubGlobal("window", {
      localStorage: { getItem: denied, setItem: denied, removeItem: denied },
    });

    expect(getStoredToken()).toBeNull();
    expect(() => storeToken("token")).not.toThrow();
    expect(() => clearToken()).not.toThrow();
  });
});
