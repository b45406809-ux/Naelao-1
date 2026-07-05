import { describe, it, expect } from "vitest";
import { localMachine } from "../../workers/agents/src/script-engine/prebuilt/local-machine.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

// §A1.17 Phase M: local-machine-as-container. The whole safety story hinges on grant checking
// happening BEFORE the tunnel is ever touched — these tests verify that a denied request never
// reaches env.localTunnel at all, that path-traversal can't bypass a directory grant, that exec
// commands must match EXACTLY (no prefix sneaking), and that a project-scoped grant doesn't leak
// across projects.

interface LocalGrant {
  id: string;
  project_id: string | null;
  user_id: string;
  grant_type: "read" | "write" | "readwrite" | "exec";
  directory: string | null;
  commands: string[];
}

function makeEnv(opts: {
  grants: LocalGrant[];
  projectId?: string;
  tunnelExec?: (params: { userId: string; op: string; params: Record<string, unknown> }) => { ok: boolean; result?: unknown; error?: string };
  noTunnel?: boolean;
}): { env: ScriptEngineEnv; tunnelCalls: Array<{ userId: string; op: string; params: Record<string, unknown> }> } {
  const tunnelCalls: Array<{ userId: string; op: string; params: Record<string, unknown> }> = [];
  const spacesWorker = {
    async fetch() {
      return Response.json({ data: opts.grants });
    },
  };
  const env: ScriptEngineEnv = {
    scriptsBucket: {} as never,
    spaceId: "space-1",
    tenantId: "tenant-1",
    platformSecret: "test-secret",
    spacesWorker: spacesWorker as unknown as Fetcher,
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.noTunnel
      ? {}
      : {
          localTunnel: {
            exec: async (p) => {
              tunnelCalls.push(p);
              return opts.tunnelExec ? opts.tunnelExec(p) : { ok: true, result: "ok" };
            },
            status: async (userId) => ({ connected: tunnelCalls.some((c) => c.userId === userId) }),
          },
        }),
  } as unknown as ScriptEngineEnv;
  return { env, tunnelCalls };
}

const noopRun = async () => ({});

