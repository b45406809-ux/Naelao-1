import {
  validateWorkspaceBranch,
  validateWorkspacePath,
  validateWorkspaceScope,
  sha256Hex,
  type WorkspacePublicationReceipt,
  type WorkspaceScope,
} from "./workspace-contract.js";

export type WorkspaceManualResolutionInput = {
  scope: WorkspaceScope;
  actorId: string;
  workerId: string;
  attempt: number;
  targetBranch: string;
  sourceBranch: string;
  path: string;
  expectedTargetHash: string | null;
  expectedSourceHash: string | null;
  content: string | null;
  copyFrom?: "target" | "worker";
  idempotencyKey: string;
  changes?: WorkspaceManualResolutionChange[];
  copyBucket?: WorkspaceConflictBucket;
  validationCommand?: string;
  validate?: (request: WorkspaceManualValidationRequest) => Promise<WorkspaceManualValidationReceipt>;
};

export type WorkspaceManualResolutionChange = {
  path: string;
  expectedTargetHash: string | null;
  expectedSourceHash: string | null;
  content: string | null;
  copyFrom?: "target" | "worker";
};

export type WorkspaceConflictBucket = {
  get(key: string): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
};

export function isWorkspaceManualResolutionChange(value: unknown): value is WorkspaceManualResolutionChange {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const change = value as Record<string, unknown>;
  if (!validateWorkspacePath(change.path) ||
      !(change.expectedTargetHash === null || typeof change.expectedTargetHash === "string" && HASH.test(change.expectedTargetHash)) ||
      !(change.expectedSourceHash === null || typeof change.expectedSourceHash === "string" && HASH.test(change.expectedSourceHash)) ||
      !(change.content === null || typeof change.content === "string") ||
      !(change.copyFrom === undefined || change.copyFrom === "target" || change.copyFrom === "worker")) return false;
  if (change.copyFrom !== undefined) {
    return change.content === null && (change.copyFrom === "target" ? change.expectedTargetHash : change.expectedSourceHash) !== null;
  }
  if (change.content === null) return true;
  const bytes = new TextEncoder().encode(change.content);
  return bytes.byteLength <= MAX_RESOLUTION_BYTES && !bytes.includes(0);
}

export function isWorkspaceManualConflictChangeSet(
  path: string,
  otherPath: string | undefined,
  changes: WorkspaceManualResolutionChange[],
): boolean {
  if (!validateWorkspacePath(path) || changes.length < 1 || changes.length > 2 ||
      changes.some(change => !isWorkspaceManualResolutionChange(change)) ||
      new Set(changes.map(change => change.path)).size !== changes.length || !changes.some(change => change.path === path)) return false;
  if (otherPath === undefined) return changes.length === 1;
  return validateWorkspacePath(otherPath) && otherPath !== path && changes.length === 2 &&
    changes.some(change => change.path === otherPath) &&
    changes.filter(change => change.content === null && change.copyFrom === undefined).length === 1;
}

export type WorkspaceCoordinatorCall = (
  path: string,
  body?: Record<string, unknown>
) => Promise<Response>;

export type WorkspaceConflictPreviewVersion = {
  hash: string | null;
  content: string | null;
  /** Exact bytes are verified and within the manual-resolution bound, but are not rendered as text. */
  copyAllowed?: boolean;
  unavailableReason?:
    | "missing"
    | "size_limit"
    | "unsupported_type"
    | "invalid_text";
};

