import { it, expect, vi } from "vitest";
import { eraseWebsiteConnections } from "./website-connection-erasure.js";
it("retains discovery metadata when encrypted profile erasure fails, then safely retries", async () => {
  let exists = true;
  const calls: string[] = [];
  const row = {
    id: "connection",
    space_id: "space",
    owner_user_id: "user",
    project_id: null,
    origins_json: '["https://example.com"]',
  };
  const env = {
    PLATFORM_SECRET: "secret",
    PLATFORM_DB: {
      prepare: (sql: string) => ({
        bind: () => ({
          all: async () => ({ results: exists ? [row] : [] }),
          run: async () => {
            calls.push(sql);
            if (sql.startsWith("DELETE")) exists = false;
          },
        }),
      }),
    },
    BROWSER_WORKER: {
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
    },
  };
  await expect(
    eraseWebsiteConnections(env as never, "tenant", { spaceId: "space" })
  ).rejects.toThrow("erasure failed");
  expect(exists).toBe(true);
  expect(calls.some((sql) => sql.startsWith("DELETE"))).toBe(false);
  env.BROWSER_WORKER.fetch.mockImplementation(
    async () => new Response(null, { status: 200 })
  );
  await eraseWebsiteConnections(env as never, "tenant", { spaceId: "space" });
  expect(exists).toBe(false);
});
