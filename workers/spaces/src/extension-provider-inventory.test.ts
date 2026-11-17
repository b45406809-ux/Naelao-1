import { describe, expect, it } from "vitest";
import { buildProviderDependencyInventory } from "./extension-provider-inventory.js";

describe("owner provider dependency inventory", () => {
  it("matches only signed connection declarations and exposes no account or secret metadata", () => {
    const result = buildProviderDependencyInventory([
      { connection_id: "crm", provider: "slack", purpose: "CRM alerts", required: true },
      { connection_id: "calendar", provider: "google_calendar", purpose: "Calendar sync", required: false },
    ], [
      { connection_id: "crm", provider: "slack", status: "active", connected_at: "2026-11-17", last_verified_at: "2026-11-17" },
      { connection_id: "calendar", provider: "google_calendar", status: "revoked", connected_at: "2026-11-16", last_verified_at: null },
      { connection_id: "other", provider: "telegram", status: "active", connected_at: "2026-11-16", last_verified_at: null },
      { connection_id: "crm", provider: "slack", status: "unknown", connected_at: "2026-11-16", last_verified_at: null },
    ]);
    expect(result).toEqual({ declared: [
      { connection_id: "crm", provider: "slack", purpose: "CRM alerts", required: true },
      { connection_id: "calendar", provider: "google_calendar", purpose: "Calendar sync", required: false },
    ], configured: [
      { connection_id: "crm", provider: "slack", status: "active", connected_at: "2026-11-17", last_verified_at: "2026-11-17" },
      { connection_id: "calendar", provider: "google_calendar", status: "revoked", connected_at: "2026-11-16", last_verified_at: null },
    ] });
  });
});
