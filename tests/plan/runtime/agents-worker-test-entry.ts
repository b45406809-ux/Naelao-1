import { getDOName } from "@naelao/crypto";
import { mintInternalToken } from "@naelao/http";
import { sweepBlackboardWakes } from "../../../workers/agents/src/communications/blackboard-wake.js";
import {
  ConcurrencyDO,
  NaelaoAgentDO,
  wakeAgentGoal,
} from "../../../workers/agents/src/index.js";
import agentsWorker from "../../../workers/agents/src/index.js";
import { writeAgentConfig } from "../../../workers/agents/src/script-engine/agent-config.js";
import { runScriptLoop, type Reasoner } from "../../../workers/agents/src/script-engine/loop.js";
import { ScriptToolSurface } from "../../../workers/agents/src/script-engine/tool-surface.js";
import { issueDelegationContract } from "../../../workers/agents/src/script-engine/delegation-contract.js";
import type { DelegationContract } from "../../../workers/agents/src/script-engine/delegation-contract.js";
import { spaceBlackboard } from "../../../workers/agents/src/script-engine/prebuilt/space-blackboard.js";
import { DEFAULT_NAELAO_AGENT } from "../../../workers/agents/src/script-engine/profiles.js";

export { NaelaoAgentDO, ConcurrencyDO };

const TEST_TENANT_ID = "tenant-blackboard-runtime-test";
const TEST_SPACE_ID = "space-blackboard-runtime-test";
const TEST_USER_ID = "owner-blackboard-runtime-test";
const TEST_VIEWER_ID = "viewer-blackboard-runtime-test";

