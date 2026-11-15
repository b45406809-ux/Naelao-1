import { describe, expect, it } from "vitest";
import type { ClaimedExtensionStreamSession } from "./telnyx-extension-stream-session.js";
import { matchesTelnyxExtensionStreamStart } from "./telnyx-extension-media.js";

const session: ClaimedExtensionStreamSession = {
  sessionId: "txs_00000000-0000-4000-8000-000000000000", callRef: `call_${"a".repeat(32)}`,
  tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", bindingId: "line-a",
  callControlId: "v3:telnyx-call-a", installationId: "install-a", handlerSha256: "a".repeat(64),
  settingsRevision: 7, expiresAt: 1_800_000_000, ticketClaimedAt: 1_700_000_000,
};

describe("Telnyx extension media start pin", () => {
  it("accepts only the exact ticket-bound provider call and PCMU media format", () => {
    expect(matchesTelnyxExtensionStreamStart(session, {
      event: "start", start: { stream_id: "stream-a", call_control_id: session.callControlId,
        media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 } },
    })).toBe(true);
    expect(matchesTelnyxExtensionStreamStart(session, {
      event: "start", start: { stream_id: "stream-a", call_control_id: "other-call",
        media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 } },
    })).toBe(false);
  });

  it("rejects media frames, malformed starts, and unsupported audio formats", () => {
    expect(matchesTelnyxExtensionStreamStart(session, { event: "media", media: { payload: "AA==" } })).toBe(false);
    expect(matchesTelnyxExtensionStreamStart(session, { event: "start", start: { stream_id: "bad stream",
      call_control_id: session.callControlId, media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 } } })).toBe(false);
    expect(matchesTelnyxExtensionStreamStart(session, { event: "start", start: { stream_id: "stream-a",
      call_control_id: session.callControlId, media_format: { encoding: "L16", sample_rate: 8000, channels: 1 } } })).toBe(false);
  });
});
