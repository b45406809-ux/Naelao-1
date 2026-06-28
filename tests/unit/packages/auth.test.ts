import { describe, it, expect } from "vitest";
import { signJwt, verifyJwt, AuthError } from "@naelao/auth";
import { hasPermission, assertPermission } from "@naelao/auth";

const TEST_SECRET = "test-secret-for-unit-tests-only";

describe("signJwt / verifyJwt", () => {
  it("produces a 3-part JWT string", async () => {
    const token = await signJwt(
      { sub: "user1", tid: "org1", email: "a@b.com", role: "owner", scopes: [] },
      TEST_SECRET
    );
    expect(token.split(".")).toHaveLength(3);
  });

  it("verifyJwt returns correct claims for freshly signed token", async () => {
    const token = await signJwt(
      { sub: "user1", tid: "org1", email: "a@b.com", role: "editor", scopes: ["api:access"] },
      TEST_SECRET
    );
    const claims = await verifyJwt(token, TEST_SECRET);
    expect(claims.sub).toBe("user1");
    expect(claims.tid).toBe("org1");
    expect(claims.email).toBe("a@b.com");
    expect(claims.role).toBe("editor");
    expect(claims.scopes).toContain("api:access");
  });

  it("throws AuthError token_expired when exp is in the past", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(
      { sub: "u", tid: "t", email: "a@b.com", role: "viewer", scopes: [], iat: now - 7200, exp: now - 3600 },
      TEST_SECRET
    );
    await expect(verifyJwt(token, TEST_SECRET)).rejects.toMatchObject({ code: "token_expired" });
  });

  it("throws AuthError invalid_token when signature is wrong", async () => {
    const token = await signJwt(
      { sub: "u", tid: "t", email: "a@b.com", role: "viewer", scopes: [] },
      TEST_SECRET
    );
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.invalidsig`;
    await expect(verifyJwt(tampered, TEST_SECRET)).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("throws AuthError invalid_token for malformed token", async () => {
    await expect(verifyJwt("not.a.valid.jwt.string", TEST_SECRET)).rejects.toBeInstanceOf(AuthError);
    await expect(verifyJwt("onlyone", TEST_SECRET)).rejects.toBeInstanceOf(AuthError);
  });
});

describe("hasPermission", () => {
  it("owner has all permissions", () => {
    expect(hasPermission("owner", "spaces:read")).toBe(true);
    expect(hasPermission("owner", "billing:write")).toBe(true);
    expect(hasPermission("owner", "admin:all")).toBe(true);
    expect(hasPermission("owner", "members:write")).toBe(true);
  });

  it("viewer has only read permissions", () => {
    expect(hasPermission("viewer", "spaces:read")).toBe(true);
    expect(hasPermission("viewer", "kb:read")).toBe(true);
    expect(hasPermission("viewer", "spaces:write")).toBe(false);
    expect(hasPermission("viewer", "billing:write")).toBe(false);
  });

  it("editor can write spaces/kb but cannot manage billing", () => {
    expect(hasPermission("editor", "spaces:write")).toBe(true);
    expect(hasPermission("editor", "kb:write")).toBe(true);
    expect(hasPermission("editor", "billing:read")).toBe(false);
    expect(hasPermission("editor", "billing:write")).toBe(false);
    expect(hasPermission("editor", "members:write")).toBe(false);
  });

  it("admin cannot access billing:write or admin:all", () => {
    expect(hasPermission("admin", "billing:read")).toBe(true);
    expect(hasPermission("admin", "billing:write")).toBe(false);
    expect(hasPermission("admin", "admin:all")).toBe(false);
  });
});

describe("assertPermission", () => {
  it("throws for insufficient role", () => {
    expect(() => assertPermission("viewer", "spaces:write")).toThrow();
    expect(() => assertPermission("editor", "billing:write")).toThrow();
  });

  it("does not throw for sufficient role", () => {
    expect(() => assertPermission("owner", "admin:all")).not.toThrow();
    expect(() => assertPermission("editor", "spaces:write")).not.toThrow();
  });
});
