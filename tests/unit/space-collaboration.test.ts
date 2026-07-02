import { describe, it, expect, beforeEach, vi } from "vitest";
import { SpaceDO, PRESENCE_PRUNE_CUTOFF_MS } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOSqlStorage, type DOSqlStorage } from "./helpers/sqlite-do-shim.js";
import { nameSimilarity, findPossibleDuplicateProjects, isPresenceFresh, PRESENCE_FRESHNESS_WINDOW_MS } from "@naelao/events";

// Space collaboration (A1.8): "two members' assistants do not build two companies because
// they read/write the same shared state." Locks + presence + project deduplication is the
// coordination surface; locks already existed (LockDO/A1.15). This adds presence (a
// heartbeat-based "who's active where") and project deduplication (a name-similarity heads-up
// on project creation, since exact-name idempotency already existed).

function makeSpaceDO(env: Record<string, unknown> = {}): SpaceDO {
  const ctx = { storage: { sql: createDOSqlStorage() } };
  return new SpaceDO(ctx as never, { PLATFORM_SECRET: "test-secret", ...env } as never);
}

async function call(doInstance: SpaceDO, path: string, method: string, body?: unknown): Promise<{ status: number; json: any }> {
  const resp = await doInstance.fetch(
    new Request(`http://space-do${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );
  const json = await resp.json().catch(() => null);
  return { status: resp.status, json };
}

// ── Pure dedup logic ──────────────────────────────────────────────────────────
describe("@naelao/events — project name similarity", () => {
  it("identical names score 1.0", () => {
    expect(nameSimilarity("Support", "Support")).toBe(1);
  });

  it("completely unrelated names score 0", () => {
    expect(nameSimilarity("Support", "Marketing Campaigns")).toBe(0);
  });

  it("a superset name (shared tokens) scores >= the duplicate threshold", () => {
    expect(nameSimilarity("Support", "Support Escalations")).toBeGreaterThanOrEqual(0.5);
  });

  it("is case- and punctuation-insensitive", () => {
    expect(nameSimilarity("Q1 Launch!", "q1 launch")).toBe(1);
  });

  it("findPossibleDuplicateProjects returns matches sorted by similarity, excluding weak matches", () => {
    const existing = [
      { id: "p1", name: "Content" }, // {content} vs {content,marketing} -> 1/2 = 0.5, at threshold
      { id: "p2", name: "Support" }, // {support} vs {content,marketing} -> 0, excluded
      { id: "p3", name: "Content Marketing" }, // exact token match -> 1.0, most similar
    ];
    const dupes = findPossibleDuplicateProjects("Content Marketing", existing);
    expect(dupes.map((d) => d.id)).toEqual(["p3", "p1"]);
  });

  it("returns nothing when no existing project is similar enough", () => {
    const existing = [{ id: "p1", name: "Billing Support" }];
    expect(findPossibleDuplicateProjects("Newsletter Drafts", existing)).toEqual([]);
  });
});

describe("@naelao/events — presence freshness", () => {
  it("a recent heartbeat is fresh", () => {
    expect(isPresenceFresh(1_000, 1_000 + 30_000)).toBe(true);
  });

  it("a heartbeat older than the window is not fresh", () => {
    expect(isPresenceFresh(0, PRESENCE_FRESHNESS_WINDOW_MS + 1)).toBe(false);
  });

  it("respects a custom window", () => {
    expect(isPresenceFresh(0, 5_000, 10_000)).toBe(true);
    expect(isPresenceFresh(0, 15_000, 10_000)).toBe(false);
  });
});

// ── SpaceDO: project creation surfaces possible duplicates (heads-up, never a block) ────────
describe("SpaceDO — project deduplication", () => {
  let spaceDO: SpaceDO;

  beforeEach(() => {
    spaceDO = makeSpaceDO();
  });

  it("creating a genuinely new, unrelated project reports no duplicates", async () => {
    const res = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "Orders" });
    expect(res.status).toBe(201);
    expect(res.json.possible_duplicates).toEqual([]);
  });

  it("creating a project similar to an existing one reports it as a possible duplicate but still creates it", async () => {
    await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "Support" });
    const res = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "Support Escalations" });
    expect(res.status).toBe(201); // never blocked
    expect(res.json.name).toBe("Support Escalations");
    expect(res.json.possible_duplicates).toHaveLength(1);
    expect(res.json.possible_duplicates[0].name).toBe("Support");
  });

  it("re-creating the exact same project (idempotent hit) reports no duplicates for itself", async () => {
    await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "Orders" });
    const res = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "Orders" });
    expect(res.status).toBe(201);
    expect(res.json.possible_duplicates).toEqual([]);
  });

  it("an archived project is not flagged as a duplicate candidate", async () => {
    const first = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "Support" });
    await call(spaceDO, `/projects/${first.json.id}`, "PATCH", { status: "archived" });
    const res = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "Support Desk" });
    expect(res.json.possible_duplicates).toEqual([]);
  });

  it("fires a project.possible_duplicate trigger (bounded fan-out, no LLM cost) when a duplicate is found", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    const doWithTriggers = makeSpaceDO({ AGENTS_WORKER: { fetch: fetchMock } });

    await call(doWithTriggers, "/event-triggers", "POST", {
      space_id: "space1",
      event_type: "project.possible_duplicate",
      condition: { type: "always" },
      script_name: "notifications.notify_admin",
    });

    await call(doWithTriggers, "/projects", "POST", { space_id: "space1", name: "Support" });
    fetchMock.mockClear();
    await call(doWithTriggers, "/projects", "POST", {
      space_id: "space1", name: "Support Desk", tenant_id: "tenant-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // fireMatchingTriggers calls fetch(request) with a single Request object (not (url, init)).
    const [firedRequest] = fetchMock.mock.calls[0] as [Request];
    const firedBody = await firedRequest.json() as { scriptName: string };
    expect(firedBody.scriptName).toBe("notifications.notify_admin");
  });
});

// ── SpaceDO: presence ─────────────────────────────────────────────────────────
describe("SpaceDO — presence", () => {
  let spaceDO: SpaceDO;

  beforeEach(() => {
    spaceDO = makeSpaceDO();
  });

  it("a heartbeat with no project/thread records space-level presence", async () => {
    const res = await call(spaceDO, "/presence", "POST", { space_id: "space1", user_id: "user-1" });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);

    const list = await call(spaceDO, "/presence?space_id=space1", "GET");
    expect(list.json.data).toHaveLength(1);
    expect(list.json.data[0]).toMatchObject({ user_id: "user-1", project_id: null });
  });

  it("scopes presence to a project when queried with project_id", async () => {
    await call(spaceDO, "/presence", "POST", { space_id: "space1", user_id: "user-1", project_id: "proj-A" });
    await call(spaceDO, "/presence", "POST", { space_id: "space1", user_id: "user-2", project_id: "proj-B" });

    const inA = await call(spaceDO, "/presence?space_id=space1&project_id=proj-A", "GET");
    expect(inA.json.data).toHaveLength(1);
    expect(inA.json.data[0].user_id).toBe("user-1");

    const spaceWide = await call(spaceDO, "/presence?space_id=space1", "GET");
    expect(spaceWide.json.data).toHaveLength(2);
  });

  it("a second heartbeat from the same user updates their location rather than duplicating", async () => {
    await call(spaceDO, "/presence", "POST", { space_id: "space1", user_id: "user-1", project_id: "proj-A" });
    await call(spaceDO, "/presence", "POST", { space_id: "space1", user_id: "user-1", project_id: "proj-B" });

    const list = await call(spaceDO, "/presence?space_id=space1", "GET");
    expect(list.json.data).toHaveLength(1);
    expect(list.json.data[0].project_id).toBe("proj-B");
  });

  it("a stale heartbeat ages out of the active list", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      await call(spaceDO, "/presence", "POST", { space_id: "space1", user_id: "user-1" });

      vi.setSystemTime(PRESENCE_FRESHNESS_WINDOW_MS + 1);
      const list = await call(spaceDO, "/presence?space_id=space1", "GET");
      expect(list.json.data).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a heartbeat missing user_id", async () => {
    const res = await call(spaceDO, "/presence", "POST", { space_id: "space1" });
    expect(res.status).toBe(400);
  });

  it("presence is isolated per space", async () => {
    await call(spaceDO, "/presence", "POST", { space_id: "space1", user_id: "user-1" });
    const otherSpace = await call(spaceDO, "/presence?space_id=space2", "GET");
    expect(otherSpace.json.data).toEqual([]);
  });

  // A1.16.15: presence's PK is (space_id, user_id) — a row only grows the table on a brand-new
  // user's first heartbeat, but then lives forever (isPresenceFresh only filters GET, it never
  // deletes). heartbeatPresence now opportunistically prunes rows older than
  // PRESENCE_PRUNE_CUTOFF_MS (24h) on every heartbeat — these two tests need to see past the
  // HTTP layer (GET only ever returns fresh rows either way) to distinguish "filtered from the
  // active list" from "physically deleted," so they construct the DO with direct access to the
  // underlying SQL storage rather than using the shared `spaceDO`/`call` helpers above.
  function makeSpaceDOWithSql(): { doInstance: SpaceDO; sql: DOSqlStorage } {
    const sql = createDOSqlStorage();
    const doInstance = new SpaceDO({ storage: { sql } } as never, { PLATFORM_SECRET: "test-secret" } as never);
    return { doInstance, sql };
  }

  function presenceRowCount(sql: DOSqlStorage, spaceId: string, userId: string): number {
    return sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM presence WHERE space_id = ? AND user_id = ?",
      spaceId, userId
    ).toArray()[0]!.n;
  }

  it("a >24h-stale row is physically deleted (not just filtered) after another user's heartbeat", async () => {
    const { doInstance, sql } = makeSpaceDOWithSql();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      await call(doInstance, "/presence", "POST", { space_id: "space1", user_id: "user-1" });
      expect(presenceRowCount(sql, "space1", "user-1")).toBe(1);

      vi.setSystemTime(PRESENCE_PRUNE_CUTOFF_MS + 1);
      // A DIFFERENT user's heartbeat is what triggers the opportunistic prune.
      await call(doInstance, "/presence", "POST", { space_id: "space1", user_id: "user-2" });

      expect(presenceRowCount(sql, "space1", "user-1")).toBe(0); // physically gone
      expect(presenceRowCount(sql, "space1", "user-2")).toBe(1); // the fresh heartbeat itself survives
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stale-but-<24h row is filtered from GET but still physically present in the table", async () => {
    const { doInstance, sql } = makeSpaceDOWithSql();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      await call(doInstance, "/presence", "POST", { space_id: "space1", user_id: "user-1" });

      // Past isPresenceFresh's ~90s window (so GET excludes it) but well under the 24h prune
      // cutoff (so the prune must NOT touch it).
      vi.setSystemTime(PRESENCE_FRESHNESS_WINDOW_MS + 1);
      expect(PRESENCE_FRESHNESS_WINDOW_MS + 1).toBeLessThan(PRESENCE_PRUNE_CUTOFF_MS);
      await call(doInstance, "/presence", "POST", { space_id: "space1", user_id: "user-2" });

      const list = await call(doInstance, "/presence?space_id=space1", "GET");
      expect(list.json.data.map((r: { user_id: string }) => r.user_id)).toEqual(["user-2"]); // user-1 filtered out

      expect(presenceRowCount(sql, "space1", "user-1")).toBe(1); // but still in the table
    } finally {
      vi.useRealTimers();
    }
  });
});
