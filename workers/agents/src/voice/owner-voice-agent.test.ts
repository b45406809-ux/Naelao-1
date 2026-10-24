import { describe, it, expect, vi } from "vitest";
vi.mock("agents", () => ({ Agent: class {} }));
vi.mock("agents/voice", () => ({
  withVoice: (Base: new (...args: never[]) => object) => Base,
  WorkersAIFluxSTT: class {},
}));
import { OwnerVoiceAgent } from "./owner-voice-agent.js";
const ticket = {
  tenantId: "tenant",
  spaceId: "space",
  sessionId: "session",
  userId: "user",
  callerRole: "product_end_user",
  role: "owner",
  agentName: "voice",
  nonce: crypto.randomUUID(),
  expiresAt: 9999999999,
};
function setup() {
  const agent = Object.create(OwnerVoiceAgent.prototype) as OwnerVoiceAgent;
  const allowed = vi.fn(async () => true),
    turn = vi.fn(async () => "Done");
  Object.assign(agent, {
    ctx: { id: { name: "voice" } },
    allowed,
    env: {
      PLATFORM_DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({
            run: vi.fn(async () => ({ meta: { changes: 1 } })),
          })),
        })),
      },
    },
    turns: { turn, pending: async () => false },
  });
  const context = {
    connection: { id: "connection", state: ticket, close: vi.fn() },
    signal: new AbortController().signal,
  };
  return { agent, allowed, turn, context };
}
describe("live voice planner permission checks", () => {
  it("uses the same scoped planner session", async () => {
    const f = setup();
    expect(await f.agent.onTurn("Work", f.context as never)).toBe("Done");
    expect(f.turn).toHaveBeenCalledWith(ticket, "Work", f.context.signal);
    expect(f.allowed).toHaveBeenCalledTimes(2);
  });
  it("blocks a revoked call before starting a planner task", async () => {
    const f = setup();
    f.allowed.mockResolvedValue(false);
    await expect(f.agent.onTurn("Work", f.context as never)).rejects.toThrow(
      "voice_scope_unavailable"
    );
    expect(f.turn).not.toHaveBeenCalled();
  });
  it("does not speak a result after permissions are revoked during the task", async () => {
    const f = setup();
    f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(f.agent.onTurn("Work", f.context as never)).rejects.toThrow(
      "voice_access_revoked"
    );
  });
  it("interrupts the completion watcher without cancelling or relaunching the task", async () => {
    const f = setup(),
      abort = new AbortController();
    Object.assign(f.agent, { watcher: abort, audioConnectionId: "connection" });
    await f.agent.onInterrupt(f.context.connection as never);
    expect(abort.signal.aborted).toBe(true);
    expect(f.turn).not.toHaveBeenCalled();
  });
});
