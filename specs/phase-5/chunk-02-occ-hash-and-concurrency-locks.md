Here is the complete, single, fully detailed, production-ready Markdown specification file for **Phase 5 — Chunk 02**: `specs/phase-5/chunk-02-occ-hash-and-concurrency-locks.md`.

---

```markdown
---
chunk_id: "phase-5-chunk-02"
phase: 5
include_files:
  - workers/agents/src/do/ConcurrencyDO.ts
  - workers/agents/src/do/NaelaoAgentDO.ts
  - workers/spaces/src/do/SpaceDO.ts
repomix_include:
  - "workers/agents/src/do/ConcurrencyDO.ts"
  - "workers/agents/src/do/NaelaoAgentDO.ts"
  - "workers/spaces/src/do/SpaceDO.ts"
expected_outputs:
  - workers/agents/src/do/ConcurrencyDO.ts
  - workers/spaces/src/do/SpaceDO.ts
---

# Phase 5 — Chunk 02: Optimistic Concurrency Control (OCC) & Mutex Locks

## 1. Executive Summary & Architectural Vision

In a collaborative enterprise workspace where multiple human developers and autonomous AI operators (e.g. `@DevOperator`, `@ReviewBot`) work in the same repository simultaneously, raw uncoordinated file overwrites cause **silent write-clobbering, race conditions, and broken builds**.

AVOS enforces a robust, edge-native **2-Layer Concurrency Defense**:
1. **Layer 1: Optimistic Concurrency Control (OCC) with SHA-256 Hash Checkpoints:**  
   Every file in the authoritative SQLite `workspace_files` table carries a content hash. Edits execute as atomic Compare-And-Swap (CAS) transactions. If a file is modified mid-turn by another user or agent, the transaction aborts with a structured conflict exception, providing fresh line numbers for self-healing.
2. **Layer 2: Ephemeral Distributed File-Level Mutex Locks (`ConcurrencyDO`):**  
   Before an agent begins a complex, multi-file refactoring operation, it acquires a non-blocking distributed lock with a 30-second TTL. If another thread holds the lock, the agent adapts by working on independent tasks in its DAG rather than crashing.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 👩‍💻 TURN A: @DevOperator (Thread #102)                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Reads `src/Header.astro` ──► Base Hash: `h_v1`                           │
│ 2. Acquires lock: `lock.acquire("file:src/Header.astro", "thread_102")`     │
│    Status: ✅ GRANTED                                                       │
│ 3. Applies AST Search-and-Replace patch.                                    │
│ 4. Atomic OCC Write to SQLite:                                              │
│    `UPDATE workspace_files SET content = ?, hash = 'h_v2' ...               │
│     WHERE path = 'src/Header.astro' AND hash = 'h_v1'`                      │
│ 5. Lock released. WebSocket broadcasts `workspace.file_changed`.           │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │ (If Turn B attempts concurrent write)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 👨‍💻 TURN B: Concurrent Agent (Thread #103)                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Attempts CAS with outdated base hash `h_v1`.                             │
│ 2. SQLite returns `changes === 0`.                                          │
│ 3. Runtime raises `OccConflictError`:                                       │
│    `✖ Conflict: 'src/Header.astro' was modified 1.2s ago. Base hash changed`│
│ 4. Agent reads updated lines and self-heals patch on fresh `h_v2` state!    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Mathematical Formulation of the Atomic State Transition

Let a file $F$ in state $S_t$ have content hash $H(F_t) = \text{SHA256}(F_t)$. 

An agent's edit operation $\mathcal{E}$ consists of a search block $\sigma_{\text{find}}$, a replacement block $\sigma_{\text{replace}}$, and an expected base hash $H_{\text{base}}$.

The atomic state transition function $\mathcal{T}$ in DO SQLite is defined as:

$$\mathcal{T}(F, \mathcal{E}) = \begin{cases} 
\text{ApplyASTPatch}(F_t, \sigma_{\text{find}}, \sigma_{\text{replace}}), & \text{if } H(F_t) = H_{\text{base}} \land \text{IsLocked}(F) = \text{False} \\
\bot \; (\text{Abort \& Raise Conflict Exception}), & \text{otherwise}
\end{cases}$$

Upon transaction abort ($\bot$), the rollback state is computed and fed to the self-healing error handler:
$$\Delta_{\text{conflict}} = \{ \text{filePath}: F, \; \text{currentHash}: H(F_{t+1}), \; \text{lineHints}: \text{FuzzyLocate}(\sigma_{\text{find}}, F_{t+1}) \}$$

---

## 3. Technical Specifications & File Implementation Contracts

### A. `workers/spaces/src/do/SpaceDO.ts` (OCC Storage Engine)

Implement the atomic OCC update method, SHA-256 hash generator, and custom conflict error class in `SpaceDO.ts`:

```typescript
export interface OccWriteParams {
  projectId: string;
  path: string;
  newContent: string;
  expectedBaseHash: string;
  updatedBy: string;
}

