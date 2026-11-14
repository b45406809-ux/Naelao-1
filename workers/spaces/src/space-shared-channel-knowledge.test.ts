import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createFakeD1 } from "../../../tests/stubs/d1-sqlite.js";
import spacesWorker from "./index.js";

const secret = "space-shared-project-knowledge-route-secret";

function harness(options: { knowledgeAvailable?: boolean; publicationIds?: string[] } = {}) {
  const platformDb = createFakeD1([
    "CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,status TEXT NOT NULL,name TEXT NOT NULL,spacetype_id TEXT NOT NULL,config_json TEXT);",
    "CREATE TABLE space_members(space_id TEXT NOT NULL,end_user_id TEXT NOT NULL,role TEXT NOT NULL,suspended_at TEXT,PRIMARY KEY(space_id,end_user_id));",
  ]);
  platformDb.db.exec(`INSERT INTO spaces VALUES('space-a','tenant-a','active','Space','default',NULL);
    INSERT INTO space_members VALUES('space-a','product-owner','owner',NULL);
    INSERT INTO space_members VALUES('space-a','product-member','member',NULL);`);
  const forwarded: Request[] = [];
  const spaceStub = { fetch: vi.fn(async (request: Request) => {
    forwarded.push(request);
    if (request.method === "GET") return Response.json({ installations: [{ instance_id: "install-a", extension_id: "ext_mentor" }] });
    return Response.json({ instance_id: "install-a", project_id: "project-a", configured: true,
      granted_publication_ids: ["course_material"], revision: 1, updated_by: "owner-a", updated_at: "2026-11-14T00:00:00.000Z" });
  }) };
  const knowledgeWorker = options.knowledgeAvailable === false ? undefined : { fetch: vi.fn(async () => Response.json({
    publications: (options.publicationIds ?? ["course_material"]).map(id => ({ id, name: id, document_count: 1, document_ids: ["doc-a"] })),
  })) };
  const env = {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: platformDb,
    SPACE_DO: { idFromName: (name: string) => name, get: () => spaceStub },
    ...(knowledgeWorker ? { KNOWLEDGE_WORKER: knowledgeWorker } : {}),
  } as never;
  return { env, forwarded, spaceStub, knowledgeWorker };
}

async function call(h: ReturnType<typeof harness>, role: string, path: string, method = "GET", body?: unknown, userId = "owner-a") {
  return spacesWorker.fetch(new Request(`https://spaces.test${path}`, {
    method,
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": userId,
      "x-naelao-role": role, "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), h.env, {} as ExecutionContext);
}

describe("Space-shared channel Project Knowledge routes", () => {
  it("allows owner listing and rejects non-admins before reading SpaceDO policy", async () => {
    const h = harness();
    const path = "/spaces/space-a/projects/project-a/space-shared-channel-knowledge";
    const listed = await call(h, "owner", path);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ installations: [{ instance_id: "install-a" }] });
    expect(h.forwarded).toHaveLength(1);
    expect(new URL(h.forwarded[0]!.url).searchParams).toMatchObject(new URLSearchParams({
      tenant_id: "tenant-a", space_id: "space-a", project_id: "project-a",
    }));

    const productOwner = await call(h, "product_end_user", path, "GET", undefined, "product-owner");
    expect(productOwner.status).toBe(200);
    expect(h.forwarded).toHaveLength(2);
    const denied = await call(h, "member", path);
    expect(denied.status).toBe(403);
    expect(h.forwarded).toHaveLength(2);
    expect((await call(h, "product_end_user", path, "GET", undefined, "product-member")).status).toBe(403);
    expect(h.forwarded).toHaveLength(2);
  });

  it("requires a currently published collection and forwards the authenticated owner with a revision", async () => {
    const h = harness();
    const path = "/spaces/space-a/projects/project-a/space-shared-channel-knowledge/install-a/knowledge-grants";
    const unavailablePublication = await call(h, "owner", path, "PUT", { expected_revision: 0, publication_ids: ["retired_collection"] });
    expect(unavailablePublication.status).toBe(409);
    expect(h.forwarded).toHaveLength(0);

    const saved = await call(h, "product_end_user", path, "PUT", { expected_revision: 0, publication_ids: ["course_material"] }, "product-owner");
    expect(saved.status).toBe(200);
    expect(h.knowledgeWorker?.fetch).toHaveBeenCalledTimes(2);
    expect(h.forwarded).toHaveLength(1);
    expect(h.forwarded[0]!.method).toBe("POST");
    expect(await h.forwarded[0]!.clone().json()).toMatchObject({ tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a",
      instanceId: "install-a", actorId: "product-owner", expectedRevision: 0, publicationIds: ["course_material"] });
  });

  it("fails closed when the Knowledge publication source is not bound", async () => {
    const h = harness({ knowledgeAvailable: false });
    const response = await call(h, "owner", "/spaces/space-a/projects/project-a/space-shared-channel-knowledge/install-a/knowledge-grants", "PUT",
      { expected_revision: 0, publication_ids: [] });
    expect(response.status).toBe(503);
    expect(h.forwarded).toHaveLength(0);
  });
});
