interface Env {
  NAELAO_SPACE_DO: DurableObjectNamespace;
  NAELAO_VECTORIZE: VectorizeIndex;
  NAELAO_WORKFLOW_R2: R2Bucket;
  NAELAO_WORKSPACE: R2Bucket;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_CIRCUIT_KV: KVNamespace;
  NAELAO_PORTAL_ROUTES: KVNamespace;
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
  NAELAO_REGISTRY: Fetcher;
}

function spaceDOStub(env: Env, spaceId: string) {
  return env.NAELAO_SPACE_DO.get(env.NAELAO_SPACE_DO.idFromName('space:' + spaceId));
}

export async function provisionSpaceType(
  spaceId: string,
  typeId: string,
  version: string,
  env: Env
): Promise<void> {
  const stub = spaceDOStub(env, spaceId);

  // Step A: Verify space exists and is active
  const metaResp = await stub.fetch(new Request('http://space/meta'));
  if (!metaResp.ok) throw new Error('space_not_found: ' + spaceId);
  const metaData = await metaResp.json<{ status?: string }>();
  if (metaData.status === 'deleted' || metaData.status === 'suspended') {
    throw new Error('space_not_active: ' + spaceId);
  }

  // Step B: Fetch space type manifest from registry
  const manifestResp = await env.NAELAO_REGISTRY.fetch(
    new Request('https://placeholder/v1/registry/space-types/' + typeId)
  );
  if (!manifestResp.ok) throw new Error('manifest_not_found: ' + typeId);
  const manifestData = await manifestResp.json<{ data: { manifest?: string } }>();
  const manifest = manifestData.data?.manifest;

  // Step C: Copy space type assets from R2 to space-specific paths
  if (manifest) {
    let parsed: { assets?: string[] } = {};
    try { parsed = JSON.parse(manifest); } catch { /* no assets */ }
    for (const assetKey of parsed.assets ?? []) {
      const src = await env.NAELAO_WORKSPACE.get('space-types/' + typeId + '/' + assetKey);
      if (src) {
        await env.NAELAO_WORKSPACE.put(
          'spaces/' + spaceId + '/assets/' + assetKey,
          await src.arrayBuffer()
        );
      }
    }
  }

  // Step D: Initialize space type DB tables in SpaceDO
  await stub.fetch(new Request('http://space/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ typeId, version }),
  }));

  // Step E: Register instance in SpaceTypeRegistryDO
  const registerResp = await env.NAELAO_REGISTRY.fetch(
    new Request('https://placeholder/v1/registry/instances/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spaceId, typeId, version }),
    })
  );
  if (!registerResp.ok) {
    env.NAELAO_ANALYTICS.writeDataPoint({
      blobs: ['provision_instance_register_failed', spaceId, typeId],
      doubles: [],
    });
  }

  // Step F: If portal space type, write portal route
  if (manifest) {
    let parsed: { isPortal?: boolean; slug?: string } = {};
    try { parsed = JSON.parse(manifest); } catch { /* skip */ }
    if (parsed.isPortal && parsed.slug) {
      await env.NAELAO_PORTAL_ROUTES.put('slug:' + parsed.slug, spaceId, { expirationTtl: 0 });
    }
  }

  env.NAELAO_ANALYTICS.writeDataPoint({
    blobs: ['space_type_provisioned', spaceId, typeId, version],
    doubles: [],
  });
}
