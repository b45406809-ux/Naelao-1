import { afterEach, expect, it, vi } from "vitest";
import { listSpaceSharedDynamicPages, publishReviewedSpaceSharedDynamicPage, reviewSpaceSharedDynamicPage, unpublishSpaceSharedDynamicPage } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("pins owner preview/apply calls to the same draft and exposes exact-slug takedown", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(
    init?.method === "DELETE" ? JSON.stringify({ unpublished: true, removed: true, slug: "welcome" })
      : !init?.method || init.method === "GET" ? JSON.stringify({ pages: [], truncated: false })
      : init?.body && JSON.parse(String(init.body)).review_id
        ? JSON.stringify({ published: true, slug: "welcome", artifact_sha256: "a".repeat(64) })
        : JSON.stringify({ review_id: "review-1", artifact_sha256: "a".repeat(64), expires_at: Date.now() + 60_000,
          draft: { slug: "welcome", html: "<main>Welcome</main>", actions: { signup: { key: "signup", fields: ["email"] } } } }),
    { status: init?.method === "DELETE" ? 200 : 201, headers: { "content-type": "application/json" } },
  ));
  vi.stubGlobal("fetch", fetchMock);
  const session = { sessionToken: "session-a", endUserId: "owner-a" };
  const draft = { slug: "welcome", html: "<main>Welcome</main>", actions: { signup: { key: "signup", fields: ["email"] } } };

  await listSpaceSharedDynamicPages("space/a", "app b", session);
  const review = await reviewSpaceSharedDynamicPage("space/a", "app b", session, draft);
  await publishReviewedSpaceSharedDynamicPage("space/a", "app b", session, review.review_id, draft);
  await unpublishSpaceSharedDynamicPage("space/a", "app b", session, draft.slug);

  expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.cache])).toEqual([
    ["http://localhost:8787/v1/spaces/space%2Fa/apps/app%20b/pages", undefined, "no-store"],
    ["http://localhost:8787/v1/spaces/space%2Fa/apps/app%20b/pages", "POST", "no-store"],
    ["http://localhost:8787/v1/spaces/space%2Fa/apps/app%20b/pages/publish", "POST", "no-store"],
    ["http://localhost:8787/v1/spaces/space%2Fa/apps/app%20b/pages/welcome", "DELETE", "no-store"],
  ]);
  expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ review_id: "review-1", draft });
  expect(fetchMock.mock.calls.every(([, init]) => new Headers(init?.headers).get("x-naelao-end-user-id") === "owner-a")).toBe(true);
});
