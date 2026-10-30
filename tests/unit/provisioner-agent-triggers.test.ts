import { describe, it, expect } from "vitest";
import { installLaunchpadAgents } from "../../workers/provisioner/src/index.js";
import type { Env } from "../../workers/provisioner/src/index.js";
import type { NaelaoSpaceTypeManifestV2 } from "../../workers/spaces/src/do/SpaceTypeRegistryDO.js";
import { DEFAULT_NAELAO_AGENT } from "../../workers/agents/src/script-engine/profiles.js";

function makeR2(): R2Bucket {
  const store = new Map<string, { text: string; etag: string }>();
  let revision = 0;
  return {
    async put(key: string, value: unknown) {
      const etag = `test-${++revision}`;
      store.set(key, { text: typeof value === "string" ? value : new TextDecoder().decode(value as ArrayBuffer), etag });
      return { etag } as R2Object;
    },
    async get(key: string) {
      const value = store.get(key);
      return value ? { size: value.text.length, etag: value.etag, uploaded: new Date(), async text() { return value.text; } } as unknown as R2ObjectBody : null;
    },
    async head(key: string) {
      const value = store.get(key);
      return value ? { size: value.text.length, etag: value.etag } as R2Object : null;
    },
  } as unknown as R2Bucket;
}

function makeEnv(): { env: Env; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const spacesWorker = {
    async fetch(reqInput: Request | string, init?: RequestInit): Promise<Response> {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      calls.push({ url: req.url, body: await req.clone().json().catch(() => null) });
      return Response.json({ ok: true, id: "record-1" }, { status: 201 });
    },
  };
  const agentsWorker = { async fetch() { return Response.json({ granted: true, active: 1, limit: 1, fencingToken: 1 }); } };
  return {
    env: {
      ENVIRONMENT: "test", PLATFORM_SECRET: "test-secret", PLATFORM_DB: {} as D1Database,
      SPACES_KV: {} as KVNamespace, SPACES_WORKER: spacesWorker as unknown as Fetcher,
      AGENTS_WORKER: agentsWorker as unknown as Fetcher, SCRIPTS_R2: makeR2(),
    } as unknown as Env,
    calls,
  };
}

const MANIFEST = { productConfig: {} } as unknown as NaelaoSpaceTypeManifestV2;

describe("installLaunchpadAgents (generic Space assistant provisioning)", () => {
  it("registers one generic Naelao assistant, regardless of retired template ids", async () => {
    const { env, calls } = makeEnv();
    await installLaunchpadAgents("space-1", "tenant-1", ["creator-store", "newsletter-business"], MANIFEST, env);

    const agentDefCalls = calls.filter((call) => call.url.endsWith("/agent-definitions"));
    expect(agentDefCalls).toHaveLength(1);
    expect((agentDefCalls[0]!.body as { config: { agent_id: string } }).config.agent_id).toBe(DEFAULT_NAELAO_AGENT.agentId);
    expect(calls.filter((call) => call.url.endsWith("/scheduled-jobs"))).toHaveLength(0);
  });

  it("fails closed when the shared agent configuration lock is unavailable", async () => {
    const { env } = makeEnv();
    delete (env as Partial<Env>).AGENTS_WORKER;
    await expect(installLaunchpadAgents("space-2", "tenant-1", undefined, MANIFEST, env))
      .rejects.toThrow("agent_config_lock_unavailable");
  });
});
