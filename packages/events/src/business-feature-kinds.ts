/**
 * @naelao/events — compatibility API for project-kind authorization.
 *
 * The kernel registry is intentionally empty. Domain-specific business capabilities are provided
 * by FDE-authored Space Templates, extensions, or connected MCP servers. Generic structural
 * project kinds remain available independently of this registry.
 */

/** The space-level role vocabulary retained for scoped extension authorization. */
export type FeatureKindRole = "owner" | "admin" | "editor";

export interface BusinessFeatureKind {
  readonly kind: string;
  readonly label: string;
  readonly description: string;
  readonly singleton: boolean;
  readonly minCreationRole: FeatureKindRole;
  readonly autoProvisionable: boolean;
  readonly prebuiltScripts?: readonly string[];
  readonly uiPanel?: string;
}

const ROLE_RANK: Record<FeatureKindRole, number> = { editor: 1, admin: 2, owner: 3 };

/**
 * Naelao keeps the kernel registry empty. Domain features are installed as Space Templates,
 * extensions, or connected MCP servers. Generic workspace kinds remain separate.
 */
export const BUSINESS_FEATURE_KIND_REGISTRY: readonly BusinessFeatureKind[] = Object.freeze([]);

const KIND_MAP: Map<string, BusinessFeatureKind> = new Map(
  BUSINESS_FEATURE_KIND_REGISTRY.map((k) => [k.kind, k])
);

/** Layout primitives are the only project kinds accepted by the kernel. */
export const STRUCTURAL_PROJECT_KINDS = Object.freeze(["DualPane", "CanvasFirst", "HeadlessPipeline", "TerminalFirst"] as const);

/** Look up a registry entry (undefined for structural kinds or an unknown kind). */
export function getBusinessFeatureKind(kind: string): BusinessFeatureKind | undefined {
  return KIND_MAP.get(kind);
}

/** Is this a kind a project may be created with at all (structural OR a known feature kind)? */
export function isKnownProjectKind(kind: string): boolean {
  return (STRUCTURAL_PROJECT_KINDS as readonly string[]).includes(kind) || KIND_MAP.has(kind);
}

/** Does the given space-level role meet a kind's minimum creation role? */
export function roleMeetsMinimum(callerRole: string, minRole: FeatureKindRole): boolean {
  const caller = ROLE_RANK[callerRole as FeatureKindRole];
  return caller !== undefined && caller >= ROLE_RANK[minRole];
}

/**
 * The registry entries a caller with `callerRole` may create, for the project-template picker.
 * Role-filtered server-side for any future scoped feature kinds.
 */
export function creatableFeatureKindsForRole(callerRole: string): readonly BusinessFeatureKind[] {
  return Object.freeze(BUSINESS_FEATURE_KIND_REGISTRY.filter((k) => roleMeetsMinimum(callerRole, k.minCreationRole)));
}
