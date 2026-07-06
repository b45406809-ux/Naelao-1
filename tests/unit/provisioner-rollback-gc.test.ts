import { describe, it, expect } from "vitest";
import { rollbackSpace } from "../../workers/provisioner/src/index.js";
import type { Env } from "../../workers/provisioner/src/index.js";
import { verifyInternalToken } from "@naelao/http";

// WS-8.6 (audit plan): rollbackSpace cleaned R2/KV/portal/scheduled_jobs on a failed provision but
// left agent_definitions and the owner space_members row orphaned in SpaceDO — a permanently-
// failed space (status='error' forever) never gets these cleaned up. Both now use the same
// SPACES_WORKER routes the forward path (installLaunchpadAgents / seedOwnerMember) already uses.

const SECRET = "test-platform-secret";

interface Call { method: string; url: string; headers: Record<string, string> }

function makeEnv(opts: { agentDefRows?: Array<{ id: string }>; listOk?: boolean } = {}): {
  env: Env;
  calls: Call[];
} {
  const calls: Call[] = [];
  const agentDefRows = opts.agentDefRows ?? [];
  const listOk = opts.listOk ?? true;

  const spacesWorker = {
    async fetch(reqInput: Request | string, init?: RequestInit): Promise<Response> {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      calls.push({ method: req.method, url: req.url, headers });

      if (req.method === "GET" && req.url.includes("/agent-definitions")) {
        if (!listOk) return new Response("nope", { status: 500 });
        return Response.json({ data: agentDefRows });
      }
      if (req.method === "DELETE") {
        return new Response(null, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  };

  const platformDb = {
    prepare(_sql: string) {
      return {
        bind(..._args: unknown[]) {
          return { async run() { return { meta: { changes: 1 } }; } };
        },
      };
    },
  };

  const spacesKv = { async delete() {} };
  const scriptsR2 = { async list() { return { objects: [], truncated: false }; } };

  const env = {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: SECRET,
    PLATFORM_DB: platformDb,
    SPACES_KV: spacesKv,
    SPACES_WORKER: spacesWorker,
    SCRIPTS_R2: scriptsR2,
  } as unknown as Env;

  return { env, calls };
}

describe("rollbackSpace — orphan GC (WS-8.6)", () => {
  it("deletes every agent_definitions row installed by step 9, when 'agents' was provisioned", async () => {
    const { env, calls } = makeEnv({ agentDefRows: [{ id: "agent-def-1" }, { id: "agent-def-2" }] });
    await rollbackSpace("space-1", "tenant-1", "launchpad", ["r2_prefixes", "agents"], env, "user-1");

    const listCall = calls.find((c) => c.method === "GET" && c.url.includes("/agent-definitions"));
    expect(listCall).toBeTruthy();
    expect(await verifyInternalToken(listCall!.headers["x-naelao-internal-token"], "tenant-1", SECRET)).toBe(true);

    const deleteCalls = calls.filter((c) => c.method === "DELETE" && c.url.includes("/agent-definitions/"));
    expect(deleteCalls.map((c) => c.url).sort()).toEqual([
      "http://spaces-worker/spaces/space-1/agent-definitions/agent-def-1",
      "http://spaces-worker/spaces/space-1/agent-definitions/agent-def-2",
    ]);
  });

  it("does not touch agent-definitions at all when step 9 never ran", async () => {
    const { env, calls } = makeEnv();
    await rollbackSpace("space-1", "tenant-1", "launchpad", ["r2_prefixes"], env, "user-1");
    expect(calls.some((c) => c.url.includes("/agent-definitions"))).toBe(false);
  });

  it("removes the owner space_members row when 'owner_member' was provisioned and userId is known", async () => {
    const { env, calls } = makeEnv();
    await rollbackSpace("space-1", "tenant-1", "launchpad", ["owner_member"], env, "user-1");

    const memberDelete = calls.find((c) => c.method === "DELETE" && c.url.includes("/members/"));
    expect(memberDelete).toBeTruthy();
    expect(memberDelete!.url).toBe("http://spaces-worker/spaces/space-1/members/user-1?space_id=space-1");
    expect(await verifyInternalToken(memberDelete!.headers["x-naelao-internal-token"], "tenant-1", SECRET)).toBe(true);
  });

  it("does not attempt member removal when userId is unknown (a message queued before the fix)", async () => {
    const { env, calls } = makeEnv();
    await rollbackSpace("space-1", "tenant-1", "launchpad", ["owner_member"], env, undefined);
    expect(calls.some((c) => c.url.includes("/members/"))).toBe(false);
  });

  it("never throws when the agent-definitions list call fails — rollback must still flip status to error", async () => {
    const { env } = makeEnv({ listOk: false });
    await expect(
      rollbackSpace("space-1", "tenant-1", "launchpad", ["agents"], env, "user-1")
    ).resolves.not.toThrow();
  });

  it("still flips the space to 'error' status even when there is nothing to roll back", async () => {
    const { env } = makeEnv();
    let updateRan = false;
    (env as unknown as { PLATFORM_DB: { prepare: (sql: string) => unknown } }).PLATFORM_DB = {
      prepare(sql: string) {
        if (sql.includes("UPDATE spaces")) updateRan = true;
        return { bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) };
      },
    };
    await rollbackSpace("space-1", "tenant-1", "launchpad", [], env, undefined);
    expect(updateRan).toBe(true);
  });
});
