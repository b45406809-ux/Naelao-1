/**
 * Axis 6: Multi-Agent Concurrency & Conflict-Free Code Editing
 *
 * Implements:
 * 1. 4-Tier Collaboration Model with Slack-style @mention dispatch
 * 2. Optimistic Concurrency Control (OCC) Storage Layer with SHA-256 CAS AST Patching
 * 3. Hierarchical Distributed File Mutex Engine with Deadlock Prevention (Lexicographical ordering & TTL)
 */

import type {
  CollaborationLaneConfig,
  CollaborationTierLevel,
  AstPatchOperation,
  OccCommitResult,
  OccConflictDetails,
} from "@naelao/types";

// ── 1. The 4-Tier Collaboration Model ──────────────────────────────────────────

export const COLLABORATION_TIERS: Record<CollaborationTierLevel, CollaborationLaneConfig> = {
  1: {
    tier: 1,
    name: "Tier 1: Team Room",
    displayLabel: "Project Chat",
    description: "The main team conversation and shared project space",
    visibility: "public_to_project",
    interactionModel: "humans_and_at_mentions",
    workspaceWritePermission: "branch_pr_only",
    requiresAtMentionForAgents: false, // Smart auto-routing handles un-mentioned messages gracefully
    canMutateFilesystem: false,
  },
  2: {
    tier: 2,
    name: "Tier 2: Task Workstations",
    displayLabel: "Active Tasks",
    description: "Task checklist with focused execution and comments",
    visibility: "public_to_project",
    interactionModel: "feature_dag_and_at_mentions",
    workspaceWritePermission: "occ_branch_patch",
    requiresAtMentionForAgents: true,
    canMutateFilesystem: true,
  },
  3: {
    tier: 3,
    name: "Tier 3: System Consult Lanes",
    displayLabel: "System Consult (Internal)",
    description: "Silent internal bot-to-bot coordination lane",
    visibility: "internal_system",
    interactionModel: "internal_specialist_consult",
    workspaceWritePermission: "coordination_only",
    requiresAtMentionForAgents: false,
    canMutateFilesystem: false,
  },
  4: {
    tier: 4,
    name: "Tier 4: Private Scratchpad",
    displayLabel: "My Private Drafts",
    description: "Personal 1-on-1 space for draft notes and ideas",
    visibility: "strictly_private",
    interactionModel: "private_direct_unmentioned",
    workspaceWritePermission: "read_only_simulation",
    requiresAtMentionForAgents: false,
    canMutateFilesystem: false,
  },
};

/**
 * Checks whether an active collaboration tier may apply a direct file mutation.
 *
 * Team-room work must be materialized as a branch/PR review card, not written
 * to a shared workspace. Task workstations are intentionally the sole mutable
 * lane; their writes still need OCC and a task branch at the storage boundary.
 */
export function canWriteToWorkspace(tier: CollaborationTierLevel): boolean {
  const cfg = COLLABORATION_TIERS[tier];
  return cfg ? cfg.canMutateFilesystem : false;
}

/**
 * Parses Slack-style @mentions from a chat stream (e.g., "@DevAgent please update Header.astro").
 */
export function parseMentionDispatch(message: string): {
  mentions: string[];
  isMentioned: (handle: string) => boolean;
  cleanedText: string;
} {
  if (!message) return { mentions: [], isMentioned: () => false, cleanedText: "" };

  const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
  const mentions: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(message)) !== null) {
    const handle = match[1];
    if (handle) {
      mentions.push(handle.toLowerCase());
    }
  }

  const cleanedText = message.replace(mentionRegex, "").trim();

  return {
    mentions,
    isMentioned: (handle: string) => {
      const normalized = handle.replace(/^@/, "").toLowerCase();
      return mentions.includes(normalized) || mentions.includes("all") || mentions.includes("agent");
    },
    cleanedText,
  };
}

/**
 * Determines if an agent should activate and respond based on the lane tier, @mention presence, or smart auto-routing.
 */
