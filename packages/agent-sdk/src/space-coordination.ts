/** Versioned, explicit Space coordination facts. These records are advisory and never grant access. */
export interface SpaceCoordinationDraftV1 {
  capability_key: string;
  label: string;
  description?: string;
}

export type SpaceCoordinationAudienceV2 = "space_members" | "space_admins";
export interface SpaceCoordinationDraftV2 extends SpaceCoordinationDraftV1 {
  schema_version: 2;
  audience: SpaceCoordinationAudienceV2;
  /** Optional owner-selected expiration. Null keeps the fact active until revoked. */
  expires_at?: string | null;
}

export interface SpaceCoordinationEntryV1 extends Omit<SpaceCoordinationDraftV1, "description"> {
  description: string | null;
  schema_version: 1;
  entry_id: string;
  audience: "space_members";
  status: "active" | "revoked";
  advisory_only: true;
  version: number;
  created_at: string;
  updated_at: string;
  last_confirmed_at: string;
  revoked_at: string | null;
}

export interface SpaceCoordinationEntryV2 extends Omit<SpaceCoordinationDraftV2, "schema_version" | "description"> {
  description: string | null;
  /** Legacy entries keep their original creation version when returned by the v2 audience API. */
  schema_version: 1 | 2;
  entry_id: string;
  status: "active" | "expired" | "revoked";
  advisory_only: true;
  version: number;
  created_at: string;
  updated_at: string;
  last_confirmed_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  /** Returned only to Space owners and administrators by the v2 lifecycle API. */
  created_by?: string;
  approved_by?: string;
  approved_role?: "owner" | "admin";
  provenance?: "explicit_owner_or_admin_approval";
  revoked_by?: string | null;
}

export interface SpaceCoordinationDisclosureV1 {
  audience: "all active members of this Space";
  effect: "advisory only; does not grant access, editing rights, or authority to use a service";
}

export const SPACE_COORDINATION_DISCLOSURE_V1: SpaceCoordinationDisclosureV1 = {
  audience: "all active members of this Space",
  effect: "advisory only; does not grant access, editing rights, or authority to use a service",
};

export interface SpaceCoordinationDisclosureV2 {
  audience: "all active members of this Space" | "Space owners and administrators";
  effect: "advisory only; does not grant access, editing rights, or authority to use a service";
}

export function spaceCoordinationDisclosureV2(audience: SpaceCoordinationAudienceV2): SpaceCoordinationDisclosureV2 {
  return { audience: audience === "space_admins" ? "Space owners and administrators" : "all active members of this Space",
    effect: "advisory only; does not grant access, editing rights, or authority to use a service" };
}

export type SpaceCoordinationDraftResult =
  | { ok: true; value: SpaceCoordinationDraftV1 }
  | { ok: false; error: "invalid_capability_key" | "invalid_label" | "invalid_description" };

/** Shared bounded normalization. The host repeats validation before it records any publication. */
export function validateSpaceCoordinationDraft(input: unknown): SpaceCoordinationDraftResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "invalid_label" };
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["capability_key", "label", "description"].includes(key))) {
    return { ok: false, error: "invalid_label" };
  }
  const capabilityKey = typeof value.capability_key === "string" ? value.capability_key.trim().toLowerCase() : "";
  if (!/^[a-z][a-z0-9_.:-]{0,95}$/.test(capabilityKey)) return { ok: false, error: "invalid_capability_key" };
  if (typeof value.label !== "string") return { ok: false, error: "invalid_label" };
  const label = value.label.trim();
  if (!label || label.length > 120 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(label)) return { ok: false, error: "invalid_label" };
  if (value.description !== undefined && typeof value.description !== "string") return { ok: false, error: "invalid_description" };
  const description = typeof value.description === "string" ? value.description.trim() : "";
  if (description.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description)) return { ok: false, error: "invalid_description" };
  return { ok: true, value: { capability_key: capabilityKey, label, ...(description ? { description } : {}) } };
}

export function validateSpaceCoordinationDraftV2(input: unknown):
  | { ok: true; value: SpaceCoordinationDraftV2 }
  | { ok: false; error: "invalid_capability_key" | "invalid_label" | "invalid_description" | "invalid_audience" | "unsupported_schema_version" | "invalid_expiry" } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "invalid_label" };
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !["schema_version", "capability_key", "label", "description", "audience", "expires_at"].includes(key)))
    return { ok: false, error: "invalid_label" };
  if (value.schema_version !== 2) return { ok: false, error: "unsupported_schema_version" };
  if (value.audience !== "space_members" && value.audience !== "space_admins") return { ok: false, error: "invalid_audience" };
  const parsed = validateSpaceCoordinationDraft({ capability_key: value.capability_key, label: value.label,
    ...(value.description === undefined ? {} : { description: value.description }) });
  if (!parsed.ok) return parsed;
  let expiresAt: string | null = null;
  if (value.expires_at !== undefined && value.expires_at !== null && value.expires_at !== "") {
    if (typeof value.expires_at !== "string") return { ok: false, error: "invalid_expiry" };
    const timestamp = Date.parse(value.expires_at);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value.expires_at)
      return { ok: false, error: "invalid_expiry" };
    expiresAt = value.expires_at;
  }
  return { ok: true, value: { schema_version: 2, audience: value.audience, ...parsed.value, expires_at: expiresAt } };
}

