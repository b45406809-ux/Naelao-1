/**
 * Fingerprint computation + comparison (spec §16 "Fingerprint Computation").
 *
 * Requirements from the spec:
 *  - Deterministic: same state → same hash.
 *  - Stable under irrelevant change (e.g. analytics script swapped) — so we hash a
 *    canonicalized projection of the state, never raw HTML/bytes.
 *  - Sensitive to relevant change (e.g. login form structure) — the caller chooses which
 *    fields go into the projection.
 *  - Tolerance band (default 5%) absorbs real-world noise at the comparison step.
 */

/** Stable JSON: object keys sorted recursively so equal states hash equal. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

/** SHA-256 hex digest via Web Crypto (available in Workers + DO). */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compute a fingerprint over the projection of state that matters for script validity.
 * Pass only the structural fields (selectors, schema field names, status, dir structure),
 * NOT volatile values.
 */
export async function computeFingerprint(projection: Record<string, unknown>): Promise<string> {
  return sha256Hex(canonical(projection));
}

/**
 * Compare a live snapshot fingerprint against a script's expected fingerprint schema.
 *
 * The fingerprint_schema may declare either:
 *  - `{ fingerprint: "<hex>" }` for an exact-match precondition, or
 *  - a set of required field names under `requiredFields: string[]` checked against the
 *    snapshot's own keys (a looser structural precondition).
 *
 * Returns a similarity in [0,1]: 1 = exact match, partial for structural overlap, 0 = none.
 * The escalation ladder uses `tolerance` (default 0.05) to decide L1 vs L2 vs L4.
 */
export function fingerprintSimilarity(
  snapshot: { fingerprint: string; [k: string]: unknown },
  fingerprintSchema: Record<string, unknown>
): number {
  // Exact-match form.
  const expected = fingerprintSchema["fingerprint"];
  if (typeof expected === "string") {
    return expected === snapshot.fingerprint ? 1 : 0;
  }

  // Structural form: how many required fields are present in the snapshot.
  const required = fingerprintSchema["requiredFields"];
  if (Array.isArray(required) && required.length > 0) {
    const present = required.filter((f) => typeof f === "string" && f in snapshot).length;
    return present / required.length;
  }

  // No precondition declared — treat as a permissive match (the FIND step already
  // matched on semantics; absence of a schema means "applies broadly").
  return 1;
}

/** Whether a similarity counts as a high-confidence match given the tolerance band. */
export function isMatch(similarity: number, tolerance = 0.05): boolean {
  return similarity >= 1 - tolerance;
}

/** Whether a similarity is a partial match (→ L2 diagnostic patch) vs no match (→ L4). */
export function isPartial(similarity: number, tolerance = 0.05): boolean {
  return similarity > 0 && similarity < 1 - tolerance;
}