export function shouldAgentRespondInTier(
  tier: CollaborationTierLevel,
  agentHandle: string,
  message: string,
  isLeadAgent: boolean = false
): boolean {
  const lane = COLLABORATION_TIERS[tier];
  if (!lane) return false;

  const { mentions, isMentioned } = parseMentionDispatch(message);

  // If specific mentions exist, honor explicit @mention routing
  if (mentions.length > 0) {
    return isMentioned(agentHandle);
  }

  // Non-technical "Apple Simplicity" Smart Auto-Routing:
  // In Tier 1 (Project Chat) or Tier 4 (My Private Drafts), the Lead / Space Assistant automatically responds
  // and delegates behind the scenes without forcing the user to type @mentions.
  if (isLeadAgent || !lane.requiresAtMentionForAgents) {
    return true;
  }

  return false;
}

// ── 2. OCC Storage Layer & AST Patching Engine ────────────────────────────────

export class ConcurrencyConflictError extends Error {
  public readonly conflictDetails: OccConflictDetails;

  constructor(message: string, conflictDetails: OccConflictDetails) {
    super(message);
    this.name = "ConcurrencyConflictError";
    this.conflictDetails = conflictDetails;
  }
}

/**
 * Computes a deterministic SHA-256 representation of UTF-8 file content.
 *
 * This is deliberately synchronous and dependency-free so the same checkpoint
 * format works in Workers, Durable Objects, browser previews, and test
 * runtimes. The previous FNV-style checksum was fast but did not provide the
 * SHA-256 CAS checkpoint promised by the workspace protocol.
 */
export function computeContentHash(content: string): string {
  const bytes = new TextEncoder().encode(content);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6);
  const message = new Uint8Array(paddedLength);
  message.set(bytes);
  message[bytes.length] = 0x80;

  // JS numbers exactly represent this length for every feasible Worker file.
  const lengthView = new DataView(message.buffer);
  lengthView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  lengthView.setUint32(paddedLength - 4, bitLength >>> 0);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const roundConstants = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const rotateRight = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));
  const words = new Uint32Array(64);

  for (let offset = 0; offset < message.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = lengthView.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const x = words[index - 15]!;
      const y = words[index - 2]!;
      const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index++) {
      const sigma1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choose = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + sigma1 + choose + roundConstants[index]! + words[index]!) >>> 0;
      const sigma0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (sigma0 + majority) >>> 0;
      [h, g, f, e, d, c, b, a] = [g!, f!, e!, (d! + temp1) >>> 0, c!, b!, a!, (temp1 + temp2) >>> 0];
    }
    hash[0] = (hash[0]! + a!) >>> 0; hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0; hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0; hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0; hash[7] = (hash[7]! + h!) >>> 0;
  }

  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
}

/**
 * Fuzzy locates lines around a missing search block to aid self-healing rollback handlers.
 */
export function fuzzyLocateLines(content: string, searchBlock: string): { found: boolean; nearbyLines: string[] } {
  const lines = content.split("\n");
  const searchLines = searchBlock.trim().split("\n");
  const firstSearchLine = searchLines[0]?.trim() ?? "";

  const matchingLineIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && firstSearchLine.length > 0 && line.includes(firstSearchLine)) {
      matchingLineIndices.push(i);
    }
  }

  if (matchingLineIndices.length === 0) {
    return {
      found: false,
      nearbyLines: lines.slice(0, Math.min(10, lines.length)),
    };
  }

  const center = matchingLineIndices[0] ?? 0;
  const start = Math.max(0, center - 3);
  const end = Math.min(lines.length, center + 5);

  return {
    found: true,
    nearbyLines: lines.slice(start, end),
  };
}

/**
 * Atomic AST Patch Operation with Optimistic Concurrency Control:
 * T(F, E) = ApplyASTPatch(F_t, sigma_find, sigma_replace) if H(F_t) == H_base && !IsLocked(F)
 * else Abort & Raise Conflict Exception
 */
