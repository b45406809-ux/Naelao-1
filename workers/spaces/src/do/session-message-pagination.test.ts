import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { SpaceDO } from "./SpaceDO.js";

describe("session message pagination under long transcripts", () => {
  it("rejects an oversized message request before parsing its JSON body", async () => {
    const storage = createDOStorage();
    const space = new SpaceDO(
      { storage } as never,
      { PLATFORM_SECRET: "pagination-test-secret" } as never
    );
    const response = await space.fetch(new Request(
      "http://space/sessions/large-thread/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "user", content: "x".repeat(1024 * 1024) }),
      }
    ));

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error_code: "request_body_too_large" });
  });

  it("caps large serialized pages and exposes a contiguous continuation cursor", async () => {
    const storage = createDOStorage();
    const space = new SpaceDO(
      { storage } as never,
      { PLATFORM_SECRET: "pagination-test-secret" } as never
    );
    const base = "http://space/sessions/large-thread/messages";
    await space.fetch(new Request(`${base}?limit=1`));
    storage.sql.exec(
      "INSERT INTO sessions(id,space_id,tenant_id) VALUES(?,?,?)",
      "large-thread",
      "space-a",
      "tenant-a"
    );
    const content = "x".repeat(100_000);
    for (let i = 1; i <= 20; i++) {
      storage.sql.exec(
        "INSERT INTO messages(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)",
        `large-${i}`,
        "large-thread",
        "user",
        content,
        `2026-10-18T00:00:${String(i).padStart(2, "0")}.000Z`
      );
    }

    const requestPage = async (beforeId?: string) => {
      const url = new URL(`${base}?limit=20&scope_space_id=space-a&scope_project_id=&scope_thread_id=large-thread`);
      if (beforeId) url.searchParams.set("before_id", beforeId);
      const response = await space.fetch(new Request(url));
      const serialized = await response.text();
      expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(1024 * 1024);
      return JSON.parse(serialized) as {
        data: Array<{ id: string }>;
        total_count: number;
        total_content_chars: number;
        has_more: boolean;
        next_before_id: string | null;
      };
    };
    const newest = await requestPage();
    expect(newest.data.length).toBeLessThan(20);
    expect(newest).toMatchObject({ total_count: 20, total_content_chars: 2_000_000, has_more: true });
    expect(newest.next_before_id).toBe(newest.data[0]?.id);
    const oldestShown = Number(newest.data[0]?.id.replace("large-", ""));
    const older = await requestPage(newest.next_before_id ?? undefined);
    expect(older.data.at(-1)?.id).toBe(`large-${oldestShown - 1}`);
  });

  it("pages 1,105 same-timestamp messages without duplicates or gaps and enforces structural scope", async () => {
    const storage = createDOStorage();
    const space = new SpaceDO(
      { storage } as never,
      { PLATFORM_SECRET: "pagination-test-secret" } as never
    );
    const base = "http://space/sessions/thread-a/messages";
    await space.fetch(new Request(`${base}?limit=1`)); // initialize migrations
    storage.sql.exec(
      "INSERT INTO sessions(id,space_id,tenant_id) VALUES(?,?,?)",
      "thread-a",
      "space-a",
      "tenant-a"
    );
    for (let i = 1; i <= 1_105; i++) {
      storage.sql.exec(
        "INSERT INTO messages(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)",
        `message-${i}`,
        "thread-a",
        i % 2 ? "user" : "assistant",
        `transcript ${i}`,
        "2026-10-18T00:00:00.000Z"
      );
    }

    const fetchPage = async (cursor?: string) => {
      const params = new URLSearchParams({
        limit: "500",
        scope_space_id: "space-a",
        scope_project_id: "",
        scope_thread_id: "thread-a",
      });
      if (cursor) params.set("before_id", cursor);
      const response = await space.fetch(new Request(`${base}?${params}`));
      expect(response.status).toBe(200);
      return (await response.json()) as { data: Array<{ id: string }>; total_count: number; total_content_chars: number };
    };
    const first = await fetchPage();
    const second = await fetchPage(first.data[0]?.id);
    const third = await fetchPage(second.data[0]?.id);
    const ids = [...third.data, ...second.data, ...first.data].map(
      (message) => message.id
    );

    expect([first.data.length, second.data.length, third.data.length]).toEqual([
      500, 500, 105,
    ]);
    expect(ids[0]).toBe("message-1");
    expect(ids.at(-1)).toBe("message-1105");
    expect(new Set(ids).size).toBe(1_105);
    expect(first.total_count).toBe(1_105);
    expect(first.total_content_chars).toBe(
      Array.from({ length: 1_105 }, (_, i) => `transcript ${i + 1}`).join("").length
    );

    // The context meter can request one row and still read an exact transcript-wide size.
    const usagePage = await space.fetch(new Request(`${base}?limit=1&scope_space_id=space-a&scope_project_id=&scope_thread_id=thread-a`));
    const usage = await usagePage.json<{ data: Array<{ id: string }>; total_count: number; total_content_chars: number }>();
    expect(usage.data).toHaveLength(1);
    expect(usage.total_count).toBe(1_105);
    expect(usage.total_content_chars).toBe(first.total_content_chars);

    const negativeLimit = await space.fetch(
      new Request(
        `${base}?limit=-1&scope_space_id=space-a&scope_project_id=&scope_thread_id=thread-a`
      )
    );
    expect((await negativeLimit.json<{ data: unknown[] }>()).data).toHaveLength(
      1
    );

    const wrongThread = await space.fetch(
      new Request(
        `${base}?scope_space_id=space-a&scope_project_id=another-project&scope_thread_id=thread-a`
      )
    );
    expect(wrongThread.status).toBe(404);
  });

  it("keeps ID cursor pages contiguous when created_at values arrive out of order", async () => {
    const storage = createDOStorage();
    const space = new SpaceDO(
      { storage } as never,
      { PLATFORM_SECRET: "pagination-test-secret" } as never
    );
    const base = "http://space/sessions/out-of-order/messages";
    await space.fetch(new Request(`${base}?limit=1`));
    storage.sql.exec(
      "INSERT INTO sessions(id,space_id,tenant_id) VALUES(?,?,?)",
      "out-of-order",
      "space-a",
      "tenant-a"
    );
    for (let i = 1; i <= 9; i++) {
      storage.sql.exec(
        "INSERT INTO messages(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)",
        `message-${i}`,
        "out-of-order",
        "user",
        `message ${i}`,
        `2026-10-18T00:00:${String(10 - i).padStart(2, "0")}.000Z`
      );
    }

    const fetchPage = async (cursor?: string) => {
      const params = new URLSearchParams({
        limit: "3",
        scope_space_id: "space-a",
        scope_project_id: "",
        scope_thread_id: "out-of-order",
      });
      if (cursor) params.set("before_id", cursor);
      const response = await space.fetch(new Request(`${base}?${params}`));
      expect(response.status).toBe(200);
      return (await response.json()) as { data: Array<{ id: string }>; has_more: boolean };
    };
    const newest = await fetchPage();
    const middle = await fetchPage(newest.data[0]?.id);
    const oldest = await fetchPage(middle.data[0]?.id);

    expect([...oldest.data, ...middle.data, ...newest.data].map((message) => message.id)).toEqual(
      Array.from({ length: 9 }, (_, index) => `message-${index + 1}`)
    );
    expect(newest.has_more).toBe(true);
    expect(middle.has_more).toBe(true);
    expect(oldest.has_more).toBe(false);
  });
});
