import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { SpaceTypeRegistryDO } from "./SpaceTypeRegistryDO.js";

describe("SpaceTypeRegistryDO install accounting", () => {
  it("preserves built-in counters on restart and counts an install only once", async () => {
    const storage = createDOStorage();
    const registry = new SpaceTypeRegistryDO({ storage } as never, {} as never);
    const record = () => registry.fetch(new Request("https://registry/record-install", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeId: "launchpad", spaceId: "space-a", version: "2.1.0" }),
    }));

    expect((await record()).status).toBe(200);
    expect(await (await record()).json()).toMatchObject({ ok: true, deduplicated: true });
    const restarted = new SpaceTypeRegistryDO({ storage } as never, {} as never);
    await restarted.fetch(new Request("https://registry/types"));
    const listing = await (await restarted.fetch(new Request("https://registry/types"))).json() as { types: Array<{ id: string; install_count: number }> };
    expect(listing.types.find((type) => type.id === "launchpad")?.install_count).toBe(1);
  });

  it("rejects malformed, unsafe, and unknown install records", async () => {
    const registry = new SpaceTypeRegistryDO({ storage: createDOStorage() } as never, {} as never);
    const post = (body: string) => registry.fetch(new Request("https://registry/record-install", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    }));
    expect((await post("{" )).status).toBe(400);
    expect((await post(JSON.stringify({ typeId: "../launchpad", spaceId: "space-a", version: "2.1.0" }))).status).toBe(400);
    expect((await post(JSON.stringify({ typeId: "launchpad", spaceId: "space-a", version: "99.0.0" }))).status).toBe(404);
    const register = (body: string) => registry.fetch(new Request("https://registry/register", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    }));
    expect((await register("{" )).status).toBe(400);
    expect((await register(JSON.stringify({ authorId: "tenant-a", manifest: { id: "evil" } }))).status).toBe(403);
    const registered = await register(JSON.stringify({
      authorId: "naelao",
      manifest: { id: "bounded-type", name: "Bounded type", description: "Test", version: "1", marketplace: { priceUsdPerMonth: 0 } },
    }));
    expect(registered.status).toBe(200);
    expect(await registered.json()).toEqual({ accepted: true });
  });
});
