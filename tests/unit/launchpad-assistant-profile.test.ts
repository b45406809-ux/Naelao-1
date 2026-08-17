import { describe, it, expect } from "vitest";
import { installLaunchpadAgents, seedLaunchpadAssistantPolicy } from "../../workers/provisioner/src/index.js";
import type { Env } from "../../workers/provisioner/src/index.js";
import type { NaelaoSpaceTypeManifestV2 } from "../../workers/spaces/src/do/SpaceTypeRegistryDO.js";
import { LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED } from "../../workers/agents/src/script-engine/profiles.js";
import { verifyInternalToken } from "@naelao/http";

// §A1.17 Phase G, revised per explicit user direction: the Launchpad Space Assistant is a
// business-builder profile, not the generic DEFAULT_NAELAO_AGENT — installLaunchpadAgents
// (provisioner step 9) writes LAUNCHPAD_ASSISTANT_PROFILE's richer agents.md/system-prompt/
// prebuilt set under the SAME agentId ("naelao-agent") every dispatcher already hardcodes, and
// seeds a FULLY AUTONOMOUS ("yolo") default assistant_policy — the assistant acts on the owner's
// behalf without asking permission for every step, the read-only allowlist is stored anyway so a
// business that later dials autonomy down to `gate_unless_listed` lands on sensible defaults. The
// owner can flip a space to any of the four approval modes any time via the existing
// PATCH /assistant-policy endpoint — no new gate engine, no new field on this profile.

function makeR2(): R2Bucket {
  const store = new Map<string, string>();
  const bucket = {
    async put(key: string, value: unknown) {
      store.set(key, typeof value === "string" ? value : String(value));
      return {} as R2Object;
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const text = store.get(key)!;
      return { size: text.length, uploaded: new Date(), async text() { return text; } } as unknown as R2ObjectBody;
    },
  };
  return bucket as unknown as R2Bucket;
}

function makeEnv(): { env: Env; calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
  const spacesWorker = {
    async fetch(reqInput: Request | string, init?: RequestInit): Promise<Response> {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      const body = await req.clone().json().catch(() => null);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      calls.push({ url: req.url, method: req.method, body, headers });
      if (req.url.endsWith("/scheduled-jobs")) return Response.json({ id: "job-1" }, { status: 201 });
      return Response.json({ ok: true }, { status: 200 });
    },
  };
  const env = {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: "test-secret",
    PLATFORM_DB: {} as unknown as D1Database,
    SPACES_KV: {} as unknown as KVNamespace,
    SPACES_WORKER: spacesWorker as unknown as Fetcher,
    SCRIPTS_R2: makeR2(),
  } as unknown as Env;
  return { env, calls };
}

const MANIFEST = { productConfig: {} } as unknown as NaelaoSpaceTypeManifestV2;

describe("seedLaunchpadAssistantPolicy", () => {
  it("PATCHes assistant-policy with the autonomous (yolo) default via a verified internal token", async () => {
    const { env, calls } = makeEnv();
    const seeded = await seedLaunchpadAssistantPolicy("space-1", "tenant-1", env);
    expect(seeded).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toBe("http://spaces-worker/spaces/space-1/assistant-policy");
    expect(calls[0]!.body).toEqual({ approval_mode: "yolo", auto_approved_actions: LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED });
    const token = calls[0]!.headers["x-naelao-internal-token"];
    expect(await verifyInternalToken(token, "tenant-1", "test-secret")).toBe(true);
  });

  it("returns false (not a throw) when the spaces worker rejects the call", async () => {
    const env = {
      ENVIRONMENT: "test",
      PLATFORM_SECRET: "test-secret",
      SPACES_WORKER: { async fetch() { return new Response("nope", { status: 500 }); } },
    } as unknown as Env;
    const seeded = await seedLaunchpadAssistantPolicy("space-1", "tenant-1", env);
    expect(seeded).toBe(false);
  });
});

describe("installLaunchpadAgents — Space Assistant profile", () => {
  it("writes the business-builder profile (not the generic assistant) under agentId naelao-agent", async () => {
    const { env, calls } = makeEnv();
    await installLaunchpadAgents("space-1", "tenant-1", undefined, MANIFEST, env);

    const written = await env.SCRIPTS_R2.get("spaces/space-1/agents/naelao-agent/system-prompt.md");
    expect(written).toBeTruthy();
    const promptText = await written!.text();
    expect(promptText).toContain("business-builder");
    expect(promptText.toLowerCase()).toContain("whop");

    const scriptsJson = await env.SCRIPTS_R2.get("spaces/space-1/agents/naelao-agent/scripts.json");
    const scripts = JSON.parse(await scriptsJson!.text()) as { prebuilt: string[] };
    expect(scripts.prebuilt).toContain("workspace-admin");
    expect(scripts.prebuilt).toContain("commerce");
  });

  it("also seeds the autonomous (yolo) assistant_policy default as part of installation", async () => {
    const { env, calls } = makeEnv();
    await installLaunchpadAgents("space-1", "tenant-1", undefined, MANIFEST, env);
    const policyCall = calls.find((c) => c.url.endsWith("/assistant-policy"));
    expect(policyCall).toBeTruthy();
    expect(policyCall!.body).toMatchObject({ approval_mode: "yolo" });
  });
});
