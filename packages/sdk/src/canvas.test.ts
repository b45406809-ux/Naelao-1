import { describe, expect, it, vi } from "vitest";
import { createCanvasGadgetClient } from "./canvas.js";

describe("Canvas Gadget bridge", () => {
  it("uses the authenticated project API and returns schema-backed Gadget data", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.example/v1/spaces/space-a/projects/project-a/apps/mentor_journal/mcp");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer short-lived-session");
      const rpc = JSON.parse(String(init?.body));
      expect(rpc).toMatchObject({ jsonrpc: "2.0", method: "tools/call", params: { name: "app_mentor_journal_list", arguments: { table: "notes", filter: { owner: "member-a" }, limit: 25 } } });
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { structuredContent: [{ id: "n1" }] } });
    });
    const client = createCanvasGadgetClient({ apiBaseUrl: "https://api.example/", spaceId: "space-a", projectId: "project-a", gadgetAppId: "mentor_journal", authorize: () => ({ authorization: "Bearer short-lived-session" }), fetch: fetcher });
    await expect(client.list("notes", { owner: "member-a" }, 25)).resolves.toEqual([{ id: "n1" }]);
  });

  it("rejects invalid scope and host authorization failures", async () => {
    expect(() => createCanvasGadgetClient({ apiBaseUrl: "https://api.example", spaceId: "s", projectId: "p", gadgetAppId: "../other", authorize: () => ({}) })).toThrow("canvas_gadget_scope_invalid");
    const client = createCanvasGadgetClient({ apiBaseUrl: "https://api.example", spaceId: "s", projectId: "p", gadgetAppId: "mentor_journal", authorize: () => ({}), fetch: async () => Response.json({ error_code: "forbidden" }, { status: 403 }) });
    await expect(client.delete("notes", "n1")).rejects.toThrow("canvas_gadget_request_failed_403");
  });
});
