import { describe, expect, it, vi } from "vitest";
import { ConcurrencyDO } from "./ConcurrencyDO.js";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";

function harness() {
  const locks = new Map<string, { holder_id: string; acquired_at: number; expires_at: number; fencing_token: number }>();
  const fences = new Map<string, number>();
  const pacers = new Map<string, number>();
  const holds = new Map<string, { holder_id: string; acquired_at: number; expires_at: number; confirmed: number }>();
  const nodeLeases = new Map<string, { resource_key: string; node_id: string; holder_type: "HUMAN" | "AGENT"; holder_id: string; acquired_at: number; expires_at: number }>();
  let alarm: number | null = null;
  const sql = {
    exec(query: string, ...args: unknown[]) {
      if (query.includes("DELETE FROM locks WHERE key = ? AND expires_at")) {
        const row = locks.get(String(args[0]));
        if (row && row.expires_at <= Number(args[1])) locks.delete(String(args[0]));
      } else if (query.includes("DELETE FROM locks WHERE key = ? AND holder_id = ? AND fencing_token = ?")) {
        const row = locks.get(String(args[0]));
        if (row?.holder_id === args[1] && row.fencing_token === args[2]) locks.delete(String(args[0]));
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
      } else if (query.includes("DELETE FROM node_leases WHERE expires_at")) {
        for (const [key, row] of nodeLeases) if (row.expires_at <= Number(args[0])) nodeLeases.delete(key);
      } else if (query.includes("INSERT INTO node_leases")) {
        const key = `${args[0]}:${args[1]}`;
        nodeLeases.set(key, { resource_key: String(args[0]), node_id: String(args[1]), holder_type: args[2] as "HUMAN" | "AGENT", holder_id: String(args[3]), acquired_at: Number(args[4]), expires_at: Number(args[5]) });
      } else if (query.includes("UPDATE node_leases SET expires_at")) {
        const key = `${args[1]}:${args[2]}`; const row = nodeLeases.get(key);
        const changed = Boolean(row?.holder_type === args[3] && row.holder_id === args[4] && row.expires_at > Number(args[5]));
        if (changed) row!.expires_at = Number(args[0]);
        return { rowsWritten: changed ? 1 : 0, toArray: () => [] };
      } else if (query.includes("DELETE FROM node_leases WHERE resource_key")) {
        const key = `${args[0]}:${args[1]}`; const row = nodeLeases.get(key);
        if (row?.holder_type === args[2] && row.holder_id === args[3]) nodeLeases.delete(key);
        return { rowsWritten: row?.holder_type === args[2] && row.holder_id === args[3] ? 1 : 0, toArray: () => [] };
      }
      const toArray = () => {
        if (query.includes("SELECT holder_type,holder_id,expires_at FROM node_leases")) {
          const row = nodeLeases.get(`${args[0]}:${args[1]}`); return row ? [row] : [];
        }
        if (query.includes("SELECT holder_id, expires_at, fencing_token FROM locks")) {
          const row = locks.get(String(args[0])); return row ? [row] : [];
        }
        if (query.includes("SELECT holder_id,fencing_token FROM locks")) {
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
            ...[...nodeLeases.values()].map((x) => x.expires_at),
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
  return { instance: new ConcurrencyDO(ctx as never, {}), locks, holds, nodeLeases, getAlarm: () => alarm };
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

  it("requires the current fencing token when releasing a renewed lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const h = harness();
    const send = (path: string, body: Record<string, unknown>) => h.instance.fetch(new Request(`http://do/locks/${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    const first = await (await send("acquire", { key: "row", holderId: "run" })).json<{ fencingToken: number }>();
    vi.advanceTimersByTime(30_001);
    const second = await (await send("acquire", { key: "row", holderId: "run" })).json<{ fencingToken: number }>();
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
    expect(await (await send("release", { key: "row", holderId: "run", fencingToken: first.fencingToken })).json()).toMatchObject({ released: false });
    expect(h.locks.get("row")?.fencing_token).toBe(second.fencingToken);
    expect(await (await send("release", { key: "row", holderId: "run", fencingToken: second.fencingToken })).json()).toMatchObject({ released: true });
    expect(h.locks.has("row")).toBe(false);
    vi.useRealTimers();
  });

  it("rejects malformed lock identities and TTLs before touching the lease table", async () => {
    const h = harness();
    const send = (path: string, body: string) => h.instance.fetch(new Request(`http://do/locks/${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body,
    }));
    expect((await send("acquire", "null")).status).toBe(400);
    expect((await send("acquire", JSON.stringify({ key: "row", holderId: "run", ttlMs: "30000" }))).status).toBe(400);
    expect((await send("acquire", JSON.stringify({ key: "row", holderId: "run", ttlMs: 1e100 }))).status).toBe(400);
    expect((await send("renew", "null")).status).toBe(400);
    expect((await send("release", JSON.stringify({ key: "row", holderId: "run" }))).status).toBe(400);
    expect(h.locks.size).toBe(0);
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

describe("ConcurrencyDO node leases", () => {
  it("serializes node edits, lets a human preempt an agent, and requires exact owner to renew/release", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const h = harness();
    const send = (path: string, body: Record<string, unknown>) => h.instance.fetch(new Request(`http://do/node-leases/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const agent = { resourceKey: "space:s:project:p", nodeId: "clause-8", holderId: "agent-1", holderType: "AGENT" };
    const human = { ...agent, holderId: "user-1", holderType: "HUMAN" };
    expect(await (await send("claim", agent)).json()).toMatchObject({ acquired: true, ttlMs: 15_000 });
    expect((await send("claim", { ...agent, holderId: "agent-2" })).status).toBe(409);
    expect(await (await send("claim", human)).json()).toMatchObject({ acquired: true, holderType: "HUMAN" });
    expect((await send("renew", agent)).status).toBe(409);
    expect(await (await send("release", agent)).json()).toMatchObject({ released: false });
    expect(await (await send("release", human)).json()).toMatchObject({ released: true });
    vi.useRealTimers();
  });

  it("expires abandoned node leases after the fixed heartbeat window", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const h = harness();
    const request = () => h.instance.fetch(new Request("http://do/node-leases/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resourceKey: "space:s", nodeId: "row-1", holderId: "user", holderType: "HUMAN" }) }));
    expect((await request()).status).toBe(200);
    vi.advanceTimersByTime(15_000); await h.instance.alarm();
    expect(h.nodeLeases.size).toBe(0);
    vi.useRealTimers();
  });
});

describe("ConcurrencyDO slot admission bounds", () => {
  it("caps caller supplied slot capacity and cannot turn a malformed request into unlimited admission", async () => {
    const storage = Object.assign(createDOStorage(), {
      getAlarm: async () => null,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    });
    const object = new ConcurrencyDO({ storage } as never, {});
    const acquire = (holder: string, limit: number) => object.fetch(new Request("http://do/acquire", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "resource", holder_id: holder, limit }),
    }));

    for (let i = 0; i < 100; i++) {
      const response = await acquire(`holder-${i}`, 1_000_000);
      expect((await response.json()).granted).toBe(true);
    }
    const overflow = await acquire("holder-overflow", 1_000_000);
    expect(await overflow.json()).toMatchObject({ granted: false, active: 100, limit: 100 });
    const fractional = await acquire("holder-fractional", 0.5);
    expect(fractional.status).toBe(400);
  });

  it("rejects malformed slot input and clamps leases to the stale-slot ceiling", async () => {
    const storage = Object.assign(createDOStorage(), {
      getAlarm: async () => null,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    });
    const object = new ConcurrencyDO({ storage } as never, {});
    const send = (body: string) => object.fetch(new Request("http://do/acquire", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    }));
    expect((await send("null")).status).toBe(400);
    expect((await send(JSON.stringify({ key: "x".repeat(513), holder_id: "worker" }))).status).toBe(400);
    expect((await send(JSON.stringify({ key: "resource", holder_id: "worker", ttl_ms: 1.5 }))).status).toBe(400);
    expect((await send(JSON.stringify({ key: "resource", holder_id: 42 }))).status).toBe(400);
    const accepted = await send(JSON.stringify({ key: "resource", holder_id: "worker", ttl_ms: Number.MAX_SAFE_INTEGER }));
    expect(accepted.status).toBe(200);
    const row = storage.sql.exec("SELECT expires_at - acquired_at AS ttl FROM slots WHERE key = ?", "resource").toArray()[0] as { ttl: number };
    expect(row.ttl).toBe(30 * 60 * 1000);
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
