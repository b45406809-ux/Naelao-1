import { describe, expect, it } from "vitest";
import { DESK_COOKIE, readDeskSession } from "./desk-drop-cookie.js";

const session = {
  token: "nps_valid-token",
  userId: "user-1",
  productId: "product-1",
  spaceId: "space-1",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

function cookie(value: unknown): string {
  return `${DESK_COOKIE}=${btoa(JSON.stringify(value))}`;
}

describe("Desk session cookie parsing", () => {
  it("reads a valid session from a cookie header with other cookies", () => {
    expect(readDeskSession(`theme=dark; ${cookie(session)}`)).toEqual(session);
  });

  it.each([
    { ...session, token: "invalid" },
    { ...session, userId: "" },
    { ...session, productId: "" },
    { ...session, spaceId: "" },
    { ...session, expiresAt: "not-a-date" },
    { ...session, expiresAt: new Date(Date.now() - 1_000).toISOString() },
  ])("rejects invalid session fields", (invalid) => {
    expect(readDeskSession(cookie(invalid))).toBeNull();
  });

  it("rejects malformed, oversized, or absent cookie values", () => {
    expect(readDeskSession(undefined)).toBeNull();
    expect(readDeskSession(`${DESK_COOKIE}=%%%`)).toBeNull();
    expect(readDeskSession(`${DESK_COOKIE}=eB==`)).toBeNull();
    expect(readDeskSession(`${DESK_COOKIE}=${"A".repeat(4097)}`)).toBeNull();
  });
});
