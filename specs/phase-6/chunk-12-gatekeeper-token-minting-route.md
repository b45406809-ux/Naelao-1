Here is the complete, single, ultra-detailed, production-ready Markdown specification file for **Phase 6 — Chunk 12**: `specs/phase-6/chunk-12-gatekeeper-token-minting-route.md`.

---

```markdown
---
chunk_id: "phase-6-chunk-12"
phase: 6
include_files:
  - workers/spaces/src/index.ts
  - workers/security/src/gatekeeper.ts
  - packages/types/src/gadgets.ts
repomix_include:
  - "workers/spaces/src/index.ts"
  - "workers/security/src/gatekeeper.ts"
  - "packages/types/src/gadgets.ts"
expected_outputs:
  - workers/spaces/src/index.ts
  - workers/security/src/gatekeeper.ts
  - packages/types/src/gadgets.ts
---

# Phase 6 — Chunk 12: Gatekeeper Token Minting Route & Iframe Capability Injection

## 1. Executive Summary & Architectural Vision

In AVOS and Cloudflare OS, user-generated Micro-Apps and Stateful Gadgets are hosted inside sandboxed, null-origin `<iframe>` viewports on the project canvas. 

**Application code inside an iframe must NEVER contain raw API keys, database credentials, or master user session tokens.** Placing master session tokens in iframes exposes the business to cross-site scripting (XSS) and data exfiltration.

Instead, the platform implements **Zero-Trust Gatekeeper Capability Tokens**:
1. When `apps/shell` mounts a Gadget iframe, the shell requests a short-lived, cryptographically signed **Gatekeeper Capability Token** from the spaces worker (`POST /spaces/:spaceId/gadgets/:instanceId/token`).
2. The platform evaluates the user's role rank in `SpaceDO` and mints an **attenuated token** signed with `PLATFORM_SECRET` via HMAC-SHA256.
3. The iframe includes this token in the `X-Gatekeeper-Token` HTTP header on all API calls back to `MicroAppDO` or Cloudflare edge endpoints.
4. The `WriteGuard` proxy inspects the token's HMAC signature, verifies that the requested operation is explicitly granted in the token's capability payload, and validates that the token has not expired.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              GATEKEEPER CAPABILITY TOKEN FLOW                                          │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. Mount Request:      User opens Project Canvas containing Gadget `instance_102`.                     │
│ 2. Token Minting:      `apps/shell` ──► POST /spaces/s1/gadgets/instance_102/token                     │
│                        `workers/spaces` validates user role rank & signs token with HMAC-SHA256.       │
│ 3. Iframe Injection:   `apps/shell` passes token to iframe via postMessage or src parameter.           │
│ 4. Attenuated Exec:    Iframe ──[X-Gatekeeper-Token]──► POST /api/data to `MicroAppDO`                 │
│ 5. Verification:       `MicroAppDO` validates HMAC signature + expiry + operation grant before write. │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Invariant Security Principles

1. **The Human Clearance Ceiling (Invariant #1):** A Gatekeeper token can **never** grant more authority than the human user who requested it. If Alice is a `Viewer` (Role Rank 1), the spaces worker will physically refuse to mint a token containing `sqlite_db:write` capabilities, even if the Gadget manifest requests it.
2. **Resource-Level Attenuation (Invariant #2):** Tokens are bound strictly to `spaceId`, `projectId`, and `gadgetInstanceId`. A token minted for Gadget A cannot be used to query Gadget B or access parent space ledgers.
3. **Short TTL & Zero Persistence (Invariant #3):** Tokens carry an explicit expiration timestamp (default: 3600 seconds / 1 hour). They are created in-memory and are never stored in D1 or KV databases, eliminating token revocation database overhead.

---

## 3. Data Contracts & Interfaces (`packages/types/src/gadgets.ts`)

Update `packages/types/src/gadgets.ts` to export the Gatekeeper token contracts:

```typescript
export type GatekeeperResourceType = "sqlite_db" | "notifications" | "slack" | "mcp_tool" | "storage_bucket";
export type GatekeeperOperation = "read" | "write" | "delete" | "execute" | "notify";

export interface GatekeeperGrant {
  resource: GatekeeperResourceType;
  target: string; // e.g. "table:app_records" or "slack:#warehouse-alerts"
  operations: GatekeeperOperation[];
  constraints?: {
    rateLimitPerMinute?: number;
    maxAmountCents?: number;
  };
}

