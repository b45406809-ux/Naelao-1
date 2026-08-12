/**
 * workspace-admin (§A1.17 Phase G) — lets an agent (specifically the Launchpad business-builder
 * Space Assistant) actually SCAFFOLD a business: create/list/configure projects, manage who can
 * see a project, and read the space's agent roster. Tier 2 (pure orchestration over the
 * already-existing spaces-worker project routes — no new backend mechanism, per the "reuse, don't
 * reinvent" principle).
 *
 * `project.create_from_template` mirrors the exact 4-step sequence the agents worker's own
 * `POST /spaces/:spaceId/projects/from-template` route already performs (create → configure →
 * seed rules → seed scheduled jobs) rather than calling that route over HTTP — this prebuilt runs
 * inside the SAME Worker as that route (both in workers/agents), and a Durable Object has no
 * "call my own Worker's HTTP router" primitive, so the sequence is replicated against the spaces
 * worker binding directly, using the identical project-templates catalogue.
 * `project.create` is the ad-hoc counterpart: a plain named project for something the catalogue
 * has no template for, which is what a person clicking "New project" in the shell gets.
 *
 * ACTING USER (§A1.18 follow-up — this fixes a real bug, not just attribution). Every call below
 * forwards `x-naelao-user-id` when the run has an acting user. Without it the spaces worker
 * computes `created_by: undefined, system_caller: true`, and since a project defaults to
 * `visibility:'private'`, `SpaceDO.createProject`'s "creator is always an implicit project_members
 * owner" insert is skipped (`if (... && body.created_by)`) — so `listProjects`' viewer filter hid
 * every assistant-scaffolded project from everyone except a space owner/admin. The person who
 * asked for the project could not see it. Forwarding the user also correctly CLAMPS the assistant
 * to what that person could do unaided (a plain member asking for a project-member change now gets
 * the same 403 they would get themselves), which is the same principle F-36's
 * `resolveAssistantEffectiveRole` already established.
 *
 * All mutating ops (`project.create`, `project.create_from_template`, `project.configure`,
 * `project.add_member`, `project.remove_member`) are gate-worthy action names — under the default
 * guided policy the owner reviews structural changes before they happen. Read-only ops
 * (`project.list`, `project.list_members`, `agent.list`) are never gated. Archiving a project is
 * `project.configure` with `status: 'archived'` rather than its own op — the PATCH is a
 * passthrough, so name/description/visibility/caps/agent-bindings/status all go through one place.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { mintInternalToken } from "@naelao/http";
import { getProjectTemplate } from "../../launchpad/project-templates.js";

async function spacesCall(ctx: PrebuiltOpContext, method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
  if (!ctx.env.spacesWorker) throw new Error("workspace-admin unavailable: spaces worker binding not configured");
  const token = await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId);
  const resp = await ctx.env.spacesWorker.fetch(
    new Request(`http://spaces-worker${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": ctx.env.tenantId,
        "x-naelao-internal-token": token,
        // Act ON BEHALF OF the person who asked, whenever there is one. This is load-bearing, not
        // cosmetic — see the header note above. Omitted (byte-identical to the prior behavior) for
        // a genuinely system-initiated run: a cron tick, a channel drain, or provision-time
        // scaffolding, none of which have an acting user.
        ...(ctx.env.userId ? { "x-naelao-user-id": ctx.env.userId } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );
  if (!resp.ok) throw new Error(`workspace-admin ${method} ${path} failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function createFromTemplate(ctx: PrebuiltOpContext, templateId: string, name?: string): Promise<unknown> {
  const template = getProjectTemplate(templateId);
  if (!template) throw new Error(`Unknown project template: ${templateId}`);
  const spaceId = ctx.env.spaceId;

  // 1. Create the project.
  const project = (await spacesCall(ctx, "POST", `/spaces/${spaceId}/projects`, {
    name: name ?? template.name,
    description: template.description,
    ...(template.default_agent_id ? { default_agent_id: template.default_agent_id } : {}),
    ...(template.allowed_agent_ids && template.allowed_agent_ids.length > 0 ? { allowed_agent_ids: template.allowed_agent_ids } : {}),
  })) as { id: string; name: string };

  // 2. Configure it (kind, execution ceiling, spend cap, thread cap, suggested channel).
  await spacesCall(ctx, "PATCH", `/spaces/${spaceId}/projects/${project.id}`, {
    kind: template.kind,
    execution_ceiling: template.execution_ceiling,
    daily_spend_cap_credits: template.daily_spend_cap_credits,
    ...(template.max_threads !== undefined ? { max_threads: template.max_threads } : {}),
    ...(template.kind === "customer_bot" && template.suggested_channel
      ? { channel_config: { [template.suggested_channel]: { connected: false } } }
      : {}),
  });

  // 3. Seed starter rules.
  for (const rule of template.rules ?? []) {
    await spacesCall(ctx, "POST", `/spaces/${spaceId}/projects/${project.id}/rules`, { ...rule });
  }

  // 4. Seed scheduled jobs.
  for (const job of template.scheduled_jobs ?? []) {
    await spacesCall(ctx, "POST", `/spaces/${spaceId}/scheduled-jobs`, { ...job, project_id: project.id });
  }

  return project;
}

export const workspaceAdmin: PrebuiltScript = {
  name: "workspace-admin",
  description:
    "Scaffold and manage the business's workspace: create a new project (either a plain one, or " +
    "fully configured from the project-templates catalogue — customer support bots, community " +
    "monitoring, etc.), list and reconfigure existing projects (including renaming and archiving " +
    "them), control who can see a private project, and read the space's installed agent roster. " +
    "Creating or reconfiguring a project is a real structural change to the business — the owner " +
    "reviews it before it happens.",
  domain: "api",
  requires_tier: 2,
  operations: {
    // The ad-hoc counterpart to create_from_template: what "New project" in the shell does. Use
    // this whenever the person asks for a project the template catalogue has no entry for.
    "project.create": async (a, c) => {
      const name = String(a["name"] ?? "").trim();
      if (!name) throw new Error("project.create requires name");
      // A project created on a SYSTEM run (a cron wake, a channel drain) has no acting user, so
      // SpaceDO skips its "the creator is an implicit project_members owner" insert — and the
      // default `private` visibility then hides it from every business member except an
      // owner/admin. Observed live: an unattended wake-up built a real project, posted a real
      // brief into it, and produced something ordinary members could not see, belonging to
      // nobody. When the assistant acts for the business rather than for a person, the business
      // is the audience. An explicit visibility from the caller still wins.
      const systemRun = !c.env.userId;
      return spacesCall(c, "POST", `/spaces/${c.env.spaceId}/projects`, {
        name,
        ...(a["description"] ? { description: String(a["description"]) } : {}),
        ...(a["visibility"] ? { visibility: String(a["visibility"]) } : systemRun ? { visibility: "public" } : {}),
        ...(a["default_agent_id"] ? { default_agent_id: String(a["default_agent_id"]) } : {}),
        ...(Array.isArray(a["allowed_agent_ids"]) ? { allowed_agent_ids: a["allowed_agent_ids"] } : {}),
      });
    },
    "project.create_from_template": (a, c) => createFromTemplate(c, String(a["template_id"] ?? ""), a["name"] ? String(a["name"]) : undefined),
    "project.list": (_a, c) => spacesCall(c, "GET", `/spaces/${c.env.spaceId}/projects`),
    "project.configure": async (a, c) => {
      const { project_id, ...patch } = a;
      if (!project_id) throw new Error("project.configure requires project_id");
      return spacesCall(c, "PATCH", `/spaces/${c.env.spaceId}/projects/${String(project_id)}`, patch);
    },
    // Project membership (§A1.17 Phase T1 ACL) — who can see/work in a private project. Reaching
    // these at all requires the acting user to be an admin of the business, enforced by
    // requireBusinessMembership on the route, not re-implemented here.
    "project.list_members": async (a, c) => {
      const projectId = String(a["project_id"] ?? "") || c.env.projectId;
      if (!projectId) throw new Error("project.list_members requires project_id");
      return spacesCall(c, "GET", `/spaces/${c.env.spaceId}/projects/${encodeURIComponent(projectId)}/members`);
    },
    "project.add_member": async (a, c) => {
      const projectId = String(a["project_id"] ?? "") || c.env.projectId;
      const userId = String(a["user_id"] ?? "");
      if (!projectId || !userId) throw new Error("project.add_member requires project_id and user_id");
      return spacesCall(c, "POST", `/spaces/${c.env.spaceId}/projects/${encodeURIComponent(projectId)}/members`, {
        user_id: userId,
        ...(a["role"] ? { role: String(a["role"]) } : {}),
      });
    },
    "project.remove_member": async (a, c) => {
      const projectId = String(a["project_id"] ?? "") || c.env.projectId;
      const userId = String(a["user_id"] ?? "");
      if (!projectId || !userId) throw new Error("project.remove_member requires project_id and user_id");
      return spacesCall(
        c, "DELETE",
        `/spaces/${c.env.spaceId}/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`
      );
    },
    "agent.list": (_a, c) => spacesCall(c, "GET", `/spaces/${c.env.spaceId}/agent-definitions?space_id=${encodeURIComponent(c.env.spaceId)}`),
  },
  // See PrebuiltScript.paramHints's own doc (project-coordination.ts has the fuller story).
  paramHints: {
    "project.create": "name (string, REQUIRED). description (string, optional). visibility " +
      "(\"private\"|\"public\", optional). default_agent_id/allowed_agent_ids (optional).",
    "project.create_from_template": "template_id (string, REQUIRED — from the project-templates " +
      "catalogue). name (string, optional — a custom name instead of the template's default).",
    "project.list": "no parameters.",
    "project.configure": "project_id (string, REQUIRED — the project to change). Every other field " +
      "is a partial patch (e.g. name, description, status:\"archived\", visibility).",
    "project.list_members": "project_id (string, optional — defaults to this run's own project).",
    "project.add_member": "project_id (string, optional — defaults to this run's own project). " +
      "user_id (string, REQUIRED). role (string, optional).",
    "project.remove_member": "project_id (string, optional — defaults to this run's own project). " +
      "user_id (string, REQUIRED).",
    "agent.list": "no parameters.",
  },
};
