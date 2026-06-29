// G-Q01: Space Provisioning Queue Worker — handles space_provision and space_deprovision messages
import { Hono } from "hono";
import { errorResponse, requestId } from "@naelao/http";
import {
  LAUNCHPAD_CORE_AGENTS,
  agentsForTemplate,
} from "../../agents/src/launchpad/spacetype.js";
import {
  writeAgentConfig,
  launchpadAgentToProfile,
  DEFAULT_NAELAO_AGENT,
} from "../../agents/src/script-engine/index.js";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  SPACES_KV: KVNamespace;
  SPACES_WORKER: Fetcher; // Service binding to naelao-spaces (for SpaceDO agent_definitions registry index)
  /** Skill library / agent-config R2 bucket (script-first engine — the authoritative agent model). */
  SCRIPTS_R2: R2Bucket;
}

interface ProvisionMessage {
  type: "space_provision" | "space_deprovision";
  spaceId: string;
  tenantId: string;
  spaceTypeId: string;
  spaceName: string;
  /** For Launchpad: which template was selected (e.g. "creator-store") */
  templateId?: string;
  requestedAt: string;
}

function validateEnv(env: Env): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
}

/**
 * Install Launchpad agents into a new space (authoritative agent model — spec appendix
 * ~6672k). For each agent we:
 *   1. Write the four R2 config files (agents.md, system-prompt.md, scripts.json,
 *      skills.json) from its profile — THIS is what actually defines the agent the
 *      script-first engine loads (agent-config.ts / profiles.ts).
 *   2. Register the agent in SpaceDO `agent_definitions` as the space-level registry
 *      INDEX (repurposed per CLAUDE.md #8 — index of installed agents, not behavior).
 * Every space also gets the Default Naelao Agent (spec §15).
 */
async function installLaunchpadAgents(
  spaceId: string,
  tenantId: string,
  templateId: string | undefined,
  env: Env
): Promise<void> {
  // Resolve which agents to install: template-specific subset, or all core agents.
  const agentsToInstall = templateId ? agentsForTemplate(templateId) : LAUNCHPAD_CORE_AGENTS;

  // Default Naelao Agent — shipped to every space (spec §15).
  await writeAgentConfig(env.SCRIPTS_R2, spaceId, DEFAULT_NAELAO_AGENT.agentId, DEFAULT_NAELAO_AGENT.config);
  await registerAgentIndex(spaceId, tenantId, DEFAULT_NAELAO_AGENT.agentId, "Naelao Agent", "General-purpose agent", null, env);

  for (const agentDef of agentsToInstall) {
    // 1. Write the four R2 config files from the agent's profile.
    const profile = launchpadAgentToProfile(agentDef);
    await writeAgentConfig(env.SCRIPTS_R2, spaceId, profile.agentId, profile.config);

    // 2. Register in the SpaceDO registry index.
    await registerAgentIndex(
      spaceId,
      tenantId,
      profile.agentId,
      agentDef.name,
      agentDef.description,
      templateId ?? null,
      env
    );
  }
}

/** Register an installed agent in SpaceDO `agent_definitions` as a lightweight index row. */
async function registerAgentIndex(
  spaceId: string,
  tenantId: string,
  agentId: string,
  name: string,
  description: string,
  templateId: string | null,
  env: Env
): Promise<void> {
  const payload = {
    id: `${spaceId}:${agentId}`,
    space_id: spaceId,
    name,
    description,
    config: {
      // Index only — the behavior lives in the 4 R2 files. We record where to find it.
      agent_id: agentId,
      config_path: `spaces/${spaceId}/agents/${agentId}/`,
      spacetype_id: "launchpad",
      template_id: templateId,
    },
  };

  const resp = await env.SPACES_WORKER.fetch(
    new Request(`http://spaces-worker/spaces/${spaceId}/agent-definitions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": tenantId,
        "x-naelao-internal": "provisioner",
      },
      body: JSON.stringify(payload),
    })
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Failed to register agent '${agentId}' in space '${spaceId}': ${err}`);
  }
}

async function provisionSpace(msg: ProvisionMessage, env: Env): Promise<void> {
  const { spaceId, tenantId, spaceTypeId, spaceName, templateId } = msg;
  const now = new Date().toISOString();

  // Step 1: Mark space as provisioning
  await env.PLATFORM_DB.prepare(
    "UPDATE spaces SET status = 'provisioning', updated_at = ? WHERE id = ? AND tenant_id = ?"
  ).bind(now, spaceId, tenantId).run();

  // Step 2: Store initial config in KV for fast reads
  const spaceConfig = {
    spaceId,
    tenantId,
    spaceTypeId,
    name: spaceName,
    status: "active",
    provisionedAt: now,
  };
  await env.SPACES_KV.put(`space:${tenantId}:${spaceId}`, JSON.stringify(spaceConfig), { expirationTtl: 86400 });

  // Step 3: Fetch SpaceType config to get default tools/system prompt
  const spaceType = await env.PLATFORM_DB.prepare(
    "SELECT id, name, config_json FROM space_types WHERE id = ?"
  ).bind(spaceTypeId).first<{ id: string; name: string; config_json: string }>();

  const config = spaceType ? JSON.parse(spaceType.config_json) as Record<string, unknown> : {};

  // Step 4: Write default welcome message to D1
  const welcomeMessageId = crypto.randomUUID();
  const welcomeContent = typeof config["welcome_message"] === "string"
    ? config["welcome_message"]
    : `Welcome to ${spaceName}! How can I help you today?`;

  await env.PLATFORM_DB.prepare(
    `INSERT OR IGNORE INTO space_welcome_messages (id, space_id, tenant_id, content, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    welcomeMessageId,
    spaceId,
    tenantId,
    welcomeContent,
    now
  ).run();

  // Step 5: Install SpaceType agents — write the 4 R2 config files (the agent definition
  // the script-first engine loads) + register each in the SpaceDO index.
  if (spaceTypeId === "launchpad") {
    await installLaunchpadAgents(spaceId, tenantId, templateId, env);
  }

  // Step 6: Mark space as active
  await env.PLATFORM_DB.prepare(
    "UPDATE spaces SET status = 'active', updated_at = ? WHERE id = ? AND tenant_id = ?"
  ).bind(now, spaceId, tenantId).run();
}

async function deprovisionSpace(msg: ProvisionMessage, env: Env): Promise<void> {
  const { spaceId, tenantId } = msg;
  const now = new Date().toISOString();

  // Mark space as deleted
  await env.PLATFORM_DB.prepare(
    "UPDATE spaces SET status = 'deleted', updated_at = ? WHERE id = ? AND tenant_id = ?"
  ).bind(now, spaceId, tenantId).run();

  // Remove KV cache
  await env.SPACES_KV.delete(`space:${tenantId}:${spaceId}`);
}

export async function queue(batch: MessageBatch<ProvisionMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (message.body.type === "space_provision") {
        await provisionSpace(message.body, env);
      } else if (message.body.type === "space_deprovision") {
        await deprovisionSpace(message.body, env);
      }
      message.ack();
    } catch (err) {
      console.error("[provisioner] Error processing message:", err);
      message.retry();
    }
  }
}

const app = new Hono<{ Bindings: Env }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

// GET /health — health check
app.get("/health", (c) => c.json({ ok: true, service: "provisioner" }));

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

export default {
  fetch: app.fetch,
  queue: queue as ExportedHandlerQueueHandler<Env>,
} satisfies ExportedHandler<Env>;
