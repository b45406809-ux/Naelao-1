import { describe, expect, it } from "vitest";
import { isProvisionMessage } from "./message-contract.js";

const validMessage = {
  type: "space_provision",
  spaceId: "d7216a8e-8e0d-49e8-bac4-f5e22d8e0f88",
  tenantId: "tenant-a",
  spaceTypeId: "launchpad",
  spaceName: "Acme",
  templateIds: ["creator-store", "customer-support"],
  requestedAt: "2026-10-20T00:00:00.000Z",
  userId: "auth0|user-a",
};

describe("provision queue message contract", () => {
  it("accepts valid provision and deprovision payloads", () => {
    expect(isProvisionMessage(validMessage)).toBe(true);
    expect(isProvisionMessage({ ...validMessage, type: "space_deprovision" })).toBe(true);
  });

  it.each([
    null,
    [],
    { ...validMessage, type: "unknown" },
    { ...validMessage, spaceId: "" },
    { ...validMessage, spaceId: "../target" },
    { ...validMessage, tenantId: "tenant/other" },
    { ...validMessage, spaceTypeId: "../registry" },
    { ...validMessage, tenantId: "t".repeat(129) },
    { ...validMessage, spaceTypeId: undefined },
    { ...validMessage, spaceName: "n".repeat(257) },
    { ...validMessage, requestedAt: "x".repeat(65) },
    { ...validMessage, userId: 123 },
    { ...validMessage, userId: "bad\nheader" },
    { ...validMessage, templateId: {} },
    { ...validMessage, templateIds: Array(101).fill("template") },
    { ...validMessage, templateIds: ["ok", ""] },
  ])("rejects malformed or unbounded payload %#", (value) => {
    expect(isProvisionMessage(value)).toBe(false);
  });
});
