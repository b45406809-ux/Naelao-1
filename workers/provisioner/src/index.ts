/**
 * Space Provisioner Queue Worker (spec §62) — handles space_provision and space_deprovision.
 *
 * 10-step transactional provisioner (authoritative per spec byte ~899k):
 *   1. Mark DB as provisioning + write KV cache
 *   2. Load manifest from SpaceTypeRegistryDO (KV-cached 1h via SPACES_WORKER)
 *   3. Instantiate declared platform DOs
 *   4. Initialize R2 prefixes from manifest
 *   5. SpaceDO init hook (space-type-specific initialization)
 *   6. Register workflow templates
 *   7. Deploy external portal (if declared in manifest)
 *   8. Call custom lifecycle.provisionerWorker (for future non-Naelao types — no-op for Launchpad)
 *   9. Install SpaceType agents (4 R2 config files per agent) + register index in SpaceDO
 *  10. Record install in SpaceTypeRegistryDO + flip space to 'active'
 *
 * On any failure: rollback by calling deprovisionSpace with the partial provisioned list.
 */

import { Hono } from "hono";
import { errorResponse, requestId } from "@naelao/http";
import {
  LAUNCHPAD_CORE_AGENTS,
  agentsForTemplate,
  getLaunchpadTemplate,
} from "../../agents/src/launchpad/spacetype.js";
import {
  writeAgentConfig,
  launchpadAgentToProfile,
  businessServicePrebuilts,
  DEFAULT_NAELAO_AGENT,
} from "../../agents/src/script-engine/index.js";
import { SkillLibrary } from "../../agents/src/script-engine/skill-library.js";
import { inheritTemplateSkills } from "../../agents/src/script-engine/federation.js";
import type { AgentConfig } from "../../agents/src/script-engine/index.js";
import type { NaelaoSpaceTypeManifestV2 } from "../../spaces/src/do/SpaceTypeRegistryDO.js";
import { resolveTenancy } from "../../spaces/src/do/SpaceTypeRegistryDO.js";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  SPACES_KV: KVNamespace;
  /** Service binding to naelao-spaces (manifest lookup + SpaceDO proxy + install record). */
  SPACES_WORKER: Fetcher;
  /** Skill library / agent-config R2 bucket (script-first engine). */
  SCRIPTS_R2: R2Bucket;
  /** Workspace R2 bucket for the external portal slug→spaceId KV route. */
  PORTAL_KV?: KVNamespace;
}

interface ProvisionMessage {
  type: "space_provision" | "space_deprovision";
  spaceId: string;
  tenantId: string;
  spaceTypeId: string;
  spaceName: string;
  templateId?: string;
  requestedAt: string;
}

function validateEnv(env: Env): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
}

// ── Manifest loader (step 2) ─────────────────────────────────────────────────

async function loadManifest(
  spaceTypeId: string,
  env: Env
): Promise<NaelaoSpaceTypeManifestV2 | null> {
  const resp = await env.SPACES_WORKER.fetch(
    new Request(`http://spaces-worker/internal/space-types/${spaceTypeId}`, {
      headers: { "x-naelao-internal": "provisioner" },
    })
  );
  if (!resp.ok) return null;
  return resp.json<NaelaoSpaceTypeManifestV2>();
}

// ── Step 9: Install SpaceType agents ────────────────────────────────────────

async function installLaunchpadAgents(
  spaceId: string,
  tenantId: string,
  templateId: string | undefined,
  manifest: NaelaoSpaceTypeManifestV2,
  env: Env
): Promise<void> {
  const agentsToInstall = templateId ? agentsForTemplate(templateId) : LAUNCHPAD_CORE_AGENTS;

  // Manifest-gated business primitives (commerce/storefront/business-email). Merged into
  // every installed agent so the owner's assistant can run the storefront and the
  // fulfilment agent can take payment via the reserved commerce script.
  const extraPrebuilt = businessServicePrebuilts(manifest.productConfig);
  const withServices = (cfg: AgentConfig): AgentConfig =>
    extraPrebuilt.length === 0
      ? cfg
      : { ...cfg, scripts: { ...cfg.scripts, prebuilt: [...new Set([...cfg.scripts.prebuilt, ...extraPrebuilt])] } };

  // Default Naelao Agent — every space gets this (spec §15)
  await writeAgentConfig(env.SCRIPTS_R2, spaceId, DEFAULT_NAELAO_AGENT.agentId, withServices(DEFAULT_NAELAO_AGENT.config));
  await registerAgentIndex(spaceId, tenantId, DEFAULT_NAELAO_AGENT.agentId, "Naelao Agent", "General-purpose agent", null, env);

  for (const agentDef of agentsToInstall) {
    const profile = launchpadAgentToProfile(agentDef);
    await writeAgentConfig(env.SCRIPTS_R2, spaceId, profile.agentId, withServices(profile.config));
    await registerAgentIndex(
      spaceId, tenantId, profile.agentId, agentDef.name, agentDef.description,
      templateId ?? null, env
    );
  }
}

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
    throw new Error(`Failed to register agent '${agentId}' in space '${spaceId}': ${await resp.text()}`);
  }
}

