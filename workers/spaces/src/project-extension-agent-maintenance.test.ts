import { mintInternalToken } from "@naelao/http";
import { describe, expect, it, vi } from "vitest";
import spacesWorker from "./index.js";

const secret = "project-extension-agent-maintenance-secret";
const grantPath = "/spaces/space-a/projects/project-a/extension-installations/instance-a/agent-maintenance-grants";
const proposalPath = "/spaces/space-a/projects/project-a/extension-installations/instance-a/settings-proposals";
const resourceGrantPath = "/spaces/space-a/projects/project-a/extension-installations/instance-a/resource-grants";
const resourceBudgetPath = `${resourceGrantPath}/budget`;

function setup(options: { projectOwner?: string; readable?: boolean; publisherActive?: boolean; trusted?: boolean; usageRows?: unknown[] } = {}) {
  const forwarded: Request[] = [];
  const usageQueries: unknown[][] = [];
  const installation = {
    instance: { instance_id: "instance-a", tenant_id: "tenant-a", space_id: "space-a", project_id: "project-a", scope: "PROJECT_BOUND", status: "active" },
    manifest: { id: "ext_project_voice", bundle: { id: "ext_project_voice", version: "1.0.0" }, settingsActivation: "owner_publish",
      settingsSchema: { schemaVersion: 1, fields: [{ id: "greeting", type: "text", label: "Greeting", required: true }] },
      declaredPermissions: ["extension.settings.read", "extension.settings.configure"],
      capabilityRequirements: ["extension.settings.read", "extension.settings.configure"] },
    release: { version: "1.0.0", signatureValid: true, dependenciesResolved: true, publisher: { keyId: "a".repeat(64) } },
    dependenciesResolved: true,
  };
  const stub = {
    fetch: vi.fn(async (request: Request) => {
      forwarded.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/projects/project-a/members") return Response.json({ data: options.projectOwner ? [{ user_id: options.projectOwner, role: "owner" }] : [] });
      if (url.pathname === "/projects/project-a/automation-access") return options.readable === false
        ? Response.json({ error_code: "forbidden" }, { status: 403 }) : Response.json({ project_id: "project-a", can_read: true });
      if (url.pathname === "/extension-resource-grants") return Response.json({ installation: { instance_id: "instance-a", extension_id: "ext_project_voice",
        tenant_id: "tenant-a", space_id: "space-a", project_id: "project-a", generation: 4, manifest_sha256: "a".repeat(64) }, requirements: [], grants: [], operation_usage: [] });
      if (url.pathname === "/workflow-installation") return options.trusted === false
        ? Response.json({ error_code: "not_found" }, { status: 404 }) : Response.json(installation);
      return Response.json({ forwarded: true, method: request.method, path: url.pathname });
    }),
  };
  const env = {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: async () => options.publisherActive === false ? null : { active: 1 },
      all: async () => { usageQueries.push(values); return { results: sql.includes("extension_resource_jobs") ? options.usageRows ?? [] : [] }; } }) }) },
    SPACE_DO: { idFromName: (name: string) => name, get: () => stub },
  } as never;
  return { env, forwarded, stub, usageQueries };
}

