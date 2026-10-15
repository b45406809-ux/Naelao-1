import type { NaelaoJwtClaims } from "@naelao/types";
import { describe, expect, it, vi } from "vitest";
import { loadSavedLanguagePreference } from "./preferred-language";

function claims(role: NaelaoJwtClaims["role"], sub: string): NaelaoJwtClaims {
  return {
    role,
    sub,
    tid: "tenant",
    email: "test@example.invalid",
    scopes: [],
    iat: 0,
    exp: 0,
    jti: "test",
  };
}

describe("authenticated language preference lookup", () => {
  it("isolates product users by product and verified end-user identity", async () => {
    const bind = vi.fn((productId: string, userId: string) => ({
      first: async () =>
        productId === "product-a" && userId === "user-a"
          ? { preferred_language: "sw-KE" }
          : null,
    }));
    const db = { prepare: vi.fn(() => ({ bind })) } as unknown as D1Database;

    expect(
      await loadSavedLanguagePreference(
        db,
        claims("product_end_user", "user-a"),
        "product-a"
      )
    ).toBe("sw-KE");
    expect(bind).toHaveBeenLastCalledWith("product-a", "user-a");
    expect(
      await loadSavedLanguagePreference(
        db,
        claims("product_end_user", "user-b"),
        "product-b"
      )
    ).toBeNull();
    expect(bind).toHaveBeenLastCalledWith("product-b", "user-b");
  });

  it("uses the platform account for members and never queries an agent identity", async () => {
    const first = vi.fn(async () => ({ preferred_language: "fr-ca" }));
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;

    expect(
      await loadSavedLanguagePreference(
        db,
        claims("owner", "member-a"),
        "space-a"
      )
    ).toBe("fr-CA");
    expect(prepare).toHaveBeenCalledWith(
      "SELECT preferred_language FROM users WHERE id = ?"
    );
    expect(bind).toHaveBeenLastCalledWith("member-a");
    expect(
      await loadSavedLanguagePreference(
        db,
        claims("agent", "agent-a"),
        "space-a"
      )
    ).toBeNull();
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});
