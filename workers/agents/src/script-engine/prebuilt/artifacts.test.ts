import { describe, expect, it, vi } from "vitest";
import { artifacts } from "./artifacts.js";
import type { PrebuiltOpContext } from "./index.js";

function context(fetch: (request: Request) => Promise<Response>): PrebuiltOpContext {
  return {
    env: {
      artifactWorker: { fetch } as unknown as Fetcher,
      spaceId: "space-a",
      tenantId: "tenant-a",
      platformSecret: "secret",
    },
    run: vi.fn(),
  };
}

describe("artifact prebuilt MIME propagation", () => {
  it("leaves omitted MIME for the artifact service to infer from the filename", async () => {
    const fetch = vi.fn(async () => Response.json({ artifact_id: "artifact-a", filename: "page.html", content_type: "text/html; charset=utf-8" }, { status: 201 }));
    await artifacts.operations["artifacts.create"]!({ filename: "page.html", content: "<h1>Hi</h1>" }, context(fetch));
    const request = fetch.mock.calls[0]![0] as Request;
    expect(JSON.parse(String(await request.clone().text()))).toEqual({ filename: "page.html", content: "<h1>Hi</h1>" });
  });

  it("returns structured text MIME from artifact reads as content instead of binary metadata", async () => {
    const fetch = vi.fn(async () => new Response("title = 'report'", { headers: { "content-type": "application/toml; charset=utf-8" } }));
    await expect(artifacts.operations["artifacts.get"]!({ artifact_id: "artifact-a" }, context(fetch)))
      .resolves.toMatchObject({ artifact_id: "artifact-a", content_type: "application/toml; charset=utf-8", content: "title = 'report'" });
  });
});
