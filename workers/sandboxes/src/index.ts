import { mintInternalToken, readBoundedRequestText, RequestBodyTooLargeError, verifyInternalToken } from "@naelao/http";
import {
  type ComputerConfig,
  type ComputerScope,
  type ComputerState,
  type ExecutionResult,
  type OwnershipMode,
  type ProviderAllocation,
  type ProviderKind,
  type RuntimeRequest,
  assertWorkspacePath,
  estimateAgent37Monthly,
  validateComputerScope,
  validateResourceShape,
} from "@naelao/sandboxes-core";
import { Hono, type Context } from "hono";
import { openConnection, sealConnection } from "./connection-crypto.js";
import { Agent37Provider, inferAgent37ContentType } from "./providers/agent37.js";
import { recordAgent37ProviderUsageSnapshot } from "./agent37-provider-usage.js";
import { agent37WorkspaceHandoff } from "./providers/agent37-workspace-client.js";
import { queueSandboxComputerDeletion, recordManualProviderDeletionEvidence, runProviderDeletionReconciliation, runSandboxAllocationReconciliation } from "./provider-deletion-reconciliation.js";
import { collectSandboxOpsMetrics, sandboxOpsAlerts } from "./ops-metrics.js";
import { recordSandboxBillingReconciliation, type SandboxBillingProvider } from "./billing-reconciliation.js";
import { recordProviderCostReceipts, summarizeProviderCostReceipts, type ProviderCostReceiptInput } from "./provider-cost-receipts.js";
import { agent37TemplateAllows, parseAgent37TemplateConstraints, validateAgent37TemplateEvidence, type Agent37TemplateConstraints } from "./agent37-admission.js";
import { openSandboxRecord, sealSandboxRecord } from "./record-crypto.js";
import {
  AGENT37_AGENTPORT_CAPABILITIES,
  authorizeAgent37AgentPortAction,
  revokeAgent37ComputerAgentPortShare,
  shareAgent37ComputerWithAgentPort,
  type Agent37AgentPortCapability,
  type Agent37AgentPortComputer,
} from "./agent37-agentport.js";

interface Env {
  PLATFORM_DB: D1Database;
  PLATFORM_SECRET: string;
  SANDBOX_RUNTIME_OPERATOR_SECRET?: string;
  SANDBOX_BILLING_OPERATOR_SECRET?: string;
  AGENT37_RUNTIME_ENABLED?: string;
  DATA_JURISDICTION?: "eu";
  AGENTS_WORKER?: Fetcher;
  AGENTPORT_WORKER?: Fetcher;
  ANALYTICS?: AnalyticsEngineDataset;
}
type Vars = { tenantId: string; userId: string; role: string };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
const fail = (error_code: string, status: number, message = error_code) =>
  json({ error_code, message }, status);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

async function projectErased(env: Env, tenantId: string, spaceId: string | undefined, projectId: string | undefined): Promise<boolean> {
  if (!spaceId || !projectId) return false;
  const row = await env.PLATFORM_DB.prepare("SELECT 1 AS erased FROM workspace_erasure_tombstones WHERE tenant_id=? AND space_id=? AND project_id=? LIMIT 1")
    .bind(tenantId, spaceId, projectId).first<{ erased: number }>();
  if (row) return true;
  if (!env.AGENTS_WORKER) throw new Error("workspace_erasure_check_unavailable");
  const scope = { tenantId, spaceId, projectId, jurisdiction: env.DATA_JURISDICTION === "eu" ? "eu" : "global" };
  const response = await env.AGENTS_WORKER.fetch(new Request("http://agents/internal/workspaces/erasure-check", {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId) }, body: JSON.stringify({ scope }),
  }));
  if (!response.ok) throw new Error("workspace_erasure_check_unavailable");
  const result = await response.json<{ erased?: unknown }>().catch((): { erased?: unknown } => ({}));
  return result.erased === true;
}

app.use("*", async (c, next) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const userId = c.req.header("x-naelao-user-id") ?? "";
  const role = c.req.header("x-naelao-role") ?? "";
  if (
    !tenantId ||
    !userId ||
    !(await verifyInternalToken(
      c.req.header("x-naelao-internal-token"),
      tenantId,
      c.env.PLATFORM_SECRET
    ))
  )
    return fail("forbidden", 403);
  c.set("tenantId", tenantId);
  c.set("userId", userId);
  c.set("role", role);
  await next();
  return;
});

app.get("/health", (_c) =>
  json({ status: "ok", providers: "configured_only" })
);
app.post("/ops/provider-cost-receipts", async c => {
  if(!c.env.SANDBOX_BILLING_OPERATOR_SECRET)return fail("provider_cost_import_unavailable",503);
  if(!await verifyOperatorSecret(c.env.SANDBOX_BILLING_OPERATOR_SECRET,c.req.header("x-sandbox-billing-operator-key")??""))return fail("forbidden",403);
  const actorId=c.req.header("x-sandbox-billing-operator-id")??"";
  let body:{receipts?:ProviderCostReceiptInput[]};
  try{body=JSON.parse(await readBoundedRequestText(c.req.raw,256*1024)) as typeof body;}catch{return fail("provider_cost_receipts_invalid",400);}
  if(!Array.isArray(body.receipts))return fail("provider_cost_receipts_invalid",400);
  try{return json(await recordProviderCostReceipts(c.env.PLATFORM_DB,{tenantId:c.get("tenantId"),actorId,receipts:body.receipts}));}
  catch(error){const code=error instanceof Error?error.message:"provider_cost_receipt_import_failed";return fail(code,code.includes("conflict")?409:400);}
});
app.get("/ops/provider-cost-receipts",async c=>{
  if(!c.env.SANDBOX_BILLING_OPERATOR_SECRET)return fail("provider_cost_import_unavailable",503);
  if(!await verifyOperatorSecret(c.env.SANDBOX_BILLING_OPERATOR_SECRET,c.req.header("x-sandbox-billing-operator-key")??""))return fail("forbidden",403);
  const provider=c.req.query("provider"),periodStart=c.req.query("periodStart"),periodEnd=c.req.query("periodEnd"),currency=c.req.query("currency")??"USD";
  if(!provider||!periodStart||!periodEnd)return fail("provider_cost_summary_invalid",400);
  try{return json(await summarizeProviderCostReceipts(c.env.PLATFORM_DB,{tenantId:c.get("tenantId"),provider:provider as SandboxBillingProvider,periodStart,periodEnd,currency}));}
  catch(error){const code=error instanceof Error?error.message:"provider_cost_summary_failed";return fail(code,400);}
});
app.get("/providers", c => {
  const runtimeEnabled=c.env.AGENT37_RUNTIME_ENABLED==="true";
  return json({
    providers: [
      {
        id: "agent37",
        status: runtimeEnabled ? "customer_owned_connection_required" : "gated",
        reasonCode: runtimeEnabled ? "customer_owned_connection_and_verified_template_required" : "agent37_runtime_rollout_disabled",
        requires: ["operator_verified_template", "customer_owned_control_plane_key", "verified_instance_file_key", "explicit_provider_billing_consent"],
      },
      {
        id: "opensandbox",
        status: "unavailable",
        reasonCode: "customer_or_managed_endpoint_not_configured",
      },
      {
        id: "cloudflare",
        status: "unavailable",
        reasonCode: "cross_worker_allocation_bridge_not_configured",
      },
    ],
    autoSchedulingEnabled: false,
  });
});
app.get("/templates", async c => {
  const rows = await c.env.PLATFORM_DB.prepare(`SELECT template_id,version,digest,provider_constraints_json,capabilities_json,status,valid_until
    FROM sandbox_template_versions WHERE status='verified' ORDER BY template_id,version`).all<Record<string, unknown>>();
  return json({ templates: (rows.results ?? []).map(row => ({
    id: row.template_id, version: row.version, digest: row.digest,
    constraints: JSON.parse(String(row.provider_constraints_json)), capabilities: JSON.parse(String(row.capabilities_json)),
    verified: true, availability: row.valid_until && Date.parse(String(row.valid_until)) > Date.now() ? "operator_verified" : "expired",
    validUntil: row.valid_until,
  })), rolloutEnabled: c.env.AGENT37_RUNTIME_ENABLED === "true" });
});

app.post("/operator/templates/:templateId/:version/verify", async c => {
  if (!await verifyOperatorSecret(c.env.SANDBOX_RUNTIME_OPERATOR_SECRET, c.req.header("x-runtime-operator-secret"))) return fail("forbidden", 403);
  const actor = c.req.header("x-runtime-operator-id") ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,119}$/.test(actor)) return fail("operator_identity_required", 400);
  let input: Record<string, unknown>;
  try { input = JSON.parse(await readBoundedRequestText(c.req.raw, 16384)) as Record<string, unknown>; }
  catch { return fail("invalid_template_evidence", 400); }
  let verified: ReturnType<typeof validateAgent37TemplateEvidence>;
  try { verified = validateAgent37TemplateEvidence({ digest: input.digest, constraints: input.constraints, evidenceUrls: input.evidenceUrls, validUntil: input.validUntil }); }
  catch (error) { return fail("invalid_template_evidence", 400, error instanceof Error ? error.message : "invalid_template_evidence"); }
  const templateId = c.req.param("templateId"), version = c.req.param("version");
  if (!idPattern.test(templateId) || !idPattern.test(version)) return fail("invalid_template_identity", 400);
  const now = new Date().toISOString(), auditId = `stpl_${crypto.randomUUID()}`;
  const evidence = { digest: verified.digest, constraints: verified.constraints, evidenceUrls: verified.evidenceUrls,
    validUntil: verified.validUntil, reason: typeof input.reason === "string" ? input.reason.slice(0, 500) : "" };
  try {
    await c.env.PLATFORM_DB.batch([
      c.env.PLATFORM_DB.prepare(`INSERT INTO sandbox_template_versions
        (template_id,version,digest,provider_constraints_json,capabilities_json,status,created_at,evidence_json,verified_by,verified_at,valid_until)
        VALUES (?,?,?,?,?,'verified',?,?,?,?,?) ON CONFLICT(template_id,version) DO UPDATE SET digest=excluded.digest,
        provider_constraints_json=excluded.provider_constraints_json,capabilities_json=excluded.capabilities_json,status='verified',
        evidence_json=excluded.evidence_json,verified_by=excluded.verified_by,verified_at=excluded.verified_at,valid_until=excluded.valid_until`)
        .bind(templateId, version, verified.digest, JSON.stringify(verified.constraints), JSON.stringify(verified.constraints.capabilities), now, JSON.stringify(evidence), actor, now, verified.validUntil),
      c.env.PLATFORM_DB.prepare(`INSERT INTO sandbox_template_audit (id,template_id,version,action,actor,evidence_json,created_at)
        VALUES (?,?,?,'verified',?,?,?)`).bind(auditId, templateId, version, actor, JSON.stringify(evidence), now),
    ]);
  } catch { return fail("template_verification_persistence_failed", 500); }
  return json({ templateId, version, status: "verified", verifiedAt: now, validUntil: verified.validUntil }, 201);
});

