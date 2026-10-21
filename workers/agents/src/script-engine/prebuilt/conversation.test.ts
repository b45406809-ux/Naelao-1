import { describe, expect, it } from "vitest";
import { conversation } from "./conversation.js";
import type { PrebuiltOpContext } from "./index.js";

function context(
  fetch: (request: Request) => Promise<Response>,
  currentSessionId = "thread-1"
): PrebuiltOpContext {
  return {
    env: {
      scriptsBucket: {} as R2Bucket,
      spacesWorker: { fetch } as unknown as Fetcher,
      spaceId: "space-1",
      projectId: "project-1",
      tenantId: "tenant-1",
      agentId: "agent-1",
      currentSessionId,
      platformSecret: "test-secret",
    },
    run: async () => undefined,
  };
}

type Message = {
  id: string;
  role: string;
  content: string;
  created_at: string;
};

function messages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `message-${i + 1}`,
    role: i % 2 ? "assistant" : "user",
    content:
      i === 0
        ? "The ancient copper telescope was packed away."
        : `Ordinary transcript item ${i + 1}`,
    created_at: new Date(1_700_000_000_000 + i).toISOString(),
  }));
}

function pagedFetch(all: Message[]) {
  const requests: URL[] = [];
  const fetch = async (request: Request) => {
    const url = new URL(request.url);
    requests.push(url);
    const beforeId = url.searchParams.get("before_id");
    const beforeIndex = beforeId
      ? Number(beforeId.replace("message-", "")) - 1
      : all.length;
    const page = all.slice(Math.max(0, beforeIndex - 100), beforeIndex);
    return Response.json({ data: page, cursor_applied: !beforeId || all.some((message) => message.id === beforeId) });
  };
  return { fetch, requests };
}

