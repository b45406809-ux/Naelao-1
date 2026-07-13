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
import { errorResponse, requestId, mintInternalToken } from "@naelao/http";
import {
  LAUNCHPAD_CORE_AGENTS,
  agentsForTemplates,
  getLaunchpadTemplate,
  type LaunchpadAgentDefinition,
} from "../../agents/src/launchpad/spacetype.js";
import {
  writeAgentConfig,
  launchpadAgentToProfile,
  businessServicePrebuilts,
  LAUNCHPAD_ASSISTANT_PROFILE,
  LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED,
} from "../../agents/src/script-engine/index.js";
import { SkillLibrary } from "../../agents/src/script-engine/skill-library.js";
import { seedScalingSkills } from "../../agents/src/launchpad/scaling-skills.js";
import { seedGrowthSkills } from "../../agents/src/launchpad/growth-skills.js";
import { inheritTemplateSkills } from "../../agents/src/script-engine/federation.js";
import type { AgentConfig } from "../../agents/src/script-engine/index.js";
import type { NaelaoSpaceTypeManifestV2 } from "../../spaces/src/do/SpaceTypeRegistryDO.js";
import { resolveTenancy } from "../../spaces/src/do/SpaceTypeRegistryDO.js";

export interface Env {
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
  /** Phase C (§A1.17): a business built from more than one template. When set, takes priority
   *  over the singular `templateId` (which stays as the first entry for back-compat readers). */
  templateIds?: string[];
  requestedAt: string;
  /** The user who created this space — registered as space_members owner in step 5c.
   *  Optional only for backward compatibility with any already-queued messages; every new
   *  enqueue (POST /spaces, POST /reseller/spaces) sets it.
   *
   *  F-45 (trust boundary — do not weaken): `userId` is TRUSTED. It is sourced from verified
   *  auth in createSpaceRecord (getCallerIdentity), never from client-supplied input, and
   *  seedOwnerMember (step 5c) registers it as `owner` of the space using a platform-secret
   *  internal token. ProvisionMessages arrive only from the internal provisioning queue, which
   *  is enqueued exclusively by that verified path. Never accept `userId` from an untrusted
   *  source — doing so would let an attacker register themselves as owner of any space. */
  userId?: string;
}

function validateEnv(env: Env): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
}

// ── Manifest loader (step 2) ─────────────────────────────────────────────────

async function loadManifest(
  spaceTypeId: string,
  env: Env,
  tenantId: string
): Promise<NaelaoSpaceTypeManifestV2 | null> {
  const resp = await env.SPACES_WORKER.fetch(
    new Request(`http://spaces-worker/internal/space-types/${spaceTypeId}`, {
      headers: {
        "x-naelao-tenant-id": tenantId,
        "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
      },
    })
  );
  if (!resp.ok) return null;
  return resp.json<NaelaoSpaceTypeManifestV2>();
}

// ── Step 9: Install SpaceType agents ────────────────────────────────────────