app.post("/operator/templates/:templateId/:version/disable", async c => {
  if (!await verifyOperatorSecret(c.env.SANDBOX_RUNTIME_OPERATOR_SECRET, c.req.header("x-runtime-operator-secret"))) return fail("forbidden", 403);
  const actor = c.req.header("x-runtime-operator-id") ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,119}$/.test(actor)) return fail("operator_identity_required", 400);
  const templateId = c.req.param("templateId"), version = c.req.param("version");
  if (!idPattern.test(templateId) || !idPattern.test(version)) return fail("invalid_template_identity", 400);
  const now = new Date().toISOString(), id = `stpl_${crypto.randomUUID()}`;
  let results: D1Result[];
  try {
    results = await c.env.PLATFORM_DB.batch([
      c.env.PLATFORM_DB.prepare(`UPDATE sandbox_template_versions SET status='disabled' WHERE template_id=? AND version=? AND status!='disabled'`).bind(templateId,version),
      c.env.PLATFORM_DB.prepare(`INSERT INTO sandbox_template_audit (id,template_id,version,action,actor,evidence_json,created_at)
        SELECT ?,?,?, 'disabled',?,?,? WHERE EXISTS (SELECT 1 FROM sandbox_template_versions WHERE template_id=? AND version=? AND status='disabled')`)
        .bind(id,templateId,version,actor,JSON.stringify({reason:"operator_disabled"}),now,templateId,version),
    ]);
  } catch { return fail("template_audit_persistence_failed",500); }
  if (!results[0]?.meta.changes) return fail("template_not_found",404);
  return json({ templateId, version, status: "disabled", updatedAt: now });
});
app.get("/connections", async (c) => {
  const rows = await c.env.PLATFORM_DB.prepare(
    "SELECT id,provider,ownership,status,region,capabilities_json,last_verified_at,control_plane_verified_at,credential_check_status,credential_check_error_code,created_at,updated_at FROM sandbox_connections WHERE tenant_id=? AND owner_id=? AND status!='revoked' ORDER BY created_at DESC"
  )
    .bind(c.get("tenantId"), c.get("userId"))
    .all<Record<string, unknown>>();
  return json({
    connections: (rows.results ?? []).map((row) => ({
      id: row.id,
      provider: row.provider,
      ownership: row.ownership,
      status: row.status,
      region: row.region,
      capabilities: JSON.parse(String(row.capabilities_json ?? "[]")),
      lastVerifiedAt: row.last_verified_at,
      controlPlaneVerifiedAt: row.control_plane_verified_at,
      credentialCheckStatus: row.credential_check_status,
      credentialCheckErrorCode: row.credential_check_error_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  });
});
app.post("/connections/:id/verify", async c => {
  if (!["owner", "admin", "editor"].includes(c.get("role"))) return fail("forbidden", 403);
  const connection = await c.env.PLATFORM_DB.prepare(`SELECT id,provider,status,credential_ciphertext,credential_iv
    FROM sandbox_connections WHERE id=? AND tenant_id=? AND owner_id=? LIMIT 1`)
    .bind(c.req.param("id"), c.get("tenantId"), c.get("userId"))
    .first<{id:string;provider:string;status:string;credential_ciphertext:string|null;credential_iv:string|null}>();
  if (!connection || connection.status === "revoked") return fail("connection_not_found", 404);
  if (connection.provider !== "agent37") return fail("provider_connection_verification_unsupported", 409);
  if (!connection.credential_ciphertext || !connection.credential_iv) return fail("provider_credentials_unavailable", 409);
  const now = new Date().toISOString();
  try {
    const raw = await openConnection(c.env.PLATFORM_SECRET, c.get("tenantId"), c.get("userId"), connection.id,
      {ciphertext:connection.credential_ciphertext,iv:connection.credential_iv});
    const credentials = JSON.parse(raw) as {apiKey?:unknown;instanceKey?:unknown};
    if (typeof credentials.apiKey !== "string" || typeof credentials.instanceKey !== "string") throw new Error("provider_credentials_invalid");
    const provider = Agent37Provider.forControlPlane({apiKey:credentials.apiKey,instanceKey:credentials.instanceKey});
    await provider.verifyControlPlaneCredentials();
    const updated = await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_connections SET credential_check_status='verified',credential_check_error_code=NULL,
      control_plane_verified_at=?,updated_at=? WHERE id=? AND tenant_id=? AND owner_id=? AND status!='revoked'`)
      .bind(now,now,connection.id,c.get("tenantId"),c.get("userId")).run();
    if (!updated.meta.changes) return fail("connection_revoked_during_verification", 409);
    return json({connectionId:connection.id,credentialCheckStatus:"verified",controlPlaneVerifiedAt:now,
      runtimeCapabilitiesVerified:false,executionKeyVerified:false});
  } catch (error) {
    const rawCode = error instanceof Error && /^[a-z][a-z0-9_:-]{1,100}$/.test(error.message) ? error.message : "provider_connection_check_failed";
    const errorCode = rawCode.replace(/^agent37_/, "");
    await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_connections SET credential_check_status='failed',credential_check_error_code=?,updated_at=?
      WHERE id=? AND tenant_id=? AND owner_id=? AND status!='revoked'`)
      .bind(errorCode,now,connection.id,c.get("tenantId"),c.get("userId")).run();
    return fail("provider_connection_verification_failed", 502, errorCode);
  }
});
app.get("/connections/:id/usage", async c => {
  if (!["owner", "admin"].includes(c.get("role"))) return fail("forbidden", 403);
  const connection = await c.env.PLATFORM_DB.prepare(`SELECT id,provider,ownership,status,credential_ciphertext,credential_iv,
      credential_check_status,control_plane_verified_at FROM sandbox_connections
    WHERE id=? AND tenant_id=? AND owner_id=? LIMIT 1`)
    .bind(c.req.param("id"), c.get("tenantId"), c.get("userId"))
    .first<{id:string;provider:string;ownership:string;status:string;credential_ciphertext:string|null;credential_iv:string|null;
      credential_check_status:string|null;control_plane_verified_at:string|null}>();
  if (!connection || connection.status === "revoked") return fail("provider_connection_not_found", 404);
  if (connection.provider !== "agent37" || connection.ownership !== "customer_owned") return fail("provider_usage_unsupported", 409);
  if (!connection.credential_ciphertext || !connection.credential_iv) return fail("provider_credentials_unavailable", 409);
  if (connection.credential_check_status !== "verified" || !connection.control_plane_verified_at
    || !Number.isFinite(Date.parse(connection.control_plane_verified_at)) || Date.now() - Date.parse(connection.control_plane_verified_at) > 24 * 60 * 60_000)
    return fail("agent37_control_plane_credentials_need_verification", 409);

  const queryFrom = c.req.query("from"), queryTo = c.req.query("to");
  const today = new Date().toISOString().slice(0, 10);
  const to = queryFrom === undefined && queryTo === undefined ? today : queryTo;
  const from = queryFrom === undefined && queryTo === undefined
    ? new Date(Date.parse(`${today}T00:00:00.000Z`) - 29 * 86_400_000).toISOString().slice(0, 10) : queryFrom;
  if (!from || !to || !validUsageDay(from) || !validUsageDay(to) || from > to || usageDayDistance(from, to) > 89)
    return fail("agent37_usage_period_invalid", 400);

  let usage: Awaited<ReturnType<Agent37Provider["readWorkspaceUsage"]>>;
  try {
    const raw = await openConnection(c.env.PLATFORM_SECRET, c.get("tenantId"), c.get("userId"), connection.id,
      {ciphertext:connection.credential_ciphertext,iv:connection.credential_iv});
    const credentials = JSON.parse(raw) as {apiKey?:unknown;instanceKey?:unknown};
    if (typeof credentials.apiKey !== "string" || typeof credentials.instanceKey !== "string") throw new Error("agent37_credentials_invalid");
    usage = await Agent37Provider.forControlPlane({apiKey:credentials.apiKey,instanceKey:credentials.instanceKey}).readWorkspaceUsage(from,to);
    const current = await c.env.PLATFORM_DB.prepare(`SELECT status,credential_check_status,control_plane_verified_at,credential_ciphertext,credential_iv
      FROM sandbox_connections WHERE id=? AND tenant_id=? AND owner_id=? LIMIT 1`)
      .bind(connection.id,c.get("tenantId"),c.get("userId")).first<{status:string;credential_check_status:string|null;control_plane_verified_at:string|null;
        credential_ciphertext:string|null;credential_iv:string|null}>();
    if (!current || current.status === "revoked") return fail("provider_connection_revoked",409);
    if (current.credential_check_status !== "verified" || current.control_plane_verified_at !== connection.control_plane_verified_at
      || current.credential_ciphertext !== connection.credential_ciphertext || current.credential_iv !== connection.credential_iv)
      return fail("provider_connection_changed_during_usage_read",409);
    const observation = await recordAgent37ProviderUsageSnapshot(c.env.PLATFORM_DB, {
      tenantId:c.get("tenantId"),ownerId:c.get("userId"),connectionRef:connection.id,usage,
    });
    return json({usage,observation,scope:"agent37_workspace_account",currency:"USD",provenance:"provider_api_observed",
      notice:"Account-level usage may include Agent37 activity outside Naelao computers."});
  } catch (error) {
    const code = safeProviderError(error,"agent37_usage_unavailable");
    return fail("agent37_usage_unavailable",502,code);
  }
});
app.post("/connections", async (c) => {
  const key = c.req.header("idempotency-key");
  if (!key || key.length > 200) return fail("idempotency_key_required", 400);
  let input: { provider?: unknown; credentials?: unknown; region?: unknown };
  try {
    input = JSON.parse(
      await readBoundedRequestText(c.req.raw, 16384)
    ) as typeof input;
  } catch {
    return fail("invalid_connection_request", 400);
  }
  const provider = input.provider;
  if (provider !== "agent37" && provider !== "opensandbox")
    return fail("unsupported_provider_connection", 400);
  const credentials = input.credentials;
  if (
    !credentials ||
    typeof credentials !== "object" ||
    Array.isArray(credentials)
  )
    return fail("provider_credentials_required", 400);
  const record = credentials as Record<string, unknown>;
  const required =
    provider === "agent37"
      ? ["apiKey", "instanceKey"]
      : ["baseUrl", "apiKey", "template"];
  if (
    !required.every(
      (name) =>
        typeof record[name] === "string" &&
        (record[name] as string).length > 0 &&
        (record[name] as string).length <= 4096
    )
  )
    return fail("invalid_provider_credentials", 400);
  if (provider === "opensandbox") {
    try {
      const url = new URL(record.baseUrl as string);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return fail("invalid_provider_endpoint", 400);
    } catch {
      return fail("invalid_provider_endpoint", 400);
    }
  }
  if (!["owner", "admin", "editor"].includes(c.get("role")))
    return fail(
      "forbidden",
      403,
      "A tenant owner, admin, or editor is required to connect a provider."
    );
  const safeCredentials = Object.fromEntries(
    required.map((name) => [name, record[name]])
  );
  const tenantId = c.get("tenantId");
  const ownerId = c.get("userId");
  const now = new Date().toISOString();
  const region =
    typeof input.region === "string" &&
    /^[A-Za-z0-9_-]{1,80}$/.test(input.region)
      ? input.region
      : null;
  if (input.region !== undefined && region === null)
    return fail("invalid_provider_region", 400);
  const payloadHash = await sha256(
    JSON.stringify({ provider, credentials: safeCredentials, region })
  );
  const existing = await c.env.PLATFORM_DB.prepare(
    "SELECT id,payload_hash FROM sandbox_connections WHERE tenant_id=? AND owner_id=? AND idempotency_key=?"
  )
    .bind(tenantId, ownerId, key)
    .first<{ id: string; payload_hash: string | null }>();
  if (existing)
    return existing.payload_hash === payloadHash
      ? json(
          {
            connection: {
              id: existing.id,
              provider,
              status: "configured_unverified",
            },
          },
          200
        )
      : fail("idempotency_conflict", 409);
  const id = `scn_${crypto.randomUUID()}`;
  const encrypted = await sealConnection(
    c.env.PLATFORM_SECRET,
    tenantId,
    ownerId,
    id,
    JSON.stringify(safeCredentials)
  );
  // Capabilities stay conservative until this exact pinned template/version passes acceptance.
  const capabilities = ["exec", "files"];
  try {
    await c.env.PLATFORM_DB.prepare(
      "INSERT INTO sandbox_connections (id,tenant_id,owner_id,provider,ownership,status,region,capabilities_json,credential_ciphertext,credential_iv,idempotency_key,payload_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )
      .bind(
        id,
        tenantId,
        ownerId,
        provider,
        "customer_owned",
        "configured_unverified",
        region,
        JSON.stringify(capabilities),
        encrypted.ciphertext,
        encrypted.iv,
        key,
        payloadHash,
        now,
        now
      )
      .run();
  } catch {
    const raced = await c.env.PLATFORM_DB.prepare(
      "SELECT id,payload_hash FROM sandbox_connections WHERE tenant_id=? AND owner_id=? AND idempotency_key=?"
    )
      .bind(tenantId, ownerId, key)
      .first<{ id: string; payload_hash: string | null }>();
    if (raced?.payload_hash === payloadHash)
      return json(
        {
          connection: {
            id: raced.id,
            provider,
            status: "configured_unverified",
          },
        },
        200
      );
    return fail("idempotency_conflict", 409);
  }
  return json(
    {
      connection: { id, provider, status: "configured_unverified" },
      message:
        "Credentials are encrypted at rest. Live provider verification is not enabled until provider acceptance checks are configured.",
    },
    201
  );
});
app.delete("/connections/:id", async (c) => {
  const connectionId = String(c.req.param("id") ?? "");
  const connection = await c.env.PLATFORM_DB.prepare(`SELECT id,status FROM sandbox_connections
    WHERE id=? AND tenant_id=? AND owner_id=?`).bind(connectionId,c.get("tenantId"),c.get("userId")).first<{id:string;status:string}>();
  if (!connection || connection.status === "revoked") return fail("connection_not_found",404);
  const computers = await c.env.PLATFORM_DB.prepare(`SELECT id FROM sandbox_computers
    WHERE connection_id=? AND tenant_id=? AND owner_id=? AND deleted_at IS NULL`).bind(connectionId,c.get("tenantId"),c.get("userId")).all<{id:string}>();
  const shares = await c.env.PLATFORM_DB.prepare(`SELECT s.id,c.tenant_id,c.owner_id,c.space_id,c.project_id,c.connection_id
    FROM sandbox_agentport_shares s JOIN sandbox_computers c ON c.id=s.computer_id AND c.tenant_id=s.tenant_id
    WHERE c.connection_id=? AND c.tenant_id=? AND c.owner_id=? AND s.status!='revoked'`)
    .bind(connectionId,c.get("tenantId"),c.get("userId")).all<{id:string;tenant_id:string;owner_id:string;space_id:string;project_id:string;connection_id:string}>();
  try {
    for (const row of shares.results ?? []) await revokeAgent37ComputerAgentPortShare(c.env, {
      id:row.id,tenant_id:row.tenant_id,owner_id:row.owner_id,space_id:row.space_id,project_id:row.project_id,connection_id:row.connection_id,
    }, `connection-revoke-${crypto.randomUUID()}`);
  } catch { return fail("agentport_share_revocation_required",503); }
  try {
    for (const computer of computers.results ?? []) await queueSandboxComputerDeletion(c.env.PLATFORM_DB,c.get("tenantId"),computer.id);
  } catch { return fail("connection_cleanup_queue_failed",503); }
  const result = await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_connections SET status='revoked',updated_at=?
    WHERE id=? AND tenant_id=? AND owner_id=? AND status!='revoked'`)
    .bind(new Date().toISOString(),connectionId,c.get("tenantId"),c.get("userId")).run();
  if (!result.meta.changes) return fail("connection_not_found",404);
  const pending = await c.env.PLATFORM_DB.prepare(`SELECT 1 AS pending FROM sandbox_provider_deletion_operations
    WHERE connection_id=? AND status NOT IN ('confirmed_deleted','retained') LIMIT 1`).bind(connectionId).first();
  if (!pending) await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_connections SET credential_ciphertext=NULL,credential_iv=NULL,updated_at=?
    WHERE id=? AND status='revoked'`).bind(new Date().toISOString(),connectionId).run();
  return json({ revoked:true, cleanup:pending?"pending":"complete", credentialsRetainedForCleanup:!!pending },pending?202:200);
});
app.get("/usage", async (c) => {
  const rows = await c.env.PLATFORM_DB.prepare(
    "SELECT kind,SUM(quantity_micros) AS quantity_micros,COUNT(*) AS events FROM sandbox_usage_events WHERE tenant_id=? GROUP BY kind"
  )
    .bind(c.get("tenantId"))
    .all<{ kind: string; quantity_micros: number; events: number }>();
  return json({
    usage: rows.results ?? [],
    currency: "USD",
    note: "Only persisted measured events are included; estimates are not billed usage.",
  });
});
app.post("/billing/reconcile", async c => {
  if (!["owner", "admin"].includes(c.get("role"))) return fail("forbidden", 403);
  let input: {
    provider?: unknown; periodStart?: unknown; periodEnd?: unknown; statementRef?: unknown;
    measuredMicros?: unknown; providerMicros?: unknown;
  };
  try { input = JSON.parse(await readBoundedRequestText(c.req.raw, 8192)) as typeof input; }
  catch { return fail("invalid_billing_reconciliation", 400); }
  try {
    const result = await recordSandboxBillingReconciliation(c.env.PLATFORM_DB, {
      tenantId: c.get("tenantId"),
      provider: input.provider as SandboxBillingProvider,
      periodStart: input.periodStart as string,
      periodEnd: input.periodEnd as string,
      statementRef: input.statementRef as string,
      measuredMicros: input.measuredMicros as number,
      providerMicros: input.providerMicros as number,
    });
    return json({ ...result, requiresManualReview: result.status === "variance", autoSettlement: false });
  } catch (error) {
    const code = error instanceof Error ? error.message : "sandbox_billing_reconciliation_invalid";
    return fail(code === "sandbox_billing_statement_conflict" ? code : "sandbox_billing_reconciliation_invalid", code === "sandbox_billing_statement_conflict" ? 409 : 400);
  }
});
app.post("/provider-deletions/:id/receipt", async c => {
  if (!["owner", "admin"].includes(c.get("role"))) return fail("forbidden", 403);
  const operationId = c.req.param("id");
  if (!/^spdel_[a-f0-9]{64}$/.test(operationId)) return fail("sandbox_provider_deletion_operation_unavailable", 404);
  let input: { evidenceRef?: unknown; observedAt?: unknown; confirm?: unknown };
  try { input = JSON.parse(await readBoundedRequestText(c.req.raw, 8 * 1024)) as typeof input; }
  catch { return fail("invalid_provider_deletion_receipt", 400); }
  if (input.confirm !== true || typeof input.evidenceRef !== "string" || typeof input.observedAt !== "string") return fail("invalid_provider_deletion_receipt", 400);
  try {
    const result = await recordManualProviderDeletionEvidence(c.env.PLATFORM_DB, {
      tenantId: c.get("tenantId"), operationId, operatorId: c.get("userId"), evidenceRef: input.evidenceRef, observedAt: input.observedAt,
    });
    return json({ operationId, status: result.status, replay: result.replay, evidenceRecorded: true });
  } catch (error) {
    const code = error instanceof Error ? error.message : "sandbox_provider_deletion_evidence_invalid";
    if (code === "sandbox_provider_deletion_evidence_conflict") return fail(code, 409);
    if (code === "sandbox_provider_deletion_operation_unavailable") return fail(code, 409);
    return fail("sandbox_provider_deletion_evidence_invalid", 400);
  }
});
app.post("/estimates", async (c) => {
  let body: {
    provider?: string;
    resources?: { cpu: number; memoryMiB: number; diskGiB: number };
    allocatedPercent?: number;
    instanceType?: "default" | "performance" | "vm";
  } | null;
  try {
    body = JSON.parse(
      await readBoundedRequestText(c.req.raw, 8192)
    ) as typeof body;
  } catch {
    return fail("invalid_estimate_request", 400);
  }
  if (
    body?.provider !== "agent37" ||
    !body.resources ||
    typeof body.allocatedPercent !== "number"
  )
    return fail("invalid_estimate_request", 400);
  try {
    return json({
      estimate: estimateAgent37Monthly(
        body.resources,
        body.allocatedPercent,
        new Date().toISOString(),
        body.instanceType ?? "default"
      ),
    });
  } catch (error) {
    return fail(
      "invalid_estimate_request",
      400,
      error instanceof Error ? error.message : "invalid_estimate_request"
    );
  }
});

app.post("/computers", async (c) => {
  const tenantId = c.get("tenantId");
  const userId = c.get("userId");
  const key = c.req.header("idempotency-key");
  if (!key || key.length > 200) return fail("idempotency_key_required", 400);
  let raw: string;
  try {
    raw = await readBoundedRequestText(c.req.raw, 32768);
  } catch {
    return fail("request_too_large", 413);
  }
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return fail("invalid_json", 400);
  }
  if (
    !input.scope ||
    typeof input.scope !== "object" ||
    Array.isArray(input.scope)
  )
    return fail("invalid_scope", 400);
  const scope = {
    ...(input.scope as Partial<ComputerScope>),
    tenantId,
    ownerId: userId,
  } as ComputerScope;
  try {
    validateComputerScope(scope);
  } catch (error) {
    return fail(
      "invalid_scope",
      400,
      error instanceof Error ? error.message : "invalid_scope"
    );
  }
  try {
    if (await projectErased(c.env, tenantId, scope.spaceId, scope.projectId)) return fail("workspace_erased", 410);
  } catch { return fail("workspace_erasure_check_unavailable", 503); }
  if (!["owner", "admin", "editor", "product_end_user"].includes(c.get("role")))
    return fail(
      "forbidden",
      403,
      "This account role cannot create computer resources."
    );
  if (scope.spaceId) {
    const space = await c.env.PLATFORM_DB.prepare(
      "SELECT id FROM spaces WHERE id=? AND tenant_id=? AND status!='deleted'"
    )
      .bind(scope.spaceId, tenantId)
      .first();
    if (!space) return fail("space_not_found", 404);
    if (c.get("role") === "product_end_user") {
      const membership = await c.env.PLATFORM_DB.prepare(
        "SELECT role FROM space_members WHERE space_id=? AND tenant_id=? AND end_user_id=? AND suspended_at IS NULL"
      )
        .bind(scope.spaceId, tenantId, userId)
        .first<{ role: string }>();
      if (!membership || !["owner", "admin"].includes(membership.role))
        return fail(
          "forbidden",
          403,
          "Space owner or admin membership is required to create a computer."
        );
    }
  } else if (scope.projectId)
    return fail(
      "invalid_scope",
      400,
      "Project computers must include their Space ID."
    );
  const resources = input.resources as {
    cpu: number;
    memoryMiB: number;
    diskGiB: number;
  };
  try {
    validateResourceShape(resources);
  } catch (error) {
    return fail(
      "invalid_resources",
      400,
      error instanceof Error ? error.message : "invalid_resources"
    );
  }
  const templateId = input.templateId;
  const templateVersion = input.templateVersion;
  const filesystemId = input.filesystemId;
  if (
    ![templateId, templateVersion, filesystemId].every(
      (v) => typeof v === "string" && idPattern.test(v)
    )
  )
    return fail("invalid_computer_config", 400);
  const provider = input.provider ?? "auto";
  if (
    !(
      provider === "auto" ||
      [
        "agent37",
        "opensandbox",
        "cloudflare",
        "local",
        "webcontainer",
      ].includes(String(provider))
    )
  )
    return fail("invalid_provider", 400);
  const connectionId = typeof input.connectionId === "string" ? input.connectionId : null;
  if (input.connectionId !== undefined && (!connectionId || !idPattern.test(connectionId))) return fail("invalid_provider_connection", 400);
  if (provider === "agent37" && !connectionId) return fail("provider_connection_required", 400);
  if (provider !== "agent37" && connectionId) return fail("provider_connection_mismatch", 400);
  if (connectionId) {
    const connection = await c.env.PLATFORM_DB.prepare(`SELECT id FROM sandbox_connections
      WHERE id=? AND tenant_id=? AND owner_id=? AND provider='agent37' AND status!='revoked'`)
      .bind(connectionId, tenantId, userId).first();
    if (!connection) return fail("provider_connection_not_found", 404);
  }
  const payloadHash = await sha256(raw);
  const old = await c.env.PLATFORM_DB.prepare(
    "SELECT id,payload_hash,result_json FROM sandbox_operations WHERE tenant_id=? AND idempotency_key=?"
  )
    .bind(tenantId, key)
    .first<{ id: string; payload_hash: string; result_json: string | null }>();
  if (old) {
    if (old.payload_hash !== payloadHash)
      return fail("idempotency_conflict", 409);
    if (old.result_json) return json(JSON.parse(old.result_json), 200);
    return fail("operation_indeterminate", 409);
  }
  const now = new Date().toISOString();
  const existingFilesystem = await c.env.PLATFORM_DB.prepare(
    "SELECT id,space_id,project_id,branch FROM sandbox_filesystems WHERE id=? AND tenant_id=? AND owner_id=? AND status='active'"
  )
    .bind(filesystemId, tenantId, userId)
    .first<{
      id: string;
      space_id: string | null;
      project_id: string | null;
      branch: string;
    }>();
  const filesystemCollision = await c.env.PLATFORM_DB.prepare(
    "SELECT id FROM sandbox_filesystems WHERE id=?"
  )
    .bind(filesystemId)
    .first();
  if (filesystemCollision && !existingFilesystem)
    return fail("filesystem_scope_mismatch", 403);
  if (
    existingFilesystem &&
    (existingFilesystem.space_id !== (scope.spaceId ?? null) ||
      existingFilesystem.project_id !== (scope.projectId ?? null) ||
      existingFilesystem.branch !== (scope.branch ?? "main"))
  )
    return fail("filesystem_scope_mismatch", 403);
  const computerId = `cmp_${crypto.randomUUID()}`;
  const filesystemMode = "snapshot_diff";
  const operationId = `op_${crypto.randomUUID()}`;
  const computer = {
    id: computerId,
    scope,
    templateId,
    templateVersion,
    ownership: (provider === "agent37" ? "customer_owned" : "naelao_managed") as OwnershipMode,
    filesystemId,
    filesystemMode,
    providerPreference: provider as ProviderKind | "auto",
    state: "configured" as ComputerState,
    resources,
    idleTimeoutSeconds: 900,
    allocationGeneration: 0,
  };
  const result = {
    computer,
    operation: { id: operationId, status: "complete" },
    providerStatus: "not_allocated",
    message:
      "Configuration is stored. Runtime allocation remains disabled until a verified provider connection and runtime acceptance are available.",
  };
  const statements = [
    c.env.PLATFORM_DB.prepare(
      "INSERT INTO sandbox_computers (id,tenant_id,owner_id,space_id,project_id,branch,template_id,template_version,ownership,filesystem_id,filesystem_mode,provider_preference,state,resources_json,idle_timeout_seconds,allocation_generation,created_at,updated_at,connection_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(
      computerId,
      tenantId,
      userId,
      scope.spaceId ?? null,
      scope.projectId ?? null,
      scope.branch ?? "main",
      templateId,
      templateVersion,
      "naelao_managed",
      filesystemId,
      filesystemMode,
      provider,
      "configured",
      JSON.stringify(resources),
      900,
      0,
      now,
      now,
      connectionId
    ),
    ...(existingFilesystem
      ? []
      : [
          c.env.PLATFORM_DB.prepare(
            "INSERT INTO sandbox_filesystems (id,tenant_id,owner_id,space_id,project_id,branch,mode,consistency,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
          ).bind(
            filesystemId,
            tenantId,
            userId,
            scope.spaceId ?? null,
            scope.projectId ?? null,
            scope.branch ?? "main",
            filesystemMode,
            "file_cas",
            "active",
            now,
            now
          ),
        ]),
    c.env.PLATFORM_DB.prepare(
      "INSERT INTO sandbox_operations (id,tenant_id,computer_id,operation,idempotency_key,payload_hash,status,generation,result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(
      operationId,
      tenantId,
      computerId,
      "create",
      key,
      payloadHash,
      "complete",
      0,
      JSON.stringify(result),
      now,
      now
    ),
  ];
  let out: D1Result[];
  try {
    out = await c.env.PLATFORM_DB.batch(statements);
  } catch {
    const raced = await c.env.PLATFORM_DB.prepare(
      "SELECT payload_hash,result_json FROM sandbox_operations WHERE tenant_id=? AND idempotency_key=?"
    )
      .bind(tenantId, key)
      .first<{ payload_hash: string; result_json: string | null }>();
    if (raced?.payload_hash !== payloadHash)
      return fail("idempotency_conflict", 409);
    if (raced.result_json) return json(JSON.parse(raced.result_json), 200);
    return fail("operation_indeterminate", 409);
  }
  if (out.some((row) => !row.success))
    return fail("computer_create_failed", 500);
  return json(result, 201);
});

app.get("/computers", async (c) => {
  const rows = await c.env.PLATFORM_DB.prepare(
    `SELECT id,space_id,project_id,branch,template_id,template_version,ownership,filesystem_id,filesystem_mode,provider_preference,state,resources_json,idle_timeout_seconds,allocation_generation,
       (SELECT status FROM sandbox_agentport_shares s WHERE s.tenant_id=c.tenant_id AND s.computer_id=c.id) AS agentport_link_status,
       (SELECT capabilities_json FROM sandbox_agentport_shares s WHERE s.tenant_id=c.tenant_id AND s.computer_id=c.id) AS agentport_capabilities_json,
       (SELECT operation FROM sandbox_operations o WHERE o.id=c.active_operation_id AND o.tenant_id=c.tenant_id) AS active_operation_type,
       (SELECT status FROM sandbox_operations o WHERE o.id=c.active_operation_id AND o.tenant_id=c.tenant_id) AS active_operation_status
       FROM sandbox_computers c WHERE tenant_id=? AND owner_id=? AND deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM workspace_erasure_tombstones t WHERE t.tenant_id=c.tenant_id AND t.space_id=c.space_id AND t.project_id=c.project_id)
       ORDER BY created_at DESC LIMIT 100`
  )
    .bind(c.get("tenantId"), c.get("userId"))
    .all<Record<string, unknown>>();
  return json({
    computers: (rows.results ?? []).map((row) =>
      formatComputer(row, c.get("tenantId"), c.get("userId"))
    ),
  });
});
app.get("/filesystems", async (c) => {
  const rows = await c.env.PLATFORM_DB.prepare(
    `SELECT id,space_id,project_id,branch,mode,consistency,status,created_at,updated_at FROM sandbox_filesystems f
       WHERE tenant_id=? AND owner_id=? AND status!='retired'
         AND NOT EXISTS (SELECT 1 FROM workspace_erasure_tombstones t WHERE t.tenant_id=f.tenant_id AND t.space_id=f.space_id AND t.project_id=f.project_id)
       ORDER BY created_at DESC LIMIT 100`
  )
    .bind(c.get("tenantId"), c.get("userId"))
    .all<Record<string, unknown>>();
  return json({
    filesystems: rows.results ?? [],
    dataPlane: "r2_publication_bridge_unavailable",
  });
});
app.get("/computers/:id", async (c) => {
  const row = await c.env.PLATFORM_DB.prepare(
    `SELECT c.*,
       (SELECT status FROM sandbox_agentport_shares s WHERE s.tenant_id=c.tenant_id AND s.computer_id=c.id) AS agentport_link_status,
       (SELECT capabilities_json FROM sandbox_agentport_shares s WHERE s.tenant_id=c.tenant_id AND s.computer_id=c.id) AS agentport_capabilities_json,
       (SELECT operation FROM sandbox_operations o WHERE o.id=c.active_operation_id AND o.tenant_id=c.tenant_id) AS active_operation_type,
       (SELECT status FROM sandbox_operations o WHERE o.id=c.active_operation_id AND o.tenant_id=c.tenant_id) AS active_operation_status
       FROM sandbox_computers c WHERE id=? AND tenant_id=? AND owner_id=? AND deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM workspace_erasure_tombstones t WHERE t.tenant_id=c.tenant_id AND t.space_id=c.space_id AND t.project_id=c.project_id)`
  )
    .bind(c.req.param("id"), c.get("tenantId"), c.get("userId"))
    .first<Record<string, unknown>>();
  return row
    ? json({
        computer: formatComputer(row, c.get("tenantId"), c.get("userId")),
      })
    : fail("computer_not_found", 404);
});

for (const action of ["start", "sleep"] as const) app.post(`/computers/:id/${action}`, c => handleComputerAction(c, action));
app.post("/computers/:id/operations/:operationId/reconcile", c => reconcileAgent37Transition(c));
app.post("/computers/:id/agentport-share", c => handleAgent37AgentPortShare(c));
app.post("/computers/:id/agentport-revoke", c => handleAgent37AgentPortRevoke(c));
app.post("/computers/:id/executions", c => handleAgent37Execution(c));
app.post("/computers/:id/executions/:executionId/reconcile", c => reconcileAgent37Execution(c));
app.post("/computers/:id/artifacts", c => handleAgent37ArtifactTransfer(c));
app.get("/computers/:id/artifact-transfers/:transferId", c => getAgent37ArtifactTransfer(c));
app.post("/computers/:id/artifact-transfers/:transferId/reconcile", c => reconcileAgent37ArtifactTransfer(c));
app.post("/computers/:id/artifact-transfers/:transferId/publish", c => publishAgent37ArtifactTransfer(c));
app.get("/operations/:id", async c => {
  const row = await c.env.PLATFORM_DB.prepare(`SELECT o.id,o.operation,o.status,o.error_code,o.result_json,o.updated_at
    FROM sandbox_operations o JOIN sandbox_computers c ON c.id=o.computer_id
    WHERE o.id=? AND o.tenant_id=? AND c.owner_id=? AND c.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM workspace_erasure_tombstones t WHERE t.tenant_id=c.tenant_id AND t.space_id=c.space_id AND t.project_id=c.project_id)`)
    .bind(c.req.param("id"), c.get("tenantId"), c.get("userId"))
    .first<Record<string, unknown>>();
  if (!row) return fail("operation_not_found", 404);
  return json({ operation: { id: row.id, type: row.operation, status: row.status, errorCode: row.error_code,
    result: row.result_json ? JSON.parse(String(row.result_json)) : null, updatedAt: row.updated_at } }, row.status === "complete" || row.status === "failed" ? 200 : 202);
});
app.post("/computers/:id/sync", async (c) => {
  const row = await c.env.PLATFORM_DB.prepare(
    `SELECT id,filesystem_id,state,tenant_id,space_id,project_id FROM sandbox_computers c
       WHERE id=? AND tenant_id=? AND owner_id=? AND filesystem_mode='snapshot_diff' AND deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM workspace_erasure_tombstones t WHERE t.tenant_id=c.tenant_id AND t.space_id=c.space_id AND t.project_id=c.project_id)`
  )
    .bind(c.req.param("id"), c.get("tenantId"), c.get("userId"))
    .first();
  if (!row) return fail("computer_not_found", 404);
  if (["deleting", "recovery_required", "deleted"].includes(String(row.state))) return fail("computer_not_writable", 409);
  if (!c.env.AGENTS_WORKER) return fail("filesystem_bridge_unavailable", 503, "The Agents workspace bridge is not bound.");
  let input: Record<string, unknown> = {};
  if (c.req.raw.body) {
    try { input = JSON.parse(await readBoundedRequestText(c.req.raw, 6 * 1024 * 1024)) as Record<string, unknown>; }
    catch (error) { return fail(error instanceof RequestBodyTooLargeError ? "request_body_too_large" : "invalid_sync_request", error instanceof RequestBodyTooLargeError ? 413 : 400); }
  }
  const operation = input.operation ?? "snapshot";
  const route = operation === "snapshot" ? "snapshot" : operation === "stageBlob" ? "blobs" : operation === "publish" ? "publish" : null;
  if (!route) return fail("invalid_sync_operation", 400);
  const body = {
    filesystemId: row.filesystem_id,
    computerId: row.id,
    ...(operation === "stageBlob" ? { snapshotId: input.snapshotId, sha256: input.sha256, contentBase64: input.contentBase64 } : {}),
    ...(operation === "publish" ? { snapshotId: input.snapshotId, changes: input.changes, idempotencyKey: input.idempotencyKey } : {}),
  };
  const responseFromAgents = await c.env.AGENTS_WORKER.fetch(new Request(`http://agents-worker/internal/sandbox-workspaces/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": c.get("tenantId"),
      "x-naelao-user-id": c.get("userId"),
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, c.get("tenantId")),
    },
    body: JSON.stringify(body),
  }));
  return new Response(responseFromAgents.body, { status: responseFromAgents.status, headers: { "content-type": responseFromAgents.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
});
app.get("/sandbox-workspace-blobs/:blobId", async (c) => {
  if (!c.env.AGENTS_WORKER) return fail("filesystem_bridge_unavailable", 503);
  const responseFromAgents = await c.env.AGENTS_WORKER.fetch(new Request(`http://agents-worker/internal/sandbox-workspaces/blobs/${encodeURIComponent(c.req.param("blobId"))}`, {
    headers: {
      "x-naelao-tenant-id": c.get("tenantId"),
      "x-naelao-user-id": c.get("userId"),
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, c.get("tenantId")),
    },
  }));
  return new Response(responseFromAgents.body, { status: responseFromAgents.status, headers: {
    "content-type": responseFromAgents.headers.get("content-type") ?? "application/json",
    ...(responseFromAgents.headers.get("x-content-sha256") ? { "x-content-sha256": responseFromAgents.headers.get("x-content-sha256")! } : {}),
    ...(responseFromAgents.headers.get("content-length") ? { "content-length": responseFromAgents.headers.get("content-length")! } : {}),
    "cache-control": "no-store",
  } });
});
app.delete("/computers/:id", async (c) => {
  const computerId = String(c.req.param("id") ?? "");
  const row = await c.env.PLATFORM_DB.prepare(
    `SELECT id,tenant_id,owner_id,space_id,project_id,connection_id FROM sandbox_computers c WHERE id=? AND tenant_id=? AND owner_id=? AND deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM workspace_erasure_tombstones t WHERE t.tenant_id=c.tenant_id AND t.space_id=c.space_id AND t.project_id=c.project_id)`,
  ).bind(computerId, c.get("tenantId"), c.get("userId")).first<Agent37AgentPortComputer>();
  if (!row) return fail("computer_not_found", 404);
  const share = await c.env.PLATFORM_DB.prepare(`SELECT status FROM sandbox_agentport_shares WHERE tenant_id=? AND computer_id=?`)
    .bind(c.get("tenantId"),computerId).first<{status:string}>();
  if (share && share.status !== "revoked") {
    try { await revokeAgent37ComputerAgentPortShare(c.env,row,`computer-revoke-${crypto.randomUUID()}`); }
    catch { return fail("agentport_share_revocation_required",503); }
  }
  try {
    const deletion = await queueSandboxComputerDeletion(c.env.PLATFORM_DB, c.get("tenantId"), computerId);
    if (deletion.pending) return json({ deleted: false, state: "deleting", providerDeletion: deletion }, 202);
    if (deletion.unresolved) return json({ deleted: false, state: "recovery_required", providerDeletion: deletion }, 202);
    return json({ deleted: true, providerDeletion: deletion });
  } catch {
    return fail("computer_deletion_retry_required", 503);
  }
});

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

