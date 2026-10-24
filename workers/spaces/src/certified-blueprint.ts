import type { SpaceBlueprint } from "@naelao/agent-sdk";
import type { ConformanceCertificate } from "@naelao/security";

export interface CertifiedBlueprintEnvelope {
  blueprint: SpaceBlueprint;
  conformanceCertificate: ConformanceCertificate;
}

/**
 * Resolve a publisher artifact from its tenant namespace. The unscoped key is read only for
 * deployments created before tenant namespaces existed; callers still verify the certificate
 * issuer and the marketplace fork bytes before allowing activation.
 */
export async function loadCertifiedBlueprint(
  env: { PLATFORM_DB: D1Database; SCRIPTS_R2?: R2Bucket },
  tenantId: string,
  blueprintId: string,
): Promise<CertifiedBlueprintEnvelope | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tenantId) || tenantId.includes("..") ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(blueprintId) || blueprintId.includes("..")) {
    return null;
  }
  if (env.SCRIPTS_R2) {
    for (const key of [`blueprints/${tenantId}/${blueprintId}.json`, `blueprints/${blueprintId}.json`]) {
      const object = await env.SCRIPTS_R2.get(key);
      if (!object) continue;
      try {
        const value = await object.json<CertifiedBlueprintEnvelope>();
        if (value?.blueprint?.id === blueprintId && value.conformanceCertificate) return value;
      } catch {
        // A malformed legacy object must not block the tenant's valid D1 license fallback.
      }
    }
  }
  const fork = await env.PLATFORM_DB.prepare(
    `SELECT f.artifact_json,f.certificate_json FROM marketplace_forks f
     JOIN marketplace_listings l ON l.id=f.listing_id
     WHERE f.tenant_id=? AND f.blueprint_id=? AND l.status='published' LIMIT 1`,
  ).bind(tenantId, blueprintId).first<{ artifact_json: string; certificate_json: string }>();
  if (!fork) return null;
  try {
    const blueprint = JSON.parse(fork.artifact_json) as SpaceBlueprint;
    const conformanceCertificate = JSON.parse(fork.certificate_json) as ConformanceCertificate;
    if (blueprint.id !== blueprintId) return null;
    return { blueprint, conformanceCertificate };
  } catch {
    return null;
  }
}

export function certifiedBlueprintKey(tenantId: string, blueprintId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tenantId) || tenantId.includes("..") ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(blueprintId) || blueprintId.includes("..")) {
    throw new Error("invalid_certified_blueprint_scope");
  }
  return `blueprints/${tenantId}/${blueprintId}.json`;
}
