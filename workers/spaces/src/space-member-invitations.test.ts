import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createFakeD1 } from "../../../tests/stubs/d1-sqlite.js";
import type { SpaceBlueprint } from "@naelao/agent-sdk";
import { certifyStateDeltaArtifact } from "@naelao/security";
import worker from "./index.js";

const secret = "space-member-invites-test-secret";

function setup() {
  const { db, ...platformDb } = createFakeD1([
    `CREATE TABLE orgs(id TEXT PRIMARY KEY,status TEXT NOT NULL)`,
    `CREATE TABLE products(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,status TEXT NOT NULL)`,
    `CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,product_id TEXT,status TEXT NOT NULL)`,
    `CREATE TABLE product_end_users(
      product_space_id TEXT NOT NULL,end_user_id TEXT NOT NULL,email TEXT,display_name TEXT,
      email_verified_at TEXT,suspended_at TEXT,deleted_at TEXT,erasure_started_at TEXT,
      PRIMARY KEY(product_space_id,end_user_id),UNIQUE(product_space_id,email))`,
    `CREATE TABLE space_members(
      id TEXT PRIMARY KEY,space_id TEXT NOT NULL,tenant_id TEXT NOT NULL,end_user_id TEXT NOT NULL,
      email TEXT,display_name TEXT,role TEXT NOT NULL DEFAULT 'member',created_at TEXT DEFAULT(datetime('now')),suspended_at TEXT,
      UNIQUE(space_id,end_user_id))`,
  ]);
  db.exec(readFileSync(join(__dirname, "../../../infra/migrations/0278_space_member_invitations.sql"), "utf8"));
  db.exec(readFileSync(join(__dirname, "../../../infra/migrations/0279_space_business_role_review_ledger.sql"), "utf8"));
  db.exec(readFileSync(join(__dirname, "../../../infra/migrations/0280_space_invitation_business_roles.sql"), "utf8"));
  db.exec("INSERT INTO orgs VALUES('tenant-a','active')");
  db.exec("INSERT INTO products VALUES('product-a','tenant-a','active')");
  db.exec("INSERT INTO spaces VALUES('space-a','tenant-a','product-a','active')");
  db.exec(`INSERT INTO product_end_users VALUES
    ('product-a','owner-a','owner@example.test','Owner','verified',NULL,NULL,NULL),
    ('product-a','member-a','member@example.test','Member','verified',NULL,NULL,NULL),
    ('product-a','other-a','other@example.test','Other','verified',NULL,NULL,NULL)`);
  db.exec("INSERT INTO space_members(id,space_id,tenant_id,end_user_id,role) VALUES('owner-membership','space-a','tenant-a','owner-a','owner')");
  const env = { PLATFORM_SECRET: secret, PLATFORM_DB: platformDb, ENVIRONMENT: "test" } as never;
  return { db, env };
}

async function inviteRequest(env: never, userId: string, path: string, method: string, body?: unknown) {
  return worker.fetch(new Request(`https://spaces.test${path}`, {
    method,
    headers: {
      "content-type": "application/json", "x-naelao-tenant-id": "tenant-a",
      "x-naelao-user-id": userId, "x-naelao-role": "product_end_user",
      "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, { waitUntil: () => undefined } as never);
}

async function installRoleBlueprint(env: never, artifact: SpaceBlueprint) {
  const certificate = await certifyStateDeltaArtifact(artifact, { fixtures: Array.from({ length: 50 }, (_, index) => ({ id: `role-${index}` })) },
    { runner: "naelao-state-delta-v1", passed: 50, total: 50, securityViolations: 0, tokensUsed: 0, maximumCostUpperBoundUsd: 0.025, diagnostics: [] }, secret, "tenant-a");
  if (!certificate) throw new Error("test_certificate_not_issued");
  const digestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(artifact)));
  const artifactSha256 = [...new Uint8Array(digestBytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const platform = env as { SPACE_DO?: unknown; SCRIPTS_R2?: unknown };
  platform.SPACE_DO = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ installations: [{ blueprint_id: artifact.id, artifact_sha256: artifactSha256,
      status: "installed", lifecycle_state: "active", listing_id: null }] }) }),
  };
  platform.SCRIPTS_R2 = { get: async () => ({ json: async () => ({ blueprint: artifact, conformanceCertificate: certificate }) }) };
  return { artifactSha256, platform };
}

