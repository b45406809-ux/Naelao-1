Here is the complete, fully-detailed, production-ready Markdown specification file for **Phase 3 — Chunk 01**: `specs/phase-3/chunk-01-universal-sdk-and-vault.md`. 

Save this file exactly as written into your `specs/phase-3/` directory.

```markdown
---
chunk_id: "phase-3-chunk-01"
phase: 3
include_files:
  - workers/agents/src/script-engine/types.ts
  - workers/credentials/src/index.ts
  - packages/types/src/index.ts
repomix_include:
  - "workers/agents/src/script-engine/types.ts"
  - "workers/credentials/src/index.ts"
  - "packages/types/src/index.ts"
expected_outputs:
  - workers/agents/src/script-engine/types.ts
  - workers/credentials/src/index.ts
  - packages/types/src/credentials.ts
---

# Phase 3 — Chunk 01: Universal SDK (`ctx`) & Zero-Leak Vault

## 1. Mental Model & Architectural Vision

In traditional AI coding platforms, agents generate code that handles raw API keys (`const apiKey = "sk_live_1234"`). This is a massive security hazard—it exposes credentials to logs, prompts, and potential exfiltration attacks.

AVOS eliminates this using the **Universal Runtime SDK (`ctx`)** and **Outbound Workers**. 
* **The Agent** writes clean TypeScript code against the `ctx` object.
* **The Code** requests outbound fetches using logical names (`credentialName: "STRIPE_SECRET_KEY"`). 
* **The Infrastructure** injects the decrypted secret directly at the edge network boundary via Cloudflare Outbound Workers. The raw key *never* touches the V8 isolate or Linux container execution environment.

### The 3-Tier Credential Scoping Hierarchy
To support multiple humans and bots safely in one shared project, credentials must resolve hierarchically based on **who** triggered the run:

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                               3-TIER CREDENTIAL RESOLUTION MATRIX                                      │
├─────────────────────────┬────────────────────────────┬─────────────────────────────────────────────────┤
│ Scope Level             │ Ownership                  │ Access Rules & Resolution Order                 │
├─────────────────────────┼────────────────────────────┼─────────────────────────────────────────────────┤
│ 1. **USER_PERSONAL**    │ Individual Human (Alice)   │ Checked FIRST. Fails cleanly with 403 Forbidden │
│ e.g. Alice's GitHub     │                            │ if `actingUserId` != `ownerUserId`. Bob cannot  │
│                         │                            │ trigger actions using Alice's tokens.           │
├─────────────────────────┼────────────────────────────┼─────────────────────────────────────────────────┤
│ 2. **PROJECT_BOUND**    │ A Specific Project         │ Checked SECOND. Valid only if `projectId` in    │
│ e.g. Support WhatsApp   │                            │ the execution context matches the credential.   │
├─────────────────────────┼────────────────────────────┼─────────────────────────────────────────────────┤
│ 3. **SPACE_SHARED**     │ Entire Company / Space     │ Checked THIRD (Fallback). Available to all      │
│ e.g. Company Stripe     │                            │ projects and agents in the business space.      │
└─────────────────────────┴────────────────────────────┴─────────────────────────────────────────────────┘
```

---

## 2. Implementation Requirements

### A. Define Credential Types (`packages/types/src/credentials.ts`)
Create `packages/types/src/credentials.ts` (and export it in `packages/types/src/index.ts`):

```typescript
export type CredentialScope = "SPACE_SHARED" | "PROJECT_BOUND" | "USER_PERSONAL";

export interface VaultCredential {
  id: string;
  spaceId: string;
  name: string; // The logical alias, e.g. "STRIPE_SECRET_KEY"
  scope: CredentialScope;
  ownerUserId?: string; // Required if scope === "USER_PERSONAL"
  boundProjectId?: string; // Required if scope === "PROJECT_BOUND"
  encryptedValue: string; // AES-256-GCM encrypted
  createdAt: string;
  updatedAt: string;
}

export interface RunResolutionContext {
  actingUserId?: string;
  projectId?: string;
  isSystemCron?: boolean;
}
```

### B. Implement the Universal SDK Interfaces (`workers/agents/src/script-engine/types.ts`)
Define the comprehensive `AvosRuntimeContext` that all CodeMode scripts, Virtual CLIs, and Workflows will use to interface with the platform:

