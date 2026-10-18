import { describe, expect, it } from "vitest";
import { channelSessionStorageUsageEvent } from "./channel-session-usage.js";

describe("channel extension session storage usage", () => {
  const scope = { spaceId: "space-a", projectId: "project-a", installationId: "install-a", messageId: "msg-a" };

  it("records only net bytes added with an opaque stable event identity", () => {
    expect(channelSessionStorageUsageEvent({ ...scope, kind: "named", bytesDelta: 12 })).toEqual({
      schema_version: 2, event_type: "storage_bytes_written", quantity: 12, unit: "bytes", space_id: "space-a",
      project_id: "project-a", installation_id: "install-a", run_id: "channel:msg-a",
      idempotency_key: "channel-session-storage:msg-a:named", payer_kind: "unknown", decision: "allowed",
    });
  });

  it("records shrinks as deletions and ignores no-op or invalid deltas", () => {
    expect(channelSessionStorageUsageEvent({ ...scope, kind: "default", bytesDelta: -8 })).toMatchObject({ event_type: "storage_bytes_deleted", quantity: 8, decision: "not_billable" });
    expect(channelSessionStorageUsageEvent({ ...scope, kind: "default", bytesDelta: 0 })).toBeNull();
    expect(channelSessionStorageUsageEvent({ ...scope, kind: "default", bytesDelta: Number.NaN })).toBeNull();
  });
});
