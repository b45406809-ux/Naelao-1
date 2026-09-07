Here is the complete, high-detail Markdown specification for **Phase 6 — Chunk 05: The Gatekeeper Security Model & WriteGuard Egress Proxy**.

This chunk implements the **Zero-Trust** core of the AVOS security model, ensuring that autonomous gadgets and agents can never perform actions beyond their assigned permissions, and providing a cryptographic audit trail for every mutation.

---

### Chunk 5: `specs/phase-2/chunk-05-gatekeeper-security-and-writeguard.md`

```markdown
---
chunk_id: "phase-6-chunk-05"
phase: 6
include_files:
  - workers/security/src/gatekeeper.ts
  - workers/agents/src/do/NaelaoAgentDO.ts
  - workers/spaces/src/do/MicroAppDO.ts
  - packages/security/src/index.ts
repomix_include:
  - "workers/security/src/gatekeeper.ts"
  - "workers/agents/src/do/NaelaoAgentDO.ts"
  - "workers/spaces/src/do/MicroAppDO.ts"
  - "packages/security/src/index.ts"
expected_outputs:
  - workers/security/src/gatekeeper.ts
  - workers/security/src/write-guard.ts
  - packages/security/src/types.ts
---

# Phase 6 — Chunk 05: Gatekeeper Security Model & WriteGuard Proxy

## 1. Executive Summary & Architectural Vision

The fatal flaw of traditional AI platforms is the use of **Raw API Keys**. If an autonomous agent or a user-generated micro-app is given a master API key, a single prompt injection or logic bug can result in the deletion of company data or exfiltration of secrets.

AVOS replaces API keys with the **Gatekeeper Security Model**:
1.  **Capability-Based Attenuation:** Instead of "all-access" keys, agents and gadgets are issued **Gatekeeper Tokens**—unforgeable, short-lived, HMAC-signed JSON objects that define exactly which resources (`sqlite_db`, `r2_file`) and which operations (`read`, `write`) are permitted.
2.  **The Human Permission Ceiling:** A token can **never** grant more power than the human user who initiated the run. If Alice is a "Member," her agent cannot mint an "Admin" token.
3.  **WriteGuard (Egress Interceptor):** A security middleware that sits between the execution sandbox and the database. It inspects every SQL statement and tool call, blocking destructive mutations (`DROP`, `DELETE *`) unless the Gatekeeper Token explicitly authorizes that specific high-risk action.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        THE GATEKEEPER SECURITY FLOW                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. INITIATION: User (Alice) prompts agent or opens a Gadget.                │
│ 2. MINTING: Platform mints a Token signed with `PLATFORM_SECRET`.           │
│    `{ user: "Alice", role: "member", grants: ["db:read", "fs:read"] }`      │
│ 3. EXECUTION: Gadget/Agent calls `ctx.fs.edit("config.json")`.              │
│ 4. INTERCEPTION (WriteGuard): Validates Token.                              │
│    • Does Token have "fs:write" grant? ──► YES.                             │
│    • Is the patch surgical (not delete)? ──► YES.                           │
│ 5. RESOLUTION: Operation executed; Audit log written.                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Technical Specifications

### A. The Gatekeeper Token Structure (`packages/security/src/types.ts`)

Define the cryptographic contract for capability tokens:

```typescript
export interface GatekeeperGrant {
  resource: "sqlite_db" | "r2_workspace" | "mcp_tool" | "channel_notify";
  target: string;         // e.g. "table:invoices", "file:src/*", "tool:send_email"
  operations: Array<"read" | "write" | "delete" | "execute">;
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
```

---

### B. The WriteGuard Interceptor (`workers/security/src/write-guard.ts`)

Implement the logic to inspect mutations before they reach the Durable Object storage:

```typescript
export class WriteGuard {
  /**
   * Inspects a SQL query string for destructive patterns.
   * Blocks any query that attempts to modify structure or perform bulk deletes
   * unless the token carries an explicit 'admin' or 'delete' grant.
   */
  static async validateSqlQuery(sql: string, token: GatekeeperToken): Promise<{ allowed: boolean; reason?: string }> {
    const normalized = sql.toLowerCase().trim();
    
    // 1. Block structural changes (DDL) for all standard tokens
    const destructivePatterns = ["drop table", "alter table", "truncate", "vacuum"];
    if (destructivePatterns.some(p => normalized.includes(p))) {
      return { allowed: false, reason: "Structural mutations (DDL) are strictly forbidden via Gatekeeper." };
    }

    // 2. Inspect DELETE operations
    if (normalized.startsWith("delete")) {
      const hasDeleteGrant = token.grants.some(g => g.resource === "sqlite_db" && g.operations.includes("delete"));
      if (!hasDeleteGrant) {
        return { allowed: false, reason: "Bulk delete operations require an explicit 'delete' capability." };
      }
      
      // Ensure WHERE clause is present to prevent 'DELETE FROM table'
      if (!normalized.includes("where")) {
        return { allowed: false, reason: "Unbounded DELETE operations are forbidden. A WHERE clause is required." };
      }
    }

    return { allowed: true };
  }
}
```

---

### C. The Gatekeeper Middleware (`workers/security/src/gatekeeper.ts`)

Implement the token verification and attenuation check:

```typescript
export async function verifyGatekeeperToken(rawToken: string, secret: string): Promise<GatekeeperToken> {
  // 1. Extract payload and signature
  // 2. Re-compute HMAC and compare (constant-time)
  // 3. Check 'exp' timestamp
  // 4. Return the typed object
}

export function checkCapability(token: GatekeeperToken, required: { resource: string; op: string; target?: string }): boolean {
  return token.grants.some(grant => {
    const resourceMatch = grant.resource === required.resource;
    const opMatch = grant.operations.includes(required.op as any);
    const targetMatch = !required.target || grant.target === "*" || grant.target === required.target;
    return resourceMatch && opMatch && targetMatch;
  });
}
```

---

## 3. Implementation Instructions for the AI Runner

1.  **Define Core Types:** Create `packages/security/src/types.ts` and export the `GatekeeperToken` interfaces.
2.  **Implement Minting Logic:** In `workers/security/src/gatekeeper.ts`, implement `mintGatekeeperToken`. It must accept the `roleRank` of the initiating user and ensure the `grants` array is attenuated (clamped) by that rank.
3.  **Implement WriteGuard:** Create `workers/security/src/write-guard.ts`. Use basic string/regex parsing (or a lightweight SQL parser) to detect and block `DROP`, `TRUNCATE`, and unbounded `DELETE` commands.
4.  **Wire into MicroAppDO:** Update `workers/spaces/src/do/MicroAppDO.ts` to expect an `x-gatekeeper-token` header on all `/api/data` requests.
    *   Call `verifyGatekeeperToken`.
    *   Pass the SQL query to `WriteGuard.validateSqlQuery` before executing `this.ctx.storage.sql.exec()`.
5.  **Audit Logs:** For every mutation, write an audit row to the `SpaceDO` ledger including the `userId` and `appId` extracted from the token.

## 4. Integration Invariants
*   **Fail Closed:** If a token is missing, malformed, or expired, the request must return `403 Forbidden`.
*   **No Raw Secrets:** The `MicroAppDO` and `NaelaoAgentDO` must never see the `PLATFORM_SECRET`. The signature check happens at the secure worker boundary.
*   **Isolate Independence:** Tokens are stateless. A V8 isolate can be destroyed and recreated; as long as the token is valid, the session continues.
```
