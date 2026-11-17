import { afterEach, describe, expect, it, vi } from "vitest";
import { installProjectCanvasExtension } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("reviewed Project extension update replay", () => {
  it("retries one ambiguous server failure with the same durable request payload", async () => {
    const calls: Array<{ url: string; body: string | null }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: typeof init?.body === "string" ? init.body : null });
      return calls.length === 1
        ? Response.json({ error_code: "temporary_failure" }, { status: 503 })
        : Response.json({ installed: true, replayed: true, installationId: "instance-a" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await installProjectCanvasExtension("space-a", "project-a", { sessionToken: "cookie", endUserId: "owner-a" },
      { id: "extension-a" }, { "./index.html": "<main />" }, true, "default", { key_id: "a".repeat(64), signature: "signature" },
      false, false, "signed-review-token");

    expect(result).toMatchObject({ installed: true, replayed: true, installationId: "instance-a" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls[0]?.url).toBe(calls[1]?.url);
    expect(calls[0]?.body).toBe(calls[1]?.body);
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ upgrade: true, updateReviewToken: "signed-review-token" });
  });

  it("does not retry a review conflict or an unreviewed install", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error_code: "extension_update_review_token_stale" }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(installProjectCanvasExtension("space-a", "project-a", { sessionToken: "cookie", endUserId: "owner-a" },
      { id: "extension-a" }, { "./index.html": "<main />" }, true, "default", undefined, false, false, "signed-review-token"))
      .rejects.toMatchObject({ status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