export async function installLaunchpadAgents(
  spaceId: string,
  tenantId: string,
  templateId: string | string[] | undefined,
  manifest: NaelaoSpaceTypeManifestV2,
  env: Env
): Promise<void> {
  // Phase C (§A1.17): a business can be built from more than one template — normalize to an
  // array so the single-id call sites (every one before this pass) keep working unchanged.
  const templateIds = Array.isArray(templateId) ? templateId : templateId ? [templateId] : [];
  const agentsToInstall = templateIds.length > 0 ? agentsForTemplates(templateIds) : LAUNCHPAD_CORE_AGENTS;
  const primaryTemplateId = templateIds[0] ?? null;

  // Manifest-gated business primitives (commerce/storefront/business-email). Merged into
  // every installed agent so the owner's assistant can run the storefront and the
  // fulfilment agent can take payment via the reserved commerce script.
  const extraPrebuilt = businessServicePrebuilts(manifest.productConfig);
  const withServices = (cfg: AgentConfig): AgentConfig =>
    extraPrebuilt.length === 0
      ? cfg
      : { ...cfg, scripts: { ...cfg.scripts, prebuilt: [...new Set([...cfg.scripts.prebuilt, ...extraPrebuilt])] } };

  // Space Assistant — every space gets this (spec §15). Launchpad gets the business-builder
  // profile (§A1.17 Phase G) instead of the generic one — same agentId ("naelao-agent"), same
  // dispatch, richer prompt.
  await writeAgentConfig(env.SCRIPTS_R2, spaceId, LAUNCHPAD_ASSISTANT_PROFILE.agentId, withServices(LAUNCHPAD_ASSISTANT_PROFILE.config));
  await registerAgentIndex(spaceId, tenantId, LAUNCHPAD_ASSISTANT_PROFILE.agentId, "Naelao Agent", "Business-builder Space Assistant", null, manifest.id, env);
  await seedLaunchpadAssistantPolicy(spaceId, tenantId, env);

  for (const agentDef of agentsToInstall) {
    const profile = launchpadAgentToProfile(agentDef);
    await writeAgentConfig(env.SCRIPTS_R2, spaceId, profile.agentId, withServices(profile.config));
    await registerAgentIndex(
      spaceId, tenantId, profile.agentId, agentDef.name, agentDef.description,
      primaryTemplateId, manifest.id, env
    );
    await installAgentTrigger(spaceId, tenantId, agentDef, env);
  }

  // F-3d: seed the prebuilt business-scaling skills into this space's own skill library so a
  // builder never starts from scratch — the assistant can discover them via script.find (they're
  // well-tagged so find works even before embeddings are computed) and wire them into its
  // methodology. Best-effort/idempotent — never fails a provision.
  try {
    const spaceLib = new SkillLibrary(env.SCRIPTS_R2, spaceId);
    const seeded = await seedScalingSkills(spaceLib);
    if (seeded.length > 0) console.log(`[provisioner] seeded ${seeded.length} scaling skill(s) into ${spaceId}`);
  } catch (err) {
    console.warn(`[provisioner] scaling-skill seed failed for ${spaceId}:`, (err as Error).message);
  }

  // Growth-layer skills (social posting, image/video generation) — same idempotent/best-effort
  // seed as the scaling skills above, just a separate try/catch so one failing set never blocks
  // the other.
  try {
    const spaceLib = new SkillLibrary(env.SCRIPTS_R2, spaceId);
    const seeded = await seedGrowthSkills(spaceLib);
    if (seeded.length > 0) console.log(`[provisioner] seeded ${seeded.length} growth skill(s) into ${spaceId}`);
  } catch (err) {
    console.warn(`[provisioner] growth-skill seed failed for ${spaceId}:`, (err as Error).message);
  }
}

/**
 * §A1.17 Phase G: seed the "guided" assistant_policy default (always_ask + a read-only
 * auto_approved_actions allowlist) for a new Launchpad space, so the business-builder assistant
 * can look around (list projects/agents, check orders, list MCP servers) without asking
 * permission for every read, but still asks before it scaffolds a project or spends anything.
 * The builder can flip this to `yolo` (fully autonomous) any time via the existing
 * PATCH /assistant-policy endpoint. Best-effort: a failed seed logs and does not fail
 * provisioning (same posture as seedOwnerMember) — fetchAssistantPolicy's own fail-closed
 * default (always_ask, no auto-approved actions) is a safe fallback if this never lands.
 */
export async function seedLaunchpadAssistantPolicy(spaceId: string, tenantId: string, env: Env): Promise<boolean> {
  const resp = await env.SPACES_WORKER.fetch(
    new Request(`http://spaces-worker/spaces/${spaceId}/assistant-policy`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": tenantId,
        "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
      },
      body: JSON.stringify({ approval_mode: "always_ask", auto_approved_actions: LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED }),
    })
  ).catch((err: Error) => {
    console.warn(`[provisioner] assistant policy seed request failed for ${spaceId}: ${err.message}`);
    return null;
  });
  if (!resp || !resp.ok) {
    console.warn(`[provisioner] assistant policy seed failed for ${spaceId}${resp ? `: ${await resp.text()}` : ""}`);
    return false;
  }
  return true;
}

