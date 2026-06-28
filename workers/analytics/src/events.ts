// G-H01: Analytics event schema and CF Analytics Engine write helper
// Fulfills the append-only, 25M rows/day CF Analytics Engine write path.

// ── Event types ───────────────────────────────────────────────────────────────

export type EventType =
  | "session_start"
  | "session_end"
  | "message_sent"
  | "agent_response"
  | "tool_called"
  | "tool_error"
  | "kb_retrieved"
  | "kb_doc_uploaded"
  | "space_created"
  | "space_deleted"
  | "login"
  | "register"
  | "billing_checkout"
  | "subscription_changed"
  | "error"
  | "rate_limited"
  | "rating_submitted";

export interface AnalyticsEvent {
  eventType: EventType;
  tenantId: string;
  spaceId?: string;
  sessionId?: string;
  userId?: string;
  durationMs?: number;
  tokenCount?: number;
  errorCode?: string;
  rating?: number; // 1-5
  model?: string;
  toolName?: string;
  planTier?: string;
  metadata?: Record<string, string>; // max 5 key-value pairs
}

// ── CF Analytics Engine write ─────────────────────────────────────────────────
//
// CF Analytics Engine field layout (must stay stable — append-only schema):
//
//  indexes (string, max 20):
//    index1 = eventType
//    index2 = tenantId
//    index3 = spaceId       (empty string when absent)
//    index4 = sessionId     (empty string when absent)
//    index5 = userId        (empty string when absent)
//
//  doubles (number, max 20):
//    double1 = timestamp unix ms
//    double2 = durationMs   (0 when absent)
//    double3 = tokenCount   (0 when absent)
//    double4 = rating       (0 when absent)
//
//  blobs (string, max 20):
//    blob1 = errorCode      (empty string when absent)
//    blob2 = model          (empty string when absent)
//    blob3 = toolName       (empty string when absent)
//    blob4 = planTier       (empty string when absent)
//    blob5 = JSON.stringify(metadata ?? {})

export function writeEvent(
  dataset: AnalyticsEngineDataset,
  event: AnalyticsEvent
): void {
  // Validate metadata size — silently truncate to 5 pairs
  let metadata = event.metadata ?? {};
  const entries = Object.entries(metadata);
  if (entries.length > 5) {
    metadata = Object.fromEntries(entries.slice(0, 5));
  }

  dataset.writeDataPoint({
    indexes: [
      event.eventType,               // index1
      event.tenantId,                // index2
      event.spaceId ?? "",           // index3
      event.sessionId ?? "",         // index4
      event.userId ?? "",            // index5
    ],
    doubles: [
      Date.now(),                    // double1 — timestamp unix ms
      event.durationMs ?? 0,         // double2
      event.tokenCount ?? 0,         // double3
      event.rating ?? 0,             // double4
    ],
    blobs: [
      event.errorCode ?? "",         // blob1
      event.model ?? "",             // blob2
      event.toolName ?? "",          // blob3
      event.planTier ?? "",          // blob4
      JSON.stringify(metadata),      // blob5
    ],
  });
}