interface RuntimeRow extends Record<string, unknown> {
  id: string; tenant_id: string; owner_id: string; space_id: string | null; project_id: string | null; branch: string;
  template_id: string; template_version: string; ownership: string; filesystem_id: string; filesystem_mode: string;
  provider_preference: string; state: string; resources_json: string; idle_timeout_seconds: number; allocation_generation: number;
  connection_id: string | null; active_operation_id: string | null;
  connection_provider: string | null; connection_ownership: string | null; connection_status: string | null; connection_region: string | null;
  credential_ciphertext: string | null; credential_iv: string | null; credential_check_status: string | null; control_plane_verified_at: string | null;
  execution_key_check_status: string | null; template_digest: string | null; template_constraints_json: string | null;
  template_capabilities_json: string | null; template_status: string | null; template_valid_until: string | null;
}
interface AllocationRow { id: string; connection_id: string; provider: string; external_id: string | null; generation: number; status: string; image_digest?: string | null; operation_id?: string | null; }

async function loadRuntimeRow(c: Context<{ Bindings: Env; Variables: Vars }>, computerId: string): Promise<RuntimeRow | Response> {
  const row = await c.env.PLATFORM_DB.prepare(`SELECT c.*,conn.provider AS connection_provider,conn.ownership AS connection_ownership,
      conn.status AS connection_status,conn.region AS connection_region,conn.credential_ciphertext,conn.credential_iv,
      conn.credential_check_status,conn.control_plane_verified_at,conn.execution_key_check_status,
      t.digest AS template_digest,t.provider_constraints_json AS template_constraints_json,t.capabilities_json AS template_capabilities_json,
      t.status AS template_status,t.valid_until AS template_valid_until
    FROM sandbox_computers c LEFT JOIN sandbox_connections conn ON conn.id=c.connection_id
    LEFT JOIN sandbox_template_versions t ON t.template_id=c.template_id AND t.version=c.template_version
    WHERE c.id=? AND c.tenant_id=? AND c.owner_id=? AND c.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM workspace_erasure_tombstones x WHERE x.tenant_id=c.tenant_id AND x.space_id=c.space_id AND x.project_id=c.project_id)`)
    .bind(computerId, c.get("tenantId"), c.get("userId")).first<RuntimeRow>();
  if (!row) return fail("computer_not_found", 404);
  try {
    if (await projectErased(c.env, row.tenant_id, row.space_id ?? undefined, row.project_id ?? undefined)) return fail("workspace_erased", 410);
  } catch { return fail("workspace_erasure_check_unavailable", 503); }
  if (!c.env.AGENT37_RUNTIME_ENABLED || c.env.AGENT37_RUNTIME_ENABLED !== "true") return fail("agent37_runtime_rollout_disabled", 503);
  if (!['owner', 'admin', 'editor'].includes(c.get("role"))) return fail("forbidden", 403);
  if (row.provider_preference !== "agent37" || row.ownership !== "customer_owned") return fail("agent37_customer_owned_computer_required", 409);
  return row;
}

