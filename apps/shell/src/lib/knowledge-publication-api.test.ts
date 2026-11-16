import { afterEach, expect, it, vi } from "vitest";
import { getExternalKnowledgePublicationSources, listExternalKnowledgePublications } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("separates collection discovery from the no-store source membership read", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.endsWith("/sources")
      ? { publication_id: "course_material", revision: 4, document_ids: ["doc-a"] }
      : { publications: [{ id: "course_material", name: "Course material", revision: 4, archived: false, document_count: 1 }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const session = { sessionToken: "session-token", endUserId: "owner-a" };

  await expect(listExternalKnowledgePublications("space/a", "project b", session)).resolves.toMatchObject([
    { id: "course_material", archived: false, document_count: 1 },
  ]);
  expect(fetchMock).toHaveBeenLastCalledWith(
    "http://localhost:8787/v1/spaces/space%2Fa/kb/projects/project%20b/external-publications",
    expect.objectContaining({ cache: "no-store", headers: expect.any(Headers) }),
  );

  await expect(getExternalKnowledgePublicationSources("space/a", "project b", "course_material", session))
    .resolves.toEqual({ publication_id: "course_material", revision: 4, document_ids: ["doc-a"] });
  expect(fetchMock).toHaveBeenLastCalledWith(
    "http://localhost:8787/v1/spaces/space%2Fa/kb/projects/project%20b/external-publications/course_material/sources",
    expect.objectContaining({ cache: "no-store", headers: expect.any(Headers) }),
  );
});
