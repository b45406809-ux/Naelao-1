"use client";

import * as React from "react";
import { Toggle } from "@naelao/ui";
import { getVideoFrameAnalysisSettings, updateVideoFrameAnalysisSettings, type SessionCredentials } from "@/lib/api";

export function VideoFrameAnalysisSettings({ spaceId, session, canManage }: {
  spaceId: string;
  session: SessionCredentials | null;
  canManage: boolean;
}) {
  const [enabled, setEnabled] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    if (!session) return;
    getVideoFrameAnalysisSettings(spaceId, session)
      .then((result) => { if (active) setEnabled(result.enabled === true); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : "Unable to load video analysis settings"); })
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [spaceId, session]);

  async function change(next: boolean) {
    if (!session || !canManage || busy) return;
    if (next && !window.confirm(
      "Enable hosted video frame analysis for this Space? When explicitly requested, up to three JPEG frames sampled at 0, 10, and 20 seconds from the first 30 seconds of a task-owned video are sent to Cloudflare Workers AI. Each frame is limited to 1 MiB and 20 megapixels. This shares a rolling 20-model-call daily limit with hosted image OCR and visual questions. Image usage varies, so no exact per-video price is available; charges go to your Cloudflare account. Sampled frames can miss events and output is untrusted. Private or air-gapped Spaces cannot use this.",
    )) return;
    setBusy(true); setError("");
    try {
      const result = await updateVideoFrameAnalysisSettings(spaceId, session, next);
      setEnabled(result.enabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save video analysis settings");
    } finally { setBusy(false); }
  }

  return (
    <div className="settings-block" style={{ marginTop: 16 }}>
      <div className="settings-row">
        <div style={{ maxWidth: 640 }}>
          <div className="settings-row-label">Hosted video frame analysis</div>
          <div className="settings-row-sub">
            Off by default and separate from audio-track transcription and image OCR. When enabled, the explicit video question action samples at 0, 10, and 20 seconds from at most the first 30 seconds, then asks Cloudflare Workers AI about each available frame. It does not analyze motion or the whole video. Input is limited to 6 MiB; each output frame is limited to 1 MiB and 20 megapixels. Video analysis and image OCR share a 20-model-call rolling Space-day quota. Costs are billed by Cloudflare and depend on image usage, so a per-video quote is unavailable. Output is untrusted. Air-gapped Spaces are unsupported.
          </div>
        </div>
        {canManage ? (
          <Toggle label="Enable hosted video frame analysis" on={enabled} onChange={(value) => void change(value)} disabled={busy || !loaded || !session} />
        ) : (
          <span style={{ fontSize: 12, color: "var(--text2)" }}>{loaded ? enabled ? "Enabled" : "Off" : "Loading…"}</span>
        )}
      </div>
      {error && <div role="status" style={{ color: "#dc2626", fontSize: 12.5, padding: "0 16px 12px" }}>{error}</div>}
    </div>
  );
}