/** Merge a first-run onboarding record into the space's config_json (read-merge-write). */
interface OnboardingState {
  template_id: string;
  status: "pending" | "complete";
  projects: string[];
  setup_scripts: string[];
  created_at: string;
}
async function mergeOnboarding(
  env: Env,
  spaceId: string,
  tenantId: string,
  onboarding: OnboardingState
): Promise<void> {
  const row = await env.PLATFORM_DB.prepare(
    "SELECT config_json FROM spaces WHERE id = ? AND tenant_id = ?"
  ).bind(spaceId, tenantId).first<{ config_json: string | null }>();
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(row?.config_json ?? "{}") as Record<string, unknown>; } catch { /* keep {} */ }
  cfg["onboarding"] = onboarding;
  await env.PLATFORM_DB.prepare(
    "UPDATE spaces SET config_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?"
  ).bind(JSON.stringify(cfg), new Date().toISOString(), spaceId, tenantId).run();
}

// ── 10-step transactional provisioner ───────────────────────────────────────

async function provisionSpace(msg: ProvisionMessage, env: Env): Promise<void> {
  const { spaceId, tenantId, spaceTypeId, spaceName, templateId } = msg;
  const now = new Date().toISOString();
  const provisioned: string[] = [];

  try {
    // Step 1: Mark DB as provisioning + write KV config cache
    await env.PLATFORM_DB.prepare(
      "UPDATE spaces SET status = 'provisioning', updated_at = ? WHERE id = ? AND tenant_id = ?"
    ).bind(now, spaceId, tenantId).run();
    await env.SPACES_KV.put(
      `space:${tenantId}:${spaceId}`,
      JSON.stringify({ spaceId, tenantId, spaceTypeId, name: spaceName, status: "provisioning", provisionedAt: now }),
      { expirationTtl: 86400 }
    );
    provisioned.push("db_status");

    // Step 2: Load SpaceType manifest from registry (KV-cached)
    const manifest = await loadManifest(spaceTypeId, env);
    if (!manifest) throw new Error(`SpaceType not found or not approved: ${spaceTypeId}`);

    // Step 3: Instantiate declared platform DOs (Launchpad declares none — extensible for future types)
    // Each platformDO entry creates a DO instance addressed as space:{spaceId}:{doType}
    for (const doConfig of manifest.backend.platformDOs) {
      // Platform DOs are addressed via the spaces worker; nothing to do here for Launchpad
      provisioned.push(`platform-do:${doConfig.type}`);
    }

    // Step 4: Initialize R2 workspace prefixes declared in manifest
    for (const prefix of manifest.backend.r2Prefixes) {
      await env.SCRIPTS_R2.put(
        `spaces/${spaceId}/${prefix}/.keep`,
        "",
        { customMetadata: { initializedAt: Date.now().toString() } }
      );
    }
    provisioned.push("r2_prefixes");

    // Step 5: SpaceDO init hook (space-type-specific initialization, e.g. default KB categories)
    // We call the spaces worker which proxies to SpaceDO.initSpaceType()
    if (manifest.backend.spaceDoInitHook) {
      const initResp = await env.SPACES_WORKER.fetch(
        new Request(`http://spaces-worker/spaces/${spaceId}/init-spacetype`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-naelao-tenant-id": tenantId,
            "x-naelao-internal": "provisioner",
          },
          body: JSON.stringify({ spaceTypeId, hook: manifest.backend.spaceDoInitHook }),
        })
      );
      if (!initResp.ok) {
        console.warn(`[provisioner] SpaceDO init hook failed for ${spaceId}: ${await initResp.text()}`);
      }
      provisioned.push("spacedo_init_hook");
    }

    // Step 5b: Seed tenancy topology (spec G-Y15). Persist the manifest's tenancy +
    // agency_shell on the D1 spaces row (drives reseller portfolio + sub-space rules)
    // and register the SpaceDO root-space row (the product's space registry, depth 0).
    {
      const tenancy = resolveTenancy(manifest.productConfig);
      const agencyShell = manifest.productConfig?.agencyShell === true;
      await env.PLATFORM_DB.prepare(
        "UPDATE spaces SET tenancy_mode = ?, agency_shell = ? WHERE id = ? AND tenant_id = ?"
      ).bind(tenancy, agencyShell ? 1 : 0, spaceId, tenantId).run();

      const rootResp = await env.SPACES_WORKER.fetch(
        new Request(`http://spaces-worker/spaces/${spaceId}/registry`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-naelao-tenant-id": tenantId,
            "x-naelao-internal": "provisioner",
          },
          body: JSON.stringify({
            id: spaceId,
            name: spaceName,
            space_type: spaceTypeId,
            tenancy_mode: tenancy,
            agency_shell: agencyShell,
          }),
        })
      );
      if (!rootResp.ok) {
        console.warn(`[provisioner] root-space registry seed failed for ${spaceId}: ${await rootResp.text()}`);
      }
      provisioned.push("space_registry");
    }

    // Step 6: Register workflow templates (stored in KV for the triggers worker to pick up)
    for (const wf of manifest.backend.workflowTemplates) {
      await env.SPACES_KV.put(
        `workflow-template:${spaceId}:${wf.id}`,
        JSON.stringify({ ...wf, spaceId, tenantId, registeredAt: now })
      );
    }
    if (manifest.backend.workflowTemplates.length > 0) {
      provisioned.push("workflow_templates");
    }

    // Step 7: Deploy external portal (register slug→spaceId in PORTAL_KV)
    if (manifest.ui.externalPortal?.enabled) {
      const portal = manifest.ui.externalPortal;
      const slug = `${portal.defaultSlug}-${spaceId.slice(0, 8)}`;
      if (env.PORTAL_KV) {
        await env.PORTAL_KV.put(`portal-slug:${slug}`, spaceId);
        await env.PORTAL_KV.put(`portal-space:${spaceId}`, JSON.stringify({
          slug, templateId: portal.templateId, authModel: portal.authModel,
        }));
      }
      provisioned.push("external_portal");
    }

    // Step 8: Custom lifecycle.provisionerWorker (no-op for Launchpad; reserved for future types)
    // Naelao-authored SpaceTypes don't declare provisionerWorkers (they are fully managed here).
    if (manifest.lifecycle.provisionerWorker) {
      const workerResp = await env.SPACES_WORKER.fetch(
        new Request(manifest.lifecycle.provisionerWorker, {
          method: "POST",
          body: JSON.stringify({ action: "provision", spaceId, spaceTypeId, tenantId }),
        })
      );
      if (!workerResp.ok) {
        throw new Error(`Custom provisioner worker failed: ${await workerResp.text()}`);
      }
      provisioned.push("custom_provisioner");
    }

    // Step 9: Install agents — write 4 R2 config files per agent + register index in SpaceDO
    if (spaceTypeId === "launchpad") {
      await installLaunchpadAgents(spaceId, tenantId, templateId, manifest, env);
    }
    provisioned.push("agents");

    // Step 9b: Template bootstrap — inherit the shared template skill library (federated
    // learning) so the space starts with what the fleet has learned, then record the first-run
    // onboarding state (credential/preference prompts + projects) for the dashboard wizard.
    if (spaceTypeId === "launchpad" && templateId) {
      try {
        const spaceLib = new SkillLibrary(env.SCRIPTS_R2, spaceId);
        const templateLib = SkillLibrary.forTemplate(env.SCRIPTS_R2, templateId);
        const res = await inheritTemplateSkills(templateLib, spaceLib);
        if (res.inherited.length > 0) {
          console.log(`[provisioner] inherited ${res.inherited.length} shared skill(s) into ${spaceId} from template ${templateId}`);
        }
      } catch (err) {
        console.warn(`[provisioner] skill inheritance failed for ${spaceId}:`, (err as Error).message);
      }

      const tpl = getLaunchpadTemplate(templateId);
      if (tpl?.bootstrap) {
        await mergeOnboarding(env, spaceId, tenantId, {
          template_id: templateId,
          status: "pending",
          projects: tpl.bootstrap.projects ?? [],
          setup_scripts: tpl.bootstrap.setup_scripts ?? [],
          created_at: now,
        });
      }
      provisioned.push("bootstrap");
    }

    // Step 10: Record install in SpaceTypeRegistryDO + flip space to 'active'
    await env.SPACES_WORKER.fetch(
      new Request(`http://spaces-worker/internal/space-types/${spaceTypeId}/record-install`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-internal": "provisioner",
        },
        body: JSON.stringify({ spaceId, version: manifest.version }),
      })
    );
    await env.PLATFORM_DB.prepare(
      "UPDATE spaces SET status = 'active', updated_at = ? WHERE id = ? AND tenant_id = ?"
    ).bind(now, spaceId, tenantId).run();
    await env.SPACES_KV.put(
      `space:${tenantId}:${spaceId}`,
      JSON.stringify({ spaceId, tenantId, spaceTypeId, name: spaceName, status: "active", provisionedAt: now }),
      { expirationTtl: 86400 }
    );
    provisioned.push("active");

    console.log(`[provisioner] Space ${spaceId} (${spaceTypeId}) provisioned successfully`);
  } catch (err) {
    console.error(`[provisioner] Provisioning failed at: ${provisioned[provisioned.length - 1] ?? "startup"}`, err);
    await rollbackSpace(spaceId, tenantId, spaceTypeId, provisioned, env);
    throw err;
  }
}

