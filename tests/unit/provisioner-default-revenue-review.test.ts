import { describe, it, expect } from "vitest";
import { seedDefaultRevenueReviewCron } from "../../workers/provisioner/src/index.js";
import type { Env } from "../../workers/provisioner/src/index.js";
import { LAUNCHPAD_ASSISTANT_PROFILE } from "../../workers/agents/src/script-engine/index.js";

// A Launchpad business created and left completely untouched previously got ZERO proactive
// assistant activity, ever: enqueueAgentTicks (workers/agents/src/index.ts) only fires for a
// space with a connected channel, a pollable connector, or an explicit scheduled_jobs row — and
// nothing auto-created one, so the assistant profile's own "REVENUE REVIEW — on your recurring
// wake-ups" instruction sat unused. seedDefaultRevenueReviewCron (provisioner Step 9b) closes
// that by seeding a default daily scheduled_jobs row, addressed at the Space Assistant.

function makeEnv(): { env: Env; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const spacesWorker = {
    async fetch(reqInput: Request | string, init?: RequestInit): Promise<Response> {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      const body = await req.clone().json().catch(() => null);
      calls.push({ url: req.url, body });
      return Response.json({ id: "job-1" }, { status: 201 });
    },
  };
  const env = {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: "test-secret",
    SPACES_WORKER: spacesWorker as unknown as Fetcher,
  } as unknown as Env;
  return { env, calls };
}

describe("seedDefaultRevenueReviewCron", () => {
  it("creates a daily scheduled_jobs row addressed at the Space Assistant", async () => {
    const { env, calls } = makeEnv();
    await seedDefaultRevenueReviewCron("space-1", "tenant-1", env);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/spaces/space-1/scheduled-jobs");
    const body = calls[0]!.body as { name: string; cron_expression: string; agent_id: string; goal: string };
    expect(body.agent_id).toBe(LAUNCHPAD_ASSISTANT_PROFILE.agentId);
    expect(body.cron_expression).toBe("0 13 * * *");
    expect(body.goal).toContain("revenue review");
    expect(body.goal).toContain("project journal");
    expect(body.name.toLowerCase()).toContain("revenue review");
  });

  // A model reproduces the wording it is handed. The first version of this goal said "message the
  // owner (via the notifications prebuilt)" and a live run copied that phrase verbatim as a script
  // name, which killed the job outright — the `notifications` prebuilt exposes ops prefixed
  // `notify.`, so the phrase resolves to nothing. Any tool a seeded goal names must be a name the
  // agent can actually run.
  it("names a real operation, never a prebuilt's descriptive phrase", async () => {
    const { env, calls } = makeEnv();
    await seedDefaultRevenueReviewCron("space-1", "tenant-1", env);

    const goal = (calls[0]!.body as { goal: string }).goal;
    expect(goal).toContain("notify.email");
    expect(goal.toLowerCase()).not.toContain("prebuilt");
  });

  it("is best-effort — a failed request never throws", async () => {
    const spacesWorker = { async fetch() { return new Response("boom", { status: 500 }); } };
    const env = { ENVIRONMENT: "test", PLATFORM_SECRET: "test-secret", SPACES_WORKER: spacesWorker as unknown as Fetcher } as unknown as Env;
    await expect(seedDefaultRevenueReviewCron("space-2", "tenant-1", env)).resolves.toBeUndefined();
  });

  it("is best-effort — a thrown fetch never propagates", async () => {
    const spacesWorker = { async fetch() { throw new Error("network down"); } };
    const env = { ENVIRONMENT: "test", PLATFORM_SECRET: "test-secret", SPACES_WORKER: spacesWorker as unknown as Fetcher } as unknown as Env;
    await expect(seedDefaultRevenueReviewCron("space-3", "tenant-1", env)).resolves.toBeUndefined();
  });
});
