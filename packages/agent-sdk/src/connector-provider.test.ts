import { describe, expect, it, vi } from "vitest";
import {
  pinConnectorProvider,
  resolveConnectorProvider,
} from "./connector-provider.js";
import { createRuntimeContext } from "./runtime-context.js";
import type { RuntimeContextServices } from "./types.js";

describe("connector provider arbitration", () => {
  const registry = {
    composio: new Set(["slack", "hubspot"]),
    pipedream: new Set(["slack", "sage50"]),
  };

  it("chooses Composio for overlapping apps and Pipedream for long-tail apps", () => {
    expect(resolveConnectorProvider({ appId: "Slack", registry })).toBe(
      "composio"
    );
    expect(resolveConnectorProvider({ appId: "sage50", registry })).toBe(
      "pipedream"
    );
  });

  it("honors explicit providers only when configured, and never breaks an existing pin", () => {
    expect(
      resolveConnectorProvider({
        appId: "slack",
        registry,
        preferredProvider: "pipedream",
      })
    ).toBe("pipedream");
    expect(
      resolveConnectorProvider({
        appId: "slack",
        registry,
        preferredProvider: "PIPEDREAM",
      })
    ).toBe("pipedream");
    expect(
      resolveConnectorProvider({
        appId: "slack",
        registry,
        pinnedProvider: "composio",
      })
    ).toBe("composio");
    expect(() =>
      resolveConnectorProvider({
        appId: "slack",
        registry,
        pinnedProvider: "composio",
        preferredProvider: "pipedream",
      })
    ).toThrow("connector_provider_pinned");
    expect(() =>
      resolveConnectorProvider({
        appId: "sage50",
        registry,
        preferredProvider: "composio",
      })
    ).toThrow("connector_provider_unavailable");
    expect(() =>
      resolveConnectorProvider({ appId: "unknown", registry })
    ).toThrow("connector_unavailable");
  });

  it("pins a route idempotently and rejects cross-provider token/account bridging", () => {
    const pinned = pinConnectorProvider({}, "Slack", "composio");
    expect(pinConnectorProvider(pinned, "slack", "composio")).toEqual({
      slack: "composio",
    });
    expect(() => pinConnectorProvider(pinned, "slack", "pipedream")).toThrow(
      "connector_provider_pinned"
    );
  });
});

describe("SDK connector facade", () => {
  it("keeps use() compatible and forwards an explicit provider choice through get()", async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const services = {
      fs: {},
      vault: {},
      browser: {},
      mcp: {},
      connectors: { call },
      run: {},
      project: {
        getJournal: vi.fn(),
        updateJournal: vi.fn(),
        createTask: vi.fn(),
        listThreads: vi.fn(),
        postMessage: vi.fn(),
      },
    } as unknown as RuntimeContextServices;
    const context = createRuntimeContext({
      scope: "PROJECT_BOUND",
      projectId: "p1",
      services,
    });

    await context.connectors
      .use("primary_inbox")
      .call("send_email", { to: "person@example.test" });
    expect(call).toHaveBeenLastCalledWith(
      "primary_inbox",
      "send_email",
      { to: "person@example.test" },
      []
    );

    await context.connectors
      .get("primary_inbox", { preferredProvider: "pipedream" })
      .call("send_email", { to: "person@example.test" });
    expect(call).toHaveBeenLastCalledWith(
      "primary_inbox",
      "send_email",
      { to: "person@example.test" },
      [],
      { preferredProvider: "pipedream" }
    );
  });
});
