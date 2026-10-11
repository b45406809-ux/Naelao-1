import { describe, expect, it, vi } from "vitest";
import { ConcurrencyDO } from "./ConcurrencyDO.js";

function harness() {
  const locks = new Map<string, { holder_id: string; acquired_at: number; expires_at: number; fencing_token: number }>();
  const fences = new Map<string, number>();
  const pacers = new Map<string, number>();
  const holds = new Map<string, { holder_id: string; acquired_at: number; expires_at: number; confirmed: number }>();
  let alarm: number | null = null;
  const sql = {
    exec(query: string, ...args: unknown[]) {
      if (query.includes("DELETE FROM locks WHERE key = ? AND expires_at")) {
        const row = locks.get(String(args[0]));
        if (row && row.expires_at <= Number(args[1])) locks.delete(String(args[0]));
      } else if (query.includes("DELETE FROM locks WHERE key = ? AND holder_id")) {
        const row = locks.get(String(args[0]));
        if (row?.holder_id === args[1]) locks.delete(String(args[0]));
      } else if (query.includes("DELETE FROM locks WHERE key = ?")) locks.delete(String(args[0]));
      else if (query.includes("DELETE FROM locks WHERE expires_at")) {
        for (const [key, row] of locks) if (row.expires_at <= Number(args[0])) locks.delete(key);
      } else if (query.includes("INSERT INTO lock_fences")) {
        fences.set(String(args[0]), Number(args[1]));
      } else if (query.includes("INSERT INTO locks")) {
        locks.set(String(args[0]), { holder_id: String(args[1]), acquired_at: Number(args[2]), expires_at: Number(args[3]), fencing_token: Number(args[4]) });
      } else if (query.includes("INSERT INTO outbound_pacers")) {
        pacers.set(String(args[0]), Number(args[1]));
      } else if (query.includes("DELETE FROM appointment_slot_holds WHERE confirmed=0 AND expires_at")) {
        for (const [key, row] of holds) if (!row.confirmed && row.expires_at <= Number(args[0])) holds.delete(key);
      } else if (query.includes("INSERT INTO appointment_slot_holds")) {
        holds.set(String(args[0]), { holder_id: String(args[1]), acquired_at: Number(args[2]), expires_at: Number(args[3]), confirmed: 0 });
      } else if (query.includes("UPDATE appointment_slot_holds SET confirmed=1")) {
        const row = holds.get(String(args[0]));
        if (row?.holder_id === args[1] && !row.confirmed && row.expires_at > Number(args[2])) row.confirmed = 1;
        return { rowsWritten: row?.confirmed ? 1 : 0, toArray: () => [] };
      } else if (query.includes("DELETE FROM appointment_slot_holds WHERE slot_key")) {
        const row = holds.get(String(args[0]));
        if (row?.holder_id === args[1] && !row.confirmed) holds.delete(String(args[0]));
      }
      const toArray = () => {
        if (query.includes("SELECT holder_id, expires_at, fencing_token FROM locks")) {
          const row = locks.get(String(args[0])); return row ? [row] : [];
        }
        if (query.includes("SELECT fencing_token FROM lock_fences")) {
          const fencing_token = fences.get(String(args[0])); return fencing_token === undefined ? [] : [{ fencing_token }];
        }
        if (query.includes("SELECT holder_id, expires_at FROM locks")) {
          const row = locks.get(String(args[0])); return row ? [row] : [];
        }
        if (query.includes("SELECT holder_id FROM locks")) {
          const row = locks.get(String(args[0])); return row ? [row] : [];
        }
        if (query.includes("MIN(expires_at)")) {
          const expiries = [
            ...[...locks.values()].map((x) => x.expires_at),
            ...[...holds.values()].filter((x) => !x.confirmed).map((x) => x.expires_at),
          ];
          return [{ expires_at: expiries.length ? Math.min(...expiries) : null }];
        }
        if (query.includes("SELECT next_release_at")) {
          const next_release_at = pacers.get(String(args[0]));
          return next_release_at === undefined ? [] : [{ next_release_at }];
        }
        if (query.includes("SELECT holder_id,expires_at,confirmed FROM appointment_slot_holds")) {
          const row = holds.get(String(args[0])); return row ? [row] : [];
        }
        return [];
      };
      return { toArray };
    },
  };
  const ctx = { storage: { sql, getAlarm: async () => alarm, setAlarm: async (value: number) => { alarm = value; }, deleteAlarm: async () => { alarm = null; } } };
  return { instance: new ConcurrencyDO(ctx as never, {}), locks, holds, getAlarm: () => alarm };
}