export type WorkspaceConflictPreview = {
  path: string;
  target: WorkspaceConflictPreviewVersion;
  worker: WorkspaceConflictPreviewVersion;
  stale: boolean;
  paired?: { path: string; target: WorkspaceConflictPreviewVersion; worker: WorkspaceConflictPreviewVersion };
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_RESOLUTION_BYTES = 256 * 1024;
const MAX_VALIDATION_COMMAND_BYTES = 256;
const VALIDATION_COMMAND = /^(?:npm|pnpm|yarn|bun) (?:run )?test(?::[A-Za-z0-9][A-Za-z0-9:._-]{0,63})?(?: -- [A-Za-z0-9@/_.:= -]{1,160})?$/;

export type WorkspaceManualValidationReceipt = {
  path: string;
  paths: string[];
  status: "passed" | "failed" | "uncertain" | "blocked";
  branch: string;
  revision: number;
  manifestHash: string;
  targetRevision: number;
  targetManifestHash: string;
  commandHash: string;
  executionId: string;
  runId: string;
  durationMs: number;
  completedAt: string;
  exitCode?: number;
  reason?: string;
};

export type WorkspaceManualValidationRequest = {
  path: string;
  paths: string[];
  reviewBranch: string;
  validationBranch: string;
  targetBranch: string;
  revision: number;
  manifestHash: string;
  targetRevision: number;
  targetManifestHash: string;
  command: string;
  commandHash: string;
  executionId: string;
  runId: string;
};

export function isWorkspaceManualValidationCommand(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= MAX_VALIDATION_COMMAND_BYTES &&
    value === value.trim() && VALIDATION_COMMAND.test(value);
}

function normalizeResolutionChanges(input: WorkspaceManualResolutionInput): WorkspaceManualResolutionChange[] | null {
  const changes = input.changes ?? [{ path: input.path, expectedTargetHash: input.expectedTargetHash,
    expectedSourceHash: input.expectedSourceHash, content: input.content, ...(input.copyFrom ? { copyFrom: input.copyFrom } : {}) }];
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 2 ||
      changes.some(change => !isWorkspaceManualResolutionChange(change)) ||
      new Set(changes.map(change => change.path)).size !== changes.length) return null;
  const primary = changes.find(change => change.path === input.path);
  if (!primary || primary.expectedTargetHash !== input.expectedTargetHash || primary.expectedSourceHash !== input.expectedSourceHash ||
      primary.content !== input.content || primary.copyFrom !== input.copyFrom) return null;
  const normalized = [...changes].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  let totalBytes = 0;
  for (const change of normalized) {
    if (change.content === null) continue;
    const bytes = new TextEncoder().encode(change.content);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_RESOLUTION_BYTES * 2) return null;
  }
  return normalized;
}

async function readBranchText(
  scope: WorkspaceScope,
  branch: string,
  path: string,
  coordinator: WorkspaceCoordinatorCall,
  bucket: {
    get(
      key: string
    ): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  }
): Promise<WorkspaceConflictPreviewVersion> {
  const response = await coordinator(
    `/v1/read?branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}`
  );
  if (!response.ok)
    throw new Error(`workspace_manual_preview_read_failed:${response.status}`);
  const payload = (await response.json()) as {
    entries?: Array<{
      path?: unknown;
      sha256?: unknown;
      size?: unknown;
      objectKey?: unknown;
      contentType?: unknown;
    }>;
  };
  const entry = payload.entries?.find((candidate) => candidate.path === path);
  if (!entry)
    return { hash: null, content: null, unavailableReason: "missing" };
  if (
    typeof entry.sha256 !== "string" ||
    !HASH.test(entry.sha256) ||
    typeof entry.size !== "number" ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    entry.objectKey !==
      `workspace-v1/${scope.tenantId}/${scope.spaceId}/${scope.projectId}/${scope.jurisdiction}/content/${entry.sha256}`
  ) {
    throw new Error("workspace_manual_preview_entry_invalid");
  }
  if (entry.size > MAX_RESOLUTION_BYTES)
    return {
      hash: entry.sha256,
      content: null,
      unavailableReason: "size_limit",
    };
  const contentType =
    typeof entry.contentType === "string"
      ? entry.contentType.toLowerCase()
      : "";
  const textPath =
    /\.(?:txt|md|mdx|json|jsonc|ya?ml|toml|xml|html|css|scss|js|jsx|mjs|cjs|ts|tsx|mts|cts|sql|sh|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|vue|svelte|graphql|gql|proto)$/i.test(
      path
    );
  const object = await bucket.get(entry.objectKey);
  if (!object || object.size !== entry.size)
    throw new Error("workspace_manual_preview_content_unavailable");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== entry.size)
    return { hash: entry.sha256, content: null, unavailableReason: "invalid_text" };
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== entry.sha256)
    return {
      hash: entry.sha256,
      content: null,
      unavailableReason: "invalid_text",
    };
  if (!(contentType.startsWith("text/") ||
      /^application\/(json|javascript|typescript|xml|yaml|toml|sql)(?:;|$)/.test(contentType) || textPath)) {
    return { hash: entry.sha256, content: null, unavailableReason: "unsupported_type", copyAllowed: true };
  }
  if (bytes.includes(0))
    return { hash: entry.sha256, content: null, unavailableReason: "invalid_text", copyAllowed: true };
  try {
    return {
      hash,
      content: new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes),
    };
  } catch {
    return { hash, content: null, unavailableReason: "invalid_text", copyAllowed: true };
  }
}

