/**
 * Space Provisioner Queue Worker (spec §62) — handles space_provision and space_deprovision.
 *
 * 10-step transactional provisioner (authoritative per spec byte ~899k):
 *   1. Mark DB as provisioning + write KV cache
 *   2. Load manifest from SpaceTypeRegistryDO (KV-cached 1h via SPACES_WORKER)
 *   3. Instantiate declared platform DOs
 *   4. Initialize R2 prefixes from manifest
 *   5. SpaceDO init hook (space-type-specific initialization)
 *   6. Deploy external portal (if declared in manifest)
 *   7. Call custom lifecycle.provisionerWorker (for future non-Naelao types — no-op for Launchpad)
 *   8. Install SpaceType agents (4 R2 config files per agent) + register index in SpaceDO
 *   9. Record install in SpaceTypeRegistryDO + flip space to 'active'
 *
 * On any failure: rollback by calling deprovisionSpace with the partial provisioned list.
 */

import { Hono } from "hono";
import { errorResponse, requestId, mintInternalToken, readBoundedResponseJson, readBoundedResponseText } from "@naelao/http";
import { checkSsrf } from "@naelao/security";
import {
  writeAgentConfig,
  DEFAULT_NAELAO_AGENT,
  createRemoteAgentConfigLockGateway,
} from "../../agents/src/script-engine/index.js";
import { seedGeneralProject } from "../../agents/src/launchpad/bootstrap.js";
import type { NaelaoSpaceTypeManifestV2 } from "../../spaces/src/do/SpaceTypeRegistryDO.js";
import { resolveTenancy } from "../../spaces/src/do/SpaceTypeRegistryDO.js";
import { type ProvisionMessage } from "./message-contract.js";
import { handleProvisionQueueMessage } from "./queue-message-handler.js";
import { isProvisionableManifest } from "./manifest-contract.js";
import { mayStartProvisioning } from "./provisioning-state.js";
import { claimProvisionLease, ProvisionLeaseBusyError, releaseProvisionLease } from "./provisioning-lease.js";

async function responseErrorDetail(response: Response): Promise<string> {
  return (await readBoundedResponseText(response, 8 * 1024).catch(() => "")).slice(0, 500);
}

/** The optional third-party lifecycle hook is the only manifest-supplied outbound URL. */
export async function callCustomProvisioner(
  url: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const destination = await checkSsrf(url, { fetchImpl });
  if (destination.blocked) throw new Error(`Custom provisioner URL blocked: ${destination.reason ?? "SSRF validation failed"}`);
  return fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
}

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
  /** Service binding to naelao-agents — used only for the best-effort AgentMail email seed
   *  (holds AGENTMAIL_API_KEY). Optional: the seed degrades to a no-op when unbound or the key
   *  isn't configured, so email provisioning happens on-demand via the assistant instead. */
  AGENTS_WORKER?: Fetcher;
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
  const manifest = await readBoundedResponseJson<unknown>(resp, 1024 * 1024).catch(() => null);
  return isProvisionableManifest(manifest, spaceTypeId) ? manifest : null;
}

// ── Step 9: Install SpaceType agents ────────────────────────────────────────

export async function installLaunchpadAgents(
  spaceId: string,
  tenantId: string,
  _templateId: string | string[] | undefined,
  manifest: NaelaoSpaceTypeManifestV2,
  env: Env
): Promise<void> {
  // Every Space gets the same general Naelao agent. Product behavior is installed through
  // Space Templates and scoped extensions rather than fixed Launchpad personas or business tools.
  const lockHeaders = {
    "x-naelao-tenant-id": spaceId,
    "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, spaceId),
  };
  // Provisioning is a multi-file write and must fail closed if the shared lock service binding
  // is absent. The optional binding remains useful for unrelated best-effort AgentMail paths,
  // but it is never acceptable to install an agent bundle without its mutex.
  if (!env.AGENTS_WORKER) throw new Error("agent_config_lock_unavailable");
  const lockGateway = createRemoteAgentConfigLockGateway(env.AGENTS_WORKER, lockHeaders, spaceId);
  await writeAgentConfig(
    env.SCRIPTS_R2,
    spaceId,
    DEFAULT_NAELAO_AGENT.agentId,
    DEFAULT_NAELAO_AGENT.config,
    { lockGateway, holderId: crypto.randomUUID() },
  );
  await registerAgentIndex(spaceId, tenantId, DEFAULT_NAELAO_AGENT.agentId, "Naelao Agent", "Naelao Space Assistant", null, manifest.id, env);




}

