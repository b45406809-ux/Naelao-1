import { afterEach, describe, expect, it, vi } from "vitest";
import { createInbox, sendFromInbox } from "./agentmail.js";

afterEach(() => vi.unstubAllGlobals());

describe("AgentMail REST client", () => {
  it("returns unconfigured without making a provider request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(createInbox({}, { spaceId: "space-1" })).resolves.toMatchObject({ configured: false, ok: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends a bounded-timeout request and parses a valid provider response", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.agentmail.to/v0/inboxes");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer secret");
      return Response.json({ email: "hello@example.test", inbox_id: "inbox-1" });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(createInbox({ AGENTMAIL_API_KEY: "secret" }, { spaceId: "space-1" }))
      .resolves.toMatchObject({ ok: true, email: "hello@example.test", inboxId: "inbox-1" });
  });

  it("rejects oversized provider responses without returning their contents", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(65 * 1024));
      },
    }))));
    const result = await createInbox({ AGENTMAIL_API_KEY: "secret" }, { spaceId: "space-1" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("agentmail_response_too_large");
    expect(result.error).not.toContain("0,0,0");
  });

  it("fails closed on malformed JSON and keeps recipient validation local", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{broken")));
    await expect(createInbox({ AGENTMAIL_API_KEY: "secret" }, { spaceId: "space-1" }))
      .resolves.toMatchObject({ ok: false, error: "agentmail create inbox error: agentmail_response_invalid" });
    await expect(sendFromInbox({ AGENTMAIL_API_KEY: "secret" }, "inbox-1", { to: [] }))
      .resolves.toMatchObject({ ok: false, error: "recipient 'to' is required" });
  });
});
