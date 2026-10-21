import { mintInternalToken } from "@naelao/http";
import { describe, expect, it, vi } from "vitest";
import worker from "./index.js";

function env() {
  const prepare = vi.fn((sql: string) => ({
    bind: (...args: unknown[]) => ({
      first: async () => sql.includes("FROM spaces") ? { id: "source" }
        : sql.includes("FROM kb_documents") ? { id: "doc-1", title: "Policy", source_url: null, status: "indexed", project_id: null } : null,
      all: async () => sql.includes("FROM kb_chunks")
        ? { results: [{ chunk_index: 0, content: "Sanitized policy text." }] }
        : { results: [{ id: String(args[2]), title: "Policy", status: "indexed", project_id: null }] },
    }),
  }));
  return { ENVIRONMENT: "test", PLATFORM_SECRET: "secret", PLATFORM_DB: { prepare } } as never;
}

describe("Foundry knowledge reference and document share service", () => {
  it("resolves only indexed space-wide documents without returning content", async () => {
    const token = await mintInternalToken("secret", "tenant");
    const response = await worker.fetch(new Request("https://knowledge/internal/spaces/source/kb/references/resolve", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": token },
      body: JSON.stringify({ document_ids: ["doc-1"] }),
    }), env(), {} as ExecutionContext);
    expect(response.status).toBe(200);
    const result = await response.json() as { documents: Array<Record<string, unknown>> };
    expect(result.documents[0]).toMatchObject({ id: "doc-1", title: "Policy", resolved: true });
    expect(result.documents[0]).not.toHaveProperty("content");
  });

  it("serves sanitized indexed text only through the internal route", async () => {
    const token = await mintInternalToken("secret", "tenant");
    const response = await worker.fetch(new Request("https://knowledge/internal/spaces/source/kb/documents/doc-1/shared", {
      headers: { "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": token },
    }), env(), {} as ExecutionContext);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ document: { id: "doc-1", title: "Policy", content: "Sanitized policy text." } });
  });

  it("rejects direct access and missing or unindexed documents", async () => {
    const direct = await worker.fetch(new Request("https://knowledge/internal/spaces/source/kb/documents/doc-1/shared"), env(), {} as ExecutionContext);
    expect(direct.status).toBe(403);
  });
});