/**
 * F: LaunchpadAgentDefinition.trigger (spec §11) was installed as data but nothing ever read
 * it — every dispatcher hardcodes "naelao-agent", so e.g. the Content agent's
 * `cron: "0 9 * * *"` schedule never actually ran the specialist. Translate the trigger into a
 * REAL wake path at install time:
 *
 *   - schedule → a scheduled_jobs row (spaces worker POST .../scheduled-jobs), with agent_id +
 *     goal set so the dispatcher (workers/agents/src/index.ts handleAgentTick) wakes the
 *     specialist's own full reasoning loop on its cron (migration 0043), not a bare script
 *     fire — drafting content needs judgment, not a deterministic tool call.
 *
 *   - webhook → deliberately NOT translated into an event_triggers row here. event_triggers
 *     (SpaceDO) only fires on STRUCTURAL in-space events (thread.created, project.created, ...);
 *     it has no "order.completed" or "message.received" event source, so a row for either would
 *     sit inert forever. Both of this SpaceType's webhook agents are wired through their own
 *     existing, more specific dispatch instead: launchpad-fulfillment-v1's "order.completed" is
 *     resolved directly by the billing worker (workers/billing/src/lemon-squeezy.ts — see the
 *     routing decision documented there), and launchpad-support-v1's "message.received" already
 *     reaches the space through channel_links → project binding. See appendix A1.16.x for the
 *     full reasoning.
 *
 *   - manual → nothing to wire; it only runs when the owner messages it directly.
 *
 * Best-effort: a failed trigger install logs and does not fail provisioning (same posture as
 * the other non-critical install steps above — spacedo_init_hook, workflow_templates).
 */
async function installAgentTrigger(
  spaceId: string,
  tenantId: string,
  agentDef: LaunchpadAgentDefinition,
  env: Env
): Promise<void> {
  if (agentDef.trigger.type !== "schedule") return;
  const cron = agentDef.trigger.cron;
  if (!cron) return;

  try {
    const resp = await env.SPACES_WORKER.fetch(
      new Request(`http://spaces-worker/spaces/${spaceId}/scheduled-jobs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": tenantId,
          "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
        },
        body: JSON.stringify({
          name: `${agentDef.name} — scheduled run`,
          cron_expression: cron,
          agent_id: agentDef.id,
          goal:
            `Run your scheduled work per your role: ${agentDef.description}. Use script.find for ` +
            "a library script that already does this before reasoning from scratch, and distill " +
            "a new one when you succeed so future runs are cheaper.",
        }),
      })
    );
    if (!resp.ok) {
      console.warn(`[provisioner] scheduled-job install failed for agent '${agentDef.id}' in space '${spaceId}': ${await resp.text()}`);
    }
  } catch (err) {
    console.warn(`[provisioner] scheduled-job install threw for agent '${agentDef.id}' in space '${spaceId}':`, (err as Error).message);
  }
}

async function registerAgentIndex(
  spaceId: string,
  tenantId: string,
  agentId: string,
  name: string,
  description: string,
  templateId: string | null,
  spaceTypeId: string,
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
      spacetype_id: spaceTypeId,
      template_id: templateId,
    },
  };
  // S0.6: /agent-definitions* is now gated inline with requireInternalHmac (A1.16.9/.10) — the
  // old static "x-naelao-internal: provisioner" string would 403 unconditionally, silently
  // breaking agent registration for every newly provisioned space.
  const resp = await env.SPACES_WORKER.fetch(
    new Request(`http://spaces-worker/spaces/${spaceId}/agent-definitions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": tenantId,
        "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
      },
      body: JSON.stringify(payload),
    })
  );
  if (!resp.ok) {
    throw new Error(`Failed to register agent '${agentId}' in space '${spaceId}': ${await resp.text()}`);
  }
}

/** A template project seed, normalized to the object shape (see spacetype.ts's
 *  TemplateProjectSeed) — a plain name is stored as `{ name }` with no default_agent_id. */
interface OnboardingProject {
  name: string;
  default_agent_id?: string;
}

