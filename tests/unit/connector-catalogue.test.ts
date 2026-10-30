import { describe, it, expect } from "vitest";
import {
  CONNECTOR_CATALOGUE,
  getConnector,
  availableConnectors,
  isConnectorAvailable,
  validateConnectorCatalogue,
} from "../../workers/agents/src/connectors/catalogue.js";
import { LAUNCHPAD_TEMPLATES, getLaunchpadTemplate } from "../../workers/agents/src/launchpad/spacetype.js";

// "Available integrations are connector data" — the connector catalogue is the source of truth the
// dashboard renders. These tests lock that contract + the reserved-money-in invariant.

describe("connector catalogue", () => {
  it("exposes Whop only as a normal external integration, not a Naelao wallet", () => {
    const whop = getConnector("whop");
    expect(whop?.status).toBe("available");
    expect(whop?.composio?.toolkit_slug).toBe("whop");
    expect(whop?.mcp_endpoint).toBeUndefined();
    expect((whop?.operations ?? []).every((operation) => !/checkout|charge|payout|refund|withdraw/i.test(operation.name))).toBe(true);
  });

  it("has no hardcoded commerce behavior in kernel routes or templates", () => {
    expect(LAUNCHPAD_TEMPLATES).toEqual([]);
    expect(getLaunchpadTemplate("whop-seller")).toBeNull();
    expect(getLaunchpadTemplate("customer-service")).toBeNull();
  });

  it("Notion is a Composio-routed connector with no direct MCP endpoint or builder credential", () => {
    const c = getConnector("notion");
    expect(c?.status).toBe("available");
    expect(c?.mcp_endpoint).toBeUndefined();
    expect(c?.composio?.toolkit_slug).toBe("notion");
    expect(c?.pipedream).toBeUndefined();
    expect(c?.auth.type).toBe("none");
    expect((c?.operations ?? []).length).toBeGreaterThan(0);
  });

  it("Composio-routed social connectors have no mcp_endpoint of their own (the provider resolves it) and no builder credential", () => {
    for (const id of ["twitter", "linkedin", "instagram", "tiktok"]) {
      const c = getConnector(id);
      expect(c?.status).toBe("available");
      expect(c?.mcp_endpoint).toBeUndefined();
      expect(c?.composio?.auth_config_id_env).toBeTruthy();
      expect(c?.auth.type).toBe("none");
      expect((c?.operations ?? []).length).toBeGreaterThan(0);
    }
  });

  it("Higgsfield is a direct (non-Composio) connector with its own hosted MCP endpoint", () => {
    const c = getConnector("higgsfield");
    expect(c?.status).toBe("available");
    expect(c?.mcp_endpoint).toBe("https://mcp.higgsfield.ai/mcp");
    expect(c?.composio).toBeUndefined();
    expect(c?.auth.credential_name).toBe("HIGGSFIELD_API_KEY");
  });

  it("the CRM/ads connectors are live now that Composio-managed auth removed the Auth Config prerequisite", () => {
    // These were coming_soon for exactly one reason — no hand-registered Auth Config — which
    // managed auth removed. Each was verified live to produce a real Connect Link.
    for (const id of ["hubspot", "google-ads", "meta-ads"]) {
      const c = getConnector(id);
      expect(c?.status).toBe("available");
      expect(c?.composio?.toolkit_slug).toBeTruthy();
      expect((c?.operations ?? []).length).toBeGreaterThan(0);
    }
  });

  it("AgentMail stays coming_soon — Composio reports no managed credentials for that toolkit", () => {
    // A real reason, not an unprovisioned config: one-click connect genuinely cannot work until
    // we register our own OAuth app for it.
    const c = getConnector("agentmail");
    expect(c?.status).toBe("coming_soon");
    expect(c?.composio?.toolkit_slug).toBe("agent_mail");
  });

  it("Meta Ads uses the toolkit slug Composio actually has", () => {
    // Was "facebook_ads", which Composio rejects as nonexistent — caught by connecting it for real.
    expect(getConnector("meta-ads")?.composio?.toolkit_slug).toBe("metaads");
  });

  it("the rest of the creator-economy platforms are coming_soon", () => {
    for (const id of ["skool", "beehiiv", "substack", "calcom", "etsy"]) {
      expect(isConnectorAvailable(id)).toBe(false);
      expect(getConnector(id)?.status).toBe("coming_soon");
    }
  });

  it("no available connector declares a money-in operation (reserved to commerce)", () => {
    // validateConnectorCatalogue throws if any available connector op looks like money-in.
    // Money-in = collecting/moving money (create/collect payment, checkout, charge, payout) —
    // reading receipts (list_payments) is allowed (model A: the platform processed the sale).
    expect(() => validateConnectorCatalogue()).not.toThrow();
    expect(availableConnectors().length).toBeGreaterThan(0);
  });

  it("connector ids are unique", () => {
    const ids = CONNECTOR_CATALOGUE.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not bundle domain Space Templates in the Launchpad kernel", () => {
    expect(LAUNCHPAD_TEMPLATES).toEqual([]);
    expect(getLaunchpadTemplate("whop-seller")).toBeNull();
    expect(getLaunchpadTemplate("customer-service")).toBeNull();
  });

  it("voice + support connectors are catalogued as coming_soon", () => {
    for (const id of ["vapi", "twilio", "elevenlabs", "zendesk", "intercom"]) {
      expect(getConnector(id)?.status).toBe("coming_soon");
    }
    expect(getConnector("vapi")?.category).toBe("voice");
    expect(getConnector("zendesk")?.category).toBe("support");
  });

});