async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Test-only control routes wrap the production Agents Worker in the isolated test runtime. */
export default {
  async fetch(
    request: Request,
    env: Record<string, unknown>,
    ctx: ExecutionContext
  ) {
    const url = new URL(request.url);
    // Wrangler's readiness probe must not fall through the production router: this fixture's
    // goal is to test the real runtime only after bootstrapping, while module cold-start can be
    // expensive in the four-worker local topology.
    if (url.pathname === "/__runtime_ready") return Response.json({ ok: true });
    if (url.pathname === "/__test/blackboard/search-all" && request.method === "POST") {
      const body = await request.json<{ query?: string; projectId?: string; maxPages?: number }>().catch(() => ({}));
      if (typeof body.query !== "string" || !body.query || typeof body.projectId !== "string")
        return Response.json({ error: "query_and_projectId_required" }, { status: 400 });
      const maxPages = typeof body.maxPages === "number" && Number.isInteger(body.maxPages)
        ? Math.min(200, Math.max(1, body.maxPages))
        : 200;
      const context = {
        env: {
          tenantId: TEST_TENANT_ID, spaceId: TEST_SPACE_ID, projectId: body.projectId,
          userId: TEST_USER_ID, platformSecret: String(env.PLATFORM_SECRET), spacesWorker: env.SPACES_WORKER as Fetcher,
        },
        run: async () => { throw new Error("unexpected_prebuilt_dispatch"); },
      } as unknown as import("../../../workers/agents/src/script-engine/prebuilt/index.js").PrebuiltOpContext;
      const operation = spaceBlackboard.operations["blackboard.search"];
      const started = performance.now();
      const pageLatencies: number[] = [];
      const cursors = new Set<string>();
      let after: string | undefined;
      let pages = 0;
      let found = false;
      let truncated = false;
      while (pages < maxPages) {
        const pageStarted = performance.now();
        const result = await operation({ query: body.query, max_pages: 1, ...(after ? { after } : {}) }, context) as {
          candidates?: Array<{ card?: { projectId?: string } }>;
          next_cursor?: string | null;
          truncated?: boolean;
        };
        pageLatencies.push(Math.round(performance.now() - pageStarted));
        pages++;
        found ||= (result.candidates ?? []).some(candidate => candidate.card?.projectId === body.projectId);
        truncated = result.truncated === true;
        const next = result.next_cursor ?? null;
        if (!next) break;
        if (cursors.has(next)) return Response.json({ error: "cursor_cycle", pages, next_cursor: next }, { status: 500 });
        cursors.add(next);
        after = next;
      }
      return Response.json({ found, pages, truncated, elapsed_ms: Math.round(performance.now() - started), page_latencies_ms: pageLatencies });
    }
    if (url.pathname === "/__test/blackboard/assistant-search" && request.method === "POST") {
      const body = await request.json<{ query?: string; projectId?: string; maxSteps?: number }>().catch(() => ({}));
      if (typeof body.query !== "string" || !body.query || typeof body.projectId !== "string")
        return Response.json({ error: "query_and_projectId_required" }, { status: 400 });
      const started = performance.now();
      const engineEnv = {
        scriptsBucket: env.SCRIPTS_R2,
        tenantId: TEST_TENANT_ID,
        spaceId: TEST_SPACE_ID,
        projectId: "assistant-search-test-project",
        agentId: "naelao-agent",
        userId: TEST_USER_ID,
        platformSecret: String(env.PLATFORM_SECRET),
        spacesWorker: env.SPACES_WORKER as Fetcher,
      } as never;
      const tools = new ScriptToolSurface(engineEnv, ["space-blackboard"], { role: "DEV_OPERATOR" });
      const reasoner: Reasoner = {
        async decide(input) {
          const prior = input.priorSteps?.filter(step => step.name === "blackboard.search") ?? [];
          const last = prior.at(-1)?.output as { candidates?: Array<{ card?: { projectId?: string } }>; next_cursor?: string | null; truncated?: boolean } | undefined;
          if (last?.candidates?.some(candidate => candidate.card?.projectId === body.projectId))
            return { action: "answer", text: `Found target card ${body.projectId} after ${prior.length} search call(s).` };
          if (last?.truncated === false || !last?.next_cursor && prior.length > 0)
            return { action: "answer", text: `Target card ${body.projectId} was not found after ${prior.length} search call(s).` };
          return { action: "run", name: "blackboard.search", params: {
            query: body.query,
            ...(last?.next_cursor ? { after: last.next_cursor } : {}),
          } };
        },
      };
      const result = await runScriptLoop(engineEnv, tools, reasoner, ["space-blackboard"], {
        goal: `Find the visible shared project card matching ${body.query}`,
        startupObserve: "observe_filesystem",
        maxSteps: body.maxSteps ?? 50,
      });
      const searchSteps = result.steps_completed?.filter(step => step.name === "blackboard.search") ?? [];
      const found = searchSteps.some(step => {
        const output = step.output as { candidates?: Array<{ card?: { projectId?: string } }> } | undefined;
        return output?.candidates?.some(candidate => candidate.card?.projectId === body.projectId) === true;
      });
      const pagesScanned = searchSteps.reduce((sum, step) => sum + Number((step.output as { pages_scanned?: number } | undefined)?.pages_scanned ?? 0), 0);
      return Response.json({ found, pages_scanned: pagesScanned, search_calls: searchSteps.length,
        loop_steps: result.trace.length, result_ok: result.result?.ok === true,
        elapsed_ms: Math.round(performance.now() - started), trace: result.trace.map(step => ({ phase: step.phase, name: step.name, ok: step.ok })) });
    }
    if (url.pathname === "/__test/pause-goal-dispatch" && request.method === "POST") {
      const body = await request.json<{ pause?: boolean }>().catch(() => ({}));
      const doName = await getDOName("agent", `${TEST_SPACE_ID}:naelao-agent`, TEST_TENANT_ID, String(env.PLATFORM_SECRET));
      const namespace = env.NAELAO_AGENT_DO as DurableObjectNamespace;
      const stub = namespace.get(namespace.idFromName(doName));
      return stub.fetch(new Request("http://agent-do/internal/test/goal-dispatch-pause", {
        method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": TEST_TENANT_ID, "x-naelao-internal-token": await mintInternalToken(String(env.PLATFORM_SECRET), TEST_TENANT_ID) },
        body: JSON.stringify({ pause: body.pause === true }),
      }));
    }
    if (url.pathname === "/__test/task-blackboard/publish" && request.method === "POST") {
      const body = await request.json<{ goalId?: string; runId?: string; projectId?: string; senderTaskId?: string; recipientTaskId?: string }>().catch(() => ({}));
      if (!/^[a-f0-9]{64}$/.test(body.goalId ?? "") || !body.runId || !body.projectId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(body.senderTaskId ?? "") || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(body.recipientTaskId ?? "")) return Response.json({ error: "invalid_test_message_scope" }, { status: 400 });
      const doName = await getDOName("agent", `${TEST_SPACE_ID}:naelao-agent`, TEST_TENANT_ID, String(env.PLATFORM_SECRET));
      const namespace = env.NAELAO_AGENT_DO as DurableObjectNamespace;
      const stub = namespace.get(namespace.idFromName(doName));
      const workerId = `${body.goalId}:${body.senderTaskId}`;
      const contract: DelegationContract = {
        tenantId: TEST_TENANT_ID, spaceId: TEST_SPACE_ID, projectId: body.projectId, actorId: TEST_USER_ID,
        agentId: "naelao-agent", rootRunId: body.runId, parentRunId: body.runId, parentDoId: stub.id.toString(), workerId,
        depth: 2, planner: false, maxTokens: 1000, maxSteps: 10, model: "test-model", role: "worker", callerRole: "owner", maxTier: 2, localOnly: false,
      };
      const token = await issueDelegationContract(contract, String(env.PLATFORM_SECRET));
      const response = await stub.fetch(new Request("http://agent-do/internal/task-blackboard", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ contract, token, action: "publish", input: { id: "restart-persistence-check", recipients: [`${body.goalId}:${body.recipientTaskId}`], kind: "finding", text: "Persisted worker handoff for the restart acceptance." } }),
      }));
      return Response.json({ status: response.status, body: await response.json().catch(() => null) }, { status: response.status });
    }
    if (url.pathname === "/__test/task-blackboard/read" && request.method === "POST") {
      const body = await request.json<{ goalId?: string; runId?: string; projectId?: string; senderTaskId?: string; recipientTaskId?: string }>().catch(() => ({}));
      if (!/^[a-f0-9]{64}$/.test(body.goalId ?? "") || !body.runId || !body.projectId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(body.senderTaskId ?? "") || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(body.recipientTaskId ?? "")) return Response.json({ error: "invalid_test_message_scope" }, { status: 400 });
      const doName = await getDOName("agent", `${TEST_SPACE_ID}:naelao-agent`, TEST_TENANT_ID, String(env.PLATFORM_SECRET));
      const namespace = env.NAELAO_AGENT_DO as DurableObjectNamespace;
      const stub = namespace.get(namespace.idFromName(doName));
      const contract: DelegationContract = {
        tenantId: TEST_TENANT_ID, spaceId: TEST_SPACE_ID, projectId: body.projectId, actorId: TEST_USER_ID,
        agentId: "naelao-agent", rootRunId: body.runId, parentRunId: body.runId, parentDoId: stub.id.toString(), workerId: `${body.goalId}:${body.recipientTaskId}`,
        depth: 2, planner: false, maxTokens: 1000, maxSteps: 10, model: "test-model", role: "worker", callerRole: "owner", maxTier: 2, localOnly: false,
      };
      const token = await issueDelegationContract(contract, String(env.PLATFORM_SECRET));
      const response = await stub.fetch(new Request("http://agent-do/internal/task-blackboard", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contract, token, action: "read" }),
      }));
      return Response.json(await response.json().catch(() => null), { status: response.status });
    }
    if (url.pathname === "/__test/goal-activity" && request.method === "GET") {
      const runId = url.searchParams.get("run_id");
      if (!runId || runId.length > 256) return Response.json({ error: "run_id_required" }, { status: 400 });
      const doName = await getDOName("agent", `${TEST_SPACE_ID}:naelao-agent`, TEST_TENANT_ID, String(env.PLATFORM_SECRET));
      const namespace = env.NAELAO_AGENT_DO as DurableObjectNamespace;
      const stub = namespace.get(namespace.idFromName(doName));
      return stub.fetch(new Request(`http://agent-do/internal/goal-activity?run_id=${encodeURIComponent(runId)}&space_id=${encodeURIComponent(TEST_SPACE_ID)}`, {
        headers: {
          "x-naelao-tenant-id": TEST_TENANT_ID,
          "x-naelao-user-id": TEST_USER_ID,
          "x-naelao-internal-token": await mintInternalToken(String(env.PLATFORM_SECRET), TEST_TENANT_ID),
        },
      }));
    }
    if (url.pathname === "/__test/agent-activity" && request.method === "GET") {
      const rootRunId = url.searchParams.get("root_run_id");
      if (!rootRunId || rootRunId.length > 256) return Response.json({ error: "root_run_id_required" }, { status: 400 });
      const spacesService = env.SPACES_WORKER as Fetcher | undefined;
      if (!spacesService) return Response.json({ error: "spaces_worker_unavailable" }, { status: 503 });
      const token = await mintInternalToken(String(env.PLATFORM_SECRET), TEST_TENANT_ID);
      return spacesService.fetch(new Request(
        `http://spaces/spaces/${encodeURIComponent(TEST_SPACE_ID)}/agent-activity?root_run_id=${encodeURIComponent(rootRunId)}&limit=200`,
        { headers: { "x-naelao-tenant-id": TEST_TENANT_ID, "x-naelao-internal-token": token } },
      ));
    }
    if (url.pathname === "/__test/active-run" && request.method === "GET") {
      const doName = await getDOName("agent", `${TEST_SPACE_ID}:naelao-agent`, TEST_TENANT_ID, String(env.PLATFORM_SECRET));
      const namespace = env.NAELAO_AGENT_DO as DurableObjectNamespace;
      const stub = namespace.get(namespace.idFromName(doName));
      return stub.fetch(new Request("http://agent-do/active-run", {
        headers: {
          "x-naelao-tenant-id": TEST_TENANT_ID,
          "x-naelao-internal-token": await mintInternalToken(String(env.PLATFORM_SECRET), TEST_TENANT_ID),
        },
      }));
    }
    if (url.pathname === "/__test/bootstrap" && request.method === "POST") {
      const db = env.PLATFORM_DB as D1Database;
      const bootstrapOptions = await request.json<{ includeTenantIsolation?: boolean }>().catch(() => ({}));
      await db.batch([
        db
          .prepare(
            "INSERT OR REPLACE INTO orgs(id,name,owner_id,status) VALUES(?,?,?,'active')"
          )
          .bind(TEST_TENANT_ID, "Blackboard Runtime Test", TEST_USER_ID),
        db
          .prepare(
            "INSERT OR REPLACE INTO spaces(id,tenant_id,spacetype_id,name,status,config_json) VALUES(?,?,? ,?,'active','{\"compliance\":{\"airGappedOnly\":true}}')"
          )
          .bind(
            TEST_SPACE_ID,
            TEST_TENANT_ID,
            "launchpad",
            "Blackboard Runtime Test Space"
          ),
        db
          .prepare(
            "INSERT OR REPLACE INTO space_members(id,space_id,tenant_id,end_user_id,role) VALUES(?,?,?,?, 'owner')"
          )
          .bind(
            "member-blackboard-runtime-test",
            TEST_SPACE_ID,
            TEST_TENANT_ID,
            TEST_USER_ID
          ),
        db
          .prepare(
            "INSERT OR REPLACE INTO space_members(id,space_id,tenant_id,end_user_id,role) VALUES(?,?,?,?, 'viewer')"
          )
          .bind(
            "viewer-blackboard-runtime-test",
            TEST_SPACE_ID,
            TEST_TENANT_ID,
            TEST_VIEWER_ID
          ),
      ]);

      let foreignTenant: { tenantId: string; spaceId: string; userId: string; token: string } | undefined;
      let sameTenantUnjoinedSpaceId: string | undefined;
      if (bootstrapOptions.includeTenantIsolation === true) {
        const foreignTenantId = "tenant-blackboard-runtime-foreign";
        const foreignSpaceId = "space-blackboard-runtime-foreign";
        const foreignUserId = "owner-blackboard-runtime-foreign";
        sameTenantUnjoinedSpaceId = "space-blackboard-runtime-unjoined";
        await db.batch([
          db.prepare("INSERT OR REPLACE INTO orgs(id,name,owner_id,status) VALUES(?,?,?,'active')")
            .bind(foreignTenantId, "Foreign Tenant Runtime Fixture", foreignUserId),
          db.prepare("INSERT OR REPLACE INTO spaces(id,tenant_id,spacetype_id,name,status,config_json) VALUES(?,?,? ,?,'active','{}')")
            .bind(foreignSpaceId, foreignTenantId, "launchpad", "Foreign Tenant Runtime Space"),
          db.prepare("INSERT OR REPLACE INTO space_members(id,space_id,tenant_id,end_user_id,role) VALUES(?,?,?,?, 'owner')")
            .bind("member-blackboard-runtime-foreign", foreignSpaceId, foreignTenantId, foreignUserId),
          db.prepare("INSERT OR REPLACE INTO spaces(id,tenant_id,spacetype_id,name,status,config_json) VALUES(?,?,? ,?,'active','{}')")
            .bind(sameTenantUnjoinedSpaceId, TEST_TENANT_ID, "launchpad", "Unjoined Same Tenant Runtime Space"),
        ]);
        foreignTenant = {
          tenantId: foreignTenantId,
          spaceId: foreignSpaceId,
          userId: foreignUserId,
          token: await mintInternalToken(String(env.PLATFORM_SECRET), foreignTenantId),
        };
      }

      return Response.json({
        tenantId: TEST_TENANT_ID,
        spaceId: TEST_SPACE_ID,
        userId: TEST_USER_ID,
        viewerId: TEST_VIEWER_ID,
        ...(foreignTenant ? { foreignTenant } : {}),
        ...(sameTenantUnjoinedSpaceId ? { sameTenantUnjoinedSpaceId } : {}),
        token: await mintInternalToken(
          String(env.PLATFORM_SECRET),
          TEST_TENANT_ID
        ),
      });
    }

    if (url.pathname === "/__test/revoke-owner-membership" && request.method === "POST") {
      const db = env.PLATFORM_DB as D1Database;
      const result = await db.prepare(
        "DELETE FROM space_members WHERE space_id=? AND tenant_id=? AND end_user_id=?"
      ).bind(TEST_SPACE_ID, TEST_TENANT_ID, TEST_USER_ID).run();
      return Response.json({ changes: result.meta.changes ?? 0 });
    }

    if (url.pathname === "/__test/space-assistant-goal" && request.method === "POST") {
      const db = env.PLATFORM_DB as D1Database;
      const spacesService = env.SPACES_WORKER as Fetcher;
      const internalHeaders = {
        "content-type": "application/json",
        "x-naelao-tenant-id": TEST_TENANT_ID,
        "x-naelao-user-id": TEST_USER_ID,
        "x-naelao-role": "product_end_user",
        "x-naelao-internal-token": await mintInternalToken(String(env.PLATFORM_SECRET), TEST_TENANT_ID),
      };
      const callSpaces = async (path: string, method: string, body?: unknown) => spacesService.fetch(new Request(`http://spaces${path}`, {
        method, headers: internalHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
      const member = await callSpaces(`/spaces/${TEST_SPACE_ID}/members`, "POST", { space_id: TEST_SPACE_ID, user_id: TEST_USER_ID, role: "owner" });
      if (!member.ok) return new Response(member.body, { status: member.status });
      await db.prepare("UPDATE spaces SET config_json=? WHERE id=?")
        .bind(JSON.stringify({ compliance: { airGappedOnly: false } }), TEST_SPACE_ID).run();
      await db.prepare("UPDATE orgs SET plan_tier='growth' WHERE id=?").bind(TEST_TENANT_ID).run();
      const policy = await callSpaces(`/spaces/${TEST_SPACE_ID}/agents/naelao-agent/policy`, "PATCH", { approval_mode: "yolo", auto_approved_actions: [] });
      if (!policy.ok) return new Response(policy.body, { status: policy.status });
      const assistantPolicy = await callSpaces(`/spaces/${TEST_SPACE_ID}/assistant-policy`, "PATCH", { approval_mode: "yolo", auto_approved_actions: [] });
      if (!assistantPolicy.ok) return new Response(assistantPolicy.body, { status: assistantPolicy.status });
      if (!env.SCRIPTS_R2) return Response.json({ error: "test_agent_config_storage_unavailable" }, { status: 503 });
      await writeAgentConfig(env.SCRIPTS_R2 as R2Bucket, TEST_SPACE_ID, "naelao-agent", DEFAULT_NAELAO_AGENT.config);
      const modelGateway = env.MODEL_GATEWAY as Fetcher | undefined;
      if (!modelGateway) return Response.json({ error: "test_model_gateway_unavailable" }, { status: 503 });
      const configure = await modelGateway.fetch(new Request("http://model/__test/configure", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ leafWorkerMode: true, dependentTaskMode: false, spaceAssistantMode: true, decisionOutcome: "passed", resetDecisionTelemetry: true }),
      }));
      if (!configure.ok) return Response.json({ error: "test_model_gateway_unavailable" }, { status: 503 });

      const runId = `space-assistant-runtime:${crypto.randomUUID()}`;
      const response = await wakeAgentGoal(env as never, {
        tenantId: TEST_TENANT_ID,
        spaceId: TEST_SPACE_ID,
        userId: TEST_USER_ID,
        runId,
        goal: "Create and verify the bounded Space Assistant runtime artifact using its assigned worker. Do not use external services.",
      });
      const dispatch = await response.clone().json().catch(() => null);
      const activity = await (env.NAELAO_AGENT_DO as DurableObjectNamespace).get((env.NAELAO_AGENT_DO as DurableObjectNamespace).idFromName(
        await getDOName("agent", `${TEST_SPACE_ID}:naelao-agent`, TEST_TENANT_ID, String(env.PLATFORM_SECRET))
      )).fetch(new Request(`http://agent-do/internal/goal-activity?run_id=${encodeURIComponent(runId)}&space_id=${encodeURIComponent(TEST_SPACE_ID)}`, {
        headers: {
          "x-naelao-tenant-id": TEST_TENANT_ID,
          "x-naelao-user-id": TEST_USER_ID,
          "x-naelao-internal-token": await mintInternalToken(String(env.PLATFORM_SECRET), TEST_TENANT_ID),
        },
      }));
      const scripts = env.SCRIPTS_R2 as R2Bucket;
      const artifact = await scripts.get(`spaces/${TEST_SPACE_ID}/workspace/reports/blackboard-worker-smoke.txt`);
      const artifactText = artifact ? await artifact.text() : null;
      const gatewayMetrics = await modelGateway.fetch(new Request("http://model/__test/metrics"));
      return Response.json({
        status: response.status,
        dispatch,
        runId,
        goalActivityStatus: activity.status,
        goalActivity: activity.ok ? await activity.json() : undefined,
        artifact: artifactText,
        gateway: await gatewayMetrics.json(),
      });
    }

    if (url.pathname === "/__test/wake" && request.method === "POST") {
      const {
        projectId,
        revokeAuthority = false,
        simulateBusyFirst = false,
        expireLease = false,
        concurrentSweepCount = 0,
        mockModelRun = false,
      } = (await request.json()) as {
        projectId: string;
        revokeAuthority?: boolean;
        simulateBusyFirst?: boolean;
        expireLease?: boolean;
        concurrentSweepCount?: number;
        mockModelRun?: boolean;
      };
      if (!projectId)
        return Response.json({ error: "projectId required" }, { status: 400 });
      const db = env.PLATFORM_DB as D1Database;
      const spacesService = env.SPACES_WORKER as Fetcher;
      const internalHeaders = {
        "content-type": "application/json",
        "x-naelao-tenant-id": TEST_TENANT_ID,
        "x-naelao-user-id": TEST_USER_ID,
        "x-naelao-role": "product_end_user",
        "x-naelao-internal-token": await mintInternalToken(
          String(env.PLATFORM_SECRET),
          TEST_TENANT_ID
        ),
      };
      const callSpaces = async (path: string, method: string, body?: unknown) =>
        spacesService.fetch(
          new Request(`http://spaces${path}`, {
            method,
            headers: internalHeaders,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          })
        );
      // The host wake identity is also the SpaceDO publication actor. Platform membership
      // authorizes the wake, while the SpaceDO roster independently authorizes artifact
      // publication. Provision both through their production routes in this fixture.
      const spaceMemberResponse = await callSpaces(
        `/spaces/${TEST_SPACE_ID}/members`,
        "POST",
        { space_id: TEST_SPACE_ID, user_id: TEST_USER_ID, role: "owner" }
      );
      if (!spaceMemberResponse.ok)
        return new Response(spaceMemberResponse.body, {
          status: spaceMemberResponse.status,
        });
      const sourceProjectResponse = await callSpaces(
        `/spaces/${TEST_SPACE_ID}/projects`,
        "POST",
        { name: "Blackboard Source Project" }
      );
      if (!sourceProjectResponse.ok)
        return new Response(sourceProjectResponse.body, {
          status: sourceProjectResponse.status,
        });
      const sourceProject = (await sourceProjectResponse.json()) as {
        id: string;
      };
      for (const cardProjectId of [sourceProject.id, projectId]) {
        const cardResponse = await callSpaces(
          `/internal/spaces/${TEST_SPACE_ID}/blackboard/cards/${encodeURIComponent(cardProjectId)}`,
          "PUT",
          {
            summary: `Runtime test card for ${cardProjectId}`,
            capabilities: ["workspace.read"],
            evidence: ["synthetic local fixture"],
          }
        );
        if (!cardResponse.ok)
          return new Response(cardResponse.body, {
            status: cardResponse.status,
          });
      }
      const policyResponse = await callSpaces(
        `/internal/spaces/${TEST_SPACE_ID}/blackboard/policy/${encodeURIComponent(projectId)}`,
        "PUT",
        { wake_enabled: true }
      );
      if (!policyResponse.ok)
        return new Response(policyResponse.body, {
          status: policyResponse.status,
        });
      const requestId = `runtime-e2e:${projectId}`;
      const requestBody = {
        id: requestId,
        source_project_id: sourceProject.id,
        target_project_id: projectId,
        objective: "Review the synthetic runtime acceptance request",
        expected_result:
          "Report the project scope and stop before provider use",
      };
      const requestPath = `/internal/spaces/${TEST_SPACE_ID}/blackboard/requests`;
      const requestResponse = await callSpaces(
        requestPath,
        "POST",
        requestBody
      );
      if (!requestResponse.ok)
        return new Response(requestResponse.body, {
          status: requestResponse.status,
        });
      const duplicateRequestResponse = await callSpaces(
        requestPath,
        "POST",
        requestBody
      );
      if (!duplicateRequestResponse.ok)
        return new Response(duplicateRequestResponse.body, {
          status: duplicateRequestResponse.status,
        });
      const conflictingRequestResponse = await callSpaces(requestPath, "POST", {
        ...requestBody,
        objective: "A conflicting reuse of the same request ID",
      });
      const requestCounts = await db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM space_blackboard_requests WHERE tenant_id=? AND space_id=? AND id=?) AS requests,
             (SELECT COUNT(*) FROM space_blackboard_events WHERE tenant_id=? AND space_id=? AND request_id=?) AS events`
        )
        .bind(
          TEST_TENANT_ID,
          TEST_SPACE_ID,
          requestId,
          TEST_TENANT_ID,
          TEST_SPACE_ID,
          requestId
        )
        .first<{ requests: number; events: number }>();

      if (revokeAuthority) {
        await db
          .prepare(
            "DELETE FROM space_members WHERE tenant_id=? AND space_id=? AND end_user_id=?"
          )
          .bind(TEST_TENANT_ID, TEST_SPACE_ID, TEST_USER_ID)
          .run();
      }

      const agentEnv = env as never;
      const dispatchResponses: Array<{ status: number; body: unknown }> = [];
      const dispatch = async (input: Parameters<typeof wakeAgentGoal>[1]) => {
        const response = await wakeAgentGoal(agentEnv, input);
        const body = await response.clone().json().catch(() => null);
        dispatchResponses.push({ status: response.status, body });
        return response;
      };
      let concurrentSweeps: Array<{ checked: number }> = [];
      let busySweep: { checked: number } | undefined;
      let busyResponse: { status: number; body: unknown } | undefined;
      const eventId = `${requestId}:pending`;
      if (mockModelRun) {
        // Test-only opt-in to the deterministic local model endpoint. Normal acceptance stays
        // air-gapped and can never contact a model provider. This fixture models an owner who
        // explicitly opted the Project Assistant into autonomous execution for the test.
        await db.prepare("UPDATE spaces SET config_json=? WHERE id=?")
          .bind(JSON.stringify({ compliance: { airGappedOnly: false } }), TEST_SPACE_ID).run();
        // This integrated path exercises a multi-turn leaf worker. Give the synthetic tenant an
        // explicit paid-tier allowance so the host wake path must propagate the D1 entitlement,
        // rather than relying on an oversized task request or a test-only budget override.
        await db.prepare("UPDATE orgs SET plan_tier='growth' WHERE id=?").bind(TEST_TENANT_ID).run();
        const policy = await callSpaces(
          `/spaces/${TEST_SPACE_ID}/agents/naelao-agent/policy`,
          "PATCH",
          { approval_mode: "yolo", auto_approved_actions: [] }
        );
        if (!policy.ok) return new Response(policy.body, { status: policy.status });
        if (!env.SCRIPTS_R2) return Response.json({ error: "test_agent_config_storage_unavailable" }, { status: 503 });
        await writeAgentConfig(env.SCRIPTS_R2 as R2Bucket, TEST_SPACE_ID, "naelao-agent", DEFAULT_NAELAO_AGENT.config);
      }
      if (expireLease) {
        const now = Math.floor(Date.now() / 1000);
        await db
          .prepare(
            "INSERT INTO space_blackboard_wakes(tenant_id,space_id,project_id,event_id,status,attempts,next_at,lease_until,updated_at) VALUES(?,?,?,?,'running',1,?,?,?)"
          )
          .bind(
            TEST_TENANT_ID,
            TEST_SPACE_ID,
            projectId,
            eventId,
            now,
            now - 1,
            now - 901
          )
          .run();
      }
      if (simulateBusyFirst) {
        busySweep = await sweepBlackboardWakes(
          agentEnv,
          async () => {
            const response = Response.json(
              { reason: "assistant_busy" },
              { status: 409 }
            );
            busyResponse = {
              status: response.status,
              body: { reason: "assistant_busy" },
            };
            return response;
          },
          Math.floor(Date.now() / 1000)
        );
      }
      if (Number.isInteger(concurrentSweepCount) && concurrentSweepCount > 0) {
        const boundedCount = Math.min(concurrentSweepCount, 32);
        concurrentSweeps = await Promise.all(
          Array.from({ length: boundedCount }, () =>
            sweepBlackboardWakes(agentEnv, dispatch, Math.floor(Date.now() / 1000))
          )
        );
      }
      const result = await sweepBlackboardWakes(
        agentEnv,
        dispatch,
        Math.floor(Date.now() / 1000) + (simulateBusyFirst ? 301 : 0)
      );
      const repeatSweep = await sweepBlackboardWakes(
        agentEnv,
        dispatch,
        Math.floor(Date.now() / 1000) + 1
      );
      const wake = await db
        .prepare(
          "SELECT status,attempts FROM space_blackboard_wakes WHERE tenant_id=? AND space_id=? AND project_id=? AND event_id=?"
        )
        .bind(TEST_TENANT_ID, TEST_SPACE_ID, projectId, `${requestId}:pending`)
        .first();
      let workspaceArtifact: { exists: boolean; branch?: string; contentMatches?: boolean; sha256?: string; candidates?: string[]; workspaceKeys?: string[] } | undefined;
      let goalActivityRunId: string | undefined;
      let goalActivity: { goals?: Array<{ verificationRequired?: boolean; tasks?: Array<{ status?: string; verification?: { outcome?: string; reason?: string } }> }> } | undefined;
      let goalActivityStatus: number | undefined;
      if (mockModelRun && (wake?.status === "completed" || wake?.status === "held")) {
        const eventRow = await db.prepare("SELECT event_id FROM space_blackboard_wakes WHERE tenant_id=? AND space_id=? AND project_id=? AND event_id=?")
          .bind(TEST_TENANT_ID, TEST_SPACE_ID, projectId, `${requestId}:pending`).first<{ event_id: string }>();
        if (eventRow?.event_id) {
          const rootRunId = `blackboard-${await sha256(JSON.stringify([TEST_TENANT_ID, TEST_SPACE_ID, projectId, eventRow.event_id]))}`;
          goalActivityRunId = rootRunId;
          const branchDigest = await sha256(JSON.stringify([TEST_TENANT_ID, TEST_SPACE_ID, projectId, rootRunId]));
          const branch = `task/${branchDigest.slice(0, 48)}`;
          const scripts = env.SCRIPTS_R2 as R2Bucket | undefined;
          const object = scripts ? await scripts.get(`spaces/${TEST_SPACE_ID}/projects/${projectId}/workspace/branches/${branch}/reports/blackboard-worker-smoke.txt`) : null;
          const artifactText = object ? await object.text() : null;
          const artifactHash = artifactText === null ? undefined : await sha256(artifactText);
          const candidates: string[] = [];
          const workspaceKeys: string[] = [];
          if (scripts) {
            let cursor: string | undefined;
            do {
              const page = await scripts.list({ prefix: `spaces/${TEST_SPACE_ID}/projects/${projectId}/workspace/`, ...(cursor ? { cursor } : {}), limit: 100 });
              workspaceKeys.push(...page.objects.slice(0, 100).map(item => item.key));
              candidates.push(...page.objects.filter(item => item.key.endsWith("/reports/blackboard-worker-smoke.txt")).map(item => item.key));
              cursor = page.truncated ? page.cursor : undefined;
            } while (cursor && workspaceKeys.length < 100);
          }
          workspaceArtifact = {
            exists: object !== null,
            branch,
            ...(artifactText !== null ? { contentMatches: artifactText === "project bot leaf worker completed\n", sha256: artifactHash } : {}),
            candidates,
            workspaceKeys,
          };
          const agentDoName = await getDOName("agent", `${TEST_SPACE_ID}:naelao-agent`, TEST_TENANT_ID, String(env.PLATFORM_SECRET));
          const agentStub = (env.NAELAO_AGENT_DO as DurableObjectNamespace).get((env.NAELAO_AGENT_DO as DurableObjectNamespace).idFromName(agentDoName));
          const activityResponse = await agentStub.fetch(new Request(`http://agent-do/internal/goal-activity?run_id=${encodeURIComponent(rootRunId)}&space_id=${encodeURIComponent(TEST_SPACE_ID)}`, {
            headers: {
              "x-naelao-tenant-id": TEST_TENANT_ID,
              "x-naelao-user-id": TEST_USER_ID,
              "x-naelao-internal-token": await mintInternalToken(String(env.PLATFORM_SECRET), TEST_TENANT_ID),
            },
          }));
          goalActivityStatus = activityResponse.status;
          if (activityResponse.ok) goalActivity = await activityResponse.json() as typeof goalActivity;
        }
      }
      if (revokeAuthority) {
        await db
          .prepare(
            "INSERT INTO space_members(id,space_id,tenant_id,end_user_id,role) VALUES(?,?,?,?, 'owner')"
          )
          .bind(
            "member-blackboard-runtime-test",
            TEST_SPACE_ID,
            TEST_TENANT_ID,
            TEST_USER_ID
          )
          .run();
      }
      const threadsResponse = await callSpaces(
        `/spaces/${TEST_SPACE_ID}/threads?project_id=${encodeURIComponent(projectId)}`,
        "GET"
      );
      if (mockModelRun) {
        await db.prepare("UPDATE spaces SET config_json=? WHERE id=?")
          .bind(JSON.stringify({ compliance: { airGappedOnly: true } }), TEST_SPACE_ID).run();
        const modelGateway = env.MODEL_GATEWAY as Fetcher | undefined;
        await modelGateway?.fetch(new Request("http://model/__test/configure", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leafWorkerMode: false, dependentTaskMode: false }) }));
      }
      return Response.json({
        sourceProjectId: sourceProject.id,
        sweep: result,
        concurrentSweeps,
        busySweep,
        busyResponse,
        repeatSweep,
        wake,
        workspaceArtifact,
        goalActivityRunId,
        goalActivity,
        goalActivityStatus,
        dispatchResponses,
        requestCounts,
        conflictingRequestStatus: conflictingRequestResponse.status,
        conflictingRequestBody: await conflictingRequestResponse.json(),
        threads: await threadsResponse.json(),
      });
    }

    return agentsWorker.fetch(request, env as never, ctx);
  },
};
