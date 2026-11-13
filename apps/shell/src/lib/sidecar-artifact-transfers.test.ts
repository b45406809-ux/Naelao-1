import { afterEach, describe, expect, it, vi } from "vitest";
import { getSidecarArtifactTransfers } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("getSidecarArtifactTransfers", () => {
  it("uses the exact installation/container path, optional branch, and no-store credentials", async () => {
    const requests: Array<{ url: string; cache?: RequestCache; authorization?: string; actor?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const authorization = headers.get("authorization"), actor = headers.get("x-naelao-end-user-id");
      requests.push({ url: String(input), ...(init?.cache ? { cache: init.cache } : {}),
        ...(authorization ? { authorization } : {}), ...(actor ? { actor } : {}) });
      return Response.json({ transfers: [] });
    }));

    await getSidecarArtifactTransfers("space/one", "project one", "install:1", "build", { sessionToken: "session", endUserId: "owner" }, "runs/review");

    const request = requests[0]!;
    const url = new URL(request.url);
    expect(url.pathname).toBe("/v1/spaces/space%2Fone/projects/project%20one/runtime-installations/install%3A1/containers/build/artifact-transfers");
    expect(url.searchParams.get("branch")).toBe("runs/review");
    expect(request.cache).toBe("no-store");
    expect(request.authorization).toBe("Bearer session");
    expect(request.actor).toBe("owner");
  });
});
