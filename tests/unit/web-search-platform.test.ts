import { describe, it, expect } from "vitest";
import { webSearch } from "../../workers/agents/src/script-engine/prebuilt/web-search.js";
import { verifyInternalToken } from "@naelao/http";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

// CLAUDE.md "universal tools" principle: web search is PLATFORM-PROVIDED — Naelao holds ONE
// provider key (TAVILY_API_KEY, a Workers Secret on the knowledge worker) and every agent gets
// search for free, exactly like Claude/ChatGPT bundle it. It is NOT the BYO-key
// `space_credentials` model. The prebuilt proxies to the knowledge worker's HMAC-gated
// /internal/web-search/* routes; the provider key never reaches the agent isolate.

const PLATFORM_SECRET = "test-platform-secret";

interface Capture {
  path?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

function makeEnv(capture: Capture, respond: (path: string, body: unknown) => unknown): ScriptEngineEnv {
  const knowledgeWorker = {
    async fetch(reqInput: Request | string, init?: RequestInit) {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      capture.path = new URL(req.url).pathname;
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      capture.headers = headers;
      capture.body = await req.json().catch(() => ({}));
      return Response.json(respond(capture.path, capture.body));
    },
  };
  return {
    scriptsBucket: {} as never,
    spaceId: "space-1",
    tenantId: "tenant-1",
    agentId: "agent-1",
    platformSecret: PLATFORM_SECRET,
    knowledgeWorker: knowledgeWorker as unknown as Fetcher,
  } as unknown as ScriptEngineEnv;
}

const noopRun = async () => ({});

describe("web-search prebuilt — universal, platform-provided (no BYO key)", () => {
  it("search proxies to the knowledge worker with a verifiable tenant-scoped internal token", async () => {
    const capture: Capture = {};
    const env = makeEnv(capture, () => ({ configured: true, results: [{ title: "T", url: "https://x", content: "c", score: 1 }] }));

    const out = await webSearch.operations["search"]!({ query: "hello", max_results: 5 }, { env, run: noopRun });

    expect(capture.path).toBe("/internal/web-search/search");
    // The provider key is NEVER passed by the agent — only a query + a minted internal token.
    expect(capture.body).toMatchObject({ query: "hello", max_results: 5 });
    expect(JSON.stringify(capture.body)).not.toContain("api_key");

    const token = capture.headers?.["x-naelao-internal-token"];
    expect(token).toBeTruthy();
    expect(await verifyInternalToken(token!, "tenant-1", PLATFORM_SECRET)).toBe(true);
    expect(await verifyInternalToken(token!, "other-tenant", PLATFORM_SECRET)).toBe(false);

    expect(out).toMatchObject({ configured: true });
  });

  it("passes through honest configured:false degradation when the platform key is unset", async () => {
    const capture: Capture = {};
    const env = makeEnv(capture, () => ({ configured: false, results: [], message: "platform web search is not configured" }));

    const out = (await webSearch.operations["search"]!({ query: "hi" }, { env, run: noopRun })) as { configured: boolean };
    expect(out.configured).toBe(false);
  });

  it("fetch_page and extract_content proxy to their platform routes", async () => {
    const capture: Capture = {};
    const env = makeEnv(capture, (path) => ({ path }));

    await webSearch.operations["fetch_page"]!({ url: "https://example.com" }, { env, run: noopRun });
    expect(capture.path).toBe("/internal/web-search/fetch");
    expect(capture.body).toMatchObject({ url: "https://example.com" });

    await webSearch.operations["extract_content"]!({ url: "https://example.com" }, { env, run: noopRun });
    expect(capture.path).toBe("/internal/web-search/extract");
  });

  it("fails loudly when the knowledge worker binding is absent (never silently empty)", async () => {
    const env = { tenantId: "t", platformSecret: PLATFORM_SECRET } as unknown as ScriptEngineEnv;
    await expect(webSearch.operations["search"]!({ query: "x" }, { env, run: noopRun })).rejects.toThrow(/KNOWLEDGE_WORKER/);
  });
});

// download_file — a save-don't-read op, deliberately shaped differently from fetch_page/
// extract_content: it writes to R2 and returns metadata only, never the content itself, so a
// large download (up to 2MB) doesn't cost the reasoning payload anything.
describe("web-search prebuilt — download_file", () => {
  function makeR2() {
    const store = new Map<string, { content: string; meta: Record<string, string> | undefined }>();
    const bucket = {
      async put(key: string, value: unknown, opts?: { customMetadata?: Record<string, string> }) {
        store.set(key, { content: String(value), meta: opts?.customMetadata });
        return {} as R2Object;
      },
      async get(key: string) {
        const row = store.get(key);
        if (!row) return null;
        return { size: row.content.length, uploaded: new Date(), async text() { return row.content; } } as unknown as R2ObjectBody;
      },
    };
    return { bucket: bucket as unknown as R2Bucket, store };
  }

  function makeDownloadEnv(capture: Capture, respond: (body: unknown) => unknown, bucket: R2Bucket): ScriptEngineEnv {
    const knowledgeWorker = {
      async fetch(reqInput: Request | string, init?: RequestInit) {
        const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
        capture.path = new URL(req.url).pathname;
        capture.body = await req.json().catch(() => ({}));
        return Response.json(respond(capture.body));
      },
    };
    return {
      scriptsBucket: bucket,
      spaceId: "space-1",
      tenantId: "tenant-1",
      agentId: "agent-1",
      platformSecret: PLATFORM_SECRET,
      knowledgeWorker: knowledgeWorker as unknown as Fetcher,
    } as unknown as ScriptEngineEnv;
  }

  it("saves the downloaded content to R2 under downloads/ and returns metadata only, not the content", async () => {
    const { bucket, store } = makeR2();
    const capture: Capture = {};
    const env = makeDownloadEnv(capture, () => ({ url: "https://example.com/report.csv", status: 200, content: "a,b,c\n1,2,3", size: 11, truncated: false }), bucket);

    const out = (await webSearch.operations["download_file"]!({ url: "https://example.com/report.csv" }, { env, run: noopRun })) as {
      ok: boolean; path: string; size: number; truncated: boolean;
    };

    expect(capture.path).toBe("/internal/web-search/download");
    expect(out.ok).toBe(true);
    expect(out.path).toBe("downloads/report.csv");
    expect(out.size).toBe(11);
    expect(out.truncated).toBe(false);
    // The content itself must never appear in the tool result — only in R2.
    expect(JSON.stringify(out)).not.toContain("a,b,c");
    const written = [...store.entries()].find(([k]) => k.endsWith("downloads/report.csv"));
    expect(written?.[1].content).toBe("a,b,c\n1,2,3");
  });

  it("sanitizes an explicit filename and falls back to the URL's own last segment otherwise", async () => {
    const { bucket, store } = makeR2();
    const capture: Capture = {};
    const env = makeDownloadEnv(capture, () => ({ url: "https://x.com/f", status: 200, content: "data", size: 4 }), bucket);

    await webSearch.operations["download_file"]!({ url: "https://x.com/f", filename: "../../evil name!!.csv" }, { env, run: noopRun });
    const keys = [...store.keys()];
    // Every ".." run collapses to a single "_" and any leading "."/"_" is stripped — a filename
    // built from an attacker-influenced string can never even look like a traversal attempt.
    expect(keys.some((k) => k.endsWith("downloads/evil_name__.csv"))).toBe(true);
    expect(keys.some((k) => k.includes(".."))).toBe(false);
  });

  it("reports failure honestly when the download itself failed, without writing anything", async () => {
    const { bucket, store } = makeR2();
    const capture: Capture = {};
    const env = makeDownloadEnv(capture, () => ({ url: "https://x.com/f", status: 415, content: null, error: "looks binary" }), bucket);

    const out = (await webSearch.operations["download_file"]!({ url: "https://x.com/f" }, { env, run: noopRun })) as { ok: boolean; error: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("binary");
    expect(store.size).toBe(0);
  });

  it("requires url", async () => {
    const env = { tenantId: "t", platformSecret: PLATFORM_SECRET } as unknown as ScriptEngineEnv;
    await expect(webSearch.operations["download_file"]!({}, { env, run: noopRun })).rejects.toThrow(/url/);
  });
});
