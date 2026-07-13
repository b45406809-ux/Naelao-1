import { describe, it, expect } from "vitest";
import {
  CONNECTOR_CATALOGUE,
  getConnector,
  availableConnectors,
  isConnectorAvailable,
  validateConnectorCatalogue,
} from "../../workers/agents/src/connectors/catalogue.js";
import { LAUNCHPAD_TEMPLATES, getLaunchpadTemplate } from "../../workers/agents/src/launchpad/spacetype.js";

// "Whop first, everything else coming soon" — the connector catalogue is the source of truth the
// dashboard renders. These tests lock that contract + the reserved-money-in invariant.

describe("connector catalogue", () => {
  it("Whop is the one available connector and is fully specified", () => {
    const whop = getConnector("whop");
    expect(whop?.status).toBe("available");
    expect(whop?.mcp_endpoint).toBeTruthy();
    expect((whop?.operations ?? []).length).toBeGreaterThan(0);
    expect(whop?.auth.credential_name).toBe("WHOP_API_KEY");
  });

  it("availableConnectors() returns Whop + Gumroad + the growth-layer connectors in this build", () => {
    const avail = availableConnectors().map((c) => c.id).sort();
    expect(avail).toEqual(["gumroad", "higgsfield", "instagram", "linkedin", "notion", "tiktok", "twitter", "whop"]);
  });

  it("Notion is a Pipedream-routed connector (the second hosted-connect provider) with no mcp_endpoint or builder credential", () => {
    const c = getConnector("notion");
    expect(c?.status).toBe("available");
    expect(c?.mcp_endpoint).toBeUndefined();
    expect(c?.composio).toBeUndefined();
    expect(c?.pipedream?.app_slug).toBe("notion");
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

  it("coming_soon Composio placeholders (CRM/ads/advanced-email) resolve and carry a toolkit slug", () => {
    for (const id of ["hubspot", "google-ads", "meta-ads", "agentmail"]) {
      const c = getConnector(id);
      expect(c?.status).toBe("coming_soon");
      expect(c?.composio?.toolkit_slug).toBeTruthy();
    }
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
    const whop = getConnector("whop");
    for (const op of whop?.operations ?? []) {
      expect(/checkout|charge|payout|refund|withdraw|collect[_-]?payment|create[_-]?payment/i.test(op.name)).toBe(false);
    }
  });

  it("connector ids are unique", () => {
    const ids = CONNECTOR_CATALOGUE.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the Whop-seller Launchpad template wires the whop connector and the mcp-connector skill", () => {
    const tpl = getLaunchpadTemplate("whop-seller");
    expect(tpl).not.toBeNull();
    expect(tpl?.connectors).toContain("whop");
    expect(tpl?.skills).toContain("mcp-connector");
    expect(tpl?.coming_soon).toBeFalsy();
  });

  it("every template connector reference resolves to a catalogue entry", () => {
    for (const tpl of LAUNCHPAD_TEMPLATES) {
      for (const cid of tpl.connectors ?? []) {
        expect(getConnector(cid), `template ${tpl.id} → connector ${cid}`).not.toBeNull();
      }
    }
  });

  it("voice + support connectors are catalogued as coming_soon", () => {
    for (const id of ["vapi", "twilio", "elevenlabs", "zendesk", "intercom"]) {
      expect(getConnector(id)?.status).toBe("coming_soon");
    }
    expect(getConnector("vapi")?.category).toBe("voice");
    expect(getConnector("zendesk")?.category).toBe("support");
  });

  it("the Whop-seller template ships a first-run bootstrap (credential prompts + projects)", () => {
    const tpl = getLaunchpadTemplate("whop-seller");
    const b = tpl?.bootstrap;
    expect(b?.prompts.some((p) => p.type === "credential" && p.connector === "whop")).toBe(true);
    expect(b?.projects).toContain("Members");
    expect((b?.setup_scripts ?? []).length).toBeGreaterThan(0);
  });

  it("ships a customer-service template (support agent + bootstrap)", () => {
    const tpl = getLaunchpadTemplate("customer-service");
    expect(tpl).not.toBeNull();
    expect(tpl?.agents).toContain("launchpad-support-v1");
    expect(tpl?.bootstrap?.prompts.some((p) => p.id === "escalation_email")).toBe(true);
  });

  it("every bootstrap credential prompt names a real connector", () => {
    for (const tpl of LAUNCHPAD_TEMPLATES) {
      for (const p of tpl.bootstrap?.prompts ?? []) {
        if (p.type === "credential" && p.connector) {
          expect(getConnector(p.connector), `${tpl.id} prompt ${p.id}`).not.toBeNull();
        }
      }
    }
  });
});
