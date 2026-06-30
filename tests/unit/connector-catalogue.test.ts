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

  it("availableConnectors() returns only Whop in this build", () => {
    const avail = availableConnectors().map((c) => c.id);
    expect(avail).toEqual(["whop"]);
  });

  it("the rest of the creator-economy platforms are coming_soon", () => {
    for (const id of ["gumroad", "skool", "beehiiv", "substack", "calcom", "etsy"]) {
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
});
