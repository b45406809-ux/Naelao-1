import { describe, expect, it } from "vitest";
import { missingToolScopes, resolveScopedConnector } from "./connector-policy";

describe("connector policy", () => {
  it("switches a logical alias target without changing caller code", () => {
    const execution = { projectId: "project-1", userId: "alice" };
    const before = resolveScopedConnector([{ connectorId: "gmail-old", scope: "space_shared" }], execution);
    const after = resolveScopedConnector([{ connectorId: "gmail-new", scope: "space_shared" }], execution);
    expect(before?.connectorId).toBe("gmail-old");
    expect(after?.connectorId).toBe("gmail-new");
  });

  it("does not expose user-personal connectors to background execution", () => {
    const selected = resolveScopedConnector([
      { connectorId: "alice-private", scope: "user_personal", userId: "alice" },
      { connectorId: "company", scope: "space_shared" },
    ], { projectId: "project-1" });
    expect(selected?.connectorId).toBe("company");
  });

  it("detects a missing write grant before dispatch", () => {
    expect(missingToolScopes("send_email", ["email.read"])).toEqual(["email.send"]);
  });
});
