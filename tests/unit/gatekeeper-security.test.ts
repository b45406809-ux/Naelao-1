import { describe, it, expect } from "vitest";
import {
  mintGatekeeperToken,
  verifyGatekeeperToken,
  checkGatekeeperGrant,
  clampGrantsToRole,
  enforceGatekeeper,
  type GatekeeperGrant,
} from "@naelao/security";

describe("Gatekeepers Security & Capability Token Protocol", () => {
  const PLATFORM_SECRET = "super_secret_test_platform_key_32_chars_minimum!";

  it("Invariant #1: Clamps capabilities to the Human Permission Ceiling", () => {
    const rawRequestedGrants: GatekeeperGrant[] = [
      { resource: "sqlite_db", target: "table:expenses", operations: ["read", "write", "delete"] },
      { resource: "channel_notify", target: "slack:#alerts", operations: ["execute"] },
      { resource: "mcp_tool", target: "stripe:refund", operations: ["execute"] },
    ];

    // Viewer (Rank 1): Read-only data only, no execution, no write/delete
    const viewerGrants = clampGrantsToRole("viewer", rawRequestedGrants);
    expect(viewerGrants.length).toBe(1);
    expect(viewerGrants[0].resource).toBe("sqlite_db");
    expect(viewerGrants[0].operations).toEqual(["read"]);

    // Member (Rank 2): Read/write data + notify, but NO delete and NO high-risk mcp_tool
    const memberGrants = clampGrantsToRole("member", rawRequestedGrants);
    expect(memberGrants.some((g) => g.resource === "sqlite_db")).toBe(true);
    expect(memberGrants.find((g) => g.resource === "sqlite_db")?.operations).toEqual(["read", "write"]);
    expect(memberGrants.some((g) => g.resource === "channel_notify")).toBe(true);
    expect(memberGrants.some((g) => g.resource === "mcp_tool")).toBe(false);

    // Editor (Rank 3): CRUD on database + notify, but blocked on financial high-risk tools (e.g. stripe:refund)
    const editorGrants = clampGrantsToRole("editor", rawRequestedGrants);
    expect(editorGrants.find((g) => g.resource === "sqlite_db")?.operations).toEqual(["read", "write", "delete"]);
    expect(editorGrants.some((g) => g.target === "stripe:refund")).toBe(false);

    // Admin (Rank 4): Full scope permitted
    const adminGrants = clampGrantsToRole("admin", rawRequestedGrants);
    expect(adminGrants.length).toBe(3);
    expect(adminGrants.some((g) => g.target === "stripe:refund")).toBe(true);
  });

  it("Invariant #2: Enforces Resource-Level Attenuation & Granular Grants", () => {
    const capability = {
      appId: "app_exp_tracker",
      spaceId: "space_123",
      creatorUserId: "usr_alice",
      creatorRoleRank: 3,
      grants: [
        {
          resource: "sqlite_db" as const,
          target: "table:expenses",
          operations: ["read" as const, "write" as const],
        },
        {
          resource: "channel_notify" as const,
          target: "slack:#finance",
          operations: ["execute" as const],
        },
      ],
      issuedAt: Date.now() - 1000,
      expiresAt: Date.now() + 3600000,
      signature: "dummy_sig",
    };

    // Allowed: read on table:expenses
    expect(checkGatekeeperGrant(capability, { resource: "sqlite_db", target: "table:expenses", op: "read" })).toBe(true);
    // Allowed: write on table:expenses
    expect(checkGatekeeperGrant(capability, { resource: "sqlite_db", target: "table:expenses", op: "write" })).toBe(true);
    // Denied: delete on table:expenses
    expect(checkGatekeeperGrant(capability, { resource: "sqlite_db", target: "table:expenses", op: "delete" })).toBe(false);
    // Denied: read on unauthorized table:salary
    expect(checkGatekeeperGrant(capability, { resource: "sqlite_db", target: "table:salary", op: "read" })).toBe(false);
    // Allowed: execute on slack:#finance
    expect(checkGatekeeperGrant(capability, { resource: "channel_notify", target: "slack:#finance", op: "execute" })).toBe(true);
    // Denied: execute on unauthorized channel
    expect(checkGatekeeperGrant(capability, { resource: "channel_notify", target: "slack:#general", op: "execute" })).toBe(false);
  });

  it("Invariant #3: Cryptographic Token Minting, Verification, and Tamper Resistance", async () => {
    const token = await mintGatekeeperToken(
      {
        appId: "app_456",
        spaceId: "space_789",
        creatorUserId: "usr_bob",
        creatorRole: "editor",
        grants: [
          { resource: "sqlite_db", target: "table:inventory", operations: ["read", "write"] },
        ],
        ttlSeconds: 300,
      },
      PLATFORM_SECRET
    );

    expect(token.startsWith("gk_")).toBe(true);

    // Verify valid token
    const verified = await verifyGatekeeperToken(token, PLATFORM_SECRET);
    expect(verified.appId).toBe("app_456");
    expect(verified.creatorRoleRank).toBe(3);
    expect(verified.grants[0].target).toBe("table:inventory");

    // Rejection on wrong secret
    await expect(verifyGatekeeperToken(token, "wrong_secret_key_12345")).rejects.toThrow(/Cryptographic signature mismatch/);

    // Rejection on tampered payload (payload modified without valid signature update)
    const rawPayload = JSON.parse(decodeURIComponent(escape(atob(token.slice(3).replace(/-/g, "+").replace(/_/g, "/")))));
    rawPayload.grants[0].target = "table:salaries"; // Tamper with grant target
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(rawPayload)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const tampered = `gk_${b64}`;
    await expect(verifyGatekeeperToken(tampered, PLATFORM_SECRET)).rejects.toThrow(/signature mismatch/);
  });

  it("Rejects expired tokens cleanly", async () => {
    const expiredToken = await mintGatekeeperToken(
      {
        appId: "app_exp",
        spaceId: "space_exp",
        creatorUserId: "usr_alice",
        creatorRole: "admin",
        grants: [{ resource: "sqlite_db", target: "*", operations: ["read"] }],
        ttlSeconds: -10, // Expired in past
      },
      PLATFORM_SECRET
    );

    await expect(verifyGatekeeperToken(expiredToken, PLATFORM_SECRET)).rejects.toThrow(/Token expired/);
  });

  it("enforceGatekeeper middleware helper validates HTTP request headers", async () => {
    const validToken = await mintGatekeeperToken(
      {
        appId: "app_middleware",
        spaceId: "space_m",
        creatorUserId: "usr_alice",
        creatorRole: "admin",
        grants: [{ resource: "sqlite_db", target: "table:tasks", operations: ["read"] }],
      },
      PLATFORM_SECRET
    );

    const reqWithHeader = new Request("https://api.internal/data", {
      headers: { "x-gatekeeper-token": validToken },
    });

    const cap = await enforceGatekeeper(
      reqWithHeader,
      { resource: "sqlite_db", target: "table:tasks", op: "read" },
      PLATFORM_SECRET
    );
    expect(cap.appId).toBe("app_middleware");

    // Request missing token
    const emptyReq = new Request("https://api.internal/data");
    await expect(
      enforceGatekeeper(emptyReq, { resource: "sqlite_db", target: "table:tasks", op: "read" }, PLATFORM_SECRET)
    ).rejects.toThrow(/No capability token provided/);

    // Request with insufficient operation
    await expect(
      enforceGatekeeper(reqWithHeader, { resource: "sqlite_db", target: "table:tasks", op: "delete" }, PLATFORM_SECRET)
    ).rejects.toThrow(/lacks 'delete' grant/);
  });
});
