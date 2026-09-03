/**
 * Gatekeepers — Capability-Based Security Model for Micro-Apps (Edge SQLite + V8 Isolates).
 *
 * Traditional plugins and AI apps suffer from the Fatal Raw API Key Flaw:
 * giving an agent or app a master secret allows prompt injections or buggy scripts
 * to query across tenants, read unauthorized databases, or drain platform funds.
 *
 * Gatekeepers replaces raw API keys with unforgeable, cryptographically signed,
 * attenuated Capability Tokens enforcing THREE core invariants:
 *
 * 1. THE HUMAN PERMISSION CEILING (Invariant #1):
 *    An agent or micro-app can NEVER hold more power than the human creator.
 *    If creator Alice is a "Member" (no refund authority), any micro-app
 *    Alice builds is physically incapable of minting refund/charge capabilities.
 *
 * 2. RESOURCE-LEVEL ATTENUATION (Invariant #2):
 *    Grants are scoped strictly to specific resources (e.g. `table:expenses`,
 *    `slack:#warehouse-alerts` max 10 msgs/min, `stripe:charge` BLOCKED).
 *
 * 3. ZERO-LEAK RUNTIME PROXY (Invariant #3):
 *    The micro-app code NEVER holds raw infrastructure credentials. Outbound
 *    operations pass through the Gatekeeper middleware/proxy which verifies
 *    the HMAC-signed token before injecting downstream secrets at the edge boundary.
 */

export interface GatekeeperGrant {
  resource: "sqlite_db" | "mcp_tool" | "channel_notify" | "storage_bucket" | (string & {});
  /** Target resource identifier (e.g. "table:expenses", "table:app_records", "slack:#warehouse-alerts", "*") */
  target: string;
  /** Granular allowed operations on this resource */
  operations: Array<"read" | "write" | "delete" | "execute">;
  /** Optional rate or numerical boundaries */
  constraints?: {
    rateLimitPerMinute?: number;
    maxAmountCents?: number;
    allowedTables?: string[];
    [key: string]: unknown;
  };
}

export interface GatekeeperCapability {
  appId: string;
  spaceId: string;
  creatorUserId: string;
  /** Clamped by Creator's Role Rank (Viewer=1, Member=2, Editor=3, Admin=4, Owner=5) */
  creatorRoleRank: number;
  /** Granular resource grants */
  grants: GatekeeperGrant[];
  issuedAt: number;
  expiresAt: number;
  /** Delegated target space IDs if cross-subspace delegation is active */
  targetSpaceId?: string;
  allowedOps?: string[];
  /** HMAC-SHA256 signature signed with PLATFORM_SECRET */
  signature: string;
}

export type GadgetScope = "USER_PRIVATE" | "PROJECT_BOUND" | "SPACE_WIDE" | "CROSS_SUBSPACE_DELEGATED";

export interface AvosGadgetManifest {
  id: string; // e.g. "gadget_bug_tracker_v1"
  name: string;
  description: string;

  // 1. Scoping & Installation Boundary
  scope: GadgetScope;
  ownerSpaceId: string;
  ownerUserId: string;
  projectId?: string;

  // Target Subspaces (For Cross-Subspace Sharing)
  delegatedTargetSpaceIds?: string[];

  // 2. Storage & Compute
  runtime: {
    engine: "dynamic_worker_isolate"; // Runs in sub-ms V8 isolate
    database: "do_facet_sqlite";       // Private dedicated SQLite DB
    enableMcpV2Api: boolean;          // Exposes auto-generated /mcp endpoint
  };

  // 3. Gatekeeper Security Policy
  gatekeeperGrants: Array<{
    resource: "sqlite_db" | "notifications" | "slack" | string;
    operations: Array<"read" | "write" | "notify" | "delete" | "execute">;
  }>;
}

export const GATEKEEPER_ROLE_RANKS = {
  viewer: 1,
  member: 2,
  editor: 3,
  admin: 4,
  owner: 5,
} as const;

export type GatekeeperRole = keyof typeof GATEKEEPER_ROLE_RANKS;

export function getRoleRank(role: string | number): number {
  if (typeof role === "number") {
    return Math.max(1, Math.min(5, Math.floor(role)));
  }
  const normalized = String(role || "").toLowerCase() as GatekeeperRole;
  return GATEKEEPER_ROLE_RANKS[normalized] ?? 1;
}

/**
 * Invariant #1: Clamp requested grants to the human creator's permission ceiling.
 * Prevents privilege escalation when an AI synthesis prompt requests sensitive actions.
 */
