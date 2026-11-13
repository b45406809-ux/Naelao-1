/** Versioned, explicit Space coordination facts. These records are advisory and never grant access. */
export interface SpaceCoordinationDraftV1 {
  capability_key: string;
  label: string;
  description?: string;
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

export interface SpaceCoordinationDisclosureV1 {
  audience: "all active members of this Space";
  effect: "advisory only; does not grant access, editing rights, or authority to use a service";
}

export const SPACE_COORDINATION_DISCLOSURE_V1: SpaceCoordinationDisclosureV1 = {
  audience: "all active members of this Space",
  effect: "advisory only; does not grant access, editing rights, or authority to use a service",
};

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

export interface SpaceCoordinationPageV1 {
  schema_version: 1;
  entries: SpaceCoordinationEntryV1[];
  next_after: string | null;
}

export interface SpaceCoordinationClientOptions {
  spaceId: string;
  request<T>(path: string, init?: { method?: "GET" | "POST" | "DELETE"; body?: unknown }): Promise<T>;
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