async function readBoundedBranchBytes(
  scope: WorkspaceScope,
  branch: string,
  path: string,
  expectedHash: string,
  coordinator: WorkspaceCoordinatorCall,
  bucket: WorkspaceConflictBucket,
): Promise<{ bytes: Uint8Array; hash: string; contentType?: string; executable?: boolean }> {
  const response = await coordinator(`/v1/read?branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}`);
  if (!response.ok) throw new Error(`workspace_manual_resolution_copy_read_failed:${response.status}`);
  const payload = await response.json() as { entries?: Array<{ path?: unknown; sha256?: unknown; size?: unknown;
    objectKey?: unknown; contentType?: unknown; executable?: unknown }> };
  const entry = payload.entries?.find(candidate => candidate.path === path);
  if (!entry || entry.sha256 !== expectedHash || typeof entry.sha256 !== "string" || !HASH.test(entry.sha256) ||
      typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_RESOLUTION_BYTES ||
      entry.objectKey !== `workspace-v1/${scope.tenantId}/${scope.spaceId}/${scope.projectId}/${scope.jurisdiction}/content/${entry.sha256}`) {
    throw new Error("workspace_manual_resolution_copy_stale_or_invalid");
  }
  const object = await bucket.get(entry.objectKey);
  if (!object || object.size !== entry.size) throw new Error("workspace_manual_resolution_copy_unavailable");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== entry.size || await sha256Hex(bytes) !== expectedHash)
    throw new Error("workspace_manual_resolution_copy_integrity_failed");
  return { bytes, hash: expectedHash,
    ...(typeof entry.contentType === "string" ? { contentType: entry.contentType } : {}),
    ...(typeof entry.executable === "boolean" ? { executable: entry.executable } : {}) };
}

async function branchHasResolution(
  branch: string,
  path: string,
  expectedHash: string | null,
  coordinator: WorkspaceCoordinatorCall
): Promise<boolean> {
  const response = await coordinator(
    `/v1/read?branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}`
  );
  if (!response.ok)
    throw new Error(
      `workspace_manual_resolution_replay_read_failed:${response.status}`
    );
  const payload = (await response.json()) as {
    entries?: Array<{ path?: unknown; sha256?: unknown }>;
  };
  if (!Array.isArray(payload.entries))
    throw new Error("workspace_manual_resolution_replay_manifest_invalid");
  const entry = payload.entries.find((candidate) => candidate.path === path);
  if (!entry) return expectedHash === null;
  if (typeof entry.sha256 !== "string" || !HASH.test(entry.sha256)) {
    throw new Error("workspace_manual_resolution_replay_entry_invalid");
  }
  return entry.sha256 === expectedHash;
}