export function clampGrantsToRole(role: string | number, requestedGrants: GatekeeperGrant[]): GatekeeperGrant[] {
  const rank = getRoleRank(role);
  const clamped: GatekeeperGrant[] = [];

  for (const grant of requestedGrants) {
    const ops: Array<"read" | "write" | "delete" | "execute"> = [];

    // Viewer (1): Strictly read-only on app data
    if (rank === 1) {
      if (grant.resource === "sqlite_db" || grant.resource === "storage_bucket") {
        if (grant.operations.includes("read")) ops.push("read");
      }
    }
    // Member (2): Read & write on app data; limited channel notifications; no delete or financial tools
    else if (rank === 2) {
      if (grant.resource === "sqlite_db") {
        if (grant.operations.includes("read")) ops.push("read");
        if (grant.operations.includes("write")) ops.push("write");
      } else if (grant.resource === "channel_notify") {
        if (grant.operations.includes("execute") || grant.operations.includes("write")) {
          ops.push("execute");
        }
      } else if (grant.resource === "storage_bucket") {
        if (grant.operations.includes("read")) ops.push("read");
        if (grant.operations.includes("write")) ops.push("write");
      }
    }
    // Editor (3): Full CRUD on app database, notification webhooks, standard MCP tool execution
    else if (rank === 3) {
      if (grant.resource === "sqlite_db" || grant.resource === "storage_bucket") {
        for (const op of grant.operations) {
          if (["read", "write", "delete", "execute"].includes(op)) ops.push(op);
        }
      } else if (grant.resource === "channel_notify" || grant.resource === "mcp_tool") {
        // High-risk targets (charges, refunds, billing, admin-deletion) require rank >= 4 (Admin)
        const isHighRisk = /(charge|refund|payout|billing|admin|delete_space)/i.test(grant.target);
        if (!isHighRisk) {
          for (const op of grant.operations) ops.push(op);
        }
      }
    }
    // Admin (4) & Owner (5): Uncapped within space boundary
    else {
      ops.push(...grant.operations);
    }

    if (ops.length > 0) {
      const grantItem: GatekeeperGrant = {
        resource: grant.resource,
        target: grant.target,
        operations: Array.from(new Set(ops)),
      };
      if (grant.constraints) {
        grantItem.constraints = { ...grant.constraints };
      }
      clamped.push(grantItem);
    }
  }

  return clamped;
}

