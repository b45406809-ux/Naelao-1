# Prompt: workers/naelao-provisioner/src/ (2 files)

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite. Service Bindings for Worker comms. Hono for routing. JWT auth. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes /v1/. compatibility_date: 2025-01-01.

Generate TWO files for workers/naelao-provisioner/src/.

Env:
  NAELAO_SPACE_DO: DurableObjectNamespace
  NAELAO_VECTORIZE: VectorizeIndex
  NAELAO_WORKFLOW_R2: R2Bucket
  NAELAO_WORKSPACE: R2Bucket
  NAELAO_CONFIG_KV: KVNamespace
  NAELAO_PORTAL_ROUTES: KVNamespace  (G-F10 fix: separate KV for portal routes)
  NAELAO_ANALYTICS: AnalyticsEngineDataset
  NAELAO_REGISTRY: Service  (Service Binding to naelao-registry)

=== File 1: src/provision.ts ===

Provisions a space type (installs a Space Type into a space).

  export async function provisionSpaceType(spaceId: string, typeId: string, version: string, env: Env): Promise<void>
  
  Steps:
  Step A: Verify space exists and is active via SpaceDO /meta
  Step B: Fetch space type manifest from registry via NAELAO_REGISTRY Service Binding
  Step C: Copy space type assets from R2 to space-specific paths
  Step D: Initialize space type DB tables in SpaceDO (call SpaceDO /init with typeId)
  Step E: Register instance in SpaceTypeRegistryDO via NAELAO_REGISTRY
  Step F: If portal space type: write portal route to NAELAO_PORTAL_ROUTES KV (G-F10 fix)

  Each step is idempotent - can be retried safely.
  On failure: update space status to 'provisioning_failed' in SpaceDO.

=== File 2: src/deprovision.ts ===

Deprovisions a space (space deletion cleanup).

CRITICAL: Must clean ALL data stores, including Vectorize (GDPR compliance G-G22 fix).

  export async function deprovisionSpace(spaceId: string, env: Env): Promise<void>
  
  Steps:
  Step A: Mark space as 'deleted' in SpaceDO
  Step B: Delete all R2 objects for space (PAGINATED - G-E08 fix):
    async function deleteAllR2Objects(bucket: R2Bucket, prefix: string): Promise<number>
      let cursor: string | undefined;
      let total = 0;
      do {
        const page = await bucket.list({ prefix, cursor, limit: 1000 });
        if (page.objects.length) { await bucket.delete(page.objects.map(o => o.key)); total += page.objects.length; }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return total;
  
  Step C: Delete Vectorize vectors for space (GDPR fix G-G22):
    - Query SpaceDO for all knowledge doc IDs
    - Build chunk IDs: docId + ':chunk:' + i for i in 0..chunkCount
    - vectorize.deleteByIds(ids) in batches of 1000

  Step D: Call SpaceDO /purge (cascades all SQLite tables)

  Step E: Clean KV entries:
    - Delete all 'cred:spaceId:*' entries
    - Delete portal routes from NAELAO_PORTAL_ROUTES
    - Delete 'space-type-manifest:spaceId:*' entries

  Step F: Remove from SpaceTypeRegistryDO instances table

  Each step in try/catch, log failures to Analytics but continue cleanup.

