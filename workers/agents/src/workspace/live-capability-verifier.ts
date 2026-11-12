import type { WorkspaceScope } from "./workspace-contract.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const OPERATION_ID = (runtimeId: string, generation: number) => `workspace-live:${runtimeId}:${generation}`;
const OBSERVED_CAPABILITIES = [
  "liveMountReady", "fuseReady", "incrementalSyncReady", "flushReady",
  "reconnectGenerationCheck", "authenticatedTransport", "runtimeAccountingReady",
] as const;

type Candidate = {
  runtime_id: string;
  tenant_id: string;
  owner_id: string;
  space_id: string | null;
  project_id: string | null;
  branch: string;
  computer_state: string;
  filesystem_mode: string;
  computer_generation: number;
  template_id: string;
  template_version: string;
  template_digest: string | null;
  template_status: string | null;
  template_valid_until: string | null;
  allocation_id: string | null;
  allocation_generation: number | null;
  allocation_status: string | null;
  allocation_image_digest: string | null;
  connection_provider: string | null;
  connection_status: string | null;
  connection_region: string | null;
  observation_runtime_type: string | null;
  observation_template_id: string | null;
  observation_template_digest: string | null;
  observation_region: string | null;
  residency_policy_id: string | null;
  capability_observations_json: string | null;
  billing_reservation_id: string | null;
  budget_reservation_id: string | null;
  evidence_json: string | null;
  verified_by: string | null;
  verified_at: string | null;
  valid_until: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedDigest(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.startsWith("sha256:") ? value : `sha256:${value}`;
  return DIGEST.test(normalized) ? normalized : null;
}

function parseCapabilities(raw: string | null): Record<string, unknown> {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    return isRecord(value) ? value : {};
  } catch { return {}; }
}

function hasLiveWritePermission(raw: string): boolean {
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value)) return value.includes("live_single_writer");
    return isRecord(value) && value.live_single_writer === true;
  } catch { return false; }
}

function validEvidence(raw: unknown, now: Date): raw is Array<{ url: string; checkedAt: string; sha256: string }> {
  return Array.isArray(raw) && raw.length > 0 && raw.length <= 30 && raw.every((item) => {
    if (!isRecord(item) || typeof item.url !== "string" || typeof item.checkedAt !== "string" || typeof item.sha256 !== "string") return false;
    try {
      const url = new URL(item.url);
      const checkedAt = Date.parse(item.checkedAt);
      return url.protocol === "https:" && !url.username && !url.password && DIGEST.test(`sha256:${item.sha256.replace(/^sha256:/, "")}`)
        && Number.isFinite(checkedAt) && checkedAt <= now.getTime() + 60_000 && now.getTime() - checkedAt <= 24 * 60 * 60_000;
    } catch { return false; }
  });
}

export interface LiveRuntimeObservationInput {
  scope: WorkspaceScope;
  runtimeId: string;
  allocationId: string;
  allocationGeneration: number;
  runtimeType: string;
  templateId: string;
  templateDigest: string;
  region: string;
  residencyPolicyId: string;
  jurisdiction: "global" | "eu";
  capabilities: Record<string, unknown>;
  billingReservationId: string;
  budgetReservationId: string;
  evidence: unknown;
  verifiedBy: string;
  reason: string;
  validUntil: string;
  now?: Date;
}