function templateConstraints(row: RuntimeRow): Agent37TemplateConstraints | Response {
  if (row.template_status !== "verified" || !row.template_digest || !/^(?:sha256:)?[a-f0-9]{64}$/i.test(row.template_digest) ||
      !row.template_valid_until || !Number.isFinite(Date.parse(row.template_valid_until)) || Date.parse(row.template_valid_until) <= Date.now())
    return fail("agent37_template_not_currently_verified", 409);
  try {
    const constraints = JSON.parse(String(row.template_constraints_json ?? "null")) as unknown;
    const parsed = JSON.parse(String(row.template_capabilities_json ?? "[]")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || !parsed.includes("exec") || !parsed.includes("files")) return fail("agent37_template_capability_mismatch", 409);
    // Revalidate the stored record at the point of use; migration/imported rows are not trusted.
    const validated = parseAgent37TemplateConstraints(constraints);
    return validated;
  } catch { return fail("agent37_template_constraints_invalid", 409); }
}

function requireConnection(row: RuntimeRow, requireExecutionKey: boolean): Response | null {
  if (!row.connection_id || row.connection_provider !== "agent37" || row.connection_ownership !== "customer_owned" ||
      row.connection_status === "revoked" || !row.credential_ciphertext || !row.credential_iv) return fail("agent37_customer_connection_required", 409);
  if (row.credential_check_status !== "verified" || !row.control_plane_verified_at || !Number.isFinite(Date.parse(row.control_plane_verified_at)) || Date.now() - Date.parse(row.control_plane_verified_at) > 24 * 60 * 60 * 1000)
    return fail("agent37_control_plane_credentials_need_verification", 409);
  if (requireExecutionKey && row.execution_key_check_status !== "verified") return fail("agent37_execution_key_not_verified", 409);
  return null;
}

async function loadAgent37AgentPortComputer(c: Context<{ Bindings: Env; Variables: Vars }>, computerId: string): Promise<Agent37AgentPortComputer | Response> {
  if (!idPattern.test(computerId)) return fail("computer_not_found", 404);
  if (!["owner", "admin", "editor"].includes(c.get("role"))) return fail("forbidden", 403);
  const row = await c.env.PLATFORM_DB.prepare(`SELECT c.id,c.tenant_id,c.owner_id,c.space_id,c.project_id,c.provider_preference,c.ownership,c.connection_id,
      conn.provider AS connection_provider,conn.ownership AS connection_ownership,conn.status AS connection_status,
      conn.credential_check_status,conn.control_plane_verified_at
    FROM sandbox_computers c LEFT JOIN sandbox_connections conn ON conn.id=c.connection_id
    WHERE c.id=? AND c.tenant_id=? AND c.owner_id=? AND c.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM workspace_erasure_tombstones t WHERE t.tenant_id=c.tenant_id AND t.space_id=c.space_id AND t.project_id=c.project_id)`)
    .bind(computerId, c.get("tenantId"), c.get("userId"))
    .first<Record<string, unknown>>();
  if (!row || row.provider_preference !== "agent37" || row.ownership !== "customer_owned"
    || row.connection_provider !== "agent37" || row.connection_ownership !== "customer_owned"
    || typeof row.connection_id !== "string" || !row.connection_id || row.connection_status === "revoked"
    || row.credential_check_status !== "verified" || typeof row.control_plane_verified_at !== "string"
    || !Number.isFinite(Date.parse(row.control_plane_verified_at)) || Date.now() - Date.parse(row.control_plane_verified_at) > 24 * 60 * 60_000)
    return fail("agent37_verified_customer_connection_required", 409);
  if (typeof row.space_id !== "string" || !row.space_id || typeof row.project_id !== "string" || !row.project_id)
    return fail("agent37_project_scope_required", 409);
  try {
    if (await projectErased(c.env, String(row.tenant_id), String(row.space_id), String(row.project_id))) return fail("workspace_erased", 410);
  } catch { return fail("workspace_erasure_check_unavailable", 503); }
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), owner_id: String(row.owner_id),
    space_id: String(row.space_id), project_id: String(row.project_id), connection_id: String(row.connection_id),
  };
}

async function handleAgent37AgentPortShare(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response> {
  const key = c.req.header("idempotency-key");
  if (!key || key.length > 160 || !idPattern.test(key)) return fail("idempotency_key_required", 400);
  let body: { capabilities?: unknown };
  try { body = JSON.parse(await readBoundedRequestText(c.req.raw, 8192)) as typeof body; }
  catch { return fail("agentport_share_request_invalid", 400); }
  if (!Array.isArray(body.capabilities) || body.capabilities.length < 1 || body.capabilities.length > AGENT37_AGENTPORT_CAPABILITIES.length
    || body.capabilities.some(value => typeof value !== "string")) return fail("agentport_share_selection_invalid", 400);
  const computer = await loadAgent37AgentPortComputer(c, String(c.req.param("id") ?? ""));
  if (computer instanceof Response) return computer;
  try {
    const share = await shareAgent37ComputerWithAgentPort(c.env, computer, key, body.capabilities as string[]);
    return json({ share });
  } catch (error) {
    const code = error instanceof Error ? error.message : "agentport_share_failed";
    return fail(code, code.includes("conflict") || code.includes("revoke_before_change") ? 409 : 503);
  }
}

async function handleAgent37AgentPortRevoke(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response> {
  const key = c.req.header("idempotency-key");
  if (!key || key.length > 160 || !idPattern.test(key)) return fail("idempotency_key_required", 400);
  const computer = await loadAgent37AgentPortComputer(c, String(c.req.param("id") ?? ""));
  if (computer instanceof Response) return computer;
  try {
    return json({ share: await revokeAgent37ComputerAgentPortShare(c.env, computer, key) });
  } catch (error) {
    const code = error instanceof Error ? error.message : "agentport_revoke_failed";
    return fail(code, code.includes("conflict") ? 409 : 503);
  }
}

async function authorizeAgent37Request(c: Context<{ Bindings: Env; Variables: Vars }>, row: RuntimeRow,
  capability: Agent37AgentPortCapability, operationKey: string, persistedAgentId?: string | null): Promise<Response | null> {
  const headerAgentId = c.req.header("x-naelao-agentport-agent-id");
  if (persistedAgentId !== undefined && headerAgentId && persistedAgentId !== headerAgentId)
    return fail("agentport_agent37_identity_mismatch", 403);
  const agentId = persistedAgentId !== undefined ? persistedAgentId : headerAgentId;
  if (agentId === undefined) return null;
  if (agentId === null) return null;
  if (!row.connection_id) return fail("agent37_customer_connection_required",409);
  try {
    await authorizeAgent37AgentPortAction(c.env, {
      tenantId: row.tenant_id, ownerId: row.owner_id, computerId: row.id, connectionId: row.connection_id, agentId, capability, operationKey,
    });
    return null;
  } catch (error) {
    const code = error instanceof Error ? error.message : "agentport_agent37_authorization_failed";
    return fail(code, code.includes("not_granted") || code.includes("denied") ? 403 : 503);
  }
}

async function createAgent37Provider(c: Context<{ Bindings: Env; Variables: Vars }>, row: RuntimeRow, constraints: Agent37TemplateConstraints) {
  if (requireConnection(row, false)) throw new Error("agent37_connection_not_admitted");
  if (row.connection_region !== constraints.region) throw new Error("agent37_connection_region_mismatch");
  const raw = await openConnection(c.env.PLATFORM_SECRET, row.tenant_id, row.owner_id, String(row.connection_id),
    { ciphertext: String(row.credential_ciphertext), iv: String(row.credential_iv) });
  const credentials = JSON.parse(raw) as { apiKey?: unknown; instanceKey?: unknown };
  if (typeof credentials.apiKey !== "string" || typeof credentials.instanceKey !== "string") throw new Error("agent37_credentials_invalid");
  return new Agent37Provider({ apiKey: credentials.apiKey, instanceKey: credentials.instanceKey }, {
    id: row.template_id, version: row.template_version, instanceType: constraints.instanceType, region: constraints.region,
    diskGiB: Number((JSON.parse(row.resources_json) as { diskGiB?: unknown }).diskGiB),
  });
}

async function getCurrentAllocation(db: D1Database, computerId: string): Promise<AllocationRow | null> {
  return db.prepare(`SELECT id,connection_id,provider,external_id,generation,status,image_digest,operation_id FROM sandbox_allocations
    WHERE computer_id=? AND status!='destroyed' ORDER BY generation DESC LIMIT 1`).bind(computerId).first<AllocationRow>();
}

/** Recheck authorization and erasure immediately before an Agent37 artifact side effect. A
 * transfer can outlive the initial route check while the owner revokes a connection or erases
 * the project. This guard deliberately binds to the same connection and allocation generation. */
async function agent37ArtifactAdmissionFailure(
  c: Context<{ Bindings: Env; Variables: Vars }>,
  original: RuntimeRow,
  allocation: AllocationRow,
): Promise<{ code: string; status: number } | null> {
  const current = await loadRuntimeRow(c, original.id);
  if (current instanceof Response) {
    const body = await current.clone().json<{ error_code?: unknown }>().catch((): { error_code?: unknown } => ({}));
    return { code: typeof body.error_code === "string" ? body.error_code : "artifact_transfer_admission_failed", status: current.status };
  }
  if (current.connection_id !== original.connection_id) return { code: "agent37_connection_changed", status: 409 };
  const connectionFailure = requireConnection(current, true);
  if (connectionFailure) {
    const body = await connectionFailure.clone().json<{ error_code?: unknown }>().catch((): { error_code?: unknown } => ({}));
    return { code: typeof body.error_code === "string" ? body.error_code : "agent37_customer_connection_required", status: connectionFailure.status };
  }
  const constraints = templateConstraints(current);
  if (constraints instanceof Response) {
    const body = await constraints.clone().json<{ error_code?: unknown }>().catch((): { error_code?: unknown } => ({}));
    return { code: typeof body.error_code === "string" ? body.error_code : "agent37_template_not_currently_verified", status: constraints.status };
  }
  if (current.connection_region !== constraints.region) return { code: "agent37_connection_region_mismatch", status: 409 };
  const latestAllocation = await getCurrentAllocation(c.env.PLATFORM_DB, original.id);
  if (!latestAllocation || latestAllocation.id !== allocation.id || latestAllocation.generation !== allocation.generation ||
      latestAllocation.status !== "active" || latestAllocation.external_id !== allocation.external_id ||
      !latestAllocation.image_digest || normalizeDigest(latestAllocation.image_digest) !== normalizeDigest(String(current.template_digest)) ||
      current.state !== "running") return { code: "artifact_transfer_allocation_changed", status: 409 };
  return null;
}

async function stopArtifactTransferForAdmissionFailure(
  c: Context<{ Bindings: Env; Variables: Vars }>,
  transferId: string,
  failure: { code: string; status: number },
): Promise<Response> {
  try {
    await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_artifact_transfers SET status='failed',error_code=?,updated_at=? WHERE id=? AND status IN ('running','indeterminate')`)
      .bind(failure.code, new Date().toISOString(), transferId).run();
  } catch { return fail("artifact_transfer_journal_failed", 503); }
  return fail(failure.code, failure.status);
}

function providerAllocation(row: AllocationRow): ProviderAllocation {
  if (!row.external_id) throw new Error("agent37_allocation_identity_unknown");
  return { provider: "agent37", externalId: row.external_id, generation: row.generation };
}

async function handleComputerAction(c: Context<{ Bindings: Env; Variables: Vars }>, action: "start" | "sleep"): Promise<Response> {
  const idempotencyKey = c.req.header("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length > 200) return fail("idempotency_key_required", 400);
  const computerId = String(c.req.param("id") ?? "");
  let row: RuntimeRow | Response = await loadRuntimeRow(c, computerId);
  if (row instanceof Response) return row;
  let requestBody: Record<string, unknown> = {};
  if (action === "start" && c.req.raw.body) {
    try { requestBody = JSON.parse(await readBoundedRequestText(c.req.raw, 8192)) as Record<string, unknown>; }
    catch { return fail("invalid_start_request", 400); }
  }
  if (requestBody.connectionId !== undefined) {
    if (typeof requestBody.connectionId !== "string" || !idPattern.test(requestBody.connectionId)) return fail("invalid_provider_connection", 400);
    if (row.connection_id && row.connection_id !== requestBody.connectionId) return fail("provider_connection_conflict", 409);
    if (!row.connection_id) {
      await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_computers SET connection_id=?,updated_at=? WHERE id=? AND tenant_id=? AND owner_id=? AND connection_id IS NULL`)
        .bind(requestBody.connectionId, new Date().toISOString(), row.id, row.tenant_id, row.owner_id).run();
      row = await loadRuntimeRow(c, String(computerId));
      if (row instanceof Response) return row;
    }
  }
  const failedConnection = requireConnection(row, false);
  if (failedConnection) return failedConnection;
  const constraints = templateConstraints(row);
  if (constraints instanceof Response) return constraints;
  if (row.connection_region !== constraints.region) return fail("agent37_connection_region_mismatch", 409);
  const resources = JSON.parse(row.resources_json) as { cpu: number; memoryMiB: number; diskGiB: number };
  if (!agent37TemplateAllows(constraints, { region: constraints.region, instanceType: constraints.instanceType, resources })) return fail("agent37_resource_profile_not_admitted", 409);
  const currentAllocation = await getCurrentAllocation(c.env.PLATFORM_DB, row.id);
  const payloadHash = await sha256(JSON.stringify({ computerId, action, connectionId: row.connection_id, generation: currentAllocation?.generation ?? row.allocation_generation + 1 }));
  const prior = await c.env.PLATFORM_DB.prepare(`SELECT id,payload_hash,status,result_json,error_code FROM sandbox_operations WHERE tenant_id=? AND idempotency_key=?`)
    .bind(row.tenant_id, idempotencyKey).first<{ id: string; payload_hash: string; status: string; result_json: string | null; error_code: string | null }>();
  if (prior) {
    if (prior.payload_hash !== payloadHash) return fail("idempotency_conflict", 409);
    return json({ operation: { id: prior.id, type: action, status: prior.status, result: prior.result_json ? JSON.parse(prior.result_json) : null, errorCode: prior.error_code } }, prior.status === "complete" || prior.status === "failed" ? 200 : 202);
  }
  const agentPortAgentId = c.req.header("x-naelao-agentport-agent-id") ?? null;
  const agentPortFailure = await authorizeAgent37Request(c, row,
    action === "start" ? "agent37.computer.start" : "agent37.computer.sleep", idempotencyKey, agentPortAgentId);
  if (agentPortFailure) return agentPortFailure;
  if (action === "sleep" && (!currentAllocation || currentAllocation.status !== "active" || !currentAllocation.external_id)) return fail("computer_not_running", 409);
  if (action === "start" && currentAllocation && ["intent", "unknown", "error"].includes(currentAllocation.status)) return fail("allocation_reconciliation_required", 409);
  if (action === "start" && currentAllocation?.status === "active") {
    if (row.execution_key_check_status !== "verified" || row.state !== "running") return fail("allocation_recovery_required", 409);
    const operationId = `op_${crypto.randomUUID()}`, now = new Date().toISOString();
    const result = { computerId, state: row.state === "running" ? "running" : "starting", allocationGeneration: currentAllocation.generation };
    await c.env.PLATFORM_DB.prepare(`INSERT INTO sandbox_operations (id,tenant_id,computer_id,operation,idempotency_key,payload_hash,status,generation,result_json,agentport_agent_id,created_at,updated_at)
      VALUES (?,?,?,'start',?,?,'complete',?,?,?,?,?)`).bind(operationId,row.tenant_id,row.id,idempotencyKey,payloadHash,currentAllocation.generation,JSON.stringify(result),agentPortAgentId,now,now).run();
    return json({ operation: { id: operationId, type: action, status: "complete", result } });
  }
  if (action === "start" && currentAllocation?.status === "sleeping") {
    if (row.execution_key_check_status !== "verified") return fail("agent37_execution_key_not_verified", 409);
    return runAgent37Transition(c, row, action, idempotencyKey, payloadHash, currentAllocation, agentPortAgentId);
  }
  if (action === "sleep") return runAgent37Transition(c, row, action, idempotencyKey, payloadHash, currentAllocation!, agentPortAgentId);
  if (row.state !== "configured" || currentAllocation) return fail("computer_state_conflict", 409);
  if (requestBody.providerBillingConsent !== true) return fail("provider_billing_consent_required", 428,
    "Starting this computer charges the connected customer-owned Agent37 account under that provider's terms.");
  return provisionAgent37Computer(c, row, constraints, resources, idempotencyKey, payloadHash, agentPortAgentId);
}

