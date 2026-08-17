import { describe, it, expect } from "vitest";
import { r2Workspace } from "../../workers/agents/src/script-engine/prebuilt/r2-workspace.js";
import { schedule, cronForDelay } from "../../workers/agents/src/script-engine/prebuilt/schedule.js";
import type { PrebuiltOpContext } from "../../workers/agents/src/script-engine/prebuilt/index.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

// Step 3: chunked read + search_file. Step 12: self-scheduling (schedule.wake_me/list/cancel).

// Range-aware R2 mock (the file-size test's mock doesn't honor a range option).
function makeR2(initial: Record<string, string> = {}): R2Bucket {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    async put(key: string, value: unknown) { store.set(key, String(value)); return {} as R2Object; },
    async get(key: string, opts?: { range?: { offset: number; length: number } }) {
      if (!store.has(key)) return null;
      const full = store.get(key)!;
      const r = opts?.range;
      const text = r ? full.slice(r.offset, r.offset + r.length) : full;
      return { size: full.length, uploaded: new Date("2026-01-01T00:00:00Z"), async text() { return text; } } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      if (!store.has(key)) return null;
      return { size: store.get(key)!.length, uploaded: new Date("2026-01-01T00:00:00Z") } as unknown as R2Object;
    },
    async delete() {},
    async list() { return { objects: [], truncated: false } as unknown as R2Objects; },
  } as unknown as R2Bucket;
}

function makeCtx(bucket: R2Bucket): PrebuiltOpContext {
  const env = { spaceId: "space-1", agentId: "agent-1", tenantId: "tenant-1", scriptsBucket: bucket } as unknown as ScriptEngineEnv;
  return { env, run: async () => ({}) };
}

const readFile = r2Workspace.operations["read_file"]!;
const searchFile = r2Workspace.operations["search_file"]!;

describe("read_file — chunked/ranged read (step 3)", () => {
  it("reads only the requested byte range and reports how to continue", async () => {
    const content = "0123456789ABCDEFGHIJ"; // 20 chars
    const ctx = makeCtx(makeR2({ "spaces/space-1/workspace/data.txt": content }));
    const first = (await readFile({ path: "data.txt", offset: 0, length: 5 }, ctx)) as {
      content: string; offset: number; length: number; total_size: number; has_more: boolean; next_offset?: number;
    };
    expect(first.content).toBe("01234");
    expect(first.total_size).toBe(20);
    expect(first.has_more).toBe(true);
    expect(first.next_offset).toBe(5);

    const next = (await readFile({ path: "data.txt", offset: first.next_offset, length: 100 }, ctx)) as {
      content: string; has_more: boolean;
    };
    expect(next.content).toBe("56789ABCDEFGHIJ");
    expect(next.has_more).toBe(false);
  });

  it("returns an empty chunk (not an error) when offset is past the end", async () => {
    const ctx = makeCtx(makeR2({ "spaces/space-1/workspace/x.txt": "abc" }));
    const r = (await readFile({ path: "x.txt", offset: 10 }, ctx)) as { content: string; has_more: boolean };
    expect(r.content).toBe("");
    expect(r.has_more).toBe(false);
  });

  it("a full read of an oversized file refuses and points at chunked read / search_file", async () => {
    const big = "z".repeat(300_000);
    const ctx = makeCtx(makeR2({ "spaces/space-1/workspace/big.txt": big }));
    const r = (await readFile({ path: "big.txt" }, ctx)) as { too_large?: boolean; message?: string };
    expect(r.too_large).toBe(true);
    expect(r.message).toMatch(/offset|search_file/);
  });
});

