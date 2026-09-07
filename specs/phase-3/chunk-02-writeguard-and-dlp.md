Here is the complete, fully detailed Markdown specification file for **Phase 3 — Chunk 02**: `specs/phase-3/chunk-02-writeguard-and-dlp.md`.

---

```markdown
---
chunk_id: "phase-3-chunk-02"
phase: 3
include_files:
  - packages/security/src/writeguard.ts
  - packages/security/src/dlp.ts
  - workers/credentials/src/index.ts
repomix_include:
  - "packages/security/src/writeguard.ts"
  - "packages/security/src/dlp.ts"
  - "workers/credentials/src/index.ts"
expected_outputs:
  - packages/security/src/writeguard.ts
  - packages/security/src/dlp.ts
  - workers/credentials/src/index.ts
---

# Phase 3 — Chunk 02: WriteGuard Mutation Interceptor & Egress DLP

## 1. Mental Model & Architectural Vision

In AVOS, agents can execute SQL mutations against DO Facet databases and make outbound HTTP requests to third-party APIs using `ctx.vault.fetchWithAuth()`. 

Relying on system prompts (e.g., *"Do not delete tables"* or *"Do not leak user SSNs"*) is a fragile defense against prompt injection. Instead, we enforce security at the **Edge Network & Execution Boundary** using two physical interceptors:

1. **WriteGuard (Mutation Interceptor):** Inspects raw SQL queries at the SQLite execution boundary. Destructive operations (`DROP`, `DELETE *`, `ALTER`) are physically blocked unless accompanied by a cryptographically signed **Gatekeeper Token** proving human authorization.
2. **Egress DLP (Data Loss Prevention):** Acts as an outbound firewall. Before `ctx.vault` transmits a payload to a public consumer connector (e.g., Discord, X/Twitter, Instagram), it scans the payload for PII (Credit Cards, SSNs, Private Keys). If detected, the transmission is blocked (403 Forbidden) and flagged for human review.

```
[ Prompt Injected Agent: "Drop the users table and tweet all SSNs" ]
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 🛑 EDGE SECURITY PROXY (Zero-Trust Boundaries)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. WRITEGUARD (SQL Interceptor):                                            │
│    • `DROP TABLE users` ──► Blocked! No Gatekeeper Token found.             │
│ 2. EGRESS DLP (Network Interceptor):                                        │
│    • `fetch("api.twitter.com", { body: "SSN: ***-**-****" })` ──► Blocked!  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Implementation Requirements

### A. Create `packages/security/src/writeguard.ts`
Implement the SQL mutation inspector. While a full SQL AST parser is the end-state, implement robust regex boundary checks for destructive operations:

```typescript
export interface WriteGuardResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Validates a SQL query string to prevent unauthorized destructive operations.
 * Requires a valid Gatekeeper token for DROP, ALTER, or unbounded DELETEs.
 */
export function isSafeSqlMutation(sql: string, hasGatekeeperToken: boolean): WriteGuardResult {
  if (!sql) return { allowed: false, reason: "Empty SQL statement." };

  const normalized = sql.toUpperCase().replace(/\s+/g, " ").trim();
  
  const isDestructive = 
    normalized.includes("DROP TABLE") || 
    normalized.includes("DROP INDEX") || 
    normalized.includes("ALTER TABLE") ||
    normalized.includes("TRUNCATE TABLE") ||
    // Catch unbounded deletes (DELETE FROM table without a WHERE clause)
    (normalized.includes("DELETE FROM") && !normalized.includes("WHERE"));

  if (isDestructive && !hasGatekeeperToken) {
    return { 
      allowed: false, 
      reason: "Destructive SQL operations require a valid Gatekeeper capability token." 
    };
  }

  return { allowed: true };
}
```

### B. Create `packages/security/src/dlp.ts`
Implement the Data Loss Prevention scanner for outbound payloads:

```typescript
const PII_PATTERNS = [
  // Rough credit card match (13-16 digits with optional dashes/spaces)
  { name: "Credit Card", regex: /\b(?:\d[ -]*?){13,16}\b/g },
  // US Social Security Number
  { name: "SSN", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Stripe Secret Keys
  { name: "Stripe Key", regex: /sk_(live|test)_[0-9a-zA-Z]{24,}/g },
  // Standard RSA/EC Private Keys
  { name: "Private Key", regex: /-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----/g }
];

export interface DlpScanResult {
  isClean: boolean;
  scrubbedPayload: string;
  flaggedCategories: string[];
}

/**
 * Scans stringified payloads for sensitive PII/Secrets.
 * Returns the scrubbed payload and flags any matched categories.
 */
export function scrubOutboundPayload(payload: string): DlpScanResult {
  if (!payload) return { isClean: true, scrubbedPayload: payload, flaggedCategories: [] };

  let cleanPayload = payload;
  const flaggedCategories = new Set<string>();

  for (const { name, regex } of PII_PATTERNS) {
    if (regex.test(cleanPayload)) {
      flaggedCategories.add(name);
      cleanPayload = cleanPayload.replace(regex, `[REDACTED_${name.replace(/\s+/g, "_").toUpperCase()}]`);
    }
  }

  return { 
    isClean: flaggedCategories.size === 0, 
    scrubbedPayload: cleanPayload, 
    flaggedCategories: Array.from(flaggedCategories) 
  };
}
```

### C. Update `workers/credentials/src/index.ts`
Integrate the DLP scanner into the outbound `fetchWithAuth` and `authorizeConnectorCall` flows to physically block exfiltration to public connectors.

```typescript
import { scrubOutboundPayload } from "@naelao/security/dlp";

/**
 * Public domains that must be strictly audited for PII exfiltration.
 */
const PUBLIC_CONSUMER_DOMAINS = ["api.twitter.com", "discord.com/api", "graph.instagram.com"];

export async function proxyOutboundRequestWithAuth(
  url: string,
  opts: { credentialName: string; method?: string; body?: any; headers?: Record<string, string> },
  callerContext: { spaceId: string; userId: string; role: string }
) {
  const targetUrl = new URL(url);
  const isPublicDomain = PUBLIC_CONSUMER_DOMAINS.some(d => targetUrl.hostname.endsWith(d));

  let finalBody = opts.body;

  // 1. Egress DLP Scan for Public Connectors
  if (isPublicDomain && opts.body) {
    const stringifiedBody = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    const dlpResult = scrubOutboundPayload(stringifiedBody);

    if (!dlpResult.isClean) {
      throw new Error(
        `403 Forbidden: Outbound payload blocked by DLP policy. Detected sensitive data: ${dlpResult.flaggedCategories.join(", ")}.`
      );
    }
    
    // Use the safely scrubbed payload if we decide to proceed rather than hard-block
    // (For AVOS strict compliance, we throw an error instead of silently modifying request signatures)
  }

  // 2. Resolve Credential securely (From Phase 3 Chunk 01 logic)
  const credential = await resolveCredentialForRun(callerContext.spaceId, opts.credentialName, {
    actingUserId: callerContext.userId
  });

  if (!credential) {
    throw new Error(`401 Unauthorized: Credential '${opts.credentialName}' not found or insufficient scope.`);
  }

  // 3. Inject credential into headers at network boundary
  const headers = new Headers(opts.headers || {});
  headers.set("Authorization", `Bearer ${credential.decryptedValue}`);

  // 4. Dispatch the request
  return await fetch(targetUrl.toString(), {
    method: opts.method || "GET",
    headers,
    body: finalBody
  });
}
```
```