export async function recordLiveRuntimeObservation(db: D1Database, input: LiveRuntimeObservationInput) {
  const now = input.now ?? new Date();
  const validUntil = Date.parse(input.validUntil);
  const capabilityKeys = [...OBSERVED_CAPABILITIES, "residencyAllowed"];
  if (!ID.test(input.runtimeId) || !ID.test(input.allocationId) || !Number.isSafeInteger(input.allocationGeneration) || input.allocationGeneration < 1
    || !ID.test(input.runtimeType) || !ID.test(input.templateId) || !DIGEST.test(input.templateDigest)
    || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.region) || !ID.test(input.residencyPolicyId)
    || !ID.test(input.billingReservationId) || !ID.test(input.budgetReservationId) || !ID.test(input.verifiedBy)
    || input.reason.trim().length < 10 || input.reason.length > 500
    || !Number.isFinite(validUntil) || validUntil <= now.getTime() || validUntil > now.getTime() + 24 * 60 * 60_000
    || !capabilityKeys.every((key) => typeof input.capabilities[key] === "boolean")
    || input.capabilities.jurisdiction !== input.jurisdiction || !validEvidence(input.evidence, now)) {
    throw new Error("live_runtime_observation_invalid");
  }

  const allocation = await db.prepare(`SELECT c.tenant_id,c.space_id,c.project_id,c.state,c.branch,c.filesystem_mode,c.allocation_generation,
      c.template_id,c.template_version,a.id AS allocation_id,a.generation,a.status AS allocation_status,a.provider,a.image_digest,
      conn.provider AS connection_provider,conn.status AS connection_status,conn.region,t.digest AS template_digest,t.status AS template_status,t.valid_until AS template_valid_until
    FROM sandbox_computers c
    JOIN sandbox_allocations a ON a.computer_id=c.id AND a.id=? AND a.generation=?
    JOIN sandbox_connections conn ON conn.id=a.connection_id AND conn.tenant_id=c.tenant_id
    JOIN sandbox_template_versions t ON t.template_id=c.template_id AND t.version=c.template_version
    JOIN spaces s ON s.id=c.space_id AND s.tenant_id=c.tenant_id AND s.status='active'
    WHERE c.id=? AND c.tenant_id=? AND c.allocation_generation=? AND c.deleted_at IS NULL`)
    .bind(input.allocationId, input.allocationGeneration, input.runtimeId, input.scope.tenantId, input.allocationGeneration)
    .first<{ tenant_id: string; space_id: string; project_id: string; state: string; branch: string; filesystem_mode: string; allocation_generation: number;
      template_id: string; template_version: string; allocation_id: string; generation: number; allocation_status: string; provider: string;
      image_digest: string | null; connection_provider: string; connection_status: string; region: string | null; template_digest: string;
      template_status: string; template_valid_until: string | null }>();
  if (!allocation || allocation.tenant_id !== input.scope.tenantId || allocation.space_id !== input.scope.spaceId
    || allocation.project_id !== input.scope.projectId || allocation.state !== "running" || allocation.branch !== "main" || allocation.filesystem_mode !== "live_mount"
    || allocation.allocation_status !== "active" || allocation.provider !== "cloudflare" || allocation.connection_provider !== "cloudflare"
    || allocation.connection_status !== "verified" || !allocation.region || allocation.region !== input.region
    || allocation.template_id !== input.templateId || normalizedDigest(allocation.template_digest) !== input.templateDigest
    || normalizedDigest(allocation.image_digest) !== input.templateDigest || allocation.template_status !== "verified"
    || !allocation.template_valid_until || Date.parse(allocation.template_valid_until) <= now.getTime()) {
    throw new Error("live_runtime_allocation_not_current");
  }

  const verifiedAt = now.toISOString();
  const evidenceJson = JSON.stringify(input.evidence);
  const capabilityJson = JSON.stringify(input.capabilities);
  const evidenceHash = await sha256Hex(evidenceJson);
  const reason = input.reason.trim();
  const auditId = `lrta_${crypto.randomUUID().replaceAll("-", "")}`;
  const batch = await db.batch([
    db.prepare(`INSERT INTO workspace_live_runtime_observations
      (runtime_id,allocation_id,allocation_generation,runtime_type,template_id,template_digest,region,residency_policy_id,
       capability_observations_json,billing_reservation_id,budget_reservation_id,evidence_json,verified_by,verified_at,valid_until,revoked_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
      ON CONFLICT(runtime_id,allocation_id,allocation_generation) DO UPDATE SET runtime_type=excluded.runtime_type,
       template_id=excluded.template_id,template_digest=excluded.template_digest,region=excluded.region,
       residency_policy_id=excluded.residency_policy_id,capability_observations_json=excluded.capability_observations_json,
       billing_reservation_id=excluded.billing_reservation_id,budget_reservation_id=excluded.budget_reservation_id,
       evidence_json=excluded.evidence_json,verified_by=excluded.verified_by,verified_at=excluded.verified_at,
       valid_until=excluded.valid_until,revoked_at=NULL`)
      .bind(input.runtimeId,input.allocationId,input.allocationGeneration,input.runtimeType,input.templateId,input.templateDigest,input.region,input.residencyPolicyId,
        capabilityJson,input.billingReservationId,input.budgetReservationId,evidenceJson,input.verifiedBy,verifiedAt,new Date(validUntil).toISOString()),
    db.prepare(`INSERT INTO workspace_live_runtime_observation_audit
      (id,runtime_id,allocation_id,allocation_generation,action,actor_id,reason,evidence_sha256,created_at)
      VALUES (?,?,?,?,'observed',?,?,?,?)`)
      .bind(auditId,input.runtimeId,input.allocationId,input.allocationGeneration,input.verifiedBy,reason,evidenceHash,verifiedAt),
  ]);
  if (!batch.every((result) => result?.success)) throw new Error("live_runtime_observation_persistence_failed");
  return { observed: true, runtimeId: input.runtimeId, allocationId: input.allocationId, allocationGeneration: input.allocationGeneration, verifiedAt };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function searchAndVerifyLiveRuntime(db: D1Database, input: {
  scope: WorkspaceScope;
  actorId: string;
  preferredRuntimeId: string;
  preferredAllocationGeneration: number;
  requireExact?: boolean;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  if (!ID.test(input.actorId) || !ID.test(input.preferredRuntimeId) || !Number.isSafeInteger(input.preferredAllocationGeneration)
    || input.preferredAllocationGeneration < 1) return { verified: false, missing: ["invalidCandidateRequest"] };
  const candidates = await db.prepare(`SELECT c.id AS runtime_id,c.tenant_id,c.owner_id,c.space_id,c.project_id,c.branch,c.state AS computer_state,
      c.filesystem_mode,c.allocation_generation AS computer_generation,c.template_id,c.template_version,
      t.digest AS template_digest,t.status AS template_status,t.valid_until AS template_valid_until,
      a.id AS allocation_id,a.generation AS allocation_generation,a.status AS allocation_status,a.image_digest AS allocation_image_digest,
      conn.provider AS connection_provider,conn.status AS connection_status,conn.region AS connection_region,
      o.runtime_type AS observation_runtime_type,o.template_id AS observation_template_id,o.template_digest AS observation_template_digest,
      o.region AS observation_region,o.residency_policy_id,o.capability_observations_json,o.billing_reservation_id,o.budget_reservation_id,
      o.evidence_json,o.verified_by,o.verified_at,o.valid_until
    FROM sandbox_computers c
    JOIN spaces s ON s.id=c.space_id AND s.tenant_id=c.tenant_id AND s.status='active'
    LEFT JOIN sandbox_allocations a ON a.computer_id=c.id AND a.generation=c.allocation_generation AND a.status='active'
    LEFT JOIN sandbox_connections conn ON conn.id=a.connection_id AND conn.tenant_id=c.tenant_id
    LEFT JOIN sandbox_template_versions t ON t.template_id=c.template_id AND t.version=c.template_version
    LEFT JOIN workspace_live_runtime_observations o ON o.runtime_id=c.id AND o.allocation_id=a.id
      AND o.allocation_generation=a.generation AND o.revoked_at IS NULL
    WHERE c.tenant_id=? AND c.space_id=? AND c.project_id=? AND c.branch='main' AND c.deleted_at IS NULL
      AND (?=0 OR c.id=?)
    ORDER BY CASE WHEN c.id=? THEN 0 ELSE 1 END,c.id LIMIT 100`)
    .bind(input.scope.tenantId,input.scope.spaceId,input.scope.projectId,input.requireExact ? 1 : 0,
      input.preferredRuntimeId,input.preferredRuntimeId)
    .all<Candidate & { id?: string }>();
  const rows = candidates.results ?? [];
  if (!rows.length) return { verified: false, missing: ["projectRuntimeAllocation"] };
  const requested = rows.find((row) => row.runtime_id === input.preferredRuntimeId);
  const ordered = [...(requested ? [requested] : []), ...rows.filter((row) => row !== requested)];
  let bestMissing: string[] = [];
  for (const candidate of ordered) {
    const result = await verifyCandidate(db, candidate, input, now);
    if (result.evidence) return { verified: true, evidence: result.evidence,
      candidateSearchPerformed: candidate.runtime_id !== input.preferredRuntimeId };
    if (!bestMissing.length || result.missing.length < bestMissing.length) bestMissing = result.missing;
    if (input.requireExact || candidate.runtime_id === input.preferredRuntimeId) {
      if (input.requireExact) return { verified: false, missing: result.missing };
    }
  }
  return { verified: false, missing: bestMissing.length ? bestMissing : ["projectRuntimeAllocation"] };
}

async function verifyCandidate(db: D1Database, candidate: Candidate, input: {
  scope: WorkspaceScope; actorId: string; preferredRuntimeId: string; preferredAllocationGeneration: number;
}, now: Date): Promise<{ evidence?: Record<string, unknown>; missing: string[] }> {
  const missing: string[] = [];
  if (candidate.computer_state !== "running" || candidate.branch !== "main" || candidate.filesystem_mode !== "live_mount"
    || candidate.computer_generation !== candidate.allocation_generation || candidate.allocation_status !== "active"
    || candidate.connection_provider !== "cloudflare" || candidate.connection_status !== "verified") missing.push("activeMainAllocation");
  if (candidate.runtime_id === input.preferredRuntimeId && candidate.allocation_generation !== input.preferredAllocationGeneration) missing.push("allocationGeneration");
  if (!candidate.allocation_id || !candidate.template_digest || !candidate.allocation_image_digest
    || normalizedDigest(candidate.template_digest) !== normalizedDigest(candidate.allocation_image_digest)
    || candidate.template_status !== "verified" || !candidate.template_valid_until || Date.parse(candidate.template_valid_until) <= now.getTime()) missing.push("verifiedImageTemplate");

  let authorizationId = "";
  let authorizationEpoch = 0;
  if (candidate.owner_id === input.actorId) {
    const member = await db.prepare(`SELECT 1 AS active FROM spaces s WHERE s.id=? AND s.tenant_id=? AND s.status='active'
      AND (EXISTS(SELECT 1 FROM orgs o WHERE o.id=s.tenant_id AND o.status='active' AND o.owner_id=?)
        OR EXISTS(SELECT 1 FROM org_members m WHERE m.org_id=s.tenant_id AND m.user_id=? AND m.joined_at IS NOT NULL)
        OR EXISTS(SELECT 1 FROM space_members sm WHERE sm.space_id=s.id AND sm.tenant_id=s.tenant_id AND sm.end_user_id=? AND sm.suspended_at IS NULL))`)
      .bind(input.scope.spaceId,input.scope.tenantId,input.actorId,input.actorId,input.actorId).first<{active:number}>();
    if (member) {
      authorizationId = `owner:${candidate.runtime_id}:${candidate.computer_generation}`;
      authorizationEpoch = candidate.computer_generation;
    } else missing.push("currentMembership");
  } else {
    const grant = await db.prepare(`SELECT id,grantee_type,permissions_json,created_at FROM sandbox_grants
      WHERE tenant_id=? AND owner_id=? AND computer_id=? AND grantee_type IN ('user','agent') AND grantee_id=?
       AND revoked_at IS NULL AND (expires_at IS NULL OR julianday(expires_at)>julianday(?))
      ORDER BY created_at DESC LIMIT 1`)
      .bind(input.scope.tenantId,candidate.owner_id,candidate.runtime_id,input.actorId,now.toISOString())
      .first<{id:string;grantee_type:string;permissions_json:string;created_at:string}>();
    if (grant && hasLiveWritePermission(grant.permissions_json)) {
      if (grant.grantee_type === "user") {
        const member = await db.prepare(`SELECT 1 AS active FROM spaces s WHERE s.id=? AND s.tenant_id=? AND s.status='active'
          AND (EXISTS(SELECT 1 FROM orgs o WHERE o.id=s.tenant_id AND o.status='active' AND o.owner_id=?)
            OR EXISTS(SELECT 1 FROM org_members m WHERE m.org_id=s.tenant_id AND m.user_id=? AND m.joined_at IS NOT NULL)
            OR EXISTS(SELECT 1 FROM space_members sm WHERE sm.space_id=s.id AND sm.tenant_id=s.tenant_id AND sm.end_user_id=? AND sm.suspended_at IS NULL))`)
          .bind(input.scope.spaceId,input.scope.tenantId,input.actorId,input.actorId,input.actorId).first<{active:number}>();
        if (member) {
          authorizationId = grant.id;
          authorizationEpoch = Math.max(1, Date.parse(grant.created_at) || 1);
        } else missing.push("currentMembership");
      } else {
        const agent = await db.prepare(`SELECT id FROM agentport_agents WHERE id=? AND tenant_id=? AND status='active' LIMIT 1`)
          .bind(input.actorId,input.scope.tenantId).first<{id:string}>();
        if (agent) {
          authorizationId = grant.id;
          authorizationEpoch = Math.max(1, Date.parse(grant.created_at) || 1);
        } else missing.push("activeAgentAuthorization");
      }
    } else missing.push("liveWriterAuthorization");
  }

  const operationId = OPERATION_ID(candidate.runtime_id, candidate.computer_generation);
  const observation = candidate.observation_runtime_type && candidate.verified_by && candidate.verified_at && candidate.valid_until
    && candidate.observation_template_id === candidate.template_id
    && normalizedDigest(candidate.observation_template_digest) === normalizedDigest(candidate.template_digest)
    && candidate.observation_region === candidate.connection_region
    && Date.parse(candidate.verified_at) <= now.getTime() + 30_000 && now.getTime() - Date.parse(candidate.verified_at) <= 5 * 60_000
    && Date.parse(candidate.valid_until) > now.getTime();
  const observed = parseCapabilities(candidate.capability_observations_json);
  if (!observation || !candidate.residency_policy_id || !candidate.evidence_json) missing.push("operatorCapabilityObservation");
  for (const capability of OBSERVED_CAPABILITIES) if (observed[capability] !== true) missing.push(capability);
  if (observed.residencyAllowed !== true || observed.jurisdiction !== input.scope.jurisdiction) missing.push("residencyPolicy");

  const billing = candidate.billing_reservation_id ? await db.prepare(`SELECT id FROM managed_service_credit_reservations
      WHERE id=? AND org_id=? AND space_id=? AND project_id=? AND provider='cloudflare' AND service_id='project-computer'
       AND operation_id=? AND status='held' AND (expires_at IS NULL OR julianday(expires_at)>julianday(?)) LIMIT 1`)
    .bind(candidate.billing_reservation_id,input.scope.tenantId,input.scope.spaceId,input.scope.projectId,operationId,now.toISOString())
    .first<{id:string}>() : null;
  if (!billing) missing.push("billingReservation");
  const budget = candidate.budget_reservation_id ? await db.prepare(`SELECT id FROM workflow_budget_reservations
      WHERE id=? AND org_id=? AND space_id=? AND project_id=? AND workflow_id=? AND status='held'
       AND julianday(expires_at)>julianday(?) LIMIT 1`)
    .bind(candidate.budget_reservation_id,input.scope.tenantId,input.scope.spaceId,input.scope.projectId,operationId,now.toISOString())
    .first<{id:string}>() : null;
  if (!budget) missing.push("budgetReservation");
  if (!authorizationId || !authorizationEpoch) missing.push("liveWriterAuthorization");
  if (missing.length || !observation || !candidate.allocation_id || !candidate.observation_region || !candidate.observation_template_digest
    || !candidate.observation_runtime_type || !candidate.residency_policy_id || !candidate.billing_reservation_id || !candidate.budget_reservation_id
    || !candidate.evidence_json || !candidate.verified_at) {
    return { missing: [...new Set(missing)] };
  }

  let evidence: unknown;
  try { evidence = JSON.parse(candidate.evidence_json); } catch { return { missing: ["operatorEvidence"] }; }
  if (!validEvidence(evidence, now)) return { missing: ["operatorEvidence"] };
  const verifiedAt = Date.parse(candidate.verified_at!);
  const digest = normalizedDigest(candidate.observation_template_digest)!;
  const runtimeId = candidate.runtime_id;
  const allocationGeneration = candidate.allocation_generation!;
  return { missing: [], evidence: {
    runtimeId, runtimeType: candidate.observation_runtime_type, templateId: candidate.template_id, templateDigest: digest,
    region: candidate.observation_region, authorizationId, authorizationEpoch,
    residencyPolicyId: candidate.residency_policy_id, allocationId: candidate.allocation_id,
    allocationGeneration, billingReservationId: candidate.billing_reservation_id, budgetReservationId: candidate.budget_reservation_id,
    authorized: true, residencyAllowed: true, liveMountReady: true, fuseReady: true, incrementalSyncReady: true,
    flushReady: true, reconnectGenerationCheck: true, authenticatedTransport: true, billingReserved: true,
    budgetReserved: true, runtimeAccountingReady: true, verifiedAt,
  } };
}
