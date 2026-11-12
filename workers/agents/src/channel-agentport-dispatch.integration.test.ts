import { describe, expect, it, vi } from "vitest";
import { handleWorkerQueue } from "./index.js";
import type { ProviderEventReferenceQueueMessage } from "./channels/session-queue.js";

describe("AgentPort channel queue → session → assistant dispatch", () => {
  it("rechecks subscription state and wakes the provisioned runtime with only a scoped event reference", async () => {
    const event: ProviderEventReferenceQueueMessage = {
      type: "provider_event_reference", tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a",
      agentId: "agentport-agent-a", connectionId: "connection-a", accountId: "account-a", subscriptionId: "subscription-a",
      eventId: "event-a", deliveryId: "delivery-a", serviceId: "agentmail:tenant-a", eventType: "message.received",
      threadRef: "thread-a", dataRef: "message-a",
    };
    const persisted: Record<string, unknown> = {};
    const routeAssistant = "naelao-specialist";
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const database = {
      prepare(sql: string) {
        let values: unknown[] = [];
        return {
          bind(...args: unknown[]) { values = args; return this; },
          first: async <T>() => {
            statements.push({ sql, values });
            if (sql.includes("SELECT s.id FROM spaces")) return { id: "space-a" } as T;
            if (sql.includes("SELECT name, config_json FROM spaces")) return { name: "Test space", config_json: "{}" } as T;
            if (sql.includes("SELECT status,lease_until FROM assistant_agentport_event_runs")) return { status: persisted.status, lease_until: null } as T;
            if (sql.includes("FROM assistant_agentport_event_routes")) return { subscription_id: event.subscriptionId, agentport_agent_id: event.agentId,
              agentport_account_id: event.accountId, service_id: event.serviceId, naelao_agent_id: routeAssistant, wake_enabled: 1, route_revision: 2 } as T;
            if (sql.includes("SELECT target_assistant_id")) return { target_assistant_id: persisted.targetAssistantId,
              target_route_revision: persisted.targetRouteRevision } as T;
            return null;
          },
          run: async () => {
            statements.push({ sql, values });
            if (sql.includes("INSERT OR IGNORE INTO assistant_agentport_event_runs")) persisted.status ??= "pending";
            if (sql.includes("SET status='running'")) persisted.status = "running";
            if (sql.includes("SET target_assistant_id=COALESCE")) { persisted.targetAssistantId ??= values[0]; persisted.targetRouteRevision ??= values[1]; }
            if (sql.includes("SET session_id=")) persisted.sessionId = values[0];
            if (sql.includes("SET status='accepted'")) persisted.status = "accepted";
            if (sql.includes("SET status='failed'")) persisted.status = "failed";
            return { meta: { changes: 1 } };
          },
        };
      },
    };
    const agentPort = vi.fn(async () => Response.json({ subscription: {
      id: event.subscriptionId, agentId: event.agentId, accountId: event.accountId, serviceId: event.serviceId, status: "active",
    } }));
    const spacesCalls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    const spaces = vi.fn(async (request: Request) => {
      const url = new URL(request.url), body = request.method === "POST" ? await request.clone().json().catch(() => ({})) as Record<string, unknown> : {};
      spacesCalls.push({ url: url.pathname, method: request.method, body });
      if (url.pathname.endsWith("/threads")) return Response.json({ id: "thread-record-a" });
      if (url.pathname.endsWith("/sessions") && request.method === "POST") return Response.json({ id: body.id });
      return Response.json({ ok: true });
    });
    const wakePayloads: Record<string, unknown>[] = [];
    const agentNamespace = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async (request: Request) => { wakePayloads.push(await request.json() as Record<string, unknown>); return Response.json({ ok: true }); } }),
    };
    const env = {
      PLATFORM_SECRET: "agentport-dispatch-test-secret",
      PLATFORM_DB: database,
      AGENTPORT_WORKER: { fetch: agentPort },
      SPACES_WORKER: { fetch: spaces },
      NAELAO_AGENT_DO: agentNamespace,
      ANTHROPIC_API_KEY: "test-model-key",
    };
    const message = { id: "queue-message-a", body: event, ack: vi.fn(), retry: vi.fn() };

    await handleWorkerQueue({ queue: "naelao-channel-sessions", messages: [message] } as never, env as never);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(agentPort).toHaveBeenCalledOnce();
    expect(persisted).toMatchObject({ status: "accepted", sessionId: expect.stringMatching(/^channel-/) });
    expect(spacesCalls.map(call => call.url.split("/").at(-1))).toEqual(["threads", "sessions", "messages"]);
    expect(spacesCalls[1]?.body).toMatchObject({ metadata: { agentport_agent_id: event.agentId, naelao_assistant_id: routeAssistant, channel_type: "agentmail" } });
    const appended = JSON.parse(String(spacesCalls[2]?.body.content)) as { provider_event_reference: Record<string, unknown> };
    expect(appended.provider_event_reference).toMatchObject({ delivery_id: event.deliveryId, data_ref: event.dataRef });
    expect(JSON.stringify(appended)).not.toContain("message body");
    expect(wakePayloads).toHaveLength(1);
    expect(wakePayloads[0]).toMatchObject({ agentId: routeAssistant, tenantId: event.tenantId, spaceId: event.spaceId,
      sessionId: persisted.sessionId, runId: expect.stringMatching(/^agentport-event-[a-f0-9]{64}$/),
      context: { agentport_agent_id: event.agentId, naelao_assistant_id: routeAssistant, session_selection: "agentport_thread" } });
    expect(wakePayloads[0]?.agentId).not.toBe(event.agentId);
    expect(statements.some(statement => statement.sql.includes("SET status='accepted'"))).toBe(true);
  });

  it("does not wake the default assistant when an AgentPort subscription has no owner-selected route", async () => {
    const event: ProviderEventReferenceQueueMessage = {
      type: "provider_event_reference", tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a",
      agentId: "agentport-agent-a", connectionId: "connection-a", accountId: "account-a", subscriptionId: "subscription-a",
      eventId: "event-unrouted", deliveryId: "delivery-unrouted", serviceId: "agentmail:tenant-a", eventType: "message.received",
      threadRef: "thread-a", dataRef: "message-a",
    };
    const persisted: Record<string, unknown> = {};
    const database = {
      prepare(sql: string) {
        let values: unknown[] = [];
        return {
          bind(...args: unknown[]) { values = args; return this; },
          first: async <T>() => {
            if (sql.includes("SELECT s.id FROM spaces")) return { id: "space-a" } as T;
            if (sql.includes("SELECT status,lease_until FROM assistant_agentport_event_runs")) return { status: persisted.status, lease_until: null } as T;
            return null;
          },
          run: async () => {
            if (sql.includes("INSERT OR IGNORE INTO assistant_agentport_event_runs")) persisted.status ??= "pending";
            if (sql.includes("SET status='running'")) persisted.status = "running";
            if (sql.includes("SET status='accepted'")) persisted.status = "accepted";
            return { meta: { changes: 1 }, values };
          },
        };
      },
    };
    const agentPort = vi.fn(async () => Response.json({ subscription: {
      id: event.subscriptionId, agentId: event.agentId, accountId: event.accountId, serviceId: event.serviceId, status: "active",
    } }));
    const env = {
      PLATFORM_SECRET: "agentport-dispatch-test-secret", PLATFORM_DB: database,
      AGENTPORT_WORKER: { fetch: agentPort },
    };
    const message = { id: "queue-message-unrouted", body: event, ack: vi.fn(), retry: vi.fn() };

    await handleWorkerQueue({ queue: "naelao-channel-sessions", messages: [message] } as never, env as never);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(agentPort).toHaveBeenCalledOnce();
    expect(persisted.status).toBe("accepted");
  });
});
