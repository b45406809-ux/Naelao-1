export type GatekeeperResource = "sqlite_db" | "r2_workspace" | "mcp_tool" | "channel_notify";
export type GatekeeperOperation = "read" | "write" | "delete" | "execute";

export interface GatekeeperGrant {
  resource: GatekeeperResource;
  target: string;         // e.g. "table:invoices", "file:src/*", "tool:send_email"
  operations: GatekeeperOperation[];
  constraints?: {
    maxAmountCents?: number;
    rateLimitPerMin?: number;
  };
}

export interface GatekeeperToken {
  appId: string;          // The ID of the Gadget or Agent
  spaceId: string;
  userId: string;
  roleRank: number;       // 1 (Viewer) to 5 (Owner)
  grants: GatekeeperGrant[];
  iat: number;            // Issued at
  exp: number;            // Expires at (default 1 hour)
  sig: string;            // HMAC-SHA256(payload, PLATFORM_SECRET)
}

export interface MintTokenOptions {
  appId: string;
  spaceId: string;
  userId: string;
  roleRank: number;
  requestedGrants?: GatekeeperGrant[];
  expiresInSeconds?: number;
}
