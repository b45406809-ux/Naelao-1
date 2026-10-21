import { describe, it, expect } from "vitest";
import { enqueueAgentTicks, handleAgentTick } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";

// Tier 2/3 follow-up: a proactive daily digest email — opt-in (productConfig.notificationsConfig.
// dailyDigestEnabled), off by default. enqueueAgentTicks (the hourly cron's enumerate phase) adds
// a 4th roster (product roots only, keyset-paginated like the other three); handleAgentTick's new
// "daily_digest" case does the actual email send, sourcing content from agent_activity_log via
// GET /spaces/:spaceId/agent-activity and the recipient via /internal/spaces/:spaceId/owner-contact
// (both already-tested, pre-existing routes — no new backend surface besides the roster itself).

// agent_activity_log.created_at is SQLite's `datetime('now')` default — "YYYY-MM-DD HH:MM:SS",
// space-separated, no "T"/"Z" (unlike JS's toISOString()). The production code parses it via
// `Date.parse(\`${created_at}Z\`)`, which V8 accepts for this exact shape — using a real
// toISOString() string in a fixture here would silently double up the "Z" and break parsing.
function sqliteNow(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function paginate<T>(rows: T[], sortKeyOf: (row: T) => string, cursor: string, limit: number): T[] {
  return [...rows]
    .filter((r) => sortKeyOf(r) > cursor)
    .sort((a, b) => (sortKeyOf(a) < sortKeyOf(b) ? -1 : sortKeyOf(a) > sortKeyOf(b) ? 1 : 0))
    .slice(0, limit);
}

interface RootRow {
  id: string;
  tenant_id: string;
  config_json: string | null;
  last_digest_sent_at: string | null;
}

describe("enqueueAgentTicks — daily_digest roster", () => {
  function makeEnv(roots: RootRow[]): { env: AgentsEnv; batches: Array<{ kind: string; spaceId: string }[]> } {
    const db = {
      prepare(sql: string) {
        let args: unknown[] = [];
        const stmt = {
          bind(...a: unknown[]) { args = a; return stmt; },
          async all() {
            if (/last_digest_sent_at/.test(sql)) {
              const cursor = String(args[args.length - 2] ?? "");
              const limit = Number(args[args.length - 1] ?? Number.MAX_SAFE_INTEGER);
              return { results: paginate(roots, (r) => r.id, cursor, limit) };
            }
            return { results: [] };
          },
          async first() { return { name: "Product", config_json: "{}" }; },
          async run() { return { meta: { changes: 1 } }; },
        };
        return stmt;
      },
    };
    const batches: Array<{ kind: string; spaceId: string }[]> = [];
    const agentTicksQueue = {
      async sendBatch(messages: Array<{ body: { kind: string; spaceId: string } }>) {
        batches.push(messages.map((m) => m.body));
      },
    };
    const env = {
      PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: db,
      AGENT_TICKS: agentTicksQueue,
      SPACES_WORKER: { fetch: async () => new Response("not found", { status: 404 }) },
      ANALYTICS: { writeDataPoint() {} },
    } as unknown as AgentsEnv;
    return { env, batches };
  }

  it("enqueues a digest for a product root that opted in and is due (never sent before)", async () => {
    const { env, batches } = makeEnv([
      { id: "prod-1", tenant_id: "tenant-1", config_json: JSON.stringify({ productConfig: { notificationsConfig: { dailyDigestEnabled: true } } }), last_digest_sent_at: null },
    ]);
    await enqueueAgentTicks(env);
    const messages = batches.flat();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ kind: "daily_digest", spaceId: "prod-1", tenantId: "tenant-1" });
  });

  it("does NOT enqueue for a product that never opted in", async () => {
    const { env, batches } = makeEnv([
      { id: "prod-1", tenant_id: "tenant-1", config_json: JSON.stringify({ productConfig: {} }), last_digest_sent_at: null },
      { id: "prod-2", tenant_id: "tenant-1", config_json: null, last_digest_sent_at: null },
    ]);
    await enqueueAgentTicks(env);
    expect(batches.flat()).toHaveLength(0);
  });

  it("does NOT enqueue when a digest was already sent within the last 24h", async () => {
    const { env, batches } = makeEnv([
      {
        id: "prod-1", tenant_id: "tenant-1",
        config_json: JSON.stringify({ productConfig: { notificationsConfig: { dailyDigestEnabled: true } } }),
        last_digest_sent_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3h ago
      },
    ]);
    await enqueueAgentTicks(env);
    expect(batches.flat()).toHaveLength(0);
  });

  it("enqueues again once 24h have passed since the last send", async () => {
    const { env, batches } = makeEnv([
      {
        id: "prod-1", tenant_id: "tenant-1",
        config_json: JSON.stringify({ productConfig: { notificationsConfig: { dailyDigestEnabled: true } } }),
        last_digest_sent_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
      },
    ]);
    await enqueueAgentTicks(env);
    expect(batches.flat()).toHaveLength(1);
  });

  it("does not crash on malformed config_json — treats it as opted out", async () => {
    const { env, batches } = makeEnv([
      { id: "prod-1", tenant_id: "tenant-1", config_json: "{not json", last_digest_sent_at: null },
    ]);
    await enqueueAgentTicks(env);
    expect(batches.flat()).toHaveLength(0);
  });
});

