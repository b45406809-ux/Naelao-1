import { afterEach, describe, expect, it, vi } from "vitest";
import { executeComposioAction } from "./composio.js";
import { isReservedToolName } from "./index.js";

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
  it("recognizes reserved money-in actions before provider dispatch", () => {
    expect(isReservedToolName("stripe_create_checkout_session")).toBe(true);
    expect(isReservedToolName("GMAIL_SEND_EMAIL")).toBe(false);
  });
});