export interface GatekeeperCapabilityPayload {
  appId: string;
  gadgetInstanceId: string;
  spaceId: string;
  projectId?: string;
  creatorUserId: string;
  creatorRoleRank: number; // 1: Viewer -> 2: Member -> 3: Editor -> 4: Admin -> 5: Owner
  grants: GatekeeperGrant[];
  issuedAt: number;  // Epoch milliseconds
  expiresAt: number; // Epoch milliseconds
}

export interface GatekeeperTokenRequest {
  requestedGrants?: GatekeeperGrant[];
  ttlSeconds?: number; // Optional custom TTL, capped at 86400 (24h)
}

export interface GatekeeperTokenResponse {
  ok: boolean;
  token: string;
  gadgetInstanceId: string;
  spaceId: string;
  expiresAt: string; // ISO-8601 string
  grantedCapabilities: GatekeeperGrant[];
}
```

---

## 4. Cryptographic Token Engine (`workers/security/src/gatekeeper.ts`)

Update `workers/security/src/gatekeeper.ts` to implement WebCrypto HMAC-SHA256 minting and verification:

```typescript
import { GatekeeperCapabilityPayload, GatekeeperGrant } from "@naelao/types";

/**
 * Encodes a Gatekeeper capability payload into a WebCrypto HMAC-SHA256 signed token string.
 * Format: `base64url(payload).base64url(signature)`
 */
export async function mintGatekeeperToken(
  payload: GatekeeperCapabilityPayload,
  platformSecret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const payloadJson = JSON.stringify(payload);
  const payloadBase64 = bufferToBase64Url(encoder.encode(payloadJson));

  const secretKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(platformSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    secretKey,
    encoder.encode(payloadBase64)
  );

  const signatureBase64 = bufferToBase64Url(new Uint8Array(signatureBuffer));
  return `${payloadBase64}.${signatureBase64}`;
}

/**
 * Cryptographically verifies a Gatekeeper capability token string using platformSecret.
 * Checks signature integrity and expiration time.
 */