describe("local-machine prebuilt — grant enforcement", () => {
  it("denies local.read_file with no active grants at all, without touching the tunnel", async () => {
    const { env, tunnelCalls } = makeEnv({ grants: [] });
    await expect(localMachine.operations["local.read_file"]!({ path: "/home/alice/project/readme.md" }, { env, run: noopRun }))
      .rejects.toThrow(/denied/);
    expect(tunnelCalls).toHaveLength(0);
  });

  it("allows local.read_file when a read grant covers the exact directory", async () => {
    const { env, tunnelCalls } = makeEnv({
      grants: [{ id: "g1", project_id: null, user_id: "builder-1", grant_type: "read", directory: "/home/alice/project", commands: [] }],
    });
    const result = await localMachine.operations["local.read_file"]!({ path: "/home/alice/project/readme.md" }, { env, run: noopRun });
    expect(result).toBe("ok");
    expect(tunnelCalls).toEqual([{ userId: "builder-1", op: "read_file", params: { path: "/home/alice/project/readme.md" } }]);
  });

  it("rejects a directory that merely shares a string prefix, not a real path segment (/home/alice/allowed-evil vs /home/alice/allowed)", async () => {
    const { env, tunnelCalls } = makeEnv({
      grants: [{ id: "g1", project_id: null, user_id: "builder-1", grant_type: "readwrite", directory: "/home/alice/allowed", commands: [] }],
    });
    await expect(localMachine.operations["local.read_file"]!({ path: "/home/alice/allowed-evil/secret.txt" }, { env, run: noopRun }))
      .rejects.toThrow(/denied/);
    expect(tunnelCalls).toHaveLength(0);
  });

  it("collapses .. traversal before the grant check, so it cannot escape the granted directory", async () => {
    const { env, tunnelCalls } = makeEnv({
      grants: [{ id: "g1", project_id: null, user_id: "builder-1", grant_type: "read", directory: "/home/alice/project", commands: [] }],
    });
    await expect(
      localMachine.operations["local.read_file"]!({ path: "/home/alice/project/../../etc/passwd" }, { env, run: noopRun })
    ).rejects.toThrow(/denied/);
    expect(tunnelCalls).toHaveLength(0);
  });

  it("a read-only grant does not permit local.write_file", async () => {
    const { env, tunnelCalls } = makeEnv({
      grants: [{ id: "g1", project_id: null, user_id: "builder-1", grant_type: "read", directory: "/home/alice/project", commands: [] }],
    });
    await expect(
      localMachine.operations["local.write_file"]!({ path: "/home/alice/project/out.txt", content: "hi" }, { env, run: noopRun })
    ).rejects.toThrow(/denied/);
    expect(tunnelCalls).toHaveLength(0);
  });

  it("a readwrite grant permits both read and write", async () => {
    const { env, tunnelCalls } = makeEnv({
      grants: [{ id: "g1", project_id: null, user_id: "builder-1", grant_type: "readwrite", directory: "/home/alice/project", commands: [] }],
    });
    await localMachine.operations["local.write_file"]!({ path: "/home/alice/project/out.txt", content: "hi" }, { env, run: noopRun });
    expect(tunnelCalls[0]).toEqual({ userId: "builder-1", op: "write_file", params: { path: "/home/alice/project/out.txt", content: "hi" } });
  });

  it("local.exec requires an EXACT command match — a broader allowed command does not authorize a longer one", async () => {
    const { env, tunnelCalls } = makeEnv({
      grants: [{ id: "g1", project_id: null, user_id: "builder-1", grant_type: "exec", directory: null, commands: ["npm test"] }],
    });
    await expect(localMachine.operations["local.exec"]!({ command: "npm test && rm -rf /" }, { env, run: noopRun })).rejects.toThrow(/denied/);
    expect(tunnelCalls).toHaveLength(0);

    await localMachine.operations["local.exec"]!({ command: "npm test" }, { env, run: noopRun });
    expect(tunnelCalls[0]).toEqual({ userId: "builder-1", op: "exec", params: { command: "npm test" } });
  });

  it("a project-scoped grant does not apply to a DIFFERENT project's run", async () => {
    const { env, tunnelCalls } = makeEnv({
      grants: [{ id: "g1", project_id: "proj-A", user_id: "builder-1", grant_type: "read", directory: "/home/alice/project", commands: [] }],
      projectId: "proj-B",
    });
    await expect(localMachine.operations["local.read_file"]!({ path: "/home/alice/project/readme.md" }, { env, run: noopRun }))
      .rejects.toThrow(/denied/);
    expect(tunnelCalls).toHaveLength(0);
  });

  it("a project-scoped grant DOES apply to that same project's run", async () => {
    const { env, tunnelCalls } = makeEnv({
      grants: [{ id: "g1", project_id: "proj-A", user_id: "builder-1", grant_type: "read", directory: "/home/alice/project", commands: [] }],
      projectId: "proj-A",
    });
    await localMachine.operations["local.read_file"]!({ path: "/home/alice/project/readme.md" }, { env, run: noopRun });
    expect(tunnelCalls).toHaveLength(1);
  });

  it("a space-wide grant (project_id null) applies to the Space Assistant (no projectId) and any project", async () => {
    const { env, tunnelCalls } = makeEnv({
      grants: [{ id: "g1", project_id: null, user_id: "builder-1", grant_type: "read", directory: "/home/alice/project", commands: [] }],
      projectId: "proj-any",
    });
    await localMachine.operations["local.read_file"]!({ path: "/home/alice/project/readme.md" }, { env, run: noopRun });
    expect(tunnelCalls).toHaveLength(1);
  });

  it("fails closed with a clear message when no local tunnel is configured, even with a matching grant", async () => {
    const { env } = makeEnv({
      grants: [{ id: "g1", project_id: null, user_id: "builder-1", grant_type: "read", directory: "/home/alice/project", commands: [] }],
      noTunnel: true,
    });
    await expect(localMachine.operations["local.read_file"]!({ path: "/home/alice/project/readme.md" }, { env, run: noopRun }))
      .rejects.toThrow(/no local tunnel configured/);
  });

  it("surfaces a tunnel-reported error (e.g. not connected) rather than pretending success", async () => {
    const { env } = makeEnv({
      grants: [{ id: "g1", project_id: null, user_id: "builder-1", grant_type: "read", directory: "/home/alice/project", commands: [] }],
      tunnelExec: () => ({ ok: false, error: "not_connected: no Naelao Local Agent is currently connected" }),
    });
    await expect(localMachine.operations["local.read_file"]!({ path: "/home/alice/project/readme.md" }, { env, run: noopRun }))
      .rejects.toThrow(/not_connected/);
  });

  it("local.status reports per-target connection state derived from the space's grants", async () => {
    const { env } = makeEnv({
      grants: [{ id: "g1", project_id: null, user_id: "builder-1", grant_type: "read", directory: "/x", commands: [] }],
    });
    const result = await localMachine.operations["local.status"]!({}, { env, run: noopRun }) as { configured: boolean; targets: Array<{ user_id: string; connected: boolean }> };
    expect(result.configured).toBe(true);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]!.user_id).toBe("builder-1");
  });

  it("local.status with no grants at all reports configured but no targets, without erroring", async () => {
    const { env } = makeEnv({ grants: [] });
    const result = await localMachine.operations["local.status"]!({}, { env, run: noopRun }) as { configured: boolean; targets: unknown[] };
    expect(result.configured).toBe(true);
    expect(result.targets).toHaveLength(0);
  });
});
