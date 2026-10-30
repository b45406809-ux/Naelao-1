import { afterEach, describe, expect, it, vi } from "vitest";
import { executeComposioAction } from "./composio.js";

describe("Composio managed broker", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("executes with the server-held API key", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)["x-api-key"]).toBe("platform-key");
      return Response.json({ successful: true, data: { id: "message-1" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(executeComposioAction({ COMPOSIO_API_KEY: "platform-key" }, { connectionId: "account", action: "GMAIL_SEND_EMAIL", arguments: { to: "a@example.com" } })).resolves.toEqual({ id: "message-1" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("fails closed on an oversized success response instead of returning empty tool output", async () => {
    const oversized = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"successful":true,"data":"'));
          controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1).fill(0x61));
          controller.enqueue(new TextEncoder().encode('"}'));
          controller.close();
        },
      }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(oversized));
    await expect(executeComposioAction({ COMPOSIO_API_KEY: "platform-key" }, { connectionId: "account", action: "GMAIL_LIST_MESSAGES" })).rejects.toThrow("invalid or oversized response");
  });
});
