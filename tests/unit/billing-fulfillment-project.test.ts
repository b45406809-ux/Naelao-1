import { describe, it, expect, vi } from "vitest";
import { handleLemonSqueezyWebhook, resolveFulfillmentProjectId, isFulfillmentAgentBound } from "../../workers/billing/src/lemon-squeezy.js";
import type { LemonSqueezyEnv } from "../../workers/billing/src/lemon-squeezy.js";
import { mintInternalToken } from "@naelao/http";

// Continuation of the audit: the Space Assistant CAN handle a billing event generally, or even
// create a project for it itself — but the prebuilt Launchpad templates that install
// launchpad-fulfillment-v1 (creator-store, newsletter-business, micro-saas) now seed a
// dedicated "Orders" project via bootstrap.projects (launchpad/spacetype.ts). When one exists,
// billing scopes the wake to that project (its own approval gates/execution ceiling apply,
// workspace-scoped R2). When it doesn't (never seeded, renamed, or archived by the builder), the
// Space Assistant runs space-wide exactly as before — never a hard dependency.

const PLATFORM_SECRET = "test-platform-secret";
const WEBHOOK_SECRET = "test-ls-webhook-secret";

async function signBody(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function makeOrderPaidBody(spaceId: string): string {
  return JSON.stringify({
    meta: { event_name: "order_created", custom_data: { spaceId } },
    data: { id: "ord_1", attributes: { total: 1999, currency: "USD", customer_id: "cust_1", custom_data: { spaceId } } },
  });
}

function makeSubscriptionUpdatedBody(spaceId: string): string {
  return JSON.stringify({
    meta: { event_name: "subscription_updated", custom_data: { spaceId } },
    data: { id: "sub_1", attributes: { total: 1999, currency: "USD", customer_id: "cust_1", custom_data: { spaceId } } },
  });
}

describe("resolveFulfillmentProjectId", () => {
  function makeEnv(projects: Array<{ id: string; name: string; status?: string; default_agent_id?: string | null }> | null): LemonSqueezyEnv {
    return {
      AGENTS_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher,
      PLATFORM_DB: {} as unknown as D1Database,
      PLATFORM_SECRET,
      SPACES_WORKER: {
        async fetch() {
          if (projects === null) return new Response("error", { status: 500 });
          return Response.json({ data: projects, count: projects.length });
        },
      } as unknown as Fetcher,
    };
  }

  it("resolves a project bound to the fulfillment agent, even with an unrelated name", async () => {
    // Mirrors newsletter-business/micro-saas seeding "Orders" via default_agent_id rather than
    // relying on the literal name — and proves a builder can rename the project (e.g. to
    // "Billing") without breaking the routing, since the binding is what's authoritative.
    const id = await resolveFulfillmentProjectId(
      "space1", "tenant1",
      makeEnv([
        { id: "p1", name: "Products" },
        { id: "p2", name: "Billing", default_agent_id: "launchpad-fulfillment-v1" },
        { id: "p3", name: "Support", default_agent_id: "launchpad-support-v1" },
      ])
    );
    expect(id).toBe("p2");
  });

  it("prefers the default_agent_id binding over a same-named-but-unbound project", async () => {
    const id = await resolveFulfillmentProjectId(
      "space1", "tenant1",
      makeEnv([
        { id: "unbound-orders", name: "Orders" },
        { id: "bound-elsewhere", name: "Fulfillment", default_agent_id: "launchpad-fulfillment-v1" },
      ])
    );
    expect(id).toBe("bound-elsewhere");
  });

  it("falls back to a project literally named Orders when nothing is bound (case/whitespace-insensitive)", async () => {
    const id = await resolveFulfillmentProjectId(
      "space1", "tenant1",
      makeEnv([{ id: "p1", name: "Products" }, { id: "p2", name: "  orders " }, { id: "p3", name: "Support" }])
    );
    expect(id).toBe("p2");
  });

  it("ignores an archived project even if it's bound to the fulfillment agent", async () => {
    const id = await resolveFulfillmentProjectId(
      "space1", "tenant1",
      makeEnv([{ id: "p2", name: "Orders", default_agent_id: "launchpad-fulfillment-v1", status: "archived" }])
    );
    expect(id).toBeUndefined();
  });

  it("returns undefined when there is no Orders project", async () => {
    const id = await resolveFulfillmentProjectId("space1", "tenant1", makeEnv([{ id: "p1", name: "Products" }]));
    expect(id).toBeUndefined();
  });

  it("ignores an archived Orders project", async () => {
    const id = await resolveFulfillmentProjectId(
      "space1", "tenant1", makeEnv([{ id: "p2", name: "Orders", status: "archived" }])
    );
    expect(id).toBeUndefined();
  });

  it("fails soft (undefined, never throws) when SPACES_WORKER errors", async () => {
    const id = await resolveFulfillmentProjectId("space1", "tenant1", makeEnv(null));
    expect(id).toBeUndefined();
  });

  it("fails soft when SPACES_WORKER is not bound", async () => {
    const env: LemonSqueezyEnv = {
      AGENTS_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher,
      PLATFORM_DB: {} as unknown as D1Database,
      PLATFORM_SECRET,
    };
    const id = await resolveFulfillmentProjectId("space1", "tenant1", env);
    expect(id).toBeUndefined();
  });
});

describe("handleLemonSqueezyWebhook — scopes the wake to the Orders project when one exists", () => {
  function makeDb(spaceId: string, tenantId: string) {
    return {
      prepare(sql: string) {
        const stmt = {
          bind() { return stmt; },
          async first() {
            if (/FROM spaces WHERE/.test(sql)) return { tenant_id: tenantId };
            if (/FROM tenant_hierarchy/.test(sql)) return null;
            return null;
          },
          async run() { return { meta: { changes: 1 } }; },
        };
        return stmt;
      },
    } as unknown as D1Database;
  }

  it("passes projectId through to the agents worker when an Orders project exists", async () => {
    const spaceId = "space1";
    const tenantId = "tenant1";
    const agentsFetch = vi.fn(async (req: Request) => {
      const body = await req.json() as { projectId?: string };
      expect(body.projectId).toBe("orders-proj");
      return new Response("{}");
    });
    const env: LemonSqueezyEnv = {
      LEMON_SQUEEZY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PLATFORM_SECRET,
      PLATFORM_DB: makeDb(spaceId, tenantId),
      AGENTS_WORKER: { fetch: agentsFetch } as unknown as Fetcher,
      SPACES_WORKER: {
        async fetch() {
          return Response.json({ data: [{ id: "orders-proj", name: "Orders" }], count: 1 });
        },
      } as unknown as Fetcher,
    };

    const raw = makeOrderPaidBody(spaceId);
    const res = await handleLemonSqueezyWebhook(
      new Request("https://billing.naelao.com/webhooks/lemon-squeezy", {
        method: "POST",
        headers: { "X-Signature": await signBody(raw) },
        body: raw,
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(agentsFetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to a space-wide run (no projectId) when there is no Orders project", async () => {
    const spaceId = "space1";
    const tenantId = "tenant1";
    const agentsFetch = vi.fn(async (req: Request) => {
      const body = await req.json() as { projectId?: string };
      expect(body.projectId).toBeUndefined();
      return new Response("{}");
    });
    const env: LemonSqueezyEnv = {
      LEMON_SQUEEZY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PLATFORM_SECRET,
      PLATFORM_DB: makeDb(spaceId, tenantId),
      AGENTS_WORKER: { fetch: agentsFetch } as unknown as Fetcher,
      SPACES_WORKER: {
        async fetch() { return Response.json({ data: [], count: 0 }); },
      } as unknown as Fetcher,
    };

    const raw = makeOrderPaidBody(spaceId);
    const res = await handleLemonSqueezyWebhook(
      new Request("https://billing.naelao.com/webhooks/lemon-squeezy", {
        method: "POST",
        headers: { "X-Signature": await signBody(raw) },
        body: raw,
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(agentsFetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to a space-wide run when SPACES_WORKER is not bound at all", async () => {
    const spaceId = "space1";
    const tenantId = "tenant1";
    const agentsFetch = vi.fn(async (req: Request) => {
      const body = await req.json() as { projectId?: string };
      expect(body.projectId).toBeUndefined();
      return new Response("{}");
    });
    const env: LemonSqueezyEnv = {
      LEMON_SQUEEZY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PLATFORM_SECRET,
      PLATFORM_DB: makeDb(spaceId, tenantId),
      AGENTS_WORKER: { fetch: agentsFetch } as unknown as Fetcher,
    };

    const raw = makeOrderPaidBody(spaceId);
    const res = await handleLemonSqueezyWebhook(
      new Request("https://billing.naelao.com/webhooks/lemon-squeezy", {
        method: "POST",
        headers: { "X-Signature": await signBody(raw) },
        body: raw,
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(agentsFetch).toHaveBeenCalledTimes(1);
  });
});

describe("handleLemonSqueezyWebhook — accounting survives an inactive space", () => {
  it("does not acknowledge an active paid order as complete when the Agents binding is missing", async () => {
    const writes: string[] = [];
    const db = {
      prepare(sql: string) {
        const stmt = {
          bind() { return stmt; },
          async first() {
            if (/FROM spaces WHERE id = \?/.test(sql)) return { tenant_id: "tenant-1" };
            if (/FROM tenant_hierarchy/.test(sql)) return null;
            return null;
          },
          async run() { writes.push(sql); return { meta: { changes: 1 } }; },
        };
        return stmt;
      },
    };
    const raw = makeOrderPaidBody("space-1");
    const response = await handleLemonSqueezyWebhook(new Request("https://billing.naelao.com/webhooks/lemon-squeezy", {
      method: "POST", headers: { "X-Signature": await signBody(raw) }, body: raw,
    }), {
      LEMON_SQUEEZY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PLATFORM_SECRET,
      PLATFORM_DB: db as unknown as D1Database,
      SPACES_WORKER: { fetch: async () => Response.json({ project_id: null }) } as unknown as Fetcher,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "agent_delivery_unavailable" });
    expect(writes.some((sql) => sql.includes("DELETE FROM processed_webhook_events"))).toBe(true);
  });

  it("records a paid order before skipping the inactive space's agent", async () => {
    const writes: string[] = [];
    const db = {
      prepare(sql: string) {
        const stmt = {
          bind() { return stmt; },
          async first() {
            if (sql.includes("FROM spaces WHERE id = ? AND status = 'active'")) return null;
            if (/FROM spaces WHERE id = \?/.test(sql)) return { tenant_id: "tenant-1" };
            return null;
          },
          async run() { writes.push(sql); return { meta: { changes: 1 } }; },
        };
        return stmt;
      },
    };
    const agentsFetch = vi.fn(async () => new Response("{}"));
    const env: LemonSqueezyEnv = {
      LEMON_SQUEEZY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PLATFORM_SECRET,
      PLATFORM_DB: db as unknown as D1Database,
      AGENTS_WORKER: { fetch: agentsFetch } as unknown as Fetcher,
      SPACES_WORKER: { fetch: async () => Response.json({ project_id: null }) } as unknown as Fetcher,
    };
    const raw = JSON.stringify({
      meta: { event_name: "order_created", custom_data: { spaceId: "space-inactive", product_id: "product-1" } },
      data: { id: "order-inactive", attributes: { total: 5000, currency: "USD", customer_id: "customer-1", custom_data: { spaceId: "space-inactive", product_id: "product-1" } } },
    });
    const response = await handleLemonSqueezyWebhook(new Request("https://billing.naelao.com/webhooks/lemon-squeezy", {
      method: "POST", headers: { "X-Signature": await signBody(raw) }, body: raw,
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ agent_skipped: true, space_id: "space-inactive" });
    expect(writes.some((sql) => sql.includes("INSERT OR IGNORE INTO launchpad_orders"))).toBe(true);
    expect(agentsFetch).not.toHaveBeenCalled();
  });

  it("releases the event claim and returns retryable failure when agent delivery is rejected", async () => {
    const writes: string[] = [];
    const db = {
      prepare(sql: string) {
        const stmt = {
          bind() { return stmt; },
          async first() {
            if (/FROM spaces WHERE id = \?/.test(sql)) return { tenant_id: "tenant-1" };
            return null;
          },
          async run() { writes.push(sql); return { meta: { changes: 1 } }; },
        };
        return stmt;
      },
    };
    const raw = makeSubscriptionUpdatedBody("space-1");
    const response = await handleLemonSqueezyWebhook(new Request("https://billing.naelao.com/webhooks/lemon-squeezy", {
      method: "POST", headers: { "X-Signature": await signBody(raw) }, body: raw,
    }), {
      LEMON_SQUEEZY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PLATFORM_SECRET,
      PLATFORM_DB: db as unknown as D1Database,
      AGENTS_WORKER: { fetch: async () => new Response("temporarily unavailable", { status: 503 }) } as unknown as Fetcher,
      SPACES_WORKER: { fetch: async () => Response.json({ data: [], count: 0 }) } as unknown as Fetcher,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "agent_delivery_failed" });
    expect(writes.some((sql) => sql.includes("DELETE FROM processed_webhook_events"))).toBe(true);
  });

  it("retries a paid surcharge when marking its periods billed is unavailable", async () => {
    const writes: string[] = [];
    const db = {
      prepare(sql: string) {
        const stmt = {
          bind() { return stmt; },
          async first() {
            if (/FROM spaces WHERE id = \?/.test(sql)) return { tenant_id: "tenant-1" };
            return null;
          },
          async run() { writes.push(sql); return { meta: { changes: 1 } }; },
        };
        return stmt;
      },
    };
    const raw = JSON.stringify({
      meta: { event_name: "order_created", custom_data: { spaceId: "space-1", kind: "revenue_cut_surcharge", periods: "2026-06", period_charges: "500" } },
      data: { id: "surcharge-1", attributes: { total: 500, currency: "USD", customer_id: "customer-1", custom_data: { spaceId: "space-1", kind: "revenue_cut_surcharge", periods: "2026-06", period_charges: "500" } } },
    });
    const response = await handleLemonSqueezyWebhook(new Request("https://billing.naelao.com/webhooks/lemon-squeezy", {
      method: "POST", headers: { "X-Signature": await signBody(raw) }, body: raw,
    }), {
      LEMON_SQUEEZY_WEBHOOK_SECRET: WEBHOOK_SECRET, PLATFORM_SECRET,
      PLATFORM_DB: db as unknown as D1Database,
      AGENTS_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher,
      SPACES_WORKER: { fetch: async () => new Response("temporary failure", { status: 503 }) } as unknown as Fetcher,
    });
    expect(response.status).toBe(500);
    expect(writes.some((sql) => sql.includes("DELETE FROM processed_webhook_events"))).toBe(true);
  });
});

describe("isFulfillmentAgentBound", () => {
  function makeEnv(projects: Array<{ default_agent_id?: string | null; status?: string }> | null): LemonSqueezyEnv {
    return {
      AGENTS_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher,
      PLATFORM_DB: {} as unknown as D1Database,
      PLATFORM_SECRET,
      SPACES_WORKER: {
        async fetch() {
          if (projects === null) return new Response("error", { status: 500 });
          return Response.json({ data: projects, count: projects.length });
        },
      } as unknown as Fetcher,
    };
  }

  it("is true when a project is actually bound to launchpad-fulfillment-v1", async () => {
    const bound = await isFulfillmentAgentBound("space1", "tenant1", makeEnv([{ default_agent_id: "launchpad-fulfillment-v1" }]));
    expect(bound).toBe(true);
  });

  it("is false for a project merely NAMED Orders with no binding — the name-fallback isn't strong enough evidence the agent is installed", async () => {
    const bound = await isFulfillmentAgentBound("space1", "tenant1", makeEnv([{ default_agent_id: null }]));
    expect(bound).toBe(false);
  });

  it("is false when the bound project is archived", async () => {
    const bound = await isFulfillmentAgentBound("space1", "tenant1", makeEnv([{ default_agent_id: "launchpad-fulfillment-v1", status: "archived" }]));
    expect(bound).toBe(false);
  });

  it("fails soft (false, never throws) when SPACES_WORKER errors", async () => {
    const bound = await isFulfillmentAgentBound("space1", "tenant1", makeEnv(null));
    expect(bound).toBe(false);
  });
});

describe("handleLemonSqueezyWebhook — routes order-completed to the fulfillment specialist's own DO (F: trigger was never woken)", () => {
  function makeDb(spaceId: string, tenantId: string) {
    return {
      prepare(sql: string) {
        const stmt = {
          bind() { return stmt; },
          async first() {
            if (/FROM spaces WHERE/.test(sql)) return { tenant_id: tenantId };
            if (/FROM tenant_hierarchy/.test(sql)) return null;
            return null;
          },
          async run() { return { meta: { changes: 1 } }; },
        };
        return stmt;
      },
    } as unknown as D1Database;
  }

  it("wakes launchpad-fulfillment-v1's own DO for a payment.success event when it's actually bound to a project", async () => {
    const spaceId = "space1";
    const tenantId = "tenant1";
    const agentsFetch = vi.fn(async () => new Response("{}"));
    const env: LemonSqueezyEnv = {
      LEMON_SQUEEZY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PLATFORM_SECRET,
      PLATFORM_DB: makeDb(spaceId, tenantId),
      AGENTS_WORKER: { fetch: agentsFetch } as unknown as Fetcher,
      SPACES_WORKER: {
        async fetch() {
          return Response.json({ data: [{ id: "orders-proj", name: "Orders", default_agent_id: "launchpad-fulfillment-v1" }], count: 1 });
        },
      } as unknown as Fetcher,
    };

    const raw = makeOrderPaidBody(spaceId);
    const res = await handleLemonSqueezyWebhook(
      new Request("https://billing.naelao.com/webhooks/lemon-squeezy", {
        method: "POST",
        headers: { "X-Signature": await signBody(raw) },
        body: raw,
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(agentsFetch).toHaveBeenCalledTimes(1);
    const calledUrl = (agentsFetch.mock.calls[0]![0] as Request).url;
    expect(calledUrl).toBe("http://agents-worker/agents/launchpad-fulfillment-v1/script/run");
  });

  it("falls back to the Space Assistant for a payment.success event when the project is only name-matched, not bound", async () => {
    const spaceId = "space1";
    const tenantId = "tenant1";
    const agentsFetch = vi.fn(async () => new Response("{}"));
    const env: LemonSqueezyEnv = {
      LEMON_SQUEEZY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PLATFORM_SECRET,
      PLATFORM_DB: makeDb(spaceId, tenantId),
      AGENTS_WORKER: { fetch: agentsFetch } as unknown as Fetcher,
      SPACES_WORKER: {
        // "Orders" by name only — no default_agent_id, e.g. a space provisioned before that
        // binding existed, or a builder-created project that coincidentally shares the name.
        async fetch() { return Response.json({ data: [{ id: "orders-proj", name: "Orders" }], count: 1 }); },
      } as unknown as Fetcher,
    };

    const raw = makeOrderPaidBody(spaceId);
    await handleLemonSqueezyWebhook(
      new Request("https://billing.naelao.com/webhooks/lemon-squeezy", {
        method: "POST",
        headers: { "X-Signature": await signBody(raw) },
        body: raw,
      }),
      env
    );
    expect(agentsFetch).toHaveBeenCalledTimes(1);
    const calledUrl = (agentsFetch.mock.calls[0]![0] as Request).url;
    expect(calledUrl).toBe("http://agents-worker/agents/naelao-agent/script/run");
  });

  it("never routes a non-order billing event (subscription.updated) to the fulfillment specialist, even when it's bound", async () => {
    const spaceId = "space1";
    const tenantId = "tenant1";
    const agentsFetch = vi.fn(async () => new Response("{}"));
    const env: LemonSqueezyEnv = {
      LEMON_SQUEEZY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PLATFORM_SECRET,
      PLATFORM_DB: makeDb(spaceId, tenantId),
      AGENTS_WORKER: { fetch: agentsFetch } as unknown as Fetcher,
      SPACES_WORKER: {
        async fetch() {
          return Response.json({ data: [{ id: "orders-proj", name: "Orders", default_agent_id: "launchpad-fulfillment-v1" }], count: 1 });
        },
      } as unknown as Fetcher,
    };

    const raw = makeSubscriptionUpdatedBody(spaceId);
    await handleLemonSqueezyWebhook(
      new Request("https://billing.naelao.com/webhooks/lemon-squeezy", {
        method: "POST",
        headers: { "X-Signature": await signBody(raw) },
        body: raw,
      }),
      env
    );
    expect(agentsFetch).toHaveBeenCalledTimes(1);
    const calledUrl = (agentsFetch.mock.calls[0]![0] as Request).url;
    expect(calledUrl).toBe("http://agents-worker/agents/naelao-agent/script/run");
  });

  it("never wakes both the Space Assistant AND the fulfillment specialist for the same event", async () => {
    const spaceId = "space1";
    const tenantId = "tenant1";
    const agentsFetch = vi.fn(async () => new Response("{}"));
    const env: LemonSqueezyEnv = {
      LEMON_SQUEEZY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PLATFORM_SECRET,
      PLATFORM_DB: makeDb(spaceId, tenantId),
      AGENTS_WORKER: { fetch: agentsFetch } as unknown as Fetcher,
      SPACES_WORKER: {
        async fetch() {
          return Response.json({ data: [{ id: "orders-proj", name: "Orders", default_agent_id: "launchpad-fulfillment-v1" }], count: 1 });
        },
      } as unknown as Fetcher,
    };

    const raw = makeOrderPaidBody(spaceId);
    await handleLemonSqueezyWebhook(
      new Request("https://billing.naelao.com/webhooks/lemon-squeezy", {
        method: "POST",
        headers: { "X-Signature": await signBody(raw) },
        body: raw,
      }),
      env
    );
    // Exactly one wake — never both the specialist and the Space Assistant for one event.
    expect(agentsFetch).toHaveBeenCalledTimes(1);
  });
});

describe("WS-6: fulfillment agent id is manifest-driven, not a hardcoded Launchpad literal", () => {
  function makeEnv(opts: {
    spacetypeId: string;
    manifest: { backend?: { fulfillment?: { agentId?: string; projectNameFallback?: string } } } | null;
    projects: Array<{ id: string; name: string; status?: string; default_agent_id?: string | null }>;
  }): LemonSqueezyEnv {
    return {
      AGENTS_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher,
      PLATFORM_SECRET,
      PLATFORM_DB: {
        prepare(sql: string) {
          return {
            bind() { return this; },
            async first() {
              if (/spacetype_id FROM spaces/.test(sql)) return { spacetype_id: opts.spacetypeId };
              return null;
            },
          };
        },
      } as unknown as D1Database,
      SPACES_WORKER: {
        async fetch(input: RequestInfo) {
          const url = typeof input === "string" ? input : (input as Request).url;
          if (url.includes("/internal/space-types/")) {
            return opts.manifest ? Response.json(opts.manifest) : new Response("not found", { status: 404 });
          }
          return Response.json({ data: opts.projects, count: opts.projects.length });
        },
      } as unknown as Fetcher,
    };
  }

  it("routes to a non-Launchpad SpaceType's own manifest-declared fulfillment agent", async () => {
    const bound = await isFulfillmentAgentBound(
      "space1", "tenant1",
      makeEnv({
        spacetypeId: "some-other-spacetype",
        manifest: { backend: { fulfillment: { agentId: "other-fulfillment-agent" } } },
        projects: [{ id: "p1", name: "Orders", default_agent_id: "other-fulfillment-agent" }],
      })
    );
    expect(bound).toBe(true);
  });

  it("does NOT bind to a project using the Launchpad agent id when the manifest declares a different one", async () => {
    const bound = await isFulfillmentAgentBound(
      "space1", "tenant1",
      makeEnv({
        spacetypeId: "some-other-spacetype",
        manifest: { backend: { fulfillment: { agentId: "other-fulfillment-agent" } } },
        projects: [{ id: "p1", name: "Orders", default_agent_id: "launchpad-fulfillment-v1" }],
      })
    );
    expect(bound).toBe(false);
  });

  it("uses the manifest's own project-name fallback instead of the hardcoded 'orders' literal", async () => {
    const id = await resolveFulfillmentProjectId(
      "space1", "tenant1",
      makeEnv({
        spacetypeId: "some-other-spacetype",
        manifest: { backend: { fulfillment: { agentId: "other-fulfillment-agent", projectNameFallback: "tickets" } } },
        projects: [{ id: "p1", name: "Tickets" }],
      })
    );
    expect(id).toBe("p1");
  });

  it("falls back to the Launchpad default when the SpaceType manifest declares no fulfillment config", async () => {
    const bound = await isFulfillmentAgentBound(
      "space1", "tenant1",
      makeEnv({
        spacetypeId: "launchpad",
        manifest: { backend: {} },
        projects: [{ id: "p1", name: "Orders", default_agent_id: "launchpad-fulfillment-v1" }],
      })
    );
    expect(bound).toBe(true);
  });

  it("falls back to the Launchpad default when the manifest fetch fails", async () => {
    const bound = await isFulfillmentAgentBound(
      "space1", "tenant1",
      makeEnv({
        spacetypeId: "launchpad",
        manifest: null,
        projects: [{ id: "p1", name: "Orders", default_agent_id: "launchpad-fulfillment-v1" }],
      })
    );
    expect(bound).toBe(true);
  });
});

// Verify mintInternalToken import didn't get dropped from lemon-squeezy.ts (used by
// resolveFulfillmentProjectId and recordSeatActivation).
describe("sanity", () => {
  it("mintInternalToken is importable (shared with lemon-squeezy.ts)", async () => {
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant1");
    expect(typeof token).toBe("string");
  });
});
