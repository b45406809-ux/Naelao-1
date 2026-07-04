/**
 * workspace-admin (§A1.17 Phase G) — lets an agent (specifically the Launchpad business-builder
 * Space Assistant) actually SCAFFOLD a business: create/list/configure projects, and read the
 * space's agent roster. Tier 2 (pure orchestration over the already-existing spaces-worker
 * project routes — no new backend mechanism, per the "reuse, don't reinvent" principle).
 *
 * `project.create_from_template` mirrors the exact 4-step sequence the agents worker's own
 * `POST /spaces/:spaceId/projects/from-template` route already performs (create → configure →
 * seed rules → seed scheduled jobs) rather than calling that route over HTTP — this prebuilt runs
 * inside the SAME Worker as that route (both in workers/agents), and a Durable Object has no
 * "call my own Worker's HTTP router" primitive, so the sequence is replicated against the spaces
 * worker binding directly, using the identical project-templates catalogue.
 *
 * All mutating ops (`project.create_from_template`, `project.configure`) are gate-worthy action
 * names — the Launchpad assistant profile's `requiresApprovalFor` lists them under the default
 * guided (gate_unless_listed) policy so the owner reviews scaffolding before it happens. Read-only
 * ops (`project.list`, `agent.list`) are never gated.
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
    "Scaffold and manage the business's workspace: create fully-configured projects from the " +
    "project-templates catalogue (customer support bots, community monitoring, etc.), list " +
    "existing projects and their configuration, and read the space's installed agent roster. " +
    "Creating or reconfiguring a project is a real structural change to the business — the owner " +
    "reviews it before it happens.",
  domain: "api",
  requires_tier: 2,
  operations: {
    "project.create_from_template": (a, c) => createFromTemplate(c, String(a["template_id"] ?? ""), a["name"] ? String(a["name"]) : undefined),
    "project.list": (_a, c) => spacesCall(c, "GET", `/spaces/${c.env.spaceId}/projects`),
    "project.configure": async (a, c) => {
      const { project_id, ...patch } = a;
      if (!project_id) throw new Error("project.configure requires project_id");
      return spacesCall(c, "PATCH", `/spaces/${c.env.spaceId}/projects/${String(project_id)}`, patch);
    },
    "agent.list": (_a, c) => spacesCall(c, "GET", `/spaces/${c.env.spaceId}/agent-definitions?space_id=${encodeURIComponent(c.env.spaceId)}`),
  },
};
