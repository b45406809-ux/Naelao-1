import { describe, it, expect, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";
const secret = "phone-extension-secret";
function setup(project: string | null) {
  const runChannel = vi.fn(async (_input: Record<string, unknown>) => ({
    ok: true,
    channel_replies: [
      JSON.stringify({ actions: [{ type: "say", text: "Hello" }] }),
    ],
  }));
  const agent = new NaelaoAgentDO(
    { storage: createDOStorage(), id: { toString: () => "agent" } } as never,
    {
      PLATFORM_SECRET: secret,
      PLATFORM_DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              installation_id: "install",
              handler_sha256: "a".repeat(64),
              status: "active",
              project_id: project,
              owner_user_id: "owner",
              provider: "twilio",
            }),
          }),
        }),
      },
    } as never
  );
  const internals = agent as unknown as {
    tenantSpaceSuspended: unknown;
    loadActiveChannelHandler: ReturnType<typeof vi.fn>;
    buildScriptEngineEnv: unknown;
  };
  internals.tenantSpaceSuspended = async () => false;
  internals.loadActiveChannelHandler = vi.fn(async () => ({
    name: "voice",
    code: "export async function run() {}",
    maxConcurrency: 1,
    knowledgeCollections: [],
    limits: {},
  }));
  internals.buildScriptEngineEnv = async () => ({ codeRunner: { runChannel } });
  return { agent, runChannel, internals };
}
async function invoke(agent: NaelaoAgentDO, valid = true) {
  return agent.fetch(
    new Request("http://agent/phone-extension", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": valid
          ? await mintInternalToken(secret, "tenant")
          : "bad",
      },
      body: JSON.stringify({
        spaceId: "space",
        bindingId: "binding",
        event: {
          id: "CA" + "a".repeat(32),
          type: "call.received",
          payload: { caller: "+15555550100" },
        },
      }),
    })
  );
}
describe("phone extension scope dispatch", () => {
  it.each([null, "project"])(
    "dispatches scope %s through the existing restricted executor without owner authority",
    async (project) => {
      const f = setup(project);
      expect((await invoke(f.agent)).status).toBe(200);
      expect(f.internals.loadActiveChannelHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          spaceId: "space",
          tenantId: "tenant",
          channel: "phone",
          ...(project ? { projectId: project } : {}),
        })
      );
      const input = f.runChannel.mock.calls[0]?.[0] as unknown as Record<
        string,
        unknown
      >;
      expect(input).not.toHaveProperty("userId");
      expect(input).not.toHaveProperty("callerRole");
      expect(input).toMatchObject({
        tenantId: "tenant",
        spaceId: "space",
        installationId: "install",
        channel: { provider: "phone" },
      });
    }
  );
  it("rejects unsigned dispatch and an unavailable installed handler", async () => {
    const f = setup(null);
    expect((await invoke(f.agent, false)).status).toBe(403);
    f.internals.loadActiveChannelHandler = vi.fn(async () => null);
    expect((await invoke(f.agent)).status).toBe(409);
    expect(f.runChannel).not.toHaveBeenCalled();
  });
});