export function validateSpaceCoordinationSingletonKeys(input: unknown):
  | { ok: true; value: string[] }
  | { ok: false; error: "invalid_singleton_capability_keys" } {
  if (!Array.isArray(input) || input.length > 32) return { ok: false, error: "invalid_singleton_capability_keys" };
  const keys: string[] = [];
  for (const candidate of input) {
    if (typeof candidate !== "string" || candidate !== candidate.trim() || !/^[a-z][a-z0-9_.:-]{0,95}$/.test(candidate)
      || keys.includes(candidate)) return { ok: false, error: "invalid_singleton_capability_keys" };
    keys.push(candidate);
  }
  return { ok: true, value: keys.sort() };
}

export interface SpaceCoordinationSingletonPolicy {
  schema_version: 1;
  configured: boolean;
  singleton_capability_keys: string[];
  revision: number;
  reservations: Array<{ capability_key: string; entry_id: string; reserved_at: string }>;
  updated_by?: string;
  updated_at?: string;
}

export interface SpaceCoordinationSingletonPolicyEvent {
  event_id: string;
  prior_revision: number | null;
  revision: number;
  prior_capability_keys: string[];
  capability_keys: string[];
  actor_id: string;
  actor_role: "owner" | "admin";
  created_at: string;
}

export interface SpaceCoordinationSingletonPolicyHistory {
  schema_version: 1;
  events: SpaceCoordinationSingletonPolicyEvent[];
  next_after: string | null;
}

export interface SpaceCoordinationPageV1 {
  schema_version: 1;
  entries: SpaceCoordinationEntryV1[];
  next_after: string | null;
}

export interface SpaceCoordinationPageV2 {
  schema_version: 2;
  entries: SpaceCoordinationEntryV2[];
  next_after: string | null;
}

export interface SpaceCoordinationAuditEventV2 {
  event_id: string;
  entry_id: string;
  action: "published" | "amended" | "revoked" | "source_retired";
  prior_version: number | null;
  version: number;
  actor_id: string;
  actor_role: "owner" | "admin" | "system";
  audience_before: SpaceCoordinationAudienceV2 | null;
  audience_after: SpaceCoordinationAudienceV2;
  expires_at_before: string | null;
  expires_at_after: string | null;
  status_after: "active" | "revoked";
  provenance: "explicit_owner_or_admin_approval";
  created_at: string;
}

export interface SpaceCoordinationAuditHistoryPageV2 {
  entry_id: string;
  events: SpaceCoordinationAuditEventV2[];
  next_after: string | null;
}

export interface SpaceCoordinationPolicyV2 {
  schema_version: 2;
  configured: boolean;
  member_facts_enabled: boolean;
  revision: number;
  active_member_facts: number;
  updated_by?: string;
  updated_at?: string;
}

export interface SpaceCoordinationPolicyEventV2 {
  event_id: string;
  prior_revision: number | null;
  revision: number;
  prior_member_facts_enabled: boolean | null;
  member_facts_enabled: boolean;
  actor_id: string;
  actor_role: "owner" | "admin";
  created_at: string;
}

export interface SpaceCoordinationPolicyHistoryPageV2 {
  schema_version: 2;
  events: SpaceCoordinationPolicyEventV2[];
  next_after: string | null;
}

export type SpaceCoordinationUseRequestStatus = "pending" | "resolved";
export type SpaceCoordinationUseRequestResolution = "contacted" | "unavailable";
export interface SpaceCoordinationUseRequest {
  request_id: string;
  entry_id: string;
  status: SpaceCoordinationUseRequestStatus;
  resolution: SpaceCoordinationUseRequestResolution | null;
  revision: number;
  created_at: string;
  updated_at: string;
  /** Owner/admin-only identity for requests in their review queue. */
  requester_id?: string;
  /** Owner/admin-only label from the approved fact. */
  entry_label?: string;
  resolved_by?: string | null;
  resolved_role?: "owner" | "admin" | null;
}
export interface SpaceCoordinationUseRequestPage {
  requests: SpaceCoordinationUseRequest[];
  next_after: string | null;
  access_granted: false;
}

