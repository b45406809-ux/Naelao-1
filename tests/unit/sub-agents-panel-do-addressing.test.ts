import { describe, it, expect } from "vitest";
import app from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { getDOName } from "@naelao/crypto";
import type { AgentsEnv } from "../../workers/agents/src/index.js";

// The reported bug: "I ran a subagent in an assistant session but the Sub-agents tab still says
// 'No sub-agents have run in this conversation.'"
//
// Root cause was DO ADDRESSING, not the panel or the DO query. `sub_agents` rows are written by
// whichever DO instance ran the spawn, and an agent DO is addressed PER CONVERSATION
// (getAgentDO(sessionId), or `{sessionId}:{agentId}` when an agent is explicitly bound — mirroring
// /agent/run's own doKey). The panel route addressed the SPACE-WIDE assistant DO
// (`{spaceId}:naelao-agent`) instead — a different instance that had never seen the run — so it
// truthfully reported nothing, however many sub-agents had actually run.
//
// These assert the DO NAME the route resolves to. The pre-existing suite could not catch this at
// all: its DO stub returns the same object for every id, so any addressing bug looks identical.

const SECRET = "test-platform-secret";

/** Captures every DO name the route resolves, so the addressing itself is the assertion. */
function makeEnv(): AgentsEnv & { __doNames: string[] } {
  const doNames: string[] = [];
  const stub = {
    fetch: async () => Response.json({ data: [] }),
  } as unknown as DurableObjectStub;
  return {
    PLATFORM_SECRET: SECRET,
    NAELAO_AGENT_DO: {
      idFromName: (name: string) => {
        doNames.push(name);
        return { toString: () => name };
      },
      get: () => stub,
    },
    // Membership check short-circuits for a builder-role caller, so no SPACES_WORKER is needed.
    __doNames: doNames,
  } as unknown as AgentsEnv & { __doNames: string[] };
}

async function req(path: string) {
  const token = await mintInternalToken(SECRET, "tenant-1");
  return new Request(`http://agents${path}`, {
    headers: {
      "x-naelao-internal-token": token,
      "x-naelao-tenant-id": "tenant-1",
      "x-naelao-role": "owner",
    },
  });
}

describe("assistant/sub-agents — addresses the DO that actually ran the spawn", () => {
  it("uses the SESSION's own DO when session_id is given (the fix)", async () => {
    const env = makeEnv();
    await app.fetch(await req("/spaces/space1/assistant/sub-agents?session_id=sess-9&parent_run_id="), env);

    const expected = await getDOName("agent", "sess-9", "tenant-1", SECRET);
    expect(env.__doNames).toContain(expected);

    // And crucially NOT the space-wide assistant DO, which is where it used to look.
    const spaceWide = await getDOName("agent", "space1:naelao-agent", "tenant-1", SECRET);
    expect(env.__doNames).not.toContain(spaceWide);
  });

  it("mirrors /agent/run's `{sessionId}:{agentId}` addressing for an explicitly bound agent", async () => {
    const env = makeEnv();
    await app.fetch(await req("/spaces/space1/assistant/sub-agents?session_id=sess-9&agent_id=agent-x"), env);

    const expected = await getDOName("agent", "sess-9:agent-x", "tenant-1", SECRET);
    expect(env.__doNames).toContain(expected);
  });

  it("falls back to the space-wide assistant DO with no session_id (heartbeat/cron wake-ups)", async () => {
    const env = makeEnv();
    await app.fetch(await req("/spaces/space1/assistant/sub-agents"), env);

    const spaceWide = await getDOName("agent", "space1:naelao-agent", "tenant-1", SECRET);
    expect(env.__doNames).toContain(spaceWide);
  });

  it("still forwards parent_run_id through to the DO", async () => {
    const calls: string[] = [];
    const env = makeEnv();
    (env.NAELAO_AGENT_DO as unknown as { get: () => DurableObjectStub }).get = () =>
      ({
        fetch: async (r: Request) => {
          calls.push(r.url);
          return Response.json({ data: [] });
        },
      }) as unknown as DurableObjectStub;

    await app.fetch(await req("/spaces/space1/assistant/sub-agents?session_id=s1&parent_run_id=run-42"), env);
    expect(calls.some((u) => u.includes("parent_run_id=run-42"))).toBe(true);
  });
});
