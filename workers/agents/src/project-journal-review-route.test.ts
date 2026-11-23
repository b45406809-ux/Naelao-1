import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { emptyJournal, journalKey, renderJournal, type JournalDecision } from "./script-engine/project-journal.js";
import { app } from "./index.js";

const secret = "project-journal-review-route-test-secret";
const spaceId = "space-a", projectId = "project-a", tenantId = "tenant-a", userId = "user-a";

function harness(projectRole: "owner" | "editor" | "viewer") {
  let currentBytes = new TextEncoder().encode(renderJournal({ ...emptyJournal(), decisionRegister: [{
    id: "decision-1", topicKey: "workspace.policy", proposal: "Use checked publication.", rationale: "Keep canonical writes fenced.",
    interfaces: [], status: "proposed", revision: 1, proposer: "editor-a", proposedAt: "2026-11-23T00:00:00.000Z",
    baseWorkspace: { branch: "main", revision: 2, manifestHash: "a".repeat(64) },
  } satisfies JournalDecision] }));
  let etag = "journal-v1";
  let writes = 0;
  const bucket = {
    async head(key: string) { return key === journalKey(spaceId, projectId) ? { etag, size: currentBytes.byteLength, customMetadata: {} } : null; },
    async get(key: string) { return key === journalKey(spaceId, projectId) ? { etag, size: currentBytes.byteLength, customMetadata: {}, arrayBuffer: async () => currentBytes.slice().buffer } : null; },
    async put(key: string, value: Uint8Array, options: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
      if (key !== journalKey(spaceId, projectId) || options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== etag) return null;
      currentBytes = new Uint8Array(value); etag = `journal-v${++writes + 1}`;
      return { etag };
    },
  };
  const spacesWorker = { async fetch(input: Request | string, init?: RequestInit) {
    const request = typeof input === "string" ? new Request(input, init) : input;
    if (new URL(request.url).pathname.endsWith("/members")) return Response.json({ data: [{ user_id: userId, role: projectRole }] });
    return Response.json({ project_id: projectId });
  } };
  const env = { PLATFORM_SECRET: secret, SPACES_WORKER: spacesWorker, SCRIPTS_R2: bucket } as never;
  return { env, writes: () => writes };
}

async function request(path: string, env: never, role: string, method: "GET" | "POST" = "GET", body?: unknown) {
  return app.request(path, { method, headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
    "x-naelao-user-id": userId, "x-naelao-role": role, "x-naelao-internal-token": await mintInternalToken(secret, tenantId) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
}

describe("Project Journal decision review route", () => {
  const registerPath = `/spaces/${spaceId}/projects/${projectId}/assistant/project-journal/decisions`;
  const reviewPath = `${registerPath}/decision-1/review`;

  it("shows current proposal revision and review authority, while denying a project editor review writes", async () => {
    const f = harness("editor");
    const read = await request(registerPath, f.env, "product_end_user");
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ can_review: false, decisions: [{ id: "decision-1", status: "proposed", revision: 1, workspaceStatus: "unavailable" }] });
    const denied = await request(reviewPath, f.env, "product_end_user", "POST", { expected_revision: 1, outcome: "reject" });
    expect(denied.status).toBe(403);
    expect(f.writes()).toBe(0);
  });

  it("allows an owner to reject an unavailable/stale proposal but never approve it without a current workspace pin", async () => {
    const f = harness("owner");
    const deniedApproval = await request(reviewPath, f.env, "product_end_user", "POST", { expected_revision: 1, outcome: "approve" });
    expect(deniedApproval.status).toBe(409);
    expect(await deniedApproval.json()).toMatchObject({ reason: "decision_workspace_revision_unavailable" });
    expect(f.writes()).toBe(0);

    const rejected = await request(reviewPath, f.env, "product_end_user", "POST", { expected_revision: 1, outcome: "reject", review_note: "No longer current." });
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({ ok: true, decision: { id: "decision-1", status: "rejected", revision: 2, reviewer: userId } });
    expect(f.writes()).toBe(1);
  });
});
