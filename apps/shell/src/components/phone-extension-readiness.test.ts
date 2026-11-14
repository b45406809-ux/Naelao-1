import { describe, expect, it } from "vitest";
import { phoneExtensionLineReadiness } from "./phone-extension-readiness.js";

describe("phone extension routing readiness", () => {
  const active = {
    status: "active",
    handler_status: "active",
    installation_id: "install-1",
    handler_sha256: "a".repeat(64),
    handler_candidates: [{ installation_id: "install-1", handler_sha256: "a".repeat(64) }],
  };

  it("reports readiness only for an active line with an exact installation and handler digest", () => {
    expect(phoneExtensionLineReadiness(active)).toEqual({ state: "ready", label: "Ready for supported keypad events" });
    expect(phoneExtensionLineReadiness({ ...active, handler_sha256: "bad" })).toMatchObject({ state: "handler_unverified" });
    expect(phoneExtensionLineReadiness({ ...active, installation_id: null })).toMatchObject({ state: "handler_unverified" });
    expect(phoneExtensionLineReadiness({ ...active, handler_candidates: [] })).toMatchObject({ state: "handler_unverified" });
    expect(phoneExtensionLineReadiness({ ...active, handler_candidates: [{ installation_id: "install-1", handler_sha256: "b".repeat(64) }] })).toMatchObject({ state: "handler_unverified" });
    expect(phoneExtensionLineReadiness({ ...active, handler_candidates: [{ installation_id: "install-2", handler_sha256: "a".repeat(64) }] })).toMatchObject({ state: "handler_unverified" });
  });

  it("explains inactive lines and missing or inactive handlers without claiming conversational voice", () => {
    expect(phoneExtensionLineReadiness({ ...active, status: "pending" })).toMatchObject({ state: "line_unavailable" });
    expect(phoneExtensionLineReadiness({ ...active, handler_status: null })).toMatchObject({ state: "handler_unavailable" });
    expect(phoneExtensionLineReadiness({ ...active, handler_status: "disabled" })).toMatchObject({ state: "handler_unavailable" });
  });
});
