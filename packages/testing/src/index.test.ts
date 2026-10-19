import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryD1, InMemoryKV, InMemoryQueue } from "./index.js";

afterEach(() => vi.restoreAllMocks());

describe("shared test doubles", () => {
  it("updates stored D1 row values as well as reporting changed rows", async () => {
    const db = new InMemoryD1();
    db.seed("sessions", [
      { id: "s1", tenant_id: "tenant-a", status: "active" },
    ]);

    const result = await db
      .prepare("UPDATE sessions SET status = ? WHERE id = ? AND tenant_id = ?")
      .bind("closed", "s1", "tenant-a")
      .run();

    expect(result.meta.changes).toBe(1);
    await expect(
      db.prepare("SELECT * FROM sessions WHERE id = ?").bind("s1").first()
    ).resolves.toMatchObject({ status: "closed" });
  });

  it("does not update rows outside the bound tenant filter", async () => {
    const db = new InMemoryD1();
    db.seed("sessions", [
      { id: "s1", tenant_id: "tenant-a", status: "active" },
      { id: "s1", tenant_id: "tenant-b", status: "active" },
    ]);

    const result = await db
      .prepare("UPDATE sessions SET status = ? WHERE id = ? AND tenant_id = ?")
      .bind("closed", "s1", "tenant-a")
      .run();

    expect(result.meta.changes).toBe(1);
    const rows = (
      await db.prepare("SELECT * FROM sessions WHERE id = ?").bind("s1").all()
    ).results;
    expect(rows).toEqual([
      { id: "s1", tenant_id: "tenant-a", status: "closed" },
      { id: "s1", tenant_id: "tenant-b", status: "active" },
    ]);
  });

  it("expires KV entries exactly at their TTL boundary", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const kv = new InMemoryKV();
    await kv.put("short", "value", { expirationTtl: 1 });
    now.mockReturnValue(2_000);
    await expect(kv.get("short")).resolves.toBeNull();
  });

  it("keeps queue send order and returns compatible bindings", async () => {
    const queue = new InMemoryQueue();
    await queue.send({ id: 1 });
    await queue.send({ id: 2 });
    expect(queue.asQueue()).toBe(queue);
    expect(queue.messages).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
