import { afterEach, describe, expect, it, vi } from "vitest";
import { exportSpaceArchive } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("exportSpaceArchive", () => {
  it("posts one scoped full export with the caller's recovery request ID", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return Response.json({ archive_id: "archive-a", checksum: "abc123", plaintext_bytes: 512, object_reference_count: 2 });
    }));

    const result = await exportSpaceArchive("space/a", { sessionToken: "session-a", endUserId: "owner-a" }, "request-a");

    expect(result).toMatchObject({ archive_id: "archive-a", checksum: "abc123", plaintext_bytes: 512, object_reference_count: 2 });
    expect(new URL(requestUrl).pathname).toBe("/v1/spaces/space%2Fa/data-ops");
    expect(requestInit?.method).toBe("POST");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe("Bearer session-a");
    expect(new Headers(requestInit?.headers).get("x-naelao-end-user-id")).toBe("owner-a");
    expect(JSON.parse(String(requestInit?.body))).toEqual({ action: "export", kind: "full", request_id: "request-a" });
  });
});