export async function verifyGatekeeperToken(
  tokenString: string,
  platformSecret: string
): Promise<GatekeeperCapabilityPayload> {
  const parts = tokenString.split(".");
  if (parts.length !== 2) {
    throw new Error("Gatekeeper Violation: Malformed token format.");
  }

  const [payloadBase64, signatureBase64] = parts;
  const encoder = new TextEncoder();

  const secretKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(platformSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signatureBytes = base64UrlToBuffer(signatureBase64);
  const isValid = await crypto.subtle.verify(
    "HMAC",
    secretKey,
    signatureBytes,
    encoder.encode(payloadBase64)
  );

  if (!isValid) {
    throw new Error("Gatekeeper Violation: Cryptographic signature mismatch.");
  }

  const payloadJson = new TextDecoder().decode(base64UrlToBuffer(payloadBase64));
  const payload: GatekeeperCapabilityPayload = JSON.parse(payloadJson);

  if (Date.now() > payload.expiresAt) {
    throw new Error("Gatekeeper Violation: Token has expired.");
  }

  return payload;
}

/**
 * Validates that a verified payload contains permission for a specific resource & operation.
 */
export function isOperationGranted(
  payload: GatekeeperCapabilityPayload,
  requiredResource: string,
  requiredTarget: string,
  requiredOp: string
): boolean {
  return payload.grants.some(g => 
    g.resource === requiredResource &&
    (g.target === "*" || g.target === requiredTarget) &&
    g.operations.includes(requiredOp as any)
  );
}

// ── WebCrypto Helper Functions ──────────────────────────────────────────────

function bufferToBase64Url(buffer: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < buffer.byteLength; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlToBuffer(base64url: string): Uint8Array {
  let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
```

---

## 5. Spaces Worker Endpoint (`workers/spaces/src/index.ts`)

Add the token minting route to `workers/spaces/src/index.ts`:

```typescript
import { mintGatekeeperToken } from "@naelao/security";
import { GatekeeperGrant, GatekeeperCapabilityPayload } from "@naelao/types";

// Route: POST /spaces/:spaceId/gadgets/:instanceId/token
app.post("/spaces/:spaceId/gadgets/:instanceId/token", async (c) => {
  const { spaceId, instanceId } = c.req.param();
  const authUser = c.get("user"); // Verified JWT / session user
  const platformSecret = c.env.PLATFORM_SECRET;

  if (!authUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // 1. Resolve user's business role and role rank in this space
  const db = c.env.PLATFORM_DB;
  const membership = await db.prepare(
    "SELECT role FROM business_memberships WHERE space_id = ? AND user_id = ? AND status = 'active'"
  ).bind(spaceId, authUser.id).first<{ role: string }>();

  const ROLE_RANKS: Record<string, number> = {
    viewer: 1,
    member: 2,
    editor: 3,
    admin: 4,
    owner: 5
  };

  const userRole = membership?.role || "viewer";
  const userRoleRank = ROLE_RANKS[userRole] || 1;

  // 2. Fetch Gadget instance details from SpaceDO SQLite
  const spaceDO = c.env.SPACES_DO.get(c.env.SPACES_DO.idFromName(spaceId));
  const gadgetRes = await spaceDO.fetch(`http://internal/gadgets/instances/${instanceId}`);
  
  if (!gadgetRes.ok) {
    return c.json({ error: "Gadget instance not found or inactive" }, 404);
  }

  const gadgetInstance = await gadgetRes.json() as {
    id: string;
    manifestId: string;
    projectId?: string;
    ownerUserId?: string;
    tier: number;
    status: string;
  };

  if (gadgetInstance.status !== "active") {
    return c.json({ error: "Gadget instance is not active" }, 400);
  }

  // Tier 1 Private Gadgets: Only the creator user can request a token
  if (gadgetInstance.tier === 1 && gadgetInstance.ownerUserId && gadgetInstance.ownerUserId !== authUser.id) {
    return c.json({ error: "Access Denied: Tier 1 Gadgets are user-private" }, 403);
  }

  // 3. Attenuate capabilities based on the Human Clearance Ceiling (Invariant #1)
  const reqBody = await c.req.json().catch(() => ({})) as { ttlSeconds?: number };
  const ttlSeconds = Math.min(reqBody.ttlSeconds || 3600, 86400); // Capped at 24h max

  const allowedGrants: GatekeeperGrant[] = [
    {
      resource: "sqlite_db",
      target: `gadget:${instanceId}`,
      operations: userRoleRank >= 3 ? ["read", "write", "delete"] : ["read"]
    },
    {
      resource: "mcp_tool",
      target: `mcp.gadget_${instanceId}.*`,
      operations: userRoleRank >= 3 ? ["read", "execute"] : ["read"]
    }
  ];

  // If user is Admin/Owner (Rank 4-5), grant notification capability
  if (userRoleRank >= 4) {
    allowedGrants.push({
      resource: "notifications",
      target: "*",
      operations: ["notify"]
    });
  }

  // 4. Construct payload and sign token
  const now = Date.now();
  const payload: GatekeeperCapabilityPayload = {
    appId: gadgetInstance.manifestId,
    gadgetInstanceId: instanceId,
    spaceId: spaceId,
    projectId: gadgetInstance.projectId,
    creatorUserId: authUser.id,
    creatorRoleRank: userRoleRank,
    grants: allowedGrants,
    issuedAt: now,
    expiresAt: now + (ttlSeconds * 1000)
  };

  const signedToken = await mintGatekeeperToken(payload, platformSecret);

  return c.json({
    ok: true,
    token: signedToken,
    gadgetInstanceId: instanceId,
    spaceId: spaceId,
    expiresAt: new Date(payload.expiresAt).toISOString(),
    grantedCapabilities: allowedGrants
  });
});
```

---

## 6. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. Update `packages/types/src/gadgets.ts`:
   - Export `GatekeeperGrant`, `GatekeeperCapabilityPayload`, `GatekeeperTokenRequest`, and `GatekeeperTokenResponse`.
2. Update `workers/security/src/gatekeeper.ts`:
   - Implement WebCrypto HMAC-SHA256 `mintGatekeeperToken`, `verifyGatekeeperToken`, and `isOperationGranted`.
   - Ensure base64url encoding uses standard WebCrypto buffers without external dependencies.
3. Update `workers/spaces/src/index.ts`:
   - Register route `POST /spaces/:spaceId/gadgets/:instanceId/token`.
   - Verify membership, enforce the Role Rank Human Clearance Ceiling, fetch Gadget instance state from `SpaceDO`, and return the signed HMAC token.
4. Run `node --check` syntax validation on the modified files.
```
