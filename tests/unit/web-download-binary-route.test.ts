import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { checkSsrf } = vi.hoisted(() => ({
  checkSsrf: vi.fn(async () => ({ blocked: false as boolean })),
}));
vi.mock("@naelao/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@naelao/security")>();
  return { ...actual, checkSsrf };
});

import { mintInternalToken } from "@naelao/http";
import knowledgeWorker from "../../workers/knowledge/src/index.js";

// The live bug: downloading https://arxiv.org/pdf/1706.03762.pdf came back
//   "web-search /internal/web-search/download failed: 415"
// An earlier revision refused ANY binary content-type on the reasoning that `.text()` on binary
// bytes produces mojibake. That reasoning was right and the conclusion was wrong — the fix is to
// stop calling `.text()`, not to stop accepting the file types "download a file" actually means.
//
// These drive the REAL route (not the prebuilt), because the 415 was produced here.

const SECRET = "test-platform-secret";
const execCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

function makeEnv() {
  return {
    PLATFORM_SECRET: SECRET,
    ENVIRONMENT: "test",
    PLATFORM_DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => ({ config_json: "{}" })),
        })),
      })),
    },
    // The download route needs none of the KB bindings — it is a keyless SSRF-guarded GET.
  } as unknown as Parameters<typeof knowledgeWorker.fetch>[1];
}

async function call(url: string) {
  const token = await mintInternalToken(SECRET, "tenant-a");
  return knowledgeWorker.fetch(
    new Request("http://knowledge/internal/web-search/download", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-internal-token": token,
        "x-naelao-tenant-id": "tenant-a",
        "x-naelao-space-id": "space-a",
      },
      body: JSON.stringify({ url }),
    }),
    makeEnv(),
    execCtx
  );
}

const realFetch = globalThis.fetch;
beforeEach(() => checkSsrf.mockReset().mockResolvedValue({ blocked: false }));
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** Stand in for the remote server the route is downloading FROM. */
function mockRemote(
  bytes: Uint8Array | string,
  contentType: string,
  status = 200
) {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(typeof bytes === "string" ? bytes : bytes, {
        status,
        headers: { "content-type": contentType },
      })
  ) as unknown as typeof fetch;
}

describe("/internal/web-search/download — binary is first-class, not a 415", () => {
  it("returns a PDF as base64 rather than refusing it (the exact live repro)", async () => {
    const pdf = new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x80, 0xff, 0x00,
    ]);
    mockRemote(pdf, "application/pdf");

    const res = await call("https://arxiv.org/pdf/1706.03762.pdf");
    expect(res.status).toBe(200); // was 415

    const body = await res.json<{
      encoding: string;
      content: string;
      content_type: string;
      size: number;
    }>();
    expect(body.encoding).toBe("base64");
    expect(body.content_type).toBe("application/pdf");
    expect(body.size).toBe(pdf.byteLength);
    // Round-trips to the original bytes — not a lossy text decode.
    const decoded = Uint8Array.from(atob(body.content), (ch) =>
      ch.charCodeAt(0)
    );
    expect([...decoded]).toEqual([...pdf]);
  });

  it("returns an image as base64 too", async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    mockRemote(png, "image/png");

    const res = await call("https://example.com/logo.png");
    expect(res.status).toBe(200);
    const body = await res.json<{ encoding: string; content_type: string }>();
    expect(body.encoding).toBe("base64");
    expect(body.content_type).toBe("image/png");
  });

  it("still returns text as text, with a charset-suffixed content type parsed down to the bare type", async () => {
    mockRemote("a,b\n1,2", "text/csv; charset=utf-8");

    const res = await call("https://example.com/report.csv");
    const body = await res.json<{
      encoding: string;
      content: string;
      content_type: string;
    }>();
    expect(body.encoding).toBe("text");
    expect(body.content).toBe("a,b\n1,2");
    expect(body.content_type).toBe("text/csv");
  });

  it("treats application/json as text, not binary", async () => {
    mockRemote('{"ok":true}', "application/json");
    const body = await (await call("https://example.com/a.json")).json<{
      encoding: string;
      content: string;
    }>();
    expect(body.encoding).toBe("text");
    expect(body.content).toBe('{"ok":true}');
  });

  it("refuses an oversized binary outright instead of writing a corrupt half-file", async () => {
    // 13MB > the 12MB binary cap. Truncating a PDF does not make a smaller PDF, it makes a broken
    // one, so the honest answer is a refusal naming the real size.
    mockRemote(new Uint8Array(13_000_000), "application/pdf");

    const res = await call("https://example.com/huge.pdf");
    expect(res.status).toBe(413);
    const body = await res.json<{ content: string | null; error: string }>();
    expect(body.content).toBeNull();
    expect(body.error).toMatch(/13000000|limit/);
  });

  it("still blocks SSRF targets before fetching anything", async () => {
    checkSsrf.mockResolvedValueOnce({ blocked: true });
    globalThis.fetch = vi.fn(
      async () => new Response("nope")
    ) as unknown as typeof fetch;
    const res = await call("http://169.254.169.254/latest/meta-data/");
    expect(res.status).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects a caller with no internal token", async () => {
    const res = await knowledgeWorker.fetch(
      new Request("http://knowledge/internal/web-search/download", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/a.pdf" }),
      }),
      makeEnv(),
      execCtx
    );
    expect([401, 403]).toContain(res.status);
  });
});
