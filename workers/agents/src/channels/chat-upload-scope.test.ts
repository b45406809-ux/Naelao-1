import { describe, expect, it } from "vitest";
import { resolveChatUploadScope } from "./chat-upload-scope.js";

describe("chat upload session scope", () => {
  it("uses the session's canonical project and checks its access", async () => {
    const requests: Request[] = [];
    const result = await resolveChatUploadScope({
      platformSecret: "secret",
      tenantId: "tenant-a",
      spaceId: "space-a",
      sessionId: "session-a",
      userId: "user-a",
      callerRole: "product_end_user",
      async fetchSpaces(request) {
        requests.push(request);
        return requests.length === 1
          ? Response.json({
              project_id: "project-a",
              private_scratchpad: false,
            })
          : Response.json({ id: "project-a" });
      },
    });
    expect(result).toEqual({ projectId: "project-a" });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/spaces/space-a/sessions/session-a/compact-scope",
      "/spaces/space-a/projects/project-a",
    ]);
    expect(requests[0]?.headers.get("x-naelao-user-id")).toBe("user-a");
    expect(requests[0]?.headers.get("x-naelao-role")).toBe("product_end_user");
    expect(requests[0]?.headers.get("x-naelao-internal-token")).toBeTruthy();
  });

  it("rejects private scratchpads, inaccessible sessions/projects, and malformed scope data", async () => {
    const base = {
      platformSecret: "secret",
      tenantId: "tenant-a",
      spaceId: "space-a",
      sessionId: "session-a",
      userId: "user-a",
      callerRole: "product_end_user",
    };
    const privateScope = await resolveChatUploadScope({
      ...base,
      async fetchSpaces() {
        return Response.json({ project_id: null, private_scratchpad: true });
      },
    });
    expect(privateScope).toBeNull();

    const foreignSession = await resolveChatUploadScope({
      ...base,
      async fetchSpaces() {
        return new Response(null, { status: 404 });
      },
    });
    expect(foreignSession).toBeNull();

    const inaccessibleProject = await resolveChatUploadScope({
      ...base,
      async fetchSpaces(request) {
        return new URL(request.url).pathname.endsWith("compact-scope")
          ? Response.json({ project_id: "project-a" })
          : new Response(null, { status: 404 });
      },
    });
    expect(inaccessibleProject).toBeNull();

    const malformed = await resolveChatUploadScope({
      ...base,
      async fetchSpaces() {
        return Response.json({ project_id: { forged: true } });
      },
    });
    expect(malformed).toBeNull();
  });
});