export type SpaceCoordinationProposalStatus = "pending" | "approved" | "rejected" | "withdrawn" | "retired";
export type SpaceCoordinationProposalAction = "approve" | "reject";
export interface SpaceCoordinationPublicationProposal {
  proposal_id: string;
  project_id: string;
  draft: SpaceCoordinationDraftV2;
  status: SpaceCoordinationProposalStatus;
  revision: number;
  created_at: string;
  updated_at: string;
  /** Reviewer-only provenance; requester reads do not expose another person's identity. */
  requester_id?: string;
  reviewed_by?: string | null;
  reviewed_role?: "owner" | "admin" | null;
  entry_id?: string | null;
}
export interface SpaceCoordinationPublicationProposalPage {
  proposals: SpaceCoordinationPublicationProposal[];
  next_after: string | null;
}

export interface SpaceCoordinationClientOptions {
  spaceId: string;
  request<T>(path: string, init?: { method?: "GET" | "POST" | "DELETE" | "PATCH" | "PUT"; body?: unknown }): Promise<T>;
}

export type SpaceCoordinationProposalClientOptions = SpaceCoordinationClientOptions;

/** Caller-neutral client for private, project-authored Space disclosure proposals. */
export function createSpaceCoordinationProposalClient(options: SpaceCoordinationProposalClientOptions) {
  const spaceBase = `/spaces/${encodeURIComponent(options.spaceId)}/coordination-proposals`;
  const projectBase = (projectId: string) => `/spaces/${encodeURIComponent(options.spaceId)}/projects/${encodeURIComponent(projectId)}/coordination-proposals`;
  return {
    reviewQueue(after?: string): Promise<SpaceCoordinationPublicationProposalPage> {
      const query = after ? `?after=${encodeURIComponent(after)}` : "";
      return options.request(`${spaceBase}${query}`);
    },
    listProject(projectId: string, after?: string): Promise<SpaceCoordinationPublicationProposalPage> {
      const query = after ? `?after=${encodeURIComponent(after)}` : "";
      return options.request(`${projectBase(projectId)}${query}`);
    },
    submit(projectId: string, draft: SpaceCoordinationDraftV2, confirmDisclosure: boolean,
      requestId: string): Promise<{ proposal: SpaceCoordinationPublicationProposal }> {
      return options.request(projectBase(projectId), { method: "POST", body: { request_id: requestId, ...draft, confirm_disclosure: confirmDisclosure } });
    },
    withdraw(projectId: string, proposalId: string, expectedRevision: number): Promise<{ proposal: SpaceCoordinationPublicationProposal }> {
      return options.request(`${projectBase(projectId)}/${encodeURIComponent(proposalId)}`, { method: "DELETE", body: { expected_revision: expectedRevision } });
    },
    review(proposalId: string, expectedRevision: number, action: SpaceCoordinationProposalAction,
      draft?: SpaceCoordinationDraftV2): Promise<{ proposal: SpaceCoordinationPublicationProposal; entry?: SpaceCoordinationEntryV2; access_granted: false }> {
      return options.request(`${spaceBase}/${encodeURIComponent(proposalId)}`, {
        method: "PATCH", body: { expected_revision: expectedRevision, action,
          ...(action === "approve" ? { confirm_disclosure: true, draft } : {}) },
      });
    },
  };
}

/** Small caller-neutral API client. The caller supplies its authenticated host transport. */
export function createSpaceCoordinationClient(options: SpaceCoordinationClientOptions) {
  const base = `/spaces/${encodeURIComponent(options.spaceId)}/coordination-registry`;
  return {
    list(after?: string): Promise<SpaceCoordinationPageV1> {
      const query = after ? `?after=${encodeURIComponent(after)}` : "";
      return options.request(`${base}${query}`);
    },
    preview(draft: SpaceCoordinationDraftV1): Promise<{ schema_version: 1; draft: SpaceCoordinationDraftV1; disclosure: SpaceCoordinationDisclosureV1 }> {
      return options.request(`${base}/preview`, { method: "POST", body: draft });
    },
    publish(draft: SpaceCoordinationDraftV1, confirmDisclosure: boolean): Promise<{ entry: SpaceCoordinationEntryV1; disclosure: SpaceCoordinationDisclosureV1 }> {
      return options.request(base, { method: "POST", body: { ...draft, confirm_disclosure: confirmDisclosure } });
    },
    revoke(entryId: string, expectedVersion: number): Promise<{ entry: SpaceCoordinationEntryV1 }> {
      return options.request(`${base}/${encodeURIComponent(entryId)}`, { method: "DELETE", body: { expected_version: expectedVersion } });
    },
  };
}