/** Read the current checked target and retained worker versions for an authorized reviewer. */
export async function readWorkspaceConflictPreview(
  input: {
    scope: WorkspaceScope;
    targetBranch: string;
    workerBranch: string;
    path: string;
    pairedPath?: string;
    expectedTargetHash?: string | null;
    expectedSourceHash?: string | null;
  },
  coordinator: WorkspaceCoordinatorCall,
  bucket: {
    get(
      key: string
    ): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  }
): Promise<WorkspaceConflictPreview> {
  if (
    !validateWorkspaceScope(input.scope) ||
    !validateWorkspaceBranch(input.targetBranch) ||
    !validateWorkspaceBranch(input.workerBranch) ||
    !validateWorkspacePath(input.path) ||
    input.pairedPath !== undefined && (!validateWorkspacePath(input.pairedPath) || input.pairedPath === input.path) ||
    input.expectedTargetHash !== undefined && !(
      input.expectedTargetHash === null ||
      (typeof input.expectedTargetHash === "string" &&
        HASH.test(input.expectedTargetHash))
    ) ||
    input.expectedSourceHash !== undefined && !(
      input.expectedSourceHash === null ||
      (typeof input.expectedSourceHash === "string" &&
        HASH.test(input.expectedSourceHash))
    )
  ) {
    throw new Error("invalid_workspace_manual_preview");
  }
  const [target, worker, pairedTarget, pairedWorker] = await Promise.all([
    readBranchText(
      input.scope,
      input.targetBranch,
      input.path,
      coordinator,
      bucket
    ),
    readBranchText(
      input.scope,
      input.workerBranch,
      input.path,
      coordinator,
      bucket
    ),
    input.pairedPath ? readBranchText(input.scope, input.targetBranch, input.pairedPath, coordinator, bucket) : Promise.resolve(undefined),
    input.pairedPath ? readBranchText(input.scope, input.workerBranch, input.pairedPath, coordinator, bucket) : Promise.resolve(undefined),
  ]);
  return {
    path: input.path,
    target,
    worker,
    stale: input.expectedTargetHash !== undefined && target.hash !== input.expectedTargetHash ||
      input.expectedSourceHash !== undefined && worker.hash !== input.expectedSourceHash,
    ...(input.pairedPath && pairedTarget && pairedWorker ? { paired: { path: input.pairedPath, target: pairedTarget, worker: pairedWorker } } : {}),
  };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length))
    );
  }
  return btoa(binary);
}

async function branchFor(
  input: WorkspaceManualResolutionInput,
  paths: string[],
): Promise<string> {
  // Keep the existing single-path branch identity stable for interrupted-request recovery.
  const pathIdentity: string | string[] = paths.length === 1 ? paths[0]! : paths;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([
        input.scope,
        input.workerId,
        input.attempt,
        input.targetBranch,
        pathIdentity,
        input.idempotencyKey,
      ])
    )
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `manual/${hex.slice(0, 48)}`;
}

async function coordinatorFailure(
  operation: string,
  response: Response
): Promise<never> {
  const detail = (await response.text().catch(() => "")).slice(0, 240);
  throw new Error(`${operation}:${response.status}:${detail}`);
}

async function readBranchHead(
  branch: string,
  coordinator: WorkspaceCoordinatorCall,
  operation: string,
): Promise<{ revision: number; manifestHash: string; branchBase?: { parentBranch: string; revision: number; manifestHash: string } }> {
  const response = await coordinator(`/v1/head?branch=${encodeURIComponent(branch)}`);
  if (!response.ok) throw new Error(`${operation}:${response.status}`);
  const payload = await response.json() as { head?: { branch?: unknown; revision?: unknown; manifestHash?: unknown };
    branchBase?: { parentBranch?: unknown; revision?: unknown; manifestHash?: unknown } };
  if (payload.head?.branch !== branch || !Number.isSafeInteger(payload.head.revision) ||
      typeof payload.head.manifestHash !== "string" || !HASH.test(payload.head.manifestHash)) {
    throw new Error(`${operation}_invalid`);
  }
  let branchBase: { parentBranch: string; revision: number; manifestHash: string } | undefined;
  if (payload.branchBase !== undefined) {
    if (typeof payload.branchBase.parentBranch !== "string" || !Number.isSafeInteger(payload.branchBase.revision) ||
        typeof payload.branchBase.manifestHash !== "string" || !HASH.test(payload.branchBase.manifestHash)) {
      throw new Error(`${operation}_base_invalid`);
    }
    branchBase = { parentBranch: payload.branchBase.parentBranch, revision: payload.branchBase.revision as number,
      manifestHash: payload.branchBase.manifestHash };
  }
  return { revision: payload.head.revision as number, manifestHash: payload.head.manifestHash, ...(branchBase ? { branchBase } : {}) };
}

