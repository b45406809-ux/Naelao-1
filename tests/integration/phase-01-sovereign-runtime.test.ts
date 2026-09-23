import {
  type ArtifactCommit,
  type ArtifactRepository,
  authorizeProject,
  authorizedOutboundFetch,
  commitToolTurn,
  createRuntimeContext,
  defineLaunchpadSpace,
  enforceWriteGuard,
  mintCapabilityGrant,
  normalizeWorkspacePath,
  routeRuntime,
  scrubEgressPayload,
} from "@naelao/agent-sdk";
import { describe, expect, it, vi } from "vitest";

function repository(): ArtifactRepository & {
  files: Map<string, Uint8Array>;
  commits: ArtifactCommit[];
} {
  const files = new Map<string, Uint8Array>();
  const commits: ArtifactCommit[] = [];
  return {
    files,
    commits,
    read: async (path) => files.get(path) ?? null,
    write: async (path, value) => {
      files.set(normalizeWorkspacePath(path), value);
    },
    commit: async (message, metadata) => {
      const commit = {
        oid: `oid-${commits.length + 1}`,
        message,
        metadata,
        createdAt: Date.now(),
      };
      commits.push(commit);
      return commit;
    },
    branch: async () => undefined,
    checkout: async () => undefined,
    head: async () => commits.at(-1)?.oid ?? "root",
    diff: async () => "diff",
  };
}

describe("phase 1 sovereign runtime journey", () => {
  it("takes an authorized request through capability, hypervisor, ArtifactFS, and checkpoint", async () => {
    const space = defineLaunchpadSpace({
      id: "space-a",
      depth: 0,
      parentId: null,
    });
    expect(
      authorizeProject({
        visibility: "private",
        isSpaceMember: true,
        projectRole: "editor",
      })
    ).toEqual({ allowed: true });
    const token = await mintCapabilityGrant(
      {
        subject: "human-1",
        resources: ["project-a"],
        actions: ["destructive_write"],
        expiresAt: 2_000,
        nonce: "n-1",
      },
      "platform-secret"
    );
    await expect(
      enforceWriteGuard(
        "DELETE FROM draft_rows",
        token,
        "platform-secret",
        {
          subject: "human-1",
          resource: "project-a",
        },
        1_000
      )
    ).resolves.toBeUndefined();
    expect(routeRuntime({ tool: "Edit" })).toMatchObject({
      tier: 1,
      engine: "artifact-vfs",
    });

    const repo = repository();
    const ctx = createRuntimeContext(space, "project-a", {
      fs: repo,
      repo,
      vault: {
        has: async () => true,
        request: async () => {
          throw new Error("vault_values_are_host_only");
        },
      },
      cli: { run: async () => ({ ok: true }) },
      browser: { navigate: async () => ({ ok: true }) },
      connectors: { call: async () => ({ ok: true }) },
    });
    await ctx.fs.write("report.csv", new TextEncoder().encode("approved,true"));
    const commit = await ctx.project.commitTurn(1, {
      agentRole: "department-director",
      userGoal: "approve report",
      taskId: "task-1",
      rationale: "authorized edit",
    });
    expect(repo.files.has("/workspace/report.csv")).toBe(true);
    expect(commit.oid).toBe("oid-1");
  });

  it("fails closed for cross-space access, secrets, mutation, and prohibited egress", async () => {
    expect(
      authorizeProject({ visibility: "private", isSpaceMember: false })
    ).toEqual({ allowed: false, status: 404 });
    await expect(
      enforceWriteGuard("rm -rf /workspace", undefined, "secret", {
        subject: "intruder",
        resource: "other-space",
      })
    ).rejects.toThrow("destructive_mutation_denied");

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok"));
    const provider = { authorization: vi.fn(async () => "Bearer host-secret") };
    await authorizedOutboundFetch(
      provider,
      "billing",
      { tenantId: "t", spaceId: "s" },
      new Request("https://example.test")
    );
    expect(provider.authorization).toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0]?.[0]).toBeInstanceOf(Request);
    expect(await (fetchSpy.mock.calls[0]?.[0] as Request).text()).not.toContain(
      "host-secret"
    );
    fetchSpy.mockRestore();

    const egress = scrubEgressPayload({ webhook: { body: "SSN 123-45-6789" } });
    expect(egress.findings).toContain("ssn");
    expect(JSON.stringify(egress.value)).not.toContain("123-45-6789");
  });
});
