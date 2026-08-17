// Work moves between projects on its own: an agent writes a file, that fires
// workspace.file_changed, and a no-code rule wakes the agent that owns the next stage.
//
// The whole chain is built from pieces that already existed — the event_triggers table, the
// `agent.consult` orchestration hook (which already accepted a target project_id), and the
// project workspace. What was missing was only the event: a workspace write announced nothing,
// so nothing could react to it.
//
// The file IS the handoff, deliberately. Passing the work as an event payload would leave the
// receiving agent with only a message to remember; a file is state both sides can re-read and it
// outlives the run that produced it.

import { describe, it, expect, vi } from "vitest";
import { r2Workspace } from "../../workers/agents/src/script-engine/prebuilt/r2-workspace.js";
import { matchesEvent, type TriggerRule, type EventEnvelope } from "../../packages/events/src/index.js";
import { seedWebStudioHandoffRules } from "../../workers/provisioner/src/index.js";

function makeR2() {
  const store = new Map<string, string>();
  return {
    async put(key: string, value: unknown) { store.set(key, String(value)); return {}; },
    async get(key: string) {
      const v = store.get(key);
      return v === undefined ? null : { text: async () => v, size: v.length };
    },
    async delete(key: string) { store.delete(key); },
    async list() { return { objects: [], truncated: false }; },
  } as unknown as R2Bucket;
}

function ctxWith(changes: Array<{ path: string; operation: string }>) {
  return {
    env: {
      scriptsBucket: makeR2(),
      spaceId: "space-1",
      agentId: "launchpad-leadgen-v1",
      tenantId: "tenant-1",
      projectId: "proj-leadgen",
      onWorkspaceChange: (c: { path: string; operation: "write" | "delete" }) => { changes.push(c); },
    },
  } as never;
}

describe("a workspace write announces itself", () => {
  it("reports a write, with the path that changed", async () => {
    const changes: Array<{ path: string; operation: string }> = [];
    const ctx = ctxWith(changes);
    await r2Workspace.operations["write_file"]!({ path: "leads/acme-cafe.json", content: "{}" }, ctx);
    expect(changes).toEqual([{ path: "leads/acme-cafe.json", operation: "write" }]);
  });

  it("reports a delete too — removing a job is as much a state change as adding one", async () => {
    const changes: Array<{ path: string; operation: string }> = [];
    const ctx = ctxWith(changes);
    await r2Workspace.operations["delete_file"]!({ path: "leads/gone.json" }, ctx);
    expect(changes).toEqual([{ path: "leads/gone.json", operation: "delete" }]);
  });

  it("still writes when nothing is listening", async () => {
    // The hook is absent for a Space Assistant run (no project). A write must not depend on it.
    const ctx = { env: { scriptsBucket: makeR2(), spaceId: "s", agentId: "a", tenantId: "t" } } as never;
    const res = await r2Workspace.operations["write_file"]!({ path: "notes.txt", content: "hi" }, ctx);
    expect((res as { ok: boolean }).ok).toBe(true);
  });
});

describe("a handoff rule reaches the next project and no further", () => {
  const rule: TriggerRule = {
    id: "r1",
    space_id: "space-1",
    project_id: "proj-leadgen",
    event_type: "workspace.file_changed",
    condition: { type: "always" },
    action: {
      type: "run_script",
      script_name: "handoff-to-project",
      params: { target_project_id: "proj-dev", target_agent_id: "launchpad-webdev-v1" },
    },
    enabled: true,
    priority: 10,
  };

  function event(projectId: string): EventEnvelope {
    return { type: "workspace.file_changed", space_id: "space-1", project_id: projectId, occurred_at: Date.now() };
  }

  it("fires on its own project's writes", () => {
    expect(matchesEvent(rule, event("proj-leadgen"))).toBe(true);
  });

  it("never fires on a DIFFERENT project's writes", () => {
    // The structural boundary: the Development project's own file churn must not re-trigger the
    // lead handoff, or a build would hand itself back to itself in a loop.
    expect(matchesEvent(rule, event("proj-dev"))).toBe(false);
  });

  it("never crosses into another space", () => {
    expect(matchesEvent(rule, { ...event("proj-leadgen"), space_id: "space-2" })).toBe(false);
  });
});

describe("the pipeline is wired at provisioning time", () => {
  function envWithCapture(calls: Array<{ url: string; body: Record<string, unknown> }>) {
    return {
      PLATFORM_SECRET: "secret",
      SPACES_WORKER: {
        fetch: vi.fn(async (req: Request) => {
          calls.push({ url: req.url, body: JSON.parse(await req.text()) });
          return new Response("{}", { status: 200 });
        }),
      },
    } as never;
  }

  it("wires lead-gen to development, and development to the customer", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    await seedWebStudioHandoffRules("space-1", "tenant-1", {
      "Lead Generation": "proj-leadgen",
      Development: "proj-dev",
      "Client Communication": "proj-comms",
    }, envWithCapture(calls));

    expect(calls).toHaveLength(2);
    const first = calls[0]!.body as { project_id: string; script_name: string; params: Record<string, string> };
    expect(first.project_id).toBe("proj-leadgen");
    expect(first.script_name).toBe("handoff-to-project");
    expect(first.params["target_project_id"]).toBe("proj-dev");
    expect(first.params["target_agent_id"]).toBe("launchpad-webdev-v1");

    const second = calls[1]!.body as { project_id: string; params: Record<string, string> };
    expect(second.project_id).toBe("proj-dev");
    expect(second.params["target_project_id"]).toBe("proj-comms");
  });

  it("sends the shape the create route actually requires", async () => {
    // The first draft sent a nested TriggerAction object; the route wants flat
    // script_name/params and rejected every rule as a bad request. The test captured the body
    // without checking it against the real contract, so it passed anyway — this asserts the
    // required fields the route validates, which is what would have caught it.
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    await seedWebStudioHandoffRules("space-1", "tenant-1", {
      "Lead Generation": "proj-leadgen", Development: "proj-dev", "Client Communication": "proj-comms",
    }, envWithCapture(calls));

    expect(calls.length).toBeGreaterThan(0);
    for (const { body } of calls) {
      // SpaceDO.createEventTrigger: "space_id, event_type, and script_name are required".
      // space_id is injected by the spaces-worker route from the URL, so the caller supplies
      // the other two.
      expect(typeof body["event_type"]).toBe("string");
      expect(typeof body["script_name"]).toBe("string");
      expect(body["action"]).toBeUndefined();
    }
  });

  it("wires nothing when the projects it depends on are not both there", async () => {
    // Better than a rule pointing at a project that does not exist, which would fail silently
    // every time it fired.
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    await seedWebStudioHandoffRules("space-1", "tenant-1", { "Lead Generation": "proj-leadgen" }, envWithCapture(calls));
    expect(calls).toHaveLength(0);
  });

  it("skips the second hop when there is no Client Communication project", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    await seedWebStudioHandoffRules("space-1", "tenant-1", {
      "Lead Generation": "proj-leadgen",
      Development: "proj-dev",
    }, envWithCapture(calls));
    expect(calls).toHaveLength(1);
  });

  it("a failing seed never throws — provisioning must not fail over a rule", async () => {
    const env = {
      PLATFORM_SECRET: "secret",
      SPACES_WORKER: { fetch: vi.fn(async () => { throw new Error("spaces worker down"); }) },
    } as never;
    await expect(seedWebStudioHandoffRules("space-1", "tenant-1", {
      "Lead Generation": "proj-leadgen", Development: "proj-dev",
    }, env)).resolves.toBeUndefined();
  });
});
