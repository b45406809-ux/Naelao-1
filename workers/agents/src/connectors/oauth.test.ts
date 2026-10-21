import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeCodeForTokens, fetchOAuthIdentity, refreshTokens } from "./oauth.js";

function oversizedTokenResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"access_token":"access","refresh_token":"refresh","extra":"'));
      controller.enqueue(new Uint8Array(64 * 1024 + 1).fill(0x61));
      controller.enqueue(new TextEncoder().encode('"}'));
      controller.close();
    },
  }));
}

describe("OAuth provider response boundaries", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("bounds token exchange responses and applies a request deadline", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ access_token: "access-2", refresh_token: "rotated-2", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchMock);
    const tokens = await exchangeCodeForTokens({ tokenUrl: "https://provider.example/token", clientId: "client", clientSecret: "secret", code: "code", codeVerifier: "verifier", redirectUri: "https://naelao.example/callback" });
    expect(tokens).toMatchObject({ access_token: "access-2", refresh_token: "rotated-2" });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects oversized refresh responses instead of replacing the rotating token pair", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(oversizedTokenResponse()));
    await expect(refreshTokens({ tokenUrl: "https://provider.example/token", clientId: "client", clientSecret: "secret", refreshToken: "refresh-1" })).rejects.toThrow("invalid or oversized response");
  });

  it("rejects invalid expiry values and overlong tokens", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ access_token: "access", refresh_token: "refresh", expires_in: -1 }))
      .mockResolvedValueOnce(Response.json({ access_token: "a".repeat(16_385), refresh_token: "refresh" })));
    const params = { tokenUrl: "https://provider.example/token", clientId: "client", clientSecret: "secret", code: "code", codeVerifier: "verifier", redirectUri: "https://naelao.example/callback" };
    await expect(exchangeCodeForTokens(params)).rejects.toThrow("invalid token fields");
    await expect(exchangeCodeForTokens(params)).rejects.toThrow("invalid token fields");
  });

  it("returns null for malformed, oversized, or overlong userinfo identities", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ sub: "u".repeat(513) }))
      .mockResolvedValueOnce(oversizedTokenResponse()));
    await expect(fetchOAuthIdentity("https://provider.example/userinfo", "access")).resolves.toBeNull();
    await expect(fetchOAuthIdentity("https://provider.example/userinfo", "access")).resolves.toBeNull();
  });
});