describe("ConcurrencyDO file mutexes", () => {
  it("grants one holder, reports contention, and expires it through the alarm", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const h = harness();
    const acquire = (holderId: string) => h.instance.fetch(new Request("http://do/locks/acquire", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "src/a.ts", holderId }),
    })).then((r) => r.json<Record<string, unknown>>());

    expect(await acquire("agent-a")).toMatchObject({ acquired: true, ttlMs: 30_000 });
    expect(await acquire("agent-b")).toMatchObject({ acquired: false, heldBy: "agent-a", remainingMs: 30_000 });
    expect(h.getAlarm()).toBe(Date.now() + 30_000);
    vi.advanceTimersByTime(30_000);
    await h.instance.alarm();
    expect(h.locks.size).toBe(0);
    expect(await acquire("agent-b")).toMatchObject({ acquired: true, holderId: "agent-b" });
    vi.useRealTimers();
  });
});

describe("ConcurrencyDO appointment slot holds", () => {
  it("exclusively holds a slot for exactly 15 seconds and then auto-expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const h = harness();
    const acquire = (holderId: string) => h.instance.acquireSlotHold({ slotKey: "cal:2026-01-02T10:00:00Z", holderId }).then((r) => r.json<Record<string, unknown>>());
    expect(await acquire("caller-a")).toMatchObject({ success: true, ttlMs: 15_000 });
    expect(h.getAlarm()).toBe(Date.now() + 15_000);
    expect(await acquire("caller-b")).toMatchObject({ success: false, reason: "SLOT_TENTATIVELY_HELD", remainingSeconds: 15 });
    vi.advanceTimersByTime(5_000);
    expect(await acquire("caller-a")).toMatchObject({ success: true, remainingSeconds: 10 });
    expect(h.getAlarm()).toBe(Date.now() + 10_000);
    vi.advanceTimersByTime(10_000);
    await h.instance.alarm();
    expect(h.holds.size).toBe(0);
    expect(h.getAlarm()).toBeNull();
    expect(await acquire("caller-b")).toMatchObject({ success: true, holderId: "caller-b" });
    vi.useRealTimers();
  });
});

describe("ConcurrencyDO outbound pacing", () => {
  it("spaces reservations to no more than five requests per second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { instance } = harness();
    const pending = Array.from({ length: 6 }, () => instance.paceOutboundRequest({ domain: "https://api.hubspot.com/path", maxPerSecond: 5 }));
    await vi.advanceTimersByTimeAsync(1_000);
    const releases = (await Promise.all(pending)).map((result) => result.releasedAt);
    expect(releases).toEqual(releases.map((_, index) => releases[0]! + index * 200));
    expect(releases[5]! - releases[0]!).toBe(1_000);
    vi.useRealTimers();
  });

  it("does not allow callers to override the five requests per second ceiling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { instance } = harness();
    const pending = Array.from({ length: 6 }, () => instance.paceOutboundRequest({ domain: "api.example.com", maxPerSecond: 500 }));
    await vi.advanceTimersByTimeAsync(1_000);
    const releases = (await Promise.all(pending)).map((result) => result.releasedAt);
    expect(releases[5]! - releases[0]!).toBe(1_000);
    vi.useRealTimers();
  });
});
