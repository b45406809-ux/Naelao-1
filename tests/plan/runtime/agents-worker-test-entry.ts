import { mintInternalToken } from "@naelao/http";
import {
  NaelaoAgentDO,
  wakeAgentGoal,
} from "../../../workers/agents/src/index.js";
import agentsWorker from "../../../workers/agents/src/index.js";
import { sweepBlackboardWakes } from "../../../workers/agents/src/communications/blackboard-wake.js";

export { NaelaoAgentDO };

const TEST_TENANT_ID = "tenant-blackboard-runtime-test";
const TEST_SPACE_ID = "space-blackboard-runtime-test";
const TEST_USER_ID = "owner-blackboard-runtime-test";
const TEST_VIEWER_ID = "viewer-blackboard-runtime-test";

/** Test-only control routes wrap the production Agents Worker in the isolated test runtime. */
export default {
  async fetch(
    request: Request,
    env: Record<string, unknown>,
    ctx: ExecutionContext
  ) {
    const url = new URL(request.url);
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
      } = (await request.json()) as {
        projectId: string;
        revokeAuthority?: boolean;
        simulateBusyFirst?: boolean;
        expireLease?: boolean;
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
      let busySweep: { checked: number } | undefined;
      let busyResponse: { status: number; body: unknown } | undefined;
      const eventId = `${requestId}:pending`;
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
      const result = await sweepBlackboardWakes(
        agentEnv,
        async (input) => {
          const response = await wakeAgentGoal(agentEnv, input);
          const body = await response
            .clone()
            .json()
            .catch(() => null);
          dispatchResponses.push({ status: response.status, body });
          return response;
        },
        Math.floor(Date.now() / 1000) + (simulateBusyFirst ? 301 : 0)
      );
      const repeatSweep = await sweepBlackboardWakes(
        agentEnv,
        async (input) => {
          const response = await wakeAgentGoal(agentEnv, input);
          const body = await response
            .clone()
            .json()
            .catch(() => null);
          dispatchResponses.push({ status: response.status, body });
          return response;
        },
        Math.floor(Date.now() / 1000) + 1
      );
      const wake = await db
        .prepare(
          "SELECT status,attempts FROM space_blackboard_wakes WHERE tenant_id=? AND space_id=? AND project_id=? AND event_id=?"
        )
        .bind(TEST_TENANT_ID, TEST_SPACE_ID, projectId, `${requestId}:pending`)
        .first();
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
      return Response.json({
        sourceProjectId: sourceProject.id,
        sweep: result,
        busySweep,
        busyResponse,
        repeatSweep,
        wake,
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