describe("Space Product-user invitations", () => {
  it("enforces all-or-none template role binding on persisted invitation rows", () => {
    const { db } = setup();
    expect(() => db.prepare(
      `INSERT INTO space_member_invitations
        (id,tenant_id,space_id,product_id,inviter_user_id,recipient_email_hash,token_hash,role,expires_at,business_role_id)
       VALUES('partial','tenant-a','space-a','product-a','owner-a','recipient','token','member','2099-01-01','stock_lead')`
    ).run()).toThrow(/space_member_invitation_role_binding_invalid/);
  });

  it("redeems once for the matching verified identity and keeps it out of SpaceDO", async () => {
    const { db, env } = setup();
    const created = await inviteRequest(env, "owner-a", "/spaces/space-a/member-invitations", "POST", { email: " MEMBER@example.test " });
    expect(created.status).toBe(201);
    const invitation = await created.json() as { id: string; token: string; delivery: string };
    expect(invitation.delivery).toBe("not_sent");
    const duplicate = await inviteRequest(env, "owner-a", "/spaces/space-a/member-invitations", "POST", { email: "member@example.test" });
    expect(duplicate.status).toBe(409);
    const path = `/spaces/space-a/member-invitations/${invitation.id}/redeem`;
    const redeemed = await inviteRequest(env, "member-a", path, "POST", { token: invitation.token });
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toMatchObject({ status: "accepted", role: "member", replayed: false });
    const replay = await inviteRequest(env, "member-a", path, "POST", { token: invitation.token });
    expect(await replay.json()).toMatchObject({ status: "accepted", replayed: true });
    expect(db.prepare("SELECT role FROM space_members WHERE space_id='space-a' AND end_user_id='member-a'").get()).toEqual({ role: "member" });
  });

  it("pins an invited business-role proposal to the exact artifact and keeps stale invitations pending", async () => {
    const { db, env } = setup();
    const artifact: SpaceBlueprint = {
      id: "tpl_invite_roles", schemaVersion: "2.0", metadata: { name: "Roles" }, templateCategory: "other",
      projects: [], requiredExtensions: [], requiredCredentials: [], businessRolesSchemaVersion: 1,
      businessRoles: [{ id: "stock_lead", name: { en: "Stock lead" }, recommendedSpaceRole: "member",
        onboardingSteps: [{ id: "first_day", title: { en: "First day" }, instructions: { en: "Review the stock procedures." }, required: true }] }],
    };
    const { artifactSha256, platform } = await installRoleBlueprint(env, artifact);
    const options = await inviteRequest(env, "owner-a", "/spaces/space-a/business-role-options", "GET");
    expect(options.status).toBe(200);
    expect(await options.json()).toMatchObject({ grants_applied: false, blueprints: [{ blueprint_id: artifact.id,
      artifact_sha256: artifactSha256, roles: [{ id: "stock_lead", name: { en: "Stock lead" }, recommended_space_role: "member" }] }] });
    const hiddenOptions = await inviteRequest(env, "member-a", "/spaces/space-a/business-role-options", "GET");
    expect(hiddenOptions.status).toBe(403);
    const created = await inviteRequest(env, "owner-a", "/spaces/space-a/member-invitations", "POST", {
      email: "member@example.test", blueprint_id: artifact.id, business_role_id: "stock_lead",
    });
    expect(created.status).toBe(201);
    const invitation = await created.json() as { id: string; token: string; business_role_id: string; grants_applied: boolean };
    expect(invitation).toMatchObject({ business_role_id: "stock_lead", grants_applied: false });
    expect(db.prepare("SELECT blueprint_id,artifact_sha256,business_role_id FROM space_member_invitations WHERE id=?").get(invitation.id))
      .toEqual({ blueprint_id: artifact.id, artifact_sha256: artifactSha256, business_role_id: "stock_lead" });
    const redeemed = await inviteRequest(env, "member-a", `/spaces/space-a/member-invitations/${invitation.id}/redeem`, "POST", { token: invitation.token });
    expect(redeemed.status, JSON.stringify(await redeemed.clone().json())).toBe(200);
    expect(await redeemed.json()).toMatchObject({
      role: "member", business_role_id: "stock_lead", role_review: { status: "proposal_only", grants_applied: false },
    });
    const replay = await inviteRequest(env, "member-a", `/spaces/space-a/member-invitations/${invitation.id}/redeem`, "POST", { token: invitation.token });
    expect(await replay.json()).toMatchObject({
      status: "accepted", business_role_id: "stock_lead", role_review: { status: "proposal_only", grants_applied: false }, replayed: true,
    });
    const review = db.prepare("SELECT blueprint_id,artifact_sha256,business_role_id,status,grants_applied FROM space_business_role_reviews").get();
    expect(review).toEqual({ blueprint_id: artifact.id, artifact_sha256: artifactSha256, business_role_id: "stock_lead", status: "proposal_only", grants_applied: 0 });
    expect(db.prepare("SELECT role FROM space_members WHERE end_user_id='member-a'").get()).toEqual({ role: "member" });
    const selfRoles = await inviteRequest(env, "member-a", "/spaces/space-a/my-business-roles", "GET");
    expect(selfRoles.status).toBe(200);
    expect(await selfRoles.json()).toMatchObject({ space_role: "member", grants_applied: false, data: [{
      status: "proposal_only", grants_applied: false, blueprint_id: artifact.id, artifact_sha256: artifactSha256,
      business_role_id: "stock_lead", name: { en: "Stock lead" },
      onboarding_steps: [{ id: "first_day", title: { en: "First day" }, required: true }],
    }] });
    const unrelatedRoles = await inviteRequest(env, "other-a", "/spaces/space-a/my-business-roles", "GET");
    expect(unrelatedRoles.status).toBe(403);

    const staleInvite = await inviteRequest(env, "owner-a", "/spaces/space-a/member-invitations", "POST", {
      email: "other@example.test", blueprint_id: artifact.id, business_role_id: "stock_lead",
    });
    const stale = await staleInvite.json() as { id: string; token: string };
    platform.SPACE_DO = { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({ installations: [{
      blueprint_id: artifact.id, artifact_sha256: "f".repeat(64), status: "installed", lifecycle_state: "active", listing_id: null,
    }] }) }) };
    const staleRedeem = await inviteRequest(env, "other-a", `/spaces/space-a/member-invitations/${stale.id}/redeem`, "POST", { token: stale.token });
    expect(staleRedeem.status).toBe(409);
    expect(db.prepare("SELECT status FROM space_member_invitations WHERE id=?").get(stale.id)).toEqual({ status: "pending" });
    expect(db.prepare("SELECT count(*) AS count FROM space_members WHERE end_user_id='other-a'").get()).toEqual({ count: 0 });
  });

  it("binds an owner-reviewed role proposal to the installed signed artifact and membership epoch without grants", async () => {
    const { db, env } = setup();
    db.exec("INSERT INTO space_members(id,space_id,tenant_id,end_user_id,role) VALUES('member-membership','space-a','tenant-a','member-a','member')");
    const artifact: SpaceBlueprint = {
      id: "tpl_roles", schemaVersion: "2.0", metadata: { name: "Roles" }, templateCategory: "other",
      projects: [], requiredExtensions: [], requiredCredentials: [], businessRolesSchemaVersion: 1,
      businessRoles: [{ id: "stock_lead", name: { en: "Stock lead" }, recommendedSpaceRole: "member" }],
    };
    const certificate = await certifyStateDeltaArtifact(artifact, { fixtures: Array.from({ length: 50 }, (_, index) => ({ id: `role-${index}` })) },
      { runner: "naelao-state-delta-v1", passed: 50, total: 50, securityViolations: 0, tokensUsed: 0, maximumCostUpperBoundUsd: 0.025, diagnostics: [] }, secret, "tenant-a");
    if (!certificate) throw new Error("test_certificate_not_issued");
    const digestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(artifact)));
    const artifactSha256 = [...new Uint8Array(digestBytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const platform = env as { SPACE_DO?: unknown; SCRIPTS_R2?: unknown };
    platform.SPACE_DO = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ installations: [{ blueprint_id: artifact.id, artifact_sha256: artifactSha256,
        status: "installed", lifecycle_state: "active", listing_id: null }] }) }),
    };
    platform.SCRIPTS_R2 = { get: async () => ({ json: async () => ({ blueprint: artifact, conformanceCertificate: certificate }) }) };
    const path = "/spaces/space-a/member-role-reviews";
    const response = await inviteRequest(env, "owner-a", path, "POST", { blueprint_id: artifact.id, end_user_id: "member-a", business_role_id: "stock_lead" });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    const review = await response.json() as { id: string; status: string; grants_applied: boolean };
    expect(review).toMatchObject({ status: "proposal_only", grants_applied: false });
    expect(db.prepare("SELECT business_role_id,status,grants_applied FROM space_business_role_reviews WHERE id=?").get(review.id))
      .toEqual({ business_role_id: "stock_lead", status: "proposal_only", grants_applied: 0 });
    expect(db.prepare("SELECT role FROM space_members WHERE end_user_id='member-a'").get()).toEqual({ role: "member" });
    platform.SPACE_DO = { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({ installations: [{
      blueprint_id: artifact.id, artifact_sha256: "f".repeat(64), status: "installed", lifecycle_state: "active", listing_id: null,
    }] }) }) };
    const stale = await inviteRequest(env, "owner-a", path, "POST", { blueprint_id: artifact.id, end_user_id: "member-a", business_role_id: "stock_lead" });
    expect(stale.status).toBe(409);
    db.exec("UPDATE space_members SET role='viewer' WHERE end_user_id='member-a'");
    expect(db.prepare("SELECT status FROM space_business_role_reviews WHERE id=?").get(review.id)).toEqual({ status: "revoked" });
  });

  it("rejects forwarded tokens, admin escalation, and redemption after inviter revocation", async () => {
    const { db, env } = setup();
    const admin = await inviteRequest(env, "owner-a", "/spaces/space-a/member-invitations", "POST", { email: "member@example.test", role: "admin" });
    expect(admin.status).toBe(201);
    const invitation = await admin.json() as { id: string; token: string };
    const path = `/spaces/space-a/member-invitations/${invitation.id}/redeem`;
    const forwarded = await inviteRequest(env, "other-a", path, "POST", { token: invitation.token });
    expect(forwarded.status).toBe(403);
    db.exec("UPDATE space_members SET suspended_at='now' WHERE end_user_id='owner-a'");
    const revokedInviter = await inviteRequest(env, "member-a", path, "POST", { token: invitation.token });
    expect(revokedInviter.status).toBe(409);
    expect(db.prepare("SELECT count(*) AS count FROM space_members WHERE end_user_id='member-a'").get()).toEqual({ count: 0 });
  });

  it("does not let an admin create an administrator invite and rechecks expiration", async () => {
    const { db, env } = setup();
    db.exec("INSERT INTO space_members(id,space_id,tenant_id,end_user_id,role) VALUES('admin-membership','space-a','tenant-a','member-a','admin')");
    const denied = await inviteRequest(env, "member-a", "/spaces/space-a/member-invitations", "POST", { email: "other@example.test", role: "admin" });
    expect(denied.status).toBe(403);
    const created = await inviteRequest(env, "member-a", "/spaces/space-a/member-invitations", "POST", { email: "other@example.test" });
    expect(created.status).toBe(201);
    const invitation = await created.json() as { id: string; token: string };
    db.prepare("UPDATE space_member_invitations SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(invitation.id);
    const expired = await inviteRequest(env, "other-a", `/spaces/space-a/member-invitations/${invitation.id}/redeem`, "POST", { token: invitation.token });
    expect(expired.status).toBe(409);
  });
});