async function registerAgentIndex(
  spaceId: string,
  tenantId: string,
  agentId: string,
  name: string,
  description: string,
  templateId: string | null,
  spaceTypeId: string,
  env: Env,
): Promise<void> {
  const response = await env.SPACES_WORKER.fetch(new Request(
    `http://spaces-worker/spaces/${encodeURIComponent(spaceId)}/agent-definitions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": tenantId,
        "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
      },
      body: JSON.stringify({
        id: `${spaceId}:${agentId}`,
        space_id: spaceId,
        name,
        description,
        config: { agent_id: agentId, config_path: `spaces/${spaceId}/agents/${agentId}/`, spacetype_id: spaceTypeId, template_id: templateId },
      }),
    },
  ));
  if (!response.ok) throw new Error(`agent_index_registration_failed:${await responseErrorDetail(response)}`);
}

async function seedOwnerMember(env: Env, spaceId: string, tenantId: string, userId: string): Promise<boolean> {
  const response = await env.SPACES_WORKER.fetch(new Request(
    `http://spaces-worker/spaces/${encodeURIComponent(spaceId)}/members`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": tenantId,
        "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
      },
      body: JSON.stringify({ space_id: spaceId, user_id: userId, role: "owner" }),
    },
  ));
  if (!response.ok) console.warn(`[provisioner] owner member seed failed for ${spaceId}: ${await responseErrorDetail(response)}`);
  return response.ok;
}

/**
 * §A1.17 Phase G, revised per explicit user direction: seed a FULLY AUTONOMOUS ("yolo")
 * assistant_policy default for a new Launchpad space — the business-builder assistant is meant
 * to be able to do anything on the owner's behalf out of the box, the same way a hired operator
 * would act without asking permission for every step. The prior default was the "guided" pairing
 * (always_ask + a read-only auto_approved_actions allowlist); that allowlist is still stored here
 * (harmless under yolo, since yolo ignores it) so a business that later dials autonomy back down
 * to `gate_unless_listed` lands on a sensible read-only allowlist rather than an empty one. The
 * owner can flip back to any of the four approval modes any time via the existing
 * PATCH /assistant-policy endpoint (Dashboard's Assistant tab, or the shell's Config side-panel).
 * Best-effort: a failed seed logs and does not fail provisioning (same posture as seedOwnerMember)
 * — fetchAssistantPolicy's own fail-closed default (always_ask, no auto-approved actions) is a
 * safe fallback if this never lands, so a seeding failure degrades to MORE cautious, never less.
 */

// ── 10-step transactional provisioner ───────────────────────────────────────

