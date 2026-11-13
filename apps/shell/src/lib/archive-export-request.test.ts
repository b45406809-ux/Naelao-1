import { describe, expect, it } from "vitest";
import { clearPendingSpaceArchiveExportRequest, getOrCreateSpaceArchiveExportRequest, readPendingSpaceArchiveExportRequest, spaceArchiveExportRequestKey } from "./archive-export-request.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("Space archive export request recovery", () => {
  it("reuses the same scoped request ID after an ambiguous response or reload", () => {
    const storage = memoryStorage();
    const createId = () => "archive-request-1";

    expect(getOrCreateSpaceArchiveExportRequest(storage, "space-a", "owner-a", createId)).toBe("archive-request-1");
    expect(readPendingSpaceArchiveExportRequest(storage, "space-a", "owner-a")).toBe("archive-request-1");
    expect(getOrCreateSpaceArchiveExportRequest(storage, "space-a", "owner-a", () => "unexpected-second-id")).toBe("archive-request-1");
    expect(readPendingSpaceArchiveExportRequest(storage, "space-b", "owner-a")).toBeNull();
    expect(readPendingSpaceArchiveExportRequest(storage, "space-a", "owner-b")).toBeNull();
  });

  it("validates stored IDs and clears only the exact Space and actor request", () => {
    const storage = memoryStorage();
    storage.setItem(spaceArchiveExportRequestKey("space-a", "owner-a"), "bad request id");
    expect(readPendingSpaceArchiveExportRequest(storage, "space-a", "owner-a")).toBeNull();
    expect(getOrCreateSpaceArchiveExportRequest(storage, "space-a", "owner-a", () => "replacement-2")).toBe("replacement-2");
    storage.setItem(spaceArchiveExportRequestKey("space-b", "owner-a"), "other-space-request");

    clearPendingSpaceArchiveExportRequest(storage, "space-a", "owner-a");

    expect(readPendingSpaceArchiveExportRequest(storage, "space-a", "owner-a")).toBeNull();
    expect(readPendingSpaceArchiveExportRequest(storage, "space-b", "owner-a")).toBe("other-space-request");
  });

  it("rejects a generated identifier that cannot be accepted by the archive API", () => {
    expect(() => getOrCreateSpaceArchiveExportRequest(memoryStorage(), "space-a", "owner-a", () => "contains spaces"))
      .toThrow("archive_export_request_id_invalid");
  });
});
