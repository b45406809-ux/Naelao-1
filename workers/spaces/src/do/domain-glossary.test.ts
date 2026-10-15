import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { SpaceDO } from "./SpaceDO.js";

describe("SpaceDO domain glossary persistence", () => {
  it("upserts by normalized term and locale while isolating Spaces and returning exact matches", async () => {
    const storage = createDOStorage();
    const space = new SpaceDO({ storage } as never, {} as never);
    const put = (spaceId: string, term: string, meaning: string, locale = "sn") => space.fetch(new Request("https://space/internal/domain-glossary", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: spaceId, actor_id: `${spaceId}-owner`, entry: { term, meaning, locale } }),
    }));
    expect((await put("space-a", " Moyo ", "community health worker")).status).toBe(201);
    expect((await put("space-a", "moyo", "community health worker, revised")).status).toBe(200);
    expect((await put("space-b", "moyo", "different scope")).status).toBe(201);

    const lookup = await space.fetch(new Request("https://space/internal/domain-glossary/lookup", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: "space-a", terms: ["MOYO"], locale: "sn" }),
    }));
    expect(await lookup.json()).toMatchObject({ matches: [{ term: "moyo", meaning: "community health worker, revised", locale: "sn" }] });
    const otherSpace = await space.fetch(new Request("https://space/internal/domain-glossary?space_id=space-b"));
    expect(await otherSpace.json()).toMatchObject({ entries: [{ meaning: "different scope" }] });

    const deleted = await space.fetch(new Request("https://space/internal/domain-glossary?space_id=space-a&term=moyo&locale=sn", { method: "DELETE" }));
    expect(await deleted.json()).toMatchObject({ deleted: true });
    const empty = await space.fetch(new Request("https://space/internal/domain-glossary/lookup", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: "space-a", terms: ["moyo"] }),
    }));
    expect(await empty.json()).toMatchObject({ matches: [] });
  });
});