/** WebCrypto HMAC helper */
async function computeHmacSha256(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(canonicalStringify).join(",")}]`;
  }
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(record[k])}`).join(",")}}`;
}

function base64UrlEncode(str: string): string {
  const b64 = btoa(unescape(encodeURIComponent(str)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): string {
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  return decodeURIComponent(escape(atob(b64)));
}

/**
 * Mint an unforgeable Gatekeeper Capability Token.
 */
export async function mintGatekeeperToken(
  params: {
    appId: string;
    spaceId: string;
    creatorUserId: string;
    creatorRole: string | number;
    grants: GatekeeperGrant[];
    ttlSeconds?: number;
    issuedAt?: number;
  },
  platformSecret: string
): Promise<string> {
  if (!platformSecret) {
    throw new Error("Cannot mint Gatekeeper token: PLATFORM_SECRET is required.");
  }
  const now = params.issuedAt ?? Date.now();
  const ttlMs = (params.ttlSeconds ?? 86400) * 1000;
  const expiresAt = now + ttlMs;

  const roleRank = getRoleRank(params.creatorRole);
  const clampedGrants = clampGrantsToRole(roleRank, params.grants);

  const payloadToSign = {
    appId: params.appId,
    spaceId: params.spaceId,
    creatorUserId: params.creatorUserId,
    creatorRoleRank: roleRank,
    grants: clampedGrants,
    issuedAt: now,
    expiresAt,
    targetSpaceId: (params as any).targetSpaceId,
    allowedOps: (params as any).allowedOps,
  };

  const canonical = canonicalStringify(payloadToSign);
  const signature = await computeHmacSha256(canonical, platformSecret);

  const fullCapability: GatekeeperCapability = {
    ...payloadToSign,
    signature,
  };

  return `gk_${base64UrlEncode(JSON.stringify(fullCapability))}`;
}

/**
 * Mint an attenuated Gatekeeper Capability Token for Cross-Subspace Delegation
 * (e.g. PM Subspace delegating a gadget to Developer Subspace).
 */
export async function mintDelegatedGatekeeperToken(
  params: {
    gadgetId: string;
    fromSpaceId: string;
    toSpaceId: string;
    delegatorUserId: string;
    delegatorRole: string | number;
    allowedOps: string[];
    ttlSeconds?: number;
  },
  platformSecret: string
): Promise<string> {
  const grants: GatekeeperGrant[] = [
    {
      resource: "sqlite_db",
      target: params.gadgetId,
      operations: params.allowedOps.map((op) =>
        op.startsWith("read") || op === "select" ? "read" : "write"
      ) as Array<"read" | "write">,
      constraints: {
        delegatedToSpaceId: params.toSpaceId,
        delegatedAllowedOps: params.allowedOps,
      },
    },
  ];

  return mintGatekeeperToken(
    {
      appId: params.gadgetId,
      spaceId: params.fromSpaceId,
      creatorUserId: params.delegatorUserId,
      creatorRole: params.delegatorRole,
      grants,
      ttlSeconds: params.ttlSeconds || 30 * 86400,
      targetSpaceId: params.toSpaceId,
      allowedOps: params.allowedOps,
    } as any,
    platformSecret
  );
}

/**
 * Verify cryptographic signature, expiration, and payload integrity of a Gatekeeper Token.
 */
export async function verifyGatekeeperToken(
  tokenString: string,
  platformSecret: string
): Promise<GatekeeperCapability> {
  if (!tokenString || typeof tokenString !== "string") {
    throw new Error("Gatekeeper Violation: No capability token provided.");
  }
  if (!platformSecret) {
    throw new Error("Gatekeeper Violation: Server PLATFORM_SECRET is unconfigured.");
  }

  const raw = tokenString.startsWith("gk_") ? tokenString.slice(3) : tokenString;
  let parsed: unknown;
  try {
    const json = base64UrlDecode(raw);
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Gatekeeper Violation: Malformed capability token encoding.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Gatekeeper Violation: Invalid capability token structure.");
  }

  const cap = parsed as GatekeeperCapability;
  if (
    !cap.appId ||
    !cap.spaceId ||
    !cap.creatorUserId ||
    typeof cap.creatorRoleRank !== "number" ||
    !Array.isArray(cap.grants) ||
    typeof cap.issuedAt !== "number" ||
    typeof cap.expiresAt !== "number" ||
    !cap.signature
  ) {
    throw new Error("Gatekeeper Violation: Missing required capability fields.");
  }

  if (Date.now() > cap.expiresAt) {
    throw new Error("Gatekeeper Violation: Token expired.");
  }

  const payloadToVerify = {
    appId: cap.appId,
    spaceId: cap.spaceId,
    creatorUserId: cap.creatorUserId,
    creatorRoleRank: cap.creatorRoleRank,
    grants: cap.grants,
    issuedAt: cap.issuedAt,
    expiresAt: cap.expiresAt,
    targetSpaceId: cap.targetSpaceId,
    allowedOps: cap.allowedOps,
  };

  const canonical = canonicalStringify(payloadToVerify);
  const expectedSig = await computeHmacSha256(canonical, platformSecret);

  if (expectedSig !== cap.signature) {
    throw new Error("Gatekeeper Violation: Cryptographic signature mismatch / token tampered.");
  }

  return cap;
}

/**
 * Checks whether a delegated capability token authorizes a specific operation on a target gadget.
 */
export function checkDelegatedGatekeeperGrant(
  capability: GatekeeperCapability,
  targetGadgetId: string,
  op: string,
  callerSpaceId?: string
): boolean {
  if (capability.appId !== targetGadgetId) return false;
  if (callerSpaceId && capability.targetSpaceId && capability.targetSpaceId !== callerSpaceId) {
    return false;
  }
  if (!capability.allowedOps || capability.allowedOps.length === 0) {
    return true; // No granular restrictions
  }
  return capability.allowedOps.includes(op) || capability.allowedOps.includes("*");
}

/**
 * Checks whether a given capability covers the required resource, target, and operation.
 * Supports wildcard matching for targets (e.g. `*`, `table:*`, `table:expenses`).
 */
export function checkGatekeeperGrant(
  capability: GatekeeperCapability,
  requiredGrant: {
    resource: string;
    target: string;
    op: "read" | "write" | "delete" | "execute";
  }
): boolean {
  return capability.grants.some((g) => {
    if (g.resource !== requiredGrant.resource) return false;

    // Target matching
    const targetMatch =
      g.target === "*" ||
      g.target === requiredGrant.target ||
      (g.target === "table:*" && requiredGrant.target.startsWith("table:")) ||
      (g.target.endsWith("*") && requiredGrant.target.startsWith(g.target.slice(0, -1)));

    if (!targetMatch) return false;

    // Operation matching
    return g.operations.includes(requiredGrant.op);
  });
}

/**
 * Middleware helper for HTTP endpoints to enforce Gatekeeper capability tokens.
 */
export async function enforceGatekeeper(
  req: Request | { headers: Headers | { get(h: string): string | null } },
  requiredGrant: {
    resource: string;
    target: string;
    op: "read" | "write" | "delete" | "execute";
  },
  platformSecret: string
): Promise<GatekeeperCapability> {
  const tokenHeader =
    req.headers.get("x-gatekeeper-token") ||
    req.headers.get("x-capability-token") ||
    (req.headers.get("authorization")?.startsWith("Bearer gk_")
      ? req.headers.get("authorization")!.slice(7)
      : null);

  if (!tokenHeader) {
    throw new Error("Gatekeeper Violation: No capability token provided.");
  }

  const capability = await verifyGatekeeperToken(tokenHeader, platformSecret);

  const isAuthorized = checkGatekeeperGrant(capability, requiredGrant);
  if (!isAuthorized) {
    throw new Error(
      `Gatekeeper Block: App '${capability.appId}' lacks '${requiredGrant.op}' grant on '${requiredGrant.target}'.`
    );
  }

  return capability;
}
