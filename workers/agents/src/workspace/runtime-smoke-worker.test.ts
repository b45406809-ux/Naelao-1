import { describe, expect, it, vi } from "vitest";
import worker from "../../workspace-runtime-smoke/worker.js";

const fetchWorker = worker.fetch as (request: Request, env: never) => Promise<Response>;

describe("disposable workspace runtime smoke worker", () => {
  it("fails closed when disposable run configuration is missing", async () => {
    const response = await fetchWorker(new Request("https://smoke.invalid/__smoke/r2"), {} as never);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "disposable_smoke_binding_required" });
  });

  it("requires the run bearer before accessing smoke bindings", async () => {
    const response = await fetchWorker(new Request("https://smoke.invalid/__smoke/r2"), {
      PLATFORM_SECRET: "local-platform-secret",
      WORKSPACE_SMOKE_DISPOSABLE: "true",
      WORKSPACE_SMOKE_TOKEN: "a-secure-smoke-token-with-at-least-32-bytes",
      WORKSPACE_SMOKE_RUN_ID: "test-run",
    } as never);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("confines R2 listing to the authenticated run scope", async () => {
    const list = vi.fn();
    const response = await fetchWorker(new Request("https://smoke.invalid/__smoke/r2?prefix=workspace-v1/other-tenant/", {
      headers: { authorization: "Bearer a-secure-smoke-token-with-at-least-32-bytes" },
    }), {
      PLATFORM_SECRET: "local-platform-secret",
      WORKSPACE_SMOKE_DISPOSABLE: "true",
      WORKSPACE_SMOKE_TOKEN: "a-secure-smoke-token-with-at-least-32-bytes",
      WORKSPACE_SMOKE_RUN_ID: "test-run",
      SCRIPTS_R2: { list } as never,
    } as never);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "scope_outside_smoke_run" });
    expect(list).not.toHaveBeenCalled();
  });
});
