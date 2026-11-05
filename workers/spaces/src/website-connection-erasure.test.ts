import { it, expect, vi } from "vitest";
import { eraseWebsiteConnections } from "./website-connection-erasure.js";
import { createFakeD1 } from "../../../tests/stubs/d1-sqlite.js";

it("erases only the requested user's profiles in Spaces linked directly to the Product", async () => {
  const db = createFakeD1([
    "CREATE TABLE spaces(id TEXT PRIMARY KEY,parent_space_id TEXT,product_id TEXT)",
    "CREATE TABLE website_connections(id TEXT PRIMARY KEY,tenant_id TEXT,space_id TEXT,owner_user_id TEXT,project_id TEXT,origins_json TEXT,status TEXT)",
    "INSERT INTO spaces VALUES('space-a',NULL,'product'),('space-b',NULL,'product'),('other',NULL,'different-product')",
    `INSERT INTO website_connections VALUES
      ('a','tenant','space-a','user-a',NULL,'[]','active'),('b','tenant','space-b','user-b',NULL,'[]','active'),
      ('c','tenant','other','user-a',NULL,'[]','active')`,
  ]);
  const revoked: string[] = [];
  const env = { PLATFORM_SECRET: "secret", PLATFORM_DB: db,
    BROWSER_WORKER: { fetch: async (request: Request) => { revoked.push((await request.json() as { connectionId: string }).connectionId); return new Response(null, { status: 200 }); } } };
  await eraseWebsiteConnections(env as never, "tenant", { productSpaceId: "product", userId: "user-a" });
  expect(revoked).toEqual(["a"]);
  expect(db.db.prepare("SELECT id FROM website_connections ORDER BY id").all()).toEqual([{ id: "b" }, { id: "c" }]);
});
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