export function applyAstPatchAtomic(
  currentContent: string,
  patch: AstPatchOperation,
  isLocked = false,
  lockedBy?: string
): { success: boolean; newContent: string; newHash: string } {
  const currentHash = computeContentHash(currentContent);

  // 1. Check Distributed Lock Status
  if (isLocked) {
    const conflict: OccConflictDetails = {
      file: patch.file,
      expectedHash: patch.expectedBaseHash,
      currentHash,
      isLocked: true,
      lockedBy,
      nearbyLines: currentContent.split("\n").slice(0, 5),
      conflictDiff: `File is locked by mutex held by ${lockedBy ?? "another thread"}`,
    };
    throw new ConcurrencyConflictError(`OCC Abort: File '${patch.file}' is currently locked.`, conflict);
  }

  // 2. Verify CAS Hash Checkpoint: H(F_t) === H_base
  if (patch.expectedBaseHash && patch.expectedBaseHash !== currentHash) {
    const { nearbyLines } = fuzzyLocateLines(currentContent, patch.findBlock);
    const conflict: OccConflictDetails = {
      file: patch.file,
      expectedHash: patch.expectedBaseHash,
      currentHash,
      isLocked: false,
      nearbyLines,
      conflictDiff: `Hash mismatch: expected ${patch.expectedBaseHash} but found current state ${currentHash}`,
    };
    throw new ConcurrencyConflictError(
      `OCC Abort: Conflict detected on '${patch.file}'. Base hash changed from ${patch.expectedBaseHash} to ${currentHash}.`,
      conflict
    );
  }

  // 3. Search and Replace Block
  if (!currentContent.includes(patch.findBlock)) {
    const { nearbyLines } = fuzzyLocateLines(currentContent, patch.findBlock);
    const conflict: OccConflictDetails = {
      file: patch.file,
      expectedHash: patch.expectedBaseHash,
      currentHash,
      isLocked: false,
      nearbyLines,
      conflictDiff: `Target findBlock not found in current content`,
    };
    throw new ConcurrencyConflictError(
      `OCC Abort: Search block for '${patch.file}' could not be located in current file state.`,
      conflict
    );
  }

  const newContent = currentContent.replace(patch.findBlock, patch.replaceBlock);
  const newHash = computeContentHash(newContent);

  return {
    success: true,
    newContent,
    newHash,
  };
}

// ── 3. Hierarchical Distributed File Mutex Engine ─────────────────────────────

export interface FileLockRecord {
  filePath: string;
  holderId: string;
  acquiredAt: number;
  expiresAt: number;
}

export class HierarchicalFileMutex {
  private locks = new Map<string, FileLockRecord>();
  private defaultTtlMs = 30_000; // 30 seconds default TTL

  constructor(defaultTtlMs = 30_000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  /**
   * Sorts lock keys in strict lexicographical order to prevent distributed circular wait deadlocks.
   */
  public sortLockKeys(filePaths: string[]): string[] {
    return [...new Set(filePaths)].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Cleans up expired locks.
   */
  private sweepExpiredLocks(): void {
    const now = Date.now();
    for (const [key, lock] of this.locks.entries()) {
      if (lock.expiresAt <= now) {
        this.locks.delete(key);
      }
    }
  }

  /**
   * Attempts to acquire distributed mutexes on one or multiple files in atomic lexicographical sequence.
   */
  public acquireLocks(
    filePaths: string[],
    holderId: string,
    ttlMs: number = this.defaultTtlMs
  ): { granted: boolean; lockedFiles: string[]; deniedFile?: string; heldBy?: string } {
    this.sweepExpiredLocks();
    const sortedKeys = this.sortLockKeys(filePaths);
    const now = Date.now();

    // Check if any file in the ordered list is already held by someone else
    for (const file of sortedKeys) {
      const existing = this.locks.get(file);
      if (existing && existing.holderId !== holderId && existing.expiresAt > now) {
        return {
          granted: false,
          lockedFiles: [],
          deniedFile: file,
          heldBy: existing.holderId,
        };
      }
    }

    // Grant all sorted locks atomically
    const lockedFiles: string[] = [];
    for (const file of sortedKeys) {
      this.locks.set(file, {
        filePath: file,
        holderId,
        acquiredAt: now,
        expiresAt: now + ttlMs,
      });
      lockedFiles.push(file);
    }

    return {
      granted: true,
      lockedFiles,
    };
  }

  /**
   * Releases locks held by a given holder.
   */
  public releaseLocks(filePaths: string[], holderId: string): void {
    for (const file of filePaths) {
      const existing = this.locks.get(file);
      if (existing && existing.holderId === holderId) {
        this.locks.delete(file);
      }
    }
  }

  /**
   * Checks if a specific file is currently locked.
   */
  public isFileLocked(filePath: string): { locked: boolean; heldBy?: string; expiresAt?: number } {
    this.sweepExpiredLocks();
    const existing = this.locks.get(filePath);
    if (existing && existing.expiresAt > Date.now()) {
      return {
        locked: true,
        heldBy: existing.holderId,
        expiresAt: existing.expiresAt,
      };
    }
    return { locked: false };
  }
}