describe("conversation.search", () => {
  it("pages past 500 messages and finds an early message with the complete transcript position", async () => {
    const all = messages(1_234);
    const api = pagedFetch(all);
    const result = (await conversation.operations["conversation.search"](
      { query: "copper telescope" },
      context(api.fetch)
    )) as {
      complete: boolean;
      searched_messages: number;
      results: Array<{ position: string }>;
    };

    expect(result.complete).toBe(true);
    expect(result.searched_messages).toBe(1_234);
    expect(result.results[0]?.position).toBe("1 of 1234");
    expect(api.requests.length).toBe(13);
    expect(
      api.requests.every((url) => url.searchParams.get("limit") === "100")
    ).toBe(true);
    expect(api.requests[0]?.searchParams.get("scope_project_id")).toBe(
      "project-1"
    );
  });

  it("continues a short byte-trimmed page when the message service says older rows remain", async () => {
    const calls: string[] = [];
    const result = (await conversation.operations["conversation.search"](
      { query: "copper telescope" },
      context(async (request) => {
        const beforeId = new URL(request.url).searchParams.get("before_id") ?? "";
        calls.push(beforeId);
        if (!beforeId) return Response.json({ data: [messages(2)[1]], has_more: true });
        return Response.json({ data: [{ id: "message-1", role: "user", content: "The ancient copper telescope was packed away." }], has_more: false, cursor_applied: true });
      })
    )) as { complete: boolean; searched_messages: number; results: Array<{ message_id: string }> };
    expect(result).toMatchObject({ complete: true, searched_messages: 2 });
    expect(result.results[0]?.message_id).toBe("message-1");
    expect(calls).toEqual(["", "message-2"]);
  });

  it("refuses a model supplied session outside the host authorized thread", async () => {
    let calls = 0;
    const result = (await conversation.operations["conversation.search"](
      { query: "copper telescope", session_id: "another-thread" },
      context(async () => {
        calls++;
        return Response.json({ data: [] });
      })
    )) as { ok: boolean; reason: string };
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("current authorized conversation");
    expect(calls).toBe(0);
  });

  it("keeps Unicode words searchable", async () => {
    const transcript = [
      {
        id: "message-1",
        role: "user",
        content: "Retrouve l’éléphant bleu",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    const result = (await conversation.operations["conversation.search"](
      { query: "éléphant" },
      context(async () => Response.json({ data: transcript }))
    )) as { results: Array<{ excerpt: string }> };
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.excerpt).toContain("éléphant");
  });

  it("finds short technical identifiers such as R2", async () => {
    const result = (await conversation.operations["conversation.search"](
      { query: "R2" },
      context(async () =>
        Response.json({
          data: [
            {
              id: "message-1",
              role: "user",
              content: "Keep the report in R2",
              created_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        })
      )
    )) as { results: Array<{ excerpt: string }> };
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.excerpt).toContain("R2");
  });

  it("searches a host scoped channel transcript that is not stored in SpaceDO", async () => {
    let spacesCalls = 0;
    const ctx = context(async () => {
      spacesCalls++;
      return new Response("not found", { status: 404 });
    });
    ctx.env.loadCurrentConversation = async () => ({
      messages: [
        {
          id: "channel-event-1",
          role: "user",
          content: "The account was frozen after the transfer",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      complete: true,
    });
    const result = (await conversation.operations["conversation.search"](
      { query: "account frozen" },
      ctx
    )) as { complete: boolean; results: Array<{ excerpt: string }> };
    expect(result.complete).toBe(true);
    expect(result.results[0]?.excerpt).toContain("account was frozen");
    expect(spacesCalls).toBe(0);
  });

  it("passes older-page cursors to the host-owned channel transcript reader", async () => {
    let received: { beforeId?: string; limit?: number } | undefined;
    const ctx = context(async () => Response.json({ data: [] }));
    ctx.env.loadCurrentConversation = async (options) => {
      received = options;
      return {
        messages: [{ id: "channel-event-4", role: "user", content: "An old renewal reference" }],
        complete: true,
      };
    };
    const result = (await conversation.operations["conversation.search"](
      { query: "renewal reference", before_id: "channel-event-5", scan_limit: 200 },
      ctx
    )) as { complete: boolean; results: Array<{ message_id: string }> };
    expect(received).toEqual({ beforeId: "channel-event-5", limit: 200 });
    expect(result.complete).toBe(true);
    expect(result.results[0]?.message_id).toBe("channel-event-4");
  });

  it("does not report an incomplete or failed scan as proof that a topic was never discussed", async () => {
    let call = 0;
    const result = (await conversation.operations["conversation.search"](
      { query: "copper telescope" },
      context(async () => {
        call++;
        return call === 1
          ? Response.json({ data: messages(100) })
          : new Response("unavailable", { status: 503 });
      })
    )) as { ok: boolean; complete: boolean; reason: string };
    expect(result).toMatchObject({ ok: false, complete: false });
    expect(result.reason).toContain("503");
  });

  it("does not treat an empty page with has_more as proof the transcript is exhausted", async () => {
    const result = (await conversation.operations["conversation.search"](
      { query: "missing topic" },
      context(async () => Response.json({ data: [], has_more: true }))
    )) as { ok: boolean; complete: boolean; reason: string };
    expect(result).toMatchObject({ ok: false, complete: false });
    expect(result.reason).toContain("empty page while older messages remain");
  });

  it("does not silently restart at the newest page when an older-page cursor is stale", async () => {
    const result = (await conversation.operations["conversation.search"](
      { query: "copper telescope", before_id: "deleted-message" },
      context(async () => Response.json({ data: messages(100), cursor_applied: false }))
    )) as { ok: boolean; complete: boolean; reason: string };
    expect(result.ok).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("cursor is no longer valid");
  });

  it("does not mark the scan complete when the overflow probe reports a stale cursor", async () => {
    let call = 0;
    const result = (await conversation.operations["conversation.search"](
      { query: "missing topic", scan_limit: 50 },
      context(async () => {
        call++;
        return call === 1
          ? Response.json({ data: messages(50), has_more: true })
          : Response.json({ data: [], cursor_applied: false });
      })
    )) as { ok: boolean; complete: boolean; note: string };
    expect(result).toMatchObject({ ok: true, complete: false });
    expect(result.note).toContain("incomplete");
  });

  it("keeps the newest suffix and resumes before its oldest row at a mid-page byte-budget boundary", async () => {
    const pageFor = (beforeId: string | null) => {
      const newest = beforeId ? Number(beforeId.replace("message-", "")) - 1 : 99;
      const first = newest - 4;
      return Array.from({ length: 5 }, (_, offset) => {
        const id = first + offset;
        return {
          id: `message-${id}`,
          role: "user",
          content: id === 18 ? `boundary marker ${"x".repeat(199_980)}` : "x".repeat(200_000),
        };
      }).filter((message) => Number(message.id.replace("message-", "")) >= 0);
    };
    const fetch = async (request: Request) => {
      const beforeId = new URL(request.url).searchParams.get("before_id");
      const page = pageFor(beforeId);
      return Response.json({
        data: page,
        has_more: page.length > 0 && Number(page[0]!.id.replace("message-", "")) > 0,
        cursor_applied: true,
      });
    };
    const firstPage = (await conversation.operations["conversation.search"](
      { query: "boundary marker" },
      context(fetch)
    )) as { complete: boolean; next_cursor?: string; results: Array<{ message_id: string }> };
    expect(firstPage.complete).toBe(false);
    expect(firstPage.next_cursor).toBe("message-17");

    const continuation = (await conversation.operations["conversation.search"](
      { query: "boundary marker", before_id: firstPage.next_cursor },
      context(fetch)
    )) as { complete: boolean; searched_messages: number; results: Array<{ message_id: string }> };
    expect(continuation.complete).toBe(true);
    expect(continuation.searched_messages).toBeGreaterThan(0);
    expect(continuation.results).toEqual([]);
  });

  it("retains the newest contiguous messages at the byte ceiling and resumes into the dropped older prefix", async () => {
    const all = Array.from({ length: 100 }, (_, index) => ({
      id: `message-${index + 1}`,
      role: "user",
      content: `boundary marker ${"x".repeat(200_000)}`,
      created_at: new Date(1_700_000_000_000 + index).toISOString(),
    }));
    const fetch = async (request: Request) => {
      const beforeId = new URL(request.url).searchParams.get("before_id");
      const beforeIndex = beforeId ? Number(beforeId.replace("message-", "")) - 1 : all.length;
      return Response.json({
        data: all.slice(Math.max(0, beforeIndex - 5), beforeIndex),
        cursor_applied: true,
        has_more: beforeIndex > 0,
      });
    };
    const first = (await conversation.operations["conversation.search"](
      { query: "boundary marker" }, context(fetch)
    )) as { complete: boolean; next_cursor?: string; results: Array<{ message_id: string }> };
    expect(first.complete).toBe(false);
    expect(first.results[0]?.message_id).toBe("message-100");
    expect(first.next_cursor).toBe("message-18");

    const continuation = (await conversation.operations["conversation.search"](
      { query: "boundary marker", before_id: first.next_cursor }, context(fetch)
    )) as { complete: boolean; results: Array<{ message_id: string }> };
    expect(continuation.complete).toBe(true);
    expect(continuation.results[0]?.message_id).toBe("message-17");
  });

  it("reports a history scan incomplete when the first host-owned message exceeds the byte budget", async () => {
    const ctx = context(async () => Response.json({ data: [] }));
    ctx.env.loadCurrentConversation = async () => ({
      messages: [{ id: "large-message", role: "user", content: "x".repeat(16 * 1024 * 1024 + 1) }],
      complete: true,
    });
    const result = (await conversation.operations["conversation.search"](
      { query: "anything" },
      ctx
    )) as { ok: boolean; complete: boolean; exhausted: boolean; note: string };
    expect(result.ok).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.exhausted).toBe(false);
    expect(result.note).toContain("stopped before it could read any messages");
  });

  it("chains only matched current-thread excerpts into the selected document processor", async () => {
    const api = pagedFetch([
      {
        id: "message-1",
        role: "user",
        content: "We approved a 30 day retention window.",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "message-2",
        role: "assistant",
        content: "Unrelated discussion about the color palette.",
        created_at: "2026-01-01T00:00:01.000Z",
      },
    ]);
    const ctx = context(api.fetch);
    const calls: Array<{ operation: string; params: Record<string, unknown> }> = [];
    ctx.run = async (operation, params) => {
      calls.push({ operation, params });
      return { summary: "The approved retention window is 30 days." };
    };

    const result = (await conversation.operations["conversation.research"](
      { query: "retention window", process: "summarize" },
      ctx
    )) as { ok: boolean; derived: unknown; derivation: { source_message_ids: string[] } };

    expect(result.ok).toBe(true);
    expect(result.derived).toEqual({ summary: "The approved retention window is 30 days." });
    expect(result.derivation.source_message_ids).toEqual(["message-1"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.operation).toBe("document.summarize");
    expect(calls[0]?.params["sourceId"]).toContain("thread-1");
    expect(calls[0]?.params["text"]).toContain("30 day retention window");
    expect(calls[0]?.params["text"]).not.toContain("color palette");
  });

  it("does not make a claim of absence when its bounded scan stops early", async () => {
    const api = pagedFetch(messages(10_001));
    const result = (await conversation.operations["conversation.search"](
      { query: "missing topic" },
      context(api.fetch)
    )) as { complete: boolean; note: string };
    expect(result.complete).toBe(false);
    expect(result.note).toContain("search was incomplete");
  });

  it("distinguishes a transcript exactly at the scan ceiling from one beyond it", async () => {
    const api = pagedFetch(messages(10_000));
    const result = (await conversation.operations["conversation.search"](
      { query: "missing topic" },
      context(api.fetch)
    )) as { complete: boolean; searched_messages: number };
    expect(result).toMatchObject({ complete: true, searched_messages: 10_000 });
  });
});
