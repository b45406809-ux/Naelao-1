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
      { template_id: "community-member-monitoring" },
      { env, run: noopRun }
    );
    expect(result).toMatchObject({ id: "proj-new" });

    // Step 1: create.
    const createCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/spaces/space-1/projects"));
    expect(createCall).toBeTruthy();
    // Step 2: configure (kind/execution_ceiling/spend cap set from the template).
    const configureCall = calls.find((c) => c.method === "PATCH" && c.url.includes("/projects/proj-new"));
    expect(configureCall).toBeTruthy();
    expect((configureCall!.body as { kind: string }).kind).toBe("workspace");
    // Every call carries a verified internal token, not a forgeable static header.
    for (const call of calls) {
      expect(await verifyInternalToken(call.headers["x-naelao-internal-token"], "tenant-1", PLATFORM_SECRET)).toBe(true);
    }
  });

  // The ad-hoc counterpart to create_from_template: what "New project" in the shell does, for
  // anything the template catalogue has no entry for.
  describe("project.create", () => {
    it("creates a plain named project", async () => {
      const calls: Call[] = [];
      const env = makeEnv(calls, () => ({ id: "proj-new", name: "Q3 Marketing" }));
      const result = await workspaceAdmin.operations["project.create"]!(
        { name: "Q3 Marketing", description: "campaign planning" },
        { env, run: noopRun }
      );
      expect(result).toEqual({ id: "proj-new", name: "Q3 Marketing" });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe("POST");
      expect(calls[0]!.url).toContain("/spaces/space-1/projects");
      // makeEnv has no acting user, i.e. a SYSTEM run (a cron wake). Such a project gets no
      // implicit project_members owner, so the default `private` would hide it from every
      // business member but an owner/admin — observed live on an unattended wake-up that built a
      // real project nobody could see. When the assistant acts for the business, the business is
      // the audience.
      expect(calls[0]!.body).toEqual({ name: "Q3 Marketing", description: "campaign planning", visibility: "public" });
      expect(await verifyInternalToken(calls[0]!.headers["x-naelao-internal-token"], "tenant-1", PLATFORM_SECRET)).toBe(true);
    });

    it("does NOT force visibility when a real person is the acting user", async () => {
      const calls: Call[] = [];
      const env = { ...makeEnv(calls, () => ({ id: "p" })), userId: "user-9" };
      await workspaceAdmin.operations["project.create"]!({ name: "Mine" }, { env, run: noopRun });
      // They become an implicit project member, so SpaceDO's own default applies as before.
      expect(calls[0]!.body).toEqual({ name: "Mine" });
    });

    it("an explicit visibility always wins over the system-run default", async () => {
      const calls: Call[] = [];
      const env = makeEnv(calls, () => ({ id: "p" }));
      await workspaceAdmin.operations["project.create"]!({ name: "Quiet", visibility: "private" }, { env, run: noopRun });
      expect(calls[0]!.body).toEqual({ name: "Quiet", visibility: "private" });
    });

    it("requires a non-blank name", async () => {
      const env = makeEnv([]);
      await expect(workspaceAdmin.operations["project.create"]!({}, { env, run: noopRun })).rejects.toThrow(/requires name/);
      await expect(workspaceAdmin.operations["project.create"]!({ name: "   " }, { env, run: noopRun })).rejects.toThrow(/requires name/);
    });

    it("passes through optional visibility and agent bindings", async () => {
      const calls: Call[] = [];
      const env = makeEnv(calls, () => ({ id: "p" }));
      await workspaceAdmin.operations["project.create"]!(
        { name: "Support", visibility: "public", default_agent_id: "a1", allowed_agent_ids: ["a1", "a2"] },
        { env, run: noopRun }
      );
      expect(calls[0]!.body).toEqual({
        name: "Support", visibility: "public", default_agent_id: "a1", allowed_agent_ids: ["a1", "a2"],
      });
    });
  });

  // §A1.17 Phase T1 ACL — who can see a private project.
  describe("project members", () => {
    it("lists, adds and removes members against the real routes", async () => {
      const calls: Call[] = [];
      const env = makeEnv(calls, () => ({ ok: true }));
      await workspaceAdmin.operations["project.list_members"]!({ project_id: "p1" }, { env, run: noopRun });
      await workspaceAdmin.operations["project.add_member"]!({ project_id: "p1", user_id: "u1", role: "editor" }, { env, run: noopRun });
      await workspaceAdmin.operations["project.remove_member"]!({ project_id: "p1", user_id: "u1" }, { env, run: noopRun });

      expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "DELETE"]);
      expect(calls[0]!.url).toContain("/projects/p1/members");
      expect(calls[1]!.body).toEqual({ user_id: "u1", role: "editor" });
      expect(calls[2]!.url).toContain("/projects/p1/members/u1");
    });

    it("falls back to the run's own project when project_id is omitted", async () => {
      const calls: Call[] = [];
      const env = { ...makeEnv(calls, () => ({})), projectId: "proj-ctx" } as ScriptEngineEnv;
      await workspaceAdmin.operations["project.list_members"]!({}, { env, run: noopRun });
      expect(calls[0]!.url).toContain("/projects/proj-ctx/members");
    });

    it("requires a user_id to add or remove", async () => {
      const env = { ...makeEnv([]), projectId: "p1" } as ScriptEngineEnv;
      await expect(workspaceAdmin.operations["project.add_member"]!({}, { env, run: noopRun })).rejects.toThrow(/user_id/);
      await expect(workspaceAdmin.operations["project.remove_member"]!({}, { env, run: noopRun })).rejects.toThrow(/user_id/);
    });
  });

  // The bug this fixes: without an acting user the spaces worker records created_by=undefined /
  // system_caller=true, so SpaceDO skips the "creator is an implicit project_members owner"
  // insert — and since a project defaults to visibility:'private', listProjects' viewer filter
  // then hid every assistant-scaffolded project from the person who asked for it.
  describe("acting user", () => {
    it("forwards x-naelao-user-id on project.create when the run has one", async () => {
      const calls: Call[] = [];
      const env = { ...makeEnv(calls, () => ({ id: "p" })), userId: "end-user-7" } as ScriptEngineEnv;
      await workspaceAdmin.operations["project.create"]!({ name: "Mine" }, { env, run: noopRun });
      expect(calls[0]!.headers["x-naelao-user-id"]).toBe("end-user-7");
    });

    it("forwards it on every call of a multi-step create_from_template too", async () => {
      const calls: Call[] = [];
      const env = { ...makeEnv(calls, () => ({ id: "proj-new", name: "Support" })), userId: "end-user-7" } as ScriptEngineEnv;
      await workspaceAdmin.operations["project.create_from_template"]!({ template_id: "community-member-monitoring" }, { env, run: noopRun });
      expect(calls.length).toBeGreaterThan(1);
      for (const call of calls) expect(call.headers["x-naelao-user-id"]).toBe("end-user-7");
    });

    it("omits the header for a system run (provisioning/cron) — unchanged from before", async () => {
      const calls: Call[] = [];
      const env = makeEnv(calls, () => ({ id: "p" })); // no userId
      await workspaceAdmin.operations["project.create"]!({ name: "Seeded" }, { env, run: noopRun });
      expect(calls[0]!.headers["x-naelao-user-id"]).toBeUndefined();
      expect(await verifyInternalToken(calls[0]!.headers["x-naelao-internal-token"], "tenant-1", PLATFORM_SECRET)).toBe(true);
    });
  });

  it("throws a clear error when the spaces worker binding is missing", async () => {
    const env = { scriptsBucket: {} as never, spaceId: "space-1", tenantId: "tenant-1", platformSecret: PLATFORM_SECRET } as unknown as ScriptEngineEnv;
    await expect(workspaceAdmin.operations["project.list"]!({}, { env, run: noopRun })).rejects.toThrow(/spaces worker binding/);
  });
});
