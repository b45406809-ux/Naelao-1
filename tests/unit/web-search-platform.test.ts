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
  // Keeps the RAW value, never String(value). A fake that stringifies would turn a Uint8Array into
  // "[object Uint8Array]" and silently pass a binary-write bug — which is precisely how a
  // download that corrupted every PDF could look green here.
  function makeR2() {
    const store = new Map<string, { content: string | Uint8Array; meta: Record<string, string> | undefined; contentType?: string }>();
    const bucket = {
      async put(
        key: string,
        value: unknown,
        opts?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } }
      ) {
        const raw = value instanceof Uint8Array ? value : String(value);
        store.set(key, { content: raw, meta: opts?.customMetadata, contentType: opts?.httpMetadata?.contentType });
        return {} as R2Object;
      },
      async get(key: string) {
        const row = store.get(key);
        if (!row) return null;
        const text = typeof row.content === "string" ? row.content : new TextDecoder().decode(row.content);
        return { size: text.length, uploaded: new Date(), async text() { return text; } } as unknown as R2ObjectBody;
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

  // Live bug: a GitHub 502 was saved into the workspace as a 16-byte `README.md` whose entire
  // content was "error code: 502", and the agent reported the download as successful. A failing
  // server still sends a body, and only "was there content" was being checked.
  it("does NOT save an error page: a non-2xx status is a failed download whatever body came with it", async () => {
    const { bucket, store } = makeR2();
    const capture: Capture = {};
    const env = makeDownloadEnv(
      capture,
      () => ({ url: "https://x.com/f", status: 502, content: "error code: 502\n", size: 16, encoding: "text", content_type: "text/plain" }),
      bucket
    );

    const out = (await webSearch.operations["download_file"]!({ url: "https://x.com/f" }, { env, run: noopRun })) as {
      ok: boolean; status: number; error: string; body_preview: string;
    };
    expect(out.ok).toBe(false);
    expect(out.status).toBe(502);
    expect(out.error).toContain("502");
    // The body is surfaced so the agent can say WHY, but never written to the workspace.
    expect(out.body_preview).toContain("error code: 502");
    expect(store.size).toBe(0);
  });

  it("a 404 page is likewise refused rather than stored as the file", async () => {
    const { bucket, store } = makeR2();
    const capture: Capture = {};
    const env = makeDownloadEnv(
      capture,
      () => ({ url: "https://x.com/missing.pdf", status: 404, content: "<html>Not Found</html>", size: 22, encoding: "text" }),
      bucket
    );

    const out = (await webSearch.operations["download_file"]!({ url: "https://x.com/missing.pdf" }, { env, run: noopRun })) as { ok: boolean };
    expect(out.ok).toBe(false);
    expect(store.size).toBe(0);
  });

  it("requires url", async () => {
    const env = { tenantId: "t", platformSecret: PLATFORM_SECRET } as unknown as ScriptEngineEnv;
    await expect(webSearch.operations["download_file"]!({}, { env, run: noopRun })).rejects.toThrow(/url/);
  });

  // The live bug this covers: downloading a PDF returned "415 ... only handles text". Downloading
  // a paper or an image is the entire point of the op, so a base64 payload must round-trip to the
  // REAL bytes in R2 — writing the base64 string itself would store a file that is neither the
  // original nor readable as text.
  it("decodes a base64 binary download back to real bytes and records its content type", async () => {
    const { bucket, store } = makeR2();
    const capture: Capture = {};
    // A real (tiny) PDF header — bytes that are NOT valid UTF-8 text, so a stringified write is
    // detectable rather than coincidentally equal.
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x80, 0xff, 0x00, 0x01]);
    const b64 = btoa(String.fromCharCode(...pdfBytes));
    const env = makeDownloadEnv(capture, () => ({
      url: "https://arxiv.org/pdf/1706.03762.pdf", status: 200,
      encoding: "base64", content_type: "application/pdf", content: b64, size: pdfBytes.byteLength, truncated: false,
    }), bucket);

    const out = (await webSearch.operations["download_file"]!(
      { url: "https://arxiv.org/pdf/1706.03762.pdf", filename: "attention_is_all_you_need.pdf" },
      { env, run: noopRun }
    )) as { ok: boolean; path: string; size: number; binary: boolean; content_type: string | null };

    expect(out.ok).toBe(true);
    expect(out.binary).toBe(true);
    expect(out.content_type).toBe("application/pdf");
    expect(out.path).toBe("downloads/attention_is_all_you_need.pdf");

    const written = [...store.entries()].find(([k]) => k.endsWith("downloads/attention_is_all_you_need.pdf"));
    expect(written).toBeDefined();
    const body = written![1].content;
    expect(body).toBeInstanceOf(Uint8Array);
    expect([...(body as Uint8Array)]).toEqual([...pdfBytes]);
    expect(written![1].contentType).toBe("application/pdf");
  });

  it("still writes a text download as a plain string, unchanged", async () => {
    const { bucket, store } = makeR2();
    const capture: Capture = {};
    const env = makeDownloadEnv(capture, () => ({
      url: "https://x.com/a.csv", status: 200, encoding: "text", content_type: "text/csv", content: "a,b\n1,2", size: 7,
    }), bucket);

    const out = (await webSearch.operations["download_file"]!({ url: "https://x.com/a.csv" }, { env, run: noopRun })) as { binary: boolean };
    expect(out.binary).toBe(false);
    const written = [...store.entries()].find(([k]) => k.endsWith("downloads/a.csv"));
    expect(written![1].content).toBe("a,b\n1,2");
  });
});
