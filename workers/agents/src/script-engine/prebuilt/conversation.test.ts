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
    return Response.json({ data: page });
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
