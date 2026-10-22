import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { mintInternalToken } from "@naelao/http";

// F-39: read-only R2 workspace file viewer. A project member lists + reads the artifacts their
// agent wrote to spaces/{spaceId}/projects/{projectId}/workspace/.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const PLATFORM_SECRET = "test-platform-secret";

// Minimal in-memory R2 bucket implementing the surface the file viewer uses (list/get).
function makeR2(files: Record<string, string>) {
  return {
    async list(opts: { prefix: string; cursor?: string; limit?: number }) {
      const objects = Object.entries(files)
        .filter(([k]) => k.startsWith(opts.prefix))
        .map(([key, v]) => ({ key, size: new TextEncoder().encode(v).length, uploaded: new Date("2026-01-01T00:00:00Z") }));
      return { objects, truncated: false, cursor: undefined as string | undefined };
    },
    async get(key: string) {
      if (!(key in files)) return null;
      const v = files[key]!;
      const bytes = new TextEncoder().encode(v);
      return { size: bytes.byteLength, async text() { return v; }, async arrayBuffer() { return bytes.slice().buffer; } };
    },
  };
}

function makeEnv(files: Record<string, string>) {
  const spaceDo = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: () => ({ fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      return path.startsWith("/projects/p1") ? Response.json({ id: "p1", visibility: "public" }) : new Response("not found", { status: 404 });
    } }),
  };
  return { PLATFORM_SECRET, ENVIRONMENT: "test", SPACE_DO: spaceDo, SCRIPTS_R2: makeR2(files) };
}
async function h(): Promise<Record<string, string>> {
  return { "content-type": "application/json", "x-naelao-tenant-id": "t1", "x-naelao-internal-token": await mintInternalToken(PLATFORM_SECRET, "t1") };
}
function get(env: ReturnType<typeof makeEnv>, path: string, hdr: Record<string, string>) {
  return spacesWorker.fetch(new Request(`https://spaces.naelao.com${path}`, { headers: hdr }), env as never, execCtx);
}

const PREFIX = "spaces/s1/projects/p1/workspace/";

describe("F-39: workspace file viewer", () => {
  it("lists workspace files (excluding .keep)", async () => {
    const env = makeEnv({ [`${PREFIX}.keep`]: "", [`${PREFIX}dashboard.html`]: "<h1>Hi</h1>", [`${PREFIX}report.md`]: "# Report" });
    const res = await get(env, "/spaces/s1/projects/p1/workspace/files", await h());
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ path: string; size: number }>; count: number };
    expect(body.count).toBe(2);
    expect(body.data.map((f) => f.path).sort()).toEqual(["dashboard.html", "report.md"]);
  });

  it("reads one file's content inline", async () => {
    const env = makeEnv({ [`${PREFIX}dashboard.html`]: "<h1>Hi</h1>" });
    const res = await get(env, "/spaces/s1/projects/p1/workspace/files/dashboard.html", await h());
    expect(res.status).toBe(200);
    const body = await res.json() as { path: string; content: string };
    expect(body.content).toBe("<h1>Hi</h1>");
  });

  it("returns PDF bytes as bounded base64 and labels the native preview type", async () => {
    const pdfBytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    const env = makeEnv({});
    env.SCRIPTS_R2 = {
      ...makeR2({}),
      async get() {
        return { size: pdfBytes.byteLength, async arrayBuffer() { return pdfBytes.slice().buffer; } };
      },
    } as never;
    const res = await get(env, "/spaces/s1/projects/p1/workspace/files/report.pdf", await h());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      path: "report.pdf",
      size: pdfBytes.byteLength,
      encoding: "base64",
      content_type: "application/pdf",
      content: "JVBERi0xLjc=",
    });
  });

  it("does not read R2 bytes when object metadata exceeds the 2 MiB inline limit", async () => {
    let arrayBufferCalls = 0;
    const env = makeEnv({});
    env.SCRIPTS_R2 = {
      ...makeR2({}),
      async get() {
        return {
          size: 2 * 1024 * 1024 + 1,
          async arrayBuffer() { arrayBufferCalls++; return new ArrayBuffer(0); },
        };
      },
    } as never;
    const res = await get(env, "/spaces/s1/projects/p1/workspace/files/large.pdf", await h());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ too_large: true, size: 2 * 1024 * 1024 + 1 });
    expect(arrayBufferCalls).toBe(0);
  });

  it("404s a missing file", async () => {
    const env = makeEnv({ [`${PREFIX}a.txt`]: "x" });
    const res = await get(env, "/spaces/s1/projects/p1/workspace/files/missing.txt", await h());
    expect(res.status).toBe(404);
  });

  it("collapses .. traversal so a read can't escape the project prefix", async () => {
    // A key outside the prefix exists but must be unreachable via ../ segments.
    const env = makeEnv({ [`${PREFIX}a.txt`]: "inside", ["spaces/s1/projects/other/workspace/secret.txt"]: "SECRET" });
    const res = await get(env, "/spaces/s1/projects/p1/workspace/files/..%2f..%2fother%2fworkspace%2fsecret.txt", await h());
    // The .. segments are stripped, so it resolves to prefix + "other/workspace/secret.txt" which
    // does NOT exist under p1's prefix → 404, never the sibling project's file.
    expect(res.status).toBe(404);
  });

  it("degrades gracefully with no R2 bound", async () => {
    const env = makeEnv({});
    const { SCRIPTS_R2: _bucket, ...withoutBucket } = env;
    const res = await get(withoutBucket as never, "/spaces/s1/projects/p1/workspace/files", await h());
    const body = await res.json() as { unavailable?: boolean; count: number };
    expect(body.count).toBe(0);
    expect(body.unavailable).toBe(true);
  });
});
