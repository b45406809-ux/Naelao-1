import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { SpaceDO } from "./SpaceDO.js";
describe("revisioned voice preferences in SpaceDO", () => {
  function fixture() {
    const storage = createDOStorage();
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: "voice-test" } as never);
    const call = (project?: string, body?: unknown) => space.fetch(new Request(`http://space/assistant-voice?space_id=s${project ? `&project_id=${project}` : ""}`, body === undefined ? undefined : { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { storage, call };
  }
  it("atomically rejects stale edits and merges partial edits", async () => {
    const { call } = fixture();
    expect((await call(undefined, { revision: 0, preferences: { enabled: true, language: "fr" } })).status).toBe(200);
    expect((await call(undefined, { revision: 0, preferences: { language: "en" } })).status).toBe(409);
    const r = await call(undefined, { revision: 1, preferences: { speed: 1.2 } });
    expect(await r.json()).toMatchObject({ revision: 2, preferences: { enabled: true, language: "fr", speed: 1.2 } });
  });
  it("preserves inherited Project limits and honors the Space lock", async () => {
    const { call, storage } = fixture();
    await call();
    storage.sql.exec("INSERT INTO projects(id,space_id,name) VALUES('p','s','Project')");
    await call(undefined, { revision: 0, preferences: { enabled: true, maxCallCostUsd: 1 } });
    expect(await (await call("p", { revision: 0, preferences: { maxCallCostUsd: 100 } })).json()).toMatchObject({ preferences: { maxCallCostUsd: 1 } });
    await call(undefined, { revision: 1, preferences: { allowProjectOverrides: false } });
    expect((await call("p", { revision: 1, preferences: { enabled: false } })).status).toBe(409);
    expect((await call("unknown")).status).toBe(404);
  });
  it("rejects arbitrary profiles and malformed payloads without mutation", async () => {
    const { call } = fixture();
    expect((await call(undefined, { revision: 0, preferences: { voiceProfileId: "other-tenant-voice" } })).status).toBe(409);
    expect((await call(undefined, { revision: 0, preferences: { speed: 100 } })).status).toBe(400);
    expect(await (await call()).json()).toMatchObject({ revision: 0 });
  });
  it("lists only host-approved voices and accepts a model-matched preset", async () => {
    const { call } = fixture();
    const initial = await (await call()).json() as { voiceCatalog: Array<{ id: string; modelClass: string }> };
    expect(initial.voiceCatalog.some((v) => v.id === "economy-eve" && v.modelClass === "economy")).toBe(true);
    expect((await call(undefined, { revision: 0, preferences: { modelClass: "balanced", voiceProfileId: "balanced-harper" } })).status).toBe(200);
    expect((await call(undefined, { revision: 1, preferences: { modelClass: "advanced" } })).status).toBe(409);
    expect((await call(undefined, { revision: 1, preferences: { customVoicesEnabled: true } })).status).toBe(409);
  });
});