async function call(env: unknown, path: string, options: { method?: string; role?: string; userId?: string; agentId?: string; body?: unknown } = {}) {
  const { method = "GET", role = "owner", userId = "owner-a", agentId, body } = options;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"),
    "x-naelao-tenant-id": "tenant-a",
    "x-naelao-user-id": userId,
    "x-naelao-role": role,
  };
  if (agentId) headers["x-naelao-agent-id"] = agentId;
  return spacesWorker.fetch(new Request(`https://spaces.test${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env as never);
}

describe("Project extension agent maintenance routes", () => {
  it("keeps owner-publish review behind project-owner authority while routing active-value reads", async () => {
    const settingsPath = `${grantPath.replace("/agent-maintenance-grants", "/settings")}`;
    const editor = setup({ projectOwner: "project-owner" });
    expect((await call(editor.env, settingsPath, { userId: "editor-a", role: "editor" })).status).toBe(200);
    const settingsRead = editor.forwarded.at(-1);
    expect(settingsRead && new URL(settingsRead.url).pathname).toBe("/extension-settings");
    expect(settingsRead?.headers.get("x-naelao-project-owner")).toBeNull();
    const settingsReadCount = editor.forwarded.filter(request => new URL(request.url).pathname === "/extension-settings").length;
    expect((await call(editor.env, settingsPath, { userId: "editor-a", role: "editor", method: "PATCH",
      body: { action: "save_draft", settings: { greeting: "Edited" }, draft_revision: 0, base_active_revision: 0 } })).status).toBe(403);
    expect(editor.forwarded.filter(request => new URL(request.url).pathname === "/extension-settings")).toHaveLength(settingsReadCount);

    const owner = setup({ projectOwner: "project-owner" });
    expect((await call(owner.env, settingsPath, { userId: "project-owner", role: "editor", method: "PATCH",
      body: { action: "save_draft", settings: { greeting: "Reviewed" }, draft_revision: 0, base_active_revision: 0 } })).status).toBe(200);
    expect(owner.forwarded.at(-1)?.headers.get("x-naelao-project-owner")).toBe("1");
  });

  it("lets a project owner manage one exact active installation grant", async () => {
    const h = setup({ projectOwner: "project-owner" });
    const response = await call(h.env, grantPath, { role: "editor", userId: "project-owner", method: "PUT",
      body: { agent_id: "voice-agent", permission: "settings.propose", expected_revision: 0 } });
    expect(response.status).toBe(200);
    const workflowInstall = h.forwarded.find(request => new URL(request.url).pathname === "/workflow-installation");
    expect(workflowInstall?.url).toContain("instance_id=instance-a");
    const forwarded = h.forwarded.at(-1);
    expect(forwarded && new URL(forwarded.url).pathname).toBe("/extension-agent-maintenance-grants");
    expect(forwarded?.headers.get("x-naelao-project-manage")).toBe("1");
    await expect(forwarded?.json()).resolves.toMatchObject({ agent_id: "voice-agent", permission: "settings.propose", expected_revision: 0 });
  });

  it("denies non-owners and revoked publisher keys before forwarding a grant change", async () => {
    const nonOwner = setup({ projectOwner: "someone-else" });
    expect((await call(nonOwner.env, grantPath, { role: "editor", userId: "editor-a", method: "PUT",
      body: { agent_id: "voice-agent", permission: "settings.propose", expected_revision: 0 } })).status).toBe(403);
    expect(nonOwner.forwarded.some(request => new URL(request.url).pathname === "/extension-agent-maintenance-grants")).toBe(false);

    const revoked = setup({ publisherActive: false });
    expect((await call(revoked.env, grantPath, { method: "PUT",
      body: { agent_id: "voice-agent", permission: "settings.propose", expected_revision: 0 } })).status).toBe(409);
    expect(revoked.forwarded.some(request => new URL(request.url).pathname === "/extension-agent-maintenance-grants")).toBe(false);
  });

  it("exposes resource grant review only to the exact Project owner", async () => {
    const owner = setup({ projectOwner: "project-owner" });
    const read = await call(owner.env, resourceGrantPath, { userId: "project-owner", role: "editor" });
    expect(read.status).toBe(200);
    const getForward = owner.forwarded.at(-1);
    expect(getForward && new URL(getForward.url).pathname).toBe("/extension-resource-grants");
    expect(getForward?.url).toContain("project_id=project-a");
    expect(getForward?.url).toContain("instance_id=instance-a");

    const change = await call(owner.env, resourceGrantPath, { userId: "project-owner", role: "editor", method: "PUT",
      body: { requirement_id: "records", expected_revision: 0, operations: ["get"], tables: ["records"] } });
    expect(change.status).toBe(200);
    const putForward = owner.forwarded.at(-1);
    expect(putForward && new URL(putForward.url).pathname).toBe("/extension-resource-grants");
    await expect(putForward?.json()).resolves.toMatchObject({ actorId: "project-owner", requirementId: "records",
      expectedRevision: 0, operations: ["get"], tables: ["records"] });

    const denied = setup({ projectOwner: "different-owner" });
    expect((await call(denied.env, resourceGrantPath, { userId: "editor-a", role: "editor", method: "PUT",
      body: { requirement_id: "records", expected_revision: 0, operations: ["get"], tables: ["records"] } })).status).toBe(403);
    expect(denied.forwarded.some(request => new URL(request.url).pathname === "/extension-resource-grants")).toBe(false);
  });

  it("lists only exact current-install job receipts to the Project owner", async () => {
    const row = { job_id: "job-a", requirement_id: "queue", status: "succeeded", dispatch_attempts: 1, payload_bytes: 128,
      deadline_at: 200, created_at: 100, updated_at: 150, started_at: 110, completed_at: 150 };
    const owner = setup({ projectOwner: "project-owner", usageRows: [row] });
    const response = await call(owner.env, `${resourceGrantPath}/usage`, { userId: "project-owner", role: "editor" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ installation_id: "instance-a", generation: 4, operations: [], receipts: [row] });
    expect(owner.usageQueries[0]).toEqual(["tenant-a", "space-a", "project-a", "instance-a", "ext_project_voice", "a".repeat(64), 4]);

    const denied = setup({ projectOwner: "different-owner", usageRows: [row] });
    expect((await call(denied.env, `${resourceGrantPath}/usage`, { userId: "editor-a", role: "editor" })).status).toBe(403);
    expect(denied.usageQueries).toHaveLength(0);
  });

  it("allows only the exact Project owner to set an installation resource budget", async () => {
    const owner = setup({ projectOwner: "project-owner" });
    const response = await call(owner.env, resourceBudgetPath, { userId: "project-owner", role: "editor", method: "PUT",
      body: { expected_revision: 0, max_run_credits: 25, monthly_credits: 250 } });
    expect(response.status).toBe(200);
    const forwarded = owner.forwarded.at(-1);
    expect(forwarded && new URL(forwarded.url).pathname).toBe("/extension-resource-budget");
    await expect(forwarded?.json()).resolves.toMatchObject({ actorId: "project-owner", expectedRevision: 0,
      maxRunCredits: 25, monthlyCredits: 250, instanceId: "instance-a" });

    const denied = setup({ projectOwner: "different-owner" });
    expect((await call(denied.env, resourceBudgetPath, { userId: "editor-a", role: "editor", method: "PUT",
      body: { expected_revision: 0, max_run_credits: 25, monthly_credits: 250 } })).status).toBe(403);
    expect(denied.forwarded.some(request => new URL(request.url).pathname === "/extension-resource-budget")).toBe(false);
  });

  it("forwards only a readable project's exact agent proposal with current installation checks", async () => {
    const h = setup();
    const response = await call(h.env, proposalPath, { method: "POST", agentId: "voice-agent",
      body: { expected_active_revision: 3, expected_draft_revision: 2, changes: { greeting: "Hello" } } });
    expect(response.status).toBe(200);
    const forwarded = h.forwarded.at(-1);
    expect(forwarded && new URL(forwarded.url).pathname).toBe("/extension-settings-agent-proposal");
    expect(forwarded?.headers.get("x-naelao-agent-id")).toBe("voice-agent");
    expect(forwarded?.headers.get("x-naelao-project-read")).toBe("1");
    await expect(forwarded?.json()).resolves.toMatchObject({ expected_active_revision: 3, expected_draft_revision: 2, changes: { greeting: "Hello" } });

    const missingAgent = setup();
    expect((await call(missingAgent.env, proposalPath, { method: "POST", body: { changes: { greeting: "Hello" } } })).status).toBe(403);
    expect(missingAgent.forwarded).toHaveLength(0);
    const unreadable = setup({ readable: false });
    expect((await call(unreadable.env, proposalPath, { method: "POST", agentId: "voice-agent", body: { changes: { greeting: "Hello" } } })).status).toBe(403);
    expect(unreadable.forwarded.some(request => new URL(request.url).pathname === "/extension-settings-agent-proposal")).toBe(false);
  });
});