/** Publish reviewer-authored content on a retained branch, then merge only through the Coordinator. */
export async function publishWorkspaceManualResolution(
  input: WorkspaceManualResolutionInput,
  coordinator: WorkspaceCoordinatorCall
): Promise<{
  reviewBranch: string;
  paths: string[];
  checkpoint: WorkspacePublicationReceipt;
  merge: WorkspacePublicationReceipt;
  validation?: WorkspaceManualValidationReceipt;
}> {
  const changes = normalizeResolutionChanges(input);
  if (
    !validateWorkspaceScope(input.scope) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.actorId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.workerId) ||
    !Number.isSafeInteger(input.attempt) ||
    input.attempt < 1 ||
    !validateWorkspaceBranch(input.targetBranch) ||
    !validateWorkspaceBranch(input.sourceBranch) ||
    !validateWorkspacePath(input.path) ||
    !(
      input.expectedTargetHash === null ||
      (typeof input.expectedTargetHash === "string" &&
        HASH.test(input.expectedTargetHash))
    ) ||
    !(
      input.expectedSourceHash === null ||
      (typeof input.expectedSourceHash === "string" &&
        HASH.test(input.expectedSourceHash))
    ) ||
    !ID.test(input.idempotencyKey) ||
    !(input.content === null || typeof input.content === "string") ||
    !changes ||
    changes.some(change => change.copyFrom !== undefined) && !input.copyBucket ||
    input.validate !== undefined && (!isWorkspaceManualValidationCommand(input.validationCommand) || typeof input.validate !== "function")
  ) {
    throw new Error("invalid_workspace_manual_resolution");
  }
  const paths = changes.map(change => change.path);
  const reviewBranch = await branchFor(input, paths);
  const operationId = reviewBranch.slice("manual/".length);
  const sourceMatches = await Promise.all(changes.map(change => branchHasResolution(input.sourceBranch, change.path, change.expectedSourceHash, coordinator)));
  if (sourceMatches.some(matches => !matches)) {
    throw new Error("workspace_manual_resolution_stale_source");
  }
  const resolvedHashes = await Promise.all(changes.map(async change => ({ path: change.path,
    hash: change.copyFrom === "target" ? change.expectedTargetHash : change.copyFrom === "worker" ? change.expectedSourceHash :
      change.content === null ? null : await sha256Hex(new TextEncoder().encode(change.content)) })));
  const branch = await coordinator("/v1/branch", {
    scope: input.scope,
    sourceBranch: input.targetBranch,
    branch: reviewBranch,
  });
  if (!branch.ok)
    await coordinatorFailure(
      "workspace_manual_resolution_branch_failed",
      branch
    );

  // A previous request can finish both Coordinator publications and lose the Worker result
  // write. The deterministic review branch plus exact resolved bytes let a retry resume from
  // that durable state instead of applying the original expected hash a second time.
  const appliedState = await Promise.all(resolvedHashes.map(change => branchHasResolution(reviewBranch, change.path, change.hash, coordinator)));
  const alreadyApplied = appliedState.every(Boolean);
  const resolvedChanges: Array<{ path: string; contentBase64: string | null; contentType?: string; executable?: boolean }> = alreadyApplied ? [] : await Promise.all(changes.map(async change => {
    if (change.content === null && change.copyFrom === undefined) return { path: change.path, contentBase64: null };
    if (change.copyFrom) {
      const expectedHash = change.copyFrom === "target" ? change.expectedTargetHash : change.expectedSourceHash;
      if (!expectedHash || !input.copyBucket) throw new Error("workspace_manual_resolution_copy_unavailable");
      const copied = await readBoundedBranchBytes(input.scope, change.copyFrom === "target" ? input.targetBranch : input.sourceBranch,
        change.path, expectedHash, coordinator, input.copyBucket);
      return { path: change.path, contentBase64: encodeBase64(copied.bytes),
        ...(copied.contentType ? { contentType: copied.contentType } : {}),
        ...(copied.executable === undefined ? {} : { executable: copied.executable }) };
    }
    const bytes = new TextEncoder().encode(change.content!);
    return { path: change.path, contentBase64: encodeBase64(bytes) };
  }));

  const runtimeId = "workspace-manual-review";
  const opened = await coordinator("/v1/open", {
    scope: input.scope,
    branch: reviewBranch,
    parentBranch: input.targetBranch,
    actorId: input.actorId,
    runtimeId,
    allocationGeneration: 1,
    mode: "checked_handoff",
  });
  if (!opened.ok)
    await coordinatorFailure("workspace_manual_resolution_open_failed", opened);
  const openedBody = (await opened.json()) as {
    session?: { id?: unknown; fence?: unknown };
    head?: { revision?: unknown };
  };
  const sessionId = openedBody.session?.id;
  const fence = openedBody.session?.fence;
  const baseRevision = openedBody.head?.revision;
  if (
    typeof sessionId !== "string" ||
    !/^ws_[0-9a-f-]{36}$/.test(sessionId) ||
    !Number.isSafeInteger(fence) ||
    !Number.isSafeInteger(baseRevision)
  ) {
    if (typeof sessionId === "string")
      await coordinator("/v1/close", { sessionId, runtimeId }).catch(
        () => undefined
      );
    throw new Error("workspace_manual_resolution_session_invalid");
  }

  try {
    const checkpointResponse = alreadyApplied
      ? null
      : await coordinator("/v1/checkpoint", {
          sessionId,
          runtimeId,
          allocationGeneration: 1,
          fence,
          baseRevision,
          idempotencyKey: `manual-${operationId}`,
          changes: changes.map(change => {
            const resolved = resolvedChanges.find(candidate => candidate.path === change.path)!;
            return { path: change.path, expectedHash: change.expectedTargetHash, contentBase64: resolved.contentBase64,
              ...(resolved.contentType ? { contentType: resolved.contentType } : {}),
              ...(resolved.executable === undefined ? {} : { executable: resolved.executable }) };
          }),
        });
    const checkpointBody = checkpointResponse
      ? ((await checkpointResponse.json().catch(() => ({}))) as {
          publication?: WorkspacePublicationReceipt;
        })
      : {};
    const checkpoint = checkpointBody.publication;
    if (checkpointResponse && checkpoint?.status === "conflicted") {
      const actualHash = checkpoint?.conflicts?.find(conflict => changes.some(change => change.path === conflict.path))?.actualHash ?? null;
      throw new Error(
        `workspace_manual_resolution_stale_target:${actualHash ?? "missing"}`
      );
    }
    if (checkpointResponse && !checkpointResponse.ok)
      await coordinatorFailure(
        "workspace_manual_resolution_checkpoint_failed",
        checkpointResponse
      );
    if (
      checkpointResponse &&
      (!checkpoint || !["published", "noop"].includes(checkpoint.status))
    )
      throw new Error("workspace_manual_resolution_checkpoint_invalid");

    let validation: WorkspaceManualValidationReceipt | undefined;
    if (input.validate) {
      const reviewHead = await readBranchHead(reviewBranch, coordinator, "workspace_manual_validation_review_head");
      const targetHead = await readBranchHead(input.targetBranch, coordinator, "workspace_manual_validation_target_head");
      if (!reviewHead.branchBase || reviewHead.branchBase.parentBranch !== input.targetBranch ||
          reviewHead.branchBase.revision !== targetHead.revision || reviewHead.branchBase.manifestHash !== targetHead.manifestHash) {
        throw new Error("workspace_manual_validation_stale_target");
      }
      const commandBytes = new TextEncoder().encode(input.validationCommand!);
      const commandHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", commandBytes))]
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const validationBranch = `race/manual-validation/${operationId.slice(0, 48)}`;
      const commandOperationHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([
        input.scope, input.workerId, input.attempt, input.targetBranch, paths.length === 1 ? paths[0] : paths, input.idempotencyKey, commandHash,
      ]))))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const executionId = `manual-validation-${commandOperationHash.slice(0, 40)}`;
      const runId = `manual-validation-run-${commandOperationHash.slice(0, 32)}`;
      validation = await input.validate({ path: input.path, paths, reviewBranch, validationBranch, targetBranch: input.targetBranch, revision: reviewHead.revision,
        manifestHash: reviewHead.manifestHash, targetRevision: targetHead.revision, targetManifestHash: targetHead.manifestHash,
        command: input.validationCommand!,
        commandHash, executionId, runId });
      if (validation.path !== input.path || JSON.stringify(validation.paths) !== JSON.stringify(paths) || validation.branch !== validationBranch || validation.revision !== reviewHead.revision || validation.manifestHash !== reviewHead.manifestHash ||
          validation.targetRevision !== targetHead.revision || validation.targetManifestHash !== targetHead.manifestHash ||
          validation.commandHash !== commandHash || validation.executionId !== executionId || validation.runId !== runId) {
        throw new Error("workspace_manual_validation_receipt_mismatch");
      }
      if (validation.status !== "passed") throw new Error(`workspace_manual_validation_${validation.status}`);
      const afterValidation = await readBranchHead(reviewBranch, coordinator, "workspace_manual_validation_review_head");
      const targetAfterValidation = await readBranchHead(input.targetBranch, coordinator, "workspace_manual_validation_target_head");
      if (afterValidation.revision !== reviewHead.revision || afterValidation.manifestHash !== reviewHead.manifestHash ||
          targetAfterValidation.revision !== targetHead.revision || targetAfterValidation.manifestHash !== targetHead.manifestHash) {
        throw new Error("workspace_manual_validation_stale_review_or_target");
      }
    }

    const mergeResponse = await coordinator("/v1/merge", {
      sessionId,
      targetBranch: input.targetBranch,
      ...(validation ? { expectedTargetRevision: validation.targetRevision, expectedTargetManifestHash: validation.targetManifestHash } : {}),
      allocationGeneration: 1,
      fence,
      idempotencyKey: `manual-merge-${operationId}`,
    });
    if (!mergeResponse.ok)
      await coordinatorFailure(
        "workspace_manual_resolution_merge_failed",
        mergeResponse
      );
    const mergeBody = (await mergeResponse.json()) as {
      publication?: WorkspacePublicationReceipt;
    };
    const merge = mergeBody.publication;
    if (!merge || !["published", "noop"].includes(merge.status)) {
      throw new Error("workspace_manual_resolution_stale_target");
    }
    return {
      reviewBranch,
      paths,
      ...(validation ? { validation } : {}),
      checkpoint: checkpoint ?? {
        id: `manual-replay-${input.idempotencyKey}`,
      idempotencyKey: `manual-${operationId}`,
        status: "noop",
        branch: reviewBranch,
        baseRevision: merge.sourceBaseRevision ?? 0,
        revision: merge.sourceRevision ?? 0,
        appliedPaths: [],
        conflicts: [],
        changeSetHash: merge.changeSetHash,
        fence: merge.fence,
        allocationGeneration: merge.allocationGeneration,
      },
      merge,
    };
  } finally {
    await coordinator("/v1/close", { sessionId, runtimeId }).catch(
      () => undefined
    );
  }
}

