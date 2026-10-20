import { describe, expect, it, vi } from "vitest";
import { WsHubDO } from "./index";

describe("sample-audit UI action delegation", () => {
  it("forwards the seeded audit artifact to the same project/session agent", async () => {
    let forwarded: Request | undefined;
    const messages: string[] = [];
    const agentWorker = {
      fetch: vi.fn(async (request: Request) => {
        forwarded = request;
        return Response.json(
          { run_id: "audit-run-1", status: "queued" },
          { status: 202 }
        );
      }),
    };
    const ws = {
      close: vi.fn(),
      deserializeAttachment: () => ({
        tenantId: "tenant-1",
        spaceId: "space-1",
        userId: "owner-1",
        agentId: "project-agent",
        sessionId: "canvas:project-1",
      }),
      send: (message: string) => messages.push(message),
    };
    const ctx = {
      storage: { sql: { exec: () => [] } },
      getTags: () => [],
    };
    const gateway = new WsHubDO(ctx as never, {
      ENVIRONMENT: "development",
      PLATFORM_SECRET: "test-secret",
      WS_HUB: {} as never,
      AGENTS_WORKER: agentWorker as never,
    });
    gateway.webSocketMessage(
      ws as never,
      JSON.stringify({
        type: "mcp.ui_action",
        projectId: "project-1",
        action: "template.run_sample_audit",
        payload: {
          path: "demo/nda-audit-fixtures.json",
          mode: "synthetic_fixture_audit",
        },
      })
    );
    await vi.waitFor(() => expect(agentWorker.fetch).toHaveBeenCalledOnce());

    expect(forwarded?.url).toBe(
      "http://agents/agents/project-agent/script/run"
    );
    expect(forwarded?.headers.get("x-naelao-tenant-id")).toBe("tenant-1");
    const body = (await forwarded?.json()) as {
      goal: string;
      spaceId: string;
      projectId: string;
      sessionId: string;
      context: Record<string, unknown>;
    };
    expect(body).toMatchObject({
      spaceId: "space-1",
      projectId: "project-1",
      sessionId: "canvas:project-1",
      context: { immediate: true, source: "mcp_ui" },
    });
    expect(body.goal).toContain('action="template.run_sample_audit"');
    expect(body.goal).toContain("nda-audit-fixtures.json");
    expect(body.goal).toContain("synthetic_fixture_audit");
    expect(messages.map((message) => JSON.parse(message).type)).toContain(
      "mcp.ui_action.accepted"
    );
    expect(messages.map((message) => JSON.parse(message).type)).toContain(
      "mcp.ui_action.queued"
    );
  });

  it("closes oversized frames before parsing or forwarding them", () => {
    const messages: string[] = [];
    const ws = {
      send: (message: string) => messages.push(message),
      close: vi.fn(),
    };
    const gateway = new WsHubDO(
      { storage: { sql: { exec: () => [] } }, getTags: () => [] } as never,
      {
        ENVIRONMENT: "development",
        PLATFORM_SECRET: "test-secret",
        WS_HUB: {} as never,
        AGENTS_WORKER: { fetch: vi.fn() } as never,
      }
    );
    gateway.webSocketMessage(ws as never, "x".repeat(64 * 1024 + 1));
    expect(ws.close).toHaveBeenCalledWith(1009, "message too large");
    expect(messages).toHaveLength(0);
  });

  it("rejects oversized internal broadcasts before parsing JSON", async () => {
    const gateway = new WsHubDO(
      { storage: { sql: { exec: () => [] } }, getTags: () => [] } as never,
      {
        ENVIRONMENT: "development",
        PLATFORM_SECRET: "test-secret",
        WS_HUB: {} as never,
        AGENTS_WORKER: {} as never,
      }
    );
    const response = await gateway.fetch(
      new Request("http://ws/broadcast", {
        method: "POST",
        headers: { "x-naelao-platform-secret": "test-secret" },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024 + 1));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit)
    );
    expect(response.status).toBe(413);
  });
});
