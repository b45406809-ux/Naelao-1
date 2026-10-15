import { describe, expect, it, vi } from "vitest";
import { dispatchOwnerVoiceTurn } from "./planner-turn.js";
import type { OwnerVoiceTicket } from "./voice-ticket.js";

const ticket: OwnerVoiceTicket = {
  tenantId: "tenant-1", spaceId: "space-1", sessionId: "session-1", userId: "owner-1", role: "owner", callerRole: "owner",
  agentName: "voice-agent", projectId: "project-1", expiresAt: 10_000, nonce: "12345678-1234-1234-1234-123456789abc",
};

describe("Cloudflare voice to Naelao planner bridge", () => {
  it("dispatches in the exact owner session and project, then returns the planner answer", async () => {
    let request: Request | undefined;
    const fetcher = { fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, init);
      return Response.json({ finalAnswer: "I found two open appointments." });
    }) } as unknown as Fetcher;
    await expect(dispatchOwnerVoiceTurn(ticket, "  Find an appointment  ", { platformSecret: "test-secret", agentsWorker: fetcher })).resolves.toBe("I found two open appointments.");
    expect(request?.url).toContain("/spaces/space-1/sessions/session-1/agent/run");
    expect(request?.headers.get("prefer")).toBe("respond-sync");
    const body = await request?.json() as Record<string, unknown>;
    expect(body).toEqual({ goal: "Find an appointment", project_id: "project-1" });
    expect(request?.headers.get("x-naelao-user-id")).toBe("owner-1");
    expect(request?.headers.get("x-naelao-internal-token")).toBeTruthy();
  });

  it("rejects empty, cancelled, failed, and answerless planner turns", async () => {
    const fetcher = { fetch: vi.fn(async () => Response.json({ finalAnswer: "" })) } as unknown as Fetcher;
    await expect(dispatchOwnerVoiceTurn(ticket, " ", { platformSecret: "x", agentsWorker: fetcher })).rejects.toThrow("voice_transcript_empty");
    await expect(dispatchOwnerVoiceTurn(ticket, "hello", { platformSecret: "x", agentsWorker: fetcher, signal: AbortSignal.abort() })).rejects.toThrow("voice_turn_cancelled");
    await expect(dispatchOwnerVoiceTurn(ticket, "hello", { platformSecret: "x", agentsWorker: fetcher })).rejects.toThrow("voice_planner_returned_no_answer");
    const failed = { fetch: vi.fn(async () => new Response("", { status: 503 })) } as unknown as Fetcher;
    await expect(dispatchOwnerVoiceTurn(ticket, "hello", { platformSecret: "x", agentsWorker: failed })).rejects.toThrow("voice_planner_failed_503");
  });
});
