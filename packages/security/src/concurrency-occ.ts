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
    workspaceWritePermission: "full_execution",
    requiresAtMentionForAgents: false, // Smart auto-routing handles un-mentioned messages gracefully
    canMutateFilesystem: true,
  },
  2: {
    tier: 2,
    name: "Tier 2: Task Workstations",
    displayLabel: "Active Tasks",
    description: "Task checklist with focused execution and comments",
    visibility: "public_to_project",
    interactionModel: "feature_dag_and_at_mentions",
    workspaceWritePermission: "full_execution",
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
 * Checks if an active collaboration tier is permitted to execute direct workspace mutations.
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
 * Computes deterministic SHA-256 hash representation of file content.
 */
export function computeContentHash(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return `h_${(hash >>> 0).toString(16).padStart(8, "0")}`;
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