async function provisionAgent37Computer(c: Context<{ Bindings: Env; Variables: Vars }>, row: RuntimeRow, constraints: Agent37TemplateConstraints,
  resources: { cpu: number; memoryMiB: number; diskGiB: number }, key: string, payloadHash: string, agentPortAgentId: string | null): Promise<Response> {
  const operationId = `op_${crypto.randomUUID()}`, allocationId = `alloc_${crypto.randomUUID()}`;
  const generation = row.allocation_generation + 1, now = new Date().toISOString();
  const computer: ComputerConfig = { id: row.id, scope: { tenantId: row.tenant_id, ownerId: row.owner_id,
    ...(row.space_id ? { spaceId: row.space_id } : {}), ...(row.project_id ? { projectId: row.project_id } : {}), branch: row.branch },
    templateId: row.template_id, templateVersion: row.template_version, ownership: "customer_owned", filesystemId: row.filesystem_id,
    filesystemMode: row.filesystem_mode as ComputerConfig["filesystemMode"], providerPreference: "agent37", state: "provisioning",
    resources, idleTimeoutSeconds: row.idle_timeout_seconds, allocationGeneration: generation };
  try {
    const results = await c.env.PLATFORM_DB.batch([
      c.env.PLATFORM_DB.prepare(`INSERT INTO sandbox_operations (id,tenant_id,computer_id,operation,idempotency_key,payload_hash,status,generation,agentport_agent_id,created_at,updated_at)
        VALUES (?,?,?,'start',?,?,'pending',?,?,?,?)`).bind(operationId,row.tenant_id,row.id,key,payloadHash,generation,agentPortAgentId,now,now),
      c.env.PLATFORM_DB.prepare(`UPDATE sandbox_computers SET state='provisioning',allocation_generation=?,active_operation_id=?,updated_at=?
        WHERE id=? AND tenant_id=? AND owner_id=? AND state='configured' AND connection_id=?
          AND NOT EXISTS (SELECT 1 FROM sandbox_allocations WHERE computer_id=? AND status!='destroyed')`)
        .bind(generation,operationId,now,row.id,row.tenant_id,row.owner_id,row.connection_id,row.id),
      c.env.PLATFORM_DB.prepare(`INSERT INTO sandbox_allocations (id,computer_id,connection_id,provider,external_id,generation,status,operation_id,created_at,updated_at)
        SELECT ?,?,?, 'agent37',NULL,?,'intent',?,?,? WHERE EXISTS (SELECT 1 FROM sandbox_computers WHERE id=? AND active_operation_id=? AND state='provisioning')`)
        .bind(allocationId,row.id,row.connection_id,generation,operationId,now,now,row.id,operationId),
    ]);
    if (!results[1]?.meta.changes || !results[2]?.meta.changes) {
      await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_operations SET status='conflicted',error_code='computer_state_conflict',updated_at=? WHERE id=? AND status='pending'`).bind(now,operationId).run();
      return fail("computer_state_conflict", 409);
    }
  } catch {
    const old = await c.env.PLATFORM_DB.prepare(`SELECT id,payload_hash,status,result_json FROM sandbox_operations WHERE tenant_id=? AND idempotency_key=?`).bind(row.tenant_id,key)
      .first<{id:string;payload_hash:string;status:string;result_json:string|null}>();
    if (old) return old.payload_hash === payloadHash ? json({operation:{id:old.id,status:old.status,result:old.result_json ? JSON.parse(old.result_json) : null}}, old.status === "complete" ? 200 : 202) : fail("idempotency_conflict",409);
    return fail("agent37_operation_journal_failed",503);
  }
  const claimed = await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_operations SET status='running',lease_until=?,updated_at=? WHERE id=? AND status='pending'`)
    .bind(new Date(Date.now()+120_000).toISOString(),now,operationId).run();
  if (!claimed.meta.changes) return fail("operation_claim_lost",409);
  let allocatedExternalId: string | null = null;
  try {
    const provider = await createAgent37Provider(c,row,constraints);
    const allocated = await provider.allocate(computer,operationId);
    allocatedExternalId = allocated.externalId;
    await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_allocations SET external_id=?,status='active',updated_at=? WHERE id=? AND operation_id=? AND status='intent'`)
      .bind(allocated.externalId,new Date().toISOString(),allocationId,operationId).run();
    const latest = await c.env.PLATFORM_DB.prepare(`SELECT conn.status AS connection_status,c.deleted_at FROM sandbox_computers c
      JOIN sandbox_connections conn ON conn.id=c.connection_id WHERE c.id=? AND conn.id=?`).bind(row.id,row.connection_id).first<{connection_status:string;deleted_at:string|null}>();
    if (!latest || latest.connection_status === "revoked" || latest.deleted_at) {
      const cleanupAt = new Date().toISOString();
      await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_provider_deletion_operations SET external_id=?,status='pending',reason_code=NULL,updated_at=?
        WHERE allocation_id=? AND status='retained' AND reason_code='allocation_identity_unknown'`).bind(allocated.externalId,cleanupAt,allocationId).run();
      await queueSandboxComputerDeletion(c.env.PLATFORM_DB,row.tenant_id,row.id,cleanupAt);
      await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_operations SET status='failed',error_code='agent37_connection_revoked_during_create',lease_until=NULL,updated_at=? WHERE id=?`)
        .bind(cleanupAt,operationId).run();
      return json({operation:{id:operationId,type:"start",status:"failed",errorCode:"agent37_connection_revoked_during_create",cleanup:"queued"}},202);
    }
    const observed = await provider.inspectDetails(allocated);
    if (typeof observed.image_digest === "string") allocated.imageDigest = observed.image_digest;
    await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_allocations SET image_digest=?,updated_at=? WHERE id=? AND generation=?`)
      .bind(allocated.imageDigest ?? null,new Date().toISOString(),allocationId,generation).run();
    const expectedDigest = normalizeDigest(String(row.template_digest));
    const observedDigest = allocated.imageDigest ? normalizeDigest(allocated.imageDigest) : null;
    if (!observedDigest || observedDigest !== expectedDigest) {
      await finishAgent37AdmissionFailure(c.env.PLATFORM_DB,row,operationId,allocationId,"agent37_image_digest_unconfirmed");
      return json({ operation: { id: operationId, type: "start", status: "failed", errorCode: "agent37_image_digest_unconfirmed",
        allocation: { id: allocationId, generation, externalId: allocated.externalId } } }, 202);
    }
    try {
      await provider.verifyInstanceCredentials(allocated);
    } catch (error) {
      const code = safeProviderError(error,"agent37_execution_key_check_failed");
      await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_connections SET execution_key_check_status='failed',execution_key_check_error_code=?,updated_at=? WHERE id=? AND status!='revoked'`)
        .bind(code,new Date().toISOString(),row.connection_id).run();
      await finishAgent37AdmissionFailure(c.env.PLATFORM_DB,row,operationId,allocationId,"agent37_execution_key_check_failed");
      return json({ operation: { id: operationId, type: "start", status: "failed", errorCode: "agent37_execution_key_check_failed",
        allocation: { id: allocationId, generation, externalId: allocated.externalId } } }, 202);
    }
    const finished = new Date().toISOString();
    const result = { computerId: row.id, state: "running", allocation: { id: allocationId, generation, provider: "agent37", externalId: allocated.externalId,
      region: allocated.region, imageDigest: allocated.imageDigest }, billingModel: "customer_owned_agent37_account" };
    const finishedRows = await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_connections SET execution_key_check_status='verified',execution_key_verified_at=?,execution_key_check_error_code=NULL,updated_at=? WHERE id=? AND status!='revoked'`).bind(finished,finished,row.connection_id).run();
    if (!finishedRows.meta.changes) {
      await finishAgent37AdmissionFailure(c.env.PLATFORM_DB,row,operationId,allocationId,"agent37_connection_revoked_during_create");
      return json({ operation: { id: operationId, type: "start", status: "failed", errorCode: "agent37_connection_revoked_during_create",
        allocation: { id: allocationId, generation, externalId: allocated.externalId } } }, 202);
    }
    await c.env.PLATFORM_DB.batch([
      c.env.PLATFORM_DB.prepare(`UPDATE sandbox_computers SET state='running',active_operation_id=NULL,updated_at=? WHERE id=? AND active_operation_id=? AND deleted_at IS NULL`).bind(finished,row.id,operationId),
      c.env.PLATFORM_DB.prepare(`UPDATE sandbox_operations SET status='complete',result_json=?,lease_until=NULL,error_code=NULL,updated_at=? WHERE id=?`).bind(JSON.stringify(result),finished,operationId),
    ]);
    return json({ operation: { id: operationId, type: "start", status: "complete", result } }, 201);
  } catch (error) {
    const code = safeProviderError(error,"agent37_create_outcome_unknown");
    if (!allocatedExternalId && isKnownAgent37NoEffect(code)) {
      await c.env.PLATFORM_DB.batch([
        c.env.PLATFORM_DB.prepare(`UPDATE sandbox_allocations SET status='error',updated_at=? WHERE id=? AND status='intent'`).bind(new Date().toISOString(),allocationId),
        c.env.PLATFORM_DB.prepare(`UPDATE sandbox_computers SET state='configured',active_operation_id=NULL,updated_at=? WHERE id=? AND active_operation_id=?`).bind(new Date().toISOString(),row.id,operationId),
        c.env.PLATFORM_DB.prepare(`UPDATE sandbox_operations SET status='failed',error_code=?,lease_until=NULL,updated_at=? WHERE id=?`).bind(code,new Date().toISOString(),operationId),
      ]);
      return fail("agent37_create_refused", 502, code);
    }
    const unknown = new Date().toISOString();
    await c.env.PLATFORM_DB.batch([
      c.env.PLATFORM_DB.prepare(`UPDATE sandbox_allocations SET status='unknown',updated_at=? WHERE id=? AND status='intent'`).bind(unknown,allocationId),
      c.env.PLATFORM_DB.prepare(`UPDATE sandbox_computers SET state='recovery_required',updated_at=? WHERE id=? AND active_operation_id=?`).bind(unknown,row.id,operationId),
      c.env.PLATFORM_DB.prepare(`UPDATE sandbox_operations SET status='indeterminate',error_code=?,lease_until=NULL,recovery_after=?,updated_at=? WHERE id=?`)
        .bind(code,new Date(Date.now()+60_000).toISOString(),unknown,operationId),
    ]);
    return json({ operation: { id: operationId, type: "start", status: "indeterminate", errorCode: code,
      reconciliation: "read_only_provider_discovery" } }, 202);
  }
}