export async function provisionSpace(msg: ProvisionMessage, env: Env): Promise<void> {
  const { spaceId, tenantId, spaceTypeId, spaceName, userId } = msg;
  const now = new Date().toISOString();
  const provisioned: string[] = [];

  const current = await env.PLATFORM_DB.prepare(
    `SELECT s.status FROM spaces s
     JOIN orgs o ON o.id = s.tenant_id AND o.status = 'active'
     WHERE s.id = ? AND s.tenant_id = ?`
  ).bind(spaceId, tenantId).first<{ status: string }>();
  if (!current || !mayStartProvisioning(current.status)) {
    console.warn(`[provisioner] Ignoring stale provision request for ${spaceId} (status=${current?.status ?? "missing"})`);
    return;
  }

  const leaseToken = crypto.randomUUID();
  if (!(await claimProvisionLease(env.PLATFORM_DB, spaceId, tenantId, leaseToken))) {
    throw new ProvisionLeaseBusyError();
  }

  try {
    // A previous attempt may have completed between the initial read and our lease claim.
    const claimedSpace = await env.PLATFORM_DB.prepare(
      "SELECT status FROM spaces WHERE id = ? AND tenant_id = ?"
    ).bind(spaceId, tenantId).first<{ status: string }>();
    if (!claimedSpace || !mayStartProvisioning(claimedSpace.status)) return;

    // Preserve an owner-reviewable template marker for queue messages produced by older releases.
    // New producers persist this marker in config_json and no longer put a blueprint on the queue.
    if (msg.blueprintId) {
      await env.PLATFORM_DB.prepare(`UPDATE spaces
        SET config_json=json_set(CASE WHEN json_valid(config_json) THEN config_json ELSE '{}' END,'$.pending_blueprint_id',?)
        WHERE id=? AND tenant_id=?`).bind(msg.blueprintId, spaceId, tenantId).run();
    }

    // Step 1: Mark DB as provisioning + write KV config cache
    const begin = await env.PLATFORM_DB.prepare(
      "UPDATE spaces SET status = 'provisioning', updated_at = ? WHERE id = ? AND tenant_id = ? AND status IN ('provisioning', 'error')"
    ).bind(now, spaceId, tenantId).run();
    if (begin.meta.changes === 0) return;
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
        console.warn(`[provisioner] SpaceDO init hook failed for ${spaceId}: ${await responseErrorDetail(initResp)}`);
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
        throw new Error(`root_space_registry_seed_failed: ${await responseErrorDetail(rootResp)}`);
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

    // Step 6: Deploy external portal (register slug→spaceId in PORTAL_KV)
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

    // Step 7: Custom lifecycle.provisionerWorker (no-op for Launchpad; reserved for future types)
    // Naelao-authored SpaceTypes don't declare provisionerWorkers (they are fully managed here).
    if (manifest.lifecycle.provisionerWorker) {
      const workerResp = await callCustomProvisioner(manifest.lifecycle.provisionerWorker, {
        action: "provision", spaceId, spaceTypeId, tenantId,
      });
      if (!workerResp.ok) {
        throw new Error(`Custom provisioner worker failed: ${await responseErrorDetail(workerResp)}`);
      }
      provisioned.push("custom_provisioner");
    }

    // Step 8: Install agents — write 4 R2 config files per agent + register index in SpaceDO.
    // Manifest-driven (WS-6, audit plan): the provisioner no longer names a SpaceType — any
    // manifest that opts in via `backend.scriptAgentsEnabled` gets this step; a manifest that
    // doesn't declare it (the default for a future SpaceType with no script-agent story yet)
    // installs nothing.
    if (manifest.backend.scriptAgentsEnabled) {
      await installLaunchpadAgents(spaceId, tenantId, undefined, manifest, env);
    }
    provisioned.push("agents");

    // Step 8a-bis: every business (templated or blank/"build from scratch") gets one ordinary
    // "General" project to land in — /projects (bare, no id) redirects straight into it instead
    // of showing a picker first. Deliberately OUTSIDE the `effectiveTemplateIds.length > 0` gate
    // below (unlike seedTemplateProjects, which only applies to a templated business): a blank
    // business gets no template-specific projects by design, but should never have ZERO projects
    // to work in. Best-effort, matching every other convenience seed here (wallet is the one
    // exception that throws, because agent runs are structurally unusable without a payer —
    // a missing General project just means a bare product root a little longer, not a broken one).
    if (manifest.backend.scriptAgentsEnabled) {
      const postToSpaces = async (path: string, body: unknown) =>
        env.SPACES_WORKER.fetch(
          new Request(`http://spaces-worker${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-naelao-tenant-id": tenantId,
              "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
            },
            body: JSON.stringify(body),
          })
        );
      const getFromSpaces = async (path: string) =>
        env.SPACES_WORKER.fetch(
          new Request(`http://spaces-worker${path}`, {
            headers: {
              "x-naelao-tenant-id": tenantId,
              "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
            },
          })
        );
      const generalId = await seedGeneralProject({ postToSpaces, getFromSpaces }, spaceId);
      if (generalId) provisioned.push("general-project");


    }

    // Step 9: Record install in SpaceTypeRegistryDO + flip space to 'active'
    const installResp = await env.SPACES_WORKER.fetch(
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
    if (!installResp.ok) {
      throw new Error(`space_type_install_record_failed: ${await responseErrorDetail(installResp)}`);
    }
    const activated = await env.PLATFORM_DB.prepare(
      "UPDATE spaces SET status = 'active', updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'provisioning'"
    ).bind(now, spaceId, tenantId).run();
    if (activated.meta.changes === 0) throw new Error("space_status_changed_during_provisioning");
    await env.SPACES_KV.put(
      `space:${tenantId}:${spaceId}`,
      JSON.stringify({ spaceId, tenantId, spaceTypeId, name: spaceName, status: "active", provisionedAt: now }),
      { expirationTtl: 86400 }
    );
    provisioned.push("active");

    // Certified Space Templates stay pending until the Space owner reviews the dependency preview
    // and explicitly approves activation from the Shell. A queued Space provision must never grant
    // extension access or create template projects on the owner's behalf.

    if(msg.userId&&env.AGENTS_WORKER){
      try { await env.AGENTS_WORKER.fetch(new Request(`http://agents/spaces/${encodeURIComponent(spaceId)}/assistant-communications`,{method:"POST",headers:{"content-type":"application/json","x-naelao-tenant-id":tenantId,"x-naelao-user-id":msg.userId,"x-naelao-role":"owner","x-naelao-internal-token":await mintInternalToken(env.PLATFORM_SECRET,tenantId)},body:JSON.stringify({action:"identity"})})); }
      catch { console.warn("[provisioner] Assistant email setup deferred until first use"); }
    }
    console.log(`[provisioner] Space ${spaceId} (${spaceTypeId}) provisioned successfully`);
  } catch (err) {
    console.error(`[provisioner] Provisioning failed at: ${provisioned[provisioned.length - 1] ?? "startup"}`, err);
    await rollbackSpace(spaceId, tenantId, spaceTypeId, provisioned, env, userId);
    throw err;
  } finally {
    await releaseProvisionLease(env.PLATFORM_DB, spaceId, tenantId, leaseToken).catch((err) => {
      console.error("[provisioner] Failed to release provisioning lease:", err);
    });
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

  const cleanup = async (label: string, action: () => Promise<void>) => {
    try { await action(); }
    catch (error) { console.error(`[provisioner] Rollback ${label} failed for ${spaceId}:`, error); }
  };

  // Keep failures isolated: one unavailable store must not prevent cleanup in the others.
  await cleanup("R2 cleanup", async () => {
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
  });
  await cleanup("portal cleanup", async () => {
    if (has("external_portal") && env.PORTAL_KV) await env.PORTAL_KV.delete(`portal-space:${spaceId}`);
  });
  await cleanup("scheduled-job cleanup", async () => {
    await env.PLATFORM_DB.prepare("DELETE FROM scheduled_jobs WHERE space_id = ?").bind(spaceId).run();
  });

  // WS-8.6: clean SpaceDO-owned rows independently so a failed agent-list call cannot skip
  // owner removal, and a failed individual delete cannot skip later agent definitions.
  await cleanup("agent-definition cleanup", async () => {
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
        const { data } = await readBoundedResponseJson<{ data?: Array<{ id?: string }> }>(listResp, 1024 * 1024);
        for (const row of data ?? []) {
          if (!row.id || row.id.length > 256) continue;
          const agentId = row.id;
          await cleanup(`agent ${agentId} cleanup`, async () => {
            await env.SPACES_WORKER.fetch(
              new Request(`http://spaces-worker/spaces/${spaceId}/agent-definitions/${encodeURIComponent(agentId)}`, {
                method: "DELETE",
                headers: {
                  "x-naelao-tenant-id": tenantId,
                  "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
                },
              })
            );
          });
        }
      } else {
        console.warn(`[provisioner] rollback: agent-definitions list failed for ${spaceId}: ${await responseErrorDetail(listResp)}`);
      }
    }
  });
  await cleanup("owner-member cleanup", async () => {
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
        console.warn(`[provisioner] rollback: owner member removal failed for ${spaceId}: ${await responseErrorDetail(memberResp)}`);
      }
    }
  });

  // Always flip DB to 'error' so the UI can show a failure state. The `spaces` row itself and its
  // `config_json.onboarding` are deliberately KEPT (not deleted) — the row is what lets the
  // builder dashboard show "this space failed to provision" at all; deleting it here would erase
  // the only record that an attempt was made. The SpaceDO root-space registry row is left for the
  // same reason (no existing endpoint removes it, and doing so touches sub-space hierarchy state
  // this pass hasn't audited) — documented as a deferred follow-up, not silently dropped.
  await cleanup("status update", async () => env.PLATFORM_DB.prepare(
    "UPDATE spaces SET status = 'error', updated_at = ? WHERE id = ? AND tenant_id = ? AND status IN ('provisioning', 'error')"
  ).bind(now, spaceId, tenantId).run().then(() => undefined));
  await cleanup("space cache removal", async () => { await env.SPACES_KV.delete(`space:${tenantId}:${spaceId}`); });
}

// ── Deprovisioner ────────────────────────────────────────────────────────────

async function deprovisionSpace(msg: ProvisionMessage, env: Env): Promise<void> {
  const { spaceId, tenantId } = msg;
  const now = new Date().toISOString();

  // Hide the space and block a stale provisioning retry before deleting external resources.
  // Queue retries can safely repeat the cleanup because each operation is keyed by spaceId.
  await env.PLATFORM_DB.prepare(
    "UPDATE spaces SET status = 'deleted', updated_at = ? WHERE id = ? AND tenant_id = ?"
  ).bind(now, spaceId, tenantId).run();

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

  // The D1 row was marked deleted before cleanup to close the stale-provision race.
  await env.SPACES_KV.delete(`space:${tenantId}:${spaceId}`);
}

// ── Queue handler ────────────────────────────────────────────────────────────

export async function queue(batch: MessageBatch<ProvisionMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    await handleProvisionQueueMessage(message, {
      provision: (body) => provisionSpace(body, env),
      deprovision: (body) => deprovisionSpace(body, env),
    });
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
