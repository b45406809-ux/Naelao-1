import { describe, it, expect } from "vitest";
import { installLaunchpadAgents } from "../../workers/provisioner/src/index.js";
import type { Env } from "../../workers/provisioner/src/index.js";
import type { NaelaoSpaceTypeManifestV2 } from "../../workers/spaces/src/do/SpaceTypeRegistryDO.js";

// F: LaunchpadAgentDefinition.trigger (spec §11) was installed as data by the provisioner but
// nothing ever read it — every dispatcher hardcoded "naelao-agent", so e.g. the Content agent's
// `cron: "0 9 * * *"` schedule never actually ran the specialist. installAgentTrigger (called
// from installLaunchpadAgents, provisioner step 9) closes this for schedule-type triggers by
// writing a real scheduled_jobs row (agent_id + goal, migration 0043) so the dispatcher
// (workers/agents/src/index.ts handleAgentTick) wakes the specialist's own full reasoning loop
// on its cron. webhook-type triggers (fulfillment's "order.completed", support's
// "message.received") are deliberately NOT translated into a scheduled_jobs OR event_triggers
// row here — see the doc comment on installAgentTrigger for why (event_triggers only fires on
// structural in-space events; billing/lemon-squeezy.ts resolves fulfillment routing directly).

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

function makeEnv(): { env: Env; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const spacesWorker = {
    async fetch(reqInput: Request | string, init?: RequestInit): Promise<Response> {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      const body = await req.clone().json().catch(() => null);
      calls.push({ url: req.url, body });
      if (req.url.endsWith("/scheduled-jobs")) {
        return Response.json({ id: "job-1", name: (body as { name: string }).name }, { status: 201 });
      }
      return Response.json({ ok: true }, { status: 201 });
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

describe("installLaunchpadAgents / installAgentTrigger (provisioner step 9 trigger wiring)", () => {
  it("creates a scheduled_jobs row for the Content agent's cron, addressed at its own agent_id", async () => {
    const { env, calls } = makeEnv();
    await installLaunchpadAgents("space-1", "tenant-1", "newsletter-business", MANIFEST, env);

    const jobCalls = calls.filter((c) => c.url.endsWith("/scheduled-jobs"));
    expect(jobCalls).toHaveLength(1);
    const body = jobCalls[0]!.body as { cron_expression: string; agent_id: string; goal: string; name: string };
    expect(body.cron_expression).toBe("0 9 * * *");
    expect(body.agent_id).toBe("launchpad-content-v1");
    expect(body.goal).toContain("script.find");
    expect(body.name).toContain("Content");
  });

  it("does NOT create any scheduled_jobs row for webhook-type triggers (fulfillment/support)", async () => {
    const { env, calls } = makeEnv();
    // creator-store installs launchpad-fulfillment-v1 (webhook) + launchpad-support-v1 (webhook),
    // no schedule-type agent at all.
    await installLaunchpadAgents("space-2", "tenant-1", "creator-store", MANIFEST, env);

    const jobCalls = calls.filter((c) => c.url.endsWith("/scheduled-jobs"));
    expect(jobCalls).toHaveLength(0);
  });

  it("still registers the agent-definitions index entries alongside the trigger wiring", async () => {
    const { env, calls } = makeEnv();
    await installLaunchpadAgents("space-3", "tenant-1", "newsletter-business", MANIFEST, env);

    const agentDefCalls = calls.filter((c) => c.url.endsWith("/agent-definitions"));
    // Default Naelao Agent + launchpad-content-v1 + launchpad-fulfillment-v1
    expect(agentDefCalls.length).toBeGreaterThanOrEqual(3);
  });

  it("a failed scheduled-jobs install is best-effort — does not throw and does not block the rest of the install", async () => {
    const spacesWorker = {
      async fetch(reqInput: Request | string, init?: RequestInit): Promise<Response> {
        const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
        if (req.url.endsWith("/scheduled-jobs")) return new Response("boom", { status: 500 });
        return Response.json({ ok: true }, { status: 201 });
      },
    };
    const env = {
      ENVIRONMENT: "test",
      PLATFORM_SECRET: "test-secret",
      SPACES_WORKER: spacesWorker as unknown as Fetcher,
      SCRIPTS_R2: makeR2(),
    } as unknown as Env;

    await expect(installLaunchpadAgents("space-4", "tenant-1", "newsletter-business", MANIFEST, env)).resolves.toBeUndefined();
  });

  it("wires a scheduled job for every schedule-triggered core agent when no templateId is given", async () => {
    // No template means "install everything", so every core agent carrying a schedule trigger
    // gets its cron — today the daily content run and the weekday lead-generation run. A space
    // built from a specific template only installs THAT template's agents, so a space which is
    // not a web studio never picks up the prospecting cron.
    const { env, calls } = makeEnv();
    await installLaunchpadAgents("space-5", "tenant-1", undefined, MANIFEST, env);
    const jobCalls = calls.filter((c) => c.url.endsWith("/scheduled-jobs"));
    const agentIds = jobCalls.map((c) => (c.body as { agent_id: string }).agent_id).sort();
    expect(agentIds).toEqual(["launchpad-content-v1", "launchpad-leadgen-v1"]);
  });

  it("a web-studio space gets the lead-generation cron and nothing it does not need", async () => {
    const { env, calls } = makeEnv();
    await installLaunchpadAgents("space-6", "tenant-1", "whop-webdev-agency", MANIFEST, env);
    const jobCalls = calls.filter((c) => c.url.endsWith("/scheduled-jobs"));
    const agentIds = jobCalls.map((c) => (c.body as { agent_id: string }).agent_id);
    expect(agentIds).toEqual(["launchpad-leadgen-v1"]);
  });

  // Phase C (§A1.17): a business built from MULTIPLE templates — installLaunchpadAgents now
  // accepts a template id array and installs the deduped union (creator-store +
  // newsletter-business both install launchpad-fulfillment-v1; it must register only once).
  it("accepts an array of template ids and installs the deduped union of their agents", async () => {
    const { env, calls } = makeEnv();
    await installLaunchpadAgents("space-6", "tenant-1", ["creator-store", "newsletter-business"], MANIFEST, env);

    const agentDefCalls = calls.filter((c) => c.url.endsWith("/agent-definitions"));
    const agentIds = agentDefCalls.map((c) => (c.body as { config: { agent_id: string } }).config.agent_id);
    // Default Naelao Agent + fulfillment + support (creator-store) + content (newsletter) — no dupes.
    expect(new Set(agentIds).size).toBe(agentIds.length);
    expect(agentIds).toContain("launchpad-fulfillment-v1");
    expect(agentIds).toContain("launchpad-support-v1");
    expect(agentIds).toContain("launchpad-content-v1");

    // Content's schedule trigger still wires even though it came from the second template.
    const jobCalls = calls.filter((c) => c.url.endsWith("/scheduled-jobs"));
    expect(jobCalls).toHaveLength(1);
    expect((jobCalls[0]!.body as { agent_id: string }).agent_id).toBe("launchpad-content-v1");
  });
});