export interface OccWriteResult {
  ok: boolean;
  newHash: string;
  sizeBytes: number;
  updatedAt: string;
}

export class OccConflictError extends Error {
  public code = "OCC_CONFLICT";
  constructor(
    public filePath: string,
    public expectedHash: string,
    public currentHash: string,
    public currentContent: string
  ) {
    super(
      `OCC Conflict: File '${filePath}' was modified by another thread. ` +
      `Expected base hash '${expectedHash.slice(0, 8)}', but found '${currentHash.slice(0, 8)}'. ` +
      `Re-read the latest line numbers before applying patch.`
    );
    this.name = "OccConflictError";
  }
}

// Compute SHA-256 hex string from text buffer
export async function computeSha256(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}
```

#### Inside `SpaceDO` Class Methods:

```typescript
export class SpaceDO extends DurableObject {
  /**
   * Performs an atomic Compare-And-Swap (CAS) write to the SQLite virtual filesystem.
   * Fails closed if the base hash has drifted.
   */
  async updateWorkspaceFileOcc(params: OccWriteParams): Promise<OccWriteResult> {
    const { projectId, path, newContent, expectedBaseHash, updatedBy } = params;
    const newHash = await computeSha256(newContent);
    const sizeBytes = new TextEncoder().encode(newContent).length;
    const nowIso = new Date().toISOString();

    return this.ctx.storage.transactionSync(() => {
      // 1. Check if the file exists
      const existing = this.ctx.storage.sql.exec<{ path: string; content: string; hash: string }>(
        "SELECT path, content, hash FROM workspace_files WHERE project_id = ? AND path = ?",
        projectId,
        path
      ).toArray()[0];

      // 2. If creating a brand new file
      if (!existing) {
        if (expectedBaseHash && expectedBaseHash !== "NEW_FILE" && expectedBaseHash !== "") {
          throw new OccConflictError(path, expectedBaseHash, "NOT_FOUND", "");
        }

        this.ctx.storage.sql.exec(
          `INSERT INTO workspace_files (project_id, path, content, hash, size_bytes, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          projectId, path, newContent, newHash, sizeBytes, nowIso, updatedBy
        );

        return { ok: true, newHash, sizeBytes, updatedAt: nowIso };
      }

      // 3. File exists: Verify expected base hash matches existing hash
      if (existing.hash !== expectedBaseHash) {
        throw new OccConflictError(path, expectedBaseHash, existing.hash, existing.content);
      }

      // 4. Atomic CAS Update
      const result = this.ctx.storage.sql.exec(
        `UPDATE workspace_files 
         SET content = ?, hash = ?, size_bytes = ?, updated_at = ?, updated_by = ?
         WHERE project_id = ? AND path = ? AND hash = ?`,
        newContent, newHash, sizeBytes, nowIso, updatedBy, projectId, path, expectedBaseHash
      );

      if (result.rowsWritten === 0) {
        throw new OccConflictError(path, expectedBaseHash, existing.hash, existing.content);
      }

      return { ok: true, newHash, sizeBytes, updatedAt: nowIso };
    });
  }
}
```

---

### B. `workers/agents/src/do/ConcurrencyDO.ts` (Distributed Mutex Engine)

Implement the ephemeral lock manager with atomic lease checks and dead-man switch timeouts:

```typescript
import { DurableObject } from "cloudflare:workers";

export interface LockAcquireRequest {
  key: string;              // e.g. "file:space_102:proj_dev:src/Header.astro"
  holderId: string;         // e.g. "thread_102_agent_dev"
  ttlMs?: number;           // Defaults to 30,000ms (30 seconds)
}

export interface LockAcquireResult {
  granted: boolean;
  key: string;
  holderId: string;
  expiresAtMs: number;
  remainingTtlMs?: number;
}

export class ConcurrencyDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    this.ensureInit();
  }

  private ensureInit() {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS distributed_locks (
          lock_key TEXT PRIMARY KEY,
          holder_id TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          created_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_locks_expiry ON distributed_locks(expires_at_ms);
      `);
    });
  }

  async acquireLock(req: LockAcquireRequest): Promise<LockAcquireResult> {
    const { key, holderId, ttlMs = 30000 } = req;
    const now = Date.now();
    const expiresAt = now + ttlMs;

    return this.ctx.storage.transactionSync(() => {
      // 1. Fetch current lock status
      const existing = this.ctx.storage.sql.exec<{ lock_key: string; holder_id: string; expires_at_ms: number }>(
        "SELECT lock_key, holder_id, expires_at_ms FROM distributed_locks WHERE lock_key = ?",
        key
      ).toArray()[0];

      // 2. If locked and not expired by a DIFFERENT holder -> DENIED
      if (existing && existing.expires_at_ms > now && existing.holder_id !== holderId) {
        return {
          granted: false,
          key,
          holderId: existing.holder_id,
          expiresAtMs: existing.expires_at_ms,
          remainingTtlMs: existing.expires_at_ms - now
        };
      }

      // 3. Grant lock (Insert or renew)
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO distributed_locks (lock_key, holder_id, expires_at_ms, created_at_ms)
         VALUES (?, ?, ?, ?)`,
        key, holderId, expiresAt, now
      );

      // Schedule automated alarm to clean expired locks
      this.ctx.storage.setAlarm(now + ttlMs + 1000);

      return {
        granted: true,
        key,
        holderId,
        expiresAtMs: expiresAt
      };
    });
  }

  async releaseLock(key: string, holderId: string): Promise<{ released: boolean }> {
    return this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql.exec<{ holder_id: string }>(
        "SELECT holder_id FROM distributed_locks WHERE lock_key = ?",
        key
      ).toArray()[0];

      if (!existing || existing.holder_id !== holderId) {
        return { released: false };
      }

      this.ctx.storage.sql.exec("DELETE FROM distributed_locks WHERE lock_key = ?", key);
      return { released: true };
    });
  }

  async getLockStatus(key: string): Promise<{ isLocked: boolean; holderId?: string; remainingTtlMs?: number }> {
    const now = Date.now();
    const existing = this.ctx.storage.sql.exec<{ holder_id: string; expires_at_ms: number }>(
      "SELECT holder_id, expires_at_ms FROM distributed_locks WHERE lock_key = ?",
      key
    ).toArray()[0];

    if (!existing || existing.expires_at_ms <= now) {
      return { isLocked: false };
    }

    return {
      isLocked: true,
      holderId: existing.holder_id,
      remainingTtlMs: existing.expires_at_ms - now
    };
  }

  // Periodic dead-man cleanup alarm
  async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM distributed_locks WHERE expires_at_ms <= ?", now);
    });
  }
}
```

---

## 4. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. **Update `workers/spaces/src/do/SpaceDO.ts`:**
   - Ensure the `workspace_files` table includes `hash TEXT NOT NULL` and `size_bytes INTEGER NOT NULL`.
   - Implement `computeSha256`, `OccConflictError`, and `updateWorkspaceFileOcc`.
   - Wrap the mutation in `this.ctx.storage.transactionSync(...)` conforming strictly to Cloudflare Durable Object SQLite guidelines.
2. **Update `workers/agents/src/do/ConcurrencyDO.ts`:**
   - Implement the `distributed_locks` table schema in `ensureInit()`.
   - Implement `acquireLock`, `releaseLock`, `getLockStatus`, and the `alarm()` cleanup method.
3. **Execute Local VM Syntax Pre-Check:**
   - Run `node --check` to ensure there are no missing exports, syntax errors, or improper async/sync transaction wrappers.
```