/** Merge a first-run onboarding record into the space's config_json (read-merge-write). */
interface OnboardingState {
  template_id: string;
  /** Phase C (§A1.17): every template this business was built from; template_id stays the
   *  first entry for back-compat readers of the singular field. */
  template_ids?: string[];
  status: "pending" | "complete";
  projects: OnboardingProject[];
  setup_scripts: string[];
  created_at: string;
}

/** Merge bootstrap (projects + setup_scripts) across multiple templates. Projects dedupe by
 *  name — a later template's definition of the same project name overrides an earlier one
 *  (e.g. a different default_agent_id); setup_scripts dedupe by value, insertion order
 *  preserved. */
function mergeTemplatesBootstrap(templateIds: string[]): { projects: OnboardingProject[]; setup_scripts: string[] } {
  const projectsByName = new Map<string, OnboardingProject>();
  const setupScripts = new Set<string>();
  for (const id of templateIds) {
    const tpl = getLaunchpadTemplate(id);
    if (!tpl?.bootstrap) continue;
    for (const p of tpl.bootstrap.projects ?? []) {
      const project: OnboardingProject = typeof p === "string" ? { name: p } : p;
      projectsByName.set(project.name, project);
    }
    for (const s of tpl.bootstrap.setup_scripts ?? []) setupScripts.add(s);
  }
  return { projects: Array.from(projectsByName.values()), setup_scripts: Array.from(setupScripts) };
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

// Step 5c: register the creator as space_members owner. Previously nothing in the platform
// EVER inserted this row for either a normal builder (POST /spaces) or a reseller customer
// (POST /reseller/spaces) — space_members stayed empty except for paid seat activations
// (billing/lemon-squeezy.ts), so the person who actually created and runs the space was never
// a member of it. Idempotent (addMember upserts on conflict), so a retry of this queue message
// is safe. Returns whether the owner row was seeded (false on missing userId or a failed call —
// never throws, since a failure here must not roll back an otherwise-successful provision).
export async function seedOwnerMember(
  env: Env,
  spaceId: string,
  tenantId: string,
  userId: string | undefined
): Promise<boolean> {
  if (!userId) {
    console.warn(`[provisioner] no userId on provision message for ${spaceId} — owner member not seeded`);
    return false;
  }
  const memberResp = await env.SPACES_WORKER.fetch(
    new Request(`http://spaces-worker/spaces/${spaceId}/members`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": tenantId,
        "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
      },
      body: JSON.stringify({ space_id: spaceId, user_id: userId, role: "owner" }),
    })
  );
  if (!memberResp.ok) {
    console.warn(`[provisioner] owner member seed failed for ${spaceId}: ${await memberResp.text()}`);
    return false;
  }
  return true;
}

// Metering enforcement follow-up: a project-scoped run (customer-bot type projects — the actual
// common case for a Launchpad business) with no builder-configured daily_spend_cap_credits used
// to run completely unmetered, with no payer of any kind. wallet_ledger (Launchpad Wallet) already
// existed and was ALWAYS meant to double as this sink (its own migration comment: "drawn down for
// Naelao's own metered platform costs... beyond a project's normal daily_spend_cap_credits") — but
// nothing auto-provisioned one, so a business had to explicitly build a wallet project of its own
// accord for that to ever apply. This seeds one automatically, bounded (not zero-forever, not
// unlimited) — same free-tier-signup-credits philosophy as the end-user side of this fix. Gated by
// `scriptAgentsEnabled`, the SAME manifest flag that already gates agent installation (WS-6's
// de-niching — general to any SpaceType with script-agent projects, not hardcoded to Launchpad).
const WALLET_STARTER_BALANCE_CENTS = 1000; // $10 — a placeholder starter allowance, easy to tune.

