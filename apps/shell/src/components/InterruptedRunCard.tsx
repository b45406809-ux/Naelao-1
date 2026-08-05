"use client";

/**
 * The standing offer to continue a run that went wrong.
 *
 * Deliberately NOT a toast and not component state: it is read from the server on every mount, so
 * it is still there after a refresh, a closed tab, or coming back tomorrow. It disappears only
 * when someone actually answers it.
 *
 * "Continue" is the important word. It re-enters the same run — actions that already executed are
 * replayed from the ledger rather than run again — whereas a plain "try again" starts from
 * nothing and repeats every side effect. That distinction is why a failed run once created a
 * second project when the user pressed Try again.
 */

import * as React from "react";
import type { InterruptedRun, SessionCredentials } from "@/lib/api";
import { resolveInterruptedRun } from "@/lib/api";

export function InterruptedRunCard({
  interrupted,
  spaceId,
  sessionId,
  session,
  onContinued,
  onDismissed,
}: {
  interrupted: InterruptedRun;
  spaceId: string;
  sessionId: string;
  session: SessionCredentials;
  /** Handed the continuation's run id so the caller can attach its live activity + answer. */
  onContinued: (runId: string) => void;
  onDismissed: () => void;
}) {
  const [busy, setBusy] = React.useState<"continue" | "dismiss" | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function resolve(action: "continue" | "dismiss") {
    setBusy(action);
    setError(null);
    try {
      const res = await resolveInterruptedRun(spaceId, sessionId, interrupted.run_id, action, session);
      if (action === "dismiss") {
        onDismissed();
        return;
      }
      // A continue that the server declined to start (already handled elsewhere, say) must not
      // leave the card silently gone with nothing running in its place.
      if (res.run_id) onContinued(res.run_id);
      else onDismissed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not do that just now.");
      setBusy(null);
    }
  }

  const done = interrupted.steps_completed;

  return (
    <div className="interrupted-card">
      <div className="interrupted-head">
        <span className="interrupted-dot" aria-hidden />
        <span className="interrupted-title">This didn&apos;t finish</span>
      </div>
      <p className="interrupted-reason">{interrupted.reason}</p>
      {/* What the error actually means, in words. A raw provider string ("4006") leaves the person
          with no way to judge whether continuing now is even worth trying. */}
      {interrupted.explanation && (
        <p className="interrupted-explain">{interrupted.explanation}</p>
      )}
      <p className="interrupted-note">
        {done > 0
          ? `${done} step${done === 1 ? "" : "s"} already completed. Continuing picks up from there — it won't redo them.`
          : "Nothing had run yet, so continuing starts this cleanly."}
      </p>
      {error && <p className="interrupted-error">{error}</p>}
      <div className="interrupted-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={() => void resolve("continue")}
          disabled={busy !== null}
        >
          {busy === "continue"
            ? "Continuing…"
            : interrupted.clears_on_its_own
              ? "Try again now"
              : "Continue"}
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => void resolve("dismiss")}
          disabled={busy !== null}
        >
          {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
        </button>
      </div>
    </div>
  );
}
