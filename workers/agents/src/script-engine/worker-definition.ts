/**
 * Versioned reusable worker definition parser (APW08, D6).
 *
 * This parser validates shape and bounds only. It GRANTS NOTHING: `capabilities` is a list of
 * requested operation names, not authority. A host that binds a definition must intersect
 * `capabilities` with the caller's current grants at execution time. Nothing in this module is
 * wired to any dispatcher yet, and `long_running` durations are never inferred.
 */
import { ALLOWED_MODELS } from "@naelao/billing-core";

export type WorkerDefinitionKind = "ephemeral" | "long_running";

interface WorkerDefinitionBase {
  readonly schema_version: 1;
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly model_hint?: string;
  readonly capabilities: readonly string[];
  readonly max_tokens: number;
  readonly evidence_required: boolean;
}

export type WorkerDefinitionV1 =
  | (WorkerDefinitionBase & { readonly kind: "ephemeral" })
  | (WorkerDefinitionBase & {
      readonly kind: "long_running";
      readonly max_active_minutes: number;
      readonly max_approval_wait_minutes: number;
      readonly on_expiry: "fail";
    });

/** No shared op-name pattern exists in the script engine; this is the spec fallback. */
export const WORKER_CAPABILITY_OP_PATTERN = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const BASE_KEYS = [
  "schema_version",
  "id",
  "name",
  "kind",
  "instructions",
  "model_hint",
  "capabilities",
  "max_tokens",
  "evidence_required",
];
const LONG_KEYS = ["max_active_minutes", "max_approval_wait_minutes", "on_expiry"];

function intIn(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`invalid_worker_definition: ${field} must be an integer ${min}-${max}`);
  }
  return value;
}

function fail(msg: string): never {
  throw new Error(`invalid_worker_definition: ${msg}`);
}

export function parseWorkerDefinitionV1(value: unknown): WorkerDefinitionV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("not an object");
  const v = value as Record<string, unknown>;
  if (v.schema_version !== 1) fail("schema_version must be 1");
  if (v.kind !== "ephemeral" && v.kind !== "long_running") fail("kind invalid");
  const kind = v.kind;
  const allowed = new Set(kind === "long_running" ? [...BASE_KEYS, ...LONG_KEYS] : BASE_KEYS);
  for (const key of Object.keys(v)) {
    if (!allowed.has(key)) fail(`unknown field ${key}`);
  }
  if (typeof v.id !== "string" || !SLUG_PATTERN.test(v.id)) fail("id must be a slug");
  if (typeof v.name !== "string" || v.name.trim() === "" || v.name.length > 200) {
    fail("name must be 1-200 characters");
  }
  if (typeof v.instructions !== "string" || v.instructions.length > 8000) {
    fail("instructions must be a string of at most 8000 characters");
  }
  let model_hint: string | undefined;
  if (v.model_hint !== undefined) {
    if (
      typeof v.model_hint !== "string" ||
      !(ALLOWED_MODELS as readonly string[]).includes(v.model_hint)
    ) {
      fail("model_hint is not an allowed model");
    }
    model_hint = v.model_hint;
  }
  if (!Array.isArray(v.capabilities) || v.capabilities.length > 64) {
    fail("capabilities must be an array of at most 64 names");
  }
  const seen = new Set<string>();
  for (const cap of v.capabilities as unknown[]) {
    if (typeof cap !== "string" || !WORKER_CAPABILITY_OP_PATTERN.test(cap)) {
      fail("capability is not a valid operation name");
    }
    // Duplicates are rejected rather than silently deduped so definitions stay canonical.
    if (seen.has(cap)) fail(`duplicate capability ${cap}`);
    seen.add(cap);
  }
  const max_tokens = intIn(v.max_tokens, 1000, 200000, "max_tokens");
  if (typeof v.evidence_required !== "boolean") fail("evidence_required must be boolean");

  const base = {
    schema_version: 1 as const,
    id: v.id,
    name: v.name,
    instructions: v.instructions,
    ...(model_hint !== undefined ? { model_hint } : {}),
    capabilities: Object.freeze([...(v.capabilities as string[])]),
    max_tokens,
    evidence_required: v.evidence_required,
  };
  if (kind === "ephemeral") return Object.freeze({ ...base, kind });
  const max_active_minutes = intIn(v.max_active_minutes, 1, 1440, "max_active_minutes");
  const max_approval_wait_minutes = intIn(
    v.max_approval_wait_minutes,
    1,
    10080,
    "max_approval_wait_minutes",
  );
  if (v.on_expiry !== "fail") fail('on_expiry must be "fail"');
  return Object.freeze({
    ...base,
    kind,
    max_active_minutes,
    max_approval_wait_minutes,
    on_expiry: "fail" as const,
  });
}