// P0-4: the starter grant above had no per-user limit — nothing stopped one person from creating
// unlimited businesses to farm $10 of free compute each. A user's very first space of ANY type
// (not just Launchpad-shaped ones — the abuse doesn't care what SpaceType it wears) already spent
// their one starter grant; every subsequent space they create gets a wallet project (still a real
// payer to gate against) but starts at $0. Best-effort like the rest of this function: a lookup
// failure is treated as "not their first" (the conservative, anti-farming direction) rather than
// silently granting on every error.
async function isUsersFirstSpace(env: Env, tenantId: string, userId: string, spaceId: string): Promise<boolean> {
  try {
    const row = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) as cnt FROM spaces WHERE tenant_id = ? AND created_by = ? AND id != ?"
    ).bind(tenantId, userId, spaceId).first<{ cnt: number }>();
    return (row?.cnt ?? 0) === 0;
  } catch (err) {
    console.warn(`[provisioner] first-space lookup failed for user ${userId}:`, (err as Error).message);
    return false;
  }
}

export async function seedWallet(env: Env, spaceId: string, tenantId: string, userId?: string): Promise<boolean> {
  try {
    const token = await mintInternalToken(env.PLATFORM_SECRET, tenantId);
    const headers = { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": token };

    // F-32: create the wallet project WITH kind='wallet' in one shot (createProject now accepts
    // `kind` and stamps is_singleton_kind, so the DB singleton index applies immediately) rather
    // than the old create-then-PATCH sequence that raced a second wallet project into existence.
    const createResp = await env.SPACES_WORKER.fetch(new Request(`http://spaces-worker/spaces/${spaceId}/projects`, {
      method: "POST", headers,
      body: JSON.stringify({ space_id: spaceId, name: "Wallet", visibility: "private", kind: "wallet" }),
    }));
    if (!createResp.ok) {
      // A 409 (a wallet already exists — idempotent re-provision) is not a failure; look it up.
      if (createResp.status === 409) {
        const dup = await createResp.json<{ existing_project_id?: string }>().catch(() => ({}) as { existing_project_id?: string });
        if (dup.existing_project_id) return true; // wallet already provisioned
      }
      console.warn(`[provisioner] wallet project creation failed for ${spaceId}: ${await createResp.text()}`);
      return false;
    }
    const { id: projectId } = await createResp.json<{ id: string }>();

    // P0-4: skip the credit grant (not the wallet project itself) unless this is verifiably the
    // user's first space — a missing userId (a message queued before this fix, or a system-
    // initiated provision with no human creator) is treated the same conservative way: no grant.
    const eligibleForStarterGrant = !!userId && (await isUsersFirstSpace(env, tenantId, userId, spaceId));
    if (eligibleForStarterGrant) {
      const creditResp = await env.SPACES_WORKER.fetch(new Request(
        `http://spaces-worker/spaces/${spaceId}/projects/${projectId}/wallet/credit`,
        { method: "POST", headers, body: JSON.stringify({ cents: WALLET_STARTER_BALANCE_CENTS, reason: "starter_grant", idempotency_key: `starter:${spaceId}` }) }
      ));
      if (!creditResp.ok) {
        console.warn(`[provisioner] wallet starter grant failed for ${spaceId}/${projectId}: ${await creditResp.text()}`);
        // The wallet project itself was created successfully — don't report the whole step as
        // failed over the starter grant alone; a $0 wallet still gives project runs a real payer
        // to gate against (just an immediate 402 until topped up), which is still strictly better
        // than no payer existing at all.
      }
    }
    return true;
  } catch (err) {
    console.warn(`[provisioner] wallet seed failed for ${spaceId}:`, (err as Error).message);
    return false;
  }
}

// ── 10-step transactional provisioner ───────────────────────────────────────

export async function provisionSpace(msg: ProvisionMessage, env: Env): Promise<void> {
  const { spaceId, tenantId, spaceTypeId, spaceName, templateId, templateIds, userId } = msg;
  // Phase C (§A1.17): templateIds (plural) takes priority when present; templateId (singular)
  // stays the back-compat single-template path for any already-queued message.
  const effectiveTemplateIds = templateIds && templateIds.length > 0 ? templateIds : templateId ? [templateId] : [];
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
    const manifest = await loadManifest(spaceTypeId, env, tenantId);
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
      // S0.6: this call target has no matching route registered anywhere in the spaces worker
      // (a separate, pre-existing gap — best-effort/non-fatal, so it doesn't block provisioning,
      // but flagging rather than silently leaving it). Fixed the forgeable static header to a
      // real minted token regardless, for consistency with every other provisioner→spaces call.
      const initResp = await env.SPACES_WORKER.fetch(
        new Request(`http://spaces-worker/spaces/${spaceId}/init-spacetype`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-naelao-tenant-id": tenantId,
            "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
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
            "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
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

    // Step 5c: Register the creator as space_members owner.
    // F-42: the owner member is ESSENTIAL when there's a userId to register — without it the
    // creator can't manage the space they just made. A failure here throws (→ rollback), rather
    // than marking a broken, owner-less space 'active'. A missing userId (a back-compat message
    // or a system-initiated provision with no human creator) legitimately seeds nothing and is
    // NOT an error — seedOwnerMember returns false in both cases, so distinguish them explicitly.
    if (userId) {
      if (!(await seedOwnerMember(env, spaceId, tenantId, userId))) {
        throw new Error(`owner member seed failed for ${spaceId} — refusing to activate an owner-less space`);
      }
      provisioned.push("owner_member");
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

    // Step 9: Install agents — write 4 R2 config files per agent + register index in SpaceDO.
    // Manifest-driven (WS-6, audit plan): the provisioner no longer names a SpaceType — any
    // manifest that opts in via `backend.scriptAgentsEnabled` gets this step; a manifest that
    // doesn't declare it (the default for a future SpaceType with no script-agent story yet)
    // installs nothing.
    if (manifest.backend.scriptAgentsEnabled) {
      await installLaunchpadAgents(spaceId, tenantId, effectiveTemplateIds, manifest, env);
    }
    provisioned.push("agents");

    // Step 9a: Seed a wallet project + starter balance — the payer for this space's own
    // project-scoped agent runs (metering enforcement follow-up). Same manifest gate as agent
    // installation: any SpaceType with script-agent projects gets one, not just Launchpad.
    // F-42: for a SpaceType with script-agent projects, the wallet is ESSENTIAL — it is the payer
    // of last resort for every project-scoped agent run, so a space with no wallet project can't
    // actually run its agents. A failure here throws (→ rollback) rather than activating a broken
    // product. (The starter-credit grant WITHIN seedWallet stays best-effort — a $0 wallet is a
    // real payer, just one that 402s until topped up; only the wallet PROJECT itself is gating.)
    if (manifest.backend.scriptAgentsEnabled) {
      if (!(await seedWallet(env, spaceId, tenantId, userId))) {
        throw new Error(`wallet seed failed for ${spaceId} — refusing to activate a space with no payer for agent runs`);
      }
      provisioned.push("wallet");
    }

    // Step 9b: Template bootstrap — inherit the shared template skill library (federated
    // learning) so the space starts with what the fleet has learned, then record the first-run
    // onboarding state (credential/preference prompts + projects) for the dashboard wizard.
    // Phase C (§A1.17): a business built from multiple templates inherits skills from EACH one
    // and gets the union of their bootstrap projects/setup_scripts (mergeTemplatesBootstrap —
    // projects dedupe by name, later template wins on conflict; setup_scripts dedupe by value).
    if (manifest.backend.scriptAgentsEnabled && effectiveTemplateIds.length > 0) {
      const spaceLib = new SkillLibrary(env.SCRIPTS_R2, spaceId);
      for (const tid of effectiveTemplateIds) {
        try {
          const templateLib = SkillLibrary.forTemplate(env.SCRIPTS_R2, tid);
          const res = await inheritTemplateSkills(templateLib, spaceLib);
          if (res.inherited.length > 0) {
            console.log(`[provisioner] inherited ${res.inherited.length} shared skill(s) into ${spaceId} from template ${tid}`);
          }
        } catch (err) {
          console.warn(`[provisioner] skill inheritance failed for ${spaceId} (template ${tid}):`, (err as Error).message);
        }
      }

      const { projects, setup_scripts } = mergeTemplatesBootstrap(effectiveTemplateIds);
      if (projects.length > 0 || setup_scripts.length > 0) {
        await mergeOnboarding(env, spaceId, tenantId, {
          template_id: effectiveTemplateIds[0]!,
          template_ids: effectiveTemplateIds,
          status: "pending",
          projects,
          setup_scripts,
          created_at: now,
        });
      }
      provisioned.push("bootstrap");
    }

    // Step 10: Record install in SpaceTypeRegistryDO + flip space to 'active'
    await env.SPACES_WORKER.fetch(
      new Request(`http://spaces-worker/internal/space-types-record-install/${spaceTypeId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": tenantId,
          "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
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
    await rollbackSpace(spaceId, tenantId, spaceTypeId, provisioned, env, userId);
    throw err;
  }
}

// ── Rollback (deprovision partial state on failure) ──────────────────────────

export async function rollbackSpace(
  spaceId: string,
  tenantId: string,
  spaceTypeId: string,
  provisioned: string[],
  env: Env,
  userId?: string
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
    // Remove any scheduled_jobs installAgentTrigger wrote (step 9, PLATFORM_DB — not under the
    // R2 prefix the block above already wipes) so a retried provisionSpace doesn't accumulate
    // duplicate cron rows for the same agent. Unconditional: harmless no-op when step 9 never
    // ran or installed none.
    await env.PLATFORM_DB.prepare("DELETE FROM scheduled_jobs WHERE space_id = ?").bind(spaceId).run();

    // WS-8.6 (audit plan): agent_definitions and the owner space_members row live in SpaceDO, not
    // PLATFORM_DB — a failed provision that got as far as step 9 (agents) or step 5c (owner
    // member) previously left these as orphans referencing a space stuck in 'error' status
    // forever, with no GC. Both SpaceDO stores expose the CRUD the provisioner's own forward path
    // already uses (installLaunchpadAgents / seedOwnerMember), so rollback reuses the same
    // internal-HMAC-gated routes rather than reaching into SpaceDO storage directly.
    if (has("agents")) {
      const listResp = await env.SPACES_WORKER.fetch(
        new Request(`http://spaces-worker/spaces/${spaceId}/agent-definitions`, {
          headers: {
            "x-naelao-tenant-id": tenantId,
            "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
          },
        })
      );
      if (listResp.ok) {
        const { data } = await listResp.json<{ data: Array<{ id: string }> }>();
        for (const row of data) {
          await env.SPACES_WORKER.fetch(
            new Request(`http://spaces-worker/spaces/${spaceId}/agent-definitions/${row.id}`, {
              method: "DELETE",
              headers: {
                "x-naelao-tenant-id": tenantId,
                "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
              },
            })
          );
        }
      } else {
        console.warn(`[provisioner] rollback: agent-definitions list failed for ${spaceId}: ${await listResp.text()}`);
      }
    }
    if (has("owner_member") && userId) {
      const memberResp = await env.SPACES_WORKER.fetch(
        new Request(
          `http://spaces-worker/spaces/${spaceId}/members/${encodeURIComponent(userId)}?space_id=${encodeURIComponent(spaceId)}`,
          {
            method: "DELETE",
            headers: {
              "x-naelao-tenant-id": tenantId,
              "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
            },
          }
        )
      );
      if (!memberResp.ok) {
        console.warn(`[provisioner] rollback: owner member removal failed for ${spaceId}: ${await memberResp.text()}`);
      }
    }
  } catch (rollbackErr) {
    console.error("[provisioner] Rollback error:", rollbackErr);
  }

  // Always flip DB to 'error' so the UI can show a failure state. The `spaces` row itself and its
  // `config_json.onboarding` are deliberately KEPT (not deleted) — the row is what lets the
  // builder dashboard show "this space failed to provision" at all; deleting it here would erase
  // the only record that an attempt was made. The SpaceDO root-space registry row is left for the
  // same reason (no existing endpoint removes it, and doing so touches sub-space hierarchy state
  // this pass hasn't audited) — documented as a deferred follow-up, not silently dropped.
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
