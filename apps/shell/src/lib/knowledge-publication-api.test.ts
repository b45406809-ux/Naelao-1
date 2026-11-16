import { afterEach, expect, it, vi } from "vitest";
import { applyWebsiteKnowledgeRefresh, createKbDocument, getExternalKnowledgePublicationSources, listExternalKnowledgePublicationEvents, listExternalKnowledgePublications,
  getWebsiteKnowledgeCrawlCapability, previewWebsiteKnowledgeCrawl, previewWebsiteKnowledgeSource, setWebsiteKnowledgeRefreshSchedule } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("separates collection discovery from the no-store source membership read", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    const body = url.endsWith("/sources")
      ? { publication_id: "course_material", revision: 4, document_ids: ["doc-a"] }
      : url.endsWith("/events")
        ? { publication_id: "course_material", events: [] }
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

  await expect(listExternalKnowledgePublicationEvents("space/a", "project b", "course_material", session)).resolves.toEqual([]);
  expect(fetchMock).toHaveBeenLastCalledWith(
    "http://localhost:8787/v1/spaces/space%2Fa/kb/projects/project%20b/external-publications/course_material/events",
    expect.objectContaining({ cache: "no-store", headers: expect.any(Headers) }),
  );
});

it("previews and saves only a Project-scoped website source receipt", async () => {
  const preview = { content: "Approved page text", requested_url: "https://docs.example/start", final_url: "https://docs.example/current",
    content_type: "text/markdown", preview_sha256: "a".repeat(64), preview_token: "signed-preview", expires_in_seconds: 900, warnings: [] };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(String(input).endsWith("/preview")
      ? JSON.stringify({ preview })
      : JSON.stringify({ id: "doc-a", status: "indexed" }),
      { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const session = { sessionToken: "session-token", endUserId: "owner-a" };
  await expect(previewWebsiteKnowledgeSource("space/a", "project b", session, {
    connection_id: "connection-a", url: "https://docs.example/start",
  })).resolves.toEqual(preview);
  expect(fetchMock).toHaveBeenLastCalledWith(
    "http://localhost:8787/v1/spaces/space%2Fa/kb/projects/project%20b/sources/website/preview",
    expect.objectContaining({ method: "POST", cache: "no-store", headers: expect.any(Headers),
      body: JSON.stringify({ connection_id: "connection-a", url: "https://docs.example/start" }) }),
  );

  await createKbDocument("space-a", session, {
    title: "Approved page", content: "Corrected owner-approved text", content_type: "url", source_url: preview.final_url,
    project_id: "project b", idempotency_key: "website-source-idempotency-01", website_connection_id: "connection-a",
    website_requested_url: preview.requested_url, website_preview_sha256: preview.preview_sha256, website_preview_token: preview.preview_token,
  });
  const [createUrl, createInit] = fetchMock.mock.calls.at(-1) ?? [];
  expect(createUrl).toBe("http://localhost:8787/v1/spaces/space-a/kb/documents");
  expect(createInit).toEqual(expect.objectContaining({ method: "POST", headers: expect.any(Headers) }));
  expect(JSON.parse(String(createInit?.body))).toMatchObject({
    website_connection_id: "connection-a", website_preview_token: "signed-preview", content_type: "url",
    project_id: "project b", content: "Corrected owner-approved text",
  });
});

it("keeps a website refresh receipt bound to its document version through the PATCH caller", async () => {
  const preview = { content: "Updated page text", requested_url: "https://docs.example/current", final_url: "https://docs.example/current",
    content_type: "text/html", preview_sha256: "b".repeat(64), preview_token: "signed-refresh", expires_in_seconds: 900, warnings: [],
    refresh_operation_id: "refresh-op-1", expected_source_revision: 7 };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => new Response(String(input).endsWith("/preview")
    ? JSON.stringify({ preview }) : JSON.stringify({ id: "doc-a", status: "indexed" }),
    { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  const session = { sessionToken: "session-token", endUserId: "owner-a" };
  await expect(previewWebsiteKnowledgeSource("space-a", "project-a", session, {
    document_id: "doc-a", idempotency_key: "refresh-request-0001", url: preview.requested_url,
  })).resolves.toMatchObject({ refresh_operation_id: "refresh-op-1", expected_source_revision: 7 });
  await applyWebsiteKnowledgeRefresh("space-a", "doc-a", "project-a", session, {
    title: "Docs", content: "Owner-corrected updated text", requested_url: preview.requested_url, final_url: preview.final_url,
    preview_sha256: preview.preview_sha256, preview_token: preview.preview_token,
    refresh_operation_id: preview.refresh_operation_id, expected_source_revision: preview.expected_source_revision,
  });
  const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
  expect(url).toBe("http://localhost:8787/v1/spaces/space-a/kb/documents/doc-a");
  expect(init).toEqual(expect.objectContaining({ method: "PATCH", headers: expect.any(Headers) }));
  expect(JSON.parse(String(init?.body))).toMatchObject({ website_refresh: {
    operation_id: "refresh-op-1", expected_source_revision: 7, preview_token: "signed-refresh",
  }, content: "Owner-corrected updated text" });
});

it("exposes an explicit owner opt-in for a daily or weekly website refresh schedule", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ schedule: { enabled: 1, interval_hours: 168,
    next_run_at: "2026-11-23T12:00:00.000Z" } }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  await setWebsiteKnowledgeRefreshSchedule("space/a", "project b", "doc c", { sessionToken: "session-token", endUserId: "owner-a" },
    { enabled: true, interval_hours: 168 });
  const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
  expect(url).toBe("http://localhost:8787/v1/spaces/space%2Fa/kb/projects/project%20b/sources/website/doc%20c/schedule");
  expect(init).toEqual(expect.objectContaining({ method: "POST", body: JSON.stringify({ enabled: true, interval_hours: 168 }) }));
});

it("loads crawl capability and resumes a scoped crawl with an idempotent owner confirmation", async () => {
  const result = { operation_id: "crawl-a", status: "partial", continuation_available: true,
    limits: { max_pages: 8, max_depth: 2, max_page_bytes: 524288, max_total_bytes: 2097152, max_links_per_page: 100,
      max_redirects: 5, elapsed_ms_per_request: 20000 },
    totals: { page_count: 1, byte_count: 42, queued_count: 1, retryable_count: 0 }, pages: [] };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(
    String(input).endsWith("/capability") ? { available: true, max_pages: 8, max_depth: 2, requires_owner_site_terms_confirmation: true } : result,
  ), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  const session = { sessionToken: "session-token", endUserId: "owner-a" };
  await expect(getWebsiteKnowledgeCrawlCapability("space/a", "project b", session)).resolves.toMatchObject({ available: true });
  await expect(previewWebsiteKnowledgeCrawl("space/a", "project b", session, {
    connection_id: "connection-a", url: "https://docs.example/start", idempotency_key: "crawl-request-0001",
    max_pages: 8, max_depth: 2, owner_confirmed_site_terms: true,
  })).resolves.toMatchObject({ operation_id: "crawl-a", continuation_available: true });
  expect(fetchMock).toHaveBeenLastCalledWith(
    "http://localhost:8787/v1/spaces/space%2Fa/kb/projects/project%20b/sources/website/crawl/preview",
    expect.objectContaining({ method: "POST", cache: "no-store", headers: expect.any(Headers),
      body: JSON.stringify({ connection_id: "connection-a", url: "https://docs.example/start", idempotency_key: "crawl-request-0001",
        max_pages: 8, max_depth: 2, owner_confirmed_site_terms: true }) }),
  );
});
