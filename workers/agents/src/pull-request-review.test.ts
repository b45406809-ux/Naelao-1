import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { app } from "./index.js";

const secret = "review-test-secret";

function harness(role: string, interruptStatusWrite = false) {
  let mainHead = "base-1";
  let mergeCalls = 0;
  let statusWrites = 0;
  const spaceCalls: string[] = [];
  const spacesWorker = { async fetch(input: Request | string, init?: RequestInit) {
    const req = typeof input === "string" ? new Request(input, init) : input;
    const url = new URL(req.url); spaceCalls.push(`${req.method} ${url.pathname}`);
    if (url.pathname.endsWith("/members")) return Response.json({ data: [{ user_id: "reviewer", role }] });
    if (url.pathname.endsWith("/pull-request-cards") && req.method === "GET") return Response.json({ data: [{
      id: "pr-1", status: "open", baseBranch: "main", forkBranch: "task/1", baseCommit: "base-1", headCommit: "head-1",
    }] });
    if (url.pathname.endsWith("/workspace-events")) return Response.json({ emitted: true });
    if (url.pathname.endsWith("/status")) {
      statusWrites++;
      if (interruptStatusWrite && statusWrites === 1) return Response.json({ error_code: "temporary" }, { status: 503 });
      return Response.json({ id: "pr-1", status: "merged" });
    }
    return Response.json({ error_code: "not_found" }, { status: 404 });
  } };
  const artifactWorker = { async fetch(input: Request | string, init?: RequestInit) {
    const req = typeof input === "string" ? new Request(input, init) : input;
    const url = new URL(req.url);
    if (url.pathname.endsWith("/head")) return Response.json({ commit_id: mainHead });
    if (url.pathname.endsWith("/compare")) return Response.json({ behind: mainHead === "head-1" ? 0 : 1 });
    if (url.pathname.endsWith("/mergePullRequest")) {
      mergeCalls++; mainHead = "head-1";
      return Response.json({ event: { type: "workspace.merged", branch: "main", source: "task/1" } });
    }
    return Response.json({ error_code: "not_found" }, { status: 404 });
  } };
  return { env: { PLATFORM_SECRET: secret, SPACES_WORKER: spacesWorker, ARTIFACT_WORKER: artifactWorker } as never,
    mergeCalls: () => mergeCalls, statusWrites: () => statusWrites, spaceCalls };
}

async function requestDecision(env: never, decision = "merge") {
  return app.request("/spaces/space-1/projects/project-1/pull-request-cards/pr-1/decision", {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1",
      "x-naelao-user-id": "reviewer", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-1") },
    body: JSON.stringify({ decision }),
  }, env);
}

describe("human pull request review endpoint", () => {
  it("requires owner/admin membership from the persisted roster", async () => {
    const test = harness("member");
    const response = await requestDecision(test.env);
    expect(response.status).toBe(403);
    expect(test.mergeCalls()).toBe(0);
    expect(test.spaceCalls).toHaveLength(1);
  });

  it("recovers a merge whose card status write was interrupted without replaying the merge", async () => {
    const test = harness("owner", true);
    const first = await requestDecision(test.env);
    expect(first.status).toBe(503);
    expect(test.mergeCalls()).toBe(1);
    const replay = await requestDecision(test.env);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ id: "pr-1", status: "merged" });
    expect(test.mergeCalls()).toBe(1);
    expect(test.statusWrites()).toBe(2);
  });
});
