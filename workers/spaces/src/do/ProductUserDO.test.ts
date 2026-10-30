import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { ProductUserDO } from "./ProductUserDO.js";

describe("ProductUserDO sessions and stored-value retirement", () => {
  it("does not expose stored-value credit wallet endpoints", async () => {
    const user = new ProductUserDO({ storage: createDOStorage() } as never, {} as never);
    for (const [path, method] of [
      ["/credits/balance", "GET"], ["/credits/grant", "POST"], ["/credits/deduct", "POST"],
      ["/credits/clawback", "POST"], ["/credits/reservations", "POST"],
    ] as const) {
      const response = await user.fetch(new Request(`https://user${path}`, { method }));
      expect(response.status).toBe(404);
    }
  });

  it("bounds session growth and rejects malformed session input", async () => {
    const user = new ProductUserDO({ storage: createDOStorage() } as never, {} as never);
    const post = (path: string, body: string) => user.fetch(new Request(`https://user${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body,
    }));

    expect((await post("/sessions", "{" )).status).toBe(400);
    expect((await post("/sessions", JSON.stringify({ auth_provider: "x".repeat(65) }))).status).toBe(400);
    for (let i = 0; i < 100; i++) expect((await post("/sessions", "{}" )).status).toBe(201);
    expect((await post("/sessions", "{}" )).status).toBe(429);
  });

  it("enforces the active-session ceiling under parallel session creation", async () => {
    const user = new ProductUserDO({ storage: createDOStorage() } as never, {} as never);
    const responses = await Promise.all(Array.from({ length: 120 }, () => user.fetch(new Request("https://user/sessions", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }))));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(100);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(20);
    const rows = await Promise.all(responses.filter((response) => response.status === 201).map((response) => response.json()));
    expect(new Set(rows.map((row) => (row as { session_id: string }).session_id)).size).toBe(100);
  });

  it("paginates conversation metadata and bounds user-controlled stored values", async () => {
    const user = new ProductUserDO({ storage: createDOStorage() } as never, {} as never);
    const post = (path: string, body: unknown) => user.fetch(new Request(`https://user${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    for (const thread_id of ["thread-a", "thread-b", "thread-c"]) {
      expect((await post("/conversation-refs", { thread_id, space_id: "space-a", title: "title" })).status).toBe(201);
    }
    expect((await user.fetch(new Request("https://user/conversation-refs?limit=101"))).status).toBe(400);
    const first = await (await user.fetch(new Request("https://user/conversation-refs?limit=2"))).json() as { data: Array<{ thread_id: string }>; next_cursor: string };
    expect(first.data).toHaveLength(2);
    const second = await (await user.fetch(new Request(`https://user/conversation-refs?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`))).json() as { data: Array<{ thread_id: string }> };
    expect(second.data).toHaveLength(1);
    expect(new Set([...first.data, ...second.data].map((row) => row.thread_id)).size).toBe(3);
    expect((await user.fetch(new Request("https://user/conversation-refs?cursor=not-base64!"))).status).toBe(400);
    expect((await user.fetch(new Request(`https://user/conversation-refs?cursor=${"a".repeat(2050)}`))).status).toBe(400);
    const pref = (value: unknown) => user.fetch(new Request("https://user/preferences", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }));
    expect((await pref({ key: "x".repeat(129), value: true })).status).toBe(400);
    expect((await pref({ key: "large", value: "x".repeat(16 * 1024) })).status).toBe(413);
    for (let i = 0; i < 500; i++) expect((await pref({ key: `key-${i}`, value: i })).status).toBe(200);
    expect((await pref({ key: "key-overflow", value: true })).status).toBe(429);
    const notify = (payload: unknown) => user.fetch(new Request("https://user/notifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload }) }));
    for (let i = 0; i < 3; i++) expect((await notify({ i })).status).toBe(201);
    const notificationPage = await (await user.fetch(new Request("https://user/notifications?limit=2"))).json() as { data: Array<{ id: string }>; next_cursor: string };
    expect(notificationPage.data).toHaveLength(2);
    const notificationTail = await (await user.fetch(new Request(`https://user/notifications?cursor=${encodeURIComponent(notificationPage.next_cursor)}`))).json() as { data: Array<{ id: string }> };
    expect(notificationTail.data).toHaveLength(1);
    expect((await user.fetch(new Request(`https://user/notifications?cursor=${"a".repeat(2050)}`))).status).toBe(400);
  });
});
