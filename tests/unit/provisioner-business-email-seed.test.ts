import { describe, it, expect } from "vitest";
import { seedBusinessEmail } from "../../workers/provisioner/src/index.js";
import type { Env } from "../../workers/provisioner/src/index.js";

// Auto-provision a real, inbound-capable AgentMail mailbox at creation time (like the wallet) —
// best-effort, degrades to a no-op when AGENTS_WORKER is unbound or AGENTMAIL_API_KEY isn't
// configured. A mail-seed failure must NEVER turn a successful space creation into a failed one.

describe("seedBusinessEmail (provisioner)", () => {
  it("is a no-op (no call) when AGENTS_WORKER is unbound", async () => {
    const env = { ENVIRONMENT: "test", PLATFORM_SECRET: "s" } as unknown as Env;
    await expect(seedBusinessEmail("space-1", "tenant-1", "My Shop", env)).resolves.toBeUndefined();
  });

  it("posts to /internal/business-email/provision with the space name as the slug", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const agentsWorker = {
      async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
        const req = typeof input === "string" ? new Request(input, init) : input;
        calls.push({ url: req.url, body: await req.clone().json().catch(() => null) });
        return Response.json({ ok: true, configured: true, email: "my-shop@agentmail.to" });
      },
    };
    const env = { ENVIRONMENT: "test", PLATFORM_SECRET: "s", AGENTS_WORKER: agentsWorker as unknown as Fetcher } as unknown as Env;
    await seedBusinessEmail("space-1", "tenant-1", "My Shop", env);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/internal/business-email/provision");
    const body = calls[0]!.body as { spaceId: string; tenantId: string; slug: string };
    expect(body).toMatchObject({ spaceId: "space-1", tenantId: "tenant-1", slug: "My Shop" });
  });

  it("is best-effort — a non-OK response never throws", async () => {
    const agentsWorker = { async fetch() { return new Response("nope", { status: 502 }); } };
    const env = { ENVIRONMENT: "test", PLATFORM_SECRET: "s", AGENTS_WORKER: agentsWorker as unknown as Fetcher } as unknown as Env;
    await expect(seedBusinessEmail("space-2", "tenant-1", "X", env)).resolves.toBeUndefined();
  });

  it("is best-effort — a thrown fetch never propagates", async () => {
    const agentsWorker = { async fetch() { throw new Error("down"); } };
    const env = { ENVIRONMENT: "test", PLATFORM_SECRET: "s", AGENTS_WORKER: agentsWorker as unknown as Fetcher } as unknown as Env;
    await expect(seedBusinessEmail("space-3", "tenant-1", "X", env)).resolves.toBeUndefined();
  });
});
