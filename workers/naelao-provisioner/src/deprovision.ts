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

async function deleteAllR2Objects(bucket: R2Bucket, prefix: string): Promise<number> {
  let cursor: string | undefined;
  let total = 0;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length) {
      await bucket.delete(page.objects.map(o => o.key));
      total += page.objects.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return total;
}

function spaceDOStub(env: Env, spaceId: string) {
  return env.NAELAO_SPACE_DO.get(env.NAELAO_SPACE_DO.idFromName('space:' + spaceId));
}

export async function deprovisionSpace(spaceId: string, env: Env): Promise<void> {
  const stub = spaceDOStub(env, spaceId);

  // Step A: Mark space as deleted
  try {
    await stub.fetch(new Request('http://space/meta', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'deleted' }),
    }));
  } catch (e) {
    env.NAELAO_ANALYTICS.writeDataPoint({ blobs: ['deprovision_step_a_failed', spaceId, String(e)], doubles: [] });
  }

  // Step B: Delete all R2 objects (paginated)
  try {
    await deleteAllR2Objects(env.NAELAO_WORKSPACE, 'spaces/' + spaceId + '/');
    await deleteAllR2Objects(env.NAELAO_WORKFLOW_R2, 'spaces/' + spaceId + '/');
  } catch (e) {
    env.NAELAO_ANALYTICS.writeDataPoint({ blobs: ['deprovision_step_b_failed', spaceId, String(e)], doubles: [] });
  }

  // Step C: Delete Vectorize vectors for space (GDPR)
  try {
    const docsResp = await stub.fetch(new Request('http://space/knowledge/docs'));
    if (docsResp.ok) {
      const docsData = await docsResp.json<{ docs: Array<{ id: string; chunk_count?: number }> }>();
      const chunkIds: string[] = [];
      for (const doc of docsData.docs ?? []) {
        const count = doc.chunk_count ?? 10;
        for (let i = 0; i < count; i++) {
          chunkIds.push(doc.id + ':chunk:' + i);
        }
      }
      for (let i = 0; i < chunkIds.length; i += 1000) {
        await env.NAELAO_VECTORIZE.deleteByIds(chunkIds.slice(i, i + 1000));
      }
    }
  } catch (e) {
    env.NAELAO_ANALYTICS.writeDataPoint({ blobs: ['deprovision_step_c_failed', spaceId, String(e)], doubles: [] });
  }

  // Step D: Purge SpaceDO SQLite tables
  try {
    await stub.fetch(new Request('http://space/purge', { method: 'POST' }));
  } catch (e) {
    env.NAELAO_ANALYTICS.writeDataPoint({ blobs: ['deprovision_step_d_failed', spaceId, String(e)], doubles: [] });
  }

  // Step E: Clean KV entries
  try {
    const [creds, portal, manifests] = await Promise.all([
      env.NAELAO_CONFIG_KV.list({ prefix: 'cred:' + spaceId + ':' }),
      env.NAELAO_PORTAL_ROUTES.list({ prefix: 'slug:' }),
      env.NAELAO_CONFIG_KV.list({ prefix: 'space-type-manifest:' + spaceId + ':' }),
    ]);
    await Promise.all([
      ...creds.keys.map(k => env.NAELAO_CONFIG_KV.delete(k.name)),
      ...portal.keys.map(async k => {
        const v = await env.NAELAO_PORTAL_ROUTES.get(k.name);
        if (v === spaceId) await env.NAELAO_PORTAL_ROUTES.delete(k.name);
      }),
      ...manifests.keys.map(k => env.NAELAO_CONFIG_KV.delete(k.name)),
    ]);

    const hostEntries = await env.NAELAO_PORTAL_ROUTES.list({ prefix: 'host:' });
    await Promise.all(hostEntries.keys.map(async k => {
      const v = await env.NAELAO_PORTAL_ROUTES.get(k.name);
      if (v === spaceId) await env.NAELAO_PORTAL_ROUTES.delete(k.name);
    }));
  } catch (e) {
    env.NAELAO_ANALYTICS.writeDataPoint({ blobs: ['deprovision_step_e_failed', spaceId, String(e)], doubles: [] });
  }

  // Step F: Remove from SpaceTypeRegistryDO instances table
  try {
    await env.NAELAO_REGISTRY.fetch(new Request('https://placeholder/v1/registry/instances/' + spaceId, {
      method: 'DELETE',
    }));
  } catch (e) {
    env.NAELAO_ANALYTICS.writeDataPoint({ blobs: ['deprovision_step_f_failed', spaceId, String(e)], doubles: [] });
  }

  env.NAELAO_ANALYTICS.writeDataPoint({
    blobs: ['space_deprovisioned', spaceId],
    doubles: [],
  });
}
