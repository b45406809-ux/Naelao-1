import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentsEnv } from "../index.js";
import { createFakeD1 } from "../../../../tests/stubs/d1-sqlite.js";
import { enrollManagedSubscription, isSubscriptionReleaseAllowed, listReleasableSubscriptions, managedSubscriptionsEnabled,
  resolveOfferingGraceDays, sweepManagedSubscriptions, type RenewalResult, type SubscriptionTypeHandler } from "./managed-subscriptions.js";

const migration = readFileSync(join(__dirname, "../../../../infra/migrations/0301_managed_service_subscriptions.sql"), "utf8");
const DAY = 86_400_000;
const T0 = Date.parse("2026-12-01T00:00:00Z");

function setup(graceDays = 3) {
  const db = createFakeD1([migration, `CREATE TABLE notifications(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,type TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,read_at TEXT,action_url TEXT,created_at TEXT NOT NULL DEFAULT (datetime('now')))`]);
  const env = { PLATFORM_DB: db } as unknown as AgentsEnv;
  const calls: string[] = [];
  let next: RenewalResult = { status: "renewed", periodEnd: T0 + 30 * DAY };
  const suspended: string[] = [];
  const handler: SubscriptionTypeHandler = {
    async renew(_env, sub) { calls.push(sub.id); return next; },
    async onSuspended(_env, sub) { suspended.push(sub.id); },
  };
  const enroll = (resource = "r1", extra: Partial<Parameters<typeof enrollManagedSubscription>[1]> = {}) => enrollManagedSubscription(db, {
    tenantId: "t1", resourceId: resource, subscriptionType: "fake", offeringId: "off", priceVersion: "v1", periodStart: T0 - 30 * DAY, periodEnd: T0,
    graceDays, notifyUserId: "u1", now: T0 - 30 * DAY, ...extra });
  const row = (resource = "r1") => db.prepare("SELECT * FROM managed_service_subscriptions WHERE resource_id=?").bind(resource).first<Record<string, unknown>>();
  return { db, env, calls, suspended, handler, enroll, row, set: (r: RenewalResult) => { next = r; } };
}