export function workspaceManualResolutionErrorResponse(
  error: unknown
): Response {
  const code =
    error instanceof Error
      ? error.message
      : "workspace_manual_resolution_failed";
  if (
    code === "invalid_workspace_manual_resolution" ||
    code === "workspace_manual_resolution_content_invalid"
  ) {
    return Response.json(
      { error_code: code },
      { status: 400, headers: { "cache-control": "no-store" } }
    );
  }
  if (
    code.startsWith("workspace_manual_resolution_stale_target") ||
    code.startsWith("workspace_manual_resolution_stale_source")
  ) {
    return Response.json(
      { error_code: "workspace_manual_resolution_stale_target" },
      { status: 409, headers: { "cache-control": "no-store" } }
    );
  }
  if (code.startsWith("workspace_manual_resolution_branch_failed:"))
    return Response.json(
      { error_code: "workspace_manual_resolution_branch_unavailable" },
      { status: 409 }
    );
  if (code.startsWith("workspace_manual_resolution_open_failed:"))
    return Response.json(
      { error_code: "workspace_manual_resolution_open_failed" },
      { status: 409 }
    );
  if (code.startsWith("workspace_manual_resolution_checkpoint_failed:"))
    return Response.json(
      { error_code: "workspace_manual_resolution_checkpoint_failed" },
      { status: 409 }
    );
  if (code.startsWith("workspace_manual_resolution_merge_failed:"))
    return Response.json(
      { error_code: "workspace_manual_resolution_merge_failed" },
      { status: 409 }
    );
  return Response.json(
    { error_code: "workspace_manual_resolution_failed" },
    { status: 503 }
  );
}
