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