/** Version 2 adds an explicit, owner-selected visibility audience without granting use rights. */
export function createSpaceCoordinationClientV2(options: SpaceCoordinationClientOptions) {
  const base = `/spaces/${encodeURIComponent(options.spaceId)}/coordination-registry/v2`;
  const singletonBase = `${base}/singletons`;
  return {
    policy(): Promise<SpaceCoordinationPolicyV2> {
      return options.request(`${base}/policy`);
    },
    policyHistory(after?: string): Promise<SpaceCoordinationPolicyHistoryPageV2> {
      const query = after ? `?after=${encodeURIComponent(after)}` : "";
      return options.request(`${base}/policy/history${query}`);
    },
    useRequests(after?: string): Promise<SpaceCoordinationUseRequestPage> {
      const query = after ? `?after=${encodeURIComponent(after)}` : "";
      return options.request(`${base}/requests${query}`);
    },
    requestCollaboration(entryId: string, confirmIdentitySharing: boolean): Promise<{ request: SpaceCoordinationUseRequest; access_granted: false }> {
      return options.request(`${base}/${encodeURIComponent(entryId)}/requests`, { method: "POST", body: {
        confirm_identity_sharing: confirmIdentitySharing,
      } });
    },
    resolveUseRequest(requestId: string, expectedRevision: number, resolution: SpaceCoordinationUseRequestResolution): Promise<{ request: SpaceCoordinationUseRequest; access_granted: false }> {
      return options.request(`${base}/requests/${encodeURIComponent(requestId)}`, { method: "PATCH", body: {
        expected_revision: expectedRevision, resolution,
      } });
    },
    updatePolicy(memberFactsEnabled: boolean, expectedRevision: number, confirm: boolean): Promise<SpaceCoordinationPolicyV2> {
      return options.request(`${base}/policy`, { method: "PUT", body: {
        member_facts_enabled: memberFactsEnabled, expected_revision: expectedRevision, confirm,
      } });
    },
    singletonPolicy(): Promise<SpaceCoordinationSingletonPolicy> {
      return options.request(singletonBase);
    },
    singletonPolicyHistory(after?: string): Promise<SpaceCoordinationSingletonPolicyHistory> {
      const query = after ? `?after=${encodeURIComponent(after)}` : "";
      return options.request(`${singletonBase}/history${query}`);
    },
    updateSingletonPolicy(keys: string[], expectedRevision: number, confirm: boolean): Promise<SpaceCoordinationSingletonPolicy> {
      const parsed = validateSpaceCoordinationSingletonKeys(keys);
      if (!parsed.ok) throw new Error(parsed.error);
      return options.request(singletonBase, { method: "PUT", body: {
        singleton_capability_keys: parsed.value, expected_revision: expectedRevision, confirm,
      } });
    },
    list(after?: string): Promise<SpaceCoordinationPageV2> {
      const query = after ? `?after=${encodeURIComponent(after)}` : "";
      return options.request(`${base}${query}`);
    },
    history(entryId: string, after?: string): Promise<SpaceCoordinationAuditHistoryPageV2> {
      const query = after ? `?after=${encodeURIComponent(after)}` : "";
      return options.request(`${base}/${encodeURIComponent(entryId)}/history${query}`);
    },
    preview(draft: SpaceCoordinationDraftV2): Promise<{ schema_version: 2; draft: SpaceCoordinationDraftV2; disclosure: SpaceCoordinationDisclosureV2; no_project_source: true }> {
      return options.request(`${base}/preview`, { method: "POST", body: draft });
    },
    publish(draft: SpaceCoordinationDraftV2, confirmDisclosure: boolean): Promise<{ entry: SpaceCoordinationEntryV2; disclosure: SpaceCoordinationDisclosureV2 }> {
      return options.request(base, { method: "POST", body: { ...draft, confirm_disclosure: confirmDisclosure } });
    },
    revoke(entryId: string, expectedVersion: number): Promise<{ entry: SpaceCoordinationEntryV2 }> {
      return options.request(`${base}/${encodeURIComponent(entryId)}`, { method: "DELETE", body: { schema_version: 2, expected_version: expectedVersion } });
    },
    amend(entryId: string, expectedVersion: number, draft: SpaceCoordinationDraftV2, confirmDisclosure: boolean): Promise<{ entry: SpaceCoordinationEntryV2; disclosure: SpaceCoordinationDisclosureV2 }> {
      return options.request(`${base}/${encodeURIComponent(entryId)}`, { method: "PATCH", body: { ...draft, expected_version: expectedVersion, confirm_disclosure: confirmDisclosure } });
    },
  };
}
