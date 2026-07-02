/**
 * Tenancy — the data-topology contract a builder picks per product (spec G-Y15 CRITICAL).
 * Pure module (no cloudflare:workers import) so it is reusable by the provisioner and the
 * worker and unit-testable without a DO runtime.
 *
 *   single — one owner, one SpaceDO. No sub-spaces.
 *   team   — one shared SpaceDO; sub-spaces (departments) live inside it, isolated by
 *            space_id in the SpaceDO `spaces` registry. Shared members.
 *   saas   — product root + per-end-user isolation: each customer business is its OWN
 *            SpaceDO under its OWN child tenant (structural isolation, G-Y16).
 */
export type Tenancy = "single" | "team" | "saas";

/**
 * Derive the effective tenancy from a productConfig. Prefers the explicit `tenancy`
 * field; otherwise infers it from membershipModel so older manifests (and per-space
 * overrides) that only set membershipModel still resolve: team→team, tenant→saas,
 * hybrid→saas. Defaults to "team".
 */
export function resolveTenancy(
  pc: { tenancy?: Tenancy; membershipModel?: string } | null | undefined
): Tenancy {
  if (!pc) return "team";
  if (pc.tenancy) return pc.tenancy;
  if (pc.membershipModel === "tenant" || pc.membershipModel === "hybrid") return "saas";
  return "team";
}