describe("handleAgentTick — daily_digest send", () => {
  function makeEnv(opts: {
    ownerEmail?: string | null;
    activity?: Array<{ event_type: string; tokens_used: number | null; cost_credits: number | null; created_at: string }>;
    notificationsWired?: boolean;
  }) {
    const { ownerEmail = "owner@acme.com", activity = [], notificationsWired = true } = opts;
    const dbCalls: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        let args: unknown[] = [];
        const stmt = {
          bind(...a: unknown[]) { args = a; return stmt; },
          async first() { return { name: "Product", config_json: "{}" }; },
          async run() { dbCalls.push({ sql, args }); return { meta: { changes: 1 } }; },
        };
        return stmt;
      },
    };
    const notifyCalls: Array<{ to: string; subject: string; body: string }> = [];
    const spacesWorker = {
      async fetch(reqInput: Request) {
        const url = new URL(reqInput.url);
        if (url.pathname.endsWith("/owner-contact")) {
          return ownerEmail
            ? Response.json({ found: true, email: ownerEmail })
            : Response.json({ found: false }, { status: 404 });
        }
        if (url.pathname.endsWith("/agent-activity")) {
          return Response.json({ data: activity, count: activity.length });
        }
        return new Response("not found", { status: 404 });
      },
    };
    const notificationsWorker = notificationsWired ? {
      async fetch(reqInput: Request) {
        const body = await reqInput.json() as { to: string; subject: string; body: string };
        notifyCalls.push(body);
        return Response.json({ delivered: true });
      },
    } : undefined;
    const env = {
      PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: db,
      SPACES_WORKER: spacesWorker,
      NOTIFICATIONS_WORKER: notificationsWorker,
    } as unknown as AgentsEnv;
    return { env, dbCalls, notifyCalls };
  }

  it("sends a digest email summarizing the last 24h of activity", async () => {
    const now = sqliteNow();
    const { env, notifyCalls, dbCalls } = makeEnv({
      activity: [
        { event_type: "run_completed", tokens_used: 500, cost_credits: 10, created_at: now },
        { event_type: "run_completed", tokens_used: 300, cost_credits: 6, created_at: now },
        { event_type: "run_failed", tokens_used: 100, cost_credits: 2, created_at: now },
        { event_type: "approval_requested", tokens_used: null, cost_credits: null, created_at: now },
      ],
    });
    await handleAgentTick(env, { kind: "daily_digest", spaceId: "prod-1", tenantId: "tenant-1" });
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]!.to).toBe("owner@acme.com");
    expect(notifyCalls[0]!.body).toContain("Runs completed: 2");
    expect(notifyCalls[0]!.body).toContain("Runs failed: 1");
    expect(notifyCalls[0]!.body).toContain("Approvals requested: 1");
    expect(notifyCalls[0]!.body).toContain("Tokens used: 900");
    expect(notifyCalls[0]!.body).toContain("Credits spent: 18");
    // last_digest_sent_at is advanced regardless of send outcome (see the handler's own comment).
    expect(dbCalls.some((c) => /UPDATE spaces SET last_digest_sent_at/.test(c.sql))).toBe(true);
  });

  it("excludes activity older than 24h from the summary", async () => {
    const now = sqliteNow();
    const stale = sqliteNow(-48 * 60 * 60 * 1000);
    const { env, notifyCalls } = makeEnv({
      activity: [
        { event_type: "run_completed", tokens_used: 100, cost_credits: 1, created_at: now },
        { event_type: "run_completed", tokens_used: 999, cost_credits: 99, created_at: stale },
      ],
    });
    await handleAgentTick(env, { kind: "daily_digest", spaceId: "prod-1", tenantId: "tenant-1" });
    expect(notifyCalls[0]!.body).toContain("Runs completed: 1");
    expect(notifyCalls[0]!.body).toContain("Tokens used: 100");
  });

  it("does not send when there's no activity in the last 24h (no empty digest)", async () => {
    const { env, notifyCalls } = makeEnv({ activity: [] });
    await handleAgentTick(env, { kind: "daily_digest", spaceId: "prod-1", tenantId: "tenant-1" });
    expect(notifyCalls).toHaveLength(0);
  });

  it("does not send when there's no owner contact on record", async () => {
    const { env, notifyCalls } = makeEnv({ ownerEmail: null, activity: [{ event_type: "run_completed", tokens_used: 1, cost_credits: 1, created_at: sqliteNow() }] });
    await handleAgentTick(env, { kind: "daily_digest", spaceId: "prod-1", tenantId: "tenant-1" });
    expect(notifyCalls).toHaveLength(0);
  });

  it("degrades honestly (no crash) when NOTIFICATIONS_WORKER is unwired", async () => {
    const { env, notifyCalls } = makeEnv({ notificationsWired: false, activity: [{ event_type: "run_completed", tokens_used: 1, cost_credits: 1, created_at: sqliteNow() }] });
    await expect(handleAgentTick(env, { kind: "daily_digest", spaceId: "prod-1", tenantId: "tenant-1" })).resolves.not.toThrow();
    expect(notifyCalls).toHaveLength(0);
  });
});
