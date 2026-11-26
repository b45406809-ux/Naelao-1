import { describe, expect, it, vi } from "vitest";
import { executeGoalDag, type GoalDagHost, type GoalDagJournal } from "./script-engine/goal-dag.js";
import type { GoalTask } from "./script-engine/prebuilt/goal-planner.js";
import { fetchStoredWorkerPreferences, resolveGoalPreferencesSnapshot, unavailableGoalPreferences, usableGoalPreferences, type StoredWorkerPreferenceRows } from "./goal-worker-preferences.js";

const rows = (over: Partial<StoredWorkerPreferenceRows> = {}): StoredWorkerPreferenceRows => ({ space_limits: null, project_limits: null, user_preferences: null, ...over });

describe("goal preference snapshot (MS-25)", () => {
  it("resolves tightest-wins across plan, Space, Project and user", () => {
    const s = resolveGoalPreferencesSnapshot(rows({
      space_limits: { max_workers: 5, allowed_model_tiers: ["economy", "standard"], goal_credit_ceiling: 400 },
      project_limits: { max_workers: 2, allowed_model_tiers: null, goal_credit_ceiling: null },
      user_preferences: { worker_count: 9, preferred_model_tier: null, goal_credit_ceiling: 50 },
    }), 3, 123);
    expect(usableGoalPreferences(s)).toBe(true);
    expect(s).toMatchObject({ workerCount: 2, goalCreditCeiling: 50, allowedModelTiers: ["economy", "standard"], takenAt: 123 });
    expect((s as { sources: { preferredModelTier: string } }).sources.preferredModelTier).toBe("cheapest-allowed");
  });
  it("never exceeds the plan limit and defaults to 3 workers / 200 credits", () => {
    expect(resolveGoalPreferencesSnapshot(rows({ space_limits: { max_workers: 10, allowed_model_tiers: null, goal_credit_ceiling: null } }), 2)).toMatchObject({ workerCount: 2, goalCreditCeiling: 200 });
  });
  it("fetch failures resolve to undefined; the unavailable marker is not applied", async () => {
    const base = { headers: {}, spaceId: "s", userId: "u", readJson: (r: Response) => r.json() };
    expect(await fetchStoredWorkerPreferences({ ...base, spaces: undefined })).toBeUndefined();
    expect(await fetchStoredWorkerPreferences({ ...base, spaces: { fetch: async () => new Response("x", { status: 500 }) } })).toBeUndefined();
    expect(await fetchStoredWorkerPreferences({ ...base, spaces: { fetch: async () => Response.json({ nope: 1 }) } })).toBeUndefined();
    expect(await fetchStoredWorkerPreferences({ ...base, spaces: { fetch: async () => { throw new Error("down"); } } })).toBeUndefined();
    const calls: string[] = [];
    expect(await fetchStoredWorkerPreferences({ ...base, projectId: "p", spaces: { fetch: async r => { calls.push(r.url); return Response.json(rows()); } } })).toEqual(rows());
    expect(calls[0]).toBe("http://spaces-worker/internal/worker-preferences?space_id=s&user_id=u&project_id=p");
    expect(usableGoalPreferences(unavailableGoalPreferences())).toBe(false);
    expect(unavailableGoalPreferences()).toMatchObject({ unavailable: true, reason: "preferences_unavailable" });
  });
});

const task = (id: string): GoalTask => ({ id, dependencies: [], title: id, subtask_spec: id, assigned_role: "r", file_paths: [`src/${id}.ts`], budget_tokens: 1000 });
function fixture(preferences?: GoalDagHost["preferences"]) {
  let saved: GoalDagJournal | undefined;
  const host: GoalDagHost = { concurrency: 1, workerId: id => `w:${id}`, load: async () => saved && structuredClone(saved), save: async j => { saved = structuredClone(j); },
    publish: vi.fn(async () => undefined), recover: vi.fn(async () => undefined), launch: vi.fn(async (_t, id) => ({ id, ok: true })), ...(preferences ? { preferences } : {}) };
  return { host, saved: () => saved! };
}
describe("snapshot on the goal journal (MS-25)", () => {
  it("is recorded on a new journal and a later preference change never replaces it", async () => {
    const first = resolveGoalPreferencesSnapshot(rows({ user_preferences: { worker_count: 1, preferred_model_tier: null, goal_credit_ceiling: null } }), 3);
    const f = fixture(first);
    await executeGoalDag([task("a")], f.host);
    expect(f.saved().preferences).toMatchObject({ workerCount: 1 });
    f.host.preferences = resolveGoalPreferencesSnapshot(rows({ user_preferences: { worker_count: 3, preferred_model_tier: null, goal_credit_ceiling: null } }), 3);
    await executeGoalDag([task("a")], f.host);
    expect(f.saved().preferences).toMatchObject({ workerCount: 1 });
  });
  it("flag off (no snapshot supplied): the journal carries none", async () => {
    const f = fixture();
    await executeGoalDag([task("a")], f.host);
    expect(f.saved().preferences).toBeUndefined();
  });
  it("records preferences_unavailable on fetch failure", async () => {
    const f = fixture(unavailableGoalPreferences());
    await executeGoalDag([task("a")], f.host);
    expect(f.saved().preferences).toMatchObject({ unavailable: true, reason: "preferences_unavailable" });
  });
});
