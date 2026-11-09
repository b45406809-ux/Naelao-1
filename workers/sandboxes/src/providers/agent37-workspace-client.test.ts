import { describe, expect, it, vi } from "vitest";
import { agent37WorkspaceHandoff } from "./agent37-workspace-client.js";

const computer = {
  id: "cmp_1", scope: { tenantId: "t", ownerId: "u", spaceId: "s", projectId: "p", branch: "main" },
  templateId: "node", templateVersion: "1", ownership: "naelao_managed" as const, filesystemId: "fs_1",
  filesystemMode: "snapshot_diff" as const, providerPreference: "agent37" as const, state: "configured" as const,
  resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 }, idleTimeoutSeconds: 900, allocationGeneration: 7,
};

describe("Agent37 checked workspace service client (mocked Agents binding)", () => {
  it("opens a checked session, reads verified bytes, stages and publishes by coordinator operations", async () => {
    const bytes = new TextEncoder().encode("from canonical workspace");
    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const binding = { fetch: vi.fn(async (request: Request) => {
      const body = await request.json() as Record<string, unknown>;
      calls.push({ url: new URL(request.url).pathname, body });
      switch (body.operation) {
        case "open": return Response.json({ session: { id: "ws_12345678-1234-1234-1234-123456789012", fence: 0 }, head: { revision: 8 } });
        case "snapshot": return Response.json({ session: { baseRevision: 8, allocationGeneration: 7 }, entries: [{ path: "src/a.txt", sha256, size: bytes.byteLength, executable: false, contentType: "text/plain; charset=utf-8" }] });
        case "content": return new Response(bytes, { headers: { "content-type": "text/plain; charset=utf-8", "x-content-sha256": sha256, "x-executable": "false" } });
        case "stage": return Response.json({ stageId: body.stageId, status: "staged" });
        case "publish": return Response.json({ publication: { id: "pub_1", status: "published" } });
        case "close": return Response.json({ status: "closed" });
        default: return Response.json({ error_code: "unexpected" }, { status: 400 });
      }
    }) } as unknown as Fetcher;
    const handoff = agent37WorkspaceHandoff({ AGENTS_WORKER: binding, PLATFORM_SECRET: "internal-secret" }, computer);
    const snapshot = await handoff.readCommitted({ tenantId: "t", spaceId: "s", projectId: "p", branch: "main", allocationGeneration: 7 });
    expect(snapshot).toMatchObject({ revision: 8, fence: 0, allocationGeneration: 7, files: [{ path: "src/a.txt", sha256, contentType: "text/plain; charset=utf-8" }] });
    expect(new TextDecoder().decode(snapshot.files[0]!.bytes)).toBe("from canonical workspace");
    const stage = await handoff.stage({ sessionId: snapshot.sessionId, revision: snapshot.revision, fence: snapshot.fence, allocationGeneration: 7,
      stageId: "agent37:exec-1:stage", changes: [{ path: "src/a.txt", expectedHash: sha256, bytes: new TextEncoder().encode("updated"), contentType: snapshot.files[0]!.contentType ?? "application/octet-stream" }] });
    expect(stage.stageId).toBe("agent37:exec-1:stage");
    expect(calls.find((call) => call.body.operation === "stage")?.body.changes).toMatchObject([{ path: "src/a.txt", expectedHash: sha256, contentBase64: btoa("updated"), contentType: "text/plain; charset=utf-8" }]);
    const receipt = await handoff.publish({ sessionId: snapshot.sessionId, stageId: stage.stageId, revision: snapshot.revision, fence: snapshot.fence, allocationGeneration: 7, idempotencyKey: "agent37:exec-1" });
    expect(receipt).toEqual({ publicationId: "pub_1", status: "published" });
    await handoff.close?.({ sessionId: snapshot.sessionId, fence: 0, allocationGeneration: 7 });
    expect(calls.map((call) => call.body.operation)).toEqual(["open", "snapshot", "content", "stage", "publish", "close"]);
  });

  it("resolves a lost publication response from its receipt without replaying publish", async () => {
    const operations: string[] = [];
    const binding = { fetch: vi.fn(async (request: Request) => {
      const body = await request.json() as Record<string, unknown>;
      operations.push(String(body.operation));
      if (body.operation === "publish") return Response.json({ error_code: "lost" }, { status: 503 });
      if (body.operation === "receipt") return Response.json({ publication: { id: "pub_committed", status: "published" } });
      return Response.json({ error_code: "unexpected" }, { status: 400 });
    }) } as unknown as Fetcher;
    const handoff = agent37WorkspaceHandoff({ AGENTS_WORKER: binding, PLATFORM_SECRET: "internal-secret" }, computer);
    await expect(handoff.publish({ sessionId: "ws_12345678-1234-1234-1234-123456789012", stageId: "stage-1", revision: 1, fence: 0, allocationGeneration: 7, idempotencyKey: "agent37:exec-1" })).resolves.toEqual({ publicationId: "pub_committed", status: "published" });
    expect(operations).toEqual(["publish", "receipt"]);
  });

  it("stages a 20 MiB provider transfer with canonical MIME and rejects larger files", async () => {
    let stagedBody: Record<string, unknown> | undefined;
    const binding = { fetch: vi.fn(async (request: Request) => {
      stagedBody = await request.json() as Record<string, unknown>;
      return Response.json({ stageId: stagedBody.stageId, status: "staged" });
    }) } as unknown as Fetcher;
    const handoff = agent37WorkspaceHandoff({ AGENTS_WORKER: binding, PLATFORM_SECRET: "internal-secret" }, computer);
    const bytes = new Uint8Array(20 * 1024 * 1024).fill(0x61);
    await expect(handoff.stage({ sessionId: "ws_12345678-1234-1234-1234-123456789012", revision: 8, fence: 0, allocationGeneration: 7,
      stageId: "agent37:large:stage", changes: [{ path: "uploads/large.bin", expectedHash: null, bytes, contentType: "application/octet-stream" }] })).resolves.toMatchObject({ stageId: "agent37:large:stage" });
    const changes = stagedBody?.changes as Array<Record<string, unknown>>;
    expect(changes[0]).toMatchObject({ path: "uploads/large.bin", contentType: "application/octet-stream" });
    expect(String(changes[0]?.contentBase64).length).toBe(Math.ceil(bytes.byteLength / 3) * 4);
    await expect(handoff.stage({ sessionId: "ws_12345678-1234-1234-1234-123456789012", revision: 8, fence: 0, allocationGeneration: 7,
      stageId: "agent37:oversized:stage", changes: [{ path: "uploads/large.bin", expectedHash: null, bytes: new Uint8Array(20 * 1024 * 1024 + 1) }] })).rejects.toThrow("workspace_stage_limit_exceeded");
  }, 30_000);
});
