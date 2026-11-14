export type SpaceMembership = { id: string };
export type InstalledExtensionReference = { installation_id: string };

export function findMemberSpace<T extends SpaceMembership>(spaces: readonly T[], spaceId: string): T | null {
  return spaces.find(space => space.id === spaceId) ?? null;
}

export function spaceCompatibilityHref(slug: string, spaceId: string, next: "extensions" | "settings", installationId?: string | null): string {
  const query = new URLSearchParams({ next });
  if (next === "extensions" && installationId && installationId.length <= 256) query.set("installationId", installationId);
  return `/p/${encodeURIComponent(slug)}/spaces/${encodeURIComponent(spaceId)}?${query.toString()}`;
}

export function extensionDashboardPath(slug: string, installationId?: string | null): string {
  const query = new URLSearchParams();
  if (installationId && installationId.length <= 256) query.set("installationId", installationId);
  const serializedQuery = query.toString();
  return `/p/${encodeURIComponent(slug)}/extensions${serializedQuery ? `?${serializedQuery}` : ""}`;
}

export function selectInstalledExtension<T extends InstalledExtensionReference>(apps: readonly T[], installationId: string | null): T | null {
  if (!installationId) return null;
  return apps.find(app => app.installation_id === installationId) ?? null;
}
