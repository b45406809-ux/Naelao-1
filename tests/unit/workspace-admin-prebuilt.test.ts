import { describe, it, expect } from "vitest";
import { workspaceAdmin } from "../../workers/agents/src/script-engine/prebuilt/workspace-admin.js";
import { verifyInternalToken } from "@naelao/http";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

// §A1.17 Phase G: lets the Launchpad business-builder assistant actually scaffold a business —
// create/list/configure projects, and read the agent roster — as thin, HMAC-verified wrappers
// over the spaces worker's existing project routes. Mirrors the commerce prebuilt's verified-
// token precedent (tests/unit/commerce-prebuilt-hmac.test.ts).

const PLATFORM_SECRET = "test-platform-secret";

interface Call { method: string; url: string; headers: Record<string, string>; body: unknown }

function makeEnv(calls: Call[], responder?: (call: Call) => unknown): ScriptEngineEnv {
  const spacesWorker = {
    async fetch(reqInput: Request | string, init?: RequestInit) {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      const body = await req.clone().json().catch(() => null);
      const call: Call = { method: req.method, url: req.url, headers, body };
      calls.push(call);
      const result = responder ? responder(call) : {};
      return Response.json(result ?? {});
    },
  };
  return {
    scriptsBucket: {} as never,
    spaceId: "space-1",
    tenantId: "tenant-1",
    platformSecret: PLATFORM_SECRET,
    spacesWorker: spacesWorker as unknown as Fetcher,
  } as unknown as ScriptEngineEnv;
}

const noopRun = async () => ({});

describe("workspace-admin prebuilt", () => {
  it("project.list mints a verified internal token and reads the space's projects", async () => {
    const calls: Call[] = [];
    const env = makeEnv(calls, () => ({ data: [{ id: "proj-1", name: "Inbox" }] }));
    const result = await workspaceAdmin.operations["project.list"]!({}, { env, run: noopRun });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/spaces/space-1/projects");
    const token = calls[0]!.headers["x-naelao-internal-token"];
    expect(await verifyInternalToken(token, "tenant-1", PLATFORM_SECRET)).toBe(true);
    expect(result).toEqual({ data: [{ id: "proj-1", name: "Inbox" }] });
  });

  it("agent.list reads the space's agent-definitions with an explicit space_id", async () => {
    const calls: Call[] = [];
    const env = makeEnv(calls, () => ({ data: [] }));
    await workspaceAdmin.operations["agent.list"]!({}, { env, run: noopRun });

    expect(calls[0]!.url).toContain("/spaces/space-1/agent-definitions?space_id=space-1");
  });

  it("project.configure requires project_id and PATCHes the right project", async () => {
    const calls: Call[] = [];
    const env = makeEnv(calls);
    await expect(workspaceAdmin.operations["project.configure"]!({ name: "New Name" }, { env, run: noopRun }))
      .rejects.toThrow(/project_id/);

    await workspaceAdmin.operations["project.configure"]!({ project_id: "proj-1", name: "New Name" }, { env, run: noopRun });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toContain("/spaces/space-1/projects/proj-1");
    expect(calls[0]!.body).toEqual({ name: "New Name" });
  });

  it("project.create_from_template rejects an unknown template id without calling the spaces worker", async () => {
    const calls: Call[] = [];
    const env = makeEnv(calls);
    await expect(
      workspaceAdmin.operations["project.create_from_template"]!({ template_id: "no-such-template" }, { env, run: noopRun })
    ).rejects.toThrow(/Unknown project template/);
    expect(calls).toHaveLength(0);
  });

  it("project.create_from_template runs the full create → configure → rules → scheduled_jobs sequence for a real template", async () => {
    const calls: Call[] = [];
    const env = makeEnv(calls, (call) => {
      if (call.method === "POST" && call.url.endsWith("/spaces/space-1/projects")) {
        return { id: "proj-new", name: "Support Bot" };
      }
      return {};
    });
    const result = await workspaceAdmin.operations["project.create_from_template"]!(
      { template_id: "whatsapp-support-bot" },
      { env, run: noopRun }
    );
    expect(result).toMatchObject({ id: "proj-new" });

    // Step 1: create.
    const createCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/spaces/space-1/projects"));
    expect(createCall).toBeTruthy();
    // Step 2: configure (kind/execution_ceiling/spend cap set from the template).
    const configureCall = calls.find((c) => c.method === "PATCH" && c.url.includes("/projects/proj-new"));
    expect(configureCall).toBeTruthy();
    expect((configureCall!.body as { kind: string }).kind).toBe("customer_bot");
    // Every call carries a verified internal token, not a forgeable static header.
    for (const call of calls) {
      expect(await verifyInternalToken(call.headers["x-naelao-internal-token"], "tenant-1", PLATFORM_SECRET)).toBe(true);
    }
  });

  it("throws a clear error when the spaces worker binding is missing", async () => {
    const env = { scriptsBucket: {} as never, spaceId: "space-1", tenantId: "tenant-1", platformSecret: PLATFORM_SECRET } as unknown as ScriptEngineEnv;
    await expect(workspaceAdmin.operations["project.list"]!({}, { env, run: noopRun })).rejects.toThrow(/spaces worker binding/);
  });
});