describe("search_file (step 3)", () => {
  it("returns matching lines with line numbers", async () => {
    const text = ["alpha", "beta needle here", "gamma", "delta needle again", "epsilon"].join("\n");
    const ctx = makeCtx(makeR2({ "spaces/space-1/workspace/log.txt": text }));
    const r = (await searchFile({ path: "log.txt", query: "needle" }, ctx)) as {
      total_matches: number; matches: Array<{ line_number: number; text: string }>;
    };
    expect(r.total_matches).toBe(2);
    expect(r.matches.map((m) => m.line_number)).toEqual([2, 4]);
    expect(r.matches[0]!.text).toContain("needle");
  });

  it("includes surrounding context when asked", async () => {
    const text = ["l1", "l2", "target", "l4", "l5"].join("\n");
    const ctx = makeCtx(makeR2({ "spaces/space-1/workspace/c.txt": text }));
    const r = (await searchFile({ path: "c.txt", query: "target", context: 1 }, ctx)) as {
      matches: Array<{ context?: string }>;
    };
    expect(r.matches[0]!.context).toBe("l2\ntarget\nl4");
  });
});

// ── Step 12: schedule ───────────────────────────────────────────────────────────────────────
interface Call { method: string; url: string; body: unknown }

function makeScheduleCtx(calls: Call[], responder?: (c: Call) => unknown): PrebuiltOpContext {
  const spacesWorker = {
    async fetch(reqInput: Request | string, init?: RequestInit) {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      const body = await req.clone().json().catch(() => null);
      const call: Call = { method: req.method, url: req.url, body };
      calls.push(call);
      return Response.json((responder ? responder(call) : { id: "job-1" }) ?? {});
    },
  };
  const env = {
    spaceId: "space-1", agentId: "launchpad-support-v1", tenantId: "tenant-1", projectId: "proj-7",
    platformSecret: "secret", spacesWorker: spacesWorker as unknown as Fetcher,
  } as unknown as ScriptEngineEnv;
  return { env, run: async () => ({}) };
}

describe("cronForDelay (step 12)", () => {
  it("pins minute/hour/day/month for a specific future time", () => {
    const now = new Date("2026-03-15T10:20:00Z");
    // +100 minutes → 12:00 on the 15th
    expect(cronForDelay(100, now)).toBe("0 12 15 3 *");
  });
});

describe("schedule.wake_me (step 12)", () => {
  it("creates a one-shot goal-based job addressed at the current agent/project", async () => {
    const calls: Call[] = [];
    const ctx = makeScheduleCtx(calls, () => ({ id: "job-42" }));
    const res = (await schedule.operations["schedule.wake_me"]!(
      { goal: "check the research sub-agent", delay_minutes: 90 },
      ctx
    )) as { ok: boolean; id: string; one_shot: boolean };
    expect(res.ok).toBe(true);
    expect(res.id).toBe("job-42");
    expect(res.one_shot).toBe(true);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/spaces/space-1/scheduled-jobs");
    expect(body["goal"]).toBe("check the research sub-agent");
    expect(body["agent_id"]).toBe("launchpad-support-v1");
    expect(body["project_id"]).toBe("proj-7");
    expect(body["params"]).toEqual({ _one_shot: true });
  });

  it("a cron-based wake is recurring (not one-shot)", async () => {
    const calls: Call[] = [];
    const ctx = makeScheduleCtx(calls);
    const res = (await schedule.operations["schedule.wake_me"]!(
      { goal: "daily review", cron: "0 9 * * *" },
      ctx
    )) as { one_shot: boolean };
    expect(res.one_shot).toBe(false);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body["cron_expression"]).toBe("0 9 * * *");
    expect(body["params"]).toBeUndefined();
  });

  it("requires a goal and a delay or cron", async () => {
    const ctx = makeScheduleCtx([]);
    await expect(schedule.operations["schedule.wake_me"]!({ delay_minutes: 5 }, ctx)).rejects.toThrow(/goal/);
    await expect(schedule.operations["schedule.wake_me"]!({ goal: "x" }, ctx)).rejects.toThrow(/delay|cron/);
  });

  it("cancel deletes a job by id", async () => {
    const calls: Call[] = [];
    const ctx = makeScheduleCtx(calls);
    const res = (await schedule.operations["schedule.cancel"]!({ id: "job-9" }, ctx)) as { ok: boolean; cancelled: string };
    expect(res.ok).toBe(true);
    expect(res.cancelled).toBe("job-9");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toContain("/scheduled-jobs/job-9");
  });
});
