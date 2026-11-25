import { describe, expect, it } from "vitest";
import { PRODUCT_END_USER_PATH_PATTERNS } from "./index.js";

describe("product session routes for composed project extensions", () => {
  const paths = [
    "/spaces/s/projects/p/extensions",
    "/spaces/s/projects/p/extension-installations/install-a/lifecycle",
    "/spaces/s/projects/p/extension-installations/install-a/settings",
    "/spaces/s/projects/p/extension-installations/install-a/agent-maintenance-grants",
    "/spaces/s/projects/p/extension-installations/install-a/resource-grants",
    "/spaces/s/projects/p/extension-installations/installation%3Atenant%3Aext_voice%3Aowner/settings",
    "/spaces/s/projects/p/extensions/ext_demo/releases",
    "/spaces/s/extension-releases/rollback",
    "/spaces/s/extension-publishers",
    "/spaces/s/extension-publishers/key-a",
    "/spaces/s/projects/p/extensions/install-a/connections/slack/oauth/slack/start",
    "/spaces/s/projects/p/extensions/install-a/connections/slack/routes/available",
    "/spaces/s/projects/p/extensions/install-a/connections/slack/routes",
    "/spaces/s/projects/p/extensions/install-a/connections/slack/telegram/connect",
    "/spaces/s/projects/p/extensions/install-a/connections/slack/whatsapp/connect",
    "/spaces/s/channel-extensions",
    "/spaces/s/projects/p/channel-extensions",
    "/spaces/s/projects/p/channel-extensions/install-a/session-state",
    "/spaces/s/projects/p/channel-extensions/install-a/inbox",
    "/spaces/s/projects/p/channel-extensions/install-a/inbox/sla",
    "/spaces/s/projects/p/channel-extensions/install-a/inbox/notes",
    "/spaces/s/projects/p/channel-extensions/install-a/inbox/assign",
    "/spaces/s/projects/p/channel-extensions/install-a/inbox/takeover",
    "/spaces/s/projects/p/channel-extensions/install-a/inbox/delete-conversation",
    "/spaces/s/projects/p/channel-extensions/install-a/inbox/reply",
    "/spaces/s/projects/p/channel-extensions/install-a/inbox/export",
    "/spaces/s/projects/p/extension-provider-revocations",
    "/spaces/s/assistant/channel-extensions",
    "/spaces/s/assistant/channel-capabilities",
    "/spaces/s/projects/p/workflows/plan",
  ];

  it.each(paths)("allows identity resolution for %s", path => {
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(true);
  });

  it("does not broaden the scoped routes to arbitrary extension paths", () => {
    for (const path of [
      "/spaces/s/projects/p/extensions/install-a/secrets",
      "/spaces/s/projects/p/channel-extensions/install-a/inbox/send-anything",
      "/spaces/s/projects/p/extensions/install-a/connections/slack/credentials/export",
      "/spaces/s/projects/p/extension-installations/install-a/settings/admin",
      "/spaces/s/projects/p/extension-installations/install-a/agent-maintenance-grants/agent-a",
      "/spaces/s/projects/p/extension-installations/install-a/resource-grants/revoke",
    ]) expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(false);
  });
});

describe("product session routes for self-service data rights", () => {
  it.each(["/spaces/s/me/export", "/spaces/s/me/data", "/spaces/s/product-users/me", "/spaces/s/product-users/me/export",
    "/spaces/s/product-users/me/inbox",
    "/spaces/s/product-users/me/micro-app-archives/preview", "/spaces/s/product-users/me/micro-app-archives/restore"])("requires product-session identity for %s", path => {
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(true);
  });

  it.each(["/spaces/s/product-users/me/export/download", "/spaces/s/product-users/me/other", "/spaces/s/product-users/me/inbox/other",
    "/spaces/s/product-users/me/micro-app-archives/other", "/spaces/s/product-users/me/micro-app-archives/restore/other"])("keeps unrelated account paths outside the self-service identity route: %s", path => {
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(false);
  });

  it("does not route signed export downloads through product-session resolution", () => {
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test("/spaces/s/me/export/download"))).toBe(false);
  });
});

describe("product user MicroApp routing", () => {
  it.each([
    "/spaces/s/product-users/me/micro-apps",
    "/spaces/s/product-users/me/micro-apps/install%3Atenant%3Aext_notes%3Aowner/personal_notes/activate",
    "/spaces/s/product-users/me/micro-apps/install-a/personal_notes/app",
    "/spaces/s/product-users/me/micro-apps/install-a/personal_notes/api/data",
    "/spaces/s/product-users/me/micro-apps/install-a/personal_notes/api/storage",
    "/spaces/s/product-users/me/micro-apps/install-a/personal_notes/mcp",
  ])("routes product identity for %s", path => {
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(true);
  });

  it.each([
    "/spaces/s/product-users/me/micro-apps/install-a/Other/app",
    "/spaces/s/product-users/me/micro-apps/install-a/personal_notes/api/settings",
    "/spaces/s/product-users/me/micro-apps/install-a/personal_notes/admin",
    "/spaces/s/product-users/me/micro-apps/install-a/personal_notes/api/data/other",
  ])("does not route unlisted MicroApp paths for %s", path => {
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(false);
  });
});

describe("Space member invitation identity routing", () => {
  it.each([
    "/spaces/s/member-invitations",
    "/spaces/s/member-invitations/invite-a/redeem",
    "/spaces/s/member-role-reviews",
    "/spaces/s/member-role-reviews/review-a",
    "/spaces/s/business-role-options",
    "/spaces/s/my-business-roles",
  ])("resolves a Product identity for %s so the Space host can enforce owner and verified-email gates", path => {
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(true);
  });

  it.each([
    "/spaces/s/member-invitations/invite-a/redeem/other",
    "/spaces/s/member-invitations/invite-a/revoke/other",
    "/spaces/s/member-role-reviews/review-a/approve",
    "/spaces/s/business-role-options/other",
    "/spaces/s/my-business-roles/other",
  ])("does not route unrelated invitation actions: %s", path => {
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(false);
  });
});

