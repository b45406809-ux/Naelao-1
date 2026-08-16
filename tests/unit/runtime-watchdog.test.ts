import { describe, it, expect } from "vitest";
import { detectRuntimeAnomaly, isJobOverdue, OVERDUE_GRACE_MS } from "../../packages/events/src/index.js";

// Phase 5 plugins/skills batch — the expected-runtime watchdog. Reads scheduled_job_runs'
// existing duration_ms/ok/skipped_busy history (migration 0071) rather than adding new tracking.

describe("detectRuntimeAnomaly", () => {
  it("returns null when there's not enough history yet", () => {
    const runs = [
      { duration_ms: 100, ok: 1, skipped_busy: 0 },
      { duration_ms: 100, ok: 1, skipped_busy: 0 },
    ];
    expect(detectRuntimeAnomaly(runs)).toBeNull();
  });

  it("returns null for an ordinary run within normal range of its own history", () => {
    const runs = [
      { duration_ms: 120, ok: 1, skipped_busy: 0 }, // latest
      { duration_ms: 100, ok: 1, skipped_busy: 0 },
      { duration_ms: 110, ok: 1, skipped_busy: 0 },
      { duration_ms: 90, ok: 1, skipped_busy: 0 },
    ];
    expect(detectRuntimeAnomaly(runs)).toBeNull();
  });

  it("flags the latest run when it's a real outlier against its own recent average", () => {
    const runs = [
      { duration_ms: 3000, ok: 1, skipped_busy: 0 }, // latest — 30x the ~100ms average
      { duration_ms: 100, ok: 1, skipped_busy: 0 },
      { duration_ms: 110, ok: 1, skipped_busy: 0 },
      { duration_ms: 90, ok: 1, skipped_busy: 0 },
    ];
    const anomaly = detectRuntimeAnomaly(runs);
    expect(anomaly).not.toBeNull();
    expect(anomaly!.latest_ms).toBe(3000);
    expect(anomaly!.average_ms).toBe(100);
    expect(anomaly!.ratio).toBeCloseTo(30, 0);
  });

  it("only ever judges the LATEST run, never an older slow one buried in history", () => {
    const runs = [
      { duration_ms: 105, ok: 1, skipped_busy: 0 }, // latest — ordinary
      { duration_ms: 5000, ok: 1, skipped_busy: 0 }, // an old outlier, already in the past
      { duration_ms: 100, ok: 1, skipped_busy: 0 },
      { duration_ms: 95, ok: 1, skipped_busy: 0 },
    ];
    // The old outlier inflates the average enough that the latest ordinary run isn't flagged —
    // proving this reads "did something change just now," not "was anything ever slow."
    expect(detectRuntimeAnomaly(runs)).toBeNull();
  });

  it("ignores failed and skipped-busy runs entirely — neither carries a meaningful duration", () => {
    const runs = [
      { duration_ms: 50, ok: 0, skipped_busy: 0, error: "boom" }, // latest — a real failure
      { duration_ms: 100, ok: 1, skipped_busy: 0 },
      { duration_ms: 110, ok: 1, skipped_busy: 0 },
      { duration_ms: 90, ok: 1, skipped_busy: 0 },
    ];
    // The failed run is dropped before ever becoming "the latest" for comparison purposes, so
    // there's nothing to compare against a non-existent completed latest run.
    expect(detectRuntimeAnomaly(runs)).toBeNull();
  });

  it("accepts real booleans as well as SQLite's 0/1 ok/skipped_busy shape", () => {
    const runs = [
      { duration_ms: 3000, ok: true, skipped_busy: false },
      { duration_ms: 100, ok: true, skipped_busy: false },
      { duration_ms: 110, ok: true, skipped_busy: false },
      { duration_ms: 90, ok: true, skipped_busy: false },
    ];
    expect(detectRuntimeAnomaly(runs)).not.toBeNull();
  });
});

describe("isJobOverdue", () => {
  const HOUR = 60 * 60_000;

  it("is never overdue while disabled", () => {
    expect(isJobOverdue(false, "0 * * * *", Date.now() - 5 * HOUR, Date.now())).toBe(false);
  });

  it("is never overdue with no run history yet — nothing has been missed", () => {
    expect(isJobOverdue(true, "0 * * * *", null, Date.now())).toBe(false);
  });

  it("is NOT overdue right after a fire matching its own cadence", () => {
    const now = Date.UTC(2026, 0, 1, 10, 5, 0);
    const lastRun = Date.UTC(2026, 0, 1, 10, 0, 0); // fired on the hour, 5 min ago
    expect(isJobOverdue(true, "0 * * * *", lastRun, now)).toBe(false);
  });

  it("is NOT overdue within the grace window after a missed fire", () => {
    const lastRun = Date.UTC(2026, 0, 1, 9, 0, 0);
    // The next hourly fire was due at 10:00 — 30 min late is well inside the 90-min grace window.
    const now = Date.UTC(2026, 0, 1, 10, 30, 0);
    expect(isJobOverdue(true, "0 * * * *", lastRun, now)).toBe(false);
  });

  it("IS overdue once well past the grace window past its expected next fire", () => {
    const lastRun = Date.UTC(2026, 0, 1, 9, 0, 0);
    // Next hourly fire was due at 10:00; now it's 12:00 — 2h late, past the 90-min grace window.
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(isJobOverdue(true, "0 * * * *", lastRun, now)).toBe(true);
  });

  it("the grace constant is exported and matches the documented 90 minutes", () => {
    expect(OVERDUE_GRACE_MS).toBe(90 * 60_000);
  });
});
