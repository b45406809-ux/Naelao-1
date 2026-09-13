import {
  ConnectorBindingMatrix,
  SingleUseGrantStore,
  VirtualCli,
  applyAgentFirewall,
  assembleSystemPrompt,
  attenuateDelegation,
  commandCatalog,
  compactContext,
  contextEnvelope,
  createParseV5Request,
  distillTrace,
  enforceWriteGuard,
  freshThreadContext,
  gateMemory,
  mintCapabilityGrant,
  parseMentionTurn,
  requiresMutationGrant,
  scrubEgress,
  toolsForChannel,
  validateTaskDag,
  verifyCapabilityGrant,
  verifyConnectorScopes,
} from "@naelao/agent-sdk";
import { describe, expect, it, vi } from "vitest";

describe("AVOS action-space security", () => {
  it("resolves the narrowest connector binding and requests missing scopes", () => {
    const matrix = new ConnectorBindingMatrix([
      {
        alias: "mail",
        connectorId: "shared",
        scope: "space",
        spaceId: "s",
        grantedScopes: ["read"],
      },
      {
        alias: "mail",
        connectorId: "personal",
        scope: "user",
        spaceId: "s",
        userId: "u",
        grantedScopes: ["read", "write"],
      },
    ]);
    const binding = matrix.resolve("mail", { spaceId: "s", userId: "u" });
    expect(binding?.connectorId).toBe("personal");
    if (!binding) throw new Error("expected personal binding");
    expect(verifyConnectorScopes(binding, ["write", "admin"])).toEqual({
      ok: false,
      card: {
        type: "incremental_reauthorization",
        connectorId: "personal",
        missingScopes: ["admin"],
      },
    });
  });

  it("requires a signed, scoped grant for destructive writes", async () => {
    expect(requiresMutationGrant("DROP TABLE users")).toBe(true);
    await expect(
      enforceWriteGuard("rm -rf /workspace", undefined, "secret", {
        subject: "u",
        resource: "p",
      })
    ).rejects.toThrow("destructive_mutation_denied");
    const grant = {
      subject: "u",
      resources: ["p"],
      actions: ["destructive_write"],
      expiresAt: 2_000,
      nonce: "n",
    };
    const token = await mintCapabilityGrant(grant, "secret");
    expect(
      await verifyCapabilityGrant(
        token,
        "secret",
        { subject: "u", resource: "p", action: "destructive_write" },
        1_000
      )
    ).toEqual(grant);
    await expect(
      enforceWriteGuard(
        "DELETE FROM users",
        token,
        "secret",
        { subject: "u", resource: "p" },
        1_000
      )
    ).resolves.toBeUndefined();
  });

  it("runs registered virtual commands and persists safe synthesized commands", async () => {
    const put = vi.fn(async () => undefined);
    const cli = new VirtualCli({ get: async () => null, put });
    await cli.registerSynthesized("echo", "return args", async (args) =>
      args.join(" ")
    );
    expect(await cli.run("echo", ["hello", "edge"])).toBe("hello edge");
    expect(put).toHaveBeenCalledWith("echo", "return args");
    await expect(
      cli.registerSynthesized("bad", "eval(source)", async () => null)
    ).rejects.toThrow();
  });

  it("strips personal tools, routes mention ownership, and consumes grants once", () => {
    expect(
      toolsForChannel(
        [
          { name: "company", scope: "space" },
          { name: "mine", scope: "user" },
        ],
        "public"
      )
    ).toEqual([{ name: "company", scope: "space" }]);
    expect(
      parseMentionTurn("@Reviewer audit @Builder's patch", [
        { id: "b", name: "Builder" },
        { id: "r", name: "Reviewer" },
      ])
    ).toEqual({ holder: "r", referents: ["b"] });
    const store = new SingleUseGrantStore();
    const grant = {
      subject: "u",
      resources: ["p"],
      actions: ["send"],
      expiresAt: 20_000,
      nonce: "once",
      singleUse: true,
    };
    store.consume(grant, 10_000);
    expect(() => store.consume(grant, 10_000)).toThrow(
      "ephemeral_grant_invalid"
    );
  });

  it("prevents delegated authority from expanding", () => {
    const parent = {
      subject: "agent",
      initiatorUserId: "u",
      roleRank: 2,
      resources: ["p"],
      actions: ["read", "write"],
      expiresAt: 100,
      nonce: "p",
    };
    expect(
      attenuateDelegation(parent, {
        subject: "child",
        resources: ["p"],
        actions: ["read"],
        expiresAt: 90,
        nonce: "c",
        parentTaskId: "task",
      }).initiatorUserId
    ).toBe("u");
    expect(() =>
      attenuateDelegation(parent, {
        subject: "child",
        resources: ["other"],
        actions: ["read"],
        expiresAt: 90,
        nonce: "c",
      })
    ).toThrow();
  });
});

