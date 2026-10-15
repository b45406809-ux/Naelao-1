import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import spacesWorker from "./index.js";

describe("Space domain glossary routes", () => {
  it("requires Space ownership, owner/admin writes and an internal HMAC for planner reads", async () => {
    const forwarded: Request[] = [];
    const spaceStub = { fetch: vi.fn(async (request: Request) => { forwarded.push(request); return Response.json({ entries: [] }); }) };
    const env = {
      PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: async () => sql.includes("tenant_id") && values[0] === "space-a" && values[1] === "tenant-a" ? { id: "space-a" } : null }) }) },
      SPACE_DO: { idFromName: (name: string) => name, get: () => spaceStub },
    } as never;
    const post = (role: string, spaceId = "space-a") => new Request(`https://spaces.test/spaces/${spaceId}/domain-glossary`, {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "user-a", "x-naelao-role": role },
      body: JSON.stringify({ term: "Moyo", meaning: "community health worker", locale: "sn" }),
    });
    expect((await spacesWorker.fetch(post("member"), env)).status).toBe(403);
    expect(spaceStub.fetch).not.toHaveBeenCalled();
    expect((await spacesWorker.fetch(post("owner", "space-other"), env)).status).toBe(404);
    expect(spaceStub.fetch).not.toHaveBeenCalled();
    expect((await spacesWorker.fetch(post("owner"), env)).status).toBe(200);
    expect(JSON.parse(await forwarded[0]!.text())).toMatchObject({ space_id: "space-a", actor_id: "user-a", entry: { term: "Moyo" } });

    const internalUrl = "https://spaces.test/internal/spaces/space-a/domain-glossary/lookup";
    const internalBody = JSON.stringify({ terms: ["moyo"], locale: "sn" });
    const denied = await spacesWorker.fetch(new Request(internalUrl, { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a" }, body: internalBody }), env);
    expect(denied.status).toBe(403);
    const permitted = await spacesWorker.fetch(new Request(internalUrl, { method: "POST", headers: {
      "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken("test-secret", "tenant-a"),
    }, body: internalBody }), env);
    expect(permitted.status).toBe(200);
    expect(JSON.parse(await forwarded[1]!.text())).toEqual({ terms: ["moyo"], locale: "sn", space_id: "space-a" });
  });
});
