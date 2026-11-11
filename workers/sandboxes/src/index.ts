import { mintInternalToken, readBoundedRequestText, RequestBodyTooLargeError, verifyInternalToken } from "@naelao/http";
import {
  type ComputerScope,
  type ComputerState,
  type OwnershipMode,
  type ProviderKind,
  estimateAgent37Monthly,
  validateComputerScope,
  validateResourceShape,
} from "@naelao/sandboxes-core";
import { Hono } from "hono";
import { sealConnection } from "./connection-crypto.js";
import { queueSandboxComputerDeletion, recordManualProviderDeletionEvidence, runProviderDeletionReconciliation, runSandboxAllocationReconciliation } from "./provider-deletion-reconciliation.js";
import { collectSandboxOpsMetrics, sandboxOpsAlerts } from "./ops-metrics.js";
import { recordSandboxBillingReconciliation, type SandboxBillingProvider } from "./billing-reconciliation.js";

interface Env {
  PLATFORM_DB: D1Database;
  PLATFORM_SECRET: string;
  DATA_JURISDICTION?: "eu";
  AGENTS_WORKER?: Fetcher;
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
app.get("/providers", (_c) =>
  json({
    providers: [
      {
        id: "agent37",
        status: "unavailable",
        reason:
          "provider credentials and runtime acceptance are not configured",
      },
      {
        id: "opensandbox",
        status: "unavailable",
        reason: "customer or managed OpenSandbox endpoint is not configured",
      },
      {
        id: "cloudflare",
        status: "unavailable",
        reason: "cross-worker allocation bridge is not configured",
      },
    ],
    autoSchedulingEnabled: false,
  })
);
app.get("/templates", (_c) =>
  json({
    templates: [
      {
        id: "node",
        version: "1",
        digest: null,
        capabilities: ["exec", "files"],
        verified: false,
        availability: "configuration_only",
      },
      {
        id: "browser-desktop",
        version: "1",
        digest: null,
        capabilities: [
          "exec",
          "files",
          "browser",
          "desktop.screenshot",
          "desktop.control",
        ],
        verified: false,
        availability: "configuration_only",
      },
      {
        id: "desktop",
        version: "1",
        digest: null,
        capabilities: [
          "exec",
          "files",
          "desktop.screenshot",
          "desktop.control",
          "desktop.stream",
        ],
        verified: false,
        availability: "configuration_only",
      },
    ],
  })
);
app.get("/connections", async (c) => {
  const rows = await c.env.PLATFORM_DB.prepare(
    "SELECT id,provider,ownership,status,region,capabilities_json,last_verified_at,created_at,updated_at FROM sandbox_connections WHERE tenant_id=? AND owner_id=? AND status!='revoked' ORDER BY created_at DESC"
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  });
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
  const result = await c.env.PLATFORM_DB.prepare(
    "UPDATE sandbox_connections SET status='revoked',credential_ciphertext=NULL,credential_iv=NULL,updated_at=? WHERE id=? AND tenant_id=? AND owner_id=? AND status!='revoked'"
  )
    .bind(
      new Date().toISOString(),
      c.req.param("id"),
      c.get("tenantId"),
      c.get("userId")
    )
    .run();
  return result.meta.changes
    ? json({ revoked: true })
    : fail("connection_not_found", 404);
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
    ownership: "naelao_managed" as OwnershipMode,
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
    providerStatus: "unavailable",
    message:
      "Configuration is stored. Runtime allocation remains disabled until a verified provider connection and runtime acceptance are available.",
  };
  const statements = [
    c.env.PLATFORM_DB.prepare(
      "INSERT INTO sandbox_computers (id,tenant_id,owner_id,space_id,project_id,branch,template_id,template_version,ownership,filesystem_id,filesystem_mode,provider_preference,state,resources_json,idle_timeout_seconds,allocation_generation,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
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
      now
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
    `SELECT id,space_id,project_id,branch,template_id,template_version,ownership,filesystem_id,filesystem_mode,provider_preference,state,resources_json,idle_timeout_seconds,allocation_generation
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
    `SELECT * FROM sandbox_computers c WHERE id=? AND tenant_id=? AND owner_id=? AND deleted_at IS NULL
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

for (const action of ["start", "sleep"] as const)
  app.post(`/computers/:id/${action}`, async (c) => {
    const row = await c.env.PLATFORM_DB.prepare(
      `SELECT id,state FROM sandbox_computers c WHERE id=? AND tenant_id=? AND owner_id=? AND deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM workspace_erasure_tombstones t WHERE t.tenant_id=c.tenant_id AND t.space_id=c.space_id AND t.project_id=c.project_id)`
    )
      .bind(c.req.param("id"), c.get("tenantId"), c.get("userId"))
      .first<{ id: string; state: string }>();
    if (!row) return fail("computer_not_found", 404);
    return fail(
      "provider_unavailable",
      503,
      `Cannot ${action} computer: no provider connection has passed live verification.`
    );
  });
app.post("/computers/:id/executions", async (c) => {
  const row = await c.env.PLATFORM_DB.prepare(
    `SELECT id FROM sandbox_computers c WHERE id=? AND tenant_id=? AND owner_id=? AND deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM workspace_erasure_tombstones t WHERE t.tenant_id=c.tenant_id AND t.space_id=c.space_id AND t.project_id=c.project_id)`
  )
    .bind(c.req.param("id"), c.get("tenantId"), c.get("userId"))
    .first();
  return row
    ? fail(
        "provider_unavailable",
        503,
        "Execution is unavailable until a provider runtime passes acceptance checks."
      )
    : fail("computer_not_found", 404);
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
  const computerId = c.req.param("id");
  const row = await c.env.PLATFORM_DB.prepare(
    `SELECT id FROM sandbox_computers c WHERE id=? AND tenant_id=? AND owner_id=? AND deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM workspace_erasure_tombstones t WHERE t.tenant_id=c.tenant_id AND t.space_id=c.space_id AND t.project_id=c.project_id)`,
  ).bind(computerId, c.get("tenantId"), c.get("userId")).first();
  if (!row) return fail("computer_not_found", 404);
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
