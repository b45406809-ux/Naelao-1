import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { SpaceDO } from "./SpaceDO.js";

describe("SpaceDO project model-cost reservations", () => {
  it("reserves atomically against actual plus concurrent holds and settles once at actual cost", async () => {
    const storage = createDOStorage();
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: "reservation-test-secret" } as never);
    await space.fetch(new Request("https://space/projects/p/spend"));
    storage.sql.exec("INSERT INTO projects (id,space_id,name,daily_spend_cap_credits) VALUES (?,?,?,?)", "p", "s", "Test", 100);
    const post = (body: Record<string, unknown>) => space.fetch(new Request("https://space/projects/p/spend", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

    const first = await post({ action: "reserve", reservation_id: "run-a:1", run_id: "run-a", credits: 60 });
    expect(first.status).toBe(200);
    expect((await post({ action: "reserve", reservation_id: "run-a:1", run_id: "run-a", credits: 60 })).status).toBe(200);
    expect((await post({ action: "reserve", reservation_id: "run-b:1", run_id: "run-b", credits: 50 })).status).toBe(402);
    expect((await post({ action: "reserve", reservation_id: "run-b:1", run_id: "run-b", credits: 40 })).status).toBe(200);

    expect((await post({ action: "settle_run", run_id: "run-a", credits: 55 })).status).toBe(200);
    await expect((await post({ action: "settle_run", run_id: "run-a", credits: 55 })).json()).resolves.toMatchObject({ deduplicated: true, spent_today: 55 });
    const gate = await (await space.fetch(new Request("https://space/projects/p/spend"))).json() as { spent_today: number; reserved_today: number; capped: boolean };
    expect(gate).toMatchObject({ spent_today: 55, reserved_today: 40, capped: false });
    expect((await post({ action: "release_run", run_id: "run-b" })).status).toBe(200);
    const afterRelease = await (await space.fetch(new Request("https://space/projects/p/spend"))).json() as { spent_today: number; reserved_today: number };
    expect(afterRelease).toMatchObject({ spent_today: 55, reserved_today: 0 });
    expect((await post({ action: "settle_run", run_id: "run-a", credits: 999 })).status).toBe(200);
    expect(storage.sql.exec<{ credits: number }>("SELECT credits FROM project_spend WHERE project_id='p'").toArray()).toEqual([{ credits: 55 }]);
  });
});