describe("AVOS skills and cognition", () => {
  it("distills traces under /.avos and emits a source-free catalog", () => {
    const skill = distillTrace("check-orders", [
      { operation: "stripe", input: { status: "open" }, output: [] },
    ]);
    expect(skill.path).toBe("/.avos/shared/skills/check-orders.ts");
    expect(
      commandCatalog([
        { name: "stripe", description: "Payments", source: "secret source" },
      ])
    ).toEqual([{ name: "stripe", description: "Payments" }]);
  });

  it("scrubs sensitive egress values", () => {
    const result = scrubEgress("SSN 123-45-6789 card 4242 4242 4242 4242");
    expect(result.value).not.toContain("123-45-6789");
    expect(result.findings).toEqual(["ssn", "credit_card"]);
  });

  it("assembles immutable prompt layers and physically filters role tools", () => {
    expect(
      assembleSystemPrompt({
        kernel: "k",
        business: "b",
        soul: "s",
        founderDirectives: "f",
      })
    ).toContain("<soul>s</soul>");
    expect(
      applyAgentFirewall(
        [{ name: "read" }, { name: "shell" }],
        new Set(["read"])
      )
    ).toEqual([{ name: "read" }]);
  });

  it("validates planner DAGs", () => {
    validateTaskDag([
      { id: "plan", dependencies: [], status: "complete" },
      { id: "build", dependencies: ["plan"], status: "pending" },
    ]);
    expect(() =>
      validateTaskDag([
        { id: "a", dependencies: ["b"], status: "pending" },
        { id: "b", dependencies: ["a"], status: "pending" },
      ])
    ).toThrow("cyclic_task_dag");
  });

  it("prefilters memory before semantic gating and wraps it as untrusted", () => {
    const chunks = gateMemory(
      [
        {
          id: "ok",
          spaceId: "s",
          projectId: "p",
          roleMask: 2,
          similarity: 0.81,
          content: "safe",
        },
        {
          id: "role",
          spaceId: "s",
          projectId: "p",
          roleMask: 1,
          similarity: 0.99,
          content: "hidden",
        },
        {
          id: "score",
          spaceId: "s",
          projectId: "p",
          roleMask: 2,
          similarity: 0.8,
          content: "low",
        },
      ],
      { spaceId: "s", projectId: "p", roleMask: 2 }
    );
    expect(chunks.map((chunk) => chunk.id)).toEqual(["ok"]);
    expect(contextEnvelope(chunks)).toBe(
      '<context_chunk id="ok" trust="untrusted">safe</context_chunk>'
    );
  });

  it("starts threads clean and compacts after 25 turns", () => {
    expect(freshThreadContext("kernel", "truth")).toEqual(["kernel", "truth"]);
    const turns = Array.from({ length: 26 }, (_, index) => ({
      id: String(index),
      content: "turn",
    }));
    const compacted = compactContext(turns, "decision");
    expect(compacted.promptTurns).toHaveLength(10);
    expect(compacted.archived).toHaveLength(16);
  });

  it("constructs Parse v5 ingestion requests", () => {
    expect(createParseV5Request(new Uint8Array([1])).model).toBe("parse-v5.0");
    expect(() => createParseV5Request(new Uint8Array())).toThrow(
      "empty_document"
    );
  });
});
