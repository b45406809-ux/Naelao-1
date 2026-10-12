import { describe, expect, it, vi } from "vitest";
import { SpaceDO } from "./SpaceDO.js";

describe("verified executive contact lookup", () => {
  it("returns only contacts whose owner/admin membership is still active", async () => {
    const exec = vi.fn((query: string) => ({
      toArray: () => query.includes("FROM executive_contacts ec")
        ? [{ user_id: "owner-1", channel: "whatsapp", contact_id: "+15551234567" }]
        : [],
      rowsWritten: 1,
    }));
    const instance = new SpaceDO({
      storage: { sql: { exec }, transactionSync: (fn: () => unknown) => fn(), deleteAlarm: async () => undefined, setAlarm: async () => undefined },
    } as never, {} as never);

    const response = await instance.fetch(new Request("https://space/internal/executive-contacts?space_id=space-1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ user_id: "owner-1", channel: "whatsapp", contact_id: "+15551234567" }] });
    expect(exec).toHaveBeenCalledWith(expect.stringContaining("sm.role IN ('owner','admin')"), "space-1");
  });

  it("matches Meta's digit-only WhatsApp sender to a saved E.164 number", async () => {
    let query = "";
    let params: unknown[] = [];
    const exec = vi.fn((sql: string, ...values: unknown[]) => {
      query = sql; params = values;
      return { toArray: () => [{ user_id: "owner-1", role: "owner" }], rowsWritten: 1 };
    });
    const instance = new SpaceDO({ storage: { sql: { exec }, transactionSync: (fn: () => unknown) => fn(), deleteAlarm: async () => undefined, setAlarm: async () => undefined } } as never, {} as never);
    const response = await instance.fetch(new Request("https://space/internal/executive/verify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ space_id: "space-1", channel: "whatsapp", contact_id: "15551234567" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ verified: true, member: { user_id: "owner-1" } });
    expect(query).toContain("REPLACE(ec.contact_id, '+', '')=?");
    expect(params).toEqual(["space-1", "whatsapp", "15551234567"]);
  });
});
