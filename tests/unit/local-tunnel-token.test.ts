import { describe, it, expect } from "vitest";
import { mintLocalTunnelToken, verifyLocalTunnelToken } from "@naelao/http";
import { signHmac } from "@naelao/crypto";

// §A1.17 Phase M: the Naelao Local Agent (a client running on a builder's own machine)
// authenticates its one WebSocket connect attempt with this token. Deliberately a SEPARATE
// HMAC payload namespace from mintInternalToken/verifyInternalToken ("local-tunnel:" vs
// "internal:") — a token minted for worker-to-worker calls must never double as a tunnel-connect
// credential, and vice versa, even though both are signed with the same PLATFORM_SECRET.

const SECRET = "test-platform-secret";

describe("mintLocalTunnelToken / verifyLocalTunnelToken round-trip", () => {
  it("a freshly minted token verifies for its own (space, user) pair", async () => {
    const token = await mintLocalTunnelToken(SECRET, "space-1", "user-1");
    expect(await verifyLocalTunnelToken(token, "space-1", "user-1", SECRET)).toBe(true);
  });

  it("does not verify for a different space", async () => {
    const token = await mintLocalTunnelToken(SECRET, "space-1", "user-1");
    expect(await verifyLocalTunnelToken(token, "space-2", "user-1", SECRET)).toBe(false);
  });

  it("does not verify for a different user (a stolen token cannot be replayed for someone else's machine)", async () => {
    const token = await mintLocalTunnelToken(SECRET, "space-1", "user-1");
    expect(await verifyLocalTunnelToken(token, "space-1", "user-2", SECRET)).toBe(false);
  });

  it("does not verify with the wrong secret", async () => {
    const token = await mintLocalTunnelToken(SECRET, "space-1", "user-1");
    expect(await verifyLocalTunnelToken(token, "space-1", "user-1", "wrong-secret")).toBe(false);
  });

  it("rejects a missing token", async () => {
    expect(await verifyLocalTunnelToken(undefined, "space-1", "user-1", SECRET)).toBe(false);
  });

  it("rejects a token older than the 5-minute freshness window", async () => {
    const staleTs = Date.now() - 6 * 60_000;
    const sig = await signHmac(`local-tunnel:space-1:user-1:${staleTs}`, SECRET);
    const staleToken = `t=${staleTs},v1=${sig}`;
    expect(await verifyLocalTunnelToken(staleToken, "space-1", "user-1", SECRET)).toBe(false);
  });

  it("a valid inter-worker internal token cannot be replayed as a local-tunnel connect token", async () => {
    const { mintInternalToken } = await import("@naelao/http");
    // An internal token minted for a "tenant" that happens to share the same string as a
    // (space, user) pair must not verify — the two token families sign different payloads.
    const internalToken = await mintInternalToken(SECRET, "space-1");
    expect(await verifyLocalTunnelToken(internalToken, "space-1", "user-1", SECRET)).toBe(false);
  });
});