describe("logical subspace blackboard identity routing", () => {
  it.each([
    "/spaces/s/subspace-blackboard/routes",
    "/spaces/s/subspace-blackboard/routes/route-a/revoke",
    "/spaces/s/subspace-blackboard/resource",
    "/spaces/s/subspace-route-proposals",
    "/spaces/s/subspace-route-proposals/decide",
    "/spaces/s/sub-spaces/dept-a/blackboard",
    "/spaces/s/sub-spaces/dept-a/blackboard/broadcast",
  ])("resolves product-session identity for %s", path => {
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(true);
  });

  it.each([
    "/spaces/s/subspace-blackboard/routes/route-a/revoke/other",
    "/spaces/s/subspace-blackboard/resource/x",
    "/spaces/s/subspace-route-proposals/decide/x",
    "/spaces/s/sub-spaces/dept-a/blackboard/other",
    "/spaces/s/sub-spaces/dept-a/blackboard/broadcast/other",
    "/spaces/s/sub-spaces/dept-a/admin",
  ])("keeps unrelated department operations outside this identity route: %s", path => {
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(false);
  });
});

describe("Product-user billing status routing", () => {
  it("allows only the exact self-service status endpoint through product-session identity", () => {
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test("/spaces/s/customer-billing-status"))).toBe(true);
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test("/spaces/s/customer-billing-status/other-user"))).toBe(false);
  });
});

describe("Space presentation preferences", () => {
  it("routes the exact preferences endpoint through product-session authorization", () => {
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test("/spaces/s/preferences"))).toBe(true);
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test("/spaces/s/preferences/admin"))).toBe(false);
  });
});

describe("Space coordination registry routing", () => {
  it.each([
    "/spaces/s/coordination-registry",
    "/spaces/s/coordination-registry/preview",
    "/spaces/s/coordination-registry/entry-a",
    "/spaces/s/coordination-registry/v2",
    "/spaces/s/coordination-registry/v2/preview",
    "/spaces/s/coordination-registry/v2/entry-a",
  ])("resolves product session identity for %s", path => {
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(true);
  });

  it("does not allow nested registry operations", () => {
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test("/spaces/s/coordination-registry/entry-a/private"))).toBe(false);
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test("/spaces/s/coordination-registry/v2/entry-a/private"))).toBe(false);
  });
});

describe("Space Template activation and shared-extension lifecycle routing", () => {
  it.each([
    "/spaces/s/blueprints/tpl_demo/activation-preview",
    "/spaces/s/blueprints/tpl_demo/setup-draft",
    "/spaces/s/blueprints/tpl_demo/setup-update-preview",
    "/spaces/s/blueprints/tpl_demo/setup-update-apply",
    "/spaces/s/blueprints/installations",
    "/spaces/s/shared-extension-installations/instance-a",
    "/spaces/s/shared-extension-installations/instance-a/filesystem-grants",
    "/spaces/s/shared-extension-installations/instance-a/lifecycle",
  ])("resolves product session identity for %s", path => {
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(true);
  });

  it("allows only the exact template setup runtime API through product-session resolution", () => {
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test("/spaces/s/apps/support_app/api/template-setup"))).toBe(true);
    for (const path of [
      "/spaces/s/apps/support_app/api/template-setup/admin",
      "/spaces/s/apps/support_app/api/settings",
      "/spaces/s/apps/support_app/api/template-setup/secret",
    ]) expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(false);
  });
});

describe("planner worker conflict review routing", () => {
  it.each([
    "/spaces/s/assistant/sub-agents/worker-a/workspace-conflicts/preview",
    "/spaces/s/assistant/sub-agents/worker-a/workspace-conflicts/resolve",
  ])("resolves product-session identity for %s", path => {
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(true);
  });

  it("keeps conflict review routes bounded to the exact worker operations", () => {
    for (const path of [
      "/spaces/s/assistant/sub-agents/worker-a/workspace-conflicts/resolve/other",
      "/spaces/s/assistant/sub-agents/worker-a/workspace-conflicts/export",
      "/spaces/s/assistant/sub-agents/worker-a/workspace-conflicts/preview/other",
    ]) expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(false);
  });
});

describe("product user durable task routing (MS-13)", () => {
  it.each(["/spaces/s/durable-tasks", "/spaces/s/durable-tasks/t", "/spaces/s/projects/p/task-stop"])("accepts %s", path => {
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(true);
  });
  it.each(["/spaces/x/durable-tasks/y/z", "/spaces/x/projects/y/task-stop/extra", "/spaces/x/durable-tasks/y/"])("rejects %s", path => {
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(false);
  });
});

describe("product session routes for worker preferences (MS-24)", () => {
  it.each(["/spaces/s/worker-preference-limits", "/spaces/s/worker-user-preferences", "/spaces/s/worker-preference-audit"])("allows %s", path => {
    expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(true);
  });
  it("rejects look-alike and nested paths", () => {
    for (const path of ["/spaces/s/worker-preference-limits/p", "/spaces/s/worker-preference-limits/", "/spaces/s/worker-user-preferences/other-user",
      "/spaces/s/worker-preference-audit/export", "/spaces/s/worker-preferences", "/spaces/s/x/worker-preference-limits", "/worker-preference-limits"])
      expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(false);
  });
});