describe("MS-36 managed subscriptions engine", () => {
  it("is off unless the flag is exactly true", () => {
    expect(managedSubscriptionsEnabled({})).toBe(false);
    expect(managedSubscriptionsEnabled({ MANAGED_SUBSCRIPTIONS_ENABLED: "false" })).toBe(false);
    expect(managedSubscriptionsEnabled({ MANAGED_SUBSCRIPTIONS_ENABLED: "true" })).toBe(true);
  });

  it("renews a due subscription and advances the period", async () => {
    const s = setup(); await s.enroll();
    expect(await sweepManagedSubscriptions(s.env, { fake: s.handler }, new Date(T0))).toMatchObject({ checked: 1, renewed: 1, billed: 1, held: 0 });
    expect(await s.row()).toMatchObject({ renewal_state: "active", current_period_start: T0, current_period_end: T0 + 30 * DAY, grace_started_at: null });
  });

  it("does not touch subscriptions that are not due", async () => {
    const s = setup(); await s.enroll();
    expect(await sweepManagedSubscriptions(s.env, { fake: s.handler }, new Date(T0 - 1))).toMatchObject({ checked: 0 });
    expect(s.calls).toHaveLength(0);
  });

  it("does not renew again after a successful replay of the same sweep", async () => {
    const s = setup(); await s.enroll();
    await sweepManagedSubscriptions(s.env, { fake: s.handler }, new Date(T0));
    expect(await sweepManagedSubscriptions(s.env, { fake: s.handler }, new Date(T0))).toMatchObject({ checked: 0, renewed: 0 });
    expect(s.calls).toHaveLength(1);
  });

  it("enrollment is idempotent per resource", async () => {
    const s = setup();
    expect(await s.enroll()).toBe(true);
    expect(await s.enroll()).toBe(false);
    expect((await s.db.prepare("SELECT COUNT(*) AS n FROM managed_service_subscriptions").first<{ n: number }>())?.n).toBe(1);
  });

  it("failure moves to grace with one notice, retries, then suspends with a second notice", async () => {
    const s = setup(3); await s.enroll(); s.set({ status: "failed", code: "insufficient_credits" });
    expect(await sweepManagedSubscriptions(s.env, { fake: s.handler }, new Date(T0))).toMatchObject({ held: 1, suspended: 0, notices: 1 });
    expect(await s.row()).toMatchObject({ renewal_state: "grace", grace_started_at: T0, current_period_end: T0 });
    // Retry inside the grace window: still grace, no second notice.
    expect(await sweepManagedSubscriptions(s.env, { fake: s.handler }, new Date(T0 + 2 * DAY))).toMatchObject({ held: 1, suspended: 0, notices: 0 });
    expect(await s.row()).toMatchObject({ renewal_state: "grace" });
    // Grace elapsed.
    expect(await sweepManagedSubscriptions(s.env, { fake: s.handler }, new Date(T0 + 3 * DAY))).toMatchObject({ suspended: 1, notices: 1 });
    expect(await s.row()).toMatchObject({ renewal_state: "suspended", suspended_at: T0 + 3 * DAY });
    expect(s.suspended).toEqual(["sub_r1"]);
    expect((await s.db.prepare("SELECT kind FROM managed_service_subscription_notices ORDER BY created_at,kind").all<{ kind: string }>()).results.map(r => r.kind).sort())
      .toEqual(["renewal_failed_grace", "suspended"]);
    expect((await s.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id='u1'").first<{ n: number }>())?.n).toBe(2);
    // A suspended subscription is not retried or charged again.
    const before = s.calls.length;
    await sweepManagedSubscriptions(s.env, { fake: s.handler }, new Date(T0 + 4 * DAY));
    expect(s.calls.length).toBe(before);
  });

  it("recovers from grace when a retry succeeds and clears the grace clock", async () => {
    const s = setup(); await s.enroll(); s.set({ status: "failed", code: "x" });
    await sweepManagedSubscriptions(s.env, { fake: s.handler }, new Date(T0));
    s.set({ status: "renewed", periodEnd: T0 + 30 * DAY });
    await sweepManagedSubscriptions(s.env, { fake: s.handler }, new Date(T0 + DAY));
    expect(await s.row()).toMatchObject({ renewal_state: "active", grace_started_at: null, current_period_end: T0 + 30 * DAY });
  });

  it("handler exceptions count as failures, never as renewals", async () => {
    const s = setup(); await s.enroll();
    const boom: SubscriptionTypeHandler = { renew: async () => { throw new Error("upstream_down"); } };
    expect(await sweepManagedSubscriptions(s.env, { fake: boom }, new Date(T0))).toMatchObject({ held: 1, renewed: 0 });
    expect(await s.row()).toMatchObject({ renewal_state: "grace" });
  });

  it("cancel_at_period_end cancels without charging; a cancelled handler result cancels too", async () => {
    const s = setup(); await s.enroll(); await s.enroll("r2");
    await s.db.prepare("UPDATE managed_service_subscriptions SET cancel_at_period_end=1 WHERE resource_id='r1'").run();
    s.set({ status: "cancelled" });
    expect(await sweepManagedSubscriptions(s.env, { fake: s.handler }, new Date(T0))).toMatchObject({ cancelled: 2, renewed: 0 });
    expect(s.calls).toEqual(["sub_r2"]);
  });

  it("releases only after 30 days suspended and 7 days after the pre-release notice (MR-LIFE-2)", async () => {
    const s = setup(0); await s.enroll(); s.set({ status: "failed", code: "x" });
    // grace_days 0: first failure suspends immediately at T0.
    expect(await sweepManagedSubscriptions(s.env, { fake: s.handler }, new Date(T0))).toMatchObject({ suspended: 1 });
    expect(await listReleasableSubscriptions(s.db, new Date(T0 + 29 * DAY))).toHaveLength(0);
    // Day 23: the second notice goes out, but release is still blocked.
    expect(await sweepManagedSubscriptions(s.env, { fake: s.handler }, new Date(T0 + 22 * DAY))).toMatchObject({ notices: 0, releasable: [] });
    const warn = await sweepManagedSubscriptions(s.env, { fake: s.handler }, new Date(T0 + 23 * DAY));
    expect(warn).toMatchObject({ notices: 1, releasable: [] });
    expect(await sweepManagedSubscriptions(s.env, { fake: s.handler }, new Date(T0 + 29 * DAY))).toMatchObject({ releasable: [] });
    // Day 30 satisfies both the 30-day and the 7-day-after-warning rules.
    expect(await sweepManagedSubscriptions(s.env, { fake: s.handler }, new Date(T0 + 30 * DAY))).toMatchObject({ notices: 0, releasable: ["sub_r1"] });
    // Late warning pushes release out: warning at day 40 means release no earlier than day 47.
    const late = { renewal_state: "suspended" as const, suspended_at: T0, release_warning_at: T0 + 40 * DAY };
    expect(isSubscriptionReleaseAllowed(late, T0 + 46 * DAY)).toBe(false);
    expect(isSubscriptionReleaseAllowed(late, T0 + 47 * DAY)).toBe(true);
    expect(isSubscriptionReleaseAllowed({ renewal_state: "suspended", suspended_at: T0, release_warning_at: null }, T0 + 90 * DAY)).toBe(false);
  });

  it("reads grace_days from offering charge components and falls back to the default", async () => {
    const s = setup();
    expect(await resolveOfferingGraceDays(s.db as unknown as AgentsEnv["PLATFORM_DB"], "missing")).toBe(7);
    s.db.db.exec(`CREATE TABLE managed_service_offerings(id TEXT PRIMARY KEY,charge_components_json TEXT NOT NULL);
      INSERT INTO managed_service_offerings VALUES('o1','[{"kind":"rental","grace_days":14}]'),('o2','not json')`);
    expect(await resolveOfferingGraceDays(s.db as unknown as AgentsEnv["PLATFORM_DB"], "o1")).toBe(14);
    expect(await resolveOfferingGraceDays(s.db as unknown as AgentsEnv["PLATFORM_DB"], "o2")).toBe(7);
  });
});
