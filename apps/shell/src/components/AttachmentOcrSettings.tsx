"use client";

import * as React from "react";
import { Toggle } from "@naelao/ui";
import { getAttachmentOcrSettings, updateAttachmentOcrSettings, type SessionCredentials } from "@/lib/api";

export function AttachmentOcrSettings({ spaceId, session, canManage }: {
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
    getAttachmentOcrSettings(spaceId, session)
      .then((result) => { if (active) setEnabled(result.enabled === true); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : "Unable to load OCR settings"); })
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [spaceId, session]);

  async function change(next: boolean) {
    if (!session || !canManage || busy) return;
    if (next && !window.confirm(
      "Enable hosted OCR for this Space? When an agent explicitly requests OCR, a task-owned PNG/JPEG image or up to the first five pages of a scanned PDF will be sent to Cloudflare Workers AI (Moondream) for text extraction. Images and each rendered PDF page are limited to 1 MiB and 20 megapixels; PDFs are limited to 1 MiB. Output is capped at 1,024 tokens per page/image, and OCR and video frame analysis share a 20-model-call rolling Space-day limit, so one PDF may use several calls. Usage is billed to your Cloudflare account; exact image cost varies. Output can be inaccurate. Private/air-gapped Spaces cannot use this.",
    )) return;
    setBusy(true); setError("");
    try {
      const result = await updateAttachmentOcrSettings(spaceId, session, next);
      setEnabled(result.enabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save OCR settings");
    } finally { setBusy(false); }
  }

  return (
    <div className="settings-block" style={{ marginTop: 16 }}>
      <div className="settings-row">
        <div style={{ maxWidth: 640 }}>
          <div className="settings-row-label">Hosted OCR for image attachments</div>
          <div className="settings-row-sub">
            Off by default. If enabled, an agent may send a task-owned PNG/JPEG or the first five rendered pages of a scanned PDF to Cloudflare Workers AI after the separate OCR action is requested. Images and each PDF page are limited to 1 MiB and 20 megapixels; PDFs are limited to 1 MiB. Output is untrusted and may be inaccurate. The current model listing is $0.30/M input tokens and $1/M output tokens; image token use varies, and PDF pages each consume a model call, so no exact per-image/PDF quote is available. OCR and video frame analysis share a 20-model-call rolling Space-day limit. Air-gapped Spaces are unsupported. {" "}
            <a href="https://moondream.ai/licenses/model/1.0" target="_blank" rel="noreferrer">Review the Moondream 1.0 model license</a>.
          </div>
        </div>
        {canManage ? (
          <Toggle label="Enable hosted OCR for image attachments" on={enabled} onChange={(value) => void change(value)} disabled={busy || !loaded || !session} />
        ) : (
          <span style={{ fontSize: 12, color: "var(--text2)" }}>{loaded ? enabled ? "Enabled" : "Off" : "Loading…"}</span>
        )}
      </div>
      {error && <div role="status" style={{ color: "#dc2626", fontSize: 12.5, padding: "0 16px 12px" }}>{error}</div>}
    </div>
  );
}
