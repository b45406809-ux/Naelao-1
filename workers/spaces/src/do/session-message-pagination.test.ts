import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { SpaceDO } from "./SpaceDO.js";

describe("session message pagination under long transcripts", () => {
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
});
