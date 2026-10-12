import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayReasoner } from "../../workers/agents/src/script-engine/reasoner.js";

const GATEWAY = { accountId: "acct", gatewayId: "gw", aigToken: "aig-token" };
const CTX = { spaceId: "space-1" };

describe("model placement policy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses cloud models in an air-gapped space without trying provider or gateway fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const localCompletion = vi.fn();
    const reasoner = new GatewayReasoner({
      apiKey: "configured-cloud-key",
      gateway: GATEWAY,
      ctx: CTX,
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      airGappedOnly: true,
      localCompletion,
    });
    const decision = await reasoner.decide({ goal: "g", level: 2, snapshot: {}, candidates: [], availableOperations: [] });
    expect(decision).toMatchObject({ action: "give_up", reason: expect.stringContaining("only permit local/* models") });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(localCompletion).not.toHaveBeenCalled();
  });

  it("dispatches local/* models only through the configured local runner", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const localCompletion = vi.fn(async (payload: Record<string, unknown>) => {
      expect(payload.model).toBe("llama3.1:8b");
      return { content: [{ type: "tool_use", name: "Bash", input: { command: "echo local", doing: "Working locally" } }] };
    });
    const reasoner = new GatewayReasoner({
      apiKey: "",
      gateway: GATEWAY,
      ctx: CTX,
      model: "local/llama3.1:8b",
      airGappedOnly: true,
      localCompletion,
    });
    const decision = await reasoner.decide({ goal: "g", level: 2, snapshot: {}, candidates: [], availableOperations: ["Bash"] });
    expect(decision).toMatchObject({ action: "run", name: "Bash", params: { commands: "echo local" } });
    expect(localCompletion).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
