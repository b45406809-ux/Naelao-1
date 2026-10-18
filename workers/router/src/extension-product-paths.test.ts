import { describe, expect, it } from "vitest";
import { PRODUCT_END_USER_PATH_PATTERNS } from "./index.js";

describe("product session routes for composed project extensions", () => {
  const paths = [
    "/spaces/s/projects/p/extensions",
    "/spaces/s/projects/p/extensions/ext_demo/releases",
    "/spaces/s/extension-releases/rollback",
    "/spaces/s/extension-publishers",
    "/spaces/s/extension-publishers/key-a",
    "/spaces/s/projects/p/extensions/install-a/connections/slack/oauth/slack/start",
    "/spaces/s/projects/p/extensions/install-a/connections/slack/routes/available",
    "/spaces/s/projects/p/extensions/install-a/connections/slack/routes",
    "/spaces/s/projects/p/extensions/install-a/connections/slack/telegram/connect",
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
    "/spaces/s/assistant/channel-extensions",
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
    ]) expect(PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path))).toBe(false);
  });
});
