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
  revoked_at: string | null;
}

export interface SpaceCoordinationEntryV2 extends Omit<SpaceCoordinationDraftV2, "schema_version" | "description"> {
  description: string | null;
  /** Legacy entries keep their original creation version when returned by the v2 audience API. */
  schema_version: 1 | 2;
  entry_id: string;
  status: "active" | "revoked";
  advisory_only: true;
  version: number;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
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
  | { ok: false; error: "invalid_capability_key" | "invalid_label" | "invalid_description" | "invalid_audience" | "unsupported_schema_version" } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "invalid_label" };
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !["schema_version", "capability_key", "label", "description", "audience"].includes(key)))
    return { ok: false, error: "invalid_label" };
  if (value.schema_version !== 2) return { ok: false, error: "unsupported_schema_version" };
  if (value.audience !== "space_members" && value.audience !== "space_admins") return { ok: false, error: "invalid_audience" };
  const parsed = validateSpaceCoordinationDraft({ capability_key: value.capability_key, label: value.label,
    ...(value.description === undefined ? {} : { description: value.description }) });
  if (!parsed.ok) return parsed;
  return { ok: true, value: { schema_version: 2, audience: value.audience, ...parsed.value } };
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

export interface SpaceCoordinationClientOptions {
  spaceId: string;
  request<T>(path: string, init?: { method?: "GET" | "POST" | "DELETE" | "PATCH"; body?: unknown }): Promise<T>;
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
  return {
    list(after?: string): Promise<SpaceCoordinationPageV2> {
      const query = after ? `?after=${encodeURIComponent(after)}` : "";
      return options.request(`${base}${query}`);
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
