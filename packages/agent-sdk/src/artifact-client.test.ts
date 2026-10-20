import { describe, expect, it, vi } from "vitest";
import { ArtifactRepositoryClient } from "./artifact-client.js";

function client(fetch: (input: Request) => Promise<Response>) {
  return new ArtifactRepositoryClient(
    { fetch },
    "space-1",
    "project-1",
    () => new Headers()
  );
}

describe("Artifact Repository response bounds", () => {
  it("accepts bounded JSON results", async () => {
    const repository = client(async () => Response.json({ branch: "main", commit_id: null }));
    await expect(repository.getRepo()).resolves.toEqual({ branch: "main", commit_id: null });
  });

  it("rejects a streamed oversized result without Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
        controller.close();
      },
    });
    const repository = client(async () => new Response(body));

    await expect(repository.getRepo()).rejects.toThrow("repository_response_too_large");
  });

  it("caps error-body reads and keeps diagnostics short", async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array(8 * 1024 + 1), { status: 500 }));
    const repository = client(fetch);

    await expect(repository.getRepo()).rejects.toThrow(
      "repository_getRepo_failed:500:repository_response_too_large"
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
});
