// seedGeneralProject — every business gets one ordinary, always-there project to land in, since
// /projects (bare, no id) now redirects straight into it instead of showing a picker first.
// Idempotent (SpaceDO's UNIQUE(space_id, name)) and best-effort by design, matching every other
// convenience seed in the provisioner.

import { describe, it, expect } from "vitest";
import { seedGeneralProject, GENERAL_PROJECT_NAME } from "../../workers/agents/src/launchpad/bootstrap.js";

function makeSpacesDouble(opts: { existing?: Array<{ id: string; name: string }> } = {}) {
  const calls: Array<{ method: "GET" | "POST"; path: string; body?: unknown }> = [];
  const createdNames = new Set((opts.existing ?? []).map((p) => p.name));
  let nextId = 1;
  return {
    calls,
    deps: {
      async postToSpaces(path: string, body: unknown): Promise<Response> {
        calls.push({ method: "POST", path, body });
        const b = body as { name: string };
        if (createdNames.has(b.name)) {
          return new Response(JSON.stringify({ error_code: "conflict" }), { status: 409 });
        }
        createdNames.add(b.name);
        return new Response(JSON.stringify({ id: `proj-${nextId++}`, name: b.name }), { status: 201 });
      },
      async getFromSpaces(path: string): Promise<Response> {
        calls.push({ method: "GET", path });
        return new Response(JSON.stringify({ data: opts.existing ?? [], count: (opts.existing ?? []).length }), { status: 200 });
      },
    },
  };
}

describe("seedGeneralProject", () => {
  it("creates a public, agent-bound General project", async () => {
    const { deps, calls } = makeSpacesDouble();
    const id = await seedGeneralProject(deps, "space-1");
    expect(id).toBe("proj-1");
    const createCall = calls.find((c) => c.method === "POST");
    expect(createCall).toBeDefined();
    const body = createCall!.body as Record<string, unknown>;
    expect(body.name).toBe(GENERAL_PROJECT_NAME);
    expect(body.default_agent_id).toBe("naelao-agent");
    expect(body.visibility).toBe("public");
  });

  it("is idempotent — a re-run finds the already-existing one instead of failing", async () => {
    const { deps } = makeSpacesDouble({ existing: [{ id: "proj-existing", name: GENERAL_PROJECT_NAME }] });
    const id = await seedGeneralProject(deps, "space-1");
    expect(id).toBe("proj-existing");
  });

  it("returns undefined, never throws, when the spaces worker is unreachable", async () => {
    const deps = {
      postToSpaces: async () => { throw new Error("network down"); },
      getFromSpaces: async () => new Response("{}", { status: 500 }),
    };
    await expect(seedGeneralProject(deps, "space-1")).resolves.toBeUndefined();
  });

  it("returns undefined when create fails and no getFromSpaces was supplied", async () => {
    const deps = {
      postToSpaces: async () => new Response(JSON.stringify({ error_code: "conflict" }), { status: 409 }),
    };
    const id = await seedGeneralProject(deps, "space-1");
    expect(id).toBeUndefined();
  });
});
