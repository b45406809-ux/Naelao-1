import { afterEach, describe, expect, it, vi } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { LockDO } from "./LockDO.js";

function harness() {
  const storage = createDOStorage();
  return { object: new LockDO({ storage } as never, {} as never), storage };
}

function post(object: LockDO, path: string, body: unknown) {
  return object.fetch(new Request(`https://lock${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

afterEach(() => vi.useRealTimers());

describe("LockDO lease bounds and expiry", () => {
  it("rejects malformed identities and invalid TTLs without mutating the lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { object, storage } = harness();
    expect((await object.fetch(new Request("https://lock/acquire", { method: "POST", body: "{" }))).status).toBe(400);
    for (const ttl_ms of [0, -1, 999, 86_400_001, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect((await post(object, "/acquire", { caller_id: "worker-a", ttl_ms })).status).toBe(400);
    }
    expect((await post(object, "/acquire", { caller_id: "../tenant", ttl_ms: 5000 })).status).toBe(400);
    expect(await storage.getAlarm()).toBeNull();
  });

  it("preserves the current lease when an older alarm fires after renewal", async () => {
    vi.useFakeTimers();
    const start = 1_000_000;
    vi.setSystemTime(start);
    const { object, storage } = harness();
    expect((await post(object, "/acquire", { caller_id: "worker-a", ttl_ms: 1000 })).status).toBe(200);
    expect(await storage.getAlarm()).toBe(start + 1000);
    await post(object, "/acquire", { caller_id: "worker-a", ttl_ms: 5000 });

    vi.setSystemTime(start + 1000);
    await object.alarm();
    expect(await storage.getAlarm()).toBe(start + 5000);
    expect(await (await object.fetch(new Request("https://lock/status"))).json()).toMatchObject({ locked: true, holder: "worker-a" });

    vi.setSystemTime(start + 5000);
    await object.alarm();
    expect(await storage.getAlarm()).toBeNull();
    expect(await (await object.fetch(new Request("https://lock/status"))).json()).toMatchObject({ locked: false });
  });

  it("allows one holder, denies another, and only releases for the owning caller", async () => {
    const { object } = harness();
    expect(await (await post(object, "/acquire", { caller_id: "worker-a" })).json()).toMatchObject({ acquired: true });
    expect(await (await post(object, "/acquire", { caller_id: "worker-b" })).json()).toMatchObject({ acquired: false, holder: "worker-a" });
    expect(await (await post(object, "/release", { caller_id: "worker-b" })).json()).toMatchObject({ released: false });
    expect(await (await post(object, "/release", { caller_id: "worker-a" })).json()).toMatchObject({ released: true });
  });
});