async function finishAgent37AdmissionFailure(db: D1Database,row:RuntimeRow,operationId:string,allocationId:string,errorCode:string) {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE sandbox_computers SET state='recovery_required',active_operation_id=NULL,updated_at=? WHERE id=? AND active_operation_id=?`).bind(now,row.id,operationId),
    db.prepare(`UPDATE sandbox_operations SET status='failed',error_code=?,lease_until=NULL,updated_at=? WHERE id=?`).bind(errorCode,now,operationId),
  ]);
  // Keep the external allocation identity reachable for explicit delete/recovery.
  await db.prepare(`UPDATE sandbox_allocations SET status='active',updated_at=? WHERE id=? AND external_id IS NOT NULL`).bind(now,allocationId).run();
}

async function runAgent37Transition(c:Context<{Bindings:Env;Variables:Vars}>,row:RuntimeRow,action:"start"|"sleep",key:string,payloadHash:string,allocationRow:AllocationRow,agentPortAgentId:string|null):Promise<Response> {
  const operationId=`op_${crypto.randomUUID()}`,now=new Date().toISOString();
  const nextState=action==="start"?"starting":"stopping";
  try {
    const reserved = await c.env.PLATFORM_DB.batch([
      c.env.PLATFORM_DB.prepare(`INSERT INTO sandbox_operations (id,tenant_id,computer_id,operation,idempotency_key,payload_hash,status,generation,agentport_agent_id,created_at,updated_at) VALUES (?,?,?, ?,?,?,'pending',?,?,?,?)`)
        .bind(operationId,row.tenant_id,row.id,action,key,payloadHash,allocationRow.generation,agentPortAgentId,now,now),
      c.env.PLATFORM_DB.prepare(`UPDATE sandbox_computers SET state=?,active_operation_id=?,updated_at=? WHERE id=? AND state=? AND active_operation_id IS NULL AND deleted_at IS NULL`)
        .bind(nextState,operationId,now,row.id,action==="start"?"sleeping":"running"),
    ]);
    if (!reserved[1]?.meta.changes) {
      await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_operations SET status='conflicted',error_code='computer_state_conflict',updated_at=? WHERE id=? AND status='pending'`).bind(now,operationId).run();
      return fail("computer_state_conflict",409);
    }
  } catch { return fail("operation_journal_conflict",409); }
  const claimed=await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_operations SET status='running',lease_until=?,updated_at=? WHERE id=? AND status='pending'`)
    .bind(new Date(Date.now()+120_000).toISOString(),now,operationId).run();
  if (!claimed.meta.changes) return fail("operation_claim_lost",409);
  try {
    const constraints=templateConstraints(row); if(constraints instanceof Response) throw new Error("agent37_template_not_currently_verified");
    const provider=await createAgent37Provider(c,row,constraints), allocation=providerAllocation(allocationRow);
    if(action==="start") await provider.start(allocation); else await provider.sleep(allocation);
    const observed=await provider.inspect(allocation);
    if ((action==="start"&&observed.state!=="running")||(action==="sleep"&&observed.state!=="sleeping")) throw new Error("agent37_transition_outcome_unknown");
    const state=action==="start"?"running":"sleeping",finished=new Date().toISOString(),result={computerId:row.id,state,allocationGeneration:allocationRow.generation};
    await c.env.PLATFORM_DB.batch([
      c.env.PLATFORM_DB.prepare(`UPDATE sandbox_allocations SET status=?,updated_at=? WHERE id=? AND generation=?`).bind(state==="running"?"active":"sleeping",finished,allocationRow.id,allocationRow.generation),
      c.env.PLATFORM_DB.prepare(`UPDATE sandbox_computers SET state=?,active_operation_id=NULL,updated_at=? WHERE id=? AND active_operation_id=?`).bind(state,finished,row.id,operationId),
      c.env.PLATFORM_DB.prepare(`UPDATE sandbox_operations SET status='complete',result_json=?,lease_until=NULL,error_code=NULL,updated_at=? WHERE id=?`).bind(JSON.stringify(result),finished,operationId),
    ]);
    return json({operation:{id:operationId,type:action,status:"complete",result}});
  } catch(error) {
    const code=safeProviderError(error,"agent37_transition_outcome_unknown"),failedAt=new Date().toISOString();
    await c.env.PLATFORM_DB.batch([
      c.env.PLATFORM_DB.prepare(`UPDATE sandbox_computers SET state='recovery_required',updated_at=? WHERE id=? AND active_operation_id=?`).bind(failedAt,row.id,operationId),
      c.env.PLATFORM_DB.prepare(`UPDATE sandbox_operations SET status='indeterminate',error_code=?,lease_until=NULL,updated_at=? WHERE id=?`).bind(code,failedAt,operationId),
    ]);
    return json({operation:{id:operationId,type:action,status:"indeterminate",errorCode:code}},202);
  }
}

/** Reconcile only an explicitly confirmed, uncertain start/sleep by reading the existing
 * provider instance. This route never sends a start or sleep request. */
async function reconcileAgent37Transition(c:Context<{Bindings:Env;Variables:Vars}>):Promise<Response> {
  const row=await loadRuntimeRow(c,String(c.req.param("id")??""));if(row instanceof Response)return row;
  if(c.get("role")!=="owner")return fail("forbidden",403);
  let body:Record<string,unknown>;
  try { body=JSON.parse(await readBoundedRequestText(c.req.raw,4096)) as Record<string,unknown>; }
  catch { return fail("invalid_reconciliation_request",400); }
  if(body.confirm!==true)return fail("owner_confirmation_required",428);
  const operationId=String(c.req.param("operationId")??"");
  const operation=await c.env.PLATFORM_DB.prepare(`SELECT id,tenant_id,computer_id,operation,status,generation,error_code
    FROM sandbox_operations WHERE id=? AND tenant_id=? AND computer_id=?`)
    .bind(operationId,row.tenant_id,row.id)
    .first<{id:string;tenant_id:string;computer_id:string;operation:string;status:string;generation:number;error_code:string|null}>();
  if(!operation)return fail("operation_not_found",404);
  if(!["start","sleep"].includes(operation.operation)||operation.status!=="indeterminate")return fail("transition_not_reconcilable",409);
  if(row.state!=="recovery_required"||row.active_operation_id!==operation.id||row.allocation_generation!==operation.generation)
    return fail("transition_reconciliation_fence_changed",409);
  const connectionFailure=requireConnection(row,true);if(connectionFailure)return connectionFailure;
  const constraints=templateConstraints(row);if(constraints instanceof Response)return constraints;
  if(row.connection_region!==constraints.region)return fail("agent37_connection_region_mismatch",409);
  const allocation=await getCurrentAllocation(c.env.PLATFORM_DB,row.id);
  const priorAllocationStatus=operation.operation==="start"?"sleeping":"active";
  if(!allocation||allocation.operation_id===operation.id||allocation.id===null||allocation.provider!=="agent37"||
      allocation.connection_id!==row.connection_id||allocation.generation!==operation.generation||allocation.generation!==row.allocation_generation||
      allocation.status!==priorAllocationStatus||typeof allocation.external_id!=="string"||!allocation.external_id||
      !allocation.image_digest||normalizeDigest(allocation.image_digest)!==normalizeDigest(String(row.template_digest)))
    return fail("transition_allocation_fence_changed",409);
  const provider=await createAgent37Provider(c,row,constraints),providerAllocationRecord=providerAllocation(allocation);
  let observed:{state:"running"|"sleeping"|"deleted"|"error";healthy:boolean};
  try { observed=await provider.inspect(providerAllocationRecord); }
  catch(error) { return json({operation:{id:operation.id,type:operation.operation,status:"indeterminate",
    errorCode:safeProviderError(error,"agent37_transition_inspection_unavailable"),actionReplayed:false}},202); }
  const targetState=operation.operation==="start"?"running":"sleeping";
  if(observed.state!==targetState)return json({operation:{id:operation.id,type:operation.operation,status:"indeterminate",
    observedState:observed.state,actionReplayed:false}},202);

  // Re-read after the provider call. The external inspection may be slow while ownership,
  // connection, generation, operation or allocation changes.
  const current=await loadRuntimeRow(c,row.id);if(current instanceof Response)return current;
  const currentOperation=await c.env.PLATFORM_DB.prepare(`SELECT id,tenant_id,computer_id,operation,status,generation
    FROM sandbox_operations WHERE id=? AND tenant_id=? AND computer_id=?`)
    .bind(operation.id,row.tenant_id,row.id).first<typeof operation>();
  const currentAllocation=await getCurrentAllocation(c.env.PLATFORM_DB,row.id);
  const currentConnectionFailure=requireConnection(current,true);
  if(currentConnectionFailure||current.connection_id!==row.connection_id||current.state!=="recovery_required"||
      current.active_operation_id!==operation.id||current.allocation_generation!==operation.generation||
      !currentOperation||currentOperation.status!=="indeterminate"||currentOperation.operation!==operation.operation||
      currentOperation.generation!==operation.generation||!currentAllocation||currentAllocation.id!==allocation.id||
      currentAllocation.operation_id===operation.id||currentAllocation.connection_id!==allocation.connection_id||
      currentAllocation.external_id!==allocation.external_id||currentAllocation.generation!==allocation.generation||
      currentAllocation.status!==priorAllocationStatus||currentAllocation.image_digest!==allocation.image_digest)
    return fail("transition_reconciliation_fence_changed",409);

  const finished=new Date().toISOString(),result={computerId:row.id,state:targetState,allocationGeneration:allocation.generation,
    reconciliation:"provider_read_only_inspection",actionReplayed:false};
  const results=await c.env.PLATFORM_DB.batch([
    c.env.PLATFORM_DB.prepare(`UPDATE sandbox_computers SET state=?,active_operation_id=NULL,updated_at=?
      WHERE id=? AND tenant_id=? AND owner_id=? AND state='recovery_required' AND active_operation_id=? AND allocation_generation=?
        AND EXISTS (SELECT 1 FROM sandbox_operations o WHERE o.id=? AND o.tenant_id=? AND o.computer_id=? AND o.operation=? AND o.status='indeterminate' AND o.generation=?)
        AND EXISTS (SELECT 1 FROM sandbox_allocations a WHERE a.id=? AND a.computer_id=? AND a.connection_id=? AND a.provider='agent37'
          AND a.external_id=? AND a.generation=? AND a.status=? AND a.image_digest=?)
        AND EXISTS (SELECT 1 FROM sandbox_connections conn WHERE conn.id=? AND conn.tenant_id=? AND conn.status!='revoked')`)
      .bind(targetState,finished,row.id,row.tenant_id,row.owner_id,operation.id,operation.generation,operation.id,row.tenant_id,row.id,
        operation.operation,operation.generation,allocation.id,row.id,allocation.connection_id,allocation.external_id,allocation.generation,
        priorAllocationStatus,allocation.image_digest,row.connection_id,row.tenant_id),
    c.env.PLATFORM_DB.prepare(`UPDATE sandbox_allocations SET status=?,updated_at=? WHERE id=? AND computer_id=? AND connection_id=?
      AND provider='agent37' AND external_id=? AND generation=? AND status=? AND image_digest=?
      AND EXISTS (SELECT 1 FROM sandbox_computers c WHERE c.id=? AND c.tenant_id=? AND c.owner_id=? AND c.state=? AND c.active_operation_id IS NULL AND c.allocation_generation=?)`)
      .bind(targetState==="running"?"active":"sleeping",finished,allocation.id,row.id,allocation.connection_id,allocation.external_id,
        allocation.generation,priorAllocationStatus,allocation.image_digest,row.id,row.tenant_id,row.owner_id,targetState,allocation.generation),
    c.env.PLATFORM_DB.prepare(`UPDATE sandbox_operations SET status='complete',result_json=?,lease_until=NULL,error_code=NULL,updated_at=?
      WHERE id=? AND tenant_id=? AND computer_id=? AND operation=? AND status='indeterminate' AND generation=?
        AND EXISTS (SELECT 1 FROM sandbox_computers c WHERE c.id=? AND c.state=? AND c.active_operation_id IS NULL AND c.allocation_generation=?)
        AND EXISTS (SELECT 1 FROM sandbox_allocations a WHERE a.id=? AND a.generation=? AND a.status=?)`)
      .bind(JSON.stringify(result),finished,operation.id,row.tenant_id,row.id,operation.operation,operation.generation,row.id,targetState,
        allocation.generation,allocation.id,allocation.generation,targetState==="running"?"active":"sleeping"),
  ]);
  if(results.some(result=>!result?.meta.changes))return fail("transition_reconciliation_race",409);
  return json({operation:{id:operation.id,type:operation.operation,status:"complete",result,observedState:observed.state,actionReplayed:false}});
}

async function handleAgent37Execution(c:Context<{Bindings:Env;Variables:Vars}>):Promise<Response> {
  const key=c.req.header("idempotency-key");if(!key||key.length>200)return fail("idempotency_key_required",400);
  const row=await loadRuntimeRow(c,String(c.req.param("id")??""));if(row instanceof Response)return row;
  const blocked=requireConnection(row,true);if(blocked)return blocked;
  const constraints=templateConstraints(row);if(constraints instanceof Response)return constraints;
  if(row.connection_region!==constraints.region)return fail("agent37_connection_region_mismatch",409);
  const allocation=await getCurrentAllocation(c.env.PLATFORM_DB,row.id);
  if(!allocation||allocation.status!=="active"||!allocation.external_id)return fail("computer_not_running",409);
  if(row.state!=="running")return fail("computer_not_running",409);
  let raw:string,input:Record<string,unknown>;
  try{raw=await readBoundedRequestText(c.req.raw,128*1024);input=JSON.parse(raw) as Record<string,unknown>;}catch{return fail("invalid_execution_request",400);}
  const command=input.command,args=input.args??[];
  if(typeof command!=="string"||!command.length||command.length>64*1024||command.includes("\0")||!Array.isArray(args)||args.length>128||args.some(a=>typeof a!=="string"||a.length>16*1024||(a as string).includes("\0")))return fail("invalid_execution_request",400);
  const cwd=input.cwd;
  if(cwd!==undefined&&(typeof cwd!=="string"||!cwd.length||cwd.length>1024||cwd.includes("\0")))return fail("invalid_execution_request",400);
  const timeoutMs=input.timeoutMs??30_000;
  if(!Number.isInteger(timeoutMs)||Number(timeoutMs)<1000||Number(timeoutMs)>280_000)return fail("invalid_execution_timeout",400);
  const environment=input.environment??{};
  if(!environment||typeof environment!=="object"||Array.isArray(environment)||Object.keys(environment).length>64||Object.entries(environment as Record<string,unknown>).some(([k,v])=>! /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k)||typeof v!=="string"||v.length>8192||(v as string).includes("\0")))return fail("invalid_execution_environment",400);
  const payloadHash=await sha256(raw),prior=await c.env.PLATFORM_DB.prepare(`SELECT id,payload_hash,status,result_ciphertext,result_iv FROM sandbox_executions WHERE computer_id=? AND idempotency_key=?`)
    .bind(row.id,key).first<{id:string;payload_hash:string;status:string;result_ciphertext:string|null;result_iv:string|null}>();
  if(prior){if(prior.payload_hash!==payloadHash)return fail("idempotency_conflict",409);return executionReplay(c,row,prior);}
  const executionId=`exec_${crypto.randomUUID()}`,now=new Date().toISOString(),recoveryAfter=new Date(Date.now()+5*60_000).toISOString();
  const requestData={command,args:args as string[],...(typeof cwd==="string"?{cwd}:{}),timeoutMs:Number(timeoutMs),environment:environment as Record<string,string>};
  const agentPortAgentId=c.req.header("x-naelao-agentport-agent-id")??null;
  const sealed=await sealSandboxRecord(c.env.PLATFORM_SECRET,row.tenant_id,row.owner_id,executionId,"request",JSON.stringify(requestData));
  try{
    await c.env.PLATFORM_DB.prepare(`INSERT INTO sandbox_executions (id,tenant_id,owner_id,computer_id,run_id,idempotency_key,payload_hash,status,created_at,updated_at,request_ciphertext,request_iv,provider_execution_name,recovery_after,allocation_id,allocation_generation,agentport_agent_id)
      VALUES (?,?,?, ?,NULL,?,?,'running',?,?,?,?,?,?,?,?,?)`).bind(executionId,row.tenant_id,row.owner_id,row.id,key,payloadHash,now,now,sealed.ciphertext,sealed.iv,`naelao-${executionId}`.slice(0,120),recoveryAfter,allocation.id,allocation.generation,agentPortAgentId).run();
  }catch{
    const raced=await c.env.PLATFORM_DB.prepare(`SELECT id,payload_hash,status,result_ciphertext,result_iv FROM sandbox_executions WHERE computer_id=? AND idempotency_key=?`).bind(row.id,key)
      .first<{id:string;payload_hash:string;status:string;result_ciphertext:string|null;result_iv:string|null}>();
    if(raced&&raced.payload_hash===payloadHash)return executionReplay(c,row,raced);
    return fail(raced?"idempotency_conflict":"execution_journal_failed",raced?409:503);
  }
  return dispatchPersistedExecution(c,row,allocation,executionId,requestData,agentPortAgentId);
}

async function reconcileAgent37Execution(c:Context<{Bindings:Env;Variables:Vars}>):Promise<Response>{
  const row=await loadRuntimeRow(c,String(c.req.param("id")??""));if(row instanceof Response)return row;
  const blocked=requireConnection(row,true);if(blocked)return blocked;
  const execution=await c.env.PLATFORM_DB.prepare(`SELECT * FROM sandbox_executions WHERE id=? AND computer_id=? AND tenant_id=? AND owner_id=?`)
    .bind(c.req.param("executionId"),row.id,row.tenant_id,row.owner_id).first<Record<string,unknown>>();
  if(!execution)return fail("execution_not_found",404);
  if(["succeeded","failed","cancelled"].includes(String(execution.status)))return executionReplay(c,row,execution as never);
  if(!["running","indeterminate"].includes(String(execution.status))||!execution.request_ciphertext||!execution.request_iv)return fail("execution_not_reconcilable",409);
  if(!execution.recovery_after||Date.parse(String(execution.recovery_after))<Date.now())return fail("agent37_named_execution_replay_window_expired",409);
  const allocation=await getCurrentAllocation(c.env.PLATFORM_DB,row.id);
  if(!allocation||allocation.id!==execution.allocation_id||allocation.generation!==execution.allocation_generation||allocation.status!=="active"||!allocation.external_id)return fail("execution_allocation_changed",409);
  let requestData:Record<string,unknown>;
  try{requestData=JSON.parse(await openSandboxRecord(c.env.PLATFORM_SECRET,row.tenant_id,row.owner_id,String(execution.id),"request",{ciphertext:String(execution.request_ciphertext),iv:String(execution.request_iv)})) as Record<string,unknown>;}catch{return fail("execution_recovery_record_unavailable",503);}
  return dispatchPersistedExecution(c,row,allocation,String(execution.id),requestData,
    typeof execution.agentport_agent_id==="string"?execution.agentport_agent_id:null);
}

async function dispatchPersistedExecution(c:Context<{Bindings:Env;Variables:Vars}>,row:RuntimeRow,allocationRow:AllocationRow,executionId:string,data:Record<string,unknown>,agentPortAgentId?:string|null):Promise<Response>{
  try{
    const agentPortFailure=await authorizeAgent37Request(c,row,"agent37.exec",executionId,agentPortAgentId);if(agentPortFailure)return agentPortFailure;
    const constraints=templateConstraints(row);if(constraints instanceof Response)return constraints;
    const provider=await createAgent37Provider(c,row,constraints);
    const request:RuntimeRequest={executionId,computer:{id:row.id,scope:{tenantId:row.tenant_id,ownerId:row.owner_id,
      ...(row.space_id?{spaceId:row.space_id}:{}),...(row.project_id?{projectId:row.project_id}:{}),branch:row.branch},templateId:row.template_id,
      templateVersion:row.template_version,ownership:"customer_owned",filesystemId:row.filesystem_id,filesystemMode:row.filesystem_mode as ComputerConfig["filesystemMode"],
      providerPreference:"agent37",state:"running",resources:JSON.parse(row.resources_json) as ComputerConfig["resources"],idleTimeoutSeconds:row.idle_timeout_seconds,allocationGeneration:allocationRow.generation},
      allocation:providerAllocation(allocationRow),command:String(data.command),args:data.args as string[],timeoutMs:Number(data.timeoutMs),
      ...(typeof data.cwd==="string"?{cwd:data.cwd}:{}),environment:data.environment as Record<string,string>};
    const result=await provider.invoke(request);
    await persistExecutionResult(c,row,executionId,result);
    return json({execution:result},result.status==="indeterminate"?202:200);
  }catch(error){
    const result:ExecutionResult={id:executionId,status:"indeterminate",exitCode:null,stdout:"",stderr:safeProviderError(error,"agent37_execution_outcome_unknown"),truncated:false,publicationId:null,workspaceState:"recovery_required"};
    await persistExecutionResult(c,row,executionId,result);
    return json({execution:result},202);
  }
}

async function persistExecutionResult(c:Context<{Bindings:Env;Variables:Vars}>,row:RuntimeRow,executionId:string,result:ExecutionResult){
  const sealed=await sealSandboxRecord(c.env.PLATFORM_SECRET,row.tenant_id,row.owner_id,executionId,"result",JSON.stringify(result)),now=new Date().toISOString();
  await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_executions SET status=?,exit_code=?,truncated=?,publication_id=?,workspace_state=?,result_ciphertext=?,result_iv=?,updated_at=? WHERE id=? AND tenant_id=? AND owner_id=?`)
    .bind(result.status,result.exitCode,result.truncated?1:0,result.publicationId,result.workspaceState,sealed.ciphertext,sealed.iv,now,executionId,row.tenant_id,row.owner_id).run();
}