// ── Rollback (deprovision partial state on failure) ──────────────────────────

async function rollbackSpace(
  spaceId: string,
  tenantId: string,
  spaceTypeId: string,
  provisioned: string[],
  env: Env
): Promise<void> {
  const has = (step: string) => provisioned.includes(step);
  const now = new Date().toISOString();
  console.warn(`[provisioner] Rolling back space ${spaceId} — provisioned steps: ${provisioned.join(", ")}`);

  try {
    // Delete R2 prefix objects initialized in step 4
    if (has("r2_prefixes")) {
      let cursor: string | undefined;
      const prefix = `spaces/${spaceId}/`;
      do {
        const list = await env.SCRIPTS_R2.list(cursor ? { prefix, cursor } : { prefix });
        if (list.objects.length > 0) {
          await env.SCRIPTS_R2.delete(list.objects.map((o) => o.key));
        }
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
    }
    // Remove workflow template KV entries (step 6)
    if (has("workflow_templates")) {
      let cursor2: string | undefined;
      const wfPrefix = `workflow-template:${spaceId}:`;
      do {
        const list = await env.SPACES_KV.list(cursor2 ? { prefix: wfPrefix, cursor: cursor2 } : { prefix: wfPrefix });
        for (const key of list.keys) await env.SPACES_KV.delete(key.name);
        cursor2 = list.list_complete ? undefined : list.cursor;
      } while (cursor2);
    }
    // Remove portal slug (step 7)
    if (has("external_portal") && env.PORTAL_KV) {
      await env.PORTAL_KV.delete(`portal-space:${spaceId}`);
    }
  } catch (rollbackErr) {
    console.error("[provisioner] Rollback error:", rollbackErr);
  }

  // Always flip DB to 'error' so the UI can show a failure state
  await env.PLATFORM_DB.prepare(
    "UPDATE spaces SET status = 'error', updated_at = ? WHERE id = ? AND tenant_id = ?"
  ).bind(now, spaceId, tenantId).run().catch(() => {});
  await env.SPACES_KV.delete(`space:${tenantId}:${spaceId}`);
}

// ── Deprovisioner ────────────────────────────────────────────────────────────

async function deprovisionSpace(msg: ProvisionMessage, env: Env): Promise<void> {
  const { spaceId, tenantId } = msg;
  const now = new Date().toISOString();

  // Delete all R2 objects under this space's prefix
  let cursor: string | undefined;
  const prefix = `spaces/${spaceId}/`;
  do {
    const list = await env.SCRIPTS_R2.list(cursor ? { prefix, cursor } : { prefix });
    if (list.objects.length > 0) {
      await env.SCRIPTS_R2.delete(list.objects.map((o) => o.key));
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);

  // Remove portal slug
  if (env.PORTAL_KV) {
    const portalMeta = await env.PORTAL_KV.get(`portal-space:${spaceId}`, "json") as { slug?: string } | null;
    if (portalMeta?.slug) await env.PORTAL_KV.delete(`portal-slug:${portalMeta.slug}`);
    await env.PORTAL_KV.delete(`portal-space:${spaceId}`);
  }

  // Flip DB to deleted + remove KV cache
  await env.PLATFORM_DB.prepare(
    "UPDATE spaces SET status = 'deleted', updated_at = ? WHERE id = ? AND tenant_id = ?"
  ).bind(now, spaceId, tenantId).run();
  await env.SPACES_KV.delete(`space:${tenantId}:${spaceId}`);
}

// ── Queue handler ────────────────────────────────────────────────────────────

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

app.get("/health", (c) => c.json({ ok: true, service: "provisioner" }));

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

export default {
  fetch: app.fetch,
  queue: queue as ExportedHandlerQueueHandler<Env>,
} satisfies ExportedHandler<Env>;
