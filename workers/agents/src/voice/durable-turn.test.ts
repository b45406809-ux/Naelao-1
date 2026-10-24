import { describe, it, expect, vi } from "vitest";
import { DurableVoiceTurns } from "./durable-turn.js";
import type { OwnerVoiceTicket } from "./voice-ticket.js";
const ticket: OwnerVoiceTicket = {
  tenantId: "t",
  spaceId: "s",
  sessionId: "conversation",
  userId: "u",
  callerRole: "product_end_user",
  role: "owner",
  agentName: "voice",
  projectId: "p",
  nonce: crypto.randomUUID(),
  expiresAt: 10000,
};
function fixture(responses: Response[]) {
  const data = new Map<string, unknown>();
  const journal = {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      data.set(key, value);
    },
  };
  const fetch = vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error("offline");
    return response;
  });
  return {
    data,
    fetch,
    turns: new DurableVoiceTurns(
      journal,
      { fetch } as unknown as Fetcher,
      "secret"
    ),
  };
}
describe("durable voice task continuity", () => {
  it("uses the normal durable planner route and caches immediate duplicate utterances", async () => {
    const f = fixture([
      Response.json({ run_id: "task-1" }, { status: 202 }),
      Response.json({ status: "completed", final_answer: "Done" }),
    ]);
    expect(await f.turns.turn(ticket, "Do the work")).toBe("Done");
    expect(await f.turns.turn(ticket, "Do the work")).toBe("Done");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    const request = (f.fetch.mock.calls as unknown as [Request][])[0]![0];
    expect(request.headers.get("prefer")).toBe("respond-async");
    expect(request.headers.get("x-naelao-user-id")).toBe("u");
    expect(await request.json()).toEqual({
      goal: "Do the work",
      project_id: "p",
    });
  });
  it("holds unknown dispatch outcomes instead of duplicating an action", async () => {
    const f = fixture([]);
    await expect(f.turns.turn(ticket, "Send it")).rejects.toThrow("offline");
    expect(await f.turns.turn(ticket, "Retry sending")).toContain(
      "could not confirm"
    );
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps approval pauses in the existing task and resumes that task after reconnect", async () => {
    const f = fixture([
      Response.json({ run_id: "task-1" }),
      Response.json({
        status: "awaiting_approval",
        pending_approval: { id: "approval" },
      }),
      Response.json({ status: "completed", final_answer: "Approved and done" }),
    ]);
    expect(await f.turns.turn(ticket, "Send it")).toContain(
      "approval in Naelao"
    );
    expect(await f.turns.turn(ticket, "Is it ready?")).toBe(
      "Approved and done"
    );
    const requests = f.fetch.mock.calls as unknown as [Request][];
    expect(requests.filter(([r]) => r.method === "POST")).toHaveLength(1);
    expect(requests[2]![0].url).toContain("/runs/task-1");
  });
  it("persists a task receipt even if speech is interrupted during dispatch", async () => {
    const controller = new AbortController();
    const f = fixture([]);
    f.fetch.mockImplementationOnce(async () => {
      controller.abort();
      return Response.json({ run_id: "task-1" });
    });
    await expect(
      f.turns.turn(ticket, "Work", controller.signal)
    ).rejects.toThrow("voice_turn_cancelled");
    expect(f.data.get("voice:pending")).toMatchObject({
      state: "running",
      runId: "task-1",
    });
  });
  it("rejects empty and oversized utterances without model work", async () => {
    const f = fixture([]);
    await expect(f.turns.turn(ticket, " ")).rejects.toThrow(
      "voice_transcript_invalid"
    );
    await expect(f.turns.turn(ticket, "x".repeat(2001))).rejects.toThrow(
      "voice_transcript_invalid"
    );
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("serializes concurrent turns so a second utterance cannot start duplicate work", async () => {
    const f = fixture([
      Response.json({ run_id: "task-1" }),
      Response.json({ status: "completed", final_answer: "Done" }),
    ]);
    const results = await Promise.all(
      Array.from({ length: 100 }, () => f.turns.turn(ticket, "Work"))
    );
    expect(results.filter((r) => r === "Done")).toHaveLength(1);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("completion watchers can never start a new planner request", async () => {
    const f = fixture([
      Response.json({ run_id: "task-1" }),
      Response.json({ status: "completed", final_answer: "Done" }),
    ]);
    expect(await f.turns.resume(ticket)).toBe("");
    expect(f.fetch).not.toHaveBeenCalled();
    await f.turns.turn(ticket, "Work");
    expect(await f.turns.resume(ticket)).toBe("");
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("saves the caller's words in the same conversation before dispatching work", async () => {
    const data = new Map<string, unknown>();
    const journal = {
      get: async <T>(key: string) => data.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => {
        data.set(key, value);
      },
    };
    const requests: Request[] = [];
    const spaces = {
      fetch: vi.fn(async (r: Request) => {
        requests.push(r);
        return Response.json({ id: "message" });
      }),
    } as unknown as Fetcher;
    let n = 0;
    const worker = {
      fetch: vi.fn(async () =>
        ++n === 1
          ? Response.json({ run_id: "task" })
          : Response.json({ status: "completed", final_answer: "Done" })
      ),
    } as unknown as Fetcher;
    const turns = new DurableVoiceTurns(journal, worker, "secret", spaces);
    await turns.turn(ticket, "Remember the constraints");
    await turns.turn(ticket, "Remember the constraints");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain("/sessions/conversation/messages");
    expect(await requests[0]!.json()).toMatchObject({
      role: "user",
      content: "Remember the constraints",
      client_message_id: expect.stringMatching(/^voice-/),
    });
  });
});