async function executionReplay(c:Context<{Bindings:Env;Variables:Vars}>,row:RuntimeRow,execution:{id:string;status:string;result_ciphertext?:string|null;result_iv?:string|null}):Promise<Response>{
  if(execution.result_ciphertext&&execution.result_iv){
    try{const result=JSON.parse(await openSandboxRecord(c.env.PLATFORM_SECRET,row.tenant_id,row.owner_id,execution.id,"result",{ciphertext:execution.result_ciphertext,iv:execution.result_iv})) as ExecutionResult;return json({execution:result},result.status==="indeterminate"?202:200);}catch{return fail("execution_result_unavailable",503);}
  }
  return json({execution:{id:execution.id,status:execution.status}},202);
}

async function handleAgent37ArtifactTransfer(c:Context<{Bindings:Env;Variables:Vars}>):Promise<Response>{
  const key=c.req.header("idempotency-key");if(!key||key.length>200)return fail("idempotency_key_required",400);
  const row=await loadRuntimeRow(c,String(c.req.param("id")??""));if(row instanceof Response)return row;
  const connectionFailure=requireConnection(row,true);if(connectionFailure)return connectionFailure;
  const constraints=templateConstraints(row);if(constraints instanceof Response)return constraints;
  const allocation=await getCurrentAllocation(c.env.PLATFORM_DB,row.id);
  if(!allocation||allocation.status!=="active"||!allocation.external_id||row.state!=="running")return fail("computer_not_running",409);
  if(!allocation.image_digest||normalizeDigest(allocation.image_digest)!==normalizeDigest(String(row.template_digest)))return fail("allocation_image_digest_unverified",409);
  if(!c.env.AGENTS_WORKER)return fail("workspace_coordinator_unavailable",503);
  let raw:string,input:Record<string,unknown>;
  try{raw=await readBoundedRequestText(c.req.raw,16*1024);input=JSON.parse(raw) as Record<string,unknown>;}catch{return fail("invalid_artifact_transfer",400);}
  const direction=input.direction,paths=input.paths,publish=input.publish===true;
  if((direction!=="import"&&direction!=="stage_output")||!Array.isArray(paths)||!paths.length||paths.length>100||
     direction==="import"&&publish||direction==="import"&&input.publish!==undefined)return fail("invalid_artifact_transfer",400);
  let selected:string[];
  try{selected=paths.map(path=>assertWorkspacePath(path));}catch{return fail("invalid_artifact_path",400);}
  if(new Set(selected).size!==selected.length||selected.reduce((n,path)=>n+path.length,0)>20_000)return fail("invalid_artifact_path_set",400);
  const payloadHash=await sha256(raw);
  const prior=await c.env.PLATFORM_DB.prepare(`SELECT id,payload_hash,status,receipt_json,error_code FROM sandbox_artifact_transfers WHERE computer_id=? AND idempotency_key=?`)
    .bind(row.id,key).first<{id:string;payload_hash:string;status:string;receipt_json:string|null;error_code:string|null}>();
  if(prior){if(prior.payload_hash!==payloadHash)return fail("idempotency_conflict",409);return json({transfer:{id:prior.id,status:prior.status,receipt:prior.receipt_json?JSON.parse(prior.receipt_json):null,errorCode:prior.error_code,
    ...(prior.status==="running"||prior.status==="indeterminate"?{reconcileUrl:`/computers/${encodeURIComponent(row.id)}/artifact-transfers/${encodeURIComponent(prior.id)}/reconcile`}:{})}},prior.status==="complete"||prior.status==="published"?200:202);}
  const transferId=`xfer_${crypto.randomUUID()}`,now=new Date().toISOString();
  const agentPortAgentId=c.req.header("x-naelao-agentport-agent-id")??null;
  try{
    await c.env.PLATFORM_DB.prepare(`INSERT INTO sandbox_artifact_transfers
      (id,tenant_id,owner_id,computer_id,allocation_id,allocation_generation,direction,idempotency_key,payload_hash,status,request_json,agentport_agent_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'running',?,?,?,?)`).bind(transferId,row.tenant_id,row.owner_id,row.id,allocation.id,allocation.generation,direction,key,payloadHash,
        JSON.stringify({paths:selected,publish}),agentPortAgentId,now,now).run();
  }catch{return fail("artifact_transfer_journal_failed",503);}
  const agentPortFailure=await authorizeAgent37Request(c,row,direction==="import"?"agent37.artifacts.write":"agent37.artifacts.read",transferId,agentPortAgentId);
  if(agentPortFailure){
    const denied=await agentPortFailure.clone().json().catch(()=>({})) as {error_code?:unknown};
    const code=typeof denied.error_code==="string"?denied.error_code:"agentport_agent37_authorization_failed";
    return stopArtifactTransferForAdmissionFailure(c,transferId,{code,status:agentPortFailure.status});
  }
  const computer=runtimeComputer(row,allocation.generation),providerAllocationRecord=providerAllocation(allocation);
  const handoff=agent37WorkspaceHandoff(c.env,computer);
  try{
    const provider=await createAgent37Provider(c,row,constraints);
    const base=await handoff.readSelectedCommitted?.({tenantId:row.tenant_id,spaceId:String(row.space_id),projectId:String(row.project_id),branch:row.branch,
      allocationGeneration:allocation.generation,paths:selected,allowMissing:direction==="stage_output"});
    if(!base)throw new Error("explicit_artifact_reader_unavailable");
    let receipt:Record<string,unknown>;
    if(direction==="import"){
      if(!base.files.length)throw new Error("artifact_input_missing");
      const destinationRoot=`artifacts/imports/${transferId}`;
      const transferred=base.files.map(file=>({path:file.path,destination:`${destinationRoot}/${file.path}`,sha256:file.sha256,size:file.bytes.byteLength,contentType:file.contentType??inferAgent37ContentType(file.path)}));
      receipt={direction:"import",sourceRevision:base.revision,allocationId:allocation.id,allocationGeneration:allocation.generation,imageDigest:allocation.image_digest,files:transferred};
      await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_artifact_transfers SET workspace_session_id=?,workspace_fence=?,base_revision=?,receipt_json=?,updated_at=? WHERE id=?`)
        .bind(base.sessionId,base.fence,base.revision,JSON.stringify(receipt),new Date().toISOString(),transferId).run();
      const directories=new Set<string>([`/home/node/workspace/${destinationRoot}`]);
      for(const file of base.files){let parent=file.path.split("/").slice(0,-1);while(parent.length){directories.add(`/home/node/workspace/${destinationRoot}/${parent.join("/")}`);parent=parent.slice(0,-1);}}
      const beforeDirectoryCreation=await agent37ArtifactAdmissionFailure(c,row,allocation);
      if(beforeDirectoryCreation)return stopArtifactTransferForAdmissionFailure(c,transferId,beforeDirectoryCreation);
      const mkdir=await provider.invoke({executionId:`${transferId}-mkdir`,computer,allocation:providerAllocationRecord,command:"mkdir",args:["-p",...directories],cwd:"/home/node",timeoutMs:30_000});
      if(mkdir.status!=="succeeded")throw new Error(mkdir.status==="indeterminate"?"artifact_directory_creation_indeterminate":"artifact_directory_creation_failed");
      for(const file of base.files){
        const destination=`${destinationRoot}/${file.path}`;
        const beforeWrite=await agent37ArtifactAdmissionFailure(c,row,allocation);
        if(beforeWrite)return stopArtifactTransferForAdmissionFailure(c,transferId,beforeWrite);
        try{await provider.writeWorkspaceFile(providerAllocationRecord,destination,file.bytes,null);}
        catch{
          // A lost PUT response is reconciled by read-back; never repeat the write blindly.
          const beforeReadback=await agent37ArtifactAdmissionFailure(c,row,allocation);
          if(beforeReadback)return stopArtifactTransferForAdmissionFailure(c,transferId,beforeReadback);
          const existing=await provider.readWorkspaceFile(providerAllocationRecord,destination,file.bytes.byteLength).catch(()=>null);
          if(!existing||await sha256Bytes(existing)!==file.sha256)throw new Error("artifact_input_write_outcome_unknown");
        }
        const beforeVerification=await agent37ArtifactAdmissionFailure(c,row,allocation);
        if(beforeVerification)return stopArtifactTransferForAdmissionFailure(c,transferId,beforeVerification);
        const saved=await provider.readWorkspaceFile(providerAllocationRecord,destination,file.bytes.byteLength);
        if(await sha256Bytes(saved)!==file.sha256)throw new Error("artifact_input_integrity_mismatch");
      }
      await handoff.close?.({sessionId:base.sessionId,fence:base.fence,allocationGeneration:allocation.generation}).catch(()=>undefined);
      const done=new Date().toISOString();
      await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_artifact_transfers SET status='complete',workspace_session_id=?,workspace_fence=?,base_revision=?,receipt_json=?,updated_at=? WHERE id=?`)
        .bind(base.sessionId,base.fence,base.revision,JSON.stringify(receipt),done,transferId).run();
      return json({transfer:{id:transferId,status:"complete",receipt}},201);
    }
    const baseByPath=new Map(base.files.map(file=>[file.path,file]));
    const changes=[];let total=0;
    for(const path of selected){
      const beforeRead=await agent37ArtifactAdmissionFailure(c,row,allocation);
      if(beforeRead)return stopArtifactTransferForAdmissionFailure(c,transferId,beforeRead);
      const bytes=await provider.readWorkspaceFile(providerAllocationRecord,path,20*1024*1024);
      total+=bytes.byteLength;if(total>20*1024*1024)throw new Error("artifact_output_transfer_limit_exceeded");
      const priorFile=baseByPath.get(path);
      changes.push({path,expectedHash:priorFile?.sha256??null,bytes,executable:priorFile?.executable??false,contentType:priorFile?.contentType??inferAgent37ContentType(path)});
    }
    const stageId=`agent37-${transferId}`;
    const fileReceipts=[];for(const change of changes)fileReceipts.push({path:change.path,sha256:await sha256Bytes(change.bytes!),size:change.bytes!.byteLength,contentType:change.contentType,expectedHash:change.expectedHash});
    receipt={direction:"stage_output",sourceRevision:base.revision,allocationId:allocation.id,allocationGeneration:allocation.generation,imageDigest:allocation.image_digest,files:fileReceipts,stageId};
    await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_artifact_transfers SET workspace_session_id=?,workspace_fence=?,base_revision=?,stage_id=?,receipt_json=?,updated_at=? WHERE id=?`)
      .bind(base.sessionId,base.fence,base.revision,stageId,JSON.stringify(receipt),new Date().toISOString(),transferId).run();
    const beforeStage=await agent37ArtifactAdmissionFailure(c,row,allocation);
    if(beforeStage)return stopArtifactTransferForAdmissionFailure(c,transferId,beforeStage);
    const stage=await handoff.stage({sessionId:base.sessionId,revision:base.revision,fence:base.fence,allocationGeneration:allocation.generation,stageId,changes});
    receipt={...receipt,stageId:stage.stageId};
    await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_artifact_transfers SET status='staged',stage_id=?,receipt_json=?,updated_at=? WHERE id=?`)
      .bind(stage.stageId,JSON.stringify(receipt),new Date().toISOString(),transferId).run();
    let status:"staged"|"published"|"conflicted"="staged",publicationId:string|null=null;
    if(publish){
      const beforePublish=await agent37ArtifactAdmissionFailure(c,row,allocation);
      if(beforePublish)return stopArtifactTransferForAdmissionFailure(c,transferId,beforePublish);
      const shareFailure=await authorizeAgent37Request(c,row,"agent37.artifacts.read",transferId,agentPortAgentId);
      if(shareFailure){const denied=await shareFailure.clone().json().catch(()=>({})) as {error_code?:unknown};
        return stopArtifactTransferForAdmissionFailure(c,transferId,{code:typeof denied.error_code==="string"?denied.error_code:"agentport_agent37_authorization_failed",status:shareFailure.status});}
      const publication=await handoff.publish({sessionId:base.sessionId,stageId:stage.stageId,revision:base.revision,fence:base.fence,
        allocationGeneration:allocation.generation,idempotencyKey:`agent37-artifact:${transferId}`});
      status=publication.status==="conflicted"?"conflicted":"published";publicationId=publication.publicationId;
      receipt={...receipt,publicationId,status:publication.status};
      if(status==="published")await handoff.close?.({sessionId:base.sessionId,fence:base.fence,allocationGeneration:allocation.generation}).catch(()=>undefined);
    }
    await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_artifact_transfers SET status=?,workspace_session_id=?,workspace_fence=?,base_revision=?,stage_id=?,receipt_json=?,updated_at=? WHERE id=?`)
      .bind(status,base.sessionId,base.fence,base.revision,stage.stageId,JSON.stringify(receipt),new Date().toISOString(),transferId).run();
    return json({transfer:{id:transferId,status,receipt}},status==="published"?201:202);
  }catch(error){
    const code=safeProviderError(error,"artifact_transfer_outcome_unknown"),status=code.endsWith("_failed")?"failed":"indeterminate";
    await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_artifact_transfers SET status=?,error_code=?,updated_at=? WHERE id=?`)
      .bind(status,code,new Date().toISOString(),transferId).run();
    return json({transfer:{id:transferId,status,errorCode:code}},202);
  }
}

async function getAgent37ArtifactTransfer(c:Context<{Bindings:Env;Variables:Vars}>):Promise<Response>{
  const transfer=await c.env.PLATFORM_DB.prepare(`SELECT a.id,a.status,a.direction,a.receipt_json,a.error_code,a.created_at,a.updated_at FROM sandbox_artifact_transfers a
    JOIN sandbox_computers c ON c.id=a.computer_id WHERE a.id=? AND a.tenant_id=? AND a.owner_id=? AND a.computer_id=? AND c.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM workspace_erasure_tombstones t WHERE t.tenant_id=c.tenant_id AND t.space_id=c.space_id AND t.project_id=c.project_id)`)
    .bind(c.req.param("transferId"),c.get("tenantId"),c.get("userId"),c.req.param("id"))
    .first<Record<string,unknown>>();
  if(!transfer)return fail("artifact_transfer_not_found",404);
  return json({transfer:{id:transfer.id,status:transfer.status,direction:transfer.direction,receipt:transfer.receipt_json?JSON.parse(String(transfer.receipt_json)):null,
    errorCode:transfer.error_code,createdAt:transfer.created_at,updatedAt:transfer.updated_at}});
}

