import { describe, expect, it, vi } from "vitest";
import { readAuditLog, writeAudit } from "./audit.js";
import { evaluateBlueprintSecurity } from "./blueprint-validator.js";

describe("audit and blueprint bounds", () => {
  it("caps audit pagination before querying D1", async () => {
    const prepare = vi.fn();
    const db = { prepare } as never;
    await expect(readAuditLog(db, "space", "s", 501)).rejects.toThrow(
      "audit_page_size_invalid"
    );
    await expect(readAuditLog(db, "space", "s", 10, -1)).rejects.toThrow(
      "audit_offset_invalid"
    );
    await expect(
      readAuditLog(db, "space", "s", 10, Number.MAX_SAFE_INTEGER)
    ).rejects.toThrow("audit_offset_invalid");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects oversized or cyclic audit metadata before writing", async () => {
    const prepare = vi.fn();
    const db = { prepare } as never;
    await expect(
      writeAudit(db, {
        eventType: "test",
        actorId: "actor",
        resourceType: "space",
        resourceId: "s",
        action: "update",
        metadata: { data: "x".repeat(65 * 1024) },
      })
    ).rejects.toThrow("audit_metadata_too_large");
    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;
    await expect(
      writeAudit(db, {
        eventType: "test",
        actorId: "actor",
        resourceType: "space",
        resourceId: "s",
        action: "update",
        metadata,
      })
    ).rejects.toThrow();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("fails closed on malformed, oversized, or non-finite blueprint security input", () => {
    expect(evaluateBlueprintSecurity(null as never)).toMatchObject({
      publishable: false,
      score: 0,
    });
    expect(
      evaluateBlueprintSecurity({
        schemaVersion: "2.0",
        projects: Array(1001).fill({}),
      } as never)
    ).toMatchObject({ publishable: false });
    expect(
      evaluateBlueprintSecurity({
        schemaVersion: "2.0",
        projects: [
          {
            name: "x",
            systemPrompt: "safe",
            starterFiles: [],
            executionTier: Number.NaN,
          },
        ],
      } as never).publishable
    ).toBe(false);
    expect(
      evaluateBlueprintSecurity({
        schemaVersion: "2.0",
        projects: [
          { name: "x", systemPrompt: "x".repeat(1_000_001), starterFiles: [] },
        ],
      }).publishable
    ).toBe(false);
  });
});
