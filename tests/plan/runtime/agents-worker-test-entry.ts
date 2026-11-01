import { mintInternalToken } from "@naelao/http";
import {
  ConcurrencyDO,
  NaelaoAgentDO,
  wakeAgentGoal,
} from "../../../workers/agents/src/index.js";
import agentsWorker from "../../../workers/agents/src/index.js";
import { sweepBlackboardWakes } from "../../../workers/agents/src/communications/blackboard-wake.js";
import { writeAgentConfig } from "../../../workers/agents/src/script-engine/agent-config.js";
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
    if (url.pathname === "/__test/bootstrap" && request.method === "POST") {
      const db = env.PLATFORM_DB as D1Database;
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

      return Response.json({
        tenantId: TEST_TENANT_ID,
        spaceId: TEST_SPACE_ID,
        userId: TEST_USER_ID,
        viewerId: TEST_VIEWER_ID,
        token: await mintInternalToken(
          String(env.PLATFORM_SECRET),
          TEST_TENANT_ID
        ),
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
      if (mockModelRun && wake?.status === "completed") {
        const eventRow = await db.prepare("SELECT event_id FROM space_blackboard_wakes WHERE tenant_id=? AND space_id=? AND project_id=? AND event_id=?")
          .bind(TEST_TENANT_ID, TEST_SPACE_ID, projectId, `${requestId}:pending`).first<{ event_id: string }>();
        if (eventRow?.event_id) {
          const rootRunId = `blackboard-${await sha256(JSON.stringify([TEST_TENANT_ID, TEST_SPACE_ID, projectId, eventRow.event_id]))}`;
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
        await modelGateway?.fetch(new Request("http://model/__test/configure", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leafWorkerMode: false }) }));
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