```typescript
export interface AvosRuntimeContext {
  // 1. Filesystem (Backed by ArtifactFS / DO SQLite)
  fs: {
    read: (path: string, opts?: { offset?: number; limit?: number }) => Promise<{ content: string; totalLines: number }>;
    write: (path: string, content: string) => Promise<{ ok: boolean }>;
    edit: (path: string, oldStr: string, newStr: string) => Promise<{ ok: boolean }>;
    grep: (pattern: string, path?: string) => Promise<{ matches: Array<{ file: string; line: number; text: string }> }>;
    glob: (pattern: string) => Promise<{ files: string[] }>;
  };

  // 2. Zero-Leak Vault (Outbound Worker Edge Egress)
  vault: {
    fetchWithAuth: (url: string, opts: { credentialName: string; method?: string; body?: any; headers?: Record<string, string> }) => Promise<Response>;
  };

  // 3. Virtual CLI Bus
  cli: {
    exec: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
    register: (name: string, def: { description: string; subcommands: Record<string, string>; handlerCode: string }) => Promise<{ ok: boolean }>;
    extend: (name: string, subcommand: string, handlerSnippet: string) => Promise<{ ok: boolean }>;
    formatTable: (data: Array<Record<string, any>>) => string;
  };

  // 4. Decoupled Connectors (Composio/OAuth Wrappers)
  connectors: {
    use: (logicalAlias: string) => Promise<any>;
    isConnected: (platform: string) => Promise<boolean>;
    requestConnectionDialog: (platforms: string[], opts: { reason: string }) => never; // Emits MCP-UI and throws
  };

  // 5. Browser & Vision Senses
  browser: {
    scrape: (url: string, selector?: string) => Promise<{ content: string; title: string }>;
  };

  // 6. Project & Space Coordination
  project: {
    id: string;
    getJournal: () => Promise<{ tasks: Array<{ id: string; title: string; status: string }> }>;
    updateTaskStatus: (taskId: string, status: "PENDING" | "IN_PROGRESS" | "COMPLETED") => Promise<{ ok: boolean }>;
  };
  
  space?: {
    id: string;
    getWalletBalance: () => Promise<{ balance_cents: number }>;
  };
}
```

### C. Implement the Credential Resolver (`workers/credentials/src/index.ts`)
Implement the hierarchical resolution logic to safely retrieve the correct database row based on the caller's context:

```typescript
import { VaultCredential, RunResolutionContext } from "@naelao/types";

/**
 * Resolves the correct credential row based on the 3-Tier strict hierarchy.
 * WARNING: Never return the decrypted value directly to untrusted scripts!
 */
export async function resolveCredentialForRun(
  db: D1Database,
  spaceId: string,
  credentialName: string,
  runContext: RunResolutionContext
): Promise<VaultCredential> {

  // Rule 1: Background Crons / System Sweeps
  // Crons have no acting user. They CANNOT access USER_PERSONAL credentials.
  if (runContext.isSystemCron && !runContext.actingUserId) {
    const cred = await fetchCredential(db, spaceId, credentialName, "SPACE_SHARED");
    if (!cred) throw new Error(`Missing SPACE_SHARED credential: ${credentialName}`);
    return cred;
  }

  // Rule 2: User-Personal Match
  // If an acting user is present, check if THEY own a personal credential first.
  if (runContext.actingUserId) {
    const personalCred = await fetchCredential(db, spaceId, credentialName, "USER_PERSONAL", runContext.actingUserId);
    if (personalCred) return personalCred;
  }

  // Rule 3: Project-Bound Match
  if (runContext.projectId) {
    const projectCred = await fetchCredential(db, spaceId, credentialName, "PROJECT_BOUND", undefined, runContext.projectId);
    if (projectCred) return projectCred;
  }

  // Rule 4: Space-Shared Fallback
  const sharedCred = await fetchCredential(db, spaceId, credentialName, "SPACE_SHARED");
  if (sharedCred) return sharedCred;

  throw new Error(`Credential not found or access denied: ${credentialName}`);
}

async function fetchCredential(
  db: D1Database,
  spaceId: string,
  name: string,
  scope: string,
  ownerUserId?: string,
  boundProjectId?: string
): Promise<VaultCredential | null> {
  let query = `SELECT * FROM space_credentials WHERE space_id = ? AND name = ? AND scope = ?`;
  const params: any[] = [spaceId, name, scope];

  if (ownerUserId) {
    query += ` AND owner_user_id = ?`;
    params.push(ownerUserId);
  } else if (boundProjectId) {
    query += ` AND bound_project_id = ?`;
    params.push(boundProjectId);
  }

  return await db.prepare(query).bind(...params).first<VaultCredential>();
}
```
```