async function reconcileAgent37ArtifactTransfer(c:Context<{Bindings:Env;Variables:Vars}>):Promise<Response>{
  const row=await loadRuntimeRow(c,String(c.req.param("id")??""));if(row instanceof Response)return row;
  const transfer=await c.env.PLATFORM_DB.prepare(`SELECT * FROM sandbox_artifact_transfers WHERE id=? AND tenant_id=? AND owner_id=? AND computer_id=?`)
    .bind(c.req.param("transferId"),row.tenant_id,row.owner_id,row.id).first<Record<string,unknown>>();
  if(!transfer)return fail("artifact_transfer_not_found",404);
  if(["complete","published","conflicted","failed"].includes(String(transfer.status)))return json({transfer:{id:transfer.id,status:transfer.status,
    receipt:transfer.receipt_json?JSON.parse(String(transfer.receipt_json)):null,errorCode:transfer.error_code}});
  if(!["running","indeterminate"].includes(String(transfer.status)))return fail("artifact_transfer_not_reconcilable",409);
  const connectionFailure=requireConnection(row,true);if(connectionFailure)return connectionFailure;
  const constraints=templateConstraints(row);if(constraints instanceof Response)return constraints;
  const allocation=await getCurrentAllocation(c.env.PLATFORM_DB,row.id);
  if(!allocation||allocation.id!==transfer.allocation_id||allocation.generation!==transfer.allocation_generation||allocation.status!=="active"
    ||!allocation.external_id||row.state!=="running"||!allocation.image_digest||normalizeDigest(allocation.image_digest)!==normalizeDigest(String(row.template_digest)))
    return fail("artifact_transfer_allocation_changed",409);
  if(!c.env.AGENTS_WORKER)return fail("workspace_coordinator_unavailable",503);
  let request:Record<string,unknown>;
  try{request=JSON.parse(String(transfer.request_json)) as Record<string,unknown>;}catch{return fail("artifact_transfer_request_corrupt",503);}
  if(!Array.isArray(request.paths)||!request.paths.length||request.paths.length>100)return fail("artifact_transfer_request_corrupt",503);
  let paths:string[];
  try{paths=request.paths.map(path=>assertWorkspacePath(path));}catch{return fail("artifact_transfer_request_corrupt",503);}
  const agentPortFailure=await authorizeAgent37Request(c,row,String(transfer.direction)==="import"?"agent37.artifacts.write":"agent37.artifacts.read",String(transfer.id),
    typeof transfer.agentport_agent_id==="string"?transfer.agentport_agent_id:null);
  if(agentPortFailure){const denied=await agentPortFailure.clone().json().catch(()=>({})) as {error_code?:unknown};
    const code=typeof denied.error_code==="string"?denied.error_code:"agentport_agent37_authorization_failed";
    return stopArtifactTransferForAdmissionFailure(c,String(transfer.id),{code,status:agentPortFailure.status});}
  const computer=runtimeComputer(row,allocation.generation),handoff=agent37WorkspaceHandoff(c.env,computer),providerAllocationRecord=providerAllocation(allocation);
  const persist=async(status:string,patch:Record<string,unknown>={})=>{
    const fields={status,updated_at:new Date().toISOString(),...patch};
    const names=Object.keys(fields),values=Object.values(fields);
    await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_artifact_transfers SET ${names.map(name=>`${name}=?`).join(",")} WHERE id=?`)
      .bind(...values,transfer.id).run();
  };
  try{
    const provider=await createAgent37Provider(c,row,constraints);
    let receipt=transfer.receipt_json?JSON.parse(String(transfer.receipt_json)) as Record<string,unknown>:null;
    if(transfer.direction==="import"){
      const base=await handoff.readSelectedCommitted?.({tenantId:row.tenant_id,spaceId:String(row.space_id),projectId:String(row.project_id),branch:row.branch,
        allocationGeneration:allocation.generation,paths});
      if(!base)throw new Error("explicit_artifact_reader_unavailable");
      if(receipt){
        const expected=Array.isArray(receipt.files)?receipt.files as Array<Record<string,unknown>>:[];
        const actual=base.files.map(file=>({path:file.path,sha256:file.sha256,size:file.bytes.byteLength,contentType:file.contentType??inferAgent37ContentType(file.path)}));
        if(Number(receipt.sourceRevision)!==base.revision||JSON.stringify(expected.map(file=>[file.path,file.sha256,file.size,file.contentType]))!==JSON.stringify(actual.map(file=>[file.path,file.sha256,file.size,file.contentType]))){
          await persist("conflicted",{error_code:"artifact_source_revision_changed"});
          await handoff.close?.({sessionId:base.sessionId,fence:base.fence,allocationGeneration:allocation.generation}).catch(()=>undefined);
          return fail("artifact_source_revision_changed",409);
        }
      }else{
        receipt={direction:"import",sourceRevision:base.revision,allocationId:allocation.id,allocationGeneration:allocation.generation,imageDigest:allocation.image_digest,
          files:base.files.map(file=>({path:file.path,destination:`artifacts/imports/${transfer.id}/${file.path}`,sha256:file.sha256,size:file.bytes.byteLength,contentType:file.contentType??inferAgent37ContentType(file.path)}))};
        await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_artifact_transfers SET workspace_session_id=?,workspace_fence=?,base_revision=?,receipt_json=?,updated_at=? WHERE id=?`)
          .bind(base.sessionId,base.fence,base.revision,JSON.stringify(receipt),new Date().toISOString(),transfer.id).run();
      }
      if(!base.files.length)throw new Error("artifact_input_missing");
      const destinationRoot=`artifacts/imports/${transfer.id}`,directories=new Set<string>([`/home/node/workspace/${destinationRoot}`]);
      for(const file of base.files){let parent=file.path.split("/").slice(0,-1);while(parent.length){directories.add(`/home/node/workspace/${destinationRoot}/${parent.join("/")}`);parent=parent.slice(0,-1);}}
      const mkdir=await provider.invoke({executionId:`${transfer.id}-mkdir`,computer,allocation:providerAllocationRecord,command:"mkdir",args:["-p",...directories],cwd:"/home/node",timeoutMs:30_000});
      if(mkdir.status!=="succeeded")throw new Error(mkdir.status==="indeterminate"?"artifact_directory_creation_indeterminate":"artifact_directory_creation_failed");
      for(const file of base.files){
        const destination=`${destinationRoot}/${file.path}`;
        try{await provider.writeWorkspaceFile(providerAllocationRecord,destination,file.bytes,null);}
        catch{const existing=await provider.readWorkspaceFile(providerAllocationRecord,destination,file.bytes.byteLength).catch(()=>null);
          if(!existing||await sha256Bytes(existing)!==file.sha256)throw new Error("artifact_input_write_outcome_unknown");}
        const saved=await provider.readWorkspaceFile(providerAllocationRecord,destination,file.bytes.byteLength);
        if(await sha256Bytes(saved)!==file.sha256)throw new Error("artifact_input_integrity_mismatch");
      }
      await handoff.close?.({sessionId:base.sessionId,fence:base.fence,allocationGeneration:allocation.generation}).catch(()=>undefined);
      await persist("complete",{error_code:null});
      return json({transfer:{id:transfer.id,status:"complete",receipt}},200);
    }
    if(transfer.direction!=="stage_output")return fail("artifact_transfer_direction_invalid",503);
    let changes:Array<{path:string;expectedHash:string|null;bytes:Uint8Array;executable:boolean;contentType:string}>;
    if(receipt){
      if(!transfer.workspace_session_id||!transfer.stage_id||!Number.isSafeInteger(transfer.workspace_fence)||!Number.isSafeInteger(transfer.base_revision))return fail("artifact_transfer_journal_incomplete",503);
      const expected=Array.isArray(receipt.files)?receipt.files as Array<Record<string,unknown>>:[];
      if(expected.length!==paths.length)return fail("artifact_transfer_receipt_corrupt",503);
      changes=[];
      for(const path of paths){
        const file=expected.find(candidate=>candidate.path===path);if(!file||typeof file.sha256!=="string"||typeof file.contentType!=="string")return fail("artifact_transfer_receipt_corrupt",503);
        const bytes=await provider.readWorkspaceFile(providerAllocationRecord,path,20*1024*1024);
        if(await sha256Bytes(bytes)!==file.sha256){await persist("conflicted",{error_code:"artifact_output_changed_since_transfer"});return fail("artifact_output_changed_since_transfer",409);}
        changes.push({path,expectedHash:typeof file.expectedHash==="string"?file.expectedHash:null,bytes,executable:file.executable===true,contentType:file.contentType});
      }
    }else{
      const base=await handoff.readSelectedCommitted?.({tenantId:row.tenant_id,spaceId:String(row.space_id),projectId:String(row.project_id),branch:row.branch,
        allocationGeneration:allocation.generation,paths,allowMissing:true});
      if(!base)throw new Error("explicit_artifact_reader_unavailable");
      const baseByPath=new Map(base.files.map(file=>[file.path,file]));changes=[];let total=0;
      for(const path of paths){const bytes=await provider.readWorkspaceFile(providerAllocationRecord,path,20*1024*1024);total+=bytes.byteLength;
        if(total>20*1024*1024)throw new Error("artifact_output_transfer_limit_exceeded");const prior=baseByPath.get(path);
        changes.push({path,expectedHash:prior?.sha256??null,bytes,executable:prior?.executable??false,contentType:prior?.contentType??inferAgent37ContentType(path)});}
      const stageId=`agent37-${transfer.id}`;
      receipt={direction:"stage_output",sourceRevision:base.revision,allocationId:allocation.id,allocationGeneration:allocation.generation,imageDigest:allocation.image_digest,stageId,
        files:await Promise.all(changes.map(async change=>({path:change.path,sha256:await sha256Bytes(change.bytes),size:change.bytes.byteLength,
          contentType:change.contentType,expectedHash:change.expectedHash,executable:change.executable})))};
      await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_artifact_transfers SET workspace_session_id=?,workspace_fence=?,base_revision=?,stage_id=?,receipt_json=?,updated_at=? WHERE id=?`)
        .bind(base.sessionId,base.fence,base.revision,stageId,JSON.stringify(receipt),new Date().toISOString(),transfer.id).run();
    }
    const sessionId=String(transfer.workspace_session_id??"");
    const stage=await handoff.stage({sessionId,revision:Number(transfer.base_revision),fence:Number(transfer.workspace_fence),allocationGeneration:allocation.generation,
      stageId:String(transfer.stage_id),changes});
    receipt={...receipt,stageId:stage.stageId};
    if(request.publish===true){
      const publication=await handoff.publish({sessionId,stageId:stage.stageId,revision:Number(transfer.base_revision),fence:Number(transfer.workspace_fence),
        allocationGeneration:allocation.generation,idempotencyKey:`agent37-artifact:${transfer.id}`});
      const status=publication.status==="conflicted"?"conflicted":"published";
      receipt={...receipt,publicationId:publication.publicationId,status:publication.status};
      await persist(status,{receipt_json:JSON.stringify(receipt),error_code:null});
      if(status==="published")await handoff.close?.({sessionId,fence:Number(transfer.workspace_fence),allocationGeneration:allocation.generation}).catch(()=>undefined);
      return json({transfer:{id:transfer.id,status,receipt}},status==="published"?200:409);
    }
    await persist("staged",{receipt_json:JSON.stringify(receipt),error_code:null});
    return json({transfer:{id:transfer.id,status:"staged",receipt}},200);
  }catch(error){
    const code=safeProviderError(error,"artifact_transfer_outcome_unknown"),status=code.endsWith("_failed")?"failed":"indeterminate";
    await persist(status,{error_code:code});
    return json({transfer:{id:transfer.id,status,errorCode:code,reconcileUrl:`/computers/${encodeURIComponent(row.id)}/artifact-transfers/${encodeURIComponent(String(transfer.id))}/reconcile`}},202);
  }
}

async function publishAgent37ArtifactTransfer(c:Context<{Bindings:Env;Variables:Vars}>):Promise<Response>{
  const row=await loadRuntimeRow(c,String(c.req.param("id")??""));if(row instanceof Response)return row;
  const transfer=await c.env.PLATFORM_DB.prepare(`SELECT * FROM sandbox_artifact_transfers WHERE id=? AND tenant_id=? AND owner_id=? AND computer_id=?`)
    .bind(c.req.param("transferId"),row.tenant_id,row.owner_id,row.id).first<Record<string,unknown>>();
  if(!transfer)return fail("artifact_transfer_not_found",404);
  if(transfer.status==="published")return json({transfer:{id:transfer.id,status:"published",receipt:transfer.receipt_json?JSON.parse(String(transfer.receipt_json)):null}});
  if(transfer.status!=="staged"||transfer.direction!=="stage_output"||!transfer.workspace_session_id||!transfer.stage_id||!Number.isSafeInteger(transfer.workspace_fence)||!Number.isSafeInteger(transfer.base_revision))return fail("artifact_transfer_not_publishable",409);
  const allocation=await getCurrentAllocation(c.env.PLATFORM_DB,row.id);
  if(!allocation||allocation.id!==transfer.allocation_id||allocation.generation!==transfer.allocation_generation||allocation.status!=="active")return fail("artifact_transfer_allocation_changed",409);
  const shareFailure=await authorizeAgent37Request(c,row,"agent37.artifacts.read",String(transfer.id),
    typeof transfer.agentport_agent_id==="string"?transfer.agentport_agent_id:null);
  if(shareFailure)return shareFailure;
  const computer=runtimeComputer(row,allocation.generation),handoff=agent37WorkspaceHandoff(c.env,computer);
  try{
    const publication=await handoff.publish({sessionId:String(transfer.workspace_session_id),stageId:String(transfer.stage_id),revision:Number(transfer.base_revision),
      fence:Number(transfer.workspace_fence),allocationGeneration:allocation.generation,idempotencyKey:`agent37-artifact:${transfer.id}`});
    const status=publication.status==="conflicted"?"conflicted":"published",priorReceipt=transfer.receipt_json?JSON.parse(String(transfer.receipt_json)) as Record<string,unknown>:{};
    const receipt={...priorReceipt,publicationId:publication.publicationId,status:publication.status};
    await c.env.PLATFORM_DB.prepare(`UPDATE sandbox_artifact_transfers SET status=?,receipt_json=?,updated_at=? WHERE id=? AND status='staged'`)
      .bind(status,JSON.stringify(receipt),new Date().toISOString(),transfer.id).run();
    if(status==="published")await handoff.close?.({sessionId:String(transfer.workspace_session_id),fence:Number(transfer.workspace_fence),allocationGeneration:allocation.generation}).catch(()=>undefined);
    return json({transfer:{id:transfer.id,status,receipt}},status==="published"?200:409);
  }catch(error){return fail("artifact_publication_outcome_unknown",202,safeProviderError(error,"artifact_publication_outcome_unknown"));}
}

function runtimeComputer(row:RuntimeRow,generation:number):ComputerConfig{return {id:row.id,scope:{tenantId:row.tenant_id,ownerId:row.owner_id,
  ...(row.space_id?{spaceId:row.space_id}:{}),...(row.project_id?{projectId:row.project_id}:{}),branch:row.branch},templateId:row.template_id,templateVersion:row.template_version,
  ownership:"customer_owned",filesystemId:row.filesystem_id,filesystemMode:row.filesystem_mode as ComputerConfig["filesystemMode"],providerPreference:"agent37",
  state:"running",resources:JSON.parse(row.resources_json) as ComputerConfig["resources"],idleTimeoutSeconds:row.idle_timeout_seconds,allocationGeneration:generation};}

async function sha256Bytes(value:Uint8Array):Promise<string>{const digest=await crypto.subtle.digest("SHA-256",value);return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,"0")).join("");}

function normalizeDigest(value:string):string{return value.toLowerCase().replace(/^sha256:/,"");}
function validUsageDay(value:string):boolean{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const date=new Date(`${value}T00:00:00.000Z`);return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}
function usageDayDistance(from:string,to:string):number{return(Date.parse(`${to}T00:00:00.000Z`)-Date.parse(`${from}T00:00:00.000Z`))/86_400_000;}
function safeProviderError(error:unknown,fallback:string):string{
  const value=error instanceof Error?error.message:"";
  return /^[a-z][a-z0-9_:-]{1,100}$/.test(value)?value:fallback;
}
function isKnownAgent37NoEffect(code:string):boolean{return ["agent37_http_400","agent37_http_402"].includes(code);}
async function verifyOperatorSecret(expected:string|undefined,provided:string|undefined):Promise<boolean>{
  if(!expected||!provided)return false;
  const [a,b]=await Promise.all([crypto.subtle.digest("SHA-256",new TextEncoder().encode(expected)),crypto.subtle.digest("SHA-256",new TextEncoder().encode(provided))]);
  const left=new Uint8Array(a),right=new Uint8Array(b);let diff=0;for(let i=0;i<left.length;i++)diff|=left[i]!^right[i]!;return diff===0;
}
function formatComputer(
  row: Record<string, unknown>,
  tenantId: string,
  ownerId: string
) {
  return {
    id: row.id,
    scope: {
      tenantId,
      ownerId,
      ...(row.space_id ? { spaceId: row.space_id } : {}),
      ...(row.project_id ? { projectId: row.project_id } : {}),
      branch: row.branch,
    },
    templateId: row.template_id,
    templateVersion: row.template_version,
    ownership: row.ownership,
    filesystemId: row.filesystem_id,
    filesystemMode: row.filesystem_mode,
    providerPreference: row.provider_preference,
    state: row.state,
    resources: JSON.parse(String(row.resources_json)),
    idleTimeoutSeconds: row.idle_timeout_seconds,
    allocationGeneration: row.allocation_generation,
    connectionId: row.connection_id ?? null,
    activeOperationId: row.active_operation_id ?? null,
    activeOperationType: row.active_operation_type ?? null,
    activeOperationStatus: row.active_operation_status ?? null,
    agentportLinkStatus: row.agentport_link_status ?? null,
    agentportCapabilities: row.agentport_capabilities_json ? JSON.parse(String(row.agentport_capabilities_json)) : [],
  };
}
export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runProviderDeletionReconciliation(env).then(async result => {
      if (result.indeterminate || result.retained) console.warn("sandbox_provider_deletion_reconciliation_attention", {
        indeterminate: result.indeterminate, retained: result.retained,
      });
      const allocations = await runSandboxAllocationReconciliation(env);
      if (allocations.indeterminate) console.warn("sandbox_allocation_reconciliation_attention", {
        indeterminate: allocations.indeterminate,
      });
    }).then(() => collectSandboxOpsMetrics(env)).then(snapshot => {
      for (const alert of sandboxOpsAlerts(snapshot)) console.warn("sandbox_ops_alert", alert);
    }).catch(() => {
      // Do not log provider response bodies, credentials, allocation IDs, or customer scope.
      console.error("sandbox_provider_deletion_reconciliation_failed");
    }));
  },
};
