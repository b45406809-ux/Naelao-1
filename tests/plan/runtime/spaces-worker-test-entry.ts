import { mintInternalToken } from "@naelao/http";
import {
  NaelaoAgentDO,
  wakeAgentGoal,
} from "../../../workers/agents/src/index.js";
import { sweepBlackboardWakes } from "../../../workers/agents/src/communications/blackboard-wake.js";
import spacesWorker, { SpaceDO } from "../../../workers/spaces/src/index.js";

export { NaelaoAgentDO, SpaceDO };

const TEST_TENANT_ID = "tenant-blackboard-runtime-test";
const TEST_SPACE_ID = "space-blackboard-runtime-test";
const TEST_USER_ID = "owner-blackboard-runtime-test";
const TEST_VIEWER_ID = "viewer-blackboard-runtime-test";

/** Test-only setup endpoint. It is present only in the isolated Wrangler test Worker. */
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
      const { projectId } = (await request.json()) as { projectId: string };
      if (!projectId)
        return Response.json({ error: "projectId required" }, { status: 400 });
      const db = env.PLATFORM_DB as D1Database;
      const spaceEnv = env as never;
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
        spacesWorker.fetch(
          new Request(`http://spaces${path}`, {
            method,
            headers: internalHeaders,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
          spaceEnv,
          ctx
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
      const requestResponse = await callSpaces(
        `/internal/spaces/${TEST_SPACE_ID}/blackboard/requests`,
        "POST",
        {
          id: "runtime-e2e",
          source_project_id: sourceProject.id,
          target_project_id: projectId,
          objective: "Review the synthetic runtime acceptance request",
          expected_result:
            "Report the project scope and stop before provider use",
        }
      );
      if (!requestResponse.ok)
        return new Response(requestResponse.body, {
          status: requestResponse.status,
        });

      const agentEnv = env as never;
      const dispatchResponses: Array<{ status: number; body: unknown }> = [];
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
        Math.floor(Date.now() / 1000)
      );
      const wake = await db
        .prepare(
          "SELECT status,attempts FROM space_blackboard_wakes WHERE tenant_id=? AND space_id=? AND project_id=? AND event_id=?"
        )
        .bind(TEST_TENANT_ID, TEST_SPACE_ID, projectId, "runtime-e2e:pending")
        .first();
      const headers = {
        "x-naelao-tenant-id": TEST_TENANT_ID,
        "x-naelao-user-id": TEST_USER_ID,
        "x-naelao-role": "owner",
        "x-naelao-internal-token": await mintInternalToken(
          String(env.PLATFORM_SECRET),
          TEST_TENANT_ID
        ),
      };
      const threadsResponse = await spacesWorker.fetch(
        new Request(
          `http://spaces/spaces/${TEST_SPACE_ID}/threads?project_id=${encodeURIComponent(projectId)}`,
          { headers }
        ),
        spaceEnv,
        ctx
      );
      return Response.json({
        sourceProjectId: sourceProject.id,
        sweep: result,
        wake,
        dispatchResponses,
        threads: await threadsResponse.json(),
      });
    }

    return spacesWorker.fetch(request, env as never, ctx);
  },
};
